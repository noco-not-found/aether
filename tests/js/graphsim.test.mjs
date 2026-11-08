import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { create } = require("../../ui/graphsim.js");

const run = (sim, max = 1500) => { for (let i = 0; i < max && !sim.settled(); i++) sim.tick(); return sim; };
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

test("a linked pair settles near the spring length, tighter when more similar", () => {
  const mk = (w) => run(create({ nodes: [{ x: 0, y: 0 }, { x: 1, y: 1 }], links: [[0, 1, w]] }));
  const weak = mk(0.2), strong = mk(0.95);
  assert.ok(dist(...strong.nodes) < dist(...weak.nodes));
  assert.ok(dist(...strong.nodes) > 5 && dist(...weak.nodes) < 120);
});

test("unlinked nodes do not collapse onto each other", () => {
  const nodes = Array.from({ length: 30 }, () => ({}));
  const sim = run(create({ nodes, links: [] }));
  let nearest = Infinity;
  for (const a of sim.nodes) for (const b of sim.nodes) if (a !== b) nearest = Math.min(nearest, dist(a, b));
  assert.ok(nearest > 3, `closest pair ${nearest}`);
});

test("identical start positions and missing positions never produce NaN", () => {
  const nodes = [{ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: null, y: null }, {}];
  const sim = run(create({ nodes, links: [[0, 1, 0.9], [1, 2, 0.9]] }));
  for (const n of sim.nodes) assert.ok(Number.isFinite(n.x) && Number.isFinite(n.y));
});

test("pinned nodes stay put; the simulation cools by itself and can be reheated", () => {
  const sim = create({ nodes: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 0.5, y: 0.2 }], links: [[0, 1, 0.5], [1, 2, 0.5]] });
  const p = sim.nodes[0], before = [p.x, p.y];
  p.pinned = true;
  run(sim);
  assert.deepEqual([p.x, p.y], before);
  assert.ok(sim.settled());
  const t = sim.tickCount;
  sim.tick();
  assert.equal(sim.tickCount, t);          // settled: no more work
  sim.reheat();
  sim.tick();
  assert.equal(sim.tickCount, t + 1);
});

test("topics start where the map put them and stay grouped", () => {
  const nodes = [];
  for (let i = 0; i < 20; i++) nodes.push({ x: Math.random() * 0.2, y: Math.random() * 0.2, cluster: 1 });
  for (let i = 0; i < 20; i++) nodes.push({ x: 0.8 + Math.random() * 0.2, y: 0.8 + Math.random() * 0.2, cluster: 2 });
  const sim = run(create({ nodes, links: [] }));
  const centre = (c) => { const m = sim.nodes.filter((n) => n.cluster === c); return { x: m.reduce((s, n) => s + n.x, 0) / m.length, y: m.reduce((s, n) => s + n.y, 0) / m.length }; };
  assert.ok(dist(centre(1), centre(2)) > 100);
});

test("a few thousand nodes tick quickly (grid repulsion is not O(n^2))", () => {
  const n = 3000;
  const nodes = Array.from({ length: n }, (_, i) => ({ x: Math.random(), y: Math.random(), cluster: i % 15 }));
  const links = Array.from({ length: n * 3 }, () => [Math.floor(Math.random() * n), Math.floor(Math.random() * n), 0.6]).filter(([a, b]) => a !== b);
  const sim = create({ nodes, links });
  const t = performance.now();
  for (let i = 0; i < 20; i++) sim.tick();
  const per = (performance.now() - t) / 20;
  assert.ok(per < 40, `${per.toFixed(1)} ms per tick`);
});
