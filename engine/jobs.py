"""Durable job queue backed by the `jobs` table.

Jobs survive crashes: anything left in 'running' at startup goes back to
'pending'. Failures retry with exponential backoff, then become 'failed'.
OCR is the first job type; embeddings (phase 3) plug into HANDLERS the same way.
"""
from __future__ import annotations

import gc
import importlib.util
import logging
import sys
import threading
import time

from . import repo
from .config import Paths
from .db import DB

log = logging.getLogger("aether.jobs")

MAX_ATTEMPTS = 4
MAX_OCR_PIXELS = 40_000_000


class JobSkipped(Exception):
    """Raised by a handler when its optional dependency is missing."""


# ------------------------------------------------------------------- queue
def enqueue(c, type_: str, item_id: int, asset_id: int) -> None:
    c.execute(
        "INSERT OR IGNORE INTO jobs(type, item_id, asset_id, created_at) VALUES (?,?,?,?)",
        (type_, item_id, asset_id, repo.now()),
    )


def ocr_available() -> bool:
    has = importlib.util.find_spec
    return bool((has("rapidocr") and has("onnxruntime")) or has("rapidocr_onnxruntime"))


# --------------------------------------------------------------------- OCR
_ocr_run = None


def _load_ocr():
    global _ocr_run
    if _ocr_run is not None:
        return _ocr_run
    try:
        if importlib.util.find_spec("rapidocr"):
            from rapidocr import RapidOCR

            engine = RapidOCR()

            def run(path: str) -> str:
                out = engine(path)
                return " ".join(getattr(out, "txts", None) or [])
        elif importlib.util.find_spec("rapidocr_onnxruntime"):
            from rapidocr_onnxruntime import RapidOCR

            engine = RapidOCR()

            def run(path: str) -> str:
                result, _ = engine(path)
                return " ".join(r[1] for r in (result or []))
        else:
            raise JobSkipped("rapidocr is not installed (pip install rapidocr onnxruntime)")
    except ImportError as e:
        raise JobSkipped(f"OCR backend missing ({e}); pip install onnxruntime") from e

    def guarded(path: str) -> str:
        # rapidocr builds its engine lazily: a missing runtime (onnxruntime) only shows up on the
        # first call. That is not transient, so skip instead of retrying forever.
        try:
            return run(path)
        except ImportError as e:
            raise JobSkipped(f"OCR backend missing ({e}); pip install onnxruntime") from e

    _ocr_run = guarded
    return guarded


def handle_ocr(db: DB, paths: Paths, job) -> None:
    c = db.conn()
    a = c.execute("SELECT id, item_id, path, w, h FROM assets WHERE id=?", (job["asset_id"],)).fetchone()
    if a is None:
        return  # asset was deleted while queued
    if (a["w"] or 0) * (a["h"] or 0) > MAX_OCR_PIXELS:
        raise JobSkipped("image too large for OCR")
    text = _load_ocr()(str(paths.originals / a["path"])).strip()[:20_000]
    with db.tx() as tx:
        tx.execute("UPDATE assets SET ocr_text=? WHERE id=?", (text, a["id"]))
        repo.reindex(tx, a["item_id"])


HANDLERS = {"ocr": handle_ocr}


# ------------------------------------------------------------------ worker
class JobWorker(threading.Thread):
    def __init__(self, db: DB, paths: Paths, semantic=None, clusterer=None) -> None:
        super().__init__(name="aether-jobs", daemon=True)
        self.db, self.paths = db, paths
        self.semantic, self.clusterer = semantic, clusterer
        self._wake = threading.Event()
        self._stop_flag = threading.Event()
        self._idle_pause_until = 0.0
        # Background mode (the packaged app with its window closed): captures are still stored, but OCR,
        # embeddings and topic work wait until a window is open again, and the models are unloaded.
        self.away = lambda: False
        self._unloaded = False

    def _idle_work(self) -> bool:
        """With no jobs queued: bring embeddings up to date, then refresh clusters if enough changed.
        True means 'did something, look again right away'."""
        if self.semantic is None or time.time() < self._idle_pause_until:
            return False
        try:
            if self.semantic.sync(16):
                return True
            if self.clusterer is not None:
                self.clusterer.maybe_auto()
        except Exception:
            log.exception("embedding pass failed; pausing it for a minute")
            self._idle_pause_until = time.time() + 60
        return False

    def recover(self) -> None:
        with self.db.tx() as c:
            c.execute("UPDATE jobs SET status='pending' WHERE status='running'")
            if ocr_available():
                c.execute("UPDATE jobs SET status='pending', error=NULL WHERE status='skipped' AND type='ocr'")

    def _unload(self) -> None:
        global _ocr_run
        _ocr_run = None
        if self.semantic is not None:
            self.semantic.unload()
        gc.collect()
        if sys.platform == "win32":      # hand the freed pages back to Windows so Task Manager shows it
            try:
                import ctypes
                ctypes.windll.psapi.EmptyWorkingSet(ctypes.windll.kernel32.GetCurrentProcess())
            except Exception:
                pass
        self._unloaded = True
        log.info("background mode: models unloaded, heavy work paused")

    def wake(self) -> None:
        self._wake.set()

    def stop(self) -> None:
        self._stop_flag.set()
        self._wake.set()

    def _claim(self):
        with self.db.tx() as c:
            job = c.execute(
                "SELECT * FROM jobs WHERE status='pending' AND run_after <= ? ORDER BY id LIMIT 1",
                (repo.now(),),
            ).fetchone()
            if job:
                c.execute("UPDATE jobs SET status='running', attempts=attempts+1 WHERE id=?", (job["id"],))
            return job

    def _finish(self, job_id: int, status: str, error: str | None = None, run_after: int = 0) -> None:
        with self.db.tx() as c:
            c.execute(
                "UPDATE jobs SET status=?, error=?, run_after=?, finished_at=? WHERE id=?",
                (status, error, run_after, repo.now() if status != "pending" else None, job_id),
            )

    def run(self) -> None:
        try:
            self.recover()
        except Exception:  # pragma: no cover
            log.exception("job recovery failed")
        while not self._stop_flag.is_set():
            if self.away():
                if not self._unloaded:
                    self._unload()
                self._wake.wait(timeout=30.0)
                self._wake.clear()
                continue
            self._unloaded = False
            job = self._claim()
            if job is None:
                if self._idle_work():
                    continue
                self._wake.wait(timeout=2.0)
                self._wake.clear()
                continue
            handler = HANDLERS.get(job["type"])
            try:
                if handler is None:
                    raise JobSkipped(f"no handler for {job['type']}")
                handler(self.db, self.paths, job)
                self._finish(job["id"], "done")
            except JobSkipped as e:
                self._finish(job["id"], "skipped", str(e))
            except Exception as e:
                attempts = job["attempts"] + 1
                log.warning("job %s failed (%s): %s", job["id"], job["type"], e)
                if attempts >= MAX_ATTEMPTS:
                    self._finish(job["id"], "failed", str(e))
                else:
                    self._finish(job["id"], "pending", str(e), run_after=repo.now() + 30 * 2 ** attempts)
