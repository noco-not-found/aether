"use strict";
/* Aether web UI: virtualised masonry grid, FTS search, tag filters, detail drawer.
   No build step. Layout is computed from stored thumbnail sizes, so nothing jumps
   when images load, and only cards near the viewport exist in the DOM. */

const TOKEN = document.querySelector('meta[name="aether-token"]').content;
const PORT = document.querySelector('meta[name="aether-port"]').content;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, { method = "GET", body } = {}) {
  const headers = { "X-Aether-Token": TOKEN, "X-Aether-Client": "ui" };   // "ui" keeps the engine out of background mode
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const r = await fetch("/api" + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!r.ok) { const e = new Error(`${method} ${path} -> ${r.status}`); e.status = r.status; throw e; }
  return r.json();
}
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: setting just won't persist */ } },
};

// ------------------------------------------------------------------ state
const state = {
  q: "", tags: new Set(), source: null, items: [], total: 0, selected: new Set(), openId: null, allTags: [],
  meaning: store.get("aether.meaning") === "1", cluster: null,       // cluster: null = all, 0 = unclustered, n = topic id
  sem: null, topics: null,
  view: store.get("aether.view") === "graph" ? "graph" : "grid",
  graph: null,                  // set in the graph section below (settings are remembered)
};
let gv = null;               // the GraphView, created the first time the graph is shown
const byId = new Map();
const nodes = new Map();      // id -> card element currently in the DOM
let layout = [];              // parallel to state.items: {x, y, w, h, imgH}
let loadToken = 0;

// GAP leaves room for the cards' hard offset shadows; META_H includes the 8px frame above the picture (see style.css .thumb)
const GAP = 22, MIN_COL = 250, META_H = 82, TEXT_H = 150, BUFFER = 900;
const grid = $("grid");

// ----------------------------------------------------------------- theme
// "system" follows Windows; "light"/"dark" are pinned (html[data-theme], set first thing by theme.js)
const THEMES = { system: "\u25d0 Auto", light: "\u2600 Light", dark: "\u263e Dark" };
function getTheme() { try { return localStorage.getItem("aether.theme") || "system"; } catch { return "system"; } }
function isDark() { const t = getTheme(); return t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches); }
function applyTheme(t) {
  if (t === "system") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  try { localStorage.setItem("aether.theme", t); } catch { /* not remembered, still applied */ }
  $("themeBtn").textContent = THEMES[t];
  $("themeBtn").setAttribute("aria-label", `Theme: ${t === "system" ? "follow Windows" : t}. Change theme`);
  if (typeof gv !== "undefined" && gv) { gv.readTheme(); gv.kick(); }
}
function cycleTheme() { const order = ["system", "light", "dark"]; applyTheme(order[(order.indexOf(getTheme()) + 1) % 3]); }
$("themeBtn").onclick = cycleTheme;
applyTheme(getTheme());

// --------------------------------------------------------------- loading
/** The search box, split: '#name' (or '#"two words"') words are tag filters, the rest is searched as text. */
const TAG_TOKEN = /(^|\s)#(?:"([^"]+)"|([^\s"#]+))/g;
function queryParts(q = state.q) {
  const tags = [];
  const text = (q || "").replace(TAG_TOKEN, (_, sp, quoted, bare) => { tags.push((quoted || bare).trim().toLowerCase()); return sp; })
    .replace(/(^|\s)#+(?=\s|$)/g, " ").replace(/\s+/g, " ").trim();
  return { text, tags: tags.filter(Boolean) };
}
const unknownTags = () => { const known = new Set((state.allTags || []).map((t) => t.name)); return queryParts().tags.filter((t) => !known.has(t)); };
/** Shared by the grid and the graph: search text, tag filters (sidebar + #tags), source, topic. */
function filterParams() {
  const p = new URLSearchParams(), qp = queryParts();
  if (qp.text) p.set("q", qp.text);
  if (state.source) p.set("source", state.source);
  for (const t of new Set([...state.tags, ...qp.tags])) p.append("tag", t);
  if (state.cluster !== null) p.set("cluster", String(state.cluster));
  if (state.meaning && qp.text) p.set("mode", "meaning");
  return p;
}

async function loadItems() {
  const mine = ++loadToken;
  const params = filterParams();

  let all = [], offset = 0, total = 0;
  for (;;) {
    params.set("limit", "500");
    params.set("offset", String(offset));
    let page;
    try { page = await api("/items?" + params); }
    catch (e) {
      if (e.status === 409 && params.get("mode") === "meaning") {   // models not downloaded: plain search still works
        params.delete("mode"); state.noModels = true; renderBanner(); offset = 0; all = []; continue;
      }
      throw e;
    }
    if (mine !== loadToken) return;            // a newer search superseded this one
    total = page.total;
    all = all.concat(page.items);
    offset += page.items.length;
    if (page.items.length < 500 || all.length >= total) break;
  }
  state.items = all;
  state.total = total;
  byId.clear();
  for (const it of all) byId.set(it.id, it);
  for (const id of [...state.selected]) if (!byId.has(id)) state.selected.delete(id);
  relayout();
  renderChrome();
}

async function loadFacets() {
  const [stats, tags] = await Promise.all([api("/stats"), api("/tags")]);
  state.allTags = tags;
  $("taglist").innerHTML = tags.map((t) => `<option value="${esc(t.name)}">`).join("");
  const srcs = Object.entries(stats.by_source), srcMax = Math.max(1, ...srcs.map(([, n]) => n)), tagMax = Math.max(1, ...tags.map((t) => t.count));
  $("sources").innerHTML = srcs.map(([s, n]) =>
    `<button data-source="${esc(s)}" class="${state.source === s ? "on" : ""}" style="--p:${n / srcMax}"><span>${esc(s)}</span><span class="n">${n}</span></button>`).join("");
  $("tags").innerHTML = tags.slice(0, 80).map((t) =>
    `<button data-tag="${esc(t.name)}" class="${state.tags.has(t.name) ? "on" : ""}" style="--p:${t.count / tagMax}"><span>${esc(t.name)}</span><span class="n">${t.count}</span></button>`).join("");
}

// ---------------------------------------------------------------- layout
function relayout() {
  const W = grid.clientWidth || 800;
  const n = Math.max(1, Math.floor((W + GAP) / (MIN_COL + GAP)));
  const cw = (W - (n - 1) * GAP) / n;
  const colH = new Array(n).fill(0);
  layout = state.items.map((it) => {
    const imgH = it.thumb && it.w ? Math.min(cw * it.h / it.w, cw * 1.9) : 0;
    const h = (imgH || TEXT_H) + META_H;
    let c = 0;
    for (let i = 1; i < n; i++) if (colH[i] < colH[c]) c = i;
    const box = { x: c * (cw + GAP), y: colH[c], w: cw, h, imgH };
    colH[c] += h + GAP;
    return box;
  });
  grid.style.height = Math.max(0, ...colH) + "px";
  for (const el of nodes.values()) el.remove();
  nodes.clear();
  render();
}

let raf = 0;
function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); }

function render() {
  const top = window.scrollY - (grid.getBoundingClientRect().top + window.scrollY) - BUFFER;
  const bottom = top + window.innerHeight + 2 * BUFFER;
  const want = new Set();
  const frag = document.createDocumentFragment();
  for (let i = 0; i < state.items.length; i++) {
    const L = layout[i];
    if (L.y + L.h < top || L.y > bottom) continue;
    const it = state.items[i];
    want.add(it.id);
    if (!nodes.has(it.id)) {
      const el = makeCard(it, L);
      nodes.set(it.id, el);
      frag.appendChild(el);
    }
  }
  for (const [id, el] of nodes) if (!want.has(id)) { el.remove(); nodes.delete(id); }
  grid.appendChild(frag);
}

function makeCard(it, L) {
  const el = document.createElement("div");
  el.className = "card" + (state.selected.has(it.id) ? " sel" : "");
  el.dataset.id = it.id;
  el.tabIndex = 0;
  el.style.cssText = `transform:translate(${L.x}px,${L.y}px);width:${L.w}px;height:${L.h}px`;
  const media = it.thumb
    ? `<div class="thumb" style="height:${L.imgH}px;background:${esc(it.color || "#222")}"><img src="${esc(it.thumb)}" alt="" decoding="async" draggable="false">`
    : `<div class="thumb" style="height:${TEXT_H}px"><div class="textcard">${esc(it.snippet || it.title || it.url)}</div>`;
  const when = new Date(it.created_at * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  const chips = it.tags.filter((t) => t.origin !== "auto").slice(0, 3).map((t) => `<span class="chip">${esc(t.name)}</span>`).join("");
  el.innerHTML = `${media}
      <span class="badge">${esc(it.source)}</span>
      ${it.type === "video" ? '<span class="play">▶</span>' : ""}
      <button class="pick" data-pick title="Select">✓</button></div>
    <div class="meta">
      <div class="title">${esc(it.title || it.url)}</div>
      <div class="sub">${esc([it.author, when].filter(Boolean).join(" · "))}</div>
      <div class="chips-row">${chips}</div>
    </div>`;
  return el;
}

// ------------------------------------------------------------- selection
function toggleSelect(id) {
  state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
  nodes.get(id)?.classList.toggle("sel", state.selected.has(id));
  renderChrome();
}

grid.addEventListener("click", (e) => {
  const card = e.target.closest(".card");
  if (!card) return;
  const id = Number(card.dataset.id);
  if (e.target.closest("[data-pick]") || e.ctrlKey || e.metaKey || e.shiftKey || state.selected.size) toggleSelect(id);
  else openDetail(id);
});
grid.addEventListener("keydown", (e) => {
  const card = e.target.closest(".card");
  if (card && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openDetail(Number(card.dataset.id)); }
});

async function bulk(op) {
  const ids = [...state.selected];
  if (!ids.length) return;
  await api("/items/bulk", { method: "POST", body: { ids, ...op } });
  if (op.delete) state.selected.clear();
  await Promise.all([loadView(), loadFacets()]);
}
const seltag = () => $("seltag").value.trim();
$("seladd").onclick = () => seltag() && bulk({ add_tags: [seltag()] }).then(() => ($("seltag").value = ""));
$("selrem").onclick = () => seltag() && bulk({ remove_tags: [seltag()] }).then(() => ($("seltag").value = ""));
$("seldel").onclick = () => confirm(`Delete ${state.selected.size} item(s)? This cannot be undone.`) && bulk({ delete: true });
$("selclear").onclick = () => { state.selected.clear(); for (const el of nodes.values()) el.classList.remove("sel"); renderChrome(); };

// ---------------------------------------------------------------- chrome
function renderChrome() {
  $("count").textContent = `${state.total} item${state.total === 1 ? "" : "s"}`;
  $("selbar").hidden = state.selected.size === 0;
  $("selcount").textContent = `${state.selected.size} selected`;
  const chips = [...state.tags].map((t) => `<span class="chip">${esc(t)} <button data-untag="${esc(t)}" aria-label="Remove filter">×</button></span>`);
  if (state.source) chips.push(`<span class="chip">source: ${esc(state.source)} <button data-unsource aria-label="Remove filter">×</button></span>`);
  if (state.cluster !== null) {
    chips.push(`<span class="chip">topic: ${esc(topicName(state.cluster))} <button data-untopic aria-label="Remove filter">×</button></span>`);
    if (state.cluster > 0 && state.total > 0)
      chips.push(`<button class="mini ghost" data-promote title="Give every item in this topic a real tag you can edit">Make a tag from this topic</button>`);
  }
  $("active").innerHTML = chips.join("");
  const empty = $("empty");
  empty.hidden = state.total > 0;
  if (state.total === 0) {
    empty.innerHTML = state.q || state.tags.size || state.source || state.cluster !== null
      ? (unknownTags().length ? `No tag called ${unknownTags().map((t) => "\u201c" + esc(t) + "\u201d").join(" or ")}. Check the spelling, or pick one from the list that opens after #.`
        : state.meaning && queryParts().text ? "Nothing close enough in meaning. Try other words, or fewer filters." : "Nothing matches. Try fewer filters.")
      : "Your library is empty.<br>Load the extension (<b>Extension setup</b>, top right) and save something.";
  }
}

document.addEventListener("click", (e) => {
  const t = e.target;
  if (t.closest("[data-source]")) { const s = t.closest("[data-source]").dataset.source; state.source = state.source === s ? null : s; refresh(); }
  else if (t.closest("[data-tag]")) { const g = t.closest("[data-tag]").dataset.tag; state.tags.has(g) ? state.tags.delete(g) : state.tags.add(g); refresh(); }
  else if (t.closest("[data-untag]")) { state.tags.delete(t.closest("[data-untag]").dataset.untag); refresh(); }
  else if (t.closest("[data-unsource]")) { state.source = null; refresh(); }
  else if (t.closest("[data-topic]")) { const c = Number(t.closest("[data-topic]").dataset.topic); state.cluster = state.cluster === c ? null : c; refresh(); }
  else if (t.closest("[data-gotopic]")) { state.cluster = Number(t.closest("[data-gotopic]").dataset.gotopic); closeDetail(); refresh(); }
  else if (t.closest("[data-untopic]")) { state.cluster = null; refresh(); }
  else if (t.closest("[data-promote]")) promoteTopic();
  else if (t.closest("[data-fetch]")) fetchModels(t.closest("[data-fetch]").dataset.fetch === "small");
});
function refresh() { loadView(); loadFacets(); renderTopics(); }

// ------------------------------------------------- meaning, topics, models
const topicName = (id) => id === 0 ? "unsorted" : (state.topics?.clusters.find((c) => c.id === id)?.name ?? "…");

$("meaningBtn").onclick = () => {
  state.meaning = !state.meaning;
  store.set("aether.meaning", state.meaning ? "1" : "0");
  syncMeaningBtn();
  if (state.q) loadView();
};
function syncMeaningBtn() {
  $("meaningBtn").setAttribute("aria-pressed", String(state.meaning));
  $("search").placeholder = state.meaning
    ? "Describe what you're looking for: “a quiet street at night”, “pasta”… #tag filters too   ( / )"
    : "Search, or type #tag to filter by tag   ( / )";
}

function renderTopics() {
  const t = state.topics, st = state.sem;
  const box = $("topics");
  if (!t) { box.innerHTML = ""; return; }
  const cl = t.clusters, top = Math.max(1, t.unclustered || 0, ...cl.map((c) => c.size));
  box.innerHTML = cl.map((c) =>
    `<button data-topic="${c.id}" class="${state.cluster === c.id ? "on" : ""}" style="--p:${c.size / top}" title="${esc(c.keywords.join(", "))}"><span>${esc(c.name)}</span><span class="n">${c.size}</span></button>`).join("")
    + (cl.length && t.unclustered ? `<button data-topic="0" class="${state.cluster === 0 ? "on" : ""}" style="--p:${t.unclustered / top}"><span>unsorted</span><span class="n">${t.unclustered}</span></button>` : "");
  const s = t.state || {};
  let msg = "";
  if (s.state === "running") msg = "Grouping your library…";
  else if (s.state === "failed") msg = "Grouping failed: " + (s.error || "see the engine window");
  else if (!st?.models) msg = "Topics need the models (see the banner above).";
  else if (!cl.length) msg = s.note || ((st?.items ?? 0) < 12 ? "Topics appear once you have 12 items." : "Not grouped yet.");
  else if (t.params?.at) msg = `${cl.length} topics · grouped ${new Date(t.params.at * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;
  $("topicState").textContent = msg;
  $("regroup").disabled = s.state === "running" || !st?.models;
  $("topicsSec").hidden = !st?.models && !cl.length;
  if (t.params && typeof t.params.visual === "number" && document.activeElement !== $("visualMix")) $("visualMix").value = t.params.visual;
}

async function loadTopics() {
  try { state.topics = await api("/clusters"); } catch { return; }
  renderTopics();
  if (state.cluster !== null) renderChrome();
}

$("regroup").onclick = async () => {
  try { await api("/clusters/recompute", { method: "POST", body: { visual: Number($("visualMix").value) } }); }
  catch (e) { $("topicState").textContent = e.status === 409 ? "Download the models first." : "Couldn't start grouping."; return; }
  pollSem(true);
};

async function promoteTopic() {
  const id = state.cluster;
  if (!id) return;
  const name = (prompt(`Tag all ${state.total} items in this topic with:`, topicName(id).replace(/\s*·\s*/g, " ")) || "").trim();
  if (!name) return;
  const r = await api(`/clusters/${id}/tag`, { method: "POST", body: { name } });
  state.cluster = null;
  await Promise.all([loadView(), loadFacets()]);
  renderTopics();
  $("topicState").textContent = `Tagged ${r.tagged} items “${name}”.`;
}

async function fetchModels(small) {
  try { await api("/models/fetch", { method: "POST", body: { small } }); } catch { /* shown by the next status poll */ }
  pollSem(true);
}

function renderBanner() {
  const st = state.sem, b = $("semBanner");
  if (!st) { b.hidden = true; return; }
  const f = st.fetch || {};
  let html = "";
  if (f.state === "running") {
    html = `<b>Downloading the models…</b> <span class="muted">${esc((f.log || []).slice(-1)[0] || "starting")}. You can keep using Aether.</span>`;
  } else if (f.state === "failed") {
    html = `<b>Download failed.</b> <span class="muted">${esc(f.error || "")}</span> <button data-fetch="full">Try again</button> <button class="ghost" data-fetch="small">Smaller models</button>`;
  } else if (!st.models) {
    html = `<b>Search by meaning, related items, topics and tag suggestions</b> need two small AI models that run on this PC (about 700 MB, once).
      <button data-fetch="full">Download</button> <button class="ghost" data-fetch="small" title="About 180 MB, a little less accurate">Smaller (180 MB)</button>`;
  } else if (st.pending > 0) {
    html = `<b>Indexing ${st.pending} item${st.pending === 1 ? "" : "s"} for meaning search…</b> <span class="muted">${st.items - st.pending} of ${st.items} done. Search works meanwhile, on what is indexed so far.</span>`;
  }
  b.hidden = !html;
  if (html && b.innerHTML !== html) b.innerHTML = html;
}

// One adaptive poll: quick while something is happening, lazy otherwise.
let semTimer = 0, lastBusy = { pending: null, cluster: null };
async function pollSem(soon) {
  clearTimeout(semTimer);
  let delay = 20000;
  try {
    state.sem = await api("/embeddings/status");
    const cs = state.sem.clusters?.state;
    const busy = state.sem.fetch?.state === "running" || state.sem.pending > 0 || cs === "running";
    renderBanner();
    // refresh the topic list when indexing or grouping just ended
    if ((lastBusy.pending > 0 && state.sem.pending === 0) || (lastBusy.cluster === "running" && cs !== "running") || !state.topics) {
      await loadTopics();
      if (state.cluster !== null || (lastBusy.cluster === "running" && cs !== "running")) loadView();
    } else renderTopics();
    lastBusy = { pending: state.sem.pending, cluster: cs };
    if (busy) delay = 2500;
  } catch { delay = 15000; }
  semTimer = setTimeout(pollSem, soon ? Math.min(delay, 1200) : delay);
}

let debounce = 0;
$("search").addEventListener("input", (e) => {
  clearTimeout(debounce);
  suggestTags();
  debounce = setTimeout(() => { if (setQuery()) loadView(); }, 150);
});
/** The '#word' still being typed (suggestions open) is not a filter yet; it counts once picked or finished. */
function setQuery() {
  const v = $("search").value, q = ($("tagSug").hidden ? v : v.slice(0, sug.start) + v.slice(sug.end)).trim();
  if (q === state.q) return false;
  state.q = q; return true;
}

// --- '#' in the search box: suggest tags for the word being typed
const sug = { items: [], at: 0, start: 0, end: 0 };
function suggestTags() {
  const box = $("tagSug"), inp = $("search"), caret = inp.selectionStart ?? inp.value.length;
  const before = inp.value.slice(0, caret);
  const m = before.match(/(^|\s)#("?)([^"#]*)$/);
  if (!m || (!m[2] && /\s/.test(m[3]))) { box.hidden = true; return; }
  const typed = m[3].toLowerCase(), used = new Set(queryParts(inp.value).tags);
  const all = (state.allTags || []).filter((t) => !used.has(t.name) || t.name === typed);
  const starts = all.filter((t) => t.name.startsWith(typed)), has = all.filter((t) => !t.name.startsWith(typed) && t.name.includes(typed));
  sug.items = [...starts, ...has].slice(0, 8);
  sug.start = caret - m[3].length - m[2].length - 1;
  const rest = inp.value.slice(caret).match(/^[^\s]*"?/)[0];
  sug.end = caret + rest.length; sug.at = 0;
  if (!sug.items.length) { box.hidden = true; return; }
  box.innerHTML = sug.items.map((t, i) =>
    `<div role="option" class="${i === 0 ? "on" : ""}" data-i="${i}"><span>#${esc(t.name)}</span><b>${t.count}</b></div>`).join("");
  box.style.left = inp.offsetLeft + "px"; box.style.top = inp.offsetTop + inp.offsetHeight + 6 + "px"; box.style.width = inp.offsetWidth + "px";
  box.hidden = false;
}
function pickTag(i) {
  const t = sug.items[i]; if (!t) return;
  const inp = $("search"), word = /\s/.test(t.name) ? `#"${t.name}"` : "#" + t.name;
  inp.value = inp.value.slice(0, sug.start) + word + " " + inp.value.slice(sug.end).replace(/^\s+/, "");
  const at = sug.start + word.length + 1; inp.setSelectionRange(at, at);
  $("tagSug").hidden = true;
  inp.dispatchEvent(new Event("input"));
  $("tagSug").hidden = true;
}
$("search").addEventListener("keydown", (e) => {
  const box = $("tagSug");
  if (box.hidden) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    sug.at = (sug.at + (e.key === "ArrowDown" ? 1 : -1) + sug.items.length) % sug.items.length;
    box.querySelectorAll("[data-i]").forEach((el, i) => el.classList.toggle("on", i === sug.at));
  } else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickTag(sug.at); }
  else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); box.hidden = true; if (setQuery()) loadView(); }
});
$("search").addEventListener("click", suggestTags);
$("search").addEventListener("blur", () => setTimeout(() => { $("tagSug").hidden = true; if (setQuery()) loadView(); }, 120));
$("tagSug").addEventListener("pointerdown", (e) => { const o = e.target.closest("[data-i]"); if (o) { e.preventDefault(); pickTag(Number(o.dataset.i)); } });

// tags never start with '#' ('#' means "tag" in search): strip it while typing in any tag box
document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.id !== "seltag" && el.id !== "dTagIn") return;
  const clean = el.value.replace(/^[#\s]+/, "").replace(/,\s*#+/g, ", ");
  if (clean !== el.value) el.value = clean;
});

window.addEventListener("scroll", schedule, { passive: true });
new ResizeObserver(() => { if (state.view === "grid" && state.items.length) relayout(); }).observe(grid);

// ------------------------------------------------------------------ graph
// Settings that change which links exist are sent to the server (and reload the graph); the rest are
// applied to the canvas instantly. Everything is remembered, and can be saved under a name as a preset.
const GRAPH_DEFAULTS = { k: 4, z: 3, visual: 0.5, simOn: true, tagOn: true, manOn: true, linkTags: null,
  size: "degree", color: "topic", labels: "auto", thumbs: "zoom", edgeAlpha: 1, hops: 1 };
const LOOK_KEYS = ["size", "color", "labels", "thumbs", "edgeAlpha"];
state.graph = (() => { try { return { ...GRAPH_DEFAULTS, ...JSON.parse(store.get("aether.graph") || "{}") }; } catch { return { ...GRAPH_DEFAULTS }; } })();
state.gData = null; state.gPath = { state: "off" };

const loadView = () => (state.view === "graph" ? loadGraph() : loadItems());

function applyView() {
  $("viewGrid").setAttribute("aria-pressed", String(state.view === "grid"));
  $("viewGraph").setAttribute("aria-pressed", String(state.view === "graph"));
  $("grid").hidden = state.view !== "grid";
  $("graphBox").hidden = state.view !== "graph";
}
function setView(v) {
  if (v === state.view) return;
  state.view = v;
  store.set("aether.view", v);
  applyView();
  loadView();
}
$("viewGrid").onclick = () => setView("grid");
$("viewGraph").onclick = () => setView("graph");

const readPresets = () => { try { return JSON.parse(store.get("aether.graph.presets") || "{}"); } catch { return {}; } };
const saveGraph = () => store.set("aether.graph", JSON.stringify(state.graph));
let gDebounce = 0;
const gReload = () => { clearTimeout(gDebounce); gDebounce = setTimeout(loadGraph, 200); };

function markCustom() { $("gPreset").value = ""; $("gPresetDel").disabled = true; }
function changed(reload) { saveGraph(); markCustom(); if (reload) gReload(); else applyLook(); }
function lookOpts() { const g = state.graph; return { size: g.size, color: g.color, labels: g.labels, thumbs: g.thumbs, edgeAlpha: g.edgeAlpha, simOn: g.simOn, tagOn: g.tagOn, manOn: g.manOn }; }
function applyLook() { gv?.setOpts(lookOpts()); renderLegend(); }

function syncGraphControls() {
  const g = state.graph;
  $("gSim").checked = g.simOn; $("gTags").checked = g.tagOn; $("gMan").checked = g.manOn;
  $("gK").value = g.k; $("gKv").textContent = g.k; $("gZ").value = g.z; $("gMix").value = g.visual;
  $("gSize").value = g.size; $("gColor").value = g.color; $("gLabels").value = g.labels; $("gThumbs").value = g.thumbs;
  $("gEdge").value = g.edgeAlpha; $("gHops").value = String(g.hops);
}

// --- links
$("gSim").onchange = (e) => { state.graph.simOn = e.target.checked; changed(false); };
$("gTags").onchange = (e) => { state.graph.tagOn = e.target.checked; changed(false); };
$("gMan").onchange = (e) => { state.graph.manOn = e.target.checked; changed(false); };
$("gK").oninput = (e) => { state.graph.k = Number(e.target.value); $("gKv").textContent = e.target.value; changed(true); };
$("gZ").oninput = (e) => { state.graph.z = Number(e.target.value); changed(true); };
$("gMix").oninput = (e) => { state.graph.visual = Number(e.target.value); changed(true); };
$("gTagAll").onclick = () => { state.graph.linkTags = null; renderTagList(); changed(true); };
$("gTagNone").onclick = () => { state.graph.linkTags = []; renderTagList(); changed(true); };
$("gTagList").onchange = () => {
  const boxes = [...$("gTagList").querySelectorAll("input")];
  const on = boxes.filter((b) => b.checked).map((b) => b.value);
  state.graph.linkTags = on.length === boxes.length ? null : on;
  changed(true);
};
function renderTagList() {
  const names = state.gData?.tag_names || [], sel = state.graph.linkTags;
  $("gTagList").innerHTML = names.length
    ? names.map((t) => `<label><input type="checkbox" value="${esc(t.name)}" ${sel === null || sel.includes(t.name) ? "checked" : ""}> <span>${esc(t.name)}</span> <span class="muted">${t.count}</span></label>`).join("")
    : '<span class="muted small">No tag is worn by 2 to 10 of the items shown.</span>';
}

// --- look
for (const [id, key] of [["gSize", "size"], ["gColor", "color"], ["gLabels", "labels"], ["gThumbs", "thumbs"]])
  $(id).onchange = (e) => { state.graph[key] = e.target.value; changed(false); };
$("gEdge").oninput = (e) => { state.graph.edgeAlpha = Number(e.target.value); changed(false); };
$("gLookReset").onclick = () => { for (const k of LOOK_KEYS) state.graph[k] = GRAPH_DEFAULTS[k]; syncGraphControls(); changed(false); };

// --- focus, highlight, path
function focusOn(id) {
  if (!gv || !gv.byId?.has(id)) return;
  gv.setFocus(id, state.graph.hops);
  renderGStatus();
}
$("gHops").onchange = (e) => {
  state.graph.hops = Number(e.target.value); saveGraph();
  const id = gv?.focusedId(); if (id != null) { gv.setFocus(id, state.graph.hops); renderGStatus(); }
};
$("gFocusClear").onclick = () => { gv?.setFocus(null); renderGStatus(); };
function buildHighlightOptions() {
  const sel = $("gHl"), keep = sel.value;
  const topics = (state.gData?.clusters || []).map((c) => `<option value="t:${c.id}">${esc(c.name)}</option>`).join("");
  const tags = (state.allTags || []).slice(0, 60).map((t) => `<option value="g:${esc(t.name)}">${esc(t.name)}</option>`).join("");
  sel.innerHTML = '<option value="">Nothing</option>' + (topics ? `<optgroup label="Topic">${topics}</optgroup>` : "") + (tags ? `<optgroup label="Tag">${tags}</optgroup>` : "");
  sel.value = [...sel.options].some((o) => o.value === keep) ? keep : "";
  applyHighlight();
}
function applyHighlight() {
  const v = $("gHl").value;
  if (!v) return gv?.setHighlight(null);
  const [kind, rest] = [v[0], v.slice(2)];
  gv?.setHighlight(kind === "t" ? (n) => n.cluster === Number(rest) : (n) => n.tags.includes(rest));
}
$("gHl").onchange = applyHighlight;
$("gPath").onclick = () => { if (state.gPath.state === "off") gv?.startPath(); else gv?.clearPath(); };

function renderGStatus() {
  const box = $("gStatus"), P = state.gPath, parts = [];
  const fid = gv?.focusedId();
  $("gFocusClear").disabled = fid == null;
  if (fid != null) {
    const meta = gv.data.nodes[gv.focus];
    parts.push(`<span class="chip">Focus: ${esc(meta.title)} \u00b7 ${gv.vis.size} item${gv.vis.size === 1 ? "" : "s"} within ${gv.hops} step${gv.hops === 1 ? "" : "s"} <button data-gfocus-clear aria-label="Show everything">\u00d7</button></span>`);
  }
  if (P.state !== "off") {
    let msg;
    if (P.state === "first") msg = "Path: click the first item.";
    else if (P.state === "second") msg = `Path from \u201c${esc(P.from)}\u201d: click the second item.`;
    else if (P.state === "found") msg = `Path, ${P.titles.length - 1} step${P.titles.length === 2 ? "" : "s"}: ` + P.titles.map(esc).join(" \u2192 ");
    else msg = `Nothing links \u201c${esc(P.from)}\u201d to \u201c${esc(P.to)}\u201d with the current links. Try more links per item or a looser match.`;
    parts.push(`<span class="chip path">${msg} <button data-gpath-clear aria-label="Stop">\u00d7</button></span>`);
  }
  if (state.linking) parts.push(`<span class="chip linking">Linking from \u201c${esc(state.linking)}\u201d: click the item it points to. Esc cancels. <button data-glink-clear aria-label="Cancel linking">\u00d7</button></span>`);
  if (state.lineage) parts.push(`<span class="chip path">${esc(state.lineage)} <button data-glineage-clear aria-label="Stop highlighting">\u00d7</button></span>`);
  box.hidden = !parts.length;
  box.innerHTML = parts.join(" ");
  $("gPath").textContent = P.state === "off" ? "Find a path between two items" : "Stop path finding";
}
$("gStatus").addEventListener("click", (e) => {
  if (e.target.closest("[data-gfocus-clear]")) $("gFocusClear").click();
  else if (e.target.closest("[data-gpath-clear]")) gv?.clearPath();
  else if (e.target.closest("[data-glink-clear]")) cancelLink();
  else if (e.target.closest("[data-glineage-clear]")) clearLineage();
});

// --- node and link menus (double-click / right-click on the canvas)
function closeMenu() { const m = $("gCtx"); if (m.hidden) return false; m.hidden = true; m.innerHTML = ""; return true; }
function openMenu(html, cx, cy, onAct) {
  const m = $("gCtx"), r = $("graphWrap").getBoundingClientRect();
  m.innerHTML = html; m.hidden = false;
  const x = Math.min(cx - r.left + 8, r.width - m.offsetWidth - 10), y = Math.min(cy - r.top + 8, r.height - m.offsetHeight - 10);
  m.style.left = Math.max(6, x) + "px"; m.style.top = Math.max(6, y) + "px";
  m.onclick = (e) => { const b = e.target.closest("[data-act]"); if (b) { closeMenu(); onAct(b.dataset.act); } };
  m.querySelector("button")?.focus({ preventScroll: true });
}
document.addEventListener("pointerdown", (e) => { if (!$("gCtx").hidden && !$("gCtx").contains(e.target)) closeMenu(); }, true);
$("graphWrap").addEventListener("wheel", closeMenu, { passive: true });
$("gCtx").addEventListener("keydown", (e) => {
  const bs = [...$("gCtx").querySelectorAll("button")], i = bs.indexOf(document.activeElement);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); bs[(i + (e.key === "ArrowDown" ? 1 : -1) + bs.length) % bs.length]?.focus(); }
});

function nodeMenu(id, cx, cy) {
  if (!gv) return;
  gv.cancelLink(); state.linking = null;
  const n = gv.data.nodes[gv.byId.get(id)], a = gv.arrows(id);
  const arrows = a.out + a.inn;
  openMenu(`<div class="gctx-title">${esc(n.title)}</div>
    <button data-act="expand">Expand</button>
    <button data-act="link">Link to\u2026</button>
    ${arrows ? `<button data-act="lineage">Highlight lineage <span class="muted">${a.inn} in \u00b7 ${a.out} out</span></button>` : ""}
    ${gv.isPinned(id) ? '<button data-act="unpin">Unpin</button>' : ""}
    <button data-act="delete" class="bad">Delete</button>`, cx, cy, (act) => {
    if (act === "expand") openDetail(id);
    else if (act === "link") { gv.startLink(id); state.linking = n.title; state.gPath = { state: "off" }; renderGStatus(); }
    else if (act === "lineage") showLineage({ node: id }, `Lineage of \u201c${n.title}\u201d`);
    else if (act === "unpin") gv.unpin(id);
    else if (act === "delete") deleteLater(id, n.title);
  });
}

function linkMenu(l, cx, cy) {
  if (l.kind === "man") {
    openMenu(`<div class="gctx-title">${esc(l.from)} \u2192 ${esc(l.to)}</div>
      <button data-act="lineage">Highlight lineage</button>
      <button data-act="unlink" class="bad">Delete link</button>`, cx, cy, (act) => {
      if (act === "lineage") showLineage({ src: l.src, dst: l.dst }, `Lineage through \u201c${l.from}\u201d \u2192 \u201c${l.to}\u201d`);
      else removeLink(l.src, l.dst);
    });
  } else {
    const why = l.kind === "tag" ? `Both tagged \u201c${esc(l.tag || "")}\u201d.` : `Similar items (match ${Math.round(l.w * 100)}%).`;
    openMenu(`<div class="gctx-title">Automatic link</div><p class="gctx-note">${why} Change these from the Links menu. Only your own arrows can be deleted.</p>`, cx, cy, () => {});
  }
}

function showLineage(spec, label) {
  const n = gv.setLineage(spec);
  state.lineage = `${label}: ${n} item${n === 1 ? "" : "s"}`;
  renderGStatus();
}
function clearLineage() { if (!state.lineage) return false; gv?.setLineage(null); state.lineage = null; renderGStatus(); return true; }
function cancelLink() { const was = gv?.cancelLink() || !!state.linking; state.linking = null; renderGStatus(); return was; }

async function makeLink(src, dst) {
  state.linking = null; renderGStatus();
  if (src == null) return;                       // cancelled (clicked the same item or the background)
  try {
    const r = await api("/links", { method: "POST", body: { src, dst } });
    gv?.addManual(src, dst); updateGInfo();
    toast(r.created ? "Linked." : "Those two were already linked.");
    if (state.openId === src || state.openId === dst) openDetail(state.openId);
  } catch { toast("Couldn't save that link."); }
}
async function removeLink(src, dst) {
  try { await api(`/links?src=${src}&dst=${dst}`, { method: "DELETE" }); } catch (e) { if (e.status !== 404) { toast("Couldn't delete that link."); return; } }
  gv?.removeManual(src, dst); updateGInfo();
  if (state.lineage) { gv?.setLineage(null); state.lineage = null; renderGStatus(); }
  if (state.openId === src || state.openId === dst) openDetail(state.openId);
  toast("Link deleted.");
}

// --- delete with undo: the item disappears at once and is really deleted 6 s later
let pendingDel = null;
function deleteLater(id, title) {
  flushDelete();
  if (state.openId === id) closeDetail();
  gv?.setGone([id]);
  pendingDel = { id, t: setTimeout(flushDelete, 6000) };
  toast(`Deleted \u201c${title}\u201d.`, { action: "Undo", ms: 6000, onAction: () => {
    if (!pendingDel || pendingDel.id !== id) return;
    clearTimeout(pendingDel.t); pendingDel = null; gv?.setGone([]);
  } });
}
async function flushDelete() {
  const p = pendingDel; if (!p) return;
  pendingDel = null; clearTimeout(p.t);
  try { await api("/items/" + p.id, { method: "DELETE" }); } catch { /* already gone */ }
  if (state.view === "graph") { loadFacets(); state.total = Math.max(0, state.total - 1); renderChrome(); updateGInfo(); } else refresh();
}
// closing the window during the undo period still deletes (keepalive survives the page)
window.addEventListener("pagehide", () => {
  if (pendingDel) fetch("/api/items/" + pendingDel.id, { method: "DELETE", keepalive: true, headers: { "X-Aether-Token": TOKEN } });
});

let toastT = 0;
function toast(msg, { action, onAction, ms = 2600 } = {}) {
  const t = $("toast");
  clearTimeout(toastT);
  t.innerHTML = `<span>${esc(msg)}</span>` + (action ? `<button class="mini">${esc(action)}</button>` : "");
  t.hidden = false;
  if (action) t.querySelector("button").onclick = () => { onAction?.(); t.hidden = true; };
  toastT = setTimeout(() => (t.hidden = true), ms);
}

function updateGInfo() {
  const g = state.gData; if (!g || !gv) return;
  const notes = [];
  if (!g.models) notes.push("similarity links need the models");
  else if (g.vectors < g.nodes.length) notes.push(`${g.nodes.length - g.vectors} still being indexed`);
  if (g.truncated) notes.push("showing the first " + g.nodes.length);
  const shown = g.nodes.length - gv.gone.size, arrows = gv.manualCount();
  $("gInfo").textContent = `${shown} items \u00b7 ${g.similar.length} similarity \u00b7 ${g.tagged.length} tag links` +
    (arrows ? ` \u00b7 ${arrows} arrow${arrows === 1 ? "" : "s"}` : "") + (notes.length ? " \u00b7 " + notes.join(" \u00b7 ") : "");
}

$("gFit").onclick = () => gv?.fit();
$("gUnpin").onclick = () => gv?.unpinAll();

// --- presets
function renderPresets(selected = "") {
  const names = Object.keys(readPresets()).sort((a, b) => a.localeCompare(b));
  $("gPreset").innerHTML = '<option value="">Custom</option>' + names.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join("");
  $("gPreset").value = names.includes(selected) ? selected : "";
  $("gPresetDel").disabled = !$("gPreset").value;
}
$("gPresetSave").onclick = () => {
  const name = (prompt("Name this graph setup:", $("gPreset").value || "") || "").trim().slice(0, 40);
  if (!name) return;
  const all = readPresets();
  all[name] = { ...state.graph };
  store.set("aether.graph.presets", JSON.stringify(all));
  renderPresets(name);
};
$("gPreset").onchange = (e) => {
  const p = readPresets()[e.target.value];
  $("gPresetDel").disabled = !p;
  if (!p) return;
  state.graph = { ...GRAPH_DEFAULTS, ...p };
  saveGraph(); syncGraphControls(); applyLook(); gReload();
};
$("gPresetDel").onclick = () => {
  const name = $("gPreset").value;
  if (!name || !confirm(`Delete the preset \u201c${name}\u201d?`)) return;
  const all = readPresets(); delete all[name];
  store.set("aether.graph.presets", JSON.stringify(all));
  renderPresets();
};

// --- popover menus: one open at a time, closed by a click elsewhere or Esc
const menus = [...document.querySelectorAll("details.gmenu")];
for (const m of menus) m.addEventListener("toggle", () => { if (m.open) for (const o of menus) if (o !== m) o.open = false; });
document.addEventListener("click", (e) => { for (const m of menus) if (m.open && !m.contains(e.target)) m.open = false; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") for (const m of menus) m.open = false; });

// --- legend (what the colours mean); topics double as a filter
function renderLegend() {
  const box = $("gLegend"), cats = gv ? gv.categories() : [];
  box.hidden = !cats.length;
  const what = { topic: "Topics", source: "Sources", type: "Types" }[state.graph.color];
  box.innerHTML = `<summary>${what} (${cats.length})</summary>` + cats.map((c) =>
    `<${c.topic ? 'button data-topic="' + c.key + '" title="Show only this topic"' : "div class=\"legrow\""}><i style="background:hsl(${c.hue},68%,60%)"></i><span>${esc(c.label)}</span></${c.topic ? "button" : "div"}>`).join("");
}

async function loadGraph() {
  const mine = ++loadToken;
  const g0 = state.graph, p = filterParams();
  p.set("k", String(g0.k)); p.set("visual", String(g0.visual)); p.set("z", String(g0.z));
  const none = Array.isArray(g0.linkTags) && g0.linkTags.length === 0;
  p.set("tag_links", String(!none));
  if (Array.isArray(g0.linkTags)) for (const t of g0.linkTags) p.append("link_tag", t);
  let g;
  try { g = await api("/graph?" + p); } catch { $("gInfo").textContent = "Couldn't load the graph."; return; }
  if (mine !== loadToken) return;
  state.total = g.nodes.length;
  state.gData = g;
  if (!gv) gv = new GraphView($("graphWrap"), {
    open: (id) => openDetail(id),
    focus: (id) => focusOn(id),
    path: (info) => { state.gPath = info; renderGStatus(); },
    menu: (id, x, y) => nodeMenu(id, x, y),
    link: (src, dst) => makeLink(src, dst),
    linkMenu: (info, x, y) => linkMenu(info, x, y),
    tip: (n, links) => `${n.thumb ? `<img src="${esc(n.thumb)}" alt="">` : ""}<b>${esc(n.title)}</b>
      <span class="muted small">${esc(n.source)} \u00b7 ${links} link${links === 1 ? "" : "s"}${n.cluster !== null ? " \u00b7 " + esc(topicName(n.cluster)) : ""}</span>`,
  });
  gv.setOpts(lookOpts());
  gv.setData(g);
  gv.setOpen(state.openId);
  state.linking = null;
  if (state.lineage) { gv.setLineage(null); state.lineage = null; }
  renderLegend(); renderTagList(); buildHighlightOptions(); renderGStatus();
  updateGInfo();
  renderChrome();
}

syncGraphControls();
renderPresets();

// ---------------------------------------------------------------- detail
function embedHTML(emb, url) {
  if (!emb) return "";
  if (!navigator.onLine) return `<p class="muted">Playback needs an internet connection. <a href="${esc(url)}" target="_blank" rel="noopener">Open original</a></p>`;
  const id = encodeURIComponent(emb.id).replace(/%2F/g, "/");
  if (emb.provider === "youtube")
    return `<iframe src="https://www.youtube-nocookie.com/embed/${id}?rel=0" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture"></iframe>`;
  if (emb.provider === "instagram")
    return `<iframe class="tall" src="https://www.instagram.com/${id}/embed" loading="lazy" allowfullscreen></iframe>`;
  if (emb.provider === "x") return `<div id="xembed" class="muted">Loading post…</div>`;
  return "";
}

function mountXEmbed(tweetId) {
  const go = () => window.twttr.widgets.createTweet(tweetId, $("xembed"), { theme: isDark() ? "dark" : "light" })
    .then((el) => { if (!el) $("xembed").textContent = "This post can't be embedded. Use “Open original”."; });
  if (window.twttr?.widgets) return go();
  const s = document.createElement("script");
  s.src = "https://platform.twitter.com/widgets.js"; s.async = true; s.onload = go;
  s.onerror = () => { const x = $("xembed"); if (x) x.textContent = "Couldn't reach X. Use “Open original”."; };
  document.head.appendChild(s);
}

async function openDetail(id) {
  state.openId = id;
  gv?.setOpen(id);
  const d = $("detail");
  d.hidden = false;
  d.innerHTML = '<p class="muted">Loading…</p>';
  let it;
  try { it = await api("/items/" + id); } catch { d.innerHTML = "<p>Couldn't load this item.</p>"; return; }
  if (state.openId !== id) return;
  const when = new Date(it.created_at * 1000).toLocaleString();
  const hasEmbed = !!it.embed;
  d.innerHTML = `
    <div class="bar">
      <span class="muted">${esc(it.source)} · ${esc(it.type)} · ${esc(when)}</span>
      <button class="ghost" id="dClose" title="Close (Esc)">Close</button>
    </div>
    <h2><a class="titlelink" href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.title || it.url)}</a></h2>
    ${it.author ? `<div class="muted">${esc(it.author)}</div>` : ""}
    <div class="row">
      <a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer"><button>Open original ↗</button></a>
      ${hasEmbed ? '<button class="ghost" id="dPlay">▶ Play in app</button>' : ""}
      ${state.view === "graph" ? '<button class="ghost" id="dFocus" title="Show only this item and what is linked to it">Focus in graph</button>' : ""}
      <button class="danger" id="dDelete">Delete</button>
    </div>
    <div class="embed" id="dEmbed"></div>
    ${it.assets.map((a) => `<img class="hero" src="${esc(a.url)}" alt="" loading="lazy" style="aspect-ratio:${a.w}/${a.h}">
        ${a.ocr_text ? `<div class="ocr"><b>Text in image:</b> ${esc(a.ocr_text.slice(0, 400))}</div>` : ""}`).join("")}
    ${it.text ? `<div class="body">${esc(it.text.slice(0, 20000))}</div>` : ""}
    ${it.cluster ? `<div class="topicrow"><span class="muted">Topic</span> <button class="chip linkchip" data-gotopic="${it.cluster.id}" title="Show everything in this topic">${esc(it.cluster.name)}</button></div>` : ""}
    ${it.links_to?.length || it.linked_from?.length ? `<h4>My links</h4><div id="dLinks" class="dlinks">
      ${[["Links to", "to", it.links_to], ["Linked from", "from", it.linked_from]].filter((r) => r[2]?.length).map(([label, dir, list]) =>
        `<div class="lrow"><span class="muted">${label}</span>${list.map((x) =>
          `<span class="chip linkchip"><button class="lnk" data-open="${x.id}">${dir === "to" ? "\u2192" : "\u2190"} ${esc(x.title)}</button><button data-unlink="${dir}:${x.id}" aria-label="Delete this link" title="Delete this link">\u00d7</button></span>`).join("")}</div>`).join("")}
    </div>` : ""}
    <h4>Tags</h4>
    <div id="dTags"></div>
    <div id="dSuggest" class="suggest" hidden></div>
    <input id="dTagIn" list="taglist" placeholder="Add tag, press Enter" autocomplete="off">
    <h4>Note</h4>
    <textarea id="dNote" placeholder="Why did you save this?">${esc(it.note || "")}</textarea>
    <div id="dRelatedBox" hidden><h4>Related</h4><div id="dRelated" class="related"></div></div>`;

  const drawTags = () => {
    $("dTags").innerHTML = it.tags.map((t) =>
      `<span class="chip ${t.origin === "auto" ? "auto" : ""}">${esc(t.name)} <button data-rm="${esc(t.name)}" aria-label="Remove tag ${esc(t.name)}">×</button></span>`).join("") || '<span class="muted">No tags yet</span>';
  };
  drawTags();

  // Suggestions and related items come from the models; the drawer works without them.
  const drawSuggest = async () => {
    if (!state.sem?.models) return;
    let r; try { r = await api(`/items/${id}/suggest-tags`); } catch { return; }
    if (state.openId !== id || !$("dSuggest")) return;
    const box = $("dSuggest");
    box.hidden = !r.tags.length;
    box.innerHTML = r.tags.length
      ? `<span class="muted small">Suggested:</span> ` + r.tags.map((t) =>
        `<button class="chip sug" data-sug="${esc(t.name)}" title="Worn by ${t.support ?? "several"} similar items">+ ${esc(t.name)}</button>`).join("")
      : "";
  };
  const drawRelated = async () => {
    if (!state.sem?.models) return;
    let r; try { r = await api(`/items/${id}/related?limit=12`); } catch { return; }
    if (state.openId !== id || !$("dRelated")) return;
    $("dRelatedBox").hidden = !r.items.length;
    $("dRelated").innerHTML = r.items.map((x) => x.thumb
      ? `<button class="rel" data-open="${x.id}" title="${esc(x.title || "")}"><img src="${esc(x.thumb)}" alt="" loading="lazy" decoding="async"></button>`
      : `<button class="rel txt" data-open="${x.id}" title="${esc(x.title || "")}"><span>${esc((x.title || x.snippet || "").slice(0, 70))}</span></button>`).join("");
  };
  drawSuggest(); drawRelated();
  $("dSuggest").onclick = (e) => { const b = e.target.closest("[data-sug]"); if (b) patch({ add_tags: [b.dataset.sug] }); };
  $("dRelated").onclick = (e) => { const b = e.target.closest("[data-open]"); if (b) openDetail(Number(b.dataset.open)); };

  const patch = async (body) => {
    it = await api("/items/" + id, { method: "PATCH", body });
    drawTags();
    if (body.add_tags || body.remove_tags) drawSuggest();
    const card = byId.get(id);
    if (card) { card.tags = it.tags; nodes.get(id)?.remove(); nodes.delete(id); render(); }
    loadFacets();
  };
  $("dClose").onclick = closeDetail;
  if ($("dFocus")) $("dFocus").onclick = () => focusOn(id);
  if ($("dLinks")) $("dLinks").onclick = (e) => {
    const o = e.target.closest("[data-open]"), u = e.target.closest("[data-unlink]");
    if (u) { const [dir, other] = u.dataset.unlink.split(":"); const o2 = Number(other); dir === "to" ? removeLink(id, o2) : removeLink(o2, id); }
    else if (o) openDetail(Number(o.dataset.open));
  };
  $("dTags").onclick = (e) => { const b = e.target.closest("[data-rm]"); if (b) patch({ remove_tags: [b.dataset.rm] }); };
  $("dTagIn").onkeydown = (e) => {
    if (e.key !== "Enter") return;
    const v = e.target.value.trim();
    if (v) patch({ add_tags: v.split(",") }).then(() => (e.target.value = ""));
  };
  $("dNote").onblur = (e) => { if (e.target.value !== (it.note || "")) patch({ note: e.target.value }); };
  $("dDelete").onclick = async () => {
    if (!confirm("Delete this item? This cannot be undone.")) return;
    await api("/items/" + id, { method: "DELETE" });
    closeDetail();
    refresh();
  };
  if (hasEmbed) $("dPlay").onclick = () => {
    $("dEmbed").innerHTML = embedHTML(it.embed, it.url);
    if (it.embed.provider === "x") mountXEmbed(it.embed.id);
  };
}

function closeDetail() { state.openId = null; gv?.setOpen(null); $("detail").hidden = true; $("detail").innerHTML = ""; }

function step(dir) {
  if (state.view !== "grid") return;
  const i = state.items.findIndex((x) => x.id === state.openId);
  const next = state.items[i + dir];
  if (next) openDetail(next.id);
}

// -------------------------------------------------------------- shortcuts
const typing = () => /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (closeMenu() || cancelLink() || clearLineage()) return;
    if (document.activeElement === $("search")) $("search").blur();
    else if (!$("detail").hidden) closeDetail();
    else if (state.selected.size) $("selclear").click();
  } else if (e.key === "/" && !typing()) { e.preventDefault(); $("search").focus(); }
  else if ((e.key === "t" || e.key === "T") && !typing() && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); cycleTheme(); }
  else if ((e.key === "r" || e.key === "R") && !typing() && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); reload(); }
  else if ((e.key === "g" || e.key === "G" || e.key === "v" || e.key === "V") && !typing() && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault(); setView(e.key.toLowerCase() === "v" ? "graph" : "grid");
  }
  else if ((e.key === "m" || e.key === "M") && !typing() && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); $("meaningBtn").click(); }
  else if (!typing() && !$("detail").hidden && e.key === "ArrowRight") step(1);
  else if (!typing() && !$("detail").hidden && e.key === "ArrowLeft") step(-1);
});

// ---------------------------------------------------------------- refresh
// The library only changes when something is saved from the extension, so the grid is not
// live-updated (cards jumping under the cursor is worse than a click). Instead the button
// reloads on demand, and a cheap /stats poll lights it up when something new has arrived.
let known = { items: null, assets: null };

function markNew(items, assets) {
  const btn = $("refreshBtn");
  const dItems = Math.max(0, items), dAssets = Math.max(0, assets);
  btn.classList.toggle("has-new", dItems > 0 || dAssets > 0);
  $("refreshLabel").textContent = dItems > 0 ? `Refresh · +${dItems} new` : dAssets > 0 ? "Refresh · updated" : "Refresh";
}

async function checkNew() {
  if (document.hidden || known.items === null) return;
  try {
    const s = await api("/stats");
    markNew(s.items - known.items, s.assets - known.assets);
  } catch { /* engine stopped: the next poll will pick it up again */ }
}

async function reload() {
  const btn = $("refreshBtn");
  if (btn.disabled) return;
  btn.disabled = true;
  btn.classList.add("busy");
  try {
    // counts first, so anything saved while the lists load still lights the button afterwards
    const s = await api("/stats");
    known = { items: s.items, assets: s.assets };
    await Promise.all([loadView(), loadFacets()]);
    markNew(0, 0);
    // pick up newly added images, unless a video is playing in the drawer
    if (state.openId && byId.has(state.openId) && !$("detail").querySelector("iframe")) openDetail(state.openId);
  } catch {
    $("refreshLabel").textContent = "Can't reach the engine";
    setTimeout(() => markNew(0, 0), 3000);
  } finally {
    btn.classList.remove("busy");
    btn.disabled = false;
  }
}
$("refreshBtn").onclick = reload;
setInterval(checkNew, 15000);
window.addEventListener("focus", checkNew);
document.addEventListener("visibilitychange", checkNew);

// ------------------------------------------------------------------ setup
$("tokenBox").textContent = TOKEN;
$("setupBtn").onclick = () => $("setup").showModal();

// ------------------------------------------------------- the installed app
// While this window is visible, tell the engine every 30 s; without it, the app's engine goes into
// background mode after 90 s (keeps saving captures, pauses heavy work, frees the models).
setInterval(() => { if (document.visibilityState === "visible") api("/presence", { method: "POST" }).catch(() => {}); }, 30000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") api("/presence", { method: "POST" }).catch(() => {}); });

api("/app").then((a) => {
  $("extPath").textContent = a.extension_dir;
  if (!a.packaged) return;
  $("setupBtn").textContent = "Settings";
  $("setup").querySelector("h2").textContent = "Settings";
  $("openExt").hidden = false; $("appOpts").hidden = false;
  $("appVer").textContent = "Version " + a.version;
  $("optLogin").checked = a.start_at_login;
  $("optLogin").onchange = async (e) => {
    try { e.target.checked = (await api("/app", { method: "POST", body: { start_at_login: e.target.checked } })).start_at_login; }
    catch { e.target.checked = !e.target.checked; toast("Couldn't change that setting."); }
  };
  $("openExt").onclick = () => api("/app/open", { method: "POST", body: { what: "extension" } }).catch(() => {});
  $("openData").onclick = () => api("/app/open", { method: "POST", body: { what: "data" } }).catch(() => {});
  $("quitApp").hidden = !a.can_quit;
  $("quitApp").onclick = async () => {
    if (!confirm("Quit Aether completely? The extension can't save until you open Aether again.")) return;
    await api("/app/quit", { method: "POST" }).catch(() => {});
    if (window.pywebview?.api?.close) window.pywebview.api.close();
    else document.body.innerHTML = '<div class="empty" style="margin:40px">Aether has quit. Open it again from the Start menu.</div>';
  };
}).catch(() => {});
$("copyToken").onclick = async () => {
  try { await navigator.clipboard.writeText(TOKEN); $("copyToken").textContent = "Copied"; }
  catch { const r = document.createRange(); r.selectNodeContents($("tokenBox")); getSelection().removeAllRanges(); getSelection().addRange(r); }
};

syncMeaningBtn();
applyView();
pollSem();
reload();
