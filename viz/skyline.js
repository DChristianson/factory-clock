// Skyline (hero view, design language `isometric`): the whole project as a
// city seen from a fixed 2:1 isometric angle, like an architectural model on
// its plinth. Packages are city blocks, placed by the shared force layout over
// the imports between packages and then snapped to a street grid, so blocks
// that import each other are neighbors. Files are buildings: footprint by
// fan-in (a widely imported file is broad), height by lines (a long file is
// tall), tests as low glass buildings, docs as pavilions under a pitched
// roof. The streets between blocks carry the imports between packages, wider
// for more; packages that import each other are joined by a bridge. Open plan
// items put scaffolding on the buildings they name
// (workspace.joins.planToCode), an epic a crane, and in replay a done item's
// scaffolding comes down at its close time. Sessions are the lights: as the
// replay runs through the sessions' day, windows light in the buildings a
// session touches (workspace.touches) and go dark as it moves on, and the sky
// darkens as the day ends. See docs/workspace-explorer.md, "Skyline".
//
// Subjects: `workspace` draws whatever is loaded (code is required; plans add
// scaffolding, sessions with file targets add lights), `code` draws the
// daylight city alone. Flat faces in three tones of one hue per role, hard
// shadows one way, no gradient but the sky; painter's order, so nearer
// buildings cover farther ones. Inferred things are dashed. Clicking a
// building or a block announces { artifactId }, scaffolding or a crane
// { itemId }, a lit window { sessionId }. Sees only its host and ctx.
(function () {
  const MAX_BLOCKS = 24; // blocks before the smallest packages fold into one "more" block
  const MAX_BLOCK_FILES = 60; // buildings in one block before it folds its files to their modules
  const MAX_LIT = 48; // buildings lit bright at once, like particles; the rest of the day's lights rest faint
  const MAX_CRANES = 8; // cranes for epics, the busiest first
  const MAX_STREETS = 120; // package-pair imports drawn along the streets; the lightest past this are left off
  const MAX_FLOORS = 12; // window rows on one face
  const SCAFFOLD_SPREAD = 4; // buildings an item naming a folder scaffolds: its tallest
  const LIGHT_SHARE = 0.08; // a window stays lit this share of the replayed span after its last touch
  // World units (a footprint's side is 2 to 8 of them).
  const SIDE_MIN = 2;
  const SIDE_MAX = 8;
  const TALL = 16; // the tallest building's height; it sets the scale
  const GAP = 0.9; // between buildings in a block
  const PAD = 1.2; // a block's curb
  const STREET = 4.5; // between blocks
  const PLINTH = 1.6; // the model's base, below the street
  const FLOOR = 1.4; // a storey, for windows and scaffold ledgers
  const SHADOW = 0.45; // a shadow's length per unit of height, cast toward +x (screen lower right)
  const STATUS_TEXT = { open: 'open', in_progress: 'in progress', blocked: 'blocked', done: 'done', deferred: 'deferred', dropped: 'dropped' };
  const BUSY = { in_progress: 3, blocked: 2, open: 1, deferred: 0 }; // which status a shared scaffold shows
  const ROLE_ORDER = { source: 0, generated: 1, asset: 1, config: 2, test: 3, doc: 4 };
  let charts = 0;

  /** The role a building is drawn as: source, test (glass), doc (pavilion), or plain. */
  const look = (role) => (role === 'test' ? 'test' : role === 'doc' ? 'doc' : role === 'source' || !role ? 'source' : 'plain');

  window.factoryClock.register({
    id: 'skyline',
    title: 'Skyline',
    tags: { subject: ['workspace', 'code'], category: ['quantitative', 'dependency', 'state'], purpose: ['expressive'], level: ['project'], dimension: ['structure', 'quantity', 'place', 'status'], language: ['isometric'] },
    mount(host, ctx) {
      const { el, svg, svgText, fmt, compact, clip, fit: fitText, hashId, forceLayout, sessionName, interact } = ctx;
      const prefix = `skyline${++charts}`;
      const frame = el('div', { class: 'hero-skyline' });
      const note = el('p', { class: 'muted small' });
      host.replaceChildren(frame, note);
      const fitter = ctx.fitter(host);
      let workspace = null;
      let subject = 'workspace';
      let selection = null;
      let model = null;
      let modelKey = null;
      let scene = null;
      let opened = null;
      let moved = false; // until the clock first moves, the city rests on its long exposure
      const clock = ctx.createReplay({ onFrame: () => paintFrame() });
      const bar = ctx.replayBar(clock, { label: 'the Skyline' });

      const qualify = (root, id) => `${root}::${id}`;
      const linesOf = (a) => (a.size && Number.isFinite(a.size.lines) ? a.size.lines : a.size && Number.isFinite(a.size.bytes) ? Math.round(a.size.bytes / 34) : 0);
      const isEpic = (it, kids) => it.kind === 'epic' || it.kind === 'milestone' || kids;

      // ---------- the model: blocks, buildings, streets, scaffolding, lights ----------
      function build(ws, withPlans, withSessions) {
        const graphs = ws.code || [];
        const arts = new Map();
        for (const g of graphs) {
          const root = g.source.root;
          for (const a of g.artifacts) arts.set(qualify(root, a.id), { qid: qualify(root, a.id), a, root, kids: [], fanIn: 0, fanOut: 0 });
        }
        for (const n of arts.values()) {
          const p = n.a.parent ? arts.get(qualify(n.root, n.a.parent)) : null;
          if (p && p !== n) {
            n.parent = p;
            p.kids.push(n);
          }
        }
        for (const g of graphs) {
          for (const d of g.dependencies) {
            const f = arts.get(qualify(g.source.root, d.from));
            const t = arts.get(qualify(g.source.root, d.to));
            if (f) f.fanOut += 1;
            if (t) t.fanIn += 1;
          }
        }
        const isLand = (n) => n.a.kind !== 'workspace' && n.a.kind !== 'external';
        const isBlock = (n) => n.a.kind === 'package' || n.a.kind === 'target';
        const isLeaf = (n) => n.a.kind === 'file' || (n.a.kind === 'module' && !n.kids.some(isLand));

        // Each leaf's block: its nearest package or target, or its graph's loose files.
        const blocks = new Map();
        const blockOfArt = new Map();
        for (const n of arts.values()) {
          if (!isLand(n)) continue;
          let up = n;
          while (up && !isBlock(up)) up = up.parent;
          const id = up ? up.qid : `${n.root}::(loose)`;
          if (!blocks.has(id)) blocks.set(id, { id, label: up ? up.a.name : `${n.root} (no package)`, art: up || null, loose: !up, leaves: [], lines: 0 });
          blockOfArt.set(n.qid, id);
          if (isLeaf(n)) {
            const b = blocks.get(id);
            b.leaves.push(n);
            b.lines += linesOf(n.a);
          }
        }
        let ranked = [...blocks.values()].filter((b) => b.leaves.length);
        ranked.sort((p, q) => q.lines - p.lines || q.leaves.length - p.leaves.length || (p.id < q.id ? -1 : 1));
        let foldedBlocks = [];
        if (ranked.length > MAX_BLOCKS) {
          foldedBlocks = ranked.slice(MAX_BLOCKS - 1);
          ranked = ranked.slice(0, MAX_BLOCKS - 1);
          ranked.push({ id: '(more)', label: `${foldedBlocks.length} more packages`, art: null, loose: false, other: true, leaves: [], lines: foldedBlocks.reduce((s, b) => s + b.lines, 0) });
        }
        const kept = new Map(ranked.map((b) => [b.id, b]));
        const keptBlockOf = (qid) => {
          const id = blockOfArt.get(qid);
          if (!id) return null;
          if (kept.has(id)) return id;
          return foldedBlocks.some((b) => b.id === id) ? '(more)' : null;
        };

        // Buildings: a file each, or a module each in a block past the limit, or a package each in "more".
        const buildingOf = new Map(); // artifact qid -> building
        const buildings = [];
        let foldedToModules = 0;
        const makeBuilding = (id, art, label, kind, leaves, block) => {
          const lines = leaves.reduce((s, n) => s + linesOf(n.a), 0);
          const fanIn = kind === 'file' ? art.fanIn : leaves.reduce((s, n) => s + n.fanIn, 0);
          const fanOut = kind === 'file' ? art.fanOut : leaves.reduce((s, n) => s + n.fanOut, 0);
          const roles = new Map();
          for (const n of leaves) roles.set(n.a.role || 'source', (roles.get(n.a.role || 'source') || 0) + 1);
          const role = kind === 'file' ? art.a.role || 'source' : [...roles.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
          const b = { id, art, label, kind, role, look: look(role), lines, fanIn, fanOut, files: leaves.filter((n) => n.a.kind === 'file').length, block, side: Math.min(SIDE_MAX, SIDE_MIN + 1.1 * Math.sqrt(fanIn)), items: [], touchers: new Map(), crane: null };
          for (const n of leaves) buildingOf.set(n.qid, b);
          buildingOf.set(id, b);
          buildings.push(b);
          block.buildings.push(b);
          return b;
        };
        const below = (n) => {
          const out = [];
          const walk = (m) => {
            if (isLeaf(m)) out.push(m);
            for (const k of m.kids) if (isLand(k) && !isBlock(k)) walk(k);
          };
          walk(n);
          return out;
        };
        for (const blk of ranked) {
          blk.buildings = [];
          if (blk.other) {
            for (const f of foldedBlocks) {
              const b = makeBuilding(f.art ? f.art.qid : f.id, f.art, f.label, 'package', f.leaves, blk);
              b.folded = f.leaves.length;
              if (f.art) for (const n of arts.values()) if (blockOfArt.get(n.qid) === f.id) buildingOf.set(n.qid, b);
            }
            continue;
          }
          if (blk.leaves.length <= MAX_BLOCK_FILES) {
            for (const n of blk.leaves) makeBuilding(n.qid, n, n.a.name, n.a.kind === 'file' ? 'file' : 'module', [n], blk);
            continue;
          }
          // Fold: each top-level module under the block is one building; files directly in it stay files.
          foldedToModules += 1;
          const tops = new Map();
          for (const n of blk.leaves) {
            let up = n;
            while (up.parent && up.parent !== blk.art && isLand(up.parent) && !isBlock(up.parent)) up = up.parent;
            if (!tops.has(up.qid)) tops.set(up.qid, up);
          }
          for (const t of tops.values()) {
            if (isLeaf(t)) makeBuilding(t.qid, t, t.a.name, t.a.kind === 'file' ? 'file' : 'module', [t], blk);
            else {
              const b = makeBuilding(t.qid, t, t.a.name, 'module', below(t), blk);
              b.folded = b.files;
              for (const n of arts.values()) {
                let up = n;
                while (up && up !== t) up = up.parent;
                if (up === t) buildingOf.set(n.qid, b);
              }
            }
          }
        }
        for (const blk of ranked) if (blk.art) buildingOf.delete(blk.art.qid); // a package names its block, not a building
        const maxLines = Math.max(1, ...buildings.map((b) => b.lines));
        const tallest = buildings.reduce((m, b) => (!m || b.lines > m.lines ? b : m), null);
        for (const b of buildings) b.h = Math.max(0.4, (b.lines / maxLines) * TALL);

        // Lay out each block: shelves of buildings, code first, then config, tests, docs; bigger first within each.
        for (const blk of ranked) {
          const list = blk.buildings.slice().sort((p, q) => (ROLE_ORDER[p.role] ?? 1) - (ROLE_ORDER[q.role] ?? 1) || q.side - p.side || q.h - p.h || (p.id < q.id ? -1 : 1));
          const maxSide = Math.max(...list.map((b) => b.side));
          const target = Math.max(maxSide, Math.sqrt(list.reduce((s, b) => s + (b.side + GAP) ** 2, 0)) * 1.08);
          let x = 0;
          let y = 0;
          let rowD = 0;
          let w = 0;
          for (const b of list) {
            if (x > 0 && x + b.side > target) {
              y += rowD + GAP;
              x = 0;
              rowD = 0;
            }
            b.lx = x;
            b.ly = y;
            x += b.side + GAP;
            rowD = Math.max(rowD, b.side);
            w = Math.max(w, x - GAP);
          }
          blk.w = w + 2 * PAD;
          blk.d = y + rowD + 2 * PAD;
        }

        // Package-pair imports: streets, and bridges where the imports run both ways.
        const pairs = new Map();
        for (const g of graphs) {
          for (const d of g.dependencies) {
            const fq = qualify(g.source.root, d.from);
            const tq = qualify(g.source.root, d.to);
            const to = arts.get(tq);
            if (to && to.a.kind === 'external') continue;
            const fb = keptBlockOf(fq);
            const tb = keptBlockOf(tq);
            if (!fb || !tb || fb === tb) continue;
            const [p, q] = fb < tb ? [fb, tb] : [tb, fb];
            const key = `${p}\u0000${q}`;
            let r = pairs.get(key);
            if (!r) pairs.set(key, (r = { key, a: p, b: q, weight: 0, ab: 0, ba: 0, observed: false }));
            const w = d.weight || 1;
            r.weight += w;
            if (fb === p) r.ab += w;
            else r.ba += w;
            r.observed = r.observed || !d.inferred;
          }
        }
        let streets = [...pairs.values()].sort((p, q) => q.weight - p.weight || (p.key < q.key ? -1 : 1));
        const streetsFolded = Math.max(0, streets.length - MAX_STREETS);
        streets = streets.slice(0, MAX_STREETS);

        // Place the blocks: the force layout over those imports, then snapped to a grid, biggest blocks choosing first.
        const n = ranked.length;
        const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
        const rows = Math.max(1, Math.ceil(n / cols));
        const meanR = ranked.reduce((s, b) => s + Math.max(b.w, b.d) / 2, 0) / Math.max(1, n);
        const box = Math.max(10, meanR * 2.6 * cols);
        const pos = forceLayout(
          ranked.map((b) => ({ id: b.id, r: Math.max(b.w, b.d) / 2 })),
          streets.map((r) => ({ source: r.a, target: r.b, weight: Math.sqrt(r.weight) })),
          { width: box, height: box * (rows / cols), padding: 0, spacing: meanR * 2.2 }
        );
        const px = ranked.map((b) => (pos.get(b.id) || { x: 0 }).x);
        const py = ranked.map((b) => (pos.get(b.id) || { y: 0 }).y);
        const span = (v) => [Math.min(...v), Math.max(...v) - Math.min(...v) || 1];
        const [mx, wx] = span(px);
        const [my, wy] = span(py);
        const taken = new Set();
        const bySize = ranked.map((b, i) => i).sort((p, q) => ranked[q].w * ranked[q].d - ranked[p].w * ranked[p].d || (ranked[p].id < ranked[q].id ? -1 : 1));
        for (const i of bySize) {
          const want = { c: ((px[i] - mx) / wx) * (cols - 1), r: ((py[i] - my) / wy) * (rows - 1) };
          let best = null;
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              if (taken.has(`${c},${r}`)) continue;
              const dist = (c - want.c) ** 2 + (r - want.r) ** 2;
              if (!best || dist < best.dist - 1e-9) best = { c, r, dist };
            }
          }
          taken.add(`${best.c},${best.r}`);
          ranked[i].col = best.c;
          ranked[i].row = best.r;
        }
        // Drop empty columns and rows, then size each to its widest block.
        const usedC = [...new Set(ranked.map((b) => b.col))].sort((a, b) => a - b);
        const usedR = [...new Set(ranked.map((b) => b.row))].sort((a, b) => a - b);
        for (const b of ranked) {
          b.col = usedC.indexOf(b.col);
          b.row = usedR.indexOf(b.row);
        }
        const colW = usedC.map((_, c) => Math.max(...ranked.filter((b) => b.col === c).map((b) => b.w)));
        const rowD = usedR.map((_, r) => Math.max(...ranked.filter((b) => b.row === r).map((b) => b.d)));
        const colX = [];
        const rowY = [];
        colW.reduce((x, w, c) => ((colX[c] = x), x + w + STREET), 0);
        rowD.reduce((y, d, r) => ((rowY[r] = y), y + d + STREET), 0);
        for (const blk of ranked) {
          blk.x0 = colX[blk.col] + (colW[blk.col] - blk.w) / 2;
          blk.y0 = rowY[blk.row] + (rowD[blk.row] - blk.d) / 2;
          blk.x1 = blk.x0 + blk.w;
          blk.y1 = blk.y0 + blk.d;
          // The street corner after the block's cell, where its traffic joins the grid.
          blk.cx = colX[blk.col] + colW[blk.col] + STREET / 2;
          blk.cy = rowY[blk.row] + rowD[blk.row] + STREET / 2;
          for (const b of blk.buildings) {
            b.x0 = blk.x0 + PAD + b.lx;
            b.y0 = blk.y0 + PAD + b.ly;
            b.x1 = b.x0 + b.side;
            b.y1 = b.y0 + b.side;
          }
        }
        // Two packages that import each other: a bridge when their blocks face across one street, a two-way street otherwise.
        for (const r of streets) {
          const A = kept.get(r.a);
          const B = kept.get(r.b);
          r.mutual = r.ab > 0 && r.ba > 0;
          r.bridge = r.mutual && Math.abs(A.col - B.col) + Math.abs(A.row - B.row) === 1;
        }
        const city = { x0: -STREET, y0: -STREET, x1: colX[colX.length - 1] + colW[colW.length - 1] + STREET, y1: rowY[rowY.length - 1] + rowD[rowD.length - 1] + STREET };

        // Scaffolding: plan items on the buildings they name.
        const items = new Map();
        const kidsOf = new Map();
        let planItems = 0;
        let unscaffolded = 0;
        const cranes = [];
        const regionOf = new Map(); // a folder or package qid -> buildings under it, tallest first
        for (const b of buildings) {
          let up = b.art;
          while (up) {
            if (!regionOf.has(up.qid)) regionOf.set(up.qid, []);
            regionOf.get(up.qid).push(b);
            up = up.parent;
          }
        }
        for (const list of regionOf.values()) list.sort((p, q) => q.h - p.h || (p.id < q.id ? -1 : 1));
        if (withPlans) {
          for (const p of ws.plans || []) {
            for (const it of p.items) items.set(qualify(p.source.root, it.id), { qid: qualify(p.source.root, it.id), it, buildings: [] });
            for (const it of p.items) {
              if (!it.parent) continue;
              const pq = qualify(p.source.root, it.parent);
              if (!kidsOf.has(pq)) kidsOf.set(pq, []);
              kidsOf.get(pq).push(qualify(p.source.root, it.id));
            }
          }
          for (const j of (ws.joins && ws.joins.planToCode) || []) {
            const item = items.get(j.from);
            if (!item) continue;
            const one = buildingOf.get(j.to);
            const named = one ? [one] : (regionOf.get(j.to) || []).slice(0, SCAFFOLD_SPREAD);
            for (const b of named) {
              const had = item.buildings.find((x) => x.b === b);
              if (had) had.inferred = had.inferred && !!j.inferred;
              else item.buildings.push({ b, inferred: !!j.inferred || item.it.confidence === 'inferred', region: !one });
            }
          }
          for (const item of items.values()) {
            const epic = isEpic(item.it, kidsOf.has(item.qid));
            if (!epic) {
              planItems += 1;
              if (!item.buildings.length) unscaffolded += 1;
            }
            if (!epic) for (const { b, inferred } of item.buildings) b.items.push({ item, inferred });
          }
          // Cranes: an epic's crane stands on the building most of its items (and its own links) scaffold.
          const candidates = [];
          for (const item of items.values()) {
            if (!isEpic(item.it, kidsOf.has(item.qid))) continue;
            const count = new Map();
            const walk = (q, depth) => {
              const x = items.get(q);
              if (!x || depth > 8) return;
              for (const { b } of x.buildings) count.set(b, (count.get(b) || 0) + 1);
              for (const k of kidsOf.get(q) || []) walk(k, depth + 1);
            };
            walk(item.qid, 0);
            if (!count.size) continue;
            const total = [...count.values()].reduce((s, v) => s + v, 0);
            const order = [...count.entries()].sort((a, b) => b[1] - a[1] || b[0].h - a[0].h || (a[0].id < b[0].id ? -1 : 1));
            candidates.push({ item, order, total });
          }
          const settled = (c) => (c.item.it.status === 'done' || c.item.it.status === 'dropped' ? 1 : 0);
          candidates.sort((p, q) => settled(p) - settled(q) || q.total - p.total || (p.item.qid < q.item.qid ? -1 : 1));
          for (const c of candidates) {
            if (cranes.length >= MAX_CRANES) break;
            const at = c.order.find(([b]) => !b.crane);
            if (!at) continue;
            at[0].crane = c.item;
            cranes.push({ item: c.item, b: at[0], total: c.total });
          }
          for (const b of buildings) b.items.sort((p, q) => (BUSY[q.item.it.status] ?? -1) - (BUSY[p.item.it.status] ?? -1) || (p.item.qid < q.item.qid ? -1 : 1));
        }
        const epicsWithoutCrane = withPlans ? [...items.values()].filter((x) => isEpic(x.it, kidsOf.has(x.qid))).length - cranes.length : 0;

        // Lights: each actor's touches, matched to buildings, in time order.
        const tracks = [];
        let touchCount = 0;
        let unmatched = 0;
        const sessions = withSessions ? ws.sessions || [] : [];
        if (sessions.length && ws.touches && ws.touches.size) {
          const exact = new Map();
          const all = [];
          for (const g of graphs) {
            for (const a of g.artifacts) {
              if (!a.path) continue;
              const q = qualify(g.source.root, a.id);
              if (!exact.has(a.path)) exact.set(a.path, q);
              all.push({ path: a.path, q });
            }
          }
          const known = new Map(sessions.map((s) => [s.summary.sessionId, s]));
          for (const [sessionId, list] of ws.touches) {
            const s = known.get(sessionId);
            if (!s) continue;
            const byActor = new Map();
            for (const t of list) {
              const ts = Date.parse(t.ts);
              if (!Number.isFinite(ts)) continue;
              let q = null;
              let inferred = false;
              if (t.anchored) q = exact.get(t.path) || null;
              else {
                const m = all.filter((x) => x.path === t.path || x.path.endsWith('/' + t.path));
                q = m.length === 1 ? m[0].q : null;
                inferred = true;
              }
              const b = q ? buildingOf.get(q) : null;
              if (!b) {
                unmatched += 1;
                continue;
              }
              touchCount += 1;
              b.touchers.set(sessionId, (b.touchers.get(sessionId) || 0) + 1);
              if (inferred) b.inferredLight = true;
              const actor = t.agentId || '';
              if (!byActor.has(actor)) byActor.set(actor, []);
              byActor.get(actor).push({ t: ts, b });
            }
            for (const [actor, pts] of byActor) {
              pts.sort((p, q) => p.t - q.t);
              tracks.push({ sessionId, actor, session: s, pts });
            }
          }
        }
        const lit = buildings.filter((b) => b.touchers.size);
        return { blocks: ranked, kept, buildings, buildingOf, foldedBlocks, foldedToModules, streets, streetsFolded, city, tallest, maxLines, items, cranes, epicsWithoutCrane, planItems, unscaffolded, tracks, touchCount, unmatched, lit, sessions };
      }

      // ---------- drawing ----------
      function update(sessions, sel, options) {
        const opts = options || {};
        selection = sel || null;
        subject = opts.subject === 'code' ? 'code' : 'workspace';
        workspace = opts.workspace || null;
        const ws = workspace;
        const key = ws ? `${subject}|${(ws.code || []).map((g) => `${g.source.root}:${g.artifacts.length}:${g.dependencies.length}`).join(',')}|${(ws.plans || []).map((p) => `${p.source.root}:${p.items.length}`).join(',')}|${(ws.sessions || []).map((s) => s.summary.sessionId).join(',')}|${ws.touches ? ws.touches.size : 0}` : '';
        if (key !== modelKey || (model && model.ws !== ws)) {
          modelKey = key;
          model = ws && (ws.code || []).length ? build(ws, subject === 'workspace', subject === 'workspace') : null;
          if (model && !model.blocks.length) model = null;
          if (model) model.ws = ws;
          moved = false;
          clock.setSessions(model ? model.sessions : []);
          opened = clock.time;
        }
        draw();
      }

      function draw() {
        scene = null;
        if (!model) {
          const missing = !workspace || !(workspace.code || []).length ? 'No code is loaded.' : 'The loaded code has no files.';
          frame.replaceChildren(el('p', { class: 'sk-empty', text: `${missing} The Skyline draws code as a city: load a code graph (Sessions and project ↓), and plans and sessions add scaffolding and lights to it.` }));
          note.textContent = '';
          return;
        }
        const m = model;
        const width = Math.max(320, host.clientWidth || 800);
        const height = fitter.height(Math.round(Math.min(640, Math.max(320, width * 0.6))), 300);
        const f1 = (v) => v.toFixed(1);
        const sel = selection;

        // Fit the projected city (s = 1) into the drawing, crane tops and the plinth included.
        const craneH = TALL * 0.45;
        const sx = (x, y) => x - y;
        const sy = (x, y, z) => (x + y) / 2 - z;
        const c = m.city;
        let bx0 = sx(c.x0, c.y1);
        let bx1 = sx(c.x1, c.y0);
        let by0 = sy(c.x0, c.y0, 0);
        const by1 = sy(c.x1, c.y1, -PLINTH);
        for (const b of m.buildings) {
          const top = b.h + (b.crane ? craneH : b.items.length ? 0.6 : 0) + (b.look === 'doc' ? b.side * 0.35 : 0);
          by0 = Math.min(by0, sy(b.x0, b.y0, top));
          if (b.crane) {
            const j = b.side * 0.5 + TALL * 0.3;
            const mxp = (b.x0 + b.x1) / 2;
            const myp = (b.y0 + b.y1) / 2;
            bx0 = Math.min(bx0, sx(mxp - j * 0.35, myp + j * 0.35));
            bx1 = Math.max(bx1, sx(mxp + j, myp - j));
          }
        }
        const inner = { x0: 14, y0: 30, x1: width - 14, y1: height - 18 };
        const s = Math.min((inner.x1 - inner.x0) / Math.max(1, bx1 - bx0), (inner.y1 - inner.y0) / Math.max(1, by1 - by0));
        const ox = inner.x0 + ((inner.x1 - inner.x0) - (bx1 - bx0) * s) / 2 - bx0 * s;
        const oy = inner.y0 + ((inner.y1 - inner.y0) - (by1 - by0) * s) / 2 - by0 * s;
        const P = (x, y, z) => `${f1(ox + (x - y) * s)},${f1(oy + ((x + y) / 2 - z) * s)}`;
        const poly = (...pts) => `M${pts.join(' L')} Z`;
        const quad = (x0, y0, x1, y1, z) => poly(P(x0, y0, z), P(x1, y0, z), P(x1, y1, z), P(x0, y1, z));
        /** The three visible faces of a box: top, left (the face toward +y), right (toward +x), and its outline. */
        const boxPaths = (x0, y0, x1, y1, z0, z1) => ({
          top: quad(x0, y0, x1, y1, z1),
          left: poly(P(x0, y1, z0), P(x1, y1, z0), P(x1, y1, z1), P(x0, y1, z1)),
          right: poly(P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), P(x1, y0, z1)),
          hull: poly(P(x0, y1, z0), P(x1, y1, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1), P(x0, y1, z1)),
        });

        const onArt = (b) => !!sel && !!sel.artifactId && (sel.artifactId === b.id || m.buildingOf.get(sel.artifactId) === b);
        const onItem = (b) => !!sel && !!sel.itemId && (b.items.some((x) => x.item.qid === sel.itemId) || (b.crane && b.crane.qid === sel.itemId));
        const onSession = (b) => !!sel && !!sel.sessionId && b.touchers.has(sel.sessionId);

        const roots = [...new Set((workspace.code || []).map((g) => g.source.root))];
        const root = svg('svg', {
          class: 'sk-svg',
          width,
          height,
          viewBox: `0 0 ${width} ${height}`,
          role: 'img',
          'aria-label': `Skyline of ${roots.join(', ')}: ${m.blocks.length} blocks, ${m.buildings.length} buildings${m.streets.length ? `, ${m.streets.length} streets of imports` : ''}${m.buildings.some((b) => b.items.length) ? `, ${m.buildings.filter((b) => b.items.length).length} under scaffolding` : ''}${m.lit.length ? `, ${m.lit.length} lit by sessions` : ''}`,
        });
        const defs = svg('defs');
        const grad = (id, cls) => {
          const g = svg('linearGradient', { id, x1: 0, y1: 0, x2: 0, y2: 1 });
          g.append(svg('stop', { class: `${cls}0`, offset: 0 }), svg('stop', { class: `${cls}1`, offset: 1 }));
          return g;
        };
        defs.append(grad(`${prefix}-day`, 'sk-day'), grad(`${prefix}-night`, 'sk-night'));
        root.append(defs);
        // The sky: the one gradient, day and night, the night's opacity set by the replay.
        root.append(svg('rect', { x: 0, y: 0, width, height, fill: `url(#${prefix}-day)` }));
        root.append(svg('rect', { class: 'sk-dusk', x: 0, y: 0, width, height, fill: `url(#${prefix}-night)` }));

        // The plinth and the streets.
        const base = boxPaths(c.x0, c.y0, c.x1, c.y1, -PLINTH, 0);
        const ground = svg('g', { class: 'sk-ground' });
        ground.append(svg('path', { class: 'sk-plinth-l', d: base.left }), svg('path', { class: 'sk-plinth-r', d: base.right }), svg('path', { class: 'sk-street', d: base.top }));
        root.append(ground);
        for (const blk of m.blocks) {
          const on = !!sel && !!blk.art && sel.artifactId === blk.art.qid;
          const plot = svg('path', { class: `sk-plot${blk.loose ? ' sk-inferred' : ''}${on ? ' sk-on' : ''}`, d: quad(blk.x0, blk.y0, blk.x1, blk.y1, 0) });
          interact(ctx, plot, {
            label: `Block ${blk.label}`,
            tip: () => [blk.label, ['Kind', blk.other ? `${m.foldedBlocks.length} small packages, folded` : blk.loose ? 'files outside any package' : (blk.art && blk.art.a.kind) || 'package'], ['Buildings', fmt(blk.buildings.length)], ['Lines', fmt(blk.buildings.reduce((a, b) => a + b.lines, 0))], ...(blk.art ? [['Fan-in', fmt(blk.art.fanIn)], ['Fan-out', fmt(blk.art.fanOut)]] : [])],
            pick: blk.art ? () => ctx.select({ artifactId: blk.art.qid }) : undefined,
          });
          ground.append(plot);
        }
        // Imports between packages, along the streets: out of one block's corner, along its street, down the other's.
        const maxW = Math.max(1, ...m.streets.map((r) => r.weight));
        m.streets.forEach((r, i) => {
          const A = m.kept.get(r.a);
          const B = m.kept.get(r.b);
          const lane = ((i % 5) - 2) * (STREET / 7);
          const ax = A.cx + lane;
          const ay = A.cy + lane;
          const bxp = B.cx + lane;
          const byp = B.cy + lane;
          const d = `M${P(ax, ay, 0)} L${P(bxp, ay, 0)} L${P(bxp, byp, 0)}`;
          const w = 0.8 + 2.6 * Math.sqrt(r.weight / maxW);
          const g = svg('g', { class: `sk-route-g${r.observed ? '' : ' sk-inferred'}` });
          g.append(svg('path', { class: 'sk-route', d, 'stroke-width': f1(w) }));
          if (r.mutual && !r.bridge) {
            const o = STREET / 9;
            g.append(svg('path', { class: 'sk-route sk-route-back', d: `M${P(ax + o, ay + o, 0)} L${P(bxp + o, ay + o, 0)} L${P(bxp + o, byp + o, 0)}`, 'stroke-width': f1(Math.max(0.8, w * 0.6)) }));
          }
          g.append(svg('path', { class: 'sk-hit', d, 'stroke-width': Math.max(8, w + 4) }));
          // A block's own spur to its corner.
          for (const [blk, x, y] of [[A, ax, ay], [B, bxp, byp]]) g.append(svg('path', { class: 'sk-route', d: `M${P(blk.x1, (blk.y0 + blk.y1) / 2, 0)} L${P(x, (blk.y0 + blk.y1) / 2, 0)} L${P(x, y, 0)}`, 'stroke-width': f1(Math.max(0.8, w * 0.6)) }));
          interact(ctx, g, {
            label: `Street between ${A.label} and ${B.label}`,
            tip: () => [`${A.label} ⇄ ${B.label}`, ['Imports', fmt(r.weight)], [`${clip(A.label, 18)} → ${clip(B.label, 18)}`, fmt(r.ab)], [`${clip(B.label, 18)} → ${clip(A.label, 18)}`, fmt(r.ba)], ...(r.observed ? [] : ['Inferred: every import on it was guessed'])],
            pick: A.art || B.art ? () => ctx.select({ artifactId: ((r.ab >= r.ba && A.art) || !B.art ? A : B).art.qid }) : undefined,
          });
          ground.append(g);
        });
        // Hard shadows, one way, all in one flat tone.
        const shadows = svg('g', { class: 'sk-shadows' });
        for (const b of m.buildings) shadows.append(svg('path', { d: quad(b.x0, b.y0, b.x1 + b.h * SHADOW, b.y1, 0) }));
        root.append(shadows);
        // Dusk over the ground, under the buildings.
        root.append(svg('path', { class: 'sk-veil', d: base.hull }));

        // Bridges: where two packages import each other, a low deck over the street between their facing blocks, drawn before the buildings so nearer ones cover it.
        const bridges = svg('g', { class: 'sk-bridges' });
        for (const r of m.streets) {
          if (!r.bridge) continue;
          const A = m.kept.get(r.a);
          const B = m.kept.get(r.b);
          const near = (blk, x, y) => [Math.max(blk.x0, Math.min(blk.x1, x)), Math.max(blk.y0, Math.min(blk.y1, y))];
          const [ax, ay] = near(A, (B.x0 + B.x1) / 2, (B.y0 + B.y1) / 2);
          const [bxp, byp] = near(B, (A.x0 + A.x1) / 2, (A.y0 + A.y1) / 2);
          const z = 1.6;
          const d = `M${P(ax, ay, 0)} L${P(ax, ay, z)} L${P(bxp, byp, z)} L${P(bxp, byp, 0)}`;
          const g = svg('g', { class: `sk-bridge-g${r.observed ? '' : ' sk-inferred'}` });
          g.append(svg('path', { class: 'sk-bridge', d }), svg('path', { class: 'sk-hit', d, 'stroke-width': 8 }));
          interact(ctx, g, {
            label: `Bridge between ${A.label} and ${B.label}`,
            tip: () => [`${A.label} ⇄ ${B.label}`, 'A bridge: each imports the other', [`${clip(A.label, 18)} → ${clip(B.label, 18)}`, fmt(r.ab)], [`${clip(B.label, 18)} → ${clip(A.label, 18)}`, fmt(r.ba)]],
            pick: A.art ? () => ctx.select({ artifactId: A.art.qid }) : undefined,
          });
          bridges.append(g);
        }
        root.append(bridges);
        // Buildings in painter's order: farther first, so nearer ones cover them.
        const city = svg('g', { class: 'sk-city' });
        root.append(city);
        const order = m.buildings.slice().sort((p, q) => p.x0 + p.x1 + p.y0 + p.y1 - (q.x0 + q.x1 + q.y0 + q.y1) || (p.id < q.id ? -1 : 1));
        const parts = [];
        for (const b of order) {
          const g = svg('g', { class: `sk-b sk-${b.look}${b.folded ? ' sk-folded' : ''}${onArt(b) || onItem(b) || onSession(b) ? ' sk-on' : ''}` });
          const bp = boxPaths(b.x0, b.y0, b.x1, b.y1, 0, b.h);
          const body = svg('g', { class: 'sk-body' });
          body.append(svg('path', { class: 'sk-face sk-left', d: bp.left }), svg('path', { class: 'sk-face sk-right', d: bp.right }));
          if (b.look === 'doc') {
            // A pavilion: a pitched roof over the low walls.
            const apex = P((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, b.h + b.side * 0.35);
            body.append(svg('path', { class: 'sk-face sk-top', d: bp.top }), svg('path', { class: 'sk-face sk-roof-l', d: poly(P(b.x0, b.y1, b.h), P(b.x1, b.y1, b.h), apex) }), svg('path', { class: 'sk-face sk-roof-r', d: poly(P(b.x1, b.y1, b.h), P(b.x1, b.y0, b.h), apex) }));
          } else body.append(svg('path', { class: 'sk-face sk-top', d: bp.top }));
          if (b.folded) {
            // A folded module: a setback storey on its roof says it stands for several files.
            const e = b.side * 0.2;
            const t = boxPaths(b.x0 + e, b.y0 + e, b.x1 - e, b.y1 - e, b.h, b.h + Math.min(1.2, b.h * 0.15 + 0.3));
            body.append(svg('path', { class: 'sk-face sk-left', d: t.left }), svg('path', { class: 'sk-face sk-right', d: t.right }), svg('path', { class: 'sk-face sk-top', d: t.top }));
          }
          const kindText = b.kind === 'file' ? b.role : `${b.kind}, ${fmt(b.folded || b.files)} files folded`;
          interact(ctx, body, {
            label: `${b.kind === 'file' ? 'File' : b.kind === 'module' ? 'Module' : 'Package'} ${b.label}: ${fmt(b.lines)} lines`,
            tip: () => [
              b.label,
              ...(b.art && b.art.a.path ? [['Path', clip(b.art.a.path, 60)]] : []),
              ['Kind', kindText],
              ['Lines (height)', fmt(b.lines)],
              ['Fan-in (footprint)', fmt(b.fanIn)],
              ['Fan-out', fmt(b.fanOut)],
              ...(b.items.length ? [['Scaffolding', clip(b.items.map((x) => x.item.it.title).join('; '), 80)]] : []),
              ...(b.touchers.size ? [['Sessions', fmt(b.touchers.size)]] : []),
            ],
            pick: b.art ? () => ctx.select({ artifactId: b.id }) : undefined,
          });
          g.append(body);

          // Windows: storeys on both visible faces, as three paths (dark, faintly lit, lit).
          const win = { all: [], glow: [], lit: [] };
          const rowsN = Math.min(MAX_FLOORS, Math.floor(b.h / FLOOR));
          const colsN = Math.max(1, Math.min(4, Math.round(b.side / 1.6)));
          const cell = (b.side / colsN) * s;
          if (b.look !== 'doc' && rowsN >= 1 && cell >= 3) {
            let k = 0;
            const fh = b.h / rowsN;
            for (let r = 0; r < rowsN; r++) {
              const za = fh * r + fh * 0.32;
              const zb = za + fh * 0.42;
              for (let ci = 0; ci < colsN; ci++) {
                const u0 = (b.side * (ci + 0.28)) / colsN;
                const u1 = u0 + (b.side * 0.44) / colsN;
                for (const face of [0, 1]) {
                  const d = face === 0 ? poly(P(b.x0 + u0, b.y1, za), P(b.x0 + u1, b.y1, za), P(b.x0 + u1, b.y1, zb), P(b.x0 + u0, b.y1, zb)) : poly(P(b.x1, b.y0 + u0, za), P(b.x1, b.y0 + u1, za), P(b.x1, b.y0 + u1, zb), P(b.x1, b.y0 + u0, zb));
                  const h = hashId(`${b.id}#${k++}`) % 10;
                  win.all.push(d);
                  if (h < 7) win.lit.push(d);
                  if (h < 5) win.glow.push(d);
                }
              }
            }
          }
          let litPath = null;
          let glowPath = null;
          if (win.all.length) g.append(svg('path', { class: 'sk-win', d: win.all.join(' ') }));
          g.append(svg('path', { class: 'sk-veil', d: bp.hull })); // dusk over the faces and dark windows; the lights sit above it
          if (win.all.length) {
            if (b.touchers.size) {
              const wg = svg('g', { class: `sk-lights${b.inferredLight ? ' sk-inferred' : ''}` });
              glowPath = svg('path', { class: 'sk-glow', d: win.glow.join(' '), visibility: 'hidden' });
              litPath = svg('path', { class: 'sk-lit', d: win.lit.join(' '), visibility: 'hidden' });
              wg.append(glowPath, litPath);
              g.append(wg);
            }
          }
          const part = { b, g, litPath, glowPath, by: null, scaf: null, crane: null };
          if (b.touchers.size) {
            const top = [...b.touchers.entries()].sort((p, q) => q[1] - p[1] || (p[0] < q[0] ? -1 : 1));
            const nameOf = (id) => {
              const v = m.sessions.find((x) => x.summary.sessionId === id);
              return v ? sessionName(v.summary, 40) : id.slice(0, 8);
            };
            // The lights' own hit area: the windows' faces, so a click there picks the session, not the file.
            const lamp = svg('path', { class: 'sk-lamp', d: win.all.length ? win.lit.concat(win.glow).join(' ') || bp.left : bp.left });
            interact(ctx, lamp, {
              label: `Lights in ${b.label}`,
              tip: () => [`Lights in ${b.label}`, ...(part.by ? [['Lit by', nameOf(part.by)]] : []), ...top.slice(0, 6).map(([id, n]) => [clip(nameOf(id), 32), `${fmt(n)} touches`]), ...(top.length > 6 ? [`and ${top.length - 6} more sessions`] : []), ...(b.inferredLight ? ['Some touches matched by path suffix (inferred)'] : [])],
              pick: () => ctx.select({ sessionId: part.by || top[0][0] }),
            });
            if (win.all.length) g.append(lamp);
          }

          // Scaffolding, on the building: poles at its visible corners, ledgers every storey and a half, one brace a face.
          if (b.items.length) {
            const e = 0.35;
            const x0 = b.x0 - e;
            const y0 = b.y0 - e;
            const x1 = b.x1 + e;
            const y1 = b.y1 + e;
            const top = b.h + 0.6;
            const ledgers = Math.max(1, Math.min(10, Math.round(top / (FLOOR * 1.5))));
            let d = '';
            for (const [x, y] of [[x0, y1], [x1, y1], [x1, y0]]) d += `M${P(x, y, 0)} L${P(x, y, top)} `;
            for (let k = 1; k <= ledgers; k++) {
              const z = (top * k) / ledgers;
              d += `M${P(x0, y1, z)} L${P(x1, y1, z)} L${P(x1, y0, z)} `;
            }
            d += `M${P(x0, y1, 0)} L${P(x1, y1, top)} M${P(x1, y1, 0)} L${P(x1, y0, top)}`;
            const inferred = b.items.every((x) => x.inferred);
            const scaf = svg('path', { class: `sk-scaf${inferred ? ' sk-inferred' : ''}`, d });
            const sg = svg('g', { class: 'sk-scaf-g' });
            sg.append(scaf, svg('path', { class: 'sk-hit', d, 'stroke-width': 6 }));
            interact(ctx, sg, {
              label: `Scaffolding on ${b.label}: ${b.items[0].item.it.title}`,
              tip: () => [`Scaffolding on ${b.label}`, ...b.items.slice(0, 6).map((x) => [STATUS_TEXT[x.item.it.status] || x.item.it.status, clip(x.item.it.title, 56)]), ...(b.items.length > 6 ? [`and ${b.items.length - 6} more items`] : []), ...(inferred ? ['Dashed: the item or its link to the code was inferred'] : [])],
              pick: () => ctx.select({ itemId: (part.scafItem || b.items[0].item).qid }),
            });
            g.append(sg);
            part.scaf = { g: sg, path: scaf, inferred };
          }
          // A crane for an epic: a mast from the roof, a jib across, a hook line down.
          if (b.crane) {
            const cx = (b.x0 + b.x1) / 2;
            const cy = (b.y0 + b.y1) / 2;
            const zTop = b.h + craneH;
            const j = b.side * 0.5 + TALL * 0.3;
            const d = `M${P(cx, cy, b.h)} L${P(cx, cy, zTop)} M${P(cx - j * 0.35, cy + j * 0.35, zTop)} L${P(cx + j, cy - j, zTop)} M${P(cx + j * 0.8, cy - j * 0.8, zTop)} L${P(cx + j * 0.8, cy - j * 0.8, zTop - craneH * 0.55)}`;
            const cg = svg('g', { class: `sk-crane-g${sel && sel.itemId === b.crane.qid ? ' sk-on' : ''}` });
            const weight = boxPaths(cx - j * 0.35 - 0.3, cy + j * 0.35 - 0.3, cx - j * 0.35 + 0.3, cy + j * 0.35 + 0.3, zTop - 0.8, zTop);
            cg.append(svg('path', { class: 'sk-crane', d }), svg('path', { class: 'sk-crane-w', d: weight.left }), svg('path', { class: 'sk-crane-w', d: weight.right }), svg('path', { class: 'sk-hit', d, 'stroke-width': 7 }));
            const epic = b.crane;
            interact(ctx, cg, {
              label: `Crane for ${epic.it.title}`,
              tip: () => [clip(epic.it.title, 80), ['Item', `${epic.it.id} · ${epic.it.kind}`], ['Status', STATUS_TEXT[epic.it.status] || epic.it.status], ['Stands on', clip(b.label, 40)]],
              pick: () => ctx.select({ itemId: epic.qid }),
            });
            g.append(cg);
            part.crane = cg;
          }
          city.append(g);
          parts.push(part);
        }


        // Block names on the curb at each block's front corner, over everything.
        const labels = svg('g', { class: 'sk-labels' });
        for (const blk of m.blocks) {
          // About 6 px a character at 10 px; the curb is as wide as the block's front edge on screen.
          const text = fitText(blk.label, Math.max(84, blk.w * s * 1.2) * (7 / 6));
          if (!text) continue;
          const [lx, ly] = P(blk.x0 + blk.w * 0.5, blk.y1, 0).split(',').map(Number);
          const half = (text.length * 6) / 2;
          labels.append(svgText({ class: 'sk-name', x: f1(Math.max(4 + half, Math.min(width - 4 - half, lx))), y: f1(Math.min(height - 4, ly + 13)), 'text-anchor': 'middle' }, text));
        }
        root.append(labels);
        root.append(svgText({ class: 'sk-caption', x: 14, y: 18 }, fitText(`SKYLINE OF ${roots.join(' · ').toUpperCase()}`, width * 0.45)));
        const scaleText = m.tallest ? `height · lines (tallest ${clip(m.tallest.label, 24)}, ${compact(m.tallest.lines)})   footprint · fan-in` : 'height · lines   footprint · fan-in';
        root.append(svgText({ class: 'sk-caption sk-caption-r', x: width - 14, y: 18, 'text-anchor': 'end' }, fitText(scaleText, width * 0.52)));

        const legend = el('div', { class: 'sk-legend' }, legendKeys(m));
        frame.replaceChildren(root, ...(clock.events.length ? [el('div', { class: 'sk-foot' }, [bar.element])] : []), legend);
        scene = { root, parts };
        paintFrame();
        note.textContent = noteText(m);
        fitter.settle(height, draw);
      }

      function legendKeys(m) {
        const key = (cls, text) => el('span', { class: 'sk-key' }, [el('span', { class: `sk-sw ${cls}` }), text]);
        const looks = new Set(m.buildings.map((b) => b.look));
        const keys = [key('sk-sw-plot', 'block: a package')];
        if (looks.has('source')) keys.push(key('sk-sw-source', 'building: a file'));
        if (looks.has('test')) keys.push(key('sk-sw-test', 'glass: a test'));
        if (looks.has('doc')) keys.push(key('sk-sw-doc', 'pavilion: a doc'));
        if (looks.has('plain')) keys.push(key('sk-sw-plain', 'config or asset'));
        if (m.buildings.some((b) => b.folded)) keys.push(key('sk-sw-folded', 'setback roof: files folded'));
        if (m.streets.length) keys.push(key('sk-sw-route', 'street: imports between packages'));
        if (m.streets.some((r) => r.bridge)) keys.push(key('sk-sw-bridge', 'bridge: imports both ways'));
        if (m.streets.some((r) => r.mutual && !r.bridge)) keys.push(key('sk-sw-twoway', 'double line: imports both ways'));
        if (m.buildings.some((b) => b.items.length)) keys.push(key('sk-sw-scaf', 'scaffolding: an open item'));
        if (m.cranes.length) keys.push(key('sk-sw-crane', 'crane: an epic'));
        if (m.lit.length) keys.push(key('sk-sw-lit', 'lit window: a session at work'));
        const inferred = m.blocks.some((b) => b.loose) || m.streets.some((r) => !r.observed) || m.buildings.some((b) => b.items.length && b.items.every((x) => x.inferred)) || m.buildings.some((b) => b.inferredLight);
        if (inferred) keys.push(key('sk-sw-inferred', 'dashed: inferred'));
        return keys;
      }

      function noteText(m) {
        const ws = workspace;
        const parts = [
          `Each package is a city block, placed by a force layout over the imports between packages and snapped to a street grid, so blocks that import each other are neighbors. Each file is a building: its height is lines, scaled to the tallest (${m.tallest ? `${m.tallest.label}, ${fmt(m.tallest.lines)} lines` : 'none'}), and its footprint grows with fan-in, how many imports point at it. Tests are glass, docs are pavilions. The streets carry the imports between packages, wider for more${m.streets.some((r) => r.mutual) ? '; two packages that import each other are joined by a bridge when their blocks face across a street, and by a double line otherwise' : ''}; externals aren't drawn.`,
        ];
        const missing = [];
        if (subject === 'code') parts.push('Drawing code alone, a daylight city; switch Draw to Workspace for scaffolding and lights.');
        else {
          const scaffolded = m.buildings.filter((b) => b.items.length).length;
          const standingNow = m.buildings.filter((b) => b.items.some((x) => x.item.it.status !== 'done' && x.item.it.status !== 'dropped')).length;
          if (!(ws.plans || []).length) missing.push('no plan is loaded, so there is no scaffolding');
          else if (!m.planItems && !m.items.size) missing.push('the loaded plan has no items, so there is no scaffolding');
          else if (!scaffolded) missing.push('no plan item names a file or folder in the loaded code, so there is no scaffolding');
          else parts.push(`Scaffolding stands on the ${fmt(standingNow)} buildings open plan items name (${fmt(scaffolded)} counting done ones), colored by the busiest item's status; an item naming a folder scaffolds its ${SCAFFOLD_SPREAD} tallest buildings${m.cranes.length ? `, and a crane stands for each of ${fmt(m.cranes.length)} epics on the building most of its items name` : ''}. In replay, a done item's scaffolding comes down at its close time.${m.unscaffolded ? ` ${fmt(m.unscaffolded)} of ${fmt(m.planItems)} items name no loaded code.` : ''}`);
          if (!(ws.sessions || []).length) missing.push('no sessions are loaded, so there are no lights and the city stays in daylight');
          else if (!m.lit.length) missing.push('the loaded sessions’ events carry no file targets that match this code, so no windows light');
          else parts.push(`Lights are sessions at work: the replay runs through the sessions' day, windows light in the building each session or subagent touches (${fmt(m.touchCount)} reads and edits) and go dark as it moves on, and the sky darkens as the day ends; a building lit earlier keeps a faint light, so the rest state is the long exposure of the day.${m.unmatched ? ` ${fmt(m.unmatched)} touches matched no loaded file.` : ''}`);
          if (missing.length) parts.push(`Missing: ${missing.join('; ')}.`);
        }
        const folds = [];
        if (m.foldedBlocks.length) folds.push(`the ${fmt(m.foldedBlocks.length)} smallest packages share one block past ${MAX_BLOCKS}, a building each`);
        if (m.foldedToModules) folds.push(`${fmt(m.foldedToModules)} block${m.foldedToModules === 1 ? '' : 's'} with more than ${MAX_BLOCK_FILES} files build${m.foldedToModules === 1 ? 's' : ''} its modules instead, with a setback roof`);
        if (m.streetsFolded) folds.push(`the lightest ${fmt(m.streetsFolded)} streets are left off past ${MAX_STREETS}`);
        if (m.epicsWithoutCrane > 0 && m.cranes.length >= MAX_CRANES) folds.push(`only the ${MAX_CRANES} busiest epics get a crane`);
        if (m.lit.length > MAX_LIT) folds.push(`at most ${MAX_LIT} buildings are lit bright at once`);
        if (folds.length) parts.push(`To keep it readable, ${folds.join('; ')}.`);
        parts.push('Dashed is inferred. Click a building or a block to select it, scaffolding or a crane for its item, a lit window for its session.');
        return parts.join(' ');
      }

      /** The replay's picture at the clock's time: the sky, which windows are lit, which scaffolding stands. */
      function paintFrame() {
        bar.sync();
        if (!scene) return;
        if (clock.playing || (opened !== null && clock.time !== opened)) moved = true;
        const has = clock.events.length > 0;
        const replaying = has && moved;
        const T = replaying ? clock.time : Infinity;
        const span = Math.max(1, clock.end - clock.start);
        const p = replaying ? Math.max(0, Math.min(1, (T - clock.start) / span)) : 1;
        // Daylight, then dusk over the last part of the day; with no sessions, it stays day.
        const dusk = has ? Math.max(0, Math.min(1, (p - 0.5) / 0.45)) : 0;
        scene.root.style.setProperty('--sk-dusk', dusk.toFixed(3));
        // Lights: each actor's building lit from its touch until it moves on (or a while passes); earlier ones glow.
        const hold = span * LIGHT_SHARE;
        const bright = new Map(); // building -> { t, sessionId }
        const glow = new Set();
        for (const tr of model.tracks) {
          let last = null;
          for (const pt of tr.pts) {
            if (pt.t > T) break;
            glow.add(pt.b);
            last = pt;
          }
          if (replaying && last && T - last.t <= hold) {
            const had = bright.get(last.b);
            if (!had || had.t < last.t) bright.set(last.b, { t: last.t, sessionId: tr.sessionId });
          }
        }
        const kept = new Set([...bright.entries()].sort((a, b) => b[1].t - a[1].t).slice(0, MAX_LIT).map(([b]) => b));
        const during = replaying && !clock.atEnd();
        const statusAt = (it) => {
          if (!during) return it.status;
          const created = it.created ? Date.parse(it.created) : NaN;
          const closed = it.closed ? Date.parse(it.closed) : NaN;
          if (Number.isFinite(created) && created > T) return null; // not yet planned
          if ((it.status === 'done' || it.status === 'dropped') && Number.isFinite(closed) && closed > T) return 'in_progress';
          return it.status;
        };
        const standing = (st) => st && st !== 'done' && st !== 'dropped';
        for (const part of scene.parts) {
          const b = part.b;
          if (part.litPath) {
            const on = kept.has(b);
            part.by = on ? bright.get(b).sessionId : null;
            part.litPath.setAttribute('visibility', on ? 'visible' : 'hidden');
            part.glowPath.setAttribute('visibility', !on && glow.has(b) ? 'visible' : 'hidden');
          }
          if (part.scaf) {
            const up = b.items.map((x) => ({ x, st: statusAt(x.item.it) })).filter((u) => standing(u.st));
            up.sort((p2, q2) => (BUSY[q2.st] ?? -1) - (BUSY[p2.st] ?? -1));
            part.scafItem = up.length ? up[0].x.item : null;
            part.scaf.g.setAttribute('visibility', up.length ? 'visible' : 'hidden');
            if (up.length) part.scaf.path.setAttribute('class', `sk-scaf sk-st-${up[0].st}${part.scaf.inferred ? ' sk-inferred' : ''}`);
          }
          if (part.crane) part.crane.setAttribute('visibility', standing(statusAt(b.crane.it)) ? 'visible' : 'hidden');
        }
      }

      return {
        update,
        resize: draw,
        setActive: (active) => clock.setActive(active),
        destroy() {
          clock.destroy();
          ctx.hideTip();
          host.replaceChildren();
        },
      };
    },
  });
})();
