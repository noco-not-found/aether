// Talks to the local Aether engine. The token is pasted once and kept in chrome.storage.local.
const DEFAULT_PORT = 47821;

export async function getConfig() {
  const { token = "", port = DEFAULT_PORT } = await chrome.storage.local.get(["token", "port"]);
  return { token: token.trim(), port: Number(port) || DEFAULT_PORT, base: `http://127.0.0.1:${Number(port) || DEFAULT_PORT}` };
}

export async function setConfig({ token, port }) {
  await chrome.storage.local.set({ token: (token || "").trim(), port: Number(port) || DEFAULT_PORT });
}

export async function health() {
  const { base } = await getConfig();
  const r = await fetch(`${base}/api/health`, { cache: "no-store" });
  return r.ok;
}

export async function fetchTags() {
  const { base, token } = await getConfig();
  const r = await fetch(`${base}/api/tags`, { headers: { "X-Aether-Token": token } });
  if (!r.ok) throw new Error(`tags ${r.status}`);
  return r.json();
}

// files: [{blob, name}]; meta.asset_kinds / asset_srcs are parallel to files.
export async function postCapture(meta, files) {
  const { base, token } = await getConfig();
  const fd = new FormData();
  fd.append("meta", JSON.stringify(meta));
  for (const f of files) fd.append("files", f.blob, f.name);
  return fetch(`${base}/api/capture`, { method: "POST", headers: { "X-Aether-Token": token }, body: fd });
}
