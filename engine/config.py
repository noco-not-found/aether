"""Paths, ports and the per-install secret token."""
from __future__ import annotations

import os
import secrets
import sys
from dataclasses import dataclass
from pathlib import Path

HOST = "127.0.0.1"
FROZEN = bool(getattr(sys, "frozen", False))      # running as the packaged Windows app (PyInstaller)


def bundle_dir() -> Path:
    """Where read-only app files live: next to the code in development, inside the app folder when packaged."""
    return Path(getattr(sys, "_MEIPASS")) if FROZEN else Path(__file__).resolve().parent.parent
DEFAULT_PORT = 47821


def default_port() -> int:
    return int(os.environ.get("AETHER_PORT", DEFAULT_PORT))


def default_root() -> Path:
    """Data directory. Override with AETHER_HOME (used by the tests)."""
    return Path(os.environ.get("AETHER_HOME") or (Path.home() / ".aether"))


@dataclass(frozen=True)
class Paths:
    root: Path

    @property
    def db(self) -> Path:
        return self.root / "aether.db"

    @property
    def originals(self) -> Path:
        return self.root / "storage" / "originals"

    @property
    def thumbs(self) -> Path:
        return self.root / "storage" / "thumbs"

    @property
    def models(self) -> Path:
        """Models you downloaded win; otherwise the copy bundled with the app (read-only)."""
        own = self.root / "models"
        if FROZEN and not any(own.glob("*/VARIANT")) and (bundle_dir() / "models").exists():
            return bundle_dir() / "models"
        return own

    @property
    def settings_file(self) -> Path:
        return self.root / "settings.json"

    @property
    def logs(self) -> Path:
        return self.root / "logs"

    @property
    def token_file(self) -> Path:
        return self.root / "token"

    def ensure(self) -> None:
        for p in (self.root, self.originals, self.thumbs):
            p.mkdir(parents=True, exist_ok=True)


def load_token(paths: Paths) -> str:
    """Return the install's secret, creating it on first run."""
    f = paths.token_file
    if f.exists():
        token = f.read_text(encoding="utf-8").strip()
        if token:
            return token
    token = secrets.token_urlsafe(32)
    f.write_text(token, encoding="utf-8")
    try:
        os.chmod(f, 0o600)
    except OSError:
        pass
    return token
