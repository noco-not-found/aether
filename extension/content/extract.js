// Injected into the active tab on demand. Defines window.__aetherExtract(), which returns:
//   { original_url, type, title, author, text, text_source,
//     images:     [[bestUrl, ...fallbacks], ...]            // pre-selected in the popup
//     candidates: [{ group: [bestUrl, ...], thumb, label }]  // extra options the user can tick
//     embed, tags }
// and window.__aetherUpgrade(url) -> [bestUrl, ...fallbacks] for a single image URL.
// One adapter per site; anything that fails or finds nothing falls through to the generic
// (Readability) extractor, and the background worker adds a screenshot if no image was found.
//
// Text policy: whatever the user has selected wins. Otherwise adapters decide: Wikipedia saves
// nothing (title + link are the item), Tumblr saves only the post's own description, and articles
// keep their Readability text.
(() => {
  // Versioned so that a tab which still holds an older copy (after the extension is reloaded)
  // gets the new one instead of silently keeping the old behaviour.
  const VERSION = 5;
  if (window.__aetherVersion === VERSION) return;
  window.__aetherVersion = VERSION;

  // Empty/missing input must stay null: new URL(undefined, base) resolves to ".../undefined" and
  // new URL("", base) resolves to the page itself.
  const abs = (u) => { if (!u) return null; try { return new URL(u, location.href).href; } catch { return null; } };
  const meta = (name) =>
    document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.content?.trim() || "";
  // any whitespace except newline (includes non-breaking spaces) collapses to one space
  const clean = (s) => (s || "").replace(/[^\S\n]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const text = (el) => clean(el?.innerText || el?.textContent || "");
  const uniq = (a) => [...new Set(a.filter(Boolean))];
  const host = location.hostname.replace(/^www\./, "");
  const onHost = (d) => host === d || host.endsWith("." + d);
  const MAX_TEXT = 150000;
  // Lazy-loaded images report naturalWidth 0, so fall back to the declared and then rendered size.
  const sizeOf = (i) => ({
    w: i.naturalWidth || Number(i.getAttribute("width")) || Math.round(i.getBoundingClientRect().width) || 0,
    h: i.naturalHeight || Number(i.getAttribute("height")) || Math.round(i.getBoundingClientRect().height) || 0,
  });

  // Best-quality URL first, the URL as seen on the page last (used if the bigger one is refused).
  function upgradeGroup(u) {
    let url;
    try { url = new URL(u, location.href); } catch { return [u]; }
    const h = url.hostname;
    if (h === "pbs.twimg.com") {
      const orig = new URL(url), large = new URL(url);
      orig.searchParams.set("name", "orig");
      large.searchParams.set("name", "large");
      return uniq([orig.href, large.href, url.href]);
    }
    if (/(^|\.)wikimedia\.org$/.test(h) && /\/\d+px-/.test(url.pathname)) {
      // Wikimedia only serves fixed thumbnail widths (e.g. 500, 960, 1280); 960 is a standard step.
      return uniq([url.href.replace(/\/(\d+)px-/, "/960px-"), url.href]);
    }
    if (h === "i.pinimg.com") {
      const swap = (to) => url.href.replace(/\/(?:\d+x\d*|originals)\//, to);
      return uniq([swap("/originals/"), swap("/736x/"), url.href]);
    }
    if (/media\.tumblr\.com$/.test(h)) {
      return uniq([url.href.replace(/_(\d+)\.(jpg|jpeg|png|gif|webp)/i, "_1280.$2"), url.href]);
    }
    return [url.href];
  }

  // -------------------------------------------------------------- YouTube
  function youtube() {
    const u = new URL(location.href);
    let id = u.searchParams.get("v");
    const m = u.pathname.match(/^\/(shorts|live|embed)\/([\w-]{6,})/);
    if (m) id = m[2];
    if (!id) return null;
    // Preferred source: the player's own data, copied into a DOM attribute by extract_tab.js
    // (a content script can't see the page's JS variables). Only trusted if it is for THIS video:
    // YouTube is a single-page app and its player data can lag behind after navigating.
    let pr = null;
    try {
      const d = JSON.parse(document.documentElement.getAttribute("data-aether-yt") || "null");
      if (d && d.videoId === id) pr = d;
    } catch { /* fall back to the DOM */ }

    // DOM fallback. Each selector is tried on its own, in order: a comma-joined selector returns
    // the first match in document order, which is an ancestor like #description-inner that also
    // contains the view-count odometer ("1 2 3 ... views ... min ago").
    // innerText, not textContent: the collapsed description is clipped in textContent only.
    const firstText = (sels) => {
      for (const s of sels) {
        const v = text(document.querySelector(s));
        if (v) return v;
      }
      return "";
    };
    const MORE = new RegExp("(?:\\.{3}|" + String.fromCharCode(8230) + ")?[^\\S\\n]*(?:\\.{3}|" + String.fromCharCode(8230) + ")?[^\\S\\n]*more$");
    const domDesc = firstText([
      "ytd-watch-metadata ytd-text-inline-expander #attributed-snippet-text",
      "ytd-watch-metadata ytd-text-inline-expander #snippet-text",
      "ytd-text-inline-expander #attributed-snippet-text",
      "ytd-text-inline-expander #snippet-text",
      "ytd-reel-video-renderer[is-active] #description",
    ]).replace(MORE, "").trim();

    const h1 = pr?.title || firstText(["h1.ytd-watch-metadata", "ytd-watch-metadata h1", "ytd-reel-video-renderer[is-active] h2"]);
    const channel = pr?.author || firstText(["ytd-watch-metadata ytd-channel-name a", "#owner ytd-channel-name a", "ytd-reel-video-renderer[is-active] #channel-name a"]);
    const desc = clean(pr?.description || domDesc);
    return {
      original_url: `https://www.youtube.com/watch?v=${id}`,
      type: "video",
      title: h1 || document.title.replace(/^\(\d+\)\s*/, "").replace(/ - YouTube$/, ""),
      author: channel,
      text: desc.slice(0, 5000),
      images: [[`https://i.ytimg.com/vi/${id}/maxresdefault.jpg`, `https://i.ytimg.com/vi/${id}/hqdefault.jpg`]],
      embed: { provider: "youtube", id },
    };
  }

  // ------------------------------------------------------------------- X
  function xcom() {
    const m = location.pathname.match(/^\/([^/]+)\/status\/(\d+)/);
    if (!m) return null;
    const [, handle, tid] = m;
    const arts = [...document.querySelectorAll('article[data-testid="tweet"]')];
    const art = arts.find((a) => a.querySelector(`a[href$="/status/${tid}"]`)) || arts[0];
    if (!art) return null;
    const body = text(art.querySelector('[data-testid="tweetText"]'));
    const name = text(art.querySelector('[data-testid="User-Name"]')).split("\n")[0];
    const images = [...art.querySelectorAll('[data-testid="tweetPhoto"] img')].map((img) => upgradeGroup(img.src));
    const poster = art.querySelector("video[poster]")?.poster;
    if (poster) images.push([poster]);
    return {
      original_url: `https://x.com/${handle}/status/${tid}`,
      type: "post",
      title: `${name || handle} (@${handle}): ${body.slice(0, 90)}`.trim(),
      author: `@${handle}`,
      text: body,
      images,
      embed: { provider: "x", id: tid },
    };
  }

  // ----------------------------------------------------------- Instagram
  function instagram() {
    const m = location.pathname.match(/\/(p|reels?|tv)\/([\w-]+)/);
    if (!m) return null;
    const kind = m[1].startsWith("reel") ? "reel" : m[1];
    const code = m[2];
    const art = document.querySelector("article") || document;
    const imgs = [...art.querySelectorAll("img")]
      .filter((i) => i.naturalWidth >= 300 && !/profile picture/i.test(i.alt || ""))
      .sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight)
      .map((i) => i.currentSrc || i.src);
    const poster = art.querySelector("video[poster]")?.poster;
    const og = meta("og:image");
    const images = uniq([poster, ...imgs.slice(0, 1), og]).map((u) => [u]);
    const ogDesc = meta("og:description");
    const caption = text(art.querySelector("h1")) || (ogDesc.match(/:\s*[“"](.*)[”"]\.?\s*$/s)?.[1] || "");
    const author =
      meta("og:title").match(/^(.*?) on Instagram/)?.[1] ||
      text(document.querySelector("header a")) ||
      location.pathname.split("/").filter(Boolean)[0] || "";
    return {
      original_url: `https://www.instagram.com/${kind}/${code}/`,
      type: kind === "reel" ? "video" : "post",
      title: caption ? caption.slice(0, 100) : `${author} on Instagram`,
      author,
      text: clean(caption),
      images: images.slice(0, 1),
      embed: { provider: "instagram", id: `${kind === "reel" ? "reel" : "p"}/${code}` },
    };
  }

  // ----------------------------------------------------------- Pinterest
  function pinterest() {
    const m = location.pathname.match(/^\/pin\/(\d+)/);
    if (!m) return null;
    const img =
      document.querySelector('[data-test-id="closeup-image"] img, [data-test-id="pin-closeup-image"] img, [data-test-id="visual-content-container"] img') ||
      null;
    const src = img?.currentSrc || img?.src || meta("og:image");
    const dest = document.querySelector('a[data-test-id="pin-closeup-link"], a[data-test-id="link-button"]')?.href;
    const desc = meta("og:description");
    return {
      original_url: `https://www.pinterest.com/pin/${m[1]}/`,
      type: "image",
      title: text(document.querySelector("h1")) || meta("og:title") || document.title,
      author: text(document.querySelector('[data-test-id="creator-profile-name"], [data-test-id="official-user-attribution"]')),
      text: clean([desc, dest && `Source: ${dest}`].filter(Boolean).join("\n")),
      images: src ? [upgradeGroup(src)] : [],
    };
  }

  // -------------------------------------------------------------- Tumblr
  // Only the post itself: its own description (never the page/article text, which carries the
  // reblog trail, replies and notes) and photos that are not avatars or inside notes/comment areas.
  function tumblr() {
    if (!/\/post\/\d+/.test(location.pathname)) return null;
    const NOISE = '[class*="note" i], [class*="comment" i], [class*="repl" i], [class*="avatar" i], ' +
      '[data-testid*="note" i], [aria-label*="notes" i], [role="complementary"], nav, header, footer, aside';
    const AVATAR = /avatar|u_c\d|\/s\d{2,3}x\d{2,3}u/i;
    const post = document.querySelector("article") || document.querySelector("main") || document.body;
    // the same photo appears at several sizes: compare without the size markers
    const keyOf = (u) => u.replace(/\/s\d+x\d+[^/]*\//, "/").replace(/_\d+(\.\w+)$/, "$1");

    const seen = new Set();
    const candidates = [];
    for (const img of post.querySelectorAll("img")) {
      const src = abs(img.currentSrc || img.src);
      if (!src || !/media\.tumblr\.com/.test(src) || AVATAR.test(src) || img.closest(NOISE)) continue;
      if (sizeOf(img).w < 200) continue;
      const key = keyOf(src);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ group: upgradeGroup(src), thumb: src, label: img.alt || "" });
    }
    let images = candidates.slice(0, 1).map((c) => c.group);
    if (!images.length) {
      const og = abs(meta("og:image"));
      if (og && !AVATAR.test(og)) images = [upgradeGroup(og)];
    }
    return {
      original_url: location.href.split("#")[0],
      type: images.length ? "image" : "post",
      title: meta("og:title") || document.title,
      author: host.split(".")[0],
      text: clean(meta("og:description")).slice(0, 2000),
      images,
      candidates,
    };
  }

  // ----------------------------------------------------------- Wikipedia
  // Deep links: "<page>#<Section>" scrolls to the section holding an image or quote, and the text
  // directive ":~:text=" (Chrome) additionally scrolls to and highlights the exact words.
  const directiveText = (s) => encodeURIComponent(s).replace(/-/g, "%2D");
  const words = (s) => clean(s).replace(/\s*\n\s*/g, " ").split(" ").filter(Boolean);
  function textDirective(quote) {
    const q = String(quote || "").trim();
    if (!q) return "";
    const lines = q.split(/\n+/).map((l) => words(l)).filter((w) => w.length);
    const all = lines.flat();
    if (!all.length) return "";
    if (lines.length === 1 && q.length <= 200) return `text=${directiveText(all.join(" "))}`;
    // long or multi-paragraph quote: "start,end" matches everything in between
    return `text=${directiveText(lines[0].slice(0, 5).join(" "))},${directiveText(lines.at(-1).slice(-5).join(" "))}`;
  }
  function wikiDeepLink(el, quote) {
    const base = location.href.split("#")[0];
    let head = null;
    for (const h of document.querySelectorAll("#mw-content-text :is(h2, h3, h4, h5, h6)[id]")) {
      if (h.compareDocumentPosition(el) & 4 /* el follows h */) head = h; else break;
    }
    const dir = textDirective(quote);
    const frag = (head ? encodeURIComponent(head.id) : "") + (dir ? `:~:${dir}` : "");
    return { url: frag ? `${base}#${frag}` : base, section: head ? text(head).replace(/\[\s*edit\s*\]/i, "").trim() : "" };
  }
  // First words of a caption, without footnote markers like "[1]".
  const captionLead = (c) => words((c || "").replace(/\[[^\]]*\]/g, "")).slice(0, 8).join(" ");

  // Where is this image / this selection? Called by the right-click menu.
  window.__aetherLocate = ({ src, quote } = {}) => {
    if (!onHost("wikipedia.org") || !document.querySelector("#mw-content-text")) return null;
    const key = (u) => (abs(u) || "").split("?")[0].replace(/\/\d+px-/, "/");
    let el = null;
    let q = "";
    if (src) {
      const want = key(src);
      const img = [...document.images].find((i) => key(i.currentSrc || i.src) === want);
      if (!img) return null;
      el = img;
      q = captionLead(text(img.closest("figure, .thumb, .gallerybox")?.querySelector("figcaption, .thumbcaption, .gallerytext")));
    } else if (quote) {
      const s = getSelection();
      const n = s && s.rangeCount ? s.getRangeAt(0).startContainer : null;
      el = n && (n.nodeType === 1 ? n : n.parentElement);
      q = quote;
    }
    if (!el || !el.closest("#mw-content-text")) return null;
    return wikiDeepLink(el, q);
  };

  // No body text: the item is the title + link (or whatever the user selected). Every real picture
  // in the article becomes an option; icons, navboxes and maths are filtered out.
  function wikipediaImages() {
    const SKIP = ".navbox, .metadata, .noprint, .sistersitebox, .mbox, .ambox, .reflist, .mw-references-wrap, .hatnote, .toc";
    const seen = new Set();
    const out = [];
    for (const img of document.querySelectorAll("#mw-content-text img")) {
      if (img.closest(SKIP) || /mwe-math/.test(img.className)) continue;
      const { w, h } = sizeOf(img);
      if (w < 100 || h < 60) continue;
      const src = abs(img.currentSrc || img.src);
      if (!src) continue;
      const key = src.replace(/\/\d+px-/, "/");
      if (seen.has(key)) continue;
      seen.add(key);
      const caption = text(img.closest("figure, .thumb, .gallerybox")?.querySelector("figcaption, .thumbcaption, .gallerytext"));
      const link = wikiDeepLink(img, captionLead(caption));
      out.push({ group: upgradeGroup(src), thumb: src, label: (img.alt || caption || "").slice(0, 120), link: link.url, section: link.section });
    }
    return out.slice(0, 24);
  }

  function wikipedia() {
    const h1 = document.querySelector("#firstHeading");
    if (!h1) return null;
    // a highlighted quote links to where it sits in the article
    const sel = String(getSelection() || "").trim();
    const loc = sel ? window.__aetherLocate({ quote: sel }) : null;
    return {
      original_url: loc ? loc.url : location.href.split("#")[0],
      type: "article",
      title: loc && loc.section ? `${text(h1)} › ${loc.section}` : text(h1),
      author: "Wikipedia",
      text: "",
      images: [],
      candidates: wikipediaImages(),
    };
  }

  // ------------------------------------------- Generic pages and blogs
  function generic() {
    if (document.contentType?.startsWith("image/")) {
      return { original_url: location.href, type: "image", title: document.title || location.pathname.split("/").pop(), images: [[location.href]] };
    }
    let art = null;
    try {
      if (typeof Readability === "function") art = new Readability(document.cloneNode(true)).parse();
    } catch { /* pages that defeat Readability still get og: metadata */ }

    let lead = null;
    const inArticle = [];
    if (art?.content) {
      const doc = new DOMParser().parseFromString(art.content, "text/html");
      lead = doc.querySelector("img")?.getAttribute("src");
      for (const i of doc.querySelectorAll("img")) {
        const w = Number(i.getAttribute("width")) || 0;
        const src = abs(i.getAttribute("src"));
        if (src && !src.startsWith("data:") && (w === 0 || w >= 120)) inArticle.push(src);
      }
    }
    const images = uniq([abs(meta("og:image")), abs(meta("twitter:image")), abs(lead)]).slice(0, 2).map((u) => [u]);
    const candidates = uniq(inArticle).slice(0, 12).map((u) => ({ group: upgradeGroup(u), thumb: u, label: "" }));
    // A real description beats a few stray words; substantial Readability output beats a description.
    const artText = clean(art?.textContent || "");
    const desc = meta("og:description") || meta("description");
    const body = artText.length >= 280 || !desc ? artText : desc;
    const canonical = abs(document.querySelector('link[rel="canonical"]')?.href);
    const sameSite = canonical && new URL(canonical).hostname.replace(/^www\./, "") === host;
    return {
      original_url: sameSite ? canonical : location.href.split("#")[0],
      type: art && (art.textContent || "").length > 800 ? "article" : "page",
      title: art?.title || meta("og:title") || document.title,
      author: art?.byline || meta("author") || meta("article:author") || meta("og:site_name") || "",
      text: body.slice(0, MAX_TEXT),
      images,
      candidates,
    };
  }

  function adapterForHost() {
    if (onHost("youtube.com") || host === "youtu.be") return youtube;
    if (onHost("x.com") || onHost("twitter.com")) return xcom;
    if (onHost("instagram.com")) return instagram;
    if (/(^|\.)pinterest\./.test(host)) return pinterest;
    if (onHost("tumblr.com")) return tumblr;
    if (onHost("wikipedia.org")) return wikipedia;
    return null;
  }

  window.__aetherUpgrade = (u) => upgradeGroup(u);

  window.__aetherExtract = async () => {
    const adapter = adapterForHost();
    let r = null;
    try { r = adapter?.() || null; } catch (e) { console.debug("[aether] adapter failed", e); }
    let viaAdapter = !!r;
    if (!r || !(r.title || r.text || r.images?.length)) { r = generic(); viaAdapter = false; }
    r.adapter = viaAdapter;       // a site adapter understood this page
    r.known_host = !!adapter;     // ...or this is a site with adapters but the page isn't a post/video/pin (feeds, home)
    const keep = (g) => (g || []).filter(Boolean);
    r.images = (r.images || []).map(keep).filter((g) => g.length);
    r.candidates = (r.candidates || []).map((c) => ({ ...c, group: keep(c.group) })).filter((c) => c.group.length);
    r.tags = [];

    // What the user highlighted always wins and is stored verbatim. If the page also supplies text
    // (blogs), the selection is put first as a quote.
    const sel = String(getSelection() || "").trim().slice(0, 20000);
    if (sel) {
      r.text = r.text ? `> ${sel.replace(/\n/g, "\n> ")}\n\n${r.text}` : sel;
      r.text_source = "selection";
    } else {
      r.text_source = r.text ? "page" : "none";
    }
    r.selection_chars = sel.length;
    r.title = clean(r.title).slice(0, 300);
    return r;
  };
})();
