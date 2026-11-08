"""URL canonicalisation (for dedup) and source detection."""
from __future__ import annotations

import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

_TRACK_PREFIXES = ("utm_", "mc_", "pk_", "hsa_")
_TRACK_KEYS = {
    "fbclid", "gclid", "dclid", "msclkid", "igshid", "igsh", "yclid",
    "ref", "ref_src", "ref_url", "spm", "_ga", "cmpid", "share", "feature",
}

_SOURCES = (
    ("youtube", ("youtube.com", "youtu.be", "youtube-nocookie.com")),
    ("x", ("x.com", "twitter.com")),
    ("instagram", ("instagram.com",)),
    ("tumblr", ("tumblr.com",)),
    ("wikipedia", ("wikipedia.org",)),
)


def _host(url: str) -> str:
    host = (urlsplit(url.strip()).hostname or "").lower()
    return re.sub(r"^(www\.|m\.|mobile\.)", "", host)


def _is(host: str, domain: str) -> bool:
    return host == domain or host.endswith("." + domain)


def detect_source(url: str) -> str:
    host = _host(url)
    for name, domains in _SOURCES:
        if any(_is(host, d) for d in domains):
            return name
    if re.search(r"(^|\.)pinterest\.", host) or host == "pin.it":
        return "pinterest"
    return "web"


def canonicalize(url: str) -> str:
    """Stable identity for a page: strips tracking params, normalises hosts."""
    p = urlsplit(url.strip())
    host = _host(url)
    path = p.path or "/"
    query = parse_qsl(p.query, keep_blank_values=False)
    source = detect_source(url)
    fragment = ""

    if source == "x":
        host, query = "x.com", []
    elif source == "youtube":
        vid = None
        if host == "youtu.be":
            vid = path.strip("/").split("/")[0] or None
        else:
            m = re.match(r"^/(shorts|live|embed|v)/([\w-]{6,})", path)
            vid = m.group(2) if m else dict(query).get("v")
        if vid:
            return f"https://youtube.com/watch?v={vid}"
        host = "youtube.com"
        query = [(k, v) for k, v in query if k == "list"]
    elif source == "instagram":
        query = []
        m = re.search(r"/(p|reels?|tv)/([\w-]+)", path)
        if m:
            kind = "reel" if m.group(1).startswith("reel") else m.group(1)
            path = f"/{kind}/{m.group(2)}"
    elif source == "pinterest":
        query = []
        m = re.search(r"/pin/(\d+)", path)
        if m:
            host, path = "pinterest.com", f"/pin/{m.group(1)}"
    elif source == "wikipedia":
        host = re.sub(r"^([a-z\-]+)\.m\.", r"\1.", (p.hostname or "").lower())
        query = []
        # Unlike other sites, the part after # is meaningful: "#History" / "#History:~:text=..." is
        # where in the article an image or quote came from, so two spots are two items.
        fragment = p.fragment[:400]
    else:
        query = [
            (k, v) for k, v in query
            if k.lower() not in _TRACK_KEYS and not k.lower().startswith(_TRACK_PREFIXES)
        ]

    if len(path) > 1:
        path = path.rstrip("/")
    port = f":{p.port}" if p.port and p.port not in (80, 443) else ""
    return urlunsplit(("https", host + port, path, urlencode(sorted(query)), fragment))
