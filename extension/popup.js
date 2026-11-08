import { fetchTags, getConfig, health, setConfig } from "./api.js";
import { extractTab } from "./extract_tab.js";

const MAX_PICK = 8;
const $ = (id) => document.getElementById(id);
let extracted = null;
let tabId = null;
let options = []; // [{ group, thumb, label, selected }]
const tags = [];

function say(el, text, cls = "") { el.textContent = text; el.className = "msg " + cls; }

async function init() {
  const cfg = await getConfig();
  if (!cfg.token) return showSetup(cfg);

  $("main").hidden = false;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab.id;

  checkEngine();
  extracted = await extractTab(tab);
  renderPreview();
}

function showSetup(cfg) {
  $("main").hidden = true;
  $("setup").hidden = false;
  $("token").value = cfg.token;
  $("port").value = cfg.port;
}

$("cfgBtn").onclick = async () => showSetup(await getConfig());
$("saveCfg").onclick = async () => {
  await setConfig({ token: $("token").value, port: $("port").value });
  $("setup").hidden = true;
  say($("cfgMsg"), "");
  init();
};

async function checkEngine() {
  try {
    await health();
    $("dot").className = "dot ok";
    $("statusText").textContent = "Engine running";
    fetchTags().then((list) => {
      $("tagOptions").innerHTML = list.map((t) => `<option value="${t.name.replace(/"/g, "&quot;")}">`).join("");
    }).catch(() => {});
  } catch {
    $("dot").className = "dot bad";
    $("statusText").textContent = "Engine offline: saves will be queued";
  }
  const { queued } = await chrome.runtime.sendMessage({ type: "drain" }).catch(() => ({ queued: 0 }));
  $("queued").textContent = queued ? `· ${queued} queued` : "";
}

// ------------------------------------------------------------- preview
function renderPreview() {
  const x = extracted;
  $("title").value = x.title || "";
  $("source").textContent = (() => { try { return new URL(x.original_url).hostname.replace(/^www\./, ""); } catch { return "page"; } })();
  $("sub").textContent = [x.author, x.type].filter(Boolean).join(" · ");

  options = buildOptions(x);
  renderPicker();
  renderTextInfo(x);
  if (x.restricted) say($("msg"), "This page can't be read; only the link will be saved.", "warn");
}

// Pre-selected images first, then the extra candidates. A candidate that is the same picture as a
// pre-selected one (they share a URL) is merged into it instead of being listed twice.
function buildOptions(x) {
  const out = [];
  for (const g of x.images || []) out.push({ group: g, thumb: g[g.length - 1], label: "", selected: true });
  for (const c of x.candidates || []) {
    const same = out.find((o) => o.group.some((u) => c.group.includes(u)));
    if (same) {
      same.thumb = c.thumb || same.thumb;
      same.label = same.label || c.label || "";
      same.link = same.link || c.link;
      same.section = same.section || c.section;
    } else {
      out.push({ group: c.group, thumb: c.thumb || c.group[c.group.length - 1], label: c.label || "", selected: false, link: c.link, section: c.section });
    }
  }
  return out;
}

function renderPicker() {
  $("imgs").hidden = options.length === 0;
  const grid = $("imgGrid");
  grid.textContent = "";
  options.forEach((o, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "opt";
    b.setAttribute("aria-pressed", String(o.selected));
    b.title = o.label || `Image ${i + 1}`;
    const img = document.createElement("img");
    img.src = o.thumb;
    img.alt = o.label || `Image ${i + 1}`;
    img.referrerPolicy = "no-referrer";
    img.onerror = () => { img.style.visibility = "hidden"; };
    const tick = document.createElement("span");
    tick.className = "tick";
    tick.textContent = "✓";
    b.append(img, tick);
    b.onclick = () => toggleOption(i, b);
    grid.append(b);
  });
  updateCount();
}

function toggleOption(i, button) {
  const o = options[i];
  if (!o.selected && options.filter((x) => x.selected).length >= MAX_PICK) {
    say($("msg"), `You can save up to ${MAX_PICK} images.`, "warn");
    return;
  }
  o.selected = !o.selected;
  button.setAttribute("aria-pressed", String(o.selected));
  say($("msg"), "");
  updateCount();
}

function updateCount() {
  const n = options.filter((o) => o.selected).length;
  $("imgCount").textContent = n ? `${n} selected` : "none selected: click to choose";
}

function renderTextInfo(x) {
  const el = $("textInfo");
  if (x.text_source === "selection") el.textContent = `Saving your selected text (${x.selection_chars} characters).`;
  else if (x.text_source === "page") el.textContent = `Saving the page text (${(x.text || "").length} characters). Select text on the page first to save just that.`;
  else el.textContent = "No text selected: saving the title and link only. Select text on the page first to include it.";
}

// ---------------------------------------------------------------- tags
function addTag(raw) {
  for (const part of raw.split(",")) {
    const t = part.trim().replace(/^#/, "").toLowerCase();
    if (t && !tags.includes(t)) tags.push(t);
  }
  drawTags();
}
function drawTags() {
  $("chips").innerHTML = "";
  for (const t of tags) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = t;
    const x = document.createElement("button");
    x.textContent = "×";
    x.setAttribute("aria-label", `Remove tag ${t}`);
    x.onclick = () => { tags.splice(tags.indexOf(t), 1); drawTags(); };
    chip.append(x);
    $("chips").append(chip);
  }
}
$("tagInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === ",") {
    e.preventDefault();
    addTag($("tagInput").value);
    $("tagInput").value = "";
  }
});

// ---------------------------------------------------------------- save
async function save() {
  if (!extracted) return;
  if ($("tagInput").value.trim()) { addTag($("tagInput").value); $("tagInput").value = ""; }
  $("save").disabled = true;
  say($("msg"), "Saving…");
  const picked = options.filter((o) => o.selected);
  const images = picked.map((o) => o.group);
  let title = $("title").value.trim() || extracted.title;
  let original_url = extracted.original_url;
  // Wikipedia: one picture saved -> link to where it sits in the article, not to the top of the page
  if (picked.length === 1 && picked[0].link) {
    original_url = picked[0].link;
    if (picked[0].section && title === extracted.title && !title.includes(" › ")) title = `${title} › ${picked[0].section}`;
  }
  const payload = {
    ...extracted,
    original_url,
    images,
    title,
    tags,
    note: $("note").value.trim(),
    screenshot: $("shot").checked,
    // if the user deliberately unticked every image, don't sneak a screenshot in
    autoShot: images.length > 0 || options.length === 0,
  };
  const res = await chrome.runtime.sendMessage({ type: "save", tabId, payload }).catch((e) => ({ ok: false, error: String(e) }));
  if (res?.ok) {
    say($("msg"), res.duplicate ? (res.new_assets ? "Already saved; added new images." : "Already saved; updated.") : "Saved.", "ok");
    setTimeout(() => window.close(), 900);
  } else if (res?.queued) {
    say($("msg"), "Engine is offline. Saved to the queue; it will upload when Aether starts.", "warn");
    setTimeout(() => window.close(), 1800);
  } else {
    say($("msg"), res?.error || "Save failed.", "bad");
    $("save").disabled = false;
  }
}
$("save").onclick = save;
document.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) save(); });

init();
