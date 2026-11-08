// Theme: "system" (follow Windows), "light" or "dark". Runs in <head> so the right colours paint first.
(() => {
  let t = "system";
  try { t = localStorage.getItem("aether.theme") || "system"; } catch { /* storage off: follow Windows */ }
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
})();
