"""All SQL lives here: items, assets, tags, full-text index."""
from __future__ import annotations

import re
import sqlite3
import time
from typing import Iterable, Optional

MAX_TEXT = 200_000


def now() -> int:
    return int(time.time())


# --------------------------------------------------------------------- tags
def normalize_tag(raw: str) -> Optional[str]:
    """Lower case, single spaces, and never a leading '#': in search, '#name' means "the tag name"."""
    t = re.sub(r"^[#\s]+", "", re.sub(r"\s+", " ", raw or "")).strip().lower()
    return t[:40].rstrip() or None


def fix_tag_names(c: sqlite3.Connection) -> int:
    """Rename (or merge) any stored tag that breaks the current rules, e.g. one saved with a leading '#'."""
    fixed = 0
    for r in c.execute("SELECT id, name FROM tags").fetchall():
        good = normalize_tag(r["name"])
        if good == r["name"]:
            continue
        fixed += 1
        if not good:
            c.execute("DELETE FROM tags WHERE id=?", (r["id"],))
            continue
        other = c.execute("SELECT id FROM tags WHERE name=? AND id<>?", (good, r["id"])).fetchone()
        if other is None:
            c.execute("UPDATE tags SET name=? WHERE id=?", (good, r["id"]))
        else:   # merge into the tag that already has the right name; a manual tag beats an automatic one
            c.execute("INSERT INTO item_tags(item_id, tag_id, origin) SELECT item_id, ?, origin FROM item_tags WHERE tag_id=? "
                      "ON CONFLICT(item_id, tag_id) DO UPDATE SET origin=excluded.origin WHERE excluded.origin='manual'",
                      (other["id"], r["id"]))
            c.execute("DELETE FROM tags WHERE id=?", (r["id"],))
    return fixed


def add_tags(c: sqlite3.Connection, item_id: int, names: Iterable[str], origin: str) -> None:
    for raw in names:
        name = normalize_tag(raw)
        if not name:
            continue
        c.execute("INSERT OR IGNORE INTO tags(name) VALUES (?)", (name,))
        tag_id = c.execute("SELECT id FROM tags WHERE name=?", (name,)).fetchone()[0]
        # A manual tag always wins over an auto one that already exists.
        c.execute(
            "INSERT INTO item_tags(item_id, tag_id, origin) VALUES (?,?,?) "
            "ON CONFLICT(item_id, tag_id) DO UPDATE SET origin=excluded.origin "
            "WHERE excluded.origin='manual'",
            (item_id, tag_id, origin),
        )


def remove_tags(c: sqlite3.Connection, item_id: int, names: Iterable[str]) -> None:
    for raw in names:
        name = normalize_tag(raw)
        if name:
            c.execute(
                "DELETE FROM item_tags WHERE item_id=? AND tag_id=(SELECT id FROM tags WHERE name=?)",
                (item_id, name),
            )
    prune_tags(c)


def prune_tags(c: sqlite3.Connection) -> None:
    c.execute("DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM item_tags)")


def list_tags(c: sqlite3.Connection) -> list[dict]:
    rows = c.execute(
        "SELECT t.name, COUNT(*) AS n FROM tags t JOIN item_tags it ON it.tag_id=t.id "
        "GROUP BY t.id ORDER BY n DESC, t.name"
    ).fetchall()
    return [{"name": r["name"], "count": r["n"]} for r in rows]


# ---------------------------------------------------------------- full text
def reindex(c: sqlite3.Connection, item_id: int) -> None:
    row = c.execute("SELECT title, text, author FROM items WHERE id=?", (item_id,)).fetchone()
    c.execute("DELETE FROM items_fts WHERE rowid=?", (item_id,))
    if not row:
        return
    c.execute("UPDATE items SET embed_stale = embed_stale + 1 WHERE id=?", (item_id,))  # re-check its embeddings
    ocr = " ".join(
        r[0] for r in c.execute(
            "SELECT ocr_text FROM assets WHERE item_id=? AND ocr_text IS NOT NULL AND ocr_text != ''",
            (item_id,),
        )
    )
    tags = " ".join(
        r[0] for r in c.execute(
            "SELECT t.name FROM item_tags it JOIN tags t ON t.id=it.tag_id WHERE it.item_id=?",
            (item_id,),
        )
    )
    c.execute(
        "INSERT INTO items_fts(rowid, title, text, ocr, tags, author) VALUES (?,?,?,?,?,?)",
        (item_id, row["title"] or "", row["text"] or "", ocr, tags, row["author"] or ""),
    )


def fts_query(q: Optional[str]) -> Optional[str]:
    tokens = re.findall(r"\w+", q or "", flags=re.UNICODE)
    return " ".join(f'"{t}"*' for t in tokens) if tokens else None


# -------------------------------------------------------------------- items
def create_or_update_item(c: sqlite3.Connection, *, canon: str, original_url: str, source: str,
                          type_: str, title, author, text, note, embed, created_at: int) -> tuple[int, bool]:
    text = (text or "")[:MAX_TEXT]
    row = c.execute(
        "SELECT id, title, author, text, note FROM items WHERE url_canonical=?", (canon,)
    ).fetchone()
    if row:
        sets: dict = {}
        if title and not row["title"]:
            sets["title"] = title
        if author and not row["author"]:
            sets["author"] = author
        if len(text) > len(row["text"] or ""):
            sets["text"] = text
        if note and note != row["note"]:
            sets["note"] = f'{row["note"]}\n{note}'.strip() if row["note"] else note
        sets["updated_at"] = now()
        cols = ", ".join(f"{k}=?" for k in sets)
        c.execute(f"UPDATE items SET {cols} WHERE id=?", [*sets.values(), row["id"]])
        return row["id"], False

    cur = c.execute(
        "INSERT INTO items(url_canonical, original_url, source, type, author, title, text, note, "
        "embed_provider, embed_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        (canon, original_url, source, type_, author, title, text, note,
         embed.provider if embed else None, embed.id if embed else None, created_at, now()),
    )
    return cur.lastrowid, True


def _card(r: sqlite3.Row) -> dict:
    return {
        "id": r["id"], "title": r["title"], "source": r["source"], "type": r["type"],
        "author": r["author"], "url": r["original_url"], "created_at": r["created_at"],
        "snippet": (r["snippet"] or "").strip(),
        "thumb": f"/files/thumbs/{r['thumb']}" if r["thumb"] else None,
        "w": r["tw"], "h": r["th"], "color": r["color"],
        "embed_provider": r["embed_provider"], "tags": [],
    }


def list_items(c: sqlite3.Connection, *, q=None, tags=(), source=None, type_=None,
               limit=200, offset=0, sort="new", only_ids=None, cluster=None) -> dict:
    """`only_ids` restricts to those items AND keeps that order (ranked results: search by meaning,
    related items). `cluster` restricts to one cluster (0 = items that fit none)."""
    joins, where, params = "", [], []
    ranked: list[int] = []
    if only_ids is not None:
        ranked = [int(i) for i in only_ids][:1000]
        if not ranked:
            return {"items": [], "total": 0}
        where.append(f"i.id IN ({','.join('?' * len(ranked))})")
        params += ranked
    if cluster is not None:
        if cluster == 0:
            where.append("i.id NOT IN (SELECT item_id FROM item_clusters WHERE cluster_id IS NOT NULL)")
        else:
            where.append("i.id IN (SELECT item_id FROM item_clusters WHERE cluster_id=?)")
            params.append(cluster)
    fts = fts_query(q)
    if fts:
        joins = "JOIN items_fts ON items_fts.rowid = i.id"
        where.append("items_fts MATCH ?")
        params.append(fts)
    if source:
        where.append("i.source=?")
        params.append(source)
    if type_:
        where.append("i.type=?")
        params.append(type_)
    names = [n for n in (normalize_tag(t) for t in tags) if n]
    if names:
        ph = ",".join("?" * len(names))
        where.append(
            "i.id IN (SELECT it.item_id FROM item_tags it JOIN tags t ON t.id=it.tag_id "
            f"WHERE t.name IN ({ph}) GROUP BY it.item_id HAVING COUNT(DISTINCT t.id)=?)"
        )
        params += names + [len(names)]
    w = (" WHERE " + " AND ".join(where)) if where else ""

    total = c.execute(f"SELECT COUNT(*) FROM items i {joins}{w}", params).fetchone()[0]
    order_params: list = []
    if ranked:
        order = "CASE i.id " + " ".join("WHEN ? THEN ?" for _ in ranked) + " END"
        order_params = [v for pair in zip(ranked, range(len(ranked))) for v in pair]
    elif fts:
        order = "bm25(items_fts), i.id DESC"
    else:
        order = "i.created_at ASC, i.id ASC" if sort == "old" else "i.created_at DESC, i.id DESC"
    rows = c.execute(
        "SELECT i.id, i.title, i.source, i.type, i.author, i.original_url, i.created_at, "
        "i.embed_provider, substr(i.text, 1, 240) AS snippet, a.thumb, a.tw, a.th, a.color "
        f"FROM items i {joins} "
        "LEFT JOIN assets a ON a.id = (SELECT id FROM assets WHERE item_id=i.id ORDER BY position, id LIMIT 1) "
        f"{w} ORDER BY {order} LIMIT ? OFFSET ?",
        [*params, *order_params, limit, offset],
    ).fetchall()

    items = [_card(r) for r in rows]
    if items:
        by_id = {it["id"]: it for it in items}
        ph = ",".join("?" * len(by_id))
        for r in c.execute(
            f"SELECT it.item_id, t.name, it.origin FROM item_tags it JOIN tags t ON t.id=it.tag_id "
            f"WHERE it.item_id IN ({ph}) ORDER BY t.name",
            list(by_id),
        ):
            by_id[r["item_id"]]["tags"].append({"name": r["name"], "origin": r["origin"]})
    return {"items": items, "total": total}


def get_item(c: sqlite3.Connection, item_id: int) -> Optional[dict]:
    r = c.execute("SELECT * FROM items WHERE id=?", (item_id,)).fetchone()
    if not r:
        return None
    assets = [
        {
            "id": a["id"], "kind": a["kind"], "w": a["w"], "h": a["h"], "color": a["color"],
            "url": f"/files/originals/{a['path']}", "thumb": f"/files/thumbs/{a['thumb']}",
            "ocr_text": a["ocr_text"], "src_url": a["src_url"],
        }
        for a in c.execute("SELECT * FROM assets WHERE item_id=? ORDER BY position, id", (item_id,))
    ]
    tags = [
        {"name": t["name"], "origin": t["origin"]}
        for t in c.execute(
            "SELECT t.name, it.origin FROM item_tags it JOIN tags t ON t.id=it.tag_id "
            "WHERE it.item_id=? ORDER BY t.name", (item_id,))
    ]
    return {
        "id": r["id"], "url": r["original_url"], "canonical": r["url_canonical"],
        "source": r["source"], "type": r["type"], "author": r["author"], "title": r["title"],
        "text": r["text"], "note": r["note"],
        "embed": {"provider": r["embed_provider"], "id": r["embed_id"]} if r["embed_provider"] else None,
        "created_at": r["created_at"], "assets": assets, "tags": tags, **item_links(c, item_id),
    }


def update_item(c: sqlite3.Connection, item_id: int, *, title=None, note=None,
                add=(), remove=()) -> bool:
    if not c.execute("SELECT 1 FROM items WHERE id=?", (item_id,)).fetchone():
        return False
    if title is not None:
        c.execute("UPDATE items SET title=?, updated_at=? WHERE id=?", (title, now(), item_id))
    if note is not None:
        c.execute("UPDATE items SET note=?, updated_at=? WHERE id=?", (note, now(), item_id))
    if remove:
        remove_tags(c, item_id, remove)
    if add:
        add_tags(c, item_id, add, "manual")
    reindex(c, item_id)
    return True


# -------------------------------------------------------------------- links
def add_link(c: sqlite3.Connection, src: int, dst: int) -> Optional[bool]:
    """A hand-drawn one-way link. None if either item is missing; False if it already existed."""
    if c.execute("SELECT COUNT(*) FROM items WHERE id IN (?, ?)", (src, dst)).fetchone()[0] < 2:
        return None
    return c.execute("INSERT OR IGNORE INTO links(src, dst, created_at) VALUES (?,?,?)", (src, dst, now())).rowcount == 1


def remove_link(c: sqlite3.Connection, src: int, dst: int) -> bool:
    return c.execute("DELETE FROM links WHERE src=? AND dst=?", (src, dst)).rowcount == 1


def _pair(a: int, b: int) -> tuple[int, int]:
    return (a, b) if a < b else (b, a)


def remove_links(c: sqlite3.Connection, links: list[dict]) -> dict:
    """Deletes your arrows ('man': src -> dst) and hides automatic links ('sim', 'tag' + tag) for good."""
    deleted = hidden = 0
    t = now()
    for l in links:
        if l["kind"] == "man":
            deleted += c.execute("DELETE FROM links WHERE src=? AND dst=?", (l["src"], l["dst"])).rowcount
        else:
            a, b = _pair(l["src"], l["dst"])
            hidden += c.execute("INSERT OR IGNORE INTO hidden_links(a, b, kind, tag, created_at) "
                                "SELECT ?,?,?,?,? WHERE (SELECT COUNT(*) FROM items WHERE id IN (?,?)) = 2",
                                (a, b, l["kind"], (l.get("tag") or "") if l["kind"] == "tag" else "", t, a, b)).rowcount
    return {"deleted": deleted, "hidden": hidden}


def restore_links(c: sqlite3.Connection, links: list[dict] | None) -> int:
    """Un-hides automatic links (all of them when links is None) and re-creates arrows given as 'man'."""
    if links is None:
        return c.execute("DELETE FROM hidden_links").rowcount
    n = 0
    for l in links:
        if l["kind"] == "man":
            n += bool(add_link(c, l["src"], l["dst"]))
        else:
            a, b = _pair(l["src"], l["dst"])
            n += c.execute("DELETE FROM hidden_links WHERE a=? AND b=? AND kind=? AND tag=?",
                           (a, b, l["kind"], (l.get("tag") or "") if l["kind"] == "tag" else "")).rowcount
    return n


def hidden_count(c: sqlite3.Connection) -> int:
    return c.execute("SELECT COUNT(*) FROM hidden_links").fetchone()[0]


def item_links(c: sqlite3.Connection, item_id: int) -> dict:
    def rows(sql):
        return [{"id": r["id"], "title": r["title"] or r["original_url"]} for r in c.execute(sql, (item_id,))]
    return {
        "links_to": rows("SELECT i.id, i.title, i.original_url FROM links l JOIN items i ON i.id=l.dst WHERE l.src=? ORDER BY l.created_at"),
        "linked_from": rows("SELECT i.id, i.title, i.original_url FROM links l JOIN items i ON i.id=l.src WHERE l.dst=? ORDER BY l.created_at"),
    }


def delete_item(c: sqlite3.Connection, item_id: int) -> Optional[list[str]]:
    """Delete an item; returns its thumbnail file names so the caller can unlink them."""
    if not c.execute("SELECT 1 FROM items WHERE id=?", (item_id,)).fetchone():
        return None
    thumbs = [r[0] for r in c.execute("SELECT thumb FROM assets WHERE item_id=?", (item_id,))]
    c.execute("DELETE FROM items_fts WHERE rowid=?", (item_id,))
    c.execute("DELETE FROM items WHERE id=?", (item_id,))
    prune_tags(c)
    return thumbs


def stats(c: sqlite3.Connection) -> dict:
    return {
        "items": c.execute("SELECT COUNT(*) FROM items").fetchone()[0],
        "assets": c.execute("SELECT COUNT(*) FROM assets").fetchone()[0],
        "by_source": {r["source"]: r["n"] for r in c.execute(
            "SELECT source, COUNT(*) AS n FROM items GROUP BY source ORDER BY n DESC")},
        "by_type": {r["type"]: r["n"] for r in c.execute(
            "SELECT type, COUNT(*) AS n FROM items GROUP BY type ORDER BY n DESC")},
        "jobs": {r["status"]: r["n"] for r in c.execute(
            "SELECT status, COUNT(*) AS n FROM jobs GROUP BY status")},
    }
