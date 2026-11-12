"""Phase 2: embeddings, search by meaning, related items, tag suggestions, topics.
A fake embedder stands in for the ONNX models, so these run without the 700 MB download."""
import hashlib
import io
import json
import re
import sys
import time
from pathlib import Path

import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from engine import repo  # noqa: E402
from engine.db import DB  # noqa: E402
from engine.embed import unit  # noqa: E402
from engine.main import create_app  # noqa: E402

DIM = 48
COLORS = {"red": (220, 30, 30), "green": (30, 200, 60), "blue": (30, 60, 220)}


def _word_vec(w: str) -> np.ndarray:
    seed = int(hashlib.sha1(w.encode()).hexdigest()[:8], 16)
    return np.random.default_rng(seed).standard_normal(DIM).astype(np.float32)


def _bag(text: str) -> np.ndarray:
    words = re.findall(r"[a-z]{3,}", text.lower()) or ["empty"]
    return unit(np.sum([_word_vec(w) for w in words], axis=0, keepdims=True))[0]


class FakeEmbedder:
    """Words hash to random directions; a picture 'looks like' the colour word of its fill."""
    def __init__(self):
        self.text_calls = 0
        self.image_calls = 0

    def has_text(self): return True
    def has_image(self): return True
    def ids(self): return {"text": "fake-text", "image": "fake-image"}

    def text_vectors(self, texts, *, query=False):
        self.text_calls += len(texts)
        return np.stack([_bag(t) for t in texts]).astype(np.float32)

    def clip_text_vectors(self, texts):
        return np.stack([_bag(t.replace("a photo of", "")) for t in texts]).astype(np.float32)

    def image_vectors(self, files):
        self.image_calls += len(files)
        out = []
        for f in files:
            px = np.array(Image.open(f).convert("RGB").resize((1, 1))).reshape(3)
            name = min(COLORS, key=lambda k: np.abs(np.array(COLORS[k]) - px).sum())
            out.append(_word_vec(name))
        return unit(np.stack(out)).astype(np.float32)


def _rand_words(seed, n):
    import random
    r = random.Random(seed)
    return ["".join(r.choice("abcdefghijklmnopqrstuvwxyz") for _ in range(6)) for _ in range(n)]


def png(color) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (320, 240), color).save(buf, "PNG")
    return buf.getvalue()


@pytest.fixture()
def fake():
    return FakeEmbedder()


@pytest.fixture()
def client(tmp_path, fake):
    app = create_app(tmp_path, embedder=fake)
    with TestClient(app, base_url="http://127.0.0.1:47821") as c:
        c.headers.update({"X-Aether-Token": app.state.token})
        c.fake = fake
        yield c


def add(client, n, title, text="", color=None, tags=(), type_="article"):
    meta = {"original_url": f"https://example.com/{n}", "type": type_, "title": title, "text": text or None, "tags": list(tags)}
    files = []
    if color:
        meta.update(asset_kinds=["image"], asset_srcs=["https://cdn/x.png"])
        files = [("files", ("a.png", png(COLORS[color]), "image/png"))]
    r = client.post("/api/capture", data={"meta": json.dumps(meta)}, files=files)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def settle(client, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        s = client.get("/api/embeddings/status").json()
        if s["pending"] == 0:
            return s
        time.sleep(0.1)
    raise AssertionError("embedding did not finish: " + json.dumps(s))


def wait_clusters(client, timeout=240):
    end = time.time() + timeout
    while time.time() < end:
        if client.get("/api/clusters").json()["state"]["state"] != "running":
            return
        time.sleep(0.5)
    raise AssertionError("clustering did not finish")


# ------------------------------------------------------------ without models
def test_meaning_search_needs_models(tmp_path):
    app = create_app(tmp_path)          # real embedder, no model files
    with TestClient(app, base_url="http://127.0.0.1:47821") as c:
        c.headers.update({"X-Aether-Token": app.state.token})
        assert c.get("/api/embeddings/status").json()["models"] is False
        r = c.get("/api/items", params={"q": "cat", "mode": "meaning"})
        assert r.status_code == 409 and r.json()["detail"] == "models-missing"
        assert c.get("/api/items", params={"q": "cat"}).status_code == 200       # keyword search is unaffected
        assert c.post("/api/clusters/recompute", json={"visual": 0.5}).status_code == 409


# ---------------------------------------------------------------- embedding
def test_items_are_embedded_and_unchanged_input_is_not_redone(client):
    a = add(client, 1, "Sourdough starter", "flour water bread baking", color="red")
    add(client, 2, "Harbour sunrise", "boats water morning", color="blue")
    s = settle(client)
    assert s["text_vectors"] == 2 and s["image_vectors"] == 2

    before = (client.fake.text_calls, client.fake.image_calls)
    # a tag change reindexes the item (stale counter goes up) but its text and picture are the same
    client.patch(f"/api/items/{a}", json={"add_tags": ["food"]})
    settle(client)
    assert (client.fake.text_calls, client.fake.image_calls) == before

    # changing what is embedded does re-embed, and only the text
    client.patch(f"/api/items/{a}", json={"note": "grandma's recipe"})
    settle(client)
    assert client.fake.text_calls == before[0] + 1 and client.fake.image_calls == before[1]


def test_made_up_titles_alone_are_not_embedded(client):
    add(client, 1, "Saved image 7", "", color="green", type_="image")
    s = settle(client)
    assert s["text_vectors"] == 0 and s["image_vectors"] == 1


def test_deleting_an_item_drops_its_vectors(client):
    a = add(client, 1, "Doomed", "words here", color="red")
    settle(client)
    client.delete(f"/api/items/{a}")
    s = client.get("/api/embeddings/status").json()
    assert s["text_vectors"] == 0 and s["image_vectors"] == 0


# ------------------------------------------------------------------- search
def test_meaning_search_text_picture_and_nonsense(client):
    bread = add(client, 1, "Sourdough starter", "flour water bread baking oven")
    add(client, 2, "Tax forms", "invoice receipts deduction filing")
    for i in range(3, 16):
        add(client, i, f"Filler {i}", " ".join(_rand_words(i, 8)))
    settle(client)

    ids = [i["id"] for i in client.get("/api/items", params={"q": "baking bread flour", "mode": "meaning"}).json()["items"]]
    assert ids and ids[0] == bread
    assert client.get("/api/items", params={"q": "zzqq xylophone", "mode": "meaning"}).json()["total"] == 0


def test_only_ids_orders_results_and_respects_filters(client):
    a = add(client, 1, "one", "alpha", tags=["x"])
    b = add(client, 2, "two", "beta")
    c = add(client, 3, "three", "gamma", tags=["x"])
    conn = DB(client.app.state.paths.db).conn() if hasattr(client.app.state, "paths") else None
    if conn is None:
        pytest.skip("paths not exposed")
    res = repo.list_items(conn, only_ids=[c, a, b])
    assert [i["id"] for i in res["items"]] == [c, a, b]
    res = repo.list_items(conn, only_ids=[c, a, b], tags=["x"])
    assert [i["id"] for i in res["items"]] == [c, a]


# ---------------------------------------------------- related and suggestions
def test_related_items_and_tag_suggestions(client):
    reds = [add(client, i, f"Red thing {i}", "", color="red", tags=["warm"]) for i in range(1, 5)]
    blues = [add(client, i, f"Blue thing {i}", "", color="blue", tags=["cool"]) for i in range(5, 9)]
    fresh = add(client, 9, "Another red", "", color="red")
    settle(client)

    rel = client.get(f"/api/items/{fresh}/related", params={"limit": 4, "visual": 1}).json()["items"]
    assert {i["id"] for i in rel} == set(reds)
    assert not set(blues) & {i["id"] for i in rel}

    sug = client.get(f"/api/items/{fresh}/suggest-tags").json()["tags"]
    assert sug and sug[0]["name"] == "warm" and sug[0]["support"] >= 2
    assert "cool" not in [t["name"] for t in sug]
    assert not {"web", "article", "image"} & {t["name"] for t in sug}      # automatic tags are never suggested

    # accepting a suggestion removes it from the list
    client.patch(f"/api/items/{fresh}", json={"add_tags": ["warm"]})
    assert "warm" not in [t["name"] for t in client.get(f"/api/items/{fresh}/suggest-tags").json()["tags"]]


# ------------------------------------------------------------------- topics
def test_topics_cluster_name_filter_and_promote(client):
    topics = {
        "forest": "pine trees moss woodland trail hiking",
        "kitchen": "recipe oven flour butter sugar baking",
        "engine": "piston turbo carburetor gearbox mechanic",
    }
    ids_by = {}
    n = 0
    for name, words in topics.items():
        ws = words.split()
        for k in range(7):
            n += 1
            ids_by.setdefault(name, []).append(
                add(client, n, f"{name} {k}", " ".join(ws[(k + j) % len(ws)] for j in range(4)) + f" {name}"))
    settle(client)

    wait_clusters(client)                      # the worker groups a library of this size by itself
    started = client.post("/api/clusters/recompute", json={"visual": 0.0}).json()
    assert started["started"] is True
    wait_clusters(client)
    data = client.get("/api/clusters").json()
    assert data["state"]["state"] == "idle", data["state"]
    assert len(data["clusters"]) >= 2

    # every cluster is (nearly) pure
    for c in data["clusters"]:
        got = client.get("/api/items", params={"cluster": c["id"], "limit": 100}).json()["items"]
        assert len(got) == c["size"]
        kinds = {i["title"].split()[0] for i in got}
        assert len(kinds) == 1, (c["name"], kinds)
    assert data["clusters"][0]["name"]

    # promote one cluster to a tag
    c0 = data["clusters"][0]
    r = client.post(f"/api/clusters/{c0['id']}/tag", json={"name": "My Topic"})
    assert r.json()["tagged"] == c0["size"]
    assert client.get("/api/items", params={"tag": "my topic"}).json()["total"] == c0["size"]
    assert client.post("/api/clusters/9999/tag", json={"name": "x"}).status_code == 404

    # the item drawer reports its topic
    member = client.get("/api/items", params={"cluster": c0["id"]}).json()["items"][0]["id"]
    assert client.get(f"/api/items/{member}").json()["cluster"]["id"] == c0["id"]

    # the map has a point per item
    assert len(client.get("/api/clusters/map").json()["points"]) == 21


def test_too_few_items_for_topics(client):
    for i in range(4):
        add(client, i, f"item {i}", f"some words {i}")
    settle(client)
    client.post("/api/clusters/recompute", json={"visual": 0.5})
    time.sleep(1.0)
    data = client.get("/api/clusters").json()
    assert data["clusters"] == [] and data["state"]["state"] != "failed"


# -------------------------------------------------------------------- graph
def test_graph_links_similar_items_and_shared_tags(client):
    reds = [add(client, i, f"Red {i}", "", color="red") for i in range(1, 6)]
    blues = [add(client, i, f"Blue {i}", "", color="blue") for i in range(6, 11)]
    greens = [add(client, i, f"Green {i}", "", color="green", tags=["leafy"]) for i in range(11, 13)]
    settle(client)

    g = client.get("/api/graph", params={"k": 3, "visual": 1}).json()
    assert g["models"] is True and len(g["nodes"]) == 12
    group = {n["id"]: "r" if n["id"] in reds else "b" if n["id"] in blues else "g" for n in g["nodes"]}
    assert g["similar"], "similar pictures should be linked"
    for a, b, w in g["similar"]:
        assert group[g["nodes"][a]["id"]] == group[g["nodes"][b]["id"]]     # never across colours
        assert 0 < w <= 1
    assert [t[2] for t in g["tagged"]] == ["leafy"]
    assert {g["nodes"][t[0]]["id"] for t in g["tagged"]} | {g["nodes"][t[1]]["id"] for t in g["tagged"]} == set(greens)

    # filters narrow the nodes; edges only join nodes that are drawn
    sub = client.get("/api/graph", params={"tag": "leafy"}).json()
    assert {n["id"] for n in sub["nodes"]} == set(greens)
    assert all(a < len(sub["nodes"]) and b < len(sub["nodes"]) for a, b, _ in sub["similar"])

    # tag links can be switched off, and k caps the similarity links per item
    assert client.get("/api/graph", params={"tag_links": "false"}).json()["tagged"] == []
    few = client.get("/api/graph", params={"k": 1, "visual": 1}).json()["similar"]
    assert len(few) <= len(g["similar"])

    # a similarity link you delete stays gone (either direction), until restored
    x, y, _ = g["similar"][0]
    src, dst = g["nodes"][y]["id"], g["nodes"][x]["id"]
    assert client.post("/api/links/remove", json={"links": [{"kind": "sim", "src": src, "dst": dst}]}).json()["hidden"] == 1
    pair = {src, dst}
    after = client.get("/api/graph", params={"k": 3, "visual": 1}).json()
    assert all({after["nodes"][a]["id"], after["nodes"][b]["id"]} != pair for a, b, _ in after["similar"])
    client.post("/api/links/restore", json={"all": True})
    again = client.get("/api/graph", params={"k": 3, "visual": 1}).json()
    assert any({again["nodes"][a]["id"], again["nodes"][b]["id"]} == pair for a, b, _ in again["similar"])


def test_graph_without_models_still_shows_tag_links(tmp_path):
    app = create_app(tmp_path)
    with TestClient(app, base_url="http://127.0.0.1:47821") as c:
        c.headers.update({"X-Aether-Token": app.state.token})
        for i in range(3):
            add(c, i, f"Thing {i}", "words", tags=["pair"] if i < 2 else [])
        g = c.get("/api/graph").json()
        assert g["models"] is False and g["similar"] == [] and len(g["nodes"]) == 3
        assert [t[2] for t in g["tagged"]] == ["pair"]


def test_graph_edge_rules():
    from engine.graph import similarity_edges, tag_edges
    rng = np.random.default_rng(0)
    base = unit(rng.standard_normal((2, 32)).astype(np.float32))
    X = np.vstack([unit(base[0] + 0.05 * rng.standard_normal((6, 32)).astype(np.float32)),
                   unit(base[1] + 0.05 * rng.standard_normal((6, 32)).astype(np.float32)),
                   unit(rng.standard_normal((1, 32)).astype(np.float32))])         # a loner
    edges = similarity_edges(X, k=3)
    assert edges and all((a < 6) == (b < 6) and max(a, b) < 12 for a, b, _ in edges)
    assert all(a < b for a, b, _ in edges)
    assert similarity_edges(X[:2], k=3) == []                                         # too few items to say what's typical

    tags = tag_edges({"pair": [4, 2], "ring": [1, 2, 3], "broad": list(range(40)), "solo": [9]})
    assert sorted(t[2] for t in tags) == ["pair"] + ["ring"] * 3                      # broad and solo tags are not drawn


def test_graph_controls_strictness_tag_choice_and_node_facts(client):
    for i in range(1, 7):
        add(client, i, f"Red {i}", "", color="red", tags=["warm"] if i <= 3 else ["spicy"])
    for i in range(7, 13):
        add(client, i, f"Blue {i}", "", color="blue")
    settle(client)

    g = client.get("/api/graph", params={"k": 5, "visual": 1}).json()
    assert {t["name"]: t["count"] for t in g["tag_names"]} == {"warm": 3, "spicy": 3}
    node = next(n for n in g["nodes"] if n["title"] == "Red 1")
    assert isinstance(node["created_at"], int) and "warm" in node["tags"]
    assert any("web" in n["tags"] for n in g["nodes"])          # all tags, automatic ones too (the UI can highlight by them)

    # only the chosen tags make links, but the picker still lists every eligible tag
    only = client.get("/api/graph", params={"link_tag": "warm", "visual": 1}).json()
    assert {t[2] for t in only["tagged"]} == {"warm"} and len(only["tag_names"]) == 2
    both = client.get("/api/graph", params={"link_tag": ["warm", "Spicy"], "visual": 1}).json()
    assert {t[2] for t in both["tagged"]} == {"warm", "spicy"}
    assert client.get("/api/graph", params={"tag_links": "false"}).json()["tagged"] == []

    # a stricter match never adds links; an impossible one removes them all
    loose = client.get("/api/graph", params={"z": 1, "k": 5, "visual": 1}).json()["similar"]
    strict = client.get("/api/graph", params={"z": 8, "k": 5, "visual": 1}).json()["similar"]
    assert len(strict) <= len(loose) and loose
    assert client.get("/api/graph", params={"z": 99}).status_code == 422
