"""Model files for the embeddings: where they live and how to fetch them.

    python -m engine.models            full precision, ~700 MB, best quality
    python -m engine.models --small    int8, ~180 MB, a little less accurate

Nothing is downloaded unless you run this (or press the button in the UI that runs it).
Files come from the public ONNX exports at huggingface.co/Xenova and are kept in <data dir>/models.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Callable

import httpx

from .config import Paths, default_root

URL = "https://huggingface.co/{repo}/resolve/main/{path}"

# local name -> {variant: path inside the repo}
SPECS: dict[str, dict] = {
    "clip": {   # image <-> text, 512-d; also encodes search queries for images
        "repo": "Xenova/clip-vit-base-patch32",
        "files": {
            "vision.onnx": {"fp32": "onnx/vision_model.onnx", "int8": "onnx/vision_model_quantized.onnx"},
            "text.onnx": {"fp32": "onnx/text_model.onnx", "int8": "onnx/text_model_quantized.onnx"},
            "tokenizer.json": {"fp32": "tokenizer.json", "int8": "tokenizer.json"},
        },
    },
    "bge": {    # sentence embeddings for titles, articles, captions, OCR text; 384-d
        "repo": "Xenova/bge-small-en-v1.5",
        "files": {
            "model.onnx": {"fp32": "onnx/model.onnx", "int8": "onnx/model_quantized.onnx"},
            "tokenizer.json": {"fp32": "tokenizer.json", "int8": "tokenizer.json"},
        },
    },
}


def model_dir(paths: Paths, name: str) -> Path:
    return paths.models / name


def present(paths: Paths, name: str) -> bool:
    d = model_dir(paths, name)
    return all((d / f).exists() for f in SPECS[name]["files"]) and (d / "VARIANT").exists()


def variant(paths: Paths, name: str) -> str:
    try:
        return (model_dir(paths, name) / "VARIANT").read_text().strip() or "fp32"
    except OSError:
        return "fp32"


def model_id(paths: Paths, name: str) -> str:
    """Stored next to every vector: a different model or variant means the vector must be redone."""
    return f"{name}-{SPECS[name]['repo'].split('/')[-1]}-{variant(paths, name)}"


def _download(url: str, dest: Path, log: Callable[[str], None]) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_suffix(dest.suffix + ".part")
    with httpx.stream("GET", url, follow_redirects=True, timeout=60) as r:
        r.raise_for_status()
        total = int(r.headers.get("content-length") or 0)
        done, last = 0, -1
        with open(part, "wb") as f:
            for chunk in r.iter_bytes(1 << 20):
                f.write(chunk)
                done += len(chunk)
                pct = int(done * 100 / total) if total else 0
                if pct // 10 != last // 10:
                    log(f"    {dest.name}: {pct}%  ({done / 1e6:.0f} / {total / 1e6:.0f} MB)")
                    last = pct
    if total and part.stat().st_size != total:
        part.unlink(missing_ok=True)
        raise RuntimeError(f"{dest.name}: incomplete download")
    part.replace(dest)


def fetch(paths: Paths, *, small: bool = False, log: Callable[[str], None] = print) -> None:
    v = "int8" if small else "fp32"
    for name, spec in SPECS.items():
        d = model_dir(paths, name)
        if present(paths, name) and variant(paths, name) == v:
            log(f"{name}: already present ({v})")
            continue
        log(f"{name}: downloading ({v})")
        for local, variants in spec["files"].items():
            _download(URL.format(repo=spec["repo"], path=variants[v]), d / local, log)
        (d / "VARIANT").write_text(v)
    log("done")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Download the embedding models Aether uses.")
    ap.add_argument("--small", action="store_true", help="int8 versions (~180 MB instead of ~700 MB)")
    ap.add_argument("--home", help="data directory (default: ~/.aether)")
    a = ap.parse_args(argv)
    fetch(Paths(Path(a.home) if a.home else default_root()), small=a.small)
    return 0


if __name__ == "__main__":
    sys.exit(main())
