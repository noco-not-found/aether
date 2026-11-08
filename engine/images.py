"""Image ingestion: validate, thumbnail (WebP), average colour, perceptual hash."""
from __future__ import annotations

import hashlib
import io
from dataclasses import dataclass

from PIL import Image, ImageOps, UnidentifiedImageError

THUMB_W = 300
THUMB_MAX_H = 900  # very tall screenshots get cropped to their top

_EXT = {"JPEG": "jpg", "MPO": "jpg", "PNG": "png", "WEBP": "webp", "GIF": "gif", "BMP": "bmp", "TIFF": "tiff"}


@dataclass
class ProcessedImage:
    data: bytes
    ext: str
    w: int
    h: int
    tw: int
    th: int
    thumb: bytes
    color: str
    phash: str
    sha256: str


def _dhash(im: Image.Image) -> str:
    g = im.convert("L").resize((9, 8), Image.Resampling.LANCZOS).tobytes()
    bits = 0
    for row in range(8):
        for col in range(8):
            bits = (bits << 1) | (g[row * 9 + col] > g[row * 9 + col + 1])
    return f"{bits:016x}"


def process_image(data: bytes) -> ProcessedImage | None:
    """Return None for anything that is not a usable raster image."""
    try:
        im = Image.open(io.BytesIO(data))
        fmt = (im.format or "").upper()
        im.load()
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        return None
    ext = _EXT.get(fmt)
    if ext is None:
        return None

    im = ImageOps.exif_transpose(im)
    if im.mode not in ("RGB", "RGBA"):
        im = im.convert("RGBA" if ("A" in im.getbands() or im.mode == "P") else "RGB")
    w, h = im.size
    if w < 2 or h < 2:
        return None

    scale = min(1.0, THUMB_W / w)
    size = (max(1, round(w * scale)), max(1, round(h * scale)))
    thumb = im.resize(size, Image.Resampling.LANCZOS)
    if thumb.height > THUMB_MAX_H:
        thumb = thumb.crop((0, 0, thumb.width, THUMB_MAX_H))
    buf = io.BytesIO()
    thumb.save(buf, "WEBP", quality=80, method=4)

    r, g, b = im.convert("RGB").resize((1, 1), Image.Resampling.BOX).getpixel((0, 0))
    return ProcessedImage(
        data=data, ext=ext, w=w, h=h, tw=thumb.width, th=thumb.height,
        thumb=buf.getvalue(), color=f"#{r:02x}{g:02x}{b:02x}",
        phash=_dhash(im), sha256=hashlib.sha256(data).hexdigest(),
    )
