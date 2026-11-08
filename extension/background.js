// Service worker: right-click menu, image download, multipart upload, offline queue.
// Work lives here (not in the popup) so a capture survives the popup closing mid-save.
import { getConfig, postCapture } from "./api.js";
import * as queue from "./queue.js";
import { extractTab, upgradeImage, locateInTab } from "./extract_tab.js";

const MAX_IMAGES = 8;
const MAX_BYTES = 30 * 1024 * 1024;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "save") {
    handleSave(msg).then(sendResponse).catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
  if (msg?.type === "drain") {
    drainQueue().then(() => queue.count()).then((n) => sendResponse({ queued: n }));
    return true;
  }
});

chrome.alarms.create("drain", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((a) => a.name === "drain" && drainQueue());
chrome.runtime.onStartup.addListener(drainQueue);
chrome.runtime.onInstalled.addListener(() => { setupMenus(); drainQueue(); });

// ------------------------------------------------------------ right-click
function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    const entries = [
      ["aether-image", "Save image to Aether", ["image"]],
      ["aether-selection", "Save selection to Aether", ["selection"]],
      ["aether-link", "Save link to Aether", ["link"]],
      ["aether-page", "Save page to Aether", ["page"]],
    ];
    for (const [id, title, contexts] of entries) chrome.contextMenus.create({ id, title, contexts });
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (tab?.id != null) saveFromMenu(info, tab).catch((e) => toast(tab.id, String(e?.message || e), "bad"));
});

async function saveFromMenu(info, tab) {
  const { token } = await getConfig();
  if (!token) return toast(tab.id, "Click the Aether toolbar icon and paste your token first.", "bad");

  const x = await extractTab(tab);
  const sel = (info.selectionText || "").trim();
  const p = { ...x, tags: [], note: "", screenshot: false };

  switch (info.menuItemId) {
    case "aether-image": {
      const group = info.srcUrl ? await upgradeImage(tab.id, info.srcUrl) : [];
      p.images = group.length ? [group] : [];
      p.text = sel; // an image save never drags the whole article along
      p.autoShot = false;
      if (info.srcUrl) await deepLink(p, tab, { src: info.srcUrl }); // Wikipedia: link to the spot, not the page
      if (x.known_host && !x.adapter && group.length) {
        // A feed or timeline (X home, Pinterest board...): the page URL would merge every image
        // saved from it into one item, so the image becomes its own item and remembers the page.
        p.original_url = group[0];
        p.type = "image";
        p.title = sel || `Image from ${new URL(tab.url).hostname.replace(/^www\./, "")}`;
        p.author = "";
        p.embed = null;
        p.note = `From ${tab.url}`;
      }
      break;
    }
    case "aether-selection":
      p.text = sel || x.text; // the quote itself, not the page around it
      p.images = [];
      p.autoShot = false;
      if (sel) await deepLink(p, tab, { quote: sel });
      break;
    case "aether-link":
      Object.assign(p, { original_url: info.linkUrl, type: "page", title: sel || info.linkUrl, author: "", text: "", images: [], embed: null, autoShot: false });
      break;
    default: // whole page: identical to the popup's defaults
      p.autoShot = true;
  }

  if (!/^https?:\/\//i.test(p.original_url || "")) return toast(tab.id, "Aether can only save web pages.", "bad");
  const res = await handleSave({ tabId: tab.id, payload: p });
  if (res.ok) toast(tab.id, res.duplicate ? "Already in Aether: updated" : "Saved to Aether", "ok");
  else if (res.queued) toast(tab.id, "Aether is offline: queued, it will save when the engine starts", "warn");
  else toast(tab.id, res.error || "Save failed", "bad");
}

// Wikipedia: point the item at the section (and the exact words) it came from.
async function deepLink(p, tab, args) {
  const loc = await locateInTab(tab.id, args);
  if (!loc) return;
  p.original_url = loc.url;
  if (loc.section && p.title && !p.title.includes(" › ")) p.title = `${p.title} › ${loc.section}`;
}

// A small confirmation in the page itself (right-click has no popup to show a result in).
async function toast(tabId, message, kind) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [message, kind],
      func: (msg, k) => {
        const id = "__aether_toast";
        document.getElementById(id)?.remove();
        const el = document.createElement("div");
        el.id = id;
        el.setAttribute("role", "status");
        el.textContent = msg;
        const bg = { ok: "#166534", warn: "#92400e", bad: "#991b1b" }[k] || "#1f2937";
        el.style.cssText = "position:fixed;z-index:2147483647;right:18px;bottom:18px;max-width:340px;padding:10px 14px;" +
          "border-radius:10px;font:13px/1.4 system-ui,sans-serif;color:#fff;box-shadow:0 8px 30px rgba(0,0,0,.35);" +
          `background:${bg};opacity:0;transition:opacity .15s`;
        document.documentElement.appendChild(el);
        setTimeout(() => (el.style.opacity = "1"), 10);
        setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 250); }, 2800);
      },
    });
  } catch { /* pages that can't be scripted just don't get a toast */ }
}

// ---------------------------------------------------------------- saving
async function handleSave({ tabId, payload: p }) {
  const { files, kinds, srcs } = await collectFiles(tabId, p);
  const meta = {
    original_url: p.original_url,
    type: p.type || "page",
    title: p.title || null,
    author: p.author || null,
    text: p.text || null,
    note: p.note || null,
    tags: p.tags || [],
    embed: p.embed || null,
    asset_kinds: kinds,
    asset_srcs: srcs,
    captured_at: Math.floor(Date.now() / 1000),
  };
  return send(meta, files);
}

async function send(meta, files) {
  try {
    const r = await postCapture(meta, files);
    if (r.ok) return { ok: true, ...(await r.json()) };
    if (r.status === 401) return { ok: false, error: "Wrong token. Open the Aether UI → Extension setup and paste it again." };
    if (r.status >= 500) throw new Error(`engine error ${r.status}`);
    return { ok: false, error: `Rejected (${r.status}): ${(await r.text()).slice(0, 160)}` };
  } catch (_e) {
    // engine not running (or crashed): keep the capture and retry later
    await queue.add({ meta, files });
    await updateBadge();
    return { ok: false, queued: true };
  }
}

async function drainQueue() {
  if (drainQueue.busy) return;
  drainQueue.busy = true;
  try {
    for (const entry of await queue.all()) {
      try {
        const r = await postCapture(entry.meta, entry.files);
        if (r.ok || (r.status >= 400 && r.status < 500 && r.status !== 401)) await queue.remove(entry.id);
        else break; // 401 or 5xx: try again next time
      } catch (_e) {
        break; // engine still offline
      }
    }
  } finally {
    drainQueue.busy = false;
    await updateBadge();
  }
}

async function updateBadge() {
  const n = await queue.count().catch(() => 0);
  await chrome.action.setBadgeText({ text: n ? String(n) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#d97706" });
}

// ---------------------------------------------------------------- images
async function collectFiles(tabId, p) {
  const files = [], kinds = [], srcs = [];
  for (const group of (p.images || []).slice(0, MAX_IMAGES)) {
    for (const url of group) {
      const blob = await fetchImage(tabId, url);
      if (blob) {
        files.push({ blob, name: `img${files.length}.${extFor(blob.type)}` });
        kinds.push("image");
        srcs.push(url);
        break;
      }
    }
  }
  // A screenshot is the safety net when image download failed. It is skipped when the user
  // deliberately picked no image (autoShot === false) and for pages that aren't posts/videos/images.
  const wantShot = p.screenshot || (files.length === 0 && p.autoShot !== false && ["video", "post", "image"].includes(p.type));
  if (wantShot && !p.restricted) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 85 });
      files.push({ blob: await (await fetch(dataUrl)).blob(), name: "screenshot.jpg" });
      kinds.push("screenshot");
      srcs.push("");
    } catch (_e) { /* tab not capturable (e.g. not focused) */ }
  }
  return { files, kinds, srcs };
}

const extFor = (type) => ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" }[type] || "img");

// 1) fetch inside the page (right origin + cookies, works for signed CDN URLs)
// 2) fall back to the service worker (host permission bypasses CORS; no page cookies)
async function fetchImage(tabId, url) {
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [url, MAX_BYTES],
      func: async (u, max) => {
        try {
          const r = await fetch(u);
          if (!r.ok) return null;
          const b = await r.blob();
          if (!b.type.startsWith("image/") || b.size > max) return null;
          return await new Promise((res, rej) => {
            const fr = new FileReader();
            fr.onload = () => res(fr.result);
            fr.onerror = rej;
            fr.readAsDataURL(b);
          });
        } catch (_e) { return null; }
      },
    });
    if (result) return await (await fetch(result)).blob();
  } catch (_e) { /* fall through */ }
  try {
    const r = await fetch(url, { credentials: "omit" });
    if (!r.ok) return null;
    const b = await r.blob();
    return b.type.startsWith("image/") && b.size <= MAX_BYTES ? b : null;
  } catch (_e) {
    return null;
  }
}
