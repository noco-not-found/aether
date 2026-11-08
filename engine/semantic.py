"""Everything built on the vectors: keeping them current, search by meaning, related items,
tag suggestions. Vectors for <3000 items are a few MB, so they are searched with plain numpy
(an exact matrix product), no vector database.
"""
from __future__ import annotations

import hashlib
import logging
import re
import threading

import numpy as np

from . import repo
from .config import Paths
from .db import DB
from .embed import unit
from .vocab import VISUAL_VOCAB

log = logging.getLogger("aether.semantic")

TEXT_CHARS = 1800        # of an item's text that is embedded (bge reads ~2000 characters at most)
OCR_CHARS = 600
# Titles the extension makes up when a page has none. Embedded on their own they are noise that every
# query is mildly similar to, so an item whose only text is such a title gets no text vector.
GENERIC_TITLE = re.compile(r"^\s*(image from .+|saved image\b.*|untitled.*|image|photo|screenshot.*)\s*$", re.I)

# Calibrated on a labelled library (see README, "Search by meaning").
TEXT_Z = 4.0             # a text match must stand this many robust deviations above the library's typical similarity
TEXT_Z_MIN_VECTORS = 12  # ...which needs enough items to say what "typical" is
TEXT_COS_FLOOR = 0.60    # fallback for very small libraries
IMAGE_P = 0.10           # a picture matches when the query beats ~170 competing descriptions with this probability...
IMAGE_REL = 0.25         # ...and it is at least this fraction of the best picture's probability
CLIP_TEMP = 100.0        # CLIP's own logit scale
RRF_K = 60


def _sha(*parts: str) -> str:
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()


class Semantic:
    def __init__(self, db: DB, paths: Paths, embedder) -> None:
        self.db, self.paths, self.emb = db, paths, embedder
        self._cache: dict = {}
        self._lock = threading.Lock()

    def unload(self) -> None:
        """Free models and cached vectors while nobody is looking (background mode)."""
        with self._lock:
            self._cache.clear()
        if hasattr(self.emb, "unload"):
            self.emb.unload()

    # ------------------------------------------------------------ status
    def ready(self) -> bool:
        return bool(self.emb.has_text() and self.emb.has_image())

    def status(self) -> dict:
        c = self.db.conn()
        ids = self.emb.ids() if self.ready() else {}
        done = {k: c.execute("SELECT COUNT(*) FROM embeddings WHERE kind=? AND model=?", (k, ids.get(k))).fetchone()[0]
                for k in ("text", "image")}
        return {
            "models": self.ready(),
            "pending": c.execute("SELECT COUNT(*) FROM items WHERE embed_stale>0").fetchone()[0] if self.ready() else None,
            "text_vectors": done["text"], "image_vectors": done["image"],
            "items": c.execute("SELECT COUNT(*) FROM items").fetchone()[0],
        }

    # -------------------------------------------------------------- sync
    def _payload(self, c, item_id: int):
        r = c.execute("SELECT title, text, note FROM items WHERE id=?", (item_id,)).fetchone()
        if r is None:
            return None, None
        ocr = " ".join(x[0] for x in c.execute(
            "SELECT ocr_text FROM assets WHERE item_id=? AND ocr_text IS NOT NULL AND ocr_text != ''", (item_id,)))
        title = r["title"] or ""
        body = [r["note"], (r["text"] or "")[:TEXT_CHARS], ocr[:OCR_CHARS] if len(ocr.strip()) >= 15 else ""]
        if GENERIC_TITLE.match(title) and not any(p and p.strip() for p in body):
            title = ""
        text = ". ".join(p.strip() for p in [title, *body] if p and p.strip())
        asset = c.execute("SELECT thumb, sha256 FROM assets WHERE item_id=? ORDER BY position, id LIMIT 1", (item_id,)).fetchone()
        return text, asset

    def sync(self, limit: int = 16) -> int:
        """Embed the next batch of items whose content changed. Returns how many items were looked at."""
        if not self.ready():
            return 0
        c = self.db.conn()
        rows = c.execute("SELECT id, embed_stale FROM items WHERE embed_stale>0 ORDER BY id LIMIT ?", (limit,)).fetchall()
        if not rows:
            return 0
        mid = self.emb.ids()
        todo_t, todo_i, drop = [], [], []
        for r in rows:
            iid = r["id"]
            text, asset = self._payload(c, iid)
            if text is None:
                continue
            for kind, want, payload in (("text", text or None, text),
                                        ("image", asset["sha256"] if asset else None, asset["thumb"] if asset else None)):
                h = _sha(mid[kind], want) if want else None
                have = c.execute("SELECT src_hash FROM embeddings WHERE item_id=? AND kind=?", (iid, kind)).fetchone()
                if h is None:
                    if have:
                        drop.append((iid, kind))
                elif not have or have["src_hash"] != h:
                    (todo_t if kind == "text" else todo_i).append((iid, h, payload))

        tvec = self.emb.text_vectors([p for _, _, p in todo_t]) if todo_t else []
        ivec, ok_i = [], []
        for item in todo_i:       # per file: one unreadable picture must not block the batch
            try:
                ivec.append(self.emb.image_vectors([self.paths.thumbs / item[2]])[0])
                ok_i.append(item)
            except Exception as e:
                log.warning("image embedding skipped for item %s: %s", item[0], e)

        sql = ("INSERT OR REPLACE INTO embeddings(item_id, kind, model, dim, vector, src_hash) "
               "SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM items WHERE id=?)")
        with self.db.tx() as w:
            for kind, items, vecs in (("text", todo_t, tvec), ("image", ok_i, ivec)):
                for (iid, h, _), v in zip(items, vecs):
                    v = np.asarray(v, dtype=np.float32)
                    w.execute(sql, (iid, kind, mid[kind], int(v.shape[0]), v.tobytes(), h, iid))
            for iid, kind in drop:
                w.execute("DELETE FROM embeddings WHERE item_id=? AND kind=?", (iid, kind))
            for r in rows:   # only if nothing changed meanwhile; otherwise the item is picked up again
                w.execute("UPDATE items SET embed_stale=0 WHERE id=? AND embed_stale=?", (r["id"], r["embed_stale"]))
        return len(rows)

    # ------------------------------------------------------------ vectors
    def _load(self, kind: str):
        model = self.emb.ids()[kind]
        c = self.db.conn()
        n, s = c.execute("SELECT COUNT(*), COALESCE(SUM(rowid),0) FROM embeddings WHERE kind=? AND model=?", (kind, model)).fetchone()
        sig = (n, s, model)
        with self._lock:
            hit = self._cache.get(kind)
            if hit and hit[0] == sig:
                return hit[1], hit[2]
        rows = c.execute("SELECT item_id, vector FROM embeddings WHERE kind=? AND model=? ORDER BY item_id", (kind, model)).fetchall()
        ids = np.array([r[0] for r in rows], dtype=np.int64)
        mat = np.stack([np.frombuffer(r[1], dtype=np.float32) for r in rows]) if rows else np.zeros((0, 1), np.float32)
        with self._lock:
            self._cache[kind] = (sig, ids, mat)
        return ids, mat

    def blended(self, visual: float = 0.5):
        """One vector per item mixing what it says (text) and what it looks like (image).
        `visual` 0 = text only, 1 = image only. A missing half is filled with the library average,
        so such an item sits 'in the middle' for that half instead of being pushed away."""
        visual = min(1.0, max(0.0, float(visual)))
        tids, tmat = self._load("text")
        iids, imat = self._load("image")
        key = ("blend", len(tids), len(iids), int(tmat.sum() * 1e3) if len(tids) else 0,
               int(imat.sum() * 1e3) if len(iids) else 0, round(visual, 2))
        with self._lock:
            hit = self._cache.get("blend")
            if hit and hit[0] == key:
                return hit[1], hit[2]
        all_ids = np.array(sorted(set(tids.tolist()) | set(iids.tolist())), dtype=np.int64)
        n = len(all_ids)
        if n == 0:
            return all_ids, np.zeros((0, 1), np.float32)
        pos = {int(i): k for k, i in enumerate(all_ids)}
        parts = []
        for ids, mat, w in ((tids, tmat, 1 - visual), (iids, imat, visual)):
            if not len(ids) or w <= 0:
                continue
            block = np.repeat(unit(mat.mean(0, keepdims=True)), n, axis=0)
            block[[pos[int(i)] for i in ids]] = mat
            parts.append(block * np.float32(np.sqrt(w)))
        if not parts:   # visual=1 but no images (or 0 with no text): fall back to whatever exists
            return self.blended(0.0 if visual >= 1 else 1.0) if len(tids) + len(iids) else (all_ids, np.zeros((0, 1), np.float32))
        X = unit(np.concatenate(parts, axis=1))
        with self._lock:
            self._cache["blend"] = (key, all_ids, X)
        return all_ids, X

    # ------------------------------------------------------------- search
    def vocab_vectors(self) -> np.ndarray:
        """CLIP text vectors for the concept vocabulary, computed once per process."""
        with self._lock:
            v = self._cache.get("vocab")
        if v is None:
            v = self.emb.clip_text_vectors([f"a photo of {w}" for w in VISUAL_VOCAB])
            with self._lock:
                self._cache["vocab"] = v
        return v

    def image_probability(self, q: str, imat: np.ndarray) -> np.ndarray:
        """For each picture: how likely is 'a photo of <q>' to be the best description of it, among
        ~170 common concepts? A raw CLIP similarity says little on its own (a cat scores 0.24 for
        'pizza' and a pizza 0.24); against competitors it separates cleanly. Concepts that mean
        (nearly) the same as the query are left out, or they would split the probability with it."""
        qv = self.emb.clip_text_vectors([f"a photo of {q}"])[0]
        vocab = self.vocab_vectors()
        vocab = vocab[vocab @ qv < 0.90]
        logits = CLIP_TEMP * (imat @ np.vstack([qv, vocab]).T)
        logits -= logits.max(axis=1, keepdims=True)
        e = np.exp(logits)
        return e[:, 0] / e.sum(axis=1)

    def search(self, q: str, k: int = 200) -> list[int]:
        """Item ids ranked by meaning: text matches, picture matches and keyword matches, fused."""
        q = (q or "").strip()
        if not q or not self.ready():
            return []
        lists: list[list[int]] = []
        tids, tmat = self._load("text")
        if len(tids):
            s = tmat @ self.emb.text_vectors([q], query=True)[0]
            if len(tids) >= TEXT_Z_MIN_VECTORS:
                med = float(np.median(s))
                mad = float(np.median(np.abs(s - med))) * 1.4826 or 1e-6
                keep = (s - med) / mad >= TEXT_Z
            else:
                keep = s >= TEXT_COS_FLOOR
            lists.append([int(tids[i]) for i in np.argsort(-s)[:k] if keep[i]])
        iids, imat = self._load("image")
        if len(iids):
            p = self.image_probability(q, imat)
            if p.max() >= IMAGE_P:
                lists.append([int(iids[i]) for i in np.argsort(-p)[:k] if p[i] >= max(IMAGE_P, IMAGE_REL * p.max())])
        fts = repo.fts_query(q)
        if fts:
            lists.append([r[0] for r in self.db.conn().execute(
                "SELECT rowid FROM items_fts WHERE items_fts MATCH ? ORDER BY bm25(items_fts) LIMIT 50", (fts,))])
        score: dict[int, float] = {}
        for lst in lists:
            for rank, iid in enumerate(lst):
                score[iid] = score.get(iid, 0.0) + 1.0 / (RRF_K + rank)
        return [i for i, _ in sorted(score.items(), key=lambda kv: -kv[1])][:k]

    # ------------------------------------------------- related / suggestions
    def neighbours(self, item_id: int, k: int = 12, visual: float = 0.5) -> list[tuple[int, float]]:
        ids, X = self.blended(visual)
        where = np.nonzero(ids == item_id)[0]
        if not len(where):
            return []
        s = X @ X[where[0]]
        order = np.argsort(-s)
        return [(int(ids[i]), float(s[i])) for i in order if ids[i] != item_id][:k]

    def suggest_tags(self, item_id: int, k: int = 15, visual: float = 0.5) -> list[dict]:
        """Tags worn by the items most like this one (only tags a person typed or accepted, never the
        automatic source/type tags). Closer neighbours count for more."""
        nb = self.neighbours(item_id, k, visual)
        if not nb:
            return []
        c = self.db.conn()
        have = {r[0] for r in c.execute(
            "SELECT t.name FROM item_tags it JOIN tags t ON t.id=it.tag_id WHERE it.item_id=?", (item_id,))}
        w = {i: max(s, 0.0) ** 4 for i, s in nb}          # sharpen: 0.9 counts ~2x as much as 0.75
        total = sum(w.values()) or 1.0
        ph = ",".join("?" * len(w))
        score: dict[str, float] = {}
        support: dict[str, int] = {}
        for r in c.execute(
                f"SELECT it.item_id, t.name FROM item_tags it JOIN tags t ON t.id=it.tag_id "
                f"WHERE it.origin IN ('manual','accepted') AND it.item_id IN ({ph})", list(w)):
            score[r["name"]] = score.get(r["name"], 0.0) + w[r["item_id"]] / total
            support[r["name"]] = support.get(r["name"], 0) + 1
        out = [{"name": n, "score": round(s, 3), "support": support[n]}
               for n, s in score.items() if n not in have and support[n] >= 2 and s >= 0.2]
        return sorted(out, key=lambda d: -d["score"])[:6]

