// Shared by the popup and the right-click menu: run the page extractor inside a tab.

export async function extractTab(tab) {
  try {
    if (/^https?:\/\/([\w-]+\.)*youtube\.com\//.test(tab.url || "")) await exposeYouTubeData(tab.id);
    try { await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["lib/Readability.js"] }); } catch { /* optional */ }
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/extract.js"] });
    const [{ result } = {}] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => window.__aetherExtract() });
    if (result) return result;
  } catch (e) {
    console.warn("extract failed", e);
  }
  // chrome:// pages, the Web Store, PDF viewers etc. can't be scripted: save just the link
  return { original_url: tab.url, title: tab.title || tab.url, type: "page", text: "", text_source: "none", images: [], candidates: [], restricted: true };
}

// YouTube keeps the clean title/channel/description in the player's data, which only the page's own
// JS world can read. Copy it into a DOM attribute (the DOM is shared with the extractor).
async function exposeYouTubeData(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: () => {
        try {
          const pr = document.querySelector("#movie_player")?.getPlayerResponse?.() || window.ytInitialPlayerResponse;
          const d = pr?.videoDetails;
          document.documentElement.setAttribute(
            "data-aether-yt",
            d?.videoId ? JSON.stringify({ videoId: d.videoId, title: d.title || "", author: d.author || "", description: d.shortDescription || "" }) : ""
          );
        } catch { document.documentElement.setAttribute("data-aether-yt", ""); }
      },
    });
  } catch { /* DOM fallback in extract.js */ }
}

// Wikipedia only: { url, section } deep link to the section (and exact words) holding an image or
// a selection, or null elsewhere. The extractor must already be injected (extractTab does that).
export async function locateInTab(tabId, args) {
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [args],
      func: (a) => (window.__aetherLocate ? window.__aetherLocate(a) : null),
    });
    return result && result.url ? result : null;
  } catch { return null; }
}

// [bestUrl, ...fallbacks] for one image URL (full-size Wikimedia / X / Pinterest / Tumblr variants).
export async function upgradeImage(tabId, url) {
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      args: [url],
      func: (u) => (window.__aetherUpgrade ? window.__aetherUpgrade(u) : [u]),
    });
    if (Array.isArray(result) && result.length) return result;
  } catch { /* fall through */ }
  return [url];
}
