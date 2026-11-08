"""Glue for the packaged Windows app: settings, start with Windows, the extension folder.

Everything here is safe to import on any OS and in development; the Windows-only parts do nothing elsewhere.
"""
from __future__ import annotations

import json
import os
import shutil
import sys
from pathlib import Path

from .config import FROZEN, Paths, bundle_dir

RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
RUN_NAME = "Aether"
DEFAULTS = {"start_at_login": True, "window": None}


def load_settings(paths: Paths) -> dict:
    try:
        return {**DEFAULTS, **json.loads(paths.settings_file.read_text(encoding="utf-8"))}
    except (OSError, ValueError):
        return dict(DEFAULTS)


def save_settings(paths: Paths, settings: dict) -> None:
    tmp = paths.settings_file.with_suffix(".tmp")
    tmp.write_text(json.dumps(settings, indent=2), encoding="utf-8")
    os.replace(tmp, paths.settings_file)


# ------------------------------------------------------------ start with Windows
def background_command() -> str:
    """What Windows runs at sign-in: the app itself, engine only, no window."""
    return f'"{sys.executable}" --background'


def start_at_login() -> bool:
    if sys.platform != "win32" or not FROZEN:
        return False
    import winreg
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k:
            return bool(winreg.QueryValueEx(k, RUN_NAME)[0])
    except OSError:
        return False


def set_start_at_login(on: bool) -> None:
    """Writes (or removes) the per-user Run entry. Rewritten on every launch, so a moved portable copy still works."""
    if sys.platform != "win32" or not FROZEN:
        return
    import winreg
    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k:
        if on:
            winreg.SetValueEx(k, RUN_NAME, 0, winreg.REG_SZ, background_command())
        else:
            try:
                winreg.DeleteValue(k, RUN_NAME)
            except FileNotFoundError:
                pass


def apply_settings(paths: Paths) -> dict:
    s = load_settings(paths)
    set_start_at_login(bool(s.get("start_at_login")))
    return s


# --------------------------------------------------------------- the extension
def extension_dir(paths: Paths) -> Path:
    """A stable copy in the data folder, so Chrome's 'Load unpacked' survives app updates and moves."""
    return paths.root / "extension" if FROZEN else bundle_dir() / "extension"


def install_extension(paths: Paths) -> Path:
    dest = extension_dir(paths)
    src = bundle_dir() / "extension"
    if FROZEN and src.exists():
        shutil.copytree(src, dest, dirs_exist_ok=True)
    return dest


def open_folder(path: Path) -> bool:
    if sys.platform != "win32":
        return False
    path.mkdir(parents=True, exist_ok=True)
    os.startfile(str(path))  # noqa: S606 - opens Explorer on our own folder
    return True
