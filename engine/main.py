"""FastAPI app: authenticated capture + library API, and the static web UI.

Security model (localhost-only service):
  * binds to 127.0.0.1 (see __main__.py)
  * Host header must be 127.0.0.1/localhost  -> defeats DNS rebinding
  * every /api call except /api/health needs the install's secret token
    in the X-Aether-Token header -> other web pages cannot call the API
  * CORS only allows chrome-extension:// origins
"""
import hmac
import json
import re
import shutil
import threading
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal, Optional

from fastapi import APIRouter, Depends, FastAPI, File, Form, Header, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError

from . import __version__, desktop, jobs, models, repo
from . import graph as graph_mod
from .cluster import Clusterer
from .config import FROZEN, Paths, bundle_dir, default_port, default_root, load_token
from .db import DB
from .embed import OnnxEmbedder
from .images import process_image
from .semantic import Semantic
from .urls import canonicalize, detect_source

UI_DIR = bundle_dir() / "ui"
AWAY_AFTER = 90          # seconds without the UI before background mode starts (packaged app only)
MAX_FILES = 12
MAX_FILE_BYTES = 30 * 1024 * 1024
MIN_PIXELS = 50 * 50  # drops tracking pixels and icons
ALLOWED_HOSTS = {"127.0.0.1", "localhost"}


class Embed(BaseModel):
    provider: str
    id: str


class CaptureMeta(BaseModel):
    original_url: str
    type: Literal["video", "post", "image", "article", "page"] = "page"
    title: Optional[str] = None
    author: Optional[str] = None
    text: Optional[str] = None
    note: Optional[str] = None
    tags: list[str] = Field(default_factory=list)
    embed: Optional[Embed] = None
    asset_kinds: list[str] = Field(default_factory=list)
    asset_srcs: list[str] = Field(default_factory=list)
    captured_at: Optional[int] = None


class ItemPatch(BaseModel):
    title: Optional[str] = None
    note: Optional[str] = None
    add_tags: list[str] = Field(default_factory=list)
    remove_tags: list[str] = Field(default_factory=list)


class RecomputeBody(BaseModel):
    visual: float = Field(0.5, ge=0.0, le=1.0)    # 0 = group by what items say, 1 = by what they look like


class ClusterTagBody(BaseModel):
    name: str = Field(min_length=1, max_length=40)


class FetchBody(BaseModel):
    small: bool = False


class AppSettings(BaseModel):
    start_at_login: bool


class OpenBody(BaseModel):
    what: Literal["extension", "data"]


class LinkBody(BaseModel):
    src: int
    dst: int


class BulkOp(BaseModel):
    ids: list[int]
    add_tags: list[str] = Field(default_factory=list)
    remove_tags: list[str] = Field(default_factory=list)
    delete: bool = False


def create_app(root: Optional[Path] = None, embedder=None, background_mode: bool = False) -> FastAPI:
    """`embedder` lets tests supply a fake one; by default the ONNX models in <data dir>/models are used.
    `background_mode` (the packaged app): when no window has talked to the engine for AWAY_AFTER seconds,
    captures are still saved but OCR / embeddings / topics wait and the models are unloaded."""
    paths = Paths(Path(root) if root else default_root())
    paths.ensure()
    token = load_token(paths)
    db = DB(paths.db)
    db.init()
    with db.tx() as c:
        repo.fix_tag_names(c)
    sem = Semantic(db, paths, embedder or OnnxEmbedder(paths))
    clusterer = Clusterer(db, sem)
    worker = jobs.JobWorker(db, paths, sem, clusterer)
    fetch_state: dict = {"state": "idle", "log": [], "error": None}
    presence = {"ui": time.time()}
    worker.away = lambda: background_mode and time.time() - presence["ui"] > AWAY_AFTER

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        worker.start()
        yield
        worker.stop()

    app = FastAPI(title="Aether engine", version=__version__, lifespan=lifespan)
    app.state.token = token
    app.state.db = db
    app.state.paths = paths
    app.state.worker = worker
    app.state.semantic = sem
    app.state.clusterer = clusterer

    # ------------------------------------------------------------ middleware
    @app.middleware("http")
    async def guard(request: Request, call_next):
        host = request.headers.get("host", "").lower().rsplit(":", 1)[0]
        if host not in ALLOWED_HOSTS:
            return JSONResponse({"detail": "bad host"}, status_code=403)
        if request.headers.get("x-aether-client") == "ui":      # a window is open: leave background mode
            presence["ui"] = time.time()
            if worker._unloaded:
                worker.wake()
        response = await call_next(request)
        if request.url.path.startswith("/files/"):
            # file names are content hashes, so they never change
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response

    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"^chrome-extension://[a-p]{32}$",
        allow_methods=["*"],
        allow_headers=["X-Aether-Token", "Content-Type"],
    )

    def require_token(x_aether_token: Optional[str] = Header(default=None)) -> None:
        if not x_aether_token or not hmac.compare_digest(x_aether_token, token):
            raise HTTPException(status_code=401, detail="missing or wrong token")

    public = APIRouter(prefix="/api")
    api = APIRouter(prefix="/api", dependencies=[Depends(require_token)])

    @public.get("/health")
    def health():
        return {"ok": True, "version": __version__, "app": "aether"}

    # ---------------------------------------------------------- desktop app
    @api.post("/presence")
    def presence_ping():
        """The window says it is still there (sent every 30 s while visible)."""
        return {"background": worker.away()}

    @api.get("/app")
    def app_info():
        return {"packaged": FROZEN, "version": __version__, "start_at_login": desktop.start_at_login(),
                "data_dir": str(paths.root), "extension_dir": str(desktop.extension_dir(paths)),
                "can_quit": callable(getattr(app.state, "quit", None))}

    @api.post("/app")
    def app_settings(body: AppSettings):
        if not FROZEN:
            raise HTTPException(status_code=409, detail="only in the installed app")
        s = desktop.load_settings(paths)
        s["start_at_login"] = body.start_at_login
        desktop.save_settings(paths, s)
        desktop.set_start_at_login(body.start_at_login)
        return {"start_at_login": desktop.start_at_login()}

    @api.post("/app/open")
    def app_open(body: OpenBody):
        target = desktop.extension_dir(paths) if body.what == "extension" else paths.root
        if not desktop.open_folder(target):
            raise HTTPException(status_code=409, detail="only on Windows")
        return {"ok": True}

    @api.post("/app/quit")
    def app_quit():
        """Stops the engine (the extension cannot save until Aether is opened again)."""
        quit_ = getattr(app.state, "quit", None)
        if not callable(quit_):
            raise HTTPException(status_code=409, detail="not running as the app")
        threading.Timer(0.3, quit_).start()
        return {"ok": True}

    # --------------------------------------------------------------- capture
    @api.post("/capture")
    def capture(meta: str = Form(...), files: Optional[list[UploadFile]] = File(default=None)):
        try:
            m = CaptureMeta.model_validate_json(meta)
        except ValidationError as e:
            raise HTTPException(status_code=422, detail=e.errors(include_url=False, include_context=False))
        if not re.match(r"^https?://", m.original_url, re.I):
            raise HTTPException(status_code=422, detail="original_url must be http(s)")

        canon = canonicalize(m.original_url)
        source = detect_source(m.original_url)

        processed, seen = [], set()
        for idx, f in enumerate((files or [])[:MAX_FILES]):
            data = f.file.read(MAX_FILE_BYTES + 1)
            if len(data) > MAX_FILE_BYTES:
                continue
            pi = process_image(data)
            if pi is None or pi.w * pi.h < MIN_PIXELS or pi.sha256 in seen:
                continue
            seen.add(pi.sha256)
            kind = m.asset_kinds[idx] if idx < len(m.asset_kinds) else "image"
            src = m.asset_srcs[idx] if idx < len(m.asset_srcs) else None
            processed.append((pi, "screenshot" if kind == "screenshot" else "image", src))

        new_assets = 0
        with db.tx() as c:
            item_id, created = repo.create_or_update_item(
                c, canon=canon, original_url=m.original_url, source=source, type_=m.type,
                title=(m.title or "").strip()[:500] or None, author=(m.author or "").strip()[:200] or None,
                text=m.text, note=(m.note or "").strip() or None, embed=m.embed,
                created_at=m.captured_at or repo.now(),
            )
            have = {r[0] for r in c.execute("SELECT sha256 FROM assets WHERE item_id=?", (item_id,))}
            position = c.execute(
                "SELECT COALESCE(MAX(position) + 1, 0) FROM assets WHERE item_id=?", (item_id,)
            ).fetchone()[0]
            for pi, kind, src in processed:
                if pi.sha256 in have:
                    continue
                have.add(pi.sha256)
                name = pi.sha256[:20]
                rel = f"{item_id}/{name}.{pi.ext}"
                thumb = f"{item_id}_{name}.webp"
                (paths.originals / str(item_id)).mkdir(parents=True, exist_ok=True)
                (paths.originals / rel).write_bytes(pi.data)
                (paths.thumbs / thumb).write_bytes(pi.thumb)
                cur = c.execute(
                    "INSERT INTO assets(item_id, kind, path, thumb, w, h, tw, th, color, sha256, phash, "
                    "src_url, position) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (item_id, kind, rel, thumb, pi.w, pi.h, pi.tw, pi.th, pi.color, pi.sha256, pi.phash, src, position),
                )
                position += 1
                new_assets += 1
                if m.type != "video":
                    jobs.enqueue(c, "ocr", item_id, cur.lastrowid)
            repo.add_tags(c, item_id, [source, m.type], "auto")
            repo.add_tags(c, item_id, m.tags, "manual")
            repo.reindex(c, item_id)
        worker.wake()
        return {"id": item_id, "duplicate": not created, "new_assets": new_assets, "source": source}

    # --------------------------------------------------------------- library
    @api.get("/items")
    def list_items(
        q: Optional[str] = None,
        tag: list[str] = Query(default=[]),
        source: Optional[str] = None,
        type: Optional[str] = None,
        sort: Literal["new", "old"] = "new",
        mode: Literal["keyword", "meaning"] = "keyword",
        cluster: Optional[int] = Query(default=None, ge=0),
        limit: int = Query(200, ge=1, le=1000),
        offset: int = Query(0, ge=0),
    ):
        if mode == "meaning" and q and q.strip():
            if not sem.ready():
                raise HTTPException(status_code=409, detail="models-missing")
            ranked = sem.search(q, 300)
            return repo.list_items(db.conn(), tags=tag, source=source, type_=type, cluster=cluster,
                                   limit=limit, offset=offset, only_ids=ranked)
        return repo.list_items(db.conn(), q=q, tags=tag, source=source, type_=type, cluster=cluster,
                               limit=limit, offset=offset, sort=sort)

    @api.get("/graph")
    def graph(
        q: Optional[str] = None,
        tag: list[str] = Query(default=[]),
        source: Optional[str] = None,
        type: Optional[str] = None,
        mode: Literal["keyword", "meaning"] = "keyword",
        cluster: Optional[int] = Query(default=None, ge=0),
        k: int = Query(4, ge=1, le=10),
        visual: float = Query(0.5, ge=0, le=1),
        z: float = Query(graph_mod.SIM_Z, ge=0.5, le=8),
        tag_links: bool = True,
        link_tag: list[str] = Query(default=[]),
    ):
        """The library as a network, for the same filters as /items. Without the models only tag links exist."""
        ranked = sem.search(q, 300) if (mode == "meaning" and q and q.strip() and sem.ready()) else None
        if ranked is not None and not ranked:
            res = {"items": [], "total": 0}
        else:
            res = repo.list_items(db.conn(), q=None if ranked is not None else q, tags=tag, source=source,
                                  type_=type, cluster=cluster, limit=graph_mod.MAX_NODES, only_ids=ranked)
        return graph_mod.build(db.conn(), res["items"], res["total"], sem, k=k, visual=visual, use_tags=tag_links,
                                z=z, link_tags=[repo.normalize_tag(t) or t for t in link_tag])

    @api.get("/items/{item_id}")
    def get_item(item_id: int):
        item = repo.get_item(db.conn(), item_id)
        if item is None:
            raise HTTPException(status_code=404, detail="not found")
        row = db.conn().execute(
            "SELECT c.id, c.name FROM item_clusters ic JOIN clusters c ON c.id=ic.cluster_id WHERE ic.item_id=?",
            (item_id,)).fetchone()
        item["cluster"] = {"id": row["id"], "name": row["name"]} if row else None
        return item

    @api.get("/items/{item_id}/related")
    def related(item_id: int, limit: int = Query(12, ge=1, le=50), visual: float = Query(0.5, ge=0, le=1)):
        if not sem.ready():
            raise HTTPException(status_code=409, detail="models-missing")
        nb = sem.neighbours(item_id, limit, visual)
        res = repo.list_items(db.conn(), only_ids=[i for i, _ in nb], limit=limit)
        score = dict(nb)
        for it in res["items"]:
            it["score"] = round(score.get(it["id"], 0.0), 3)
        return res

    @api.get("/items/{item_id}/suggest-tags")
    def suggest_tags(item_id: int):
        return {"tags": sem.suggest_tags(item_id) if sem.ready() else []}

    @api.patch("/items/{item_id}")
    def patch_item(item_id: int, body: ItemPatch):
        with db.tx() as c:
            ok = repo.update_item(c, item_id, title=body.title, note=body.note,
                                  add=body.add_tags, remove=body.remove_tags)
        if not ok:
            raise HTTPException(status_code=404, detail="not found")
        return repo.get_item(db.conn(), item_id)

    def _unlink(item_id: int, thumbs: list[str]) -> None:
        shutil.rmtree(paths.originals / str(item_id), ignore_errors=True)
        for t in thumbs:
            (paths.thumbs / t).unlink(missing_ok=True)

    @api.delete("/items/{item_id}")
    def delete_item(item_id: int):
        with db.tx() as c:
            thumbs = repo.delete_item(c, item_id)
        if thumbs is None:
            raise HTTPException(status_code=404, detail="not found")
        _unlink(item_id, thumbs)
        return {"ok": True}

    @api.post("/items/bulk")
    def bulk(body: BulkOp):
        removed: list[tuple[int, list[str]]] = []
        with db.tx() as c:
            for item_id in body.ids:
                if body.delete:
                    thumbs = repo.delete_item(c, item_id)
                    if thumbs is not None:
                        removed.append((item_id, thumbs))
                else:
                    repo.update_item(c, item_id, add=body.add_tags, remove=body.remove_tags)
        for item_id, thumbs in removed:
            _unlink(item_id, thumbs)
        return {"ok": True, "count": len(body.ids)}

    @api.post("/links")
    def add_link(body: LinkBody):
        """A one-way link you drew in the graph (src -> dst)."""
        if body.src == body.dst:
            raise HTTPException(status_code=400, detail="an item cannot link to itself")
        with db.tx() as c:
            made = repo.add_link(c, body.src, body.dst)
        if made is None:
            raise HTTPException(status_code=404, detail="not found")
        return {"ok": True, "created": made}

    @api.delete("/links")
    def remove_link(src: int, dst: int):
        with db.tx() as c:
            gone = repo.remove_link(c, src, dst)
        if not gone:
            raise HTTPException(status_code=404, detail="not found")
        return {"ok": True}

    @api.get("/tags")
    def tags():
        return repo.list_tags(db.conn())

    @api.get("/stats")
    def stats():
        return {**repo.stats(db.conn()), "ocr_available": jobs.ocr_available(), "version": __version__}

    # ------------------------------------------------- embeddings and models
    @api.get("/embeddings/status")
    def embeddings_status():
        return {**sem.status(), "fetch": dict(fetch_state), "clusters": dict(clusterer.state)}

    @api.post("/models/fetch")
    def fetch_models(body: FetchBody):
        """Download the embedding models (~700 MB, or ~180 MB with small=true) in the background."""
        if fetch_state["state"] == "running":
            return dict(fetch_state)
        fetch_state.update(state="running", log=[], error=None)

        def work():
            try:
                models.fetch(paths, small=body.small, log=lambda m: fetch_state["log"].append(m.strip()))
                fetch_state["state"] = "done"
                worker.wake()
            except Exception as e:
                fetch_state.update(state="failed", error=f"{type(e).__name__}: {e}")

        threading.Thread(target=work, name="aether-model-fetch", daemon=True).start()
        return dict(fetch_state)

    # --------------------------------------------------------------- clusters
    @api.get("/clusters")
    def list_clusters():
        c = db.conn()
        rows = c.execute("SELECT id, name, keywords, size FROM clusters ORDER BY size DESC, id").fetchall()
        p = c.execute("SELECT value FROM meta WHERE key='cluster_params'").fetchone()
        clustered = c.execute("SELECT COUNT(*) FROM item_clusters WHERE cluster_id IS NOT NULL").fetchone()[0]
        total = c.execute("SELECT COUNT(*) FROM items").fetchone()[0]
        return {
            "clusters": [{"id": r["id"], "name": r["name"], "size": r["size"], "keywords": json.loads(r["keywords"])} for r in rows],
            "unclustered": total - clustered,
            "params": json.loads(p[0]) if p else None,
            "state": dict(clusterer.state),
        }

    @api.post("/clusters/recompute")
    def recompute(body: RecomputeBody):
        if not sem.ready():
            raise HTTPException(status_code=409, detail="models-missing")
        return {"started": clusterer.start(body.visual), "state": dict(clusterer.state)}

    @api.get("/clusters/map")
    def cluster_map():
        rows = db.conn().execute("SELECT item_id, cluster_id, x, y FROM item_clusters").fetchall()
        return {"points": [{"id": r["item_id"], "c": r["cluster_id"], "x": r["x"], "y": r["y"]} for r in rows]}

    @api.post("/clusters/{cluster_id}/tag")
    def tag_cluster(cluster_id: int, body: ClusterTagBody):
        """Turn a cluster into a real, editable tag on all its members."""
        with db.tx() as c:
            ids = [r[0] for r in c.execute("SELECT item_id FROM item_clusters WHERE cluster_id=?", (cluster_id,))]
            if not ids:
                raise HTTPException(status_code=404, detail="no such cluster")
            for i in ids:
                repo.update_item(c, i, add=[body.name])
        return {"ok": True, "tagged": len(ids)}

    app.include_router(public)
    app.include_router(api)

    # ------------------------------------------------------------ static / UI
    app.mount("/files/thumbs", StaticFiles(directory=paths.thumbs), name="thumbs")
    app.mount("/files/originals", StaticFiles(directory=paths.originals), name="originals")
    if UI_DIR.exists():
        app.mount("/ui", StaticFiles(directory=UI_DIR), name="ui")

    @app.get("/", response_class=HTMLResponse, include_in_schema=False)
    def index():
        html = (UI_DIR / "index.html").read_text(encoding="utf-8")
        html = html.replace("__AETHER_TOKEN__", token).replace("__AETHER_PORT__", str(default_port()))
        return HTMLResponse(html, headers={
            "Cache-Control": "no-store",
            "Content-Security-Policy": "frame-ancestors 'none'",
        })

    return app
