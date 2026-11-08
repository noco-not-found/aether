"""Topic clusters: blended vectors -> UMAP -> HDBSCAN, named from what the members have in common.

Names come from two places. If most members have text, the words that are frequent in this cluster
but rare in the others (c-TF-IDF). If they are mostly pictures, the closest concepts from a fixed
vocabulary, found by comparing the cluster's average picture with CLIP's text encoder.
"""
from __future__ import annotations

import json
import logging
import re
import threading
import time
from typing import Optional

import numpy as np

from .db import DB
from .embed import unit
from .semantic import Semantic
from .vocab import VISUAL_VOCAB

log = logging.getLogger("aether.cluster")

MIN_ITEMS = 12



_NOISE = {
    "http", "https", "www", "com", "org", "net", "html", "amp", "nbsp", "image", "images", "photo", "photos",
    "saved", "twitter", "pic", "status", "just", "like", "get", "got", "one", "also", "would", "could",
    "new", "use", "used", "make", "made", "see", "say", "said", "really", "much", "many", "know",
}


def _tokens_doc(c, ids: list[int]) -> dict[int, str]:
    """Title + text + OCR + the tags a person typed, per item."""
    out: dict[int, list[str]] = {i: [] for i in ids}
    for r in c.execute("SELECT id, title, substr(text,1,1500) AS t, note FROM items"):
        if r["id"] in out:
            out[r["id"]] += [r["title"] or "", r["t"] or "", r["note"] or ""]
    for r in c.execute("SELECT item_id, ocr_text FROM assets WHERE ocr_text IS NOT NULL AND ocr_text != ''"):
        if r["item_id"] in out:
            out[r["item_id"]].append(r["ocr_text"][:600])
    for r in c.execute("SELECT it.item_id, t.name FROM item_tags it JOIN tags t ON t.id=it.tag_id "
                       "WHERE it.origin IN ('manual','accepted')"):
        if r["item_id"] in out:
            out[r["item_id"]].append(r["name"])
    return {i: " ".join(p) for i, p in out.items()}


def ctfidf_names(docs: dict[int, str], labels: dict[int, int]) -> dict[int, list[str]]:
    """Per cluster, the terms most characteristic of it (class-based TF-IDF): frequent in this
    cluster, rare in the others. A term must appear in at least two of the cluster's items, or it is
    one document's quirk (a lone item can still name itself)."""
    import scipy.sparse as sp
    from sklearn.feature_extraction.text import ENGLISH_STOP_WORDS, CountVectorizer
    ids = [i for i, lab in labels.items() if lab >= 0]
    if not ids:
        return {}
    keys = sorted({labels[i] for i in ids})
    cv = CountVectorizer(stop_words=list(ENGLISH_STOP_WORDS | _NOISE), ngram_range=(1, 2), lowercase=True,
                         token_pattern=r"(?u)\b[a-zA-Z][a-zA-Z'\-]{2,}\b")
    try:
        C = cv.fit_transform([docs.get(i, "") for i in ids]).tocsr()          # items x terms
    except ValueError:                                                          # nothing but stop words
        return {k: [] for k in keys}
    vocab = np.array(cv.get_feature_names_out())
    col = {k: n for n, k in enumerate(keys)}
    M = sp.csr_matrix((np.ones(len(ids)), ([col[labels[i]] for i in ids], range(len(ids)))), shape=(len(keys), len(ids)))
    counts = np.asarray((M @ C).todense(), dtype=np.float64)                    # clusters x terms
    seen_in = np.asarray((M @ (C > 0).astype(np.float64)).todense())            # in how many items of the cluster
    size = np.asarray(M.sum(1)).ravel()
    tf = counts / np.maximum(counts.sum(1, keepdims=True), 1)
    idf = np.log(1 + (counts.sum() / len(keys)) / np.maximum(counts.sum(0), 1))
    names: dict[int, list[str]] = {}
    for k in keys:
        r = col[k]
        score = np.where(seen_in[r] >= (2 if size[r] >= 3 else 1), tf[r] * idf, 0.0)
        picked: list[str] = []
        for j in np.argsort(-score)[:80]:
            if score[j] <= 0:
                break
            t = str(vocab[j])
            if any(t in p or p in t for p in picked):       # "space" vs "space shuttle": keep the first
                continue
            picked.append(t)
            if len(picked) == 8:
                break
        names[k] = picked
    return names

class Clusterer:
    def __init__(self, db: DB, sem: Semantic) -> None:
        self.db, self.sem = db, sem
        self.state: dict = {"state": "idle", "error": None, "started": None, "finished": None}
        self._thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self._vocab_vecs: Optional[np.ndarray] = None

    def running(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def start(self, visual: float = 0.5) -> bool:
        with self._lock:
            if self.running():
                return False
            self.state = {"state": "running", "error": None, "started": int(time.time()), "finished": None}
            self._thread = threading.Thread(target=self._run, args=(visual,), name="aether-cluster", daemon=True)
            self._thread.start()
            return True

    def wait(self, timeout: float = 300) -> None:
        if self._thread:
            self._thread.join(timeout)

    # ---- automatic re-runs: when enough new items have been embedded since the last run
    def maybe_auto(self) -> None:
        if self.running() or not self.sem.ready():
            return
        c = self.db.conn()
        n = c.execute("SELECT COUNT(*) FROM embeddings WHERE kind='text'").fetchone()[0] + \
            c.execute("SELECT COUNT(*) FROM embeddings WHERE kind='image'").fetchone()[0]
        last = c.execute("SELECT value FROM meta WHERE key='cluster_params'").fetchone()
        prev = json.loads(last[0]) if last else None
        if prev is None:
            if n >= MIN_ITEMS and self.state["state"] != "failed":
                self.start()
        elif n >= prev["vectors"] + max(8, int(0.1 * prev["vectors"])) and self.state["state"] != "failed":
            self.start(prev.get("visual", 0.5))

    # ---- the run
    def _visual_names(self, ids: np.ndarray, labels: np.ndarray, emb) -> dict[int, list[str]]:
        iids, imat = self.sem._load("image")
        if not len(iids):
            return {}
        self._vocab_vecs = self.sem.vocab_vectors()
        where = {int(i): k for k, i in enumerate(iids)}
        out: dict[int, list[str]] = {}
        for lab in sorted(set(labels.tolist()) - {-1}):
            rows = [where[int(i)] for i in ids[labels == lab] if int(i) in where]
            if not rows:
                continue
            # Score each concept by how many of the cluster's pictures it describes best, not by the
            # centroid alone: the centroid of 10 cats is also vaguely "noodles".
            sims = imat[rows] @ self._vocab_vecs.T
            p = np.exp(100.0 * (sims - sims.max(axis=1, keepdims=True)))
            p /= p.sum(axis=1, keepdims=True)
            share = p.mean(0)
            order = [j for j in np.argsort(-share)[:3] if share[j] >= 0.12]
            out[lab] = [VISUAL_VOCAB[j] for j in (order or [int(np.argmax(share))])]
        return out

    def _run(self, visual: float) -> None:
        try:
            ids, X = self.sem.blended(visual)
            n = len(ids)
            if n < MIN_ITEMS:
                self.state = {"state": "idle", "error": None, "started": self.state["started"], "finished": int(time.time()),
                              "note": f"needs at least {MIN_ITEMS} embedded items (has {n})"}
                return
            import umap
            from sklearn.cluster import HDBSCAN
            nn = min(15, n - 1)
            Z = umap.UMAP(n_neighbors=nn, n_components=min(8, n - 2), min_dist=0.0, metric="cosine",
                          random_state=42, n_jobs=1).fit_transform(X)
            labels = HDBSCAN(min_cluster_size=max(3, int(0.4 * n ** 0.5)), min_samples=2, copy=True).fit_predict(Z)
            xy = umap.UMAP(n_neighbors=nn, n_components=2, min_dist=0.3, metric="cosine",
                           random_state=42, n_jobs=1).fit_transform(X)

            c = self.db.conn()
            docs = _tokens_doc(c, [int(i) for i in ids])
            lab_by_id = {int(i): int(l) for i, l in zip(ids, labels)}
            words = ctfidf_names(docs, lab_by_id)
            visual_names = self._visual_names(ids, labels, self.sem.emb)
            text_chars = {i: len((c.execute("SELECT COALESCE(text,'') || COALESCE(note,'') FROM items WHERE id=?", (i,)).fetchone() or [""])[0])
                          for i in lab_by_id}

            order = sorted(set(labels.tolist()) - {-1}, key=lambda l: -int((labels == l).sum()))
            remap = {old: k + 1 for k, old in enumerate(order)}
            rows = []
            for old in order:
                members = [int(i) for i in ids[labels == old]]
                text_share = sum(1 for i in members if text_chars[i] >= 80) / len(members)
                terms = words.get(old, [])
                vis = visual_names.get(old, [])
                if text_share >= 0.5 and terms:
                    name = " · ".join(terms[:3])
                elif vis:
                    name = " · ".join(vis[:2] + (terms[:1] if text_share > 0.25 and terms else []))
                else:
                    name = " · ".join(terms[:3]) or f"Group {remap[old]}"
                rows.append((remap[old], name, json.dumps(terms[:8] + vis), len(members)))

            with self.db.tx() as w:
                w.execute("DELETE FROM item_clusters")
                w.execute("DELETE FROM clusters")
                w.executemany("INSERT INTO clusters(id, name, keywords, size) VALUES (?,?,?,?)", rows)
                w.executemany(
                    "INSERT INTO item_clusters(item_id, cluster_id, x, y) "
                    "SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM items WHERE id=?)",
                    [(int(i), remap.get(int(l)), float(p[0]), float(p[1]), int(i)) for i, l, p in zip(ids, labels, xy)])
                vec = w.execute("SELECT (SELECT COUNT(*) FROM embeddings WHERE kind='text') + "
                                "(SELECT COUNT(*) FROM embeddings WHERE kind='image')").fetchone()[0]
                w.execute("INSERT OR REPLACE INTO meta(key, value) VALUES ('cluster_params', ?)",
                          (json.dumps({"visual": visual, "items": n, "vectors": vec, "at": int(time.time())}),))
            self.state = {"state": "idle", "error": None, "started": self.state["started"], "finished": int(time.time())}
        except Exception as e:                        # surfaced in /api/clusters, never crashes the engine
            log.exception("clustering failed")
            self.state = {"state": "failed", "error": f"{type(e).__name__}: {e}", "started": self.state["started"],
                          "finished": int(time.time())}
