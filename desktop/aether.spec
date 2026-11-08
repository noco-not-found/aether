# PyInstaller spec for the Windows app. Build everything with:  powershell -File desktop\build.ps1
# One folder (not one file): starts fast, and the ~700 MB of models aren't unpacked on every launch.
import os
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

ROOT = Path(SPECPATH).parent
MODELS = Path(os.environ.get("AETHER_MODELS") or Path.home() / ".aether" / "models")

datas = [(str(ROOT / "ui"), "ui"), (str(ROOT / "extension"), "extension"), (str(ROOT / "desktop" / "aether.ico"), ".")]
for d in sorted(MODELS.iterdir()):                       # clip/ and bge/, with their VARIANT files
    if d.is_dir() and (d / "VARIANT").exists():
        datas.append((str(d), f"models/{d.name}"))
assert any(d[1].startswith("models/") for d in datas), f"no models found in {MODELS}"
for pkg in ("rapidocr", "rapidocr_onnxruntime"):         # OCR config + its small detection models
    try:
        datas += collect_data_files(pkg)
    except Exception:
        pass

hidden = collect_submodules("uvicorn") + collect_submodules("engine") + ["multipart", "python_multipart"]

a = Analysis(
    [str(ROOT / "desktop" / "aether.py")],
    pathex=[str(ROOT)],
    datas=datas,
    hiddenimports=hidden,
    excludes=["tkinter", "matplotlib", "pytest", "IPython", "notebook"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="Aether", console=False,
          icon=str(ROOT / "desktop" / "aether.ico"), upx=False)
coll = COLLECT(exe, a.binaries, a.datas, name="Aether", upx=False)
