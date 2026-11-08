"""Run the engine:  python -m engine [--open] [--port N]"""
import argparse
import threading
import webbrowser

import uvicorn

from .config import HOST, Paths, default_port, default_root, load_token
from .main import create_app


def main() -> None:
    ap = argparse.ArgumentParser(prog="aether")
    ap.add_argument("--port", type=int, default=default_port())
    ap.add_argument("--open", action="store_true", help="open the UI in your browser")
    args = ap.parse_args()

    app = create_app()
    token = load_token(Paths(default_root()))
    url = f"http://{HOST}:{args.port}/"
    print(f"\n  Aether is running at {url}")
    print(f"  Data folder : {default_root()}")
    print(f"  Extension token (paste once into the extension popup):\n\n    {token}\n")
    if args.open:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    uvicorn.run(app, host=HOST, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
