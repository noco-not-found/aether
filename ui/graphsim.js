"use strict";
/* Force layout for the item network. No DOM in here, so it is unit-tested under Node.

   Nodes start where the topic map (UMAP) put them, so similar items already sit together and the
   layout only has to untangle, not discover. Then, per tick:
     links     springs, shorter and stiffer for stronger similarity
     repel     only against nodes in the same or adjacent grid cell, so a tick is O(n), not O(n^2)
     topic     a weak pull towards the centre of the node's topic keeps topics together
     gravity   a weak pull to the origin so disconnected pieces don't drift away
   A cooling `alpha` ends the simulation by itself; dragging a node reheats it. */
(function (root) {
  const REST = 38;            // spring length of a weak link, in layout units
  const CELL = 70;            // repulsion reach and grid size

  function create(input, opts = {}) {
    const n = input.nodes.length;
    const spread = Math.sqrt(Math.max(n, 1)) * 34;
    const rnd = mulberry(opts.seed ?? 7);
    let mx0 = Infinity, my0 = Infinity, mx1 = -Infinity, my1 = -Infinity;     // extent of the map positions we were given
    for (const s of input.nodes) if (Number.isFinite(s.x) && Number.isFinite(s.y)) {
      mx0 = Math.min(mx0, s.x); mx1 = Math.max(mx1, s.x); my0 = Math.min(my0, s.y); my1 = Math.max(my1, s.y);
    }
    const sx = mx1 > mx0 ? mx1 - mx0 : 1, sy = my1 > my0 ? my1 - my0 : 1;
    const nodes = input.nodes.map((s, i) => {
      let x = s.x, y = s.y;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {                // no map position: a random spot in a disc
        const r = spread * Math.sqrt(rnd()), a = rnd() * Math.PI * 2;
        x = r * Math.cos(a); y = r * Math.sin(a);
      } else { x = ((x - mx0) / sx - 0.5) * 2 * spread; y = ((y - my0) / sy - 0.5) * 2 * spread; }
      return { i, x, y, vx: 0, vy: 0, cluster: s.cluster ?? null, pinned: false, deg: 0 };
    });
    const links = input.links.map(([a, b, w, kind]) => ({ a, b, w: w ?? 0.5, kind: kind || "sim" }));
    for (const l of links) { nodes[l.a].deg++; nodes[l.b].deg++; }

    const sim = { nodes, links, alpha: 1, tickCount: 0 };
    const decay = opts.decay ?? 0.985;

    sim.tick = function () {
      const a = sim.alpha;
      if (a < 0.012) return a;
      // topic centres
      const cx = new Map();
      for (const nd of nodes) if (nd.cluster !== null) {
        const c = cx.get(nd.cluster) || (cx.set(nd.cluster, { x: 0, y: 0, n: 0 }), cx.get(nd.cluster));
        c.x += nd.x; c.y += nd.y; c.n++;
      }
      // repulsion through a grid
      const grid = new Map();
      for (const nd of nodes) {
        const key = Math.floor(nd.x / CELL) * 73856093 ^ Math.floor(nd.y / CELL) * 19349663;
        (grid.get(key) || (grid.set(key, []), grid.get(key))).push(nd);
      }
      for (const nd of nodes) {
        const gx = Math.floor(nd.x / CELL), gy = Math.floor(nd.y / CELL);
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          const cell = grid.get((gx + dx) * 73856093 ^ (gy + dy) * 19349663);
          if (!cell) continue;
          for (const o of cell) {
            if (o === nd) continue;
            let rx = nd.x - o.x, ry = nd.y - o.y, d2 = rx * rx + ry * ry;
            if (d2 > CELL * CELL) continue;
            if (d2 < 0.01) { rx = (rnd() - 0.5); ry = (rnd() - 0.5); d2 = rx * rx + ry * ry + 0.01; }
            const d = Math.sqrt(d2), f = (CELL - d) / CELL * 2.2 * a / d;
            nd.vx += rx * f; nd.vy += ry * f;
          }
        }
        const c = nd.cluster !== null ? cx.get(nd.cluster) : null;
        if (c && c.n > 1) { nd.vx += (c.x / c.n - nd.x) * 0.012 * a; nd.vy += (c.y / c.n - nd.y) * 0.012 * a; }
        nd.vx -= nd.x * 0.0015 * a; nd.vy -= nd.y * 0.0015 * a;
      }
      // springs
      for (const l of links) {
        const p = nodes[l.a], q = nodes[l.b];
        let rx = q.x - p.x, ry = q.y - p.y, d = Math.hypot(rx, ry) || 0.01;
        const rest = REST * (l.kind === "tag" ? 1.6 : 1.5 - Math.min(Math.max(l.w, 0), 1) * 0.6);
        const f = (d - rest) / d * (l.kind === "tag" ? 0.05 : 0.09) * a;
        rx *= f; ry *= f;
        p.vx += rx; p.vy += ry; q.vx -= rx; q.vy -= ry;
      }
      for (const nd of nodes) {
        if (nd.pinned) { nd.vx = nd.vy = 0; continue; }
        nd.vx *= 0.82; nd.vy *= 0.82;
        const sp = Math.hypot(nd.vx, nd.vy);
        if (sp > 40) { nd.vx *= 40 / sp; nd.vy *= 40 / sp; }
        nd.x += nd.vx; nd.y += nd.vy;
      }
      sim.tickCount++;
      return (sim.alpha = a * decay);
    };
    sim.reheat = (a = 0.4) => { sim.alpha = Math.max(sim.alpha, a); };
    sim.settled = () => sim.alpha < 0.012;
    sim.bounds = function () {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const nd of nodes) { x0 = Math.min(x0, nd.x); y0 = Math.min(y0, nd.y); x1 = Math.max(x1, nd.x); y1 = Math.max(y1, nd.y); }
      return nodes.length ? { x0, y0, x1, y1 } : { x0: -1, y0: -1, x1: 1, y1: 1 };
    };
    return sim;
  }

  // small seeded generator so layouts are repeatable
  function mulberry(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const api = { create };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.AetherSim = api;
})(typeof self !== "undefined" ? self : globalThis);
