# Aether

Local-first idea collection. A Chrome extension captures pages, posts, images and videos; a local
Python engine stores, indexes and searches them; a web UI shows them as a fast masonry grid.
Phase 1 of the plan: **capture → storage → grid → search → tags**.

## Install the app (Windows 10/11, 64-bit)

Download from **[Releases](../../releases/latest)**:

- **`Aether-Setup-<version>.exe`**: installer. Per-user, no admin prompt; Start menu + desktop shortcut; uninstall from
  Windows Settings → Apps.
- **`Aether-<version>-portable.zip`**: unzip anywhere and run `Aether.exe`.

Both contain everything, including the meaning-search models (~700 MB), so nothing else is downloaded.
The installer is not code-signed, so Windows SmartScreen may say "Windows protected your PC": click
**More info → Run anyway**.

How the app behaves:

- **Aether.exe** opens its own window. Closing it leaves a small **background engine** running so the browser
  extension can still save; it also starts with Windows (turn that off in **Settings**). With no window open
  for 90 s, the engine only stores captures: reading text in images, meaning indexing and topics wait until you
  open Aether again, and the models are unloaded to keep RAM low. **Settings → Quit Aether** stops everything.
- **Theme**: the ◐ button in the header (or **T**) cycles Auto (follow Windows) → Light → Dark.
- **Your library** lives in `%USERPROFILE%\.aether` (database, files, token, settings, logs). Installing, updating
  or uninstalling never touches it.
- **Extension**: open **Settings** in the app, click **Open this folder**, then in Chrome go to `chrome://extensions` →
  Developer mode → Load unpacked → pick that folder, and paste the token shown in Settings.

### Build the app yourself

```bat
powershell -ExecutionPolicy Bypass -File desktop\build.ps1
```

Needs the dev setup below, the models in `%USERPROFILE%\.aether\models` (`python -m engine.models`), and Inno Setup 6
(`winget install JRSoftware.InnoSetup`). Output: `dist\Aether\` (the app), the portable zip and `Aether-Setup-<version>.exe`.
Run the app from source with `.venv\Scripts\python desktop\aether.py`.

## Run it from source (development)

```bat
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
run.bat                          :: starts the engine and opens http://127.0.0.1:47821/
```

The engine prints a token. (It is also shown in the UI under **Extension setup**.)

1. Chrome → `chrome://extensions` → **Developer mode** → **Load unpacked** → pick the `extension` folder.
2. Click the Aether icon, paste the token once.
3. Save from any page, two ways:
   - **Popup** (icon or **Alt+Shift+S**): pick images, add tags and a note, **Save**.
   - **Right-click** → *Save page / selection / image / link to Aether*. One click, no tags (add them later in the
     UI); a small toast in the page confirms. Browsers' own custom menus (e.g. over the YouTube player) replace
     Chrome's, so right-click anywhere else on the page there.

After pulling an update, reload the extension at `chrome://extensions` (new permissions apply on reload).

### What gets saved

| You do | Text stored | Images stored |
|---|---|---|
| Select text, then save (popup) | exactly what you selected (for blogs: as a quote above the article text) | the ticked ones |
| Save with nothing selected, Wikipedia | nothing: the item is the title + link | none pre-ticked; every real picture in the article is offered |
| Save with nothing selected, Tumblr | the post's own description only (never comments, notes or the reblog trail) | the post's photo; avatars and photos inside notes/replies are ignored |
| Save with nothing selected, blogs | the article (Readability) | cover image pre-ticked; images inside the article offered |
| Right-click an image | only text you had selected, never the article | that image, upgraded to full size where the site allows |
| Right-click a selection | the selection | none |
| Right-click a link | none (title = the link text if selected, else the URL) | none |
| YouTube video | the video's real description, read from the player's own data (never the view-count header) | the thumbnail |

**Wikipedia links point at the spot, not the page.** Saving a picture or a highlighted quote links to the section
it sits in (`…/wiki/Cat#History`), plus the first words of the caption / the quote itself as a text directive
(`#History:~:text=…`), which Chrome scrolls to and highlights. The title becomes *Cat › History*. This works
for right-click and for the popup (one picture ticked, or text selected). The fragment is part of the item's
identity on Wikipedia, so two different spots are two items; two uncaptioned pictures from the same section are
the same item with two images. A save with nothing selected still links to the page.

On a feed or timeline (X home, a Pinterest board...) a right-clicked image becomes its own item, with the page noted,
so images from one feed don't merge into a single "Home" item.

Your data lives in `%USERPROFILE%\.aether` (SQLite DB + `storage\originals` + `storage\thumbs`).
Copy that folder to back it up.

## What is in here

```
engine/      FastAPI app: auth, capture, search, tags, job queue   (python -m engine)
ui/          Static web UI, no build step: virtualised masonry grid, filters, detail drawer
extension/   Manifest V3 extension: per-site extractors, offline queue
tests/       pytest (engine) · tests/js (extractor fixtures, `npm test`) · seed.py (load generator)
```

### Engine decisions

| Concern | Choice |
|---|---|
| Unauthenticated localhost API | Binds to `127.0.0.1`; `Host` header must be `127.0.0.1`/`localhost` (blocks DNS rebinding); every `/api` call needs the install's secret token; CORS allows only `chrome-extension://` origins. |
| Signed CDN URLs (X, Instagram) | The **extension** downloads image bytes (inside the page first, then from the service worker) and uploads them. The engine never fetches a media URL. |
| Engine not running | Captures go to an IndexedDB queue and retry every minute (badge shows the count). |
| Layout without jank | Thumbnail sizes are stored, so the grid is laid out before any image loads; only cards near the viewport exist in the DOM. |
| Dedup | Canonical URL (tracking params stripped; `twitter.com`→`x.com`; `youtu.be`/shorts → `watch?v=`), plus SHA-256 of image bytes. Perceptual hash is stored for later cross-item dedup. |
| Search | SQLite FTS5 over title, text, OCR text, author and tags, with prefix matching and BM25 ranking. |
| Background work | A `jobs` table, not in-memory tasks: `running` jobs return to `pending` after a crash; failures retry with backoff. OCR is the first job type. |

### OCR

Jobs are queued on every image, but run only if an OCR package is installed:
`pip install rapidocr onnxruntime` (rapidocr needs the runtime; without it the jobs are marked *skipped*, not retried
forever). Skipped jobs are re-queued automatically on the next start.

### Refresh

The grid doesn't live-update (cards jumping under the cursor is worse than a click). **Refresh** (or **R**) reloads
the library; a light poll of `/api/stats` every 15 s and whenever you return to the tab turns the button into
*Refresh · +N new* when something was saved from the extension.

## Phase 2: meaning, related items, topics

Everything here runs on your PC. Nothing is sent anywhere, and Aether works exactly as before until you download the models.

**Turn it on.** Click **Download** in the banner at the top of the library (or run `.venv\Scripts\python -m engine.models`;
add `--small` for ~180 MB int8 versions instead of ~700 MB), then `pip install -r requirements.txt` once for the new packages
(`onnxruntime`, `tokenizers`, `scikit-learn`, `umap-learn`). The engine then embeds every item in the background (about
50 ms per picture on CPU) and re-embeds only what actually changed. For GPU use `pip install onnxruntime-directml` instead
of `onnxruntime`; it is picked up automatically, CPU otherwise.

| Feature | How it works |
|---|---|
| **Meaning** toggle (key **M**) | Pictures are scored with CLIP ViT-B/32, texts with bge-small-en-v1.5. A picture matches "dog" when "a photo of a dog" beats ~170 other common descriptions for it, which is what keeps nonsense queries empty; a text matches when it stands out from the library's typical similarity (robust z-score ≥ 4). Picture, text and keyword lists are merged with rank fusion. |
| **Related** (item drawer) | Nearest neighbours over text + picture vectors, exact (a numpy matrix product; no vector database is needed below tens of thousands of items). |
| **Suggested tags** (drawer) | Tags *you* typed or accepted on the 15 most similar items, closer ones counting more; needs at least two supporters. Automatic `web`/`article` tags are never suggested. Click to accept. |
| **Topics** (sidebar) | Blended vectors → UMAP → HDBSCAN. Names: the distinctive words of the cluster (c-TF-IDF) for text topics, or the closest everyday concepts for picture topics. **Text ↔ Looks** slider chooses what topics are built from; **Regroup** recomputes. Re-groups itself when ≥10 % new items arrived. Needs ≥12 items. The first run compiles UMAP (≈30 s); later runs are faster. |
| **Make a tag from this topic** | Filter to a topic, click the button: every member gets an ordinary tag you can then edit. Topics themselves are recomputed freely; tags are yours. |

Measured on a labelled test library (150 items: 90 pictures from public datasets, 60 newsgroup posts; synthetic, **not
your data**):

| | |
|---|---|
| Related: same-class share of top 5 | pictures 0.96, texts 0.71 |
| Topics vs. true classes | ARI 0.80, NMI 0.93 (two sets of 5 cathedral pictures split, motorcycles+autos merged) |
| Tag suggestions (3 tagged per class) | 67 right, 0 wrong, 38 abstained (precision 1.00 when it speaks) |
| Meaning search for nonsense words | 0 results (a bare-CLIP threshold returned dozens) |

Caveats: the thresholds were calibrated on that library, so expect to re-tune them (`TEXT_Z`, `IMAGE_P` in
`engine/semantic.py`) once it meets your real, messier saves. bge-small is English only. The food-class labels in my test
set turned out to be wrong, so food search numbers there are meaningless; I did not re-measure.
## Measured (3,000 synthetic items, this machine, `tests/seed.py`)

### Graph view

**Graph controls** (toolbar above the graph; settings are remembered between sessions):
- **Links** – similarity on/off, links per item, loose↔strict, text↔looks blend, tag links on/off and *which* tags make links.
- **Look** – node size (links / same / recency), colour (topic / source / type), labels (auto / hubs / off), thumbnails (on zoom / always / never), link strength.
- **Focus** – shift-click a node (or "Focus in graph" in the drawer) to show only its neighbourhood (1–3 steps); highlight a topic or tag; find the shortest chain of links between two items.
- **Presets** – save the whole setup under a name and switch between them.
- Hiding link types or focusing never re-runs the layout; the layout always uses every link.

**Acting on items in the graph**
- **Double-click (or right-click) an item** for its menu: *Expand* (opens it), *Link to…*, *Highlight lineage*
  (only when it has arrows), *Unpin* (only when pinned), *Delete* (instant, with a 6-second **Undo**; closing
  the window during those 6 seconds still deletes). A single click waits ~¼ s so it can tell a double-click apart.
- **My links**: *Link to…* makes the item shake; click the item it points to and a one-way arrow A → B is
  saved in the library (it survives Regroup). Clicking the same item or the background, or Esc, cancels. The
  item's window lists *Links to* / *Linked from*, each with × to delete. Toggle arrows under Links → My links.
- **Right-click an arrow**: *Highlight lineage* (everything upstream of A and downstream of B along arrows) or
  *Delete link*. Right-clicking an automatic link explains why it exists.

**Search by tag**: `#ramen #todo broth` = items tagged ramen *and* todo, then text-searched for "broth".
Typing `#` suggests tags; multi-word tags are written `#"spicy food"`. A tag word only filters once it is
finished or picked. Tags themselves can never start with `#` (it is stripped as you type and by the engine,
and old ones are renamed or merged at startup).

**Graph** in the header (key **V**; **G** returns to the grid) draws the library as a network: one dot per item, coloured by
topic, placed where the topic map put it and then relaxed by a force layout.

| | |
|---|---|
| Links | *Similarity*: each item to its closest matches (**Links per item** slider, 1-8), kept only when the match stands out from what is typical for that item, so a loner gets no links instead of its least-bad ones. *Tag*: dashed links between items you gave the same tag by hand (or accepted). Tags worn by more than 10 items are skipped, otherwise "recipes" on 200 items turns the graph into a hairball. |
| Filters | The sidebar filters, search and Meaning toggle apply to the graph exactly as they do to the grid. Clicking a topic in the graph's legend filters to it. |
| Interaction | Hover: thumbnail, title, topic, and the item's neighbours light up. Click: opens the item. Drag a dot: moves and pins it (its menu's *Unpin* releases it, **Unpin all** releases all). Wheel: zoom at the cursor; drag the background: pan; **Fit** or double-click the background: show everything. Past ~2x zoom dots become thumbnails (at most 160 at once). |
| Without models | Only tag links are drawn; the info line says so. |
| Cost | The layout tick is O(n) (repulsion uses a grid): ~7 ms per tick at 3,000 nodes in the unit test, and it stops by itself when settled, so an idle graph uses no CPU. Up to 3,000 items are drawn; beyond that the info line says it is showing the first 3,000. |

| | |
|---|---|
| Capture (upload + thumbnail + index) | median 43 ms, p95 70 ms |
| List all 3,000 cards | 340 ms |
| Full-text search | ~22 ms |
| Cards in the DOM at once | ~11–18 of 3,000 |

Frame time while scrolling was **not** measured (the browser pane was hidden, which pauses animation frames).
Measure it in a normal window with the Performance panel before quoting a number.

## Site support: what was actually verified

| Site | Status |
|---|---|
| Wikipedia | Verified on live pages (Computer vision, India): image filtering and full-size URLs; the section lookup was checked against the live *Cat* article (44 headings in document order, captions found). Whether Chrome actually highlights the text directive is up to the browser and was not checked here. Only the first 24 images of very long articles are offered. |
| Tumblr | Fixture-tested only. Tumblr sits behind a bot check, so its real markup couldn't be inspected; the extractor is deliberately conservative (see table above). If it still grabs junk, send me the post's saved HTML. |
| Blogs / generic | Readability + `og:` fallback, covered by fixture tests. Not yet tried on many real blogs. |
| YouTube | Works in daily use. Description comes from the player data (verified on a live page); if that is unavailable the page's description box is used, which YouTube only renders in full once expanded. |
| X, Instagram, Pinterest | Logic covered by **fixture tests** only (X currently ends up as a screenshot). The selectors are my best reading of each site's DOM and **have not been run against the live sites** (they need a login). Expect to adjust selectors. |

When one breaks: save the page's HTML into a fixture in `tests/js/extract.test.mjs`, fix the selector in
`extension/content/extract.js`, run `npm test` in `tests/js`. If DOM extraction finds no image, the
extension falls back to a screenshot of the tab, so a capture still lands.

Instagram/X playback in the app is best-effort (their embeds need login or can be blocked);
YouTube uses the privacy-enhanced embed. Offline, the original link is the fallback.

## Tests

```bat
.venv\Scripts\python -m pytest tests          :: 38 engine tests (Phase 2 ones use a fake embedder: no models needed)
cd tests\js && npm install && npm test        :: 28 JS tests (extractors + graph layout)
.venv\Scripts\python tests\seed.py http://127.0.0.1:47821 <token> 3000    :: load test
```

## Roadmap

5. **Embeds** polish, resurfacing ("revisit" shelf), auto-update for the Windows app, a 2-D map view of topics (the /api/clusters/map data is already there)
