"use strict";
/* Canvas view of the item network (layout lives in graphsim.js). One canvas, redrawn only while
   something moves, so an idle graph costs nothing.

   Mouse:  wheel = zoom at the cursor        drag background = pan
           drag a node = move and pin it     double-click background = fit
           click = open the item (after a short wait, so a double-click isn't also a click)
           double-click / right-click a node = its menu (handlers.menu)
           drag a picture's corner = resize that picture (handlers.resized(id, scale) to remember it)
           right-click a link = the link's menu (handlers.linkMenu)
           click a link = select it, Shift/Ctrl+click = add or remove it (handlers.linkSel(count))
           shift-click = focus on its neighbourhood
   Link mode (startLink): the source node shakes; clicking another node calls handlers.link(src, dst),
   clicking the same node or the background calls handlers.link(null) (cancelled).
   Everything else (look, links, focus, highlight, path) is set from outside through setOpts / setFocus /
   setHighlight / startPath, so the toolbar in app.js stays plain DOM and this file stays plain canvas.

   The layout is always computed from ALL links; hiding a link type or focusing only changes what is
   drawn, so nodes don't jump around when you flip a switch. */
(function (root) {
  const MAX_THUMBS = 160, IMG_CACHE = 500;
  const DEFAULTS = { size: "degree", color: "topic", labels: "auto", thumbs: "zoom", edgeAlpha: 1, imgSize: 1, simOn: true, tagOn: true, manOn: true };
  const CORNER = 9;                 // px around a picture's corner that grab it for resizing
  const MIN_SCALE = 0.4, MAX_SCALE = 8, MAX_SIDE = 640;
  const CLICK_WAIT = 240;           // ms a click waits to see whether it becomes a double-click
  const calm = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  class GraphView {
    constructor(wrap, handlers) {
      this.wrap = wrap;
      this.h = handlers;                // { open, tip, focus, path, menu(id,x,y), link(src,dst), linkMenu(info,x,y) }
      this.cv = wrap.querySelector("canvas");
      this.ctx = this.cv.getContext("2d");
      this.tip = wrap.querySelector(".gtip");
      this.cam = { x: 0, y: 0, k: 1 };
      this.o = { ...DEFAULTS };
      this.sim = null; this.data = null; this.hover = -1; this.openId = null; this.drag = null;
      this.focus = -1; this.hops = 1; this.hl = null; this.pathMode = false; this.pathPick = []; this.path = null; this.vis = null;
      this.adj = []; this.deg = []; this.vl = []; this.out = []; this.inn = [];
      this.linkFrom = -1; this.mouse = null; this.clickT = 0; this.lineageSpec = null; this.lineage = null;
      this.goneIds = new Set(); this.gone = new Set();
      this.sizes = new Map();          // item id -> its own picture scale (dragged by the corner)
      this.selLinks = new Set();       // selected link objects (from sim.links)
      this.hoverLink = null;
      this.rects = [];                 // pictures drawn last frame, in draw order: [i, x, y, side]
      this.order = null;               // draw order: resized pictures last, so they sit on top
      this.imgs = new Map(); this.raf = 0; this.fitted = false; this.d = 1;
      this.readTheme();
      matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { this.readTheme(); this.kick(); });
      new ResizeObserver(() => this.resize()).observe(wrap);
      this.bind();
    }

    readTheme() {
      const s = getComputedStyle(document.documentElement);
      const v = (n, d) => s.getPropertyValue(n).trim() || d;
      this.col = { line: v("--line", "#9fb3cf"), accent: v("--accent", "#2f4fd1"), text: v("--text", "#1d2540"),
        ink: v("--ink", "#1d2540"), face: v("--face", "#fbfdff"), tag: v("--pink", "#f2a9d8") };
      this.font = v("--px", "system-ui");
    }

    // ---------------------------------------------------------- colour
    static hue(c) { return c === null || c === undefined ? null : (c * 137.508 + 20) % 360; }
    static catHue(i) { return (i * 137.508 + 200) % 360; }
    /** The categories the current colouring distinguishes: [{key, label, hue|null}] (for the legend). */
    categories() {
      if (!this.data) return [];
      if (this.o.color === "topic") return this.data.clusters.map((c) => ({ key: c.id, label: c.name, hue: GraphView.hue(c.id), topic: true }));
      const field = this.o.color;                       // "source" | "type"
      return this.cats(field).map((v, i) => ({ key: v, label: v, hue: GraphView.catHue(i) }));
    }
    cats(field) { return [...new Set(this.data.nodes.map((n) => n[field]))].sort(); }
    hueOf(i) {
      const m = this.data.nodes[i];
      if (this.o.color === "topic") return GraphView.hue(m.cluster);
      return GraphView.catHue(this.catIndex.get(m[this.o.color]) ?? 0);
    }
    color(i, a = 1) { const h = this.hueOf(i); return h === null ? `hsla(220,10%,62%,${a})` : `hsla(${h},62%,66%,${a})`; }

    // ---------------------------------------------------------- data
    setData(data) {
      const keepFocus = this.focus >= 0 ? this.data?.nodes[this.focus]?.id : null;
      this.data = data;
      this.byId = new Map(data.nodes.map((n, i) => [n.id, i]));
      data.manual = data.manual || [];
      const links = data.similar.map(([a, b, w]) => [a, b, w, "sim"]).concat(data.tagged.map(([a, b]) => [a, b, 0.5, "tag"]))
        .concat(data.manual.map(([a, b]) => [a, b, 0.8, "man"]));
      this.sim = root.AetherSim.create({ nodes: data.nodes, links });
      data.tagged.forEach((t, k) => { this.sim.links[data.similar.length + k].tag = t[2]; });    // the tag a tag-link stands for
      this.selLinks = new Set(); this.hoverLink = null;
      this.focus = keepFocus !== null && keepFocus !== undefined ? (this.byId.get(keepFocus) ?? -1) : -1;
      this.pathPick = []; this.path = null; this.hover = -1; this.fitted = false; this.hideTip();
      this.order = null;
      this.linkFrom = -1; this.gone = new Set([...this.goneIds].map((id) => this.byId.get(id)).filter((i) => i !== undefined));
      this.refreshCategories();
      this.rebuild();
      for (let i = 0; i < 90; i++) this.sim.tick();        // most of the way before the first paint, so it doesn't visibly explode
      this.fit(false);
      this.kick();
    }
    refreshCategories() {
      this.catIndex = new Map();
      if (this.o.color !== "topic" && this.data) this.cats(this.o.color).forEach((v, i) => this.catIndex.set(v, i));
      const t = this.data?.nodes.map((n) => n.created_at || 0) || [];
      const order = [...t.keys()].sort((a, b) => t[a] - t[b]);
      this.recency = new Array(t.length);
      order.forEach((idx, r) => { this.recency[idx] = t.length > 1 ? r / (t.length - 1) : 1; });
    }

    /** Visible links -> adjacency, degree, focus neighbourhood, path. Cheap enough to redo on every switch. */
    rebuild() {
      if (!this.sim) return;
      const n = this.sim.nodes.length;
      this.vl = this.sim.links.filter((l) => (l.kind === "tag" ? this.o.tagOn : l.kind === "man" ? this.o.manOn : this.o.simOn)
        && !this.gone.has(l.a) && !this.gone.has(l.b));
      this.adj = Array.from({ length: n }, () => new Set());
      this.out = Array.from({ length: n }, () => new Set()); this.inn = Array.from({ length: n }, () => new Set());
      for (const l of this.vl) {
        this.adj[l.a].add(l.b); this.adj[l.b].add(l.a);
        if (l.kind === "man") { this.out[l.a].add(l.b); this.inn[l.b].add(l.a); }
      }
      this.deg = this.adj.map((s) => s.size);
      this.vis = this.focus >= 0 ? this.within(this.focus, this.hops) : null;
      if (this.vis && this.hover >= 0 && !this.vis.has(this.hover)) this.hover = -1;
      this.path = this.pathPick.length === 2 ? this.findPath(this.pathPick[0], this.pathPick[1]) : null;
      this.lineage = this.lineageSpec ? this.computeLineage(this.lineageSpec) : null;
      const drawn = new Set(this.vl);
      const before = this.selLinks.size;
      for (const l of [...this.selLinks]) if (!drawn.has(l)) this.selLinks.delete(l);
      if (this.selLinks.size !== before) this.h.linkSel?.(this.selLinks.size);
      this.kick();
    }
    /** Everything upstream and downstream along your arrows: of a node, or through one arrow a -> b. */
    computeLineage(spec) {
      const a = this.byId.get(spec.src ?? spec.node), b = this.byId.get(spec.dst ?? spec.node);
      if (a === undefined || b === undefined) return null;
      const walk = (start, next) => {
        const seen = new Set([start]), q = [start];
        for (let h = 0; h < q.length; h++) for (const v of next[q[h]]) if (!seen.has(v)) { seen.add(v); q.push(v); }
        return seen;
      };
      const up = walk(a, this.inn), down = walk(b, this.out);   // both include their start
      const nodes = new Set([...up, ...down]), edges = new Set();
      for (const l of this.vl) {
        if (l.kind !== "man") continue;
        if ((up.has(l.a) && up.has(l.b)) || (down.has(l.a) && down.has(l.b)) || (l.a === a && l.b === b)) edges.add(l.a + ">" + l.b);
      }
      return { nodes, edges };
    }
    within(start, hops) {
      const seen = new Map([[start, 0]]), q = [start];
      for (let h = 0; h < q.length; h++) {
        const u = q[h], d = seen.get(u);
        if (d >= hops) continue;
        for (const v of this.adj[u]) if (!seen.has(v)) { seen.set(v, d + 1); q.push(v); }
      }
      return new Set(seen.keys());
    }
    findPath(a, b) {
      const prev = new Map([[a, -1]]), q = [a];
      for (let h = 0; h < q.length && !prev.has(b); h++) for (const v of this.adj[q[h]]) if (!prev.has(v)) { prev.set(v, q[h]); q.push(v); }
      if (!prev.has(b)) return { nodes: [], edges: new Set(), found: false };
      const nodes = [];
      for (let c = b; c !== -1; c = prev.get(c)) nodes.push(c);
      nodes.reverse();
      const edges = new Set();
      for (let i = 1; i < nodes.length; i++) edges.add(Math.min(nodes[i - 1], nodes[i]) + "-" + Math.max(nodes[i - 1], nodes[i]));
      return { nodes, edges, found: true };
    }

    // ------------------------------------------------- public controls
    setOpts(o) {
      const colourChanged = o.color !== undefined && o.color !== this.o.color;
      const linksChanged = ["simOn", "tagOn", "manOn"].some((k) => o[k] !== undefined && o[k] !== this.o[k]);
      Object.assign(this.o, o);
      if (colourChanged) this.refreshCategories();
      if (linksChanged) this.rebuild();
      this.kick();
    }
    setFocus(id, hops = this.hops) {
      this.hops = hops;
      this.focus = id === null || id === undefined ? -1 : (this.byId?.get(id) ?? -1);
      this.rebuild();
      this.fit();
      return this.focus >= 0;
    }
    setHighlight(fn) { this.hl = fn || null; this.kick(); }
    startPath() { this.pathMode = true; this.pathPick = []; this.path = null; this.emitPath(); this.kick(); }
    clearPath() { this.pathMode = false; this.pathPick = []; this.path = null; this.emitPath(); this.kick(); }
    emitPath() {
      const t = (i) => this.data.nodes[i].title;
      const p = this.pathPick;
      this.h.path?.(!this.pathMode && !p.length ? { state: "off" }
        : p.length < 2 ? { state: p.length ? "second" : "first", from: p.length ? t(p[0]) : null }
        : { state: this.path.found ? "found" : "none", titles: this.path.nodes.map(t), from: t(p[0]), to: t(p[1]) });
    }
    // --- hand-drawn links, lineage, pending deletes (called by app.js)
    startLink(id) { const i = this.byId?.get(id); if (i === undefined) return false; this.clearPath(); this.linkFrom = i; this.kick(); return true; }
    cancelLink() { if (this.linkFrom < 0) return false; this.linkFrom = -1; this.kick(); return true; }
    addManual(src, dst) {
      const a = this.byId.get(src), b = this.byId.get(dst);
      if (a === undefined || b === undefined || this.sim.links.some((l) => l.kind === "man" && l.a === a && l.b === b)) return;
      this.data.manual.push([a, b]);
      this.sim.links.push({ a, b, w: 0.8, kind: "man" }); this.sim.nodes[a].deg++; this.sim.nodes[b].deg++;
      this.sim.reheat(0.15); this.rebuild();
    }
    removeManual(src, dst) {
      const a = this.byId?.get(src), b = this.byId?.get(dst);
      const k = this.sim?.links.findIndex((l) => l.kind === "man" && l.a === a && l.b === b) ?? -1;
      if (k < 0) return;
      this.sim.links.splice(k, 1); this.sim.nodes[a].deg--; this.sim.nodes[b].deg--;
      this.data.manual = this.data.manual.filter(([x, y]) => !(x === a && y === b));
      this.rebuild();
    }
    // --- selecting and deleting links
    linkInfo(l) {
      const n = this.data.nodes;
      return { kind: l.kind, src: n[l.a].id, dst: n[l.b].id, tag: l.tag || null, w: l.w, from: n[l.a].title, to: n[l.b].title };
    }
    findLink(info) {
      const a = this.byId?.get(info.src), b = this.byId?.get(info.dst);
      return this.sim?.links.find((l) => l.kind === info.kind && (l.tag || null) === (info.tag || null) &&
        ((l.a === a && l.b === b) || (l.kind !== "man" && l.a === b && l.b === a)));
    }
    selectedLinks() { return [...this.selLinks].map((l) => this.linkInfo(l)); }
    isSelected(info) { const l = this.findLink(info); return !!l && this.selLinks.has(l); }
    clearLinkSel() { if (!this.selLinks.size) return false; this.selLinks.clear(); this.kick(); this.h.linkSel?.(0); return true; }
    /** Take links out of the drawing (after the engine deleted them). No re-layout: nothing jumps. */
    removeLinks(infos) {
      const gone = new Set(infos.map((i) => this.findLink(i)).filter(Boolean));
      if (!gone.size) return;
      for (const l of gone) { this.sim.nodes[l.a].deg--; this.sim.nodes[l.b].deg--; this.selLinks.delete(l); }
      const keep = this.sim.links.filter((l) => !gone.has(l));
      this.sim.links.length = 0; this.sim.links.push(...keep);            // the sim holds this array: change it in place
      const has = (kind, a, b, tag) => [...gone].some((l) => l.kind === kind && l.a === a && l.b === b && (tag === undefined || l.tag === tag));
      this.data.similar = this.data.similar.filter(([a, b]) => !has("sim", a, b));
      this.data.tagged = this.data.tagged.filter(([a, b, t]) => !has("tag", a, b, t));
      this.data.manual = this.data.manual.filter(([a, b]) => !has("man", a, b));
      this.h.linkSel?.(this.selLinks.size);
      this.rebuild();
    }
    /** Put links back (undo). */
    restoreLinks(infos) {
      for (const i of infos) {
        const a = this.byId.get(i.src), b = this.byId.get(i.dst);
        if (a === undefined || b === undefined || this.findLink(i)) continue;
        const l = { a, b, w: i.w ?? (i.kind === "man" ? 0.8 : 0.5), kind: i.kind };
        if (i.tag) l.tag = i.tag;
        this.sim.links.push(l); this.sim.nodes[a].deg++; this.sim.nodes[b].deg++;
        if (i.kind === "sim") this.data.similar.push([a, b, l.w]);
        else if (i.kind === "tag") this.data.tagged.push([a, b, i.tag]);
        else this.data.manual.push([a, b]);
      }
      this.rebuild();
    }
    arrows(id) { const i = this.byId?.get(id); return i === undefined ? { out: 0, inn: 0 } : { out: this.out[i].size, inn: this.inn[i].size }; }
    manualCount() { return this.sim ? this.sim.links.filter((l) => l.kind === "man").length : 0; }
    setLineage(spec) { this.lineageSpec = spec || null; this.rebuild(); return this.lineage ? this.lineage.nodes.size : 0; }
    setGone(ids) {
      this.goneIds = new Set(ids);
      this.gone = new Set([...this.goneIds].map((id) => this.byId?.get(id)).filter((i) => i !== undefined));
      if (this.gone.has(this.hover)) { this.hover = -1; this.hideTip(); }
      this.rebuild();
    }
    /** Per-picture sizes, as {id: scale}. Resized pictures show at any zoom and sit on top. */
    setSizes(obj) { this.sizes = new Map(Object.entries(obj || {}).map(([k, v]) => [Number(k), Number(v)])); this.order = null; this.kick(); }
    resetSize(id) { this.sizes.delete(id); this.order = null; this.kick(); this.h.resized?.(id, null); }
    hasSize(id) { return this.sizes.has(id); }
    isPinned(id) { const i = this.byId?.get(id); return i !== undefined && !!this.sim.nodes[i].pinned; }
    unpin(id) { const i = this.byId?.get(id); if (i !== undefined) { this.sim.nodes[i].pinned = false; this.sim.reheat(0.3); this.kick(); } }
    unpinAll() { for (const n of this.sim?.nodes || []) n.pinned = false; this.sim?.reheat(0.5); this.kick(); }
    setOpen(id) { this.openId = id; this.kick(); }
    focusedId() { return this.focus >= 0 ? this.data.nodes[this.focus].id : null; }

    fit(animate = true) {
      if (!this.sim) return;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const n of this.sim.nodes) {
        if (this.vis && !this.vis.has(n.i)) continue;
        x0 = Math.min(x0, n.x); x1 = Math.max(x1, n.x); y0 = Math.min(y0, n.y); y1 = Math.max(y1, n.y);
      }
      if (x0 === Infinity) { x0 = y0 = -1; x1 = y1 = 1; }
      const w = this.cv.clientWidth || 800, h = this.cv.clientHeight || 600, pad = 60;
      const k = Math.min((w - 2 * pad) / Math.max(x1 - x0, 1), (h - 2 * pad) / Math.max(y1 - y0, 1), 3);
      this.cam = { k: Math.max(k, 0.05), x: w / 2 - ((x0 + x1) / 2) * k, y: h / 2 - ((y0 + y1) / 2) * k };
      this.kick();
    }

    // -------------------------------------------------------- render
    resize() {
      const r = this.wrap.getBoundingClientRect(), d = Math.min(devicePixelRatio || 1, 2);
      this.cv.width = Math.max(1, Math.round(r.width * d)); this.cv.height = Math.max(1, Math.round(r.height * d));
      this.d = d;
      if (this.sim && !this.fitted) this.fit(false);
      this.kick();
    }
    kick() { if (!this.raf) this.raf = requestAnimationFrame(() => this.frame()); }
    frame() {
      this.raf = 0;
      if (this.wrap.offsetParent === null) return;                 // hidden: nothing to draw
      if (this.sim && !this.sim.settled()) { this.sim.tick(); this.sim.tick(); }
      this.draw();
      if ((this.sim && !this.sim.settled()) || (this.linkFrom >= 0 && !calm())) this.kick();   // the shake needs frames
      else if (!this.fitted && this.sim) { this.fitted = true; this.fit(false); }
    }
    toScreen(n) { return [n.x * this.cam.k + this.cam.x, n.y * this.cam.k + this.cam.y]; }
    shown(i) { return (!this.vis || this.vis.has(i)) && !this.gone.has(i); }
    radius(n) {
      const base = this.o.size === "same" ? 6 : this.o.size === "recent" ? 3.5 + 8 * (this.recency[n.i] ?? 0) : Math.min(4 + 1.6 * Math.sqrt(this.deg[n.i] || 0), 11);
      return base * Math.min(Math.max(Math.sqrt(this.cam.k), 0.7), 2.2);
    }
    /** 1 = normal, <1 = faded, depending on hover / path / highlight. */
    fade(i) {
      if (this.lineage) return this.lineage.nodes.has(i) ? 1 : 0.12;
      if (this.path || (this.pathPick.length === 1)) {
        const on = this.path ? this.path.nodes.includes(i) : this.pathPick[0] === i;
        return on ? 1 : 0.12;
      }
      let f = 1;
      if (this.hover >= 0 && i !== this.hover && !this.adj[this.hover].has(i)) f = 0.15;
      if (this.hl && !this.hl(this.data.nodes[i])) f = Math.min(f, 0.14);
      return f;
    }

    draw() {
      const { ctx, cv, cam, sim } = this, d = this.d || 1, o = this.o;
      ctx.setTransform(d, 0, 0, d, 0, 0);
      ctx.clearRect(0, 0, cv.width, cv.height);
      if (!sim) return;
      const W = cv.width / d, H = cv.height / d, nodes = sim.nodes, hv = this.hover, ea = o.edgeAlpha;
      const pathing = !!this.path, lin = this.lineage;

      ctx.lineCap = "butt";
      for (const l of this.vl) {
        if (!this.shown(l.a) || !this.shown(l.b)) continue;
        const [x1, y1] = this.toScreen(nodes[l.a]), [x2, y2] = this.toScreen(nodes[l.b]);
        if ((x1 < 0 && x2 < 0) || (y1 < 0 && y2 < 0) || (x1 > W && x2 > W) || (y1 > H && y2 > H)) continue;
        const lit = hv >= 0 && (l.a === hv || l.b === hv);
        const onPath = pathing && this.path.edges.has(Math.min(l.a, l.b) + "-" + Math.max(l.a, l.b));
        const onLin = lin && lin.edges.has(l.a + ">" + l.b);
        const dimmed = (hv >= 0 && !lit) || (pathing && !onPath) || (lin && !onLin) || (this.hl && Math.min(this.fade(l.a), this.fade(l.b)) < 1);
        const sel = this.selLinks.has(l), hot = l === this.hoverLink;
        if (sel || hot) {        // selected: a thick outline behind the link, in the page colour, then the link in accent
          ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.strokeStyle = this.col.face; ctx.lineWidth = sel ? 9 : 7;
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
          ctx.strokeStyle = sel ? this.col.accent : this.col.ink; ctx.lineWidth = sel ? 4 : 3;
          if (l.kind === "tag" && !sel) ctx.setLineDash([5, 4]);
          if (l.kind === "man") { this.arrow(x1, y1, x2, y2, nodes[l.b], sel ? this.col.accent : this.col.ink, 1, sel ? 4 : 3.2); continue; }
          ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); ctx.setLineDash([]);
          continue;
        }
        if (l.kind === "man") { this.arrow(x1, y1, x2, y2, nodes[l.b], onLin || onPath ? this.col.accent : this.col.ink, dimmed ? 0.1 : Math.min(1, 0.95 * Math.max(ea, 0.6)), lit || onLin ? 3.2 : 2.4); continue; }
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
        if (onPath) { ctx.setLineDash([]); ctx.strokeStyle = this.col.accent; ctx.globalAlpha = 1; ctx.lineWidth = 3.5; }
        else if (l.kind === "tag") { ctx.setLineDash([5, 4]); ctx.strokeStyle = this.col.accent; ctx.globalAlpha = Math.min(1, (lit ? 0.95 : dimmed ? 0.08 : 0.55) * ea); ctx.lineWidth = lit ? 2.5 : 1.5; }
        else { ctx.setLineDash([]); ctx.strokeStyle = lit ? this.col.ink : this.col.line; ctx.globalAlpha = Math.min(1, (lit ? 0.9 : dimmed ? 0.06 : 0.35 + 0.5 * Math.max(0, l.w - 0.3)) * ea); ctx.lineWidth = lit ? 2 : 1.2; }
        ctx.stroke();
      }
      ctx.setLineDash([]); ctx.globalAlpha = 1;
      if (this.linkFrom >= 0 && this.mouse && this.shown(this.linkFrom)) {     // rubber band from the shaking node
        const [sx, sy] = this.toScreen(nodes[this.linkFrom]);
        ctx.setLineDash([6, 5]); ctx.strokeStyle = this.col.accent; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(this.mouse[0], this.mouse[1]); ctx.stroke(); ctx.setLineDash([]);
      }

      const thumbs = o.thumbs === "always" || (o.thumbs === "zoom" && cam.k >= 2.2);
      if (!this.order) {
        const own = (n) => this.sizes.has(this.data.nodes[n.i].id);
        this.order = nodes.filter((n) => !own(n)).concat(nodes.filter(own).sort((a, b) => this.picScale(a) - this.picScale(b)));
      }
      let drawn = 0;
      this.rects = [];
      for (const n of this.order) {
        if (!this.shown(n.i)) continue;
        let [x, y] = this.toScreen(n);
        if (n.i === this.linkFrom && !calm()) { const t = performance.now() / 32; x += Math.sin(t) * 2.6; y += Math.cos(t * 1.3) * 1.2; }
        const r = this.radius(n);
        const meta = this.data.nodes[n.i], own = this.sizes.has(meta.id);
        const s = own || thumbs ? this.picSide(n) : 0, pad = Math.max(30, s / 2);
        if (x < -pad || y < -pad || x > W + pad || y > H + pad) continue;
        const f = this.fade(n.i);
        ctx.globalAlpha = f;
        let showed = false;
        // a picture you resized always shows (unless pictures are off): it is a landmark you chose
        if (meta.thumb && o.thumbs !== "never" && (own || (thumbs && drawn < MAX_THUMBS)) && (f > 0.5 || own)) {
          const img = this.image(meta.thumb);
          if (img?.complete && img.naturalWidth) {
            ctx.save(); ctx.beginPath(); ctx.rect(x - s / 2, y - s / 2, s, s); ctx.clip();
            const q = Math.min(img.naturalWidth, img.naturalHeight), sx = (img.naturalWidth - q) / 2, sy = (img.naturalHeight - q) / 2;
            ctx.drawImage(img, sx, sy, q, q, x - s / 2, y - s / 2, s, s); ctx.restore();
            ctx.lineWidth = 2; ctx.strokeStyle = this.col.ink; ctx.strokeRect(x - s / 2, y - s / 2, s, s);
            ctx.fillStyle = this.color(n.i); ctx.fillRect(x - s / 2, y + s / 2 - 4, s, 4);
            if (n.i === hv || this.drag?.resize === n.i) this.handles(x, y, s);
            this.rects.push([n.i, x, y, s]);
            showed = true; if (!own) drawn++;
          }
        }
        if (!showed) {
          const s = Math.round(r * 1.8), q = Math.round(x - s / 2) + 0.5, w = Math.round(y - s / 2) + 0.5;
          if (s >= 9) { ctx.fillStyle = this.col.ink; ctx.fillRect(q + 2, w + 2, s, s); }
          ctx.fillStyle = this.color(n.i); ctx.fillRect(q, w, s, s);
          ctx.lineWidth = 1.5; ctx.strokeStyle = this.col.ink; ctx.strokeRect(q, w, s, s);
          if (n.pinned) { ctx.fillStyle = this.col.ink; ctx.fillRect(q - 1, w - 1, Math.max(4, s / 3), Math.max(4, s / 3)); }
        }
        const picked = this.pathPick.includes(n.i);
        const linking = n.i === this.linkFrom;
        if (meta.id === this.openId || n.i === hv || n.i === this.focus || picked || linking) {
          ctx.lineWidth = n.i === this.focus || picked || linking ? 3 : 2.5; ctx.strokeStyle = n.i === this.focus || picked || linking ? this.col.accent : this.col.text;
          if (linking) ctx.setLineDash([4, 3]);
          const m = (showed ? s : Math.round(r * 1.8)) / 2 + 5;      // around the picture when one is drawn
          ctx.strokeRect(Math.round(x - m) + 0.5, Math.round(y - m) + 0.5, 2 * m, 2 * m);
          ctx.setLineDash([]);
        }
      }
      ctx.globalAlpha = 1;
      this.drawLabels(W, H);
    }

    /** Picture side in screen px: node size x the Image size setting x this picture's own scale. */
    picScale(n) { return this.sizes.get(this.data.nodes[n.i].id) ?? 1; }
    picSide(n) { return Math.min(MAX_SIDE, Math.max(26, this.radius(n) * 3.2) * (this.o.imgSize || 1) * this.picScale(n)); }
    /** Four inked corner squares: the "you can drag me" signal. */
    handles(x, y, s) {
      const { ctx } = this, h = 7;
      for (const [cx, cy] of [[x - s / 2, y - s / 2], [x + s / 2, y - s / 2], [x - s / 2, y + s / 2], [x + s / 2, y + s / 2]]) {
        ctx.fillStyle = this.col.face; ctx.fillRect(cx - h / 2 - 1, cy - h / 2 - 1, h + 2, h + 2);
        ctx.fillStyle = this.col.ink; ctx.fillRect(cx - h / 2, cy - h / 2, h, h);
      }
    }
    /** The picture corner under the pointer: { i, sx, sy } (sx/sy = which corner, -1 or 1) or null. Topmost first. */
    corner(mx, my) {
      for (let k = this.rects.length - 1; k >= 0; k--) {
        const [i, x, y, s] = this.rects[k];
        const sx = mx < x ? -1 : 1, sy = my < y ? -1 : 1;
        if (Math.abs(mx - (x + sx * s / 2)) <= CORNER && Math.abs(my - (y + sy * s / 2)) <= CORNER) return { i, sx, sy };
        if (Math.abs(mx - x) < s / 2 && Math.abs(my - y) < s / 2) return null;     // inside a picture on top: not a corner below it
      }
      return null;
    }

    /** A one-way link: a solid line that stops at the edge of the target square, then a solid head. */
    arrow(x1, y1, x2, y2, target, colour, alpha, width) {
      const { ctx } = this, dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
      if (len < 1) return;
      const ux = dx / len, uy = dy / len, half = Math.round(this.radius(target) * 1.8) / 2 + 3;
      const stop = half / Math.max(Math.abs(ux), Math.abs(uy), 0.2), head = Math.min(11, len / 3);
      const ex = x2 - ux * stop, ey = y2 - uy * stop;
      ctx.globalAlpha = alpha; ctx.strokeStyle = colour; ctx.fillStyle = colour; ctx.lineWidth = width; ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(ex - ux * head * 0.8, ey - uy * head * 0.8); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ex, ey);
      ctx.lineTo(ex - ux * head - uy * head * 0.55, ey - uy * head + ux * head * 0.55);
      ctx.lineTo(ex - ux * head + uy * head * 0.55, ey - uy * head - ux * head * 0.55);
      ctx.closePath(); ctx.fill();
    }

    drawLabels(W, H) {
      const { ctx, cam, o } = this;
      const showAll = o.labels === "auto" && cam.k >= 1.4, hubs = o.labels === "hubs" || (o.labels === "auto" && cam.k >= 0.6);
      const forced = new Set(this.pathPick); if (this.path) for (const i of this.path.nodes) forced.add(i);
      if (this.focus >= 0) forced.add(this.focus);
      if (this.linkFrom >= 0) forced.add(this.linkFrom);
      if (this.hover >= 0) forced.add(this.hover);
      if (o.labels === "off" && !forced.size) return;
      ctx.font = `500 12px ${this.font}`; ctx.textAlign = "center"; ctx.fillStyle = this.col.text;
      if ("letterSpacing" in ctx) ctx.letterSpacing = "0.3px";      // also turns ligatures off: the pixel face has no "fi" glyph
      ctx.lineJoin = "round"; ctx.lineWidth = 3.5; ctx.strokeStyle = this.col.face;
      const cap = showAll ? 90 : hubs ? 24 : 0;
      const nodes = this.sim.nodes.filter((n) => this.shown(n.i) && (forced.has(n.i) || (o.labels !== "off" && this.fade(n.i) > 0.5)));
      // forced labels first, then best-connected, so the ones that survive overlap-culling are the ones that matter
      nodes.sort((a, b) => (forced.has(b.i) - forced.has(a.i)) || (this.deg[b.i] - this.deg[a.i]) || (a.i - b.i));
      const taken = []; let count = 0;
      for (const n of nodes) {
        const must = forced.has(n.i);
        if (!must && count >= cap) break;
        const [x, y] = this.toScreen(n);
        if (x < 0 || y < 0 || x > W || y > H) continue;
        const raw = this.data.nodes[n.i].title || "";
        const t = raw.length > 28 ? raw.slice(0, 27) + "…" : raw;
        const pic = this.rects.find((r) => r[0] === n.i);
        const w = ctx.measureText(t).width, ly = y + Math.max(this.radius(n), pic ? pic[3] / 2 + 2 : 0) + 13;
        const box = [x - w / 2 - 3, ly - 11, x + w / 2 + 3, ly + 3];
        if (!must && taken.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
        taken.push(box);
        if (!must) count++;
        ctx.globalAlpha = must ? 1 : 0.9; ctx.strokeText(t, x, ly); ctx.fillText(t, x, ly);
      }
      ctx.globalAlpha = 1;
    }

    image(src) {
      let im = this.imgs.get(src);
      if (!im) {
        if (this.imgs.size > IMG_CACHE) this.imgs.delete(this.imgs.keys().next().value);
        im = new Image(); im.decoding = "async"; im.onload = () => this.kick(); im.src = src;
        this.imgs.set(src, im);
      }
      return im;
    }

    // ------------------------------------------------------ interaction
    pick(mx, my) {
      if (!this.sim) return -1;
      for (let k = this.rects.length - 1; k >= 0; k--) {
        const [i, x, y, s] = this.rects[k];
        if (Math.abs(mx - x) <= s / 2 + 2 && Math.abs(my - y) <= s / 2 + 2) return i;
      }
      let best = -1, bd = 1e9;
      for (const n of this.sim.nodes) {
        if (!this.shown(n.i)) continue;
        const [x, y] = this.toScreen(n), dx = x - mx, dy = y - my, d2 = dx * dx + dy * dy;
        const r = Math.max(this.radius(n) + 3, this.o.thumbs !== "never" && this.cam.k >= 2.2 ? 16 : 0);
        if (d2 <= r * r && d2 < bd) { bd = d2; best = n.i; }
      }
      return best;
    }
    /** The visible link under the pointer (within 6 px of its line), or null. */
    pickLink(mx, my) {
      let best = null, bd = 36;
      for (const l of this.vl) {
        if (!this.shown(l.a) || !this.shown(l.b)) continue;
        const [x1, y1] = this.toScreen(this.sim.nodes[l.a]), [x2, y2] = this.toScreen(this.sim.nodes[l.b]);
        const vx = x2 - x1, vy = y2 - y1, L = vx * vx + vy * vy || 1;
        const t = Math.max(0, Math.min(1, ((mx - x1) * vx + (my - y1) * vy) / L));
        const px = x1 + t * vx - mx, py = y1 + t * vy - my, d2 = px * px + py * py;
        if (d2 < bd || (d2 === bd && l.kind === "man")) { bd = d2; best = l; }
      }
      return best;
    }
    pos(e) { const r = this.cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

    clicked(i, e) {
      const meta = this.data.nodes[i];
      if (this.linkFrom >= 0) {
        const from = this.linkFrom; this.linkFrom = -1; this.kick();
        this.h.link?.(from === i ? null : this.data.nodes[from].id, from === i ? null : meta.id);
      } else if (this.pathMode) {
        if (this.pathPick.length >= 2) this.pathPick = [];
        if (!this.pathPick.includes(i)) this.pathPick.push(i);
        this.path = this.pathPick.length === 2 ? this.findPath(this.pathPick[0], this.pathPick[1]) : null;
        this.emitPath(); this.kick();
      } else if (e.shiftKey) this.h.focus?.(meta.id);
      else { clearTimeout(this.clickT); this.clickT = setTimeout(() => this.h.open(meta.id), CLICK_WAIT); }
    }

    bind() {
      const cv = this.cv;
      cv.addEventListener("wheel", (e) => {
        e.preventDefault();
        const [mx, my] = this.pos(e), f = Math.exp(-e.deltaY * 0.0015), k = Math.min(Math.max(this.cam.k * f, 0.04), 12);
        this.cam.x = mx - (mx - this.cam.x) * (k / this.cam.k); this.cam.y = my - (my - this.cam.y) * (k / this.cam.k); this.cam.k = k;
        this.fitted = true; this.hideTip(); this.kick();
      }, { passive: false });
      cv.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;                        // right button: the menu, not a click or a drag
        const [mx, my] = this.pos(e), c = this.linkFrom < 0 && !this.pathMode ? this.corner(mx, my) : null;
        cv.setPointerCapture(e.pointerId);
        this.hideTip();
        if (c) {                                             // grabbed a picture corner: resize, don't move
          const n = this.sim.nodes[c.i];
          this.drag = { resize: c.i, i: c.i, mx, my, moved: false, base: this.picSide(n) / this.picScale(n) };
          return;
        }
        const i = this.pick(mx, my);
        this.drag = { i, mx, my, cx: this.cam.x, cy: this.cam.y, moved: false, shift: e.shiftKey, add: e.shiftKey || e.ctrlKey || e.metaKey };
      });
      cv.addEventListener("pointermove", (e) => {
        const [mx, my] = this.pos(e), dr = this.drag;
        this.mouse = [mx, my];
        if (this.linkFrom >= 0) this.kick();
        if (dr?.resize !== undefined) {
          if (Math.hypot(mx - dr.mx, my - dr.my) > 2) dr.moved = true;
          if (dr.moved) {
            // the picture stays centred on its node, so the dragged corner sets half the side
            const [x, y] = this.toScreen(this.sim.nodes[dr.resize]);
            const side = 2 * Math.max(Math.abs(mx - x), Math.abs(my - y));
            const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, side / dr.base));
            this.sizes.set(this.data.nodes[dr.resize].id, Math.round(scale * 100) / 100);
            this.order = null; this.kick();
          }
          return;
        }
        if (dr) {
          if (Math.hypot(mx - dr.mx, my - dr.my) > 4) dr.moved = true;
          if (dr.moved) {
            if (dr.i >= 0) {
              const n = this.sim.nodes[dr.i];
              n.x = (mx - this.cam.x) / this.cam.k; n.y = (my - this.cam.y) / this.cam.k; n.pinned = true; n.vx = n.vy = 0;
              this.sim.reheat(0.35);
            } else { this.cam.x = dr.cx + mx - dr.mx; this.cam.y = dr.cy + my - dr.my; this.fitted = true; }
            this.kick();
          }
          return;
        }
        const c = this.linkFrom < 0 && !this.pathMode ? this.corner(mx, my) : null;
        const i = c ? c.i : this.pick(mx, my);
        if (i !== this.hover) { this.hover = i; i >= 0 && !c ? this.showTip(i, mx, my) : this.hideTip(); this.kick(); }
        else if (i >= 0 && !c) this.moveTip(mx, my);
        if (c) this.hideTip();
        const hl = c || i >= 0 || this.linkFrom >= 0 ? null : this.pickLink(mx, my);
        if (hl !== this.hoverLink) { this.hoverLink = hl; this.kick(); }
        cv.style.cursor = c ? (c.sx === c.sy ? "nwse-resize" : "nesw-resize") : i >= 0 || hl ? "pointer" : "grab";
      });
      cv.addEventListener("pointerup", () => {
        const dr = this.drag; this.drag = null;
        if (dr?.resize !== undefined) {
          if (dr.moved) { const id = this.data.nodes[dr.resize].id; this.h.resized?.(id, this.sizes.get(id)); }
          this.kick(); return;
        }
        if (dr && !dr.moved && dr.i >= 0) this.clicked(dr.i, { shiftKey: dr.shift });
        else if (dr && !dr.moved && this.linkFrom >= 0) { this.linkFrom = -1; this.kick(); this.h.link?.(null, null); }
        else if (dr && !dr.moved && !this.pathMode) {          // a click on the background: links
          const l = this.pickLink(dr.mx, dr.my);
          if (l) {
            if (dr.add) this.selLinks.has(l) ? this.selLinks.delete(l) : this.selLinks.add(l);
            else if (this.selLinks.size === 1 && this.selLinks.has(l)) this.selLinks.clear();
            else { this.selLinks.clear(); this.selLinks.add(l); }
          } else if (!dr.add) this.selLinks.clear();
          this.h.linkSel?.(this.selLinks.size); this.kick();
        }
      });
      cv.addEventListener("pointercancel", () => { this.drag = null; });
      cv.addEventListener("pointerleave", () => { if (!this.drag) { this.hover = -1; this.hoverLink = null; this.hideTip(); this.kick(); } });
      cv.addEventListener("dblclick", (e) => {
        clearTimeout(this.clickT);
        const [mx, my] = this.pos(e), i = this.pick(mx, my);
        if (i >= 0) this.h.menu?.(this.data.nodes[i].id, e.clientX, e.clientY);
        else if (this.linkFrom < 0) this.fit();
        this.kick();
      });
      cv.addEventListener("contextmenu", (e) => {
        if (!this.sim) return;
        const [mx, my] = this.pos(e), i = this.pick(mx, my);
        if (i >= 0) { e.preventDefault(); clearTimeout(this.clickT); this.h.menu?.(this.data.nodes[i].id, e.clientX, e.clientY); return; }
        const l = this.pickLink(mx, my);
        if (!l) return;
        e.preventDefault();
        this.h.linkMenu?.(this.linkInfo(l), e.clientX, e.clientY);
      });
    }

    showTip(i, mx, my) {
      this.tip.innerHTML = this.h.tip(this.data.nodes[i], this.deg[i]); this.tip.hidden = false; this.moveTip(mx, my);
    }
    moveTip(mx, my) {
      const t = this.tip, w = this.wrap.clientWidth, h = this.wrap.clientHeight;
      t.style.left = Math.max(4, Math.min(mx + 14, w - t.offsetWidth - 8)) + "px";
      t.style.top = Math.max(4, Math.min(my + 14, h - t.offsetHeight - 8)) + "px";
    }
    hideTip() { if (this.tip) this.tip.hidden = true; }
  }

  GraphView.DEFAULTS = DEFAULTS;
  root.GraphView = GraphView;
})(typeof self !== "undefined" ? self : globalThis);
