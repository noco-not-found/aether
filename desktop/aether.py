"""Aether for Windows.

    Aether.exe                open the window (starts the background engine first if it isn't running)
    Aether.exe --background   the engine only, no window: what Windows starts at sign-in

Closing the window leaves the engine running, so the browser extension can save at any time. With no
window open the engine goes into background mode: captures are stored, heavy work waits, models unload.

From source:  .venv\\Scripts\\python desktop\\aether.py [--background]
"""
from __future__ import annotations

import argparse
import ctypes
import json
import logging
import os
import subprocess
import sys
import time
import urllib.request
from logging.handlers import RotatingFileHandler
from pathlib import Path

if not getattr(sys, "frozen", False):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# numpy's OpenBLAS reserves ~32 MB per CPU thread at import (540 MB on a 16-thread laptop) for maths this app
# barely uses: two threads keep the always-on engine at ~90 MB. Must be set before numpy is imported.
os.environ.setdefault("OPENBLAS_NUM_THREADS", "2")

from engine import desktop  # noqa: E402
from engine.config import FROZEN, HOST, Paths, default_port, default_root  # noqa: E402

PORT = default_port()
URL = f"http://{HOST}:{PORT}/"
paths = Paths(default_root())
log = logging.getLogger("aether.app")
_no_proxy = urllib.request.build_opener(urllib.request.ProxyHandler({}))   # never send localhost via a proxy


def alive(timeout: float = 0.6) -> bool:
    try:
        with _no_proxy.open(URL + "api/health", timeout=timeout) as r:
            return bool(json.load(r).get("ok"))
    except Exception:
        return False


def setup_logging(name: str) -> None:
    paths.ensure()
    paths.logs.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(paths.logs / f"{name}.log", maxBytes=1_000_000, backupCount=2, encoding="utf-8")
    logging.basicConfig(level=logging.INFO, handlers=[handler], format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    if sys.stderr is None or FROZEN:     # a windowed exe has no console: keep tracebacks in the log folder
        sys.stderr = open(paths.logs / f"{name}-errors.log", "a", encoding="utf-8", buffering=1)
    if sys.stdout is None:
        sys.stdout = open(os.devnull, "w", encoding="utf-8")


def single_instance(name: str):
    """A named mutex: returns (handle, already_running). Keep the handle alive for the process lifetime."""
    if sys.platform != "win32":
        return None, False
    k32 = ctypes.windll.kernel32
    handle = k32.CreateMutexW(None, False, name)
    return handle, k32.GetLastError() == 183          # ERROR_ALREADY_EXISTS


# ------------------------------------------------------------------ engine
def run_background() -> None:
    setup_logging("engine")
    os.environ.setdefault("NUMBA_CACHE_DIR", str(paths.root / "cache" / "numba"))
    _mutex, running = single_instance("Local\\AetherEngine")
    if running or alive():
        log.info("engine already running")
        return
    desktop.install_extension(paths)
    desktop.apply_settings(paths)
    import uvicorn

    from engine.main import create_app

    app = create_app(background_mode=True)
    server = uvicorn.Server(uvicorn.Config(app, host=HOST, port=PORT, log_config=None, log_level="warning", access_log=False))
    app.state.quit = lambda: setattr(server, "should_exit", True)
    log.info("engine starting on %s", URL)
    server.run()
    log.info("engine stopped")


def start_background() -> None:
    cmd = [sys.executable, "--background"] if FROZEN else [sys.executable, str(Path(__file__).resolve()), "--background"]
    flags = 0x00000008 | 0x00000200 | 0x08000000     # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
    subprocess.Popen(cmd, creationflags=flags if sys.platform == "win32" else 0, close_fds=True, cwd=str(paths.root),
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


# ------------------------------------------------------------------ window
SPLASH = """<!doctype html><meta charset="utf-8"><style>
:root{--d:#8ec3ee;--f:#fbfdff;--t:#c3e4fb;--i:#1d2540;--g:#a9c862;--l:#cfc6f0}
@media (prefers-color-scheme:dark){:root{--d:#141b3a;--f:#1f2749;--t:#34428f;--i:#04060f;--l:#b4a8ec}body{color:#eef1ff}}
body{margin:0;height:100vh;display:grid;place-items:center;background:var(--d);font:600 15px "Segoe UI",system-ui;color:#1d2540}
.w{width:320px;background:var(--f);border:2px solid var(--i);box-shadow:6px 6px 0 var(--i)}
.t{background:var(--t);border-bottom:2px solid var(--i);padding:7px 10px;display:flex;gap:8px;align-items:center}
.t:before{content:"";width:10px;height:10px;background:var(--i)}
.b{padding:18px 16px}.bar{height:12px;border:2px solid var(--i);background:var(--l);margin-top:12px;overflow:hidden}
.bar i{display:block;height:100%;width:30%;background:var(--g);animation:m 1.2s steps(6) infinite alternate}
@keyframes m{to{width:100%}}@media (prefers-reduced-motion:reduce){.bar i{animation:none;width:60%}}
</style><div class="w"><div class="t">Aether</div><div class="b">%MSG%<div class="bar"><i></i></div></div></div>"""


class Api:
    """Exposed to the page as window.pywebview.api."""

    def close(self) -> None:
        import webview
        for w in list(webview.windows):
            w.destroy()


def focus_existing() -> None:
    if sys.platform != "win32":
        return
    user32 = ctypes.windll.user32
    hwnd = user32.FindWindowW(None, "Aether")
    if hwnd:
        user32.ShowWindow(hwnd, 9)        # SW_RESTORE
        user32.SetForegroundWindow(hwnd)


def browser_fallback() -> None:
    """No WebView2 / pywebview: open Edge in app mode (its own window), else the default browser."""
    for base in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles")):
        edge = Path(base or "") / "Microsoft" / "Edge" / "Application" / "msedge.exe"
        if edge.exists():
            subprocess.Popen([str(edge), f"--app={URL}"])
            return
    import webbrowser
    webbrowser.open(URL)


def run_window() -> None:
    setup_logging("window")
    _mutex, running = single_instance("Local\\AetherWindow")
    if running:
        focus_existing()
        return
    if not alive():
        start_background()
    settings = desktop.apply_settings(paths)          # also keeps the start-at-login path current
    try:
        import webview
    except Exception:
        log.exception("pywebview unavailable, using the browser")
        for _ in range(240):
            if alive():
                break
            time.sleep(0.25)
        browser_fallback()
        return

    geo = settings.get("window") or {}
    win = webview.create_window("Aether", html=SPLASH.replace("%MSG%", "Starting Aether…"),
                                width=int(geo.get("w", 1360)), height=int(geo.get("h", 880)), min_size=(900, 600),
                                maximized=bool(geo.get("max")), background_color="#8ec3ee", js_api=Api(), text_select=True)

    def when_ready() -> None:
        t0 = time.time()
        while time.time() - t0 < 120:
            if alive():
                win.load_url(URL)
                return
            time.sleep(0.3)
        win.load_html(SPLASH.replace("%MSG%", f"The engine didn't start. Details are in {paths.logs}").replace("<i></i>", ""))

    def remember_size() -> None:
        try:
            s = desktop.load_settings(paths)
            s["window"] = {"w": win.width, "h": win.height}
            desktop.save_settings(paths, s)
        except Exception:
            log.exception("could not save the window size")

    win.events.closing += remember_size
    webview.settings["OPEN_EXTERNAL_LINKS_IN_BROWSER"] = True
    webview.start(when_ready, gui="edgechromium", private_mode=False, storage_path=str(paths.root / "webview"))


def main() -> None:
    ap = argparse.ArgumentParser(prog="Aether")
    ap.add_argument("--background", action="store_true", help="run the engine only, without a window")
    args, _ = ap.parse_known_args()
    run_background() if args.background else run_window()


if __name__ == "__main__":
    main()
