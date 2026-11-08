// Fixture tests for extension/content/extract.js, run in jsdom with the real Readability library.
// Fixtures are hand-built approximations of each site's DOM: they pin the extractor's *logic*.
// When a site changes its markup, add a saved page here and fix the selector (see README).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

const SRC = readFileSync(new URL("../../extension/content/extract.js", import.meta.url), "utf8");

function load(url, html) {
  const dom = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  // jsdom doesn't load images, so report the declared size as the natural size
  for (const [prop, attr] of [["naturalWidth", "width"], ["naturalHeight", "height"]]) {
    Object.defineProperty(w.HTMLImageElement.prototype, prop, { get() { return Number(this.getAttribute(attr) || 0); } });
  }
  w.Readability = Readability; // the extension injects lib/Readability.js as a global
  w.eval(SRC);
  return w;
}
const plain = (v) => JSON.parse(JSON.stringify(v)); // jsdom objects live in another realm
async function extract(url, html, { select } = {}) {
  const w = load(url, html);
  if (select) {
    const range = w.document.createRange();
    range.selectNodeContents(w.document.querySelector(select));
    w.getSelection().removeAllRanges();
    w.getSelection().addRange(range);
  }
  return plain(await w.__aetherExtract());
}

const lorem = "Neural networks learn representations by gradient descent over many layers of weights. ".repeat(14);

// ------------------------------------------------------------------ blogs
test("blog post: Readability gives title, author, body, og:image and in-article image options", async () => {
  const r = await extract("https://blog.example.com/posts/ml?utm_source=x", `<html><head>
    <title>Site | How nets learn</title><meta property="og:title" content="How nets learn">
    <meta property="og:image" content="/cover.jpg"><meta name="author" content="Ada Lovelace">
    <link rel="canonical" href="https://blog.example.com/posts/ml"></head>
    <body><nav>Home About</nav><article><h1>How nets learn</h1><p>${lorem}</p>
      <img src="/figure.png" width="600" height="400"><img src="/icon.png" width="16" height="16"><p>${lorem}</p></article><footer>(c)</footer></body></html>`);
  assert.equal(r.type, "article");
  assert.equal(r.original_url, "https://blog.example.com/posts/ml");
  assert.match(r.title, /How nets learn/);
  assert.ok(r.text.length > 800 && !r.text.includes("Home About"));
  assert.equal(r.text_source, "page");
  assert.deepEqual(r.images[0], ["https://blog.example.com/cover.jpg"]);
  const options = r.candidates.map((c) => c.group[0]);
  assert.ok(options.includes("https://blog.example.com/figure.png"), JSON.stringify(options));
  assert.ok(!options.some((u) => u.endsWith("icon.png")));
});

test("plain page without article body falls back to meta description", async () => {
  const r = await extract("https://example.com/", `<html><head><title>Landing</title>
    <meta name="description" content="A tiny landing page."></head><body><p>hi</p></body></html>`);
  assert.equal(r.type, "page");
  assert.equal(r.text, "A tiny landing page.");
});

// -------------------------------------------------------------- wikipedia
const WIKI = `<html><body><h1 id="firstHeading">Cat</h1>
  <div id="mw-content-text"><div class="mw-parser-output">
    <table class="infobox"><tr><td>
      <img class="mw-file-element" alt="A tabby cat" width="250" height="300" src="//upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Cat.jpg/250px-Cat.jpg">
    </td></tr></table>
    <section>
      <p id="p1">The cat is a domestic species of small carnivorous mammal.[1] It is the only domesticated species in Felidae.[a]</p>
      <figure typeof="mw:File/Thumb"><img class="mw-file-element" width="220" height="150" src="//upload.wikimedia.org/wikipedia/commons/thumb/c/cd/Kitten.png/220px-Kitten.png"><figcaption>A kitten playing</figcaption></figure>
      <figure><img class="mw-file-element" width="330" height="200" src="//upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Cat.jpg/330px-Cat.jpg"></figure>
      <img class="mwe-math-fallback-image-inline" width="200" height="80" src="https://wikimedia.org/api/rest_v1/media/math/render/svg/abc">
      <p id="p2">Cats have been used since ancient times to control rodents in agricultural settings and around ships.</p>
    </section>
    <div class="navbox"><img width="300" height="200" src="//upload.wikimedia.org/wikipedia/commons/thumb/z/zz/Nav.jpg/300px-Nav.jpg">
      <img width="16" height="16" src="//upload.wikimedia.org/wikipedia/en/thumb/9/96/Symbol_category_class.svg/16px-Symbol_category_class.svg.png"></div>
    <span class="noprint"><img width="120" height="90" src="//upload.wikimedia.org/wikipedia/commons/thumb/e/ee/Edit.png/120px-Edit.png"></span>
  </div></div></body></html>`;

test("wikipedia: no selection -> title + link only, real pictures offered as options", async () => {
  const r = await extract("https://en.wikipedia.org/wiki/Cat#History", WIKI);
  assert.equal(r.adapter, true);
  assert.equal(r.original_url, "https://en.wikipedia.org/wiki/Cat");
  assert.equal(r.title, "Cat");
  assert.equal(r.text, "");
  assert.equal(r.text_source, "none");
  assert.deepEqual(r.images, [], "nothing is pre-selected: the user chooses");
  // lead image, kitten; the 330px copy of Cat.jpg is the same file; math, navbox, icons, noprint are skipped
  assert.equal(r.candidates.length, 2, JSON.stringify(r.candidates.map((c) => c.thumb)));
  assert.match(r.candidates[0].group[0], /\/960px-Cat\.jpg$/);
  assert.match(r.candidates[0].group[1], /\/250px-Cat\.jpg$/);
  assert.equal(r.candidates[0].label, "A tabby cat");
  assert.equal(r.candidates[1].label, "A kitten playing");
});

test("wikipedia: selected text is saved verbatim, citation marks and all", async () => {
  const r = await extract("https://en.wikipedia.org/wiki/Cat", WIKI, { select: "#p2" });
  assert.equal(r.text, "Cats have been used since ancient times to control rodents in agricultural settings and around ships.");
  assert.equal(r.text_source, "selection");
  assert.equal(r.selection_chars, r.text.length);
  assert.equal(r.title, "Cat");
});

// ------------------------------------------------------------------ x.com
test("x.com: focal tweet, original-size image, handle and embed id", async () => {
  const r = await extract("https://twitter.com/jack/status/20?s=20", `<html><body>
    <article data-testid="tweet"><a href="/other/status/19">x</a><div data-testid="tweetText">some reply</div></article>
    <article data-testid="tweet"><div data-testid="User-Name">jack\n@jack</div><a href="/jack/status/20">time</a>
      <div data-testid="tweetText">just setting up my twttr</div>
      <div data-testid="tweetPhoto"><img src="https://pbs.twimg.com/media/ABC?format=jpg&name=small"></div></article></body></html>`);
  assert.equal(r.original_url, "https://x.com/jack/status/20");
  assert.equal(r.author, "@jack");
  assert.equal(r.text, "just setting up my twttr");
  assert.deepEqual(r.embed, { provider: "x", id: "20" });
  assert.match(r.images[0][0], /name=orig/);
  assert.match(r.images[0].at(-1), /name=small/);
});

test("adapter miss (x.com home) falls through to the generic extractor and says so", async () => {
  const r = await extract("https://x.com/home", `<html><head><title>Home / X</title></head><body></body></html>`);
  assert.equal(r.title, "Home / X");
  assert.equal(r.original_url, "https://x.com/home");
  assert.equal(r.adapter, false);
  assert.equal(r.known_host, true); // the right-click handler uses this to avoid merging feed images
});

// -------------------------------------------------------------- instagram
test("instagram reel: canonical permalink, caption, poster", async () => {
  const r = await extract("https://www.instagram.com/someone/reel/Cabc123/?igsh=zzz", `<html><head>
    <meta property="og:title" content="Some One on Instagram: &quot;nice&quot;"></head><body>
    <article><h1>Golden hour in Jaipur</h1><video poster="https://scontent.cdninstagram.com/poster.jpg"></video>
    <img width="640" height="800" alt="Photo" src="https://scontent.cdninstagram.com/v/pic.jpg"></article></body></html>`);
  assert.equal(r.original_url, "https://www.instagram.com/reel/Cabc123/");
  assert.equal(r.type, "video");
  assert.equal(r.author, "Some One");
  assert.equal(r.text, "Golden hour in Jaipur");
  assert.deepEqual(r.embed, { provider: "instagram", id: "reel/Cabc123" });
  assert.equal(r.images[0][0], "https://scontent.cdninstagram.com/poster.jpg");
});

// -------------------------------------------------------------- pinterest
test("pinterest: upgrades the 736x thumbnail to /originals/", async () => {
  const r = await extract("https://in.pinterest.com/pin/123456/?utm_medium=x", `<html><head><meta property="og:description" content="Brutalist poster"></head><body>
    <h1>Brutalist poster</h1><div data-test-id="closeup-image"><img src="https://i.pinimg.com/736x/aa/bb/cc.jpg"></div></body></html>`);
  assert.equal(r.original_url, "https://www.pinterest.com/pin/123456/");
  assert.equal(r.type, "image");
  assert.deepEqual(r.images[0], [
    "https://i.pinimg.com/originals/aa/bb/cc.jpg",
    "https://i.pinimg.com/736x/aa/bb/cc.jpg",
  ]);
});

// ----------------------------------------------------------------- tumblr
test("tumblr: asks for the 1280 variant first", async () => {
  const r = await extract("https://foo.tumblr.com/post/12345/slug", `<html><head><meta property="og:title" content="A photo"></head><body>
    <article><img width="500" height="400" src="https://64.media.tumblr.com/abc/tumblr_xyz_500.jpg"></article></body></html>`);
  assert.equal(r.type, "image");
  assert.equal(r.author, "foo");
  assert.deepEqual(r.images[0], [
    "https://64.media.tumblr.com/abc/tumblr_xyz_1280.jpg",
    "https://64.media.tumblr.com/abc/tumblr_xyz_500.jpg",
  ]);
});

const TUMBLR = (head) => `<html><head><meta property="og:title" content="Golden hour">${head}</head><body>
  <article>
    <header><img width="64" height="64" src="https://64.media.tumblr.com/h1/h2/s64x64u_c1/blogavatar.png"></header>
    <img width="640" height="480" src="https://64.media.tumblr.com/aaa/bbb/s640x960/post.jpg">
    <p class="caption-text">The post itself, with a long enough sentence to matter.</p>
    <ol class="notes-list"><li><img width="500" height="300" src="https://64.media.tumblr.com/ddd/eee/s500x750/reblogger-photo.jpg">
      <p>great pic!!! reblogged with comment</p></li></ol>
    <div class="reply-thread"><img width="64" height="64" src="https://64.media.tumblr.com/ccc/avatar_zzz_64.png"><p>Lol first!</p></div>
  </article></body></html>`;

test("tumblr: only the post's own photo is offered; notes, replies and avatars are ignored", async () => {
  const r = await extract("https://foo.tumblr.com/post/12345/slug", TUMBLR(""));
  assert.equal(r.text, "", "never falls back to the article's text, which carries the comments");
  assert.equal(r.text_source, "none");
  assert.equal(r.candidates.length, 1, JSON.stringify(r.candidates.map((c) => c.thumb)));
  assert.match(r.candidates[0].thumb, /post\.jpg$/);
  assert.equal(r.images.length, 1);
  assert.match(r.images[0].at(-1), /post\.jpg$/);
  assert.ok(!JSON.stringify(r).includes("great pic") && !JSON.stringify(r).includes("Lol first"));
});

test("tumblr: the post description comes from og:description only", async () => {
  const r = await extract("https://foo.tumblr.com/post/12345/slug", TUMBLR(`<meta property="og:description" content="Golden light over the lake.">`));
  assert.equal(r.text, "Golden light over the lake.");
  assert.equal(r.text_source, "page");
});

// ---------------------------------------------------------------- youtube
test("youtube: normalises URL, maxres then hq thumbnail, title from document.title", async () => {
  const r = await extract("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5s&utm_source=x", `<html><head><title>(3) Never Gonna - YouTube</title></head><body></body></html>`);
  assert.equal(r.original_url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.equal(r.type, "video");
  assert.equal(r.title, "Never Gonna");
  assert.deepEqual(r.embed, { provider: "youtube", id: "dQw4w9WgXcQ" });
  assert.match(r.images[0][0], /maxresdefault/);
  assert.match(r.images[0][1], /hqdefault/);
});

// The real watch page: #description-inner is an ancestor that also holds the view-count odometer.
const ELL = String.fromCharCode(8230);
const ytPage = (attr) => `<html ${attr}><head><title>x - YouTube</title></head><body>
  <ytd-watch-metadata>
    <h1 class="ytd-watch-metadata">Real Title</h1>
    <ytd-channel-name><a>Real Channel</a></ytd-channel-name>
    <div id="description-inner">
      <div id="info-container"><span>1 2 3 4 5 6 7 8 9 0</span> views <span>2 min ago</span> #tag1 #tag2</div>
      <ytd-text-inline-expander>
        <span id="attributed-snippet-text">The actual description line.\nSUPPORT ME: https://ko-fi.com/x ${ELL}more</span>
      </ytd-text-inline-expander>
    </div>
  </ytd-watch-metadata></body></html>`;

test("youtube: description comes from the player data, never the odometer/view-count header", async () => {
  const data = JSON.stringify({ videoId: "abcdefghijk", title: "Player Title", author: "Player Channel", description: "Full description\n\nwith every line, not clipped.\n#tag" });
  const r = await extract("https://www.youtube.com/watch?v=abcdefghijk", ytPage(`data-aether-yt='${data}'`));
  assert.equal(r.text, "Full description\n\nwith every line, not clipped.\n#tag");
  assert.equal(r.title, "Player Title");
  assert.equal(r.author, "Player Channel");
  assert.doesNotMatch(r.text, /views|ago|1 2 3/);
});

test("youtube: player data for a different video is ignored; DOM fallback is clean (no odometer, no '...more')", async () => {
  const stale = JSON.stringify({ videoId: "OTHERVIDEO1", title: "Wrong", author: "Wrong", description: "WRONG" });
  const r = await extract("https://www.youtube.com/watch?v=abcdefghijk", ytPage(`data-aether-yt='${stale}'`));
  assert.equal(r.text, "The actual description line.\nSUPPORT ME: https://ko-fi.com/x");
  assert.equal(r.title, "Real Title");
  assert.equal(r.author, "Real Channel");
});

// ------------------------------------------------- wikipedia deep links
const WKI = "https://en.wikipedia.org/wiki/Cat";
const wkPage = `<html><head><title>Cat - Wikipedia</title></head><body>
  <h1 id="firstHeading"><span>Cat</span></h1>
  <div id="mw-content-text"><div class="mw-parser-output">
    <figure class="thumb"><img id="lead" src="//upload.wikimedia.org/wikipedia/commons/a/a1/Lead.jpg/220px-Lead.jpg" width="220" height="200" alt="">
      <figcaption>A tabby cat.</figcaption></figure>
    <p id="p0">The cat is a small carnivorous mammal.</p>
    <div class="mw-heading mw-heading2"><h2 id="History">History</h2><span class="mw-editsection">[edit]</span></div>
    <figure class="thumb"><img id="hist" src="//upload.wikimedia.org/wikipedia/commons/b/b2/Old.jpg/220px-Old.jpg" width="220" height="200" alt="">
      <figcaption>A cat in 1900 with a long caption that keeps going on and on.<sup>[1]</sup></figcaption></figure>
    <div class="mw-heading mw-heading3"><h3 id="Early_domestication">Early domestication</h3></div>
    <p id="p1">Cats were first domesticated in the Near East.</p>
    <p id="p2">A second paragraph about rats-and-grain storage in early farming villages.</p>
  </div></div></body></html>`;
const selectIn = (w, from, to) => {
  const r = w.document.createRange();
  r.setStart(w.document.querySelector(from).firstChild, 0);
  r.setEnd(w.document.querySelector(to).lastChild, w.document.querySelector(to).lastChild.textContent.length);
  w.getSelection().removeAllRanges();
  w.getSelection().addRange(r);
};

test("wikipedia locate: image links to its section plus the caption's first words (footnote marker dropped)", async () => {
  const w = load(WKI, wkPage);
  const r = plain(w.__aetherLocate({ src: "https://upload.wikimedia.org/wikipedia/commons/b/b2/Old.jpg/500px-Old.jpg" })); // different thumb size, same file
  assert.equal(r.section, "History");
  assert.equal(r.url, `${WKI}#History:~:text=A%20cat%20in%201900%20with%20a%20long%20caption`);
});

test("wikipedia locate: a picture above the first heading has no section, only the caption", async () => {
  const w = load(WKI, wkPage);
  const r = plain(w.__aetherLocate({ src: "https://upload.wikimedia.org/wikipedia/commons/a/a1/Lead.jpg/220px-Lead.jpg" }));
  assert.equal(r.section, "");
  assert.equal(r.url, `${WKI}#:~:text=A%20tabby%20cat.`);
});

test("wikipedia locate: short selection -> nearest heading + exact text; long/multi-paragraph -> start,end with '-' escaped", async () => {
  let w = load(WKI, wkPage);
  selectIn(w, "#p1", "#p1");
  let r = plain(w.__aetherLocate({ quote: "Cats were first domesticated in the Near East." }));
  assert.equal(r.section, "Early domestication");
  assert.equal(r.url, `${WKI}#Early_domestication:~:text=Cats%20were%20first%20domesticated%20in%20the%20Near%20East.`);

  w = load(WKI, wkPage);
  selectIn(w, "#p1", "#p2");
  r = plain(w.__aetherLocate({ quote: "Cats were first domesticated in the Near East.\nA second paragraph about rats-and-grain storage in early farming villages." }));
  assert.equal(r.url, `${WKI}#Early_domestication:~:text=Cats%20were%20first%20domesticated%20in,storage%20in%20early%20farming%20villages.`);
  assert.equal(plain(load(WKI, wkPage).__aetherLocate({ quote: "x" })), null); // selection outside the page text -> nothing to locate
});

test("wikipedia locate: '-' inside a quoted phrase is percent-escaped (it is the directive's own separator)", async () => {
  const w = load(WKI, wkPage);
  selectIn(w, "#p2", "#p2");
  const r = plain(w.__aetherLocate({ quote: "rats-and-grain storage" }));
  assert.match(r.url, /text=rats%2Dand%2Dgrain%20storage$/);
});

test("wikipedia: popup candidates carry their own deep link; a page-level selection retitles + relinks the item", async () => {
  const r = await extract(WKI, wkPage);
  const hist = r.candidates.find((c) => c.thumb.includes("Old.jpg"));
  assert.equal(hist.section, "History");
  assert.match(hist.link, /#History:~:text=A%20cat%20in%201900/);
  assert.equal(r.original_url, WKI); // nothing selected: the page itself

  const s = await extract(WKI, wkPage, { select: "#p1" });
  assert.equal(s.original_url, `${WKI}#Early_domestication:~:text=Cats%20were%20first%20domesticated%20in%20the%20Near%20East.`);
  assert.equal(s.title, "Cat › Early domestication");
});

test("wikipedia locate: other sites return null", async () => {
  const w = load("https://example.com/a", `<html><body><p id="p">hello</p></body></html>`);
  assert.equal(w.__aetherLocate({ quote: "hello" }), null);
});

// -------------------------------------------------------------- selection
test("blog: selected text is put first as a quote above the page text", async () => {
  const r = await extract("https://example.com/a", `<html><head><title>T</title><meta name="description" content="desc"></head>
    <body><p id="p">Pick this sentence.</p></body></html>`, { select: "#p" });
  assert.ok(r.text.startsWith("> Pick this sentence."));
  assert.equal(r.text_source, "selection");
});

// ------------------------------------------------- right-click image upgrade
test("__aetherUpgrade: best-quality URL first, the page's own URL last", async () => {
  const w = load("https://example.com/", "<html><body></body></html>");
  const up = (u) => plain(w.__aetherUpgrade(u));
  assert.deepEqual(up("https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Cat.jpg/250px-Cat.jpg"), [
    "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Cat.jpg/960px-Cat.jpg",
    "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Cat.jpg/250px-Cat.jpg",
  ]);
  assert.match(up("https://pbs.twimg.com/media/ABC?format=jpg&name=small")[0], /name=orig/);
  assert.equal(up("https://i.pinimg.com/236x/aa/bb/cc.jpg")[0], "https://i.pinimg.com/originals/aa/bb/cc.jpg");
  assert.match(up("https://64.media.tumblr.com/abc/tumblr_xyz_500.jpg")[0], /_1280\.jpg$/);
  assert.deepEqual(up("https://example.org/pic.png"), ["https://example.org/pic.png"]);
});
