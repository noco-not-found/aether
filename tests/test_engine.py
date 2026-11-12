import io
import json
import sys
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from engine.main import create_app  # noqa: E402
from engine.urls import canonicalize, detect_source  # noqa: E402


def png(color=(200, 30, 30), size=(400, 300)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


@pytest.fixture()
def client(tmp_path):
    app = create_app(tmp_path)
    with TestClient(app, base_url="http://127.0.0.1:47821") as c:
        c.headers.update({"X-Aether-Token": app.state.token})
        yield c


def capture(client, url="https://example.com/post?utm_source=x", title="Moody blue UI study",
            tags=(), img=None, **extra):
    meta = {"original_url": url, "type": "article", "title": title, "text": "dark interface study",
            "tags": list(tags), "asset_kinds": ["image"], "asset_srcs": ["https://cdn/x.png"], **extra}
    files = [("files", ("a.png", img or png(), "image/png"))]
    return client.post("/api/capture", data={"meta": json.dumps(meta)}, files=files)


# ---------------------------------------------------------------- security
def test_health_is_open_but_api_needs_token(client):
    assert client.get("/api/health", headers={"X-Aether-Token": ""}).status_code == 200
    assert client.get("/api/items", headers={"X-Aether-Token": "nope"}).status_code == 401
    assert client.get("/api/items", headers={"X-Aether-Token": ""}).status_code == 401


def test_foreign_host_header_is_rejected(client):
    # DNS rebinding: attacker.example resolves to 127.0.0.1 but keeps its own Host header
    assert client.get("/api/health", headers={"Host": "attacker.example"}).status_code == 403


def test_ui_index_injects_token(client):
    r = client.get("/")
    assert r.status_code == 200
    assert client.app.state.token in r.text
    assert "frame-ancestors" in r.headers["content-security-policy"]


# ----------------------------------------------------------------- capture
def test_capture_search_tag_delete_roundtrip(client):
    r = capture(client, tags=["Design Inspo"])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["duplicate"] is False and body["new_assets"] == 1

    listing = client.get("/api/items", params={"q": "moody"}).json()
    assert listing["total"] == 1
    card = listing["items"][0]
    assert card["thumb"] and card["w"] and card["h"] and card["color"]
    names = {t["name"] for t in card["tags"]}
    assert {"design inspo", "web", "article"} <= names

    thumb = client.get(card["thumb"])
    assert thumb.status_code == 200 and thumb.headers["content-type"] == "image/webp"

    # prefix search + tag filter
    assert client.get("/api/items", params={"q": "interf"}).json()["total"] == 1
    assert client.get("/api/items", params={"tag": "design inspo"}).json()["total"] == 1
    assert client.get("/api/items", params={"tag": ["design inspo", "nope"]}).json()["total"] == 0

    # tags are searchable through FTS too
    client.patch(f"/api/items/{body['id']}", json={"add_tags": ["#Vaporwave"], "note": "revisit"})
    assert client.get("/api/items", params={"q": "vaporwave"}).json()["total"] == 1
    detail = client.get(f"/api/items/{body['id']}").json()
    assert detail["note"] == "revisit" and detail["assets"][0]["url"].startswith("/files/originals/")

    assert client.delete(f"/api/items/{body['id']}").status_code == 200
    assert client.get("/api/items").json()["total"] == 0
    assert client.get("/api/tags").json() == []
    assert client.get(card["thumb"]).status_code == 404


def test_resaving_same_page_dedups(client):
    first = capture(client, url="https://example.com/post?utm_source=x").json()
    second = capture(client, url="https://www.example.com/post/?fbclid=zzz", tags=["later"]).json()
    assert second["id"] == first["id"] and second["duplicate"] is True
    assert second["new_assets"] == 0  # identical image bytes are not stored twice
    assert client.get("/api/items").json()["total"] == 1
    assert client.get("/api/items", params={"tag": "later"}).json()["total"] == 1

    # a different image on the same item *is* added
    third = capture(client, url="https://example.com/post", img=png((10, 200, 10))).json()
    assert third["new_assets"] == 1
    assert len(client.get(f"/api/items/{first['id']}").json()["assets"]) == 2


def test_junk_uploads_are_ignored(client):
    meta = {"original_url": "https://example.com/a", "type": "page", "title": "no image"}
    files = [("files", ("x.png", b"not an image", "image/png")),
             ("files", ("tiny.png", png(size=(8, 8)), "image/png"))]
    r = client.post("/api/capture", data={"meta": json.dumps(meta)}, files=files)
    assert r.status_code == 200 and r.json()["new_assets"] == 0
    assert client.get("/api/items").json()["items"][0]["thumb"] is None


def test_bad_meta_is_rejected(client):
    r = client.post("/api/capture", data={"meta": json.dumps({"original_url": "javascript:alert(1)"})})
    assert r.status_code == 422
    r = client.post("/api/capture", data={"meta": "{}"})
    assert r.status_code == 422


def test_bulk_tag_and_delete(client):
    ids = [capture(client, url=f"https://example.com/{i}", img=png((i * 40, 0, 0))).json()["id"] for i in range(3)]
    client.post("/api/items/bulk", json={"ids": ids, "add_tags": ["batch"]})
    assert client.get("/api/items", params={"tag": "batch"}).json()["total"] == 3
    client.post("/api/items/bulk", json={"ids": ids[:2], "delete": True})
    assert client.get("/api/items").json()["total"] == 1


# -------------------------------------------------------------------- jobs
def test_ocr_jobs_are_queued_and_settle(client):
    capture(client)
    deadline = time.time() + 10
    while time.time() < deadline:
        jobs = client.get("/api/stats").json()["jobs"]
        if jobs and not (jobs.get("pending") or jobs.get("running")):
            break
        time.sleep(0.2)
    # 'skipped' when rapidocr is not installed, 'done' when it is
    assert set(jobs) <= {"done", "skipped"}, jobs


def test_running_jobs_are_recovered_after_a_crash(tmp_path):
    app = create_app(tmp_path)
    with app.state.db.tx() as c:
        iid = c.execute(
            "INSERT INTO items(url_canonical, original_url, source, type, created_at, updated_at) "
            "VALUES ('https://a.b/c','https://a.b/c','web','page',1,1)").lastrowid
        aid = c.execute(
            "INSERT INTO assets(item_id, path, thumb, sha256) VALUES (?, 'x', 'x', 'abc')", (iid,)).lastrowid
        c.execute("INSERT INTO jobs(type, item_id, asset_id, status, attempts, created_at) "
                  "VALUES ('ocr', ?, ?, 'running', 1, 1)", (iid, aid))
    app.state.worker.recover()
    status = app.state.db.conn().execute("SELECT status FROM jobs").fetchone()[0]
    assert status == "pending"


# --------------------------------------------------------------------- urls
@pytest.mark.parametrize("a,b", [
    ("https://youtu.be/dQw4w9WgXcQ?si=abc", "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s&feature=share"),
    ("https://youtube.com/shorts/dQw4w9WgXcQ", "https://m.youtube.com/watch?v=dQw4w9WgXcQ"),
    ("https://twitter.com/jack/status/20?s=20", "https://x.com/jack/status/20"),
    ("https://www.instagram.com/someone/reel/Cabc123/?igsh=zzz", "https://instagram.com/reel/Cabc123"),
    ("https://in.pinterest.com/pin/123456/", "https://www.pinterest.com/pin/123456/?utm_medium=x"),
    ("https://en.m.wikipedia.org/wiki/Cat#History", "https://en.wikipedia.org/wiki/Cat?oldid=5#History"),
    ("https://blog.example.com/a/?utm_campaign=1&id=7", "http://www.blog.example.com/a?id=7&fbclid=2"),
])
def test_canonicalize_merges_equivalent_urls(a, b):
    assert canonicalize(a) == canonicalize(b)


def test_canonicalize_keeps_distinct_pages_apart():
    assert canonicalize("https://example.com/a?id=1") != canonicalize("https://example.com/a?id=2")
    assert canonicalize("https://x.com/a/status/1") != canonicalize("https://x.com/a/status/2")


def test_wikipedia_fragment_is_part_of_identity():
    """#Section and the text directive say where an image/quote came from: different spots, different items."""
    base = "https://en.wikipedia.org/wiki/Cat"
    whole = canonicalize(base)
    history = canonicalize(base + "#History")
    quote = canonicalize(base + "#History:~:text=Cats%20are%20small")
    assert whole == base
    assert history == base + "#History"
    assert quote == base + "#History:~:text=Cats%20are%20small"
    assert len({whole, history, quote}) == 3
    # other sites still ignore fragments
    assert canonicalize("https://example.com/a#x") == canonicalize("https://example.com/a")


def test_detect_source():
    assert detect_source("https://www.youtube.com/watch?v=x") == "youtube"
    assert detect_source("https://mobile.twitter.com/a") == "x"
    assert detect_source("https://someone.tumblr.com/post/1") == "tumblr"
    assert detect_source("https://pinterest.co.uk/pin/1") == "pinterest"
    assert detect_source("https://news.ycombinator.com") == "web"


# ------------------------------------------------------- tags & hand-drawn links
def test_tags_never_start_with_a_hash(client):
    item = capture(client, tags=["#Ramen", "# #  spicy   food"]).json()["id"]
    names = {t["name"] for t in client.get(f"/api/items/{item}").json()["tags"]}
    assert {"ramen", "spicy food"} <= names and not any(n.startswith("#") for n in names)
    client.patch(f"/api/items/{item}", json={"add_tags": ["##todo", "#"]})
    names = {t["name"] for t in client.get(f"/api/items/{item}").json()["tags"]}
    assert "todo" in names and "" not in names and not any(n.startswith("#") for n in names)


def test_old_hash_tags_are_renamed_or_merged_on_start(tmp_path):
    from engine.db import DB
    app = create_app(tmp_path)
    with TestClient(app, base_url="http://127.0.0.1:47821") as c:
        c.headers.update({"X-Aether-Token": app.state.token})
        a = capture(c, url="https://e.com/a", tags=["ramen"]).json()["id"]
        b = capture(c, url="https://e.com/b").json()["id"]
    db = DB(next(tmp_path.rglob("*.db")))
    with db.tx() as conn:   # what an older version could have stored
        conn.execute("INSERT INTO tags(name) VALUES ('#ramen'), ('#solo')")
        for tid, item in ((conn.execute("SELECT id FROM tags WHERE name='#ramen'").fetchone()[0], b),
                          (conn.execute("SELECT id FROM tags WHERE name='#solo'").fetchone()[0], a)):
            conn.execute("INSERT INTO item_tags(item_id, tag_id, origin) VALUES (?,?, 'manual')", (item, tid))
    app = create_app(tmp_path)
    with TestClient(app, base_url="http://127.0.0.1:47821") as c:
        c.headers.update({"X-Aether-Token": app.state.token})
        tags = {t["name"]: t["count"] for t in c.get("/api/tags").json()}
    assert tags.get("ramen") == 2 and tags.get("solo") == 1 and not any(n.startswith("#") for n in tags)


def test_hand_drawn_links_are_one_way_and_go_with_their_items(client):
    a = capture(client, url="https://e.com/a", title="A").json()["id"]
    b = capture(client, url="https://e.com/b", title="B").json()["id"]
    cc = capture(client, url="https://e.com/c", title="C").json()["id"]
    assert client.post("/api/links", json={"src": a, "dst": b}).json()["created"] is True
    assert client.post("/api/links", json={"src": a, "dst": b}).json()["created"] is False
    assert client.post("/api/links", json={"src": b, "dst": cc}).status_code == 200
    assert client.post("/api/links", json={"src": a, "dst": a}).status_code == 400
    assert client.post("/api/links", json={"src": a, "dst": 9999}).status_code == 404
    item_b = client.get(f"/api/items/{b}").json()
    assert [x["title"] for x in item_b["linked_from"]] == ["A"] and [x["title"] for x in item_b["links_to"]] == ["C"]
    g = client.get("/api/graph").json()
    ix = {n["id"]: i for i, n in enumerate(g["nodes"])}
    assert sorted(map(tuple, g["manual"])) == sorted([(ix[a], ix[b]), (ix[b], ix[cc])])
    assert client.delete("/api/links", params={"src": b, "dst": a}).status_code == 404   # direction matters
    assert client.delete("/api/links", params={"src": a, "dst": b}).status_code == 200
    client.delete(f"/api/items/{cc}")
    assert client.get(f"/api/items/{b}").json()["links_to"] == [] and client.get("/api/graph").json()["manual"] == []


# ---------------------------------------------------------- background mode (packaged app)
def test_background_mode_saves_now_and_does_heavy_work_when_a_window_returns(tmp_path, monkeypatch):
    import engine.main as main_mod
    monkeypatch.setattr(main_mod, "AWAY_AFTER", 0)          # no window -> away immediately
    app = create_app(tmp_path, background_mode=True)
    with TestClient(app, base_url="http://127.0.0.1:47821") as c:
        c.headers.update({"X-Aether-Token": app.state.token})
        assert capture(c).status_code == 200                 # the extension can still save
        time.sleep(1.0)
        jobs = c.get("/api/stats").json()["jobs"]
        assert jobs.get("pending") == 1, jobs                # OCR waits while nobody is looking
        assert app.state.worker._unloaded
        monkeypatch.setattr(main_mod, "AWAY_AFTER", 3600)
        assert c.post("/api/presence", headers={"X-Aether-Client": "ui"}).json()["background"] is False
        deadline = time.time() + 10
        while time.time() < deadline:
            jobs = c.get("/api/stats").json()["jobs"]
            if not (jobs.get("pending") or jobs.get("running")):
                break
            time.sleep(0.2)
        assert set(jobs) <= {"done", "skipped"}, jobs


def test_app_endpoints_outside_the_packaged_app(client):
    info = client.get("/api/app").json()
    assert info["packaged"] is False and info["can_quit"] is False and info["version"]
    assert client.post("/api/app", json={"start_at_login": True}).status_code == 409
    assert client.post("/api/app/quit").status_code == 409
    assert client.get("/api/health").json()["app"] == "aether"


def test_graph_links_can_be_selected_and_deleted_of_every_kind(client):
    """Arrows are deleted; similarity / tag links are hidden for good (until restored)."""
    ids = [capture(client, url=f"https://e.com/{i}", title=f"T{i}", tags=["pair"] if i < 2 else []).json()["id"] for i in range(3)]
    a, b, c3 = ids
    client.post("/api/links", json={"src": a, "dst": c3})
    g = client.get("/api/graph").json()
    ix = {n["id"]: i for i, n in enumerate(g["nodes"])}
    assert [ix[a], ix[b], "pair"] in g["tagged"] or [ix[b], ix[a], "pair"] in g["tagged"]
    r = client.post("/api/links/remove", json={"links": [
        {"kind": "man", "src": a, "dst": c3}, {"kind": "tag", "src": b, "dst": a, "tag": "pair"}]}).json()
    assert r == {"deleted": 1, "hidden": 1}
    g = client.get("/api/graph").json()
    assert g["manual"] == [] and g["tagged"] == []
    assert client.get("/api/links/hidden").json()["count"] == 1
    # the tag itself stays, and the link survives other changes until restored
    assert "pair" in {t["name"] for t in client.get(f"/api/items/{a}").json()["tags"]}
    # undo brings both back
    assert client.post("/api/links/restore", json={"links": [
        {"kind": "man", "src": a, "dst": c3}, {"kind": "tag", "src": a, "dst": b, "tag": "pair"}]}).json()["restored"] == 2
    g = client.get("/api/graph").json()
    assert len(g["manual"]) == 1 and len(g["tagged"]) == 1
    client.post("/api/links/remove", json={"links": [{"kind": "tag", "src": a, "dst": b, "tag": "pair"}]})
    assert client.post("/api/links/restore", json={"all": True}).json()["restored"] == 1
    assert client.get("/api/links/hidden").json()["count"] == 0
    assert client.post("/api/links/remove", json={"links": [{"kind": "bogus", "src": a, "dst": b}]}).status_code == 422
