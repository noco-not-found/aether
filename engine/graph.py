"""The item network: which saved items are linked, for the graph view.

Three kinds of link:
  * similarity: each item to its nearest neighbours by meaning, kept only when the match stands out
    from what is typical for that item (the same robust z-score idea as search), so an item with
    nothing alike in the library gets no links rather than its least-bad ones;
  * tag: items you gave the same tag by hand (or accepted), for tags worn by a handful of items.
    Broad tags ("recipes" on 200 items) would turn the graph into a hairball, so they are skipped;
  * manual: one-way arrows you drew yourself (always shown when both ends are on screen).
"""
from __future__ import annotations

import numpy as np

SIM_Z = 3.0              # a neighbour must stand this many robust deviations above the item's typical similarity
MAX_TAG_GROUP = 10       # tags worn by more items than this are not drawn as links
MAX_NODES = 3000


def similarity_edges(X: np.ndarray, k: int, z: float = SIM_Z) -> list[tuple[int, int, float]]:
    """Top-k neighbours per row of the unit-vector matrix X, as (i, j, sim) with i < j."""
    n = len(X)
    if n < 3 or k < 1:
        return []
    S = X @ X.T
    np.fill_diagonal(S, -1.0)
    med = np.median(S, axis=1, keepdims=True)
    mad = np.median(np.abs(S - med), axis=1, keepdims=True) * 1.4826
    mad = np.maximum(mad, 1e-4)
    Z = (S - med) / mad
    kk = min(k, n - 1)
    top = np.argpartition(-S, kk - 1, axis=1)[:, :kk]
    best: dict[tuple[int, int], float] = {}
    for i in range(n):
        for j in top[i]:
            j = int(j)
            if Z[i, j] < z:
                continue
            key = (i, j) if i < j else (j, i)
            s = float(S[i, j])
            if s > best.get(key, -1.0):
                best[key] = s
    return [(a, b, s) for (a, b), s in best.items()]


def tag_edges(groups: dict[str, list[int]]) -> list[tuple[int, int, str]]:
    """groups: tag -> node indices. Pairs for two items, a ring for 3..MAX_TAG_GROUP (connected, uncluttered)."""
    out: list[tuple[int, int, str]] = []
    for name, members in groups.items():
        m = sorted(set(members))
        if len(m) < 2 or len(m) > MAX_TAG_GROUP:
            continue
        if len(m) == 2:
            out.append((m[0], m[1], name))
        else:
            out += [(m[i], m[(i + 1) % len(m)], name) for i in range(len(m))]
    return out


def build(c, cards: list[dict], total: int, sem, *, k: int, visual: float, use_tags: bool,
          z: float = SIM_Z, link_tags: list[str] | None = None) -> dict:
    """cards: items to draw (as returned by repo.list_items). Returns a JSON-ready graph."""
    truncated = total > min(len(cards), MAX_NODES)
    cards = cards[:MAX_NODES]
    index = {it["id"]: n for n, it in enumerate(cards)}
    ph = ",".join("?" * len(cards)) or "NULL"
    pos = {r["item_id"]: (r["cluster_id"], r["x"], r["y"]) for r in c.execute(
        f"SELECT item_id, cluster_id, x, y FROM item_clusters WHERE item_id IN ({ph})", [it["id"] for it in cards])}
    nodes = []
    for it in cards:
        cl, x, y = pos.get(it["id"], (None, None, None))
        nodes.append({"id": it["id"], "title": it["title"] or it["url"], "thumb": it.get("thumb"), "color": it.get("color"),
                      "source": it["source"], "type": it["type"], "cluster": cl, "x": x, "y": y,
                      "created_at": it.get("created_at"), "tags": [t["name"] for t in it.get("tags", [])]})

    sim: list[list] = []
    have_vectors = 0
    if sem is not None and sem.ready() and len(cards) >= 3:
        all_ids, X = sem.blended(visual)
        row = {int(i): r for r, i in enumerate(all_ids)}
        mine = [(index[i], row[i]) for i in index if i in row]
        have_vectors = len(mine)
        if len(mine) >= 3:
            node_ix = np.array([m[0] for m in mine])
            for a, b, s in similarity_edges(X[[m[1] for m in mine]], k, z):
                sim.append([int(node_ix[a]), int(node_ix[b]), round(s, 3)])

    tagged: list[list] = []
    tag_names: list[dict] = []
    if cards:
        groups: dict[str, list[int]] = {}
        for r in c.execute(
                "SELECT it.item_id, t.name FROM item_tags it JOIN tags t ON t.id=it.tag_id "
                f"WHERE it.origin IN ('manual','accepted') AND it.item_id IN ({ph})", [it["id"] for it in cards]):
            groups.setdefault(r["name"], []).append(index[r["item_id"]])
        tag_names = sorted(({"name": n, "count": len(set(m))} for n, m in groups.items() if 2 <= len(set(m)) <= MAX_TAG_GROUP),
                           key=lambda t: (-t["count"], t["name"]))
        if use_tags:
            allowed = {t.lower() for t in link_tags} if link_tags else None
            tagged = [[a, b, name] for a, b, name in tag_edges(groups) if allowed is None or name in allowed]

    manual: list[list] = []
    if cards:
        ids = [it["id"] for it in cards]
        manual = [[index[r["src"]], index[r["dst"]]] for r in c.execute(
            f"SELECT src, dst FROM links WHERE src IN ({ph}) AND dst IN ({ph})", ids + ids)]

    names = {r["id"]: r["name"] for r in c.execute("SELECT id, name FROM clusters")}
    return {
        "nodes": nodes,
        "similar": sim,
        "tagged": tagged,
        "tag_names": tag_names,
        "manual": manual,
        "clusters": [{"id": i, "name": names[i]} for i in sorted({n["cluster"] for n in nodes if n["cluster"] in names})],
        "models": bool(sem is not None and sem.ready()),
        "vectors": have_vectors,
        "truncated": truncated,
    }
