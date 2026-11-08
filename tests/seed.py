"""Fill a running engine with synthetic items and print timings.

    python tests/seed.py http://127.0.0.1:47900 <token> 3000
"""
import io
import json
import random
import statistics
import sys
import time

import httpx
from PIL import Image, ImageDraw

base, token = sys.argv[1].rstrip("/"), sys.argv[2]
n = int(sys.argv[3]) if len(sys.argv) > 3 else 500
random.seed(7)

WORDS = ("moody blue dark interface study typography poster neon retro brutalist garden recipe "
         "paper vector clustering cats synthesizer robotics kinematics lighting palette").split()


def fake_image(i: int) -> bytes:
    w, h = random.randint(400, 900), random.randint(300, 1400)
    base_c = tuple(random.randint(20, 235) for _ in range(3))
    im = Image.new("RGB", (w, h), base_c)
    d = ImageDraw.Draw(im)
    for _ in range(6):
        x0, y0 = random.randint(0, w - 50), random.randint(0, h - 50)
        d.rectangle([x0, y0, x0 + random.randint(40, w // 2), y0 + random.randint(40, h // 2)],
                    fill=tuple(random.randint(0, 255) for _ in range(3)))
    d.text((20, 20), f"item {i}", fill=(255, 255, 255))
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=82)
    return buf.getvalue()


def url_for(i: int):
    k = i % 10
    if k == 0:
        return f"https://www.youtube.com/watch?v=vid{i:08d}", "video"
    if k in (1, 2):
        return f"https://x.com/user{i % 50}/status/{1000 + i}", "post"
    if k == 3:
        return f"https://www.pinterest.com/pin/{500000 + i}/", "image"
    return f"https://blog{i % 40}.example.com/posts/{i}", "article"


client = httpx.Client(base_url=base, headers={"X-Aether-Token": token}, timeout=60)
times = []
t0 = time.perf_counter()
for i in range(n):
    url, typ = url_for(i)
    title = " ".join(random.sample(WORDS, 4)).capitalize() + f" #{i}"
    meta = {"original_url": url, "type": typ, "title": title, "author": f"author{i % 30}",
            "text": " ".join(random.choices(WORDS, k=60)),
            "tags": random.sample(["inspo", "to-read", "ui", "reference", "music", "ml"], random.randint(0, 2)),
            "asset_kinds": ["image"], "asset_srcs": [""]}
    files = [] if i % 12 == 5 else [("files", ("a.jpg", fake_image(i), "image/jpeg"))]
    s = time.perf_counter()
    r = client.post("/api/capture", data={"meta": json.dumps(meta)}, files=files)
    r.raise_for_status()
    times.append((time.perf_counter() - s) * 1000)
total = time.perf_counter() - t0
print(f"captured {n} items in {total:.1f}s  (median {statistics.median(times):.0f} ms, "
      f"p95 {sorted(times)[int(n * .95) - 1]:.0f} ms per capture)")

t = time.perf_counter()
got = 0
for off in range(0, n, 500):
    got += len(client.get("/api/items", params={"limit": 500, "offset": off}).json()["items"])
print(f"listed {got} cards in {(time.perf_counter() - t) * 1000:.0f} ms")

for q in ("blue", "kinematics", "interf", "retro garden"):
    t = time.perf_counter()
    total_hits = client.get("/api/items", params={"q": q, "limit": 50}).json()["total"]
    print(f"search {q!r:16} -> {total_hits:5} hits in {(time.perf_counter() - t) * 1000:.0f} ms")

print("stats:", json.dumps(client.get("/api/stats").json()))
