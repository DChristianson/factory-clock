// Atlas (hero view, design language `cartographic`): the whole project drawn
// as a map. Code is land: each package is an island, placed by the shared
// force layout over the package-level dependencies (so closeness is
// dependency), its coast drawn around a circle packing of its modules and
// files, with contour rings inside each file by its size, so a big file is a
// hill. Dependencies between packages are roads, a curve bundled toward the
// middle of the map with width by import weight; dependencies on externals
// are dotted sea lanes to the margin. Plan items are pins on the files or
// modules they name (workspace.joins.planToCode), hue by status, epics are
// small-caps region labels over their items' pins, and `blocks` links are
// dashed routes between pins. Sessions are trails: as the replay runs, each
// actor's path across the files it touched is drawn as a wake that fades.
// See docs/workspace-explorer.md, "Atlas".
//
// Subjects: `workspace` draws whatever is loaded (code is required; plans
// add pins, sessions with file targets add trails), `code` draws the land
// alone. Inferred things are drawn as a cartographer draws uncertain coasts:
// dashed, and "unsurveyed" in the legend. Clicking a file, a package's land,
// or an external announces { artifactId }, a pin or region label
// { itemId }, a trail { sessionId }; an island's name zooms to it. Sees only
// its host and ctx: no VS Code.
(function () {
  const MAX_ISLANDS = 24; // islands before the smallest fold into "other"
  const MAX_ISLAND_FILES = 200; // files on one island drawn one by one before it folds to modules
  const MAX_ROADS = 300; // package-pair roads drawn; the lightest past this are left off
  const MAX_PINS = 12; // pins on one island before they cluster into a numbered marker (four times this when zoomed)
  const MAX_TRAILS = 48; // trails in flight; older ones rest faint
  const MAX_LANES = 24; // externals given a sea lane; the rest fold into one
  const LANE_SOURCES = 3; // islands a sea lane is drawn from, the heaviest users; the tip names them all
  const MARGIN = 26; // the neatline's inset, px
  const FADE_SHARE = 0.15; // a trail's wake fades over this share of the replayed span
  const LEAF_PAD = 1.5; // world units between packed circles
  const STATUS_TEXT = { open: 'open', in_progress: 'in progress', blocked: 'blocked', done: 'done', deferred: 'deferred', dropped: 'dropped' };
  const NICE = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];
  let charts = 0;

  // ---------- circle packing (front chain, after Wang et al. 2006) ----------
  /** Places c tangent to a and b, on the left of a→b. */
  function placeTangent(b, a, c) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d2 = dx * dx + dy * dy;
    if (!d2) {
      c.x = a.x + a.r + c.r;
      c.y = a.y;
      return;
    }
    let a2 = a.r + c.r;
    a2 *= a2;
    let b2 = b.r + c.r;
    b2 *= b2;
    if (a2 > b2) {
      const x = (d2 + b2 - a2) / (2 * d2);
      const y = Math.sqrt(Math.max(0, b2 / d2 - x * x));
      c.x = b.x - x * dx - y * dy;
      c.y = b.y - x * dy + y * dx;
    } else {
      const x = (d2 + a2 - b2) / (2 * d2);
      const y = Math.sqrt(Math.max(0, a2 / d2 - x * x));
      c.x = a.x + x * dx - y * dy;
      c.y = a.y + x * dy + y * dx;
    }
  }
  const overlaps = (a, b) => {
    const dr = a.r + b.r - 1e-6;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    return dr > 0 && dr * dr > dx * dx + dy * dy;
  };
  /** How far the pair a, a.next sits from the origin: the front chain grows where this is least. */
  const chainScore = (n) => {
    const a = n.c;
    const b = n.next.c;
    const ab = a.r + b.r;
    const x = (a.x * b.r + b.x * a.r) / ab;
    const y = (a.y * b.r + b.y * a.r) / ab;
    return x * x + y * y;
  };
  /**
   * Packs circles ({ r }) around the origin, each tangent to two on the front chain and
   * overlapping none: sets x and y. The order given is the order placed.
   */
  function packSiblings(circles) {
    const n = circles.length;
    if (!n) return;
    let a = circles[0];
    a.x = 0;
    a.y = 0;
    if (n === 1) return;
    let b = circles[1];
    a.x = -b.r;
    b.x = a.r;
    b.y = 0;
    if (n === 2) return;
    let c = circles[2];
    placeTangent(b, a, c);
    a = { c: a };
    b = { c: b };
    c = { c };
    a.next = c.prev = b;
    b.next = a.prev = c;
    c.next = b.prev = a;
    pack: for (let i = 3; i < n; i++) {
      placeTangent(a.c, b.c, circles[i]);
      c = { c: circles[i] };
      // Walk the chain both ways from a and b; the first circle c overlaps cuts the chain there.
      let j = b.next;
      let k = a.prev;
      let sj = b.c.r;
      let sk = a.c.r;
      do {
        if (sj <= sk) {
          if (overlaps(j.c, c.c)) {
            b = j;
            a.next = b;
            b.prev = a;
            i--;
            continue pack;
          }
          sj += j.c.r;
          j = j.next;
        } else {
          if (overlaps(k.c, c.c)) {
            a = k;
            a.next = b;
            b.prev = a;
            i--;
            continue pack;
          }
          sk += k.c.r;
          k = k.prev;
        }
      } while (j !== k.next);
      c.prev = a;
      c.next = b;
      a.next = b.prev = b = c;
      // The next circle goes beside the pair closest to the origin.
      let best = chainScore(a);
      while ((c = c.next) !== b) {
        const s = chainScore(c);
        if (s < best) {
          a = c;
          best = s;
        }
      }
      b = a.next;
    }
  }
  /** A circle around circles: a few rounds of moving toward the farthest (Bădoiu and Clarkson's iteration). */
  function enclose(circles) {
    let x = 0;
    let y = 0;
    for (const c of circles) {
      x += c.x / circles.length;
      y += c.y / circles.length;
    }
    const far = () => {
      let best = null;
      let reach = -1;
      for (const c of circles) {
        const d = Math.hypot(c.x - x, c.y - y) + c.r;
        if (d > reach) {
          reach = d;
          best = c;
        }
      }
      return { best, reach };
    };
    for (let k = 1; k <= 40; k++) {
      const { best } = far();
      const d = Math.hypot(best.x - x, best.y - y) || 1;
      // Toward the far side of the farthest circle, by a shrinking step.
      const tx = best.x + ((best.x - x) / d) * best.r;
      const ty = best.y + ((best.y - y) / d) * best.r;
      x += (tx - x) / (k + 2);
      y += (ty - y) / (k + 2);
    }
    return { x, y, r: far().reach };
  }
  /** Packs a tree ({ lines, children }) bottom-up: every node gets r, and x, y relative to its parent's center. */
  function packTree(t, radiusOf) {
    if (!t.children.length) {
      t.r = radiusOf(t.lines);
      return;
    }
    for (const c of t.children) packTree(c, radiusOf);
    const order = t.children.slice().sort((p, q) => q.r - p.r || (p.id < q.id ? -1 : 1));
    const pad = t.depth === 0 ? LEAF_PAD * 2 : LEAF_PAD;
    for (const c of order) c.r += pad;
    packSiblings(order);
    for (const c of order) c.r -= pad;
    const e = enclose(order.map((c) => ({ x: c.x, y: c.y, r: c.r + pad })));
    for (const c of order) {
      c.x -= e.x;
      c.y -= e.y;
    }
    t.r = e.r + pad;
  }

  /** A closed smooth path through points (Catmull-Rom as cubic Béziers). */
  function smoothClosed(pts) {
    const n = pts.length;
    const f = (v) => v.toFixed(1);
    let d = `M${f(pts[0].x)} ${f(pts[0].y)}`;
    for (let i = 0; i < n; i++) {
      const p0 = pts[(i - 1 + n) % n];
      const p1 = pts[i];
      const p2 = pts[(i + 1) % n];
      const p3 = pts[(i + 2) % n];
      d += ` C${f(p1.x + (p2.x - p0.x) / 6)} ${f(p1.y + (p2.y - p0.y) / 6)} ${f(p2.x - (p3.x - p1.x) / 6)} ${f(p2.y - (p3.y - p1.y) / 6)} ${f(p2.x)} ${f(p2.y)}`;
    }
    return `${d} Z`;
  }

  window.factoryClock.register({
    id: 'atlas',
    title: 'Atlas',
    tags: { subject: ['workspace', 'code'], category: ['dependency', 'quantitative', 'state'], purpose: ['expressive'], level: ['project'], dimension: ['structure', 'dependency', 'status'], language: ['cartographic'] },
    mount(host, ctx) {
      const { el, svg, svgText, fmt, compact, clip, fit: fitText, hashId, forceLayout, formatTime, sessionName, agentName, interact } = ctx;
      const prefix = `atlas${++charts}`;
      const frame = el('div', { class: 'hero-atlas' });
      const note = el('p', { class: 'muted small' });
      host.replaceChildren(frame, note);
      const fitter = ctx.fitter(host);
      let workspace = null;
      let subject = 'workspace';
      let selection = null;
      let model = null; // the laid-out map for the loaded workspace
      let modelKey = null;
      let zoom = ''; // an island id, or '' for the whole map
      const shown = { roads: true, pins: true, trails: true };
      let scene = null; // what the replay frame repaints
      let opened = null; // the clock's time when the sessions were set
      let moved = false; // whether the replay has moved since: until then the trails show as a long exposure
      const clock = ctx.createReplay({ onFrame: () => paintFrame() });
      const bar = ctx.replayBar(clock, { label: 'the Atlas' });

      const qualify = (root, id) => `${root}::${id}`;
      const linesOf = (a) => (a.size && Number.isFinite(a.size.lines) ? a.size.lines : a.size && Number.isFinite(a.size.bytes) ? Math.round(a.size.bytes / 34) : 0);

      // ---------- the model: islands, their packing, roads, lanes, pins, trails ----------
      function build(ws, withPlans, withSessions) {
        const graphs = ws.code || [];
        const arts = new Map(); // qid -> node
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
        const isIsland = (n) => n.a.kind === 'package' || n.a.kind === 'target';
        // Each artifact's island: its nearest package or target, or its graph's loose files.
        const islandOfArt = new Map();
        const islands = new Map();
        const island = (id, label, art, root, loose) => {
          if (!islands.has(id)) islands.set(id, { id, label, art, root, loose, members: [], lines: 0, files: 0 });
          return islands.get(id);
        };
        for (const n of arts.values()) {
          if (!isLand(n)) continue;
          let up = n;
          while (up && !isIsland(up)) up = up.parent;
          const isl = up ? island(up.qid, up.a.name, up, up.root, false) : island(`${n.root}::(loose)`, n.root, null, n.root, true);
          islandOfArt.set(n.qid, isl.id);
          if (n.a.kind === 'file' || (!n.kids.length && n.a.kind === 'module')) {
            isl.lines += linesOf(n.a);
            isl.files += n.a.kind === 'file' ? 1 : 0;
          }
        }
        // Totals for containers: every file below.
        const total = new Map();
        const sum = (n) => {
          if (total.has(n.qid)) return total.get(n.qid);
          total.set(n.qid, 0);
          const v = n.kids.length ? n.kids.filter(isLand).reduce((s, k) => s + sum(k), 0) : linesOf(n.a);
          total.set(n.qid, v);
          return v;
        };
        for (const n of arts.values()) if (isLand(n)) sum(n);
        const fileCount = (n) => (n.kids.length ? n.kids.filter(isLand).reduce((s, k) => s + fileCount(k), 0) : n.a.kind === 'file' ? 1 : 0);

        // Fold the smallest islands into "other".
        let ranked = [...islands.values()].filter((i) => i.lines > 0 || i.files > 0 || (i.art && i.art.kids.length));
        ranked.sort((p, q) => q.lines - p.lines || (p.id < q.id ? -1 : 1));
        let foldedIslands = [];
        if (ranked.length > MAX_ISLANDS) {
          foldedIslands = ranked.slice(MAX_ISLANDS - 1);
          ranked = ranked.slice(0, MAX_ISLANDS - 1);
          const other = { id: '(other)', label: `${foldedIslands.length} more`, art: null, root: '', loose: false, other: true, members: [], lines: foldedIslands.reduce((s, i) => s + i.lines, 0), files: foldedIslands.reduce((s, i) => s + i.files, 0) };
          ranked.push(other);
          for (const f of foldedIslands) for (const [q, i] of islandOfArt) if (i === f.id) islandOfArt.set(q, other.id);
        }
        const kept = new Map(ranked.map((i) => [i.id, i]));

        // Each island's tree: its land below it, nested packages left to their own islands.
        const leafOf = new Map(); // artifact qid -> the packed node that stands for it
        let foldedToModules = 0;
        const treeOf = (n, depth, fold) => {
          const kids = n.kids.filter((k) => isLand(k) && !isIsland(k) && islandOfArt.get(k.qid) === islandOfArt.get(n.qid));
          const t = { id: n.qid, art: n, label: n.a.name, kind: n.a.kind, lines: total.get(n.qid) || 0, files: fileCount(n), depth, children: [] };
          leafOf.set(n.qid, t);
          if (fold && depth >= 1) {
            const mark = (m) => {
              leafOf.set(m.qid, t);
              m.kids.forEach(mark);
            };
            n.kids.forEach(mark);
          } else t.children = kids.map((k) => treeOf(k, depth + 1, fold));
          return t;
        };
        for (const isl of ranked) {
          let t;
          if (isl.other) {
            t = { id: isl.id, label: isl.label, kind: 'island', lines: isl.lines, depth: 0, children: [] };
            for (const f of foldedIslands) {
              const leaf = { id: f.id, art: f.art, label: f.label, kind: 'package', lines: f.lines, files: f.files, depth: 1, children: [], folded: true };
              t.children.push(leaf);
              for (const [q, i] of islandOfArt) if (i === isl.id && (q === f.id || (arts.get(q) && islandOf0(arts.get(q)) === f.id))) leafOf.set(q, leaf);
            }
          } else if (isl.loose) {
            const tops = [...arts.values()].filter((n) => isLand(n) && islandOfArt.get(n.qid) === isl.id && (!n.parent || !isLand(n.parent)));
            const fold = isl.files > MAX_ISLAND_FILES;
            if (fold) foldedToModules += 1;
            t = { id: isl.id, label: isl.label, kind: 'island', lines: isl.lines, depth: 0, children: tops.map((n) => treeOf(n, 1, fold)) };
          } else {
            const fold = isl.files > MAX_ISLAND_FILES;
            if (fold) foldedToModules += 1;
            t = treeOf(isl.art, 0, fold);
          }
          if (!t.children.length) t.children = [{ id: `${isl.id}#land`, label: isl.label, kind: 'package', lines: Math.max(1, isl.lines), depth: 1, children: [], blank: true }];
          isl.tree = t;
          if (isl.art) leafOf.set(isl.art.qid, t);
        }
        function islandOf0(n) {
          let up = n;
          while (up && !isIsland(up)) up = up.parent;
          return up ? up.qid : `${n.root}::(loose)`;
        }

        // Pack each island, then its coast: a radial outline around everything packed, with a wobble from its id.
        const radiusOf = (lines) => Math.sqrt(Math.max(lines, 8));
        for (const isl of ranked) {
          packTree(isl.tree, radiusOf);
          isl.tree.x = 0;
          isl.tree.y = 0;
          const leaves = [];
          const walk = (t, ox, oy) => {
            t.lx = ox + (t === isl.tree ? 0 : t.x);
            t.ly = oy + (t === isl.tree ? 0 : t.y);
            if (!t.children.length) leaves.push(t);
            for (const c of t.children) walk(c, t.lx, t.ly);
          };
          walk(isl.tree, 0, 0);
          isl.leaves = leaves;
          const R = isl.tree.r;
          const margin = 4 + R * 0.07;
          const h = hashId(isl.id);
          const N = 56;
          const raw = [];
          for (let i = 0; i < N; i++) {
            const th = (i / N) * 2 * Math.PI;
            const ux = Math.cos(th);
            const uy = Math.sin(th);
            let reach = R * 0.3;
            for (const l of leaves) {
              const b = l.lx * ux + l.ly * uy;
              const disc = l.r * l.r - (l.lx * l.lx + l.ly * l.ly - b * b);
              if (disc >= 0) reach = Math.max(reach, b + Math.sqrt(disc));
            }
            raw.push(reach + margin);
          }
          let sm = raw.slice();
          for (let pass = 0; pass < 3; pass++) sm = sm.map((v, i) => Math.max(raw[i], (sm[(i - 1 + N) % N] + 2 * v + sm[(i + 1) % N]) / 4));
          isl.coast = sm.map((v, i) => {
            const th = (i / N) * 2 * Math.PI;
            const wob = 1 + 0.045 * Math.sin(3 * th + (h & 63)) + 0.03 * Math.sin(7 * th + ((h >>> 6) & 63)) + 0.015 * Math.sin(13 * th + ((h >>> 12) & 63));
            return Math.max(v, v * wob);
          });
          isl.ext = Math.max(...isl.coast);
        }

        // Roads between islands, sea lanes to externals.
        const roads = new Map();
        const lanes = new Map(); // external qid -> { users: Map(island -> weight), weight }
        for (const g of graphs) {
          for (const d of g.dependencies) {
            const fq = qualify(g.source.root, d.from);
            const tq = qualify(g.source.root, d.to);
            const fi = islandOfArt.get(fq);
            if (!fi || !kept.has(fi)) continue;
            const w = d.weight || 1;
            const to = arts.get(tq);
            if (to && to.a.kind === 'external') {
              let lane = lanes.get(tq);
              if (!lane) lanes.set(tq, (lane = { id: tq, label: to.a.name, users: new Map(), weight: 0, observed: false, kinds: new Set() }));
              lane.users.set(fi, (lane.users.get(fi) || 0) + w);
              lane.weight += w;
              lane.observed = lane.observed || !d.inferred;
              lane.kinds.add(d.kind);
              continue;
            }
            const ti = islandOfArt.get(tq);
            if (!ti || ti === fi || !kept.has(ti)) continue;
            const [p, q] = fi < ti ? [fi, ti] : [ti, fi];
            const key = `${p}\u0000${q}`;
            let r = roads.get(key);
            if (!r) roads.set(key, (r = { key, a: p, b: q, weight: 0, ab: 0, ba: 0, observed: false, kinds: new Set() }));
            r.weight += w;
            if (fi === p) r.ab += w;
            else r.ba += w;
            r.observed = r.observed || !d.inferred;
            r.kinds.add(d.kind);
          }
        }
        let roadList = [...roads.values()].sort((p, q) => q.weight - p.weight || (p.key < q.key ? -1 : 1));
        const roadsFolded = Math.max(0, roadList.length - MAX_ROADS);
        roadList = roadList.slice(0, MAX_ROADS);
        let laneList = [...lanes.values()].sort((p, q) => q.weight - p.weight || (p.id < q.id ? -1 : 1));
        let lanesFolded = 0;
        if (laneList.length > MAX_LANES) {
          const rest = laneList.slice(MAX_LANES - 1);
          lanesFolded = rest.length;
          const fold = { id: '(lanes)', label: `+${rest.length} more`, users: new Map(), weight: 0, observed: true, kinds: new Set(), folded: rest };
          for (const l of rest) {
            for (const [i, w] of l.users) fold.users.set(i, (fold.users.get(i) || 0) + w);
            fold.weight += l.weight;
          }
          laneList = [...laneList.slice(0, MAX_LANES - 1), fold];
        }

        // Place the islands: the force layout over the roads, in a box sized to their area, then pushed apart until no two coasts meet.
        const list = ranked;
        const meanExt = list.reduce((s, i) => s + i.ext, 0) / Math.max(1, list.length);
        const gap = Math.max(8, meanExt * 0.22);
        const area = list.reduce((s, i) => s + Math.PI * (i.ext + gap) ** 2, 0);
        const aspect = 1.6;
        const W = Math.sqrt((area / 0.5) * aspect);
        const H = W / aspect;
        const pos = forceLayout(
          list.map((i) => ({ id: i.id, r: i.ext + gap / 2 })),
          roadList.map((r) => ({ source: r.a, target: r.b, weight: Math.sqrt(r.weight) })),
          { width: W, height: H, padding: 0, spacing: meanExt * 1.2 }
        );
        for (const i of list) Object.assign(i, pos.get(i.id) || { x: W / 2, y: H / 2 });
        for (let pass = 0; pass < 400; pass++) {
          let moved = false;
          for (let p = 0; p < list.length; p++) {
            for (let q = p + 1; q < list.length; q++) {
              const A = list[p];
              const B = list[q];
              let dx = B.x - A.x;
              let dy = B.y - A.y;
              let d = Math.hypot(dx, dy);
              const need = A.ext + B.ext + gap;
              if (d >= need) continue;
              if (d < 1e-6) {
                const ang = ((hashId(A.id + '|' + B.id) & 0xffff) / 0x10000) * 2 * Math.PI;
                dx = Math.cos(ang);
                dy = Math.sin(ang);
                d = 1;
              }
              const push = (need - d) / 2 + 0.01;
              A.x -= (dx / d) * push;
              A.y -= (dy / d) * push;
              B.x += (dx / d) * push;
              B.y += (dy / d) * push;
              moved = true;
            }
          }
          if (!moved) break;
        }
        // The map's orientation: turned by a hash of its islands, which the compass rose shows.
        const keyText = list.map((i) => i.id).sort().join('\n');
        const turn = (((hashId(keyText) & 0xffff) / 0x10000) * 2 - 1) * (Math.PI / 7);
        const cx = list.reduce((s, i) => s + i.x, 0) / Math.max(1, list.length);
        const cy = list.reduce((s, i) => s + i.y, 0) / Math.max(1, list.length);
        for (const i of list) {
          const dx = i.x - cx;
          const dy = i.y - cy;
          i.x = dx * Math.cos(turn) - dy * Math.sin(turn);
          i.y = dx * Math.sin(turn) + dy * Math.cos(turn);
        }
        // World positions of every packed node.
        for (const isl of list) {
          const walk = (t) => {
            t.wx = isl.x + t.lx;
            t.wy = isl.y + t.ly;
            t.island = isl.id;
            for (const c of t.children) walk(c);
          };
          walk(isl.tree);
        }
        const locate = (qid) => {
          const t = leafOf.get(qid);
          if (!t || t.wx === undefined) return null;
          return t;
        };

        // Pins: plan items on the code their paths name, one per item per island.
        const items = new Map();
        const kidsOfItem = new Map();
        const pins = [];
        const blocks = [];
        const epics = [];
        let unpinned = 0;
        let planItems = 0;
        if (withPlans) {
          for (const p of ws.plans || []) {
            for (const it of p.items) {
              const q = qualify(p.source.root, it.id);
              items.set(q, { qid: q, it, root: p.source.root });
            }
            for (const it of p.items) {
              if (!it.parent) continue;
              const pq = qualify(p.source.root, it.parent);
              if (!kidsOfItem.has(pq)) kidsOfItem.set(pq, []);
              kidsOfItem.get(pq).push(qualify(p.source.root, it.id));
            }
          }
          const targets = new Map();
          for (const j of (ws.joins && ws.joins.planToCode) || []) {
            if (!targets.has(j.from)) targets.set(j.from, []);
            targets.get(j.from).push(j);
          }
          for (const item of items.values()) {
            const isEpic = item.it.kind === 'epic' || item.it.kind === 'milestone';
            if (!isEpic) planItems += 1;
            const byIsland = new Map();
            for (const j of targets.get(item.qid) || []) {
              const t = locate(j.to);
              if (!t) continue;
              if (!byIsland.has(t.island)) byIsland.set(t.island, { pts: [], inferred: true });
              const g = byIsland.get(t.island);
              if (!g.pts.some((x) => x === t)) g.pts.push(t);
              g.inferred = g.inferred && !!j.inferred;
            }
            item.places = [...byIsland.entries()].map(([isl, g]) => ({ island: isl, x: g.pts.reduce((s, t) => s + t.wx, 0) / g.pts.length, y: g.pts.reduce((s, t) => s + t.wy, 0) / g.pts.length, at: g.pts.length === 1 ? g.pts[0] : null, inferred: g.inferred || item.it.confidence === 'inferred' }));
            if (isEpic) continue;
            if (!item.places.length) unpinned += 1;
            for (const pl of item.places) pins.push({ id: `${item.qid}@${pl.island}`, item, ...pl });
          }
          for (const p of ws.plans || []) {
            for (const l of p.links) {
              if (l.kind !== 'blocks') continue;
              const f = items.get(qualify(p.source.root, l.from));
              const t = items.get(qualify(p.source.root, l.to));
              if (f && t && f.places && t.places && f.places.length && t.places.length) blocks.push({ from: f, to: t, inferred: !!l.inferred || f.it.confidence === 'inferred' || t.it.confidence === 'inferred' });
            }
          }
          for (const item of items.values()) {
            if (!(item.it.kind === 'epic' || item.it.kind === 'milestone' || kidsOfItem.has(item.qid))) continue;
            const below = [];
            const walk = (q) => {
              for (const k of kidsOfItem.get(q) || []) {
                const ki = items.get(k);
                if (ki && ki.places) below.push(...ki.places);
                walk(k);
              }
            };
            walk(item.qid);
            const all = [...below, ...(item.places || [])];
            if (all.length) epics.push({ item, places: all });
          }
        }

        // Trails: each actor's path over the files its session touched, in time order.
        const trails = [];
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
              if (!exact.has(a.path)) exact.set(a.path, []);
              exact.get(a.path).push(q);
              all.push({ path: a.path, q });
            }
          }
          const names = new Map(sessions.map((s, i) => [s.summary.sessionId, { s, i }]));
          for (const [sessionId, list] of ws.touches) {
            const meta = names.get(sessionId);
            if (!meta) continue;
            const byActor = new Map();
            for (const t of list) {
              const ts = Date.parse(t.ts);
              if (!Number.isFinite(ts)) continue;
              let q = null;
              let inferred = false;
              if (t.anchored) q = (exact.get(t.path) || [])[0] || null;
              else {
                const m = all.filter((x) => x.path === t.path || x.path.endsWith('/' + t.path));
                q = m.length === 1 ? m[0].q : null;
                inferred = true;
              }
              const loc = q ? locate(q) : null;
              if (!loc) {
                unmatched += 1;
                continue;
              }
              touchCount += 1;
              const actor = t.agentId || '';
              if (!byActor.has(actor)) byActor.set(actor, []);
              byActor.get(actor).push({ t: ts, x: loc.wx, y: loc.wy, q, inferred, kind: t.kind, label: loc.label });
            }
            for (const [actor, pts] of byActor) {
              pts.sort((p, q) => p.t - q.t);
              const merged = [];
              for (const p of pts) {
                const last = merged[merged.length - 1];
                if (last && last.q === p.q) {
                  last.n += 1;
                  last.t2 = p.t;
                } else merged.push({ ...p, n: 1, t2: p.t });
              }
              trails.push({ id: `${sessionId}|${actor}`, sessionId, actor, session: meta.s, si: meta.i, pts: merged, touches: pts.length, first: pts[0].t, last: pts[pts.length - 1].t });
            }
          }
        }
        return { islands: list, kept, roads: roadList, roadsFolded, lanes: laneList, lanesFolded, foldedIslands, foldedToModules, pins, blocks, epics, unpinned, planItems, trails, touchCount, unmatched, turn, arts, total, locate, sessions, items };
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
          if (model) model.ws = ws;
          if (model && zoom && !model.kept.has(zoom)) zoom = '';
          moved = false;
          opened = null;
          clock.setSessions(model ? model.sessions : []);
          opened = clock.time;
        }
        draw();
      }

      function draw() {
        scene = null;
        if (!model) {
          const missing = !workspace || !(workspace.code || []).length ? 'No code is loaded.' : '';
          frame.replaceChildren(el('p', { class: 'at-empty', text: `${missing} The Atlas draws code as land: load a code graph (Sessions and project ↓), and plans and sessions add pins and trails to it.` }));
          note.textContent = '';
          return;
        }
        const m = model;
        const width = Math.max(320, host.clientWidth || 800);
        const height = fitter.height(Math.round(Math.min(640, Math.max(320, width * 0.62))), 300);
        const inner = { x0: MARGIN + 6, y0: MARGIN + 22, x1: width - MARGIN - 6, y1: height - MARGIN - 22 };
        const zoomed = zoom && m.kept.has(zoom) ? m.kept.get(zoom) : null;
        // The world box to show: every island, or the zoomed one.
        const box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
        for (const i of zoomed ? [zoomed] : m.islands) {
          box.x0 = Math.min(box.x0, i.x - i.ext);
          box.x1 = Math.max(box.x1, i.x + i.ext);
          box.y0 = Math.min(box.y0, i.y - i.ext);
          box.y1 = Math.max(box.y1, i.y + i.ext);
        }
        const room = { w: Math.max(40, inner.x1 - inner.x0), h: Math.max(40, inner.y1 - inner.y0 - 12) }; // 12 for the island names under the lowest coasts
        const s = Math.min(room.w / Math.max(1, box.x1 - box.x0), room.h / Math.max(1, box.y1 - box.y0));
        const ox = inner.x0 + (room.w - (box.x1 - box.x0) * s) / 2 - box.x0 * s;
        const oy = inner.y0 + (room.h - (box.y1 - box.y0) * s) / 2 - box.y0 * s;
        const X = (x) => ox + x * s;
        const Y = (y) => oy + y * s;
        const f1 = (v) => v.toFixed(1);
        const sel = selection;
        const on = (id) => !!sel && (sel.artifactId === id || sel.itemId === id);

        const root = svg('svg', {
          class: 'at-svg',
          width,
          height,
          viewBox: `0 0 ${width} ${height}`,
          role: 'img',
          'aria-label': `Atlas of ${m.islands.length} packages as islands${zoomed ? `, zoomed to ${zoomed.label}` : ''}: ${m.roads.length} roads, ${m.lanes.length} sea lanes${m.pins.length ? `, ${m.pins.length} pins` : ''}${m.trails.length ? `, ${m.trails.length} trails` : ''}`,
        });
        const defs = svg('defs');
        const hatch = svg('pattern', { id: `${prefix}-sea`, width: 8, height: 8, patternUnits: 'userSpaceOnUse' });
        hatch.append(svg('line', { class: 'at-hatch', x1: 0, y1: 4, x2: 8, y2: 4 }));
        defs.append(hatch);
        const clipRect = svg('clipPath', { id: `${prefix}-clip` });
        clipRect.append(svg('rect', { x: MARGIN, y: MARGIN, width: width - 2 * MARGIN, height: height - 2 * MARGIN }));
        defs.append(clipRect);
        root.append(defs);
        root.append(svg('rect', { class: 'at-paper', x: 0, y: 0, width, height }));
        root.append(svg('rect', { class: 'at-sea', x: MARGIN, y: MARGIN, width: width - 2 * MARGIN, height: height - 2 * MARGIN }));
        root.append(svg('rect', { x: MARGIN, y: MARGIN, width: width - 2 * MARGIN, height: height - 2 * MARGIN, fill: `url(#${prefix}-sea)` }));
        const map = svg('g', { 'clip-path': `url(#${prefix}-clip)` });
        root.append(map);
        const layer = () => {
          const g = svg('g');
          map.append(g);
          return g;
        };
        const laneLayer = layer();
        const roadLayer = layer();
        const landLayer = layer();
        const routeLayer = layer();
        const trailLayer = layer();
        const pinLayer = layer();
        const labelLayer = layer();

        // Sea lanes: from each island that uses an external to a point on the margin in that direction.
        const centerX = X(m.islands.reduce((a, i) => a + i.x, 0) / m.islands.length);
        const centerY = Y(m.islands.reduce((a, i) => a + i.y, 0) / m.islands.length);
        const edge = { x0: MARGIN + 4, y0: MARGIN + 4, x1: width - MARGIN - 4, y1: height - MARGIN - 4 };
        const ew = edge.x1 - edge.x0;
        const eh = edge.y1 - edge.y0;
        const perim = 2 * (ew + eh);
        const toPerim = (dx, dy) => {
          // The ray from the map's middle in (dx, dy) to the edge box, as a distance around the box from its top-left corner.
          const tx = dx > 0 ? (edge.x1 - centerX) / dx : dx < 0 ? (edge.x0 - centerX) / dx : Infinity;
          const ty = dy > 0 ? (edge.y1 - centerY) / dy : dy < 0 ? (edge.y0 - centerY) / dy : Infinity;
          const t = Math.max(0, Math.min(tx, ty));
          const px = Math.min(edge.x1, Math.max(edge.x0, centerX + dx * t));
          const py = Math.min(edge.y1, Math.max(edge.y0, centerY + dy * t));
          if (Math.abs(py - edge.y0) < 0.5) return px - edge.x0;
          if (Math.abs(px - edge.x1) < 0.5) return ew + (py - edge.y0);
          if (Math.abs(py - edge.y1) < 0.5) return ew + eh + (edge.x1 - px);
          return 2 * ew + eh + (edge.y1 - py);
        };
        const fromPerim = (u) => {
          u = ((u % perim) + perim) % perim;
          if (u < ew) return { x: edge.x0 + u, y: edge.y0, side: 'top' };
          if (u < ew + eh) return { x: edge.x1, y: edge.y0 + (u - ew), side: 'right' };
          if (u < 2 * ew + eh) return { x: edge.x1 - (u - ew - eh), y: edge.y1, side: 'bottom' };
          return { x: edge.x0, y: edge.y1 - (u - 2 * ew - eh), side: 'left' };
        };
        const ports = m.lanes.map((l) => {
          let wx = 0;
          let wy = 0;
          let w = 0;
          for (const [i, k] of l.users) {
            const isl = m.kept.get(i);
            if (!isl) continue;
            wx += X(isl.x) * k;
            wy += Y(isl.y) * k;
            w += k;
          }
          let dx = w ? wx / w - centerX : 0;
          let dy = w ? wy / w - centerY : 0;
          if (Math.hypot(dx, dy) < 1) {
            const a = ((hashId(l.id) & 0xffff) / 0x10000) * 2 * Math.PI;
            dx = Math.cos(a);
            dy = Math.sin(a);
          }
          return { lane: l, u: toPerim(dx, dy) };
        });
        ports.sort((p, q) => p.u - q.u);
        // Spread the ports along the edge so their names don't meet (a name along the top or bottom needs its width),
        // and keep them off the compass rose's corner.
        const roseCorner = [ew - 56, ew + 56];
        const nameW = (l) => Math.min(110, fitText(l.label, 110).length * 5.6) + 10;
        const squeeze = Math.min(1, perim / Math.max(1, ports.reduce((a, p) => a + nameW(p.lane), 0) + 112));
        for (let i = 0; i < ports.length; i++) {
          const p = ports[i];
          if (i > 0) {
            const prev = ports[i - 1];
            const side = fromPerim(prev.u).side;
            const need = (side === 'top' || side === 'bottom' ? (nameW(prev.lane) + nameW(p.lane)) / 2 : 16) * squeeze;
            if (p.u - prev.u < need) p.u = prev.u + need;
          }
          if (p.u > roseCorner[0] && p.u < roseCorner[1]) p.u = roseCorner[1];
        }
        for (const p of ports) {
          const at = fromPerim(p.u);
          const l = p.lane;
          // From the islands that use it most, so a common external doesn't web the whole sea.
          const from = [...l.users.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, LANE_SOURCES);
          for (const [i] of from) {
            const isl = m.kept.get(i);
            if (!isl) continue;
            laneLayer.append(svg('line', { class: `at-lane${l.observed ? '' : ' at-unsurveyed'}`, x1: f1(X(isl.x)), y1: f1(Y(isl.y)), x2: f1(at.x), y2: f1(at.y) }));
          }
          const g = svg('g', { class: `at-port${on(l.id) ? ' at-on' : ''}` });
          g.append(svg('circle', { class: 'at-port-mark', cx: f1(at.x), cy: f1(at.y), r: 2.5 }));
          const anchor = at.side === 'left' ? 'start' : at.side === 'right' ? 'end' : 'middle';
          const tx = at.side === 'left' ? at.x + 6 : at.side === 'right' ? at.x - 6 : at.x;
          const ty = at.side === 'top' ? at.y + 12 : at.side === 'bottom' ? at.y - 6 : at.y + 3;
          g.append(svgText({ class: 'at-port-name', x: f1(tx), y: f1(ty), 'text-anchor': anchor }, fitText(l.label, at.side === 'top' || at.side === 'bottom' ? 110 : 96)));
          const users = [...l.users.entries()].map(([i, w]) => `${(m.kept.get(i) || { label: i }).label} (${fmt(w)})`);
          interact(ctx, g, {
            label: `External ${l.label}`,
            tip: () => [l.label, ['Kind', l.folded ? `${l.folded.length} externals, folded` : 'external'], ['Imported by', clip(users.join(', '), 160)], ['Weight', fmt(l.weight)], ...(l.observed ? [] : ['Unsurveyed: every link to it was inferred'])],
            pick: l.folded ? undefined : () => ctx.select({ artifactId: l.id }),
          });
          labelLayer.append(g);
        }

        // Roads: a curve between two islands, bent toward the middle of the map so roads bundle there; width by import weight.
        const maxW = Math.max(1, ...m.roads.map((r) => r.weight));
        if (shown.roads) {
          for (const r of m.roads) {
            const A = m.kept.get(r.a);
            const B = m.kept.get(r.b);
            const ax = X(A.x);
            const ay = Y(A.y);
            const bx = X(B.x);
            const by = Y(B.y);
            const mx = (ax + bx) / 2;
            const my = (ay + by) / 2;
            const qx = mx + (centerX - mx) * 0.35;
            const qy = my + (centerY - my) * 0.35;
            const w = 1 + 4.5 * Math.sqrt(r.weight / maxW);
            const d = `M${f1(ax)} ${f1(ay)} Q${f1(qx)} ${f1(qy)} ${f1(bx)} ${f1(by)}`;
            const g = svg('g', { class: `at-road-g${r.observed ? '' : ' at-unsurveyed'}` });
            g.append(svg('path', { class: 'at-road', d, 'stroke-width': f1(w) }));
            if (w >= 3) g.append(svg('path', { class: 'at-road-core', d, 'stroke-width': f1(w - 2) }));
            g.append(svg('path', { class: 'at-hit', d, 'stroke-width': Math.max(8, w + 4) }));
            interact(ctx, g, {
              label: `Road between ${A.label} and ${B.label}`,
              tip: () => [`${A.label} ⇄ ${B.label}`, ['Weight', fmt(r.weight)], [`${clip(A.label, 18)} → ${clip(B.label, 18)}`, fmt(r.ab)], [`${clip(B.label, 18)} → ${clip(A.label, 18)}`, fmt(r.ba)], ['Kinds', [...r.kinds].join(', ')], ...(r.observed ? [] : ['Unsurveyed: every dependency on it was inferred'])],
              pick: (A.art || B.art) ? () => ctx.select({ artifactId: ((r.ab >= r.ba && A.art) || !B.art ? A : B).art.qid }) : undefined,
            });
            roadLayer.append(g);
          }
        }

        // Islands: a coast, the packed modules as faint regions, the files as contour rings.
        for (const isl of m.islands) {
          const N = isl.coast.length;
          const pts = isl.coast.map((rr, i) => {
            const th = (i / N) * 2 * Math.PI;
            return { x: X(isl.x + Math.cos(th) * rr), y: Y(isl.y + Math.sin(th) * rr) };
          });
          const d = smoothClosed(pts);
          const g = svg('g', { class: `at-island${isl.loose ? ' at-unsurveyed' : ''}${isl.art && on(isl.art.qid) ? ' at-on' : ''}` });
          g.append(svg('path', { class: 'at-shoal', d }));
          const land = svg('path', { class: 'at-land', d });
          g.append(land);
          const fileCount = isl.files;
          interact(ctx, land, {
            label: `Island ${isl.label}`,
            tip: () => [isl.label, ['Kind', isl.other ? `${m.foldedIslands.length} small packages, folded` : isl.loose ? 'files outside any package' : (isl.art && isl.art.a.kind) || 'package'], ['Lines', fmt(isl.lines)], ['Files', fmt(fileCount)], ...(isl.art ? [['Fan-in', fmt(isl.art.fanIn)], ['Fan-out', fmt(isl.art.fanOut)]] : []), ...(isl.loose && !isl.other ? ['Unsurveyed: no package was read for these files'] : [])],
            pick: isl.art ? () => ctx.select({ artifactId: isl.art.qid }) : undefined,
          });
          // Module regions and file contours.
          const walk = (t, depth) => {
            const r = t.r * s;
            if (t.children.length) {
              if (depth >= 1 && r > 6) g.append(svg('circle', { class: `at-region${on(t.id) ? ' at-on' : ''}`, cx: f1(X(t.wx)), cy: f1(Y(t.wy)), r: f1(r) }));
              if (zoomed === isl && depth >= 1 && r > 26) g.append(svgText({ class: 'at-region-name', x: f1(X(t.wx)), y: f1(Y(t.wy) - r + 9), 'text-anchor': 'middle' }, fitText(t.label, r * 1.6)));
              for (const c of t.children) walk(c, depth + 1);
              return;
            }
            if (t.blank) return;
            const lines = t.lines || 0;
            const rings = Math.max(1, Math.min(6, 1 + Math.floor(Math.log2(Math.max(1, lines) / 40))));
            const fg = svg('g', { class: `at-file${t.kind !== 'file' ? ' at-folded' : ''}${on(t.id) ? ' at-on' : ''}` });
            const cx = X(t.wx);
            const cy = Y(t.wy);
            fg.append(svg('circle', { class: 'at-file-ground', cx: f1(cx), cy: f1(cy), r: f1(Math.max(1, r)) }));
            for (let k = 0; k < rings; k++) {
              const rk = r * (1 - k / rings);
              if (rk < 1.2) break;
              fg.append(svg('circle', { class: `at-contour${k === 0 ? ' at-contour-0' : ''}`, cx: f1(cx), cy: f1(cy), r: f1(rk) }));
            }
            const shortName = zoomed === isl && r > 18 ? fitText(t.label, r * 1.8) : '';
            if (shortName && (shortName === t.label || shortName.length >= 6)) fg.append(svgText({ class: 'at-file-name', x: f1(cx), y: f1(cy + 3), 'text-anchor': 'middle' }, shortName));
            const art = t.art;
            interact(ctx, fg, {
              label: `${t.kind === 'file' ? 'File' : t.folded ? 'Package' : 'Module'} ${t.label}: ${fmt(lines)} lines`,
              tip: () => [
                t.label,
                ...(art && art.a.path ? [['Path', clip(art.a.path, 60)]] : []),
                ['Kind', t.kind === 'file' ? (art && art.a.role) || 'file' : `${t.kind}, ${fmt(t.files || 0)} files folded`],
                ['Lines', fmt(lines)],
                ...(art ? [['Fan-in', fmt(art.fanIn)], ['Fan-out', fmt(art.fanOut)]] : []),
                ['Contours', `${rings}`],
              ],
              pick: art ? () => ctx.select({ artifactId: t.id }) : undefined,
            });
            g.append(fg);
          };
          for (const c of isl.tree.children) walk(c, 1);
          g.append(svg('path', { class: 'at-coast', d }));
          landLayer.append(g);
          // The island's name, under its coast; clicking it zooms to the island, or back out.
          const bottom = Y(isl.y) + Math.max(...isl.coast.filter((_, i) => Math.sin((i / N) * 2 * Math.PI) > 0.5).map((rr) => rr * s), isl.ext * s * 0.6);
          const ly = Math.min(height - MARGIN - 8, bottom + 12);
          const name = svgText({ class: `at-island-name${zoom === isl.id ? ' at-zoomed' : ''}`, x: f1(X(isl.x)), y: f1(ly), 'text-anchor': 'middle' }, fitText(isl.label.toUpperCase(), Math.max(70, isl.ext * s * 2.4)));
          interact(ctx, name, {
            label: zoom === isl.id ? `Zoom out from ${isl.label}` : `Zoom to ${isl.label}`,
            tip: () => [isl.label, zoom === isl.id ? 'Click to see the whole map' : 'Click to zoom to this island'],
            pick: () => setZoom(zoom === isl.id ? '' : isl.id),
          });
          labelLayer.append(name);
        }

        // Pins, clustered past the limit per island; routes for blocks; epics as region labels.
        const pinAt = new Map(); // item qid -> screen point of its first pin (or cluster)
        const pinParts = [];
        if (shown.pins && m.pins.length) {
          const limit = zoomed ? MAX_PINS * 4 : MAX_PINS;
          const byIsland = new Map();
          for (const p of m.pins) {
            if (!byIsland.has(p.island)) byIsland.set(p.island, []);
            byIsland.get(p.island).push(p);
          }
          const crowd = new Map(); // a rounded screen point -> pins there so far
          for (const [islId, list] of byIsland) {
            const isl = m.kept.get(islId);
            if (list.length > limit) {
              const x = list.reduce((a, p) => a + X(p.x), 0) / list.length;
              const y = list.reduce((a, p) => a + Y(p.y), 0) / list.length;
              const g = svg('g', { class: 'at-cluster' });
              g.append(svg('circle', { class: 'at-cluster-disc', cx: f1(x), cy: f1(y), r: 9 }));
              g.append(svgText({ class: 'at-cluster-n', x: f1(x), y: f1(y + 3.5), 'text-anchor': 'middle' }, String(list.length)));
              interact(ctx, g, {
                label: `${list.length} plan items on ${isl.label}`,
                tip: () => [`${list.length} plan items on ${isl.label}`, ...list.slice(0, 8).map((p) => `${STATUS_TEXT[p.item.it.status] || p.item.it.status} · ${clip(p.item.it.title, 48)}`), ...(list.length > 8 ? [`and ${list.length - 8} more; click to zoom`] : ['Click to zoom'])],
                pick: () => setZoom(islId),
              });
              pinLayer.append(g);
              for (const p of list) if (!pinAt.has(p.item.qid)) pinAt.set(p.item.qid, { x, y });
              continue;
            }
            for (const p of list) {
              const k = `${Math.round(X(p.x) / 4)},${Math.round(Y(p.y) / 4)}`;
              const nth = crowd.get(k) || 0;
              crowd.set(k, nth + 1);
              const x = X(p.x) + (nth ? (nth % 2 ? 1 : -1) * Math.ceil(nth / 2) * 7 : 0);
              const y = Y(p.y);
              const it = p.item.it;
              const g = svg('g', { class: `at-pin${p.inferred ? ' at-unsurveyed' : ''}${on(p.item.qid) ? ' at-on' : ''}` });
              const head = svg('path', { class: `at-pin-head at-st-${it.status}`, d: `M${f1(x)} ${f1(y)} l-4.5 -9 a5.2 5.2 0 1 1 9 0 z` });
              g.append(head);
              const where = p.at ? p.at.label : `${isl.label}`;
              interact(ctx, g, {
                label: `${it.title}: ${STATUS_TEXT[it.status] || it.status}`,
                tip: () => [clip(it.title, 80), ['Item', `${it.id} · ${it.kind}`], ['Status', STATUS_TEXT[it.status] || it.status], ['On', clip(where, 48)], ...(p.inferred ? ['Unsurveyed: the item or its link to the code was inferred'] : [])],
                pick: () => ctx.select({ itemId: p.item.qid }),
              });
              pinLayer.append(g);
              pinParts.push({ head, g, item: p.item });
              if (!pinAt.has(p.item.qid)) pinAt.set(p.item.qid, { x, y: y - 9 });
            }
          }
          for (const b of m.blocks) {
            const a = pinAt.get(b.from.qid);
            const c = pinAt.get(b.to.qid);
            if (!a || !c || (Math.abs(a.x - c.x) < 1 && Math.abs(a.y - c.y) < 1)) continue;
            const dx = c.x - a.x;
            const dy = c.y - a.y;
            const len = Math.hypot(dx, dy) || 1;
            const bow = (hashId(b.from.qid + b.to.qid) % 2 ? 1 : -1) * Math.min(40, len * 0.2);
            const qx = (a.x + c.x) / 2 - (dy / len) * bow;
            const qy = (a.y + c.y) / 2 + (dx / len) * bow;
            const d = `M${f1(a.x)} ${f1(a.y)} Q${f1(qx)} ${f1(qy)} ${f1(c.x)} ${f1(c.y)}`;
            const g = svg('g', { class: `at-route-g${b.inferred ? ' at-unsurveyed' : ''}` });
            g.append(svg('path', { class: 'at-route', d }), svg('path', { class: 'at-hit', d, 'stroke-width': 8 }));
            interact(ctx, g, {
              label: `${b.from.it.title} blocks ${b.to.it.title}`,
              tip: () => [`${clip(b.from.it.title, 50)}`, 'blocks', `${clip(b.to.it.title, 50)}`, ...(b.inferred ? ['Unsurveyed: inferred'] : [])],
              pick: () => ctx.select({ itemId: b.from.qid }),
            });
            routeLayer.append(g);
          }
          // Epics: a small-caps label over the middle of their items' pins, nudged so labels don't stack.
          const placed = [];
          const epics = m.epics
            .map((e) => ({ e, places: zoomed ? e.places.filter((p) => p.island === zoomed.id) : e.places }))
            .filter((l) => l.places.length)
            .map(({ e, places }) => ({ e, x: places.reduce((a, p) => a + X(p.x), 0) / places.length, y: places.reduce((a, p) => a + Y(p.y), 0) / places.length - 18 }))
            .sort((p, q) => p.y - q.y);
          for (const lab of epics) {
            const text = fitText(lab.e.item.it.title.toUpperCase(), 190);
            const w = text.length * 7.2;
            let y = Math.max(MARGIN + 30, Math.min(height - MARGIN - 30, lab.y));
            const x = Math.max(MARGIN + w / 2 + 4, Math.min(width - MARGIN - w / 2 - 4, lab.x));
            for (let tries = 0; tries < 12 && placed.some((p) => Math.abs(p.x - x) < (p.w + w) / 2 && Math.abs(p.y - y) < 12); tries++) y += 13;
            placed.push({ x, y, w });
            const it = lab.e.item.it;
            const t = svgText({ class: `at-epic${on(lab.e.item.qid) ? ' at-on' : ''}`, x: f1(x), y: f1(y), 'text-anchor': 'middle' }, text);
            interact(ctx, t, {
              label: `Epic ${it.title}`,
              tip: () => [it.title, ['Item', `${it.id} · ${it.kind}`], ['Status', STATUS_TEXT[it.status] || it.status], ['Pins under it', fmt(lab.e.places.length)]],
              pick: () => ctx.select({ itemId: lab.e.item.qid }),
            });
            labelLayer.append(t);
          }
        }

        // Trails: one path per actor, a segment per hop between files; the replay sets which show and how bright.
        const trailParts = [];
        if (shown.trails && m.trails.length) {
          for (const tr of m.trails) {
            const segs = [];
            const tsel = !!sel && sel.sessionId === tr.sessionId;
            for (let i = 1; i < tr.pts.length; i++) {
              const a = tr.pts[i - 1];
              const b = tr.pts[i];
              const ax = X(a.x);
              const ay = Y(a.y);
              const bx = X(b.x);
              const by = Y(b.y);
              const len = Math.hypot(bx - ax, by - ay) || 1;
              const bend = ((hashId(tr.id + i) % 2 ? 1 : -1) * Math.min(24, len * 0.18));
              const qx = (ax + bx) / 2 - ((by - ay) / len) * bend;
              const qy = (ay + by) / 2 + ((bx - ax) / len) * bend;
              const p = svg('path', { class: `at-trail${a.inferred || b.inferred ? ' at-unsurveyed' : ''}${tsel ? ' at-on' : ''}`, d: `M${f1(ax)} ${f1(ay)} Q${f1(qx)} ${f1(qy)} ${f1(bx)} ${f1(by)}`, visibility: 'hidden' });
              trailLayer.append(p);
              segs.push({ p, t: b.t });
            }
            const headDot = svg('circle', { class: `at-trail-head${tsel ? ' at-on' : ''}`, r: 3, cx: 0, cy: 0, visibility: 'hidden' });
            const name = sessionName(tr.session.summary, 40);
            interact(ctx, headDot, {
              label: `Trail of ${name}`,
              tip: () => [name, ['Actor', tr.actor ? `subagent ${tr.actor.replace(/^agent-/, '').slice(0, 8)}` : agentName(tr.session.summary.agent)], ['Files touched', fmt(tr.pts.length)], ['Touches', fmt(tr.touches)], ['From', formatTime(new Date(tr.first).toISOString())], ['To', formatTime(new Date(tr.last).toISOString())]],
              pick: () => ctx.select({ sessionId: tr.sessionId }),
            });
            for (const sg of segs) {
              interact(ctx, sg.p, {
                label: `Trail of ${name}`,
                tip: () => [name, ['Files touched', fmt(tr.pts.length)], ['Touches', fmt(tr.touches)]],
                pick: () => ctx.select({ sessionId: tr.sessionId }),
              });
            }
            trailLayer.append(headDot);
            trailParts.push({ tr, segs, headDot, X, Y });
          }
        }

        // The furniture: neatline, cartouche, scale bar, compass rose.
        root.append(svg('rect', { class: 'at-neat', x: MARGIN, y: MARGIN, width: width - 2 * MARGIN, height: height - 2 * MARGIN }));
        root.append(svg('rect', { class: 'at-neat-outer', x: MARGIN - 4, y: MARGIN - 4, width: width - 2 * MARGIN + 8, height: height - 2 * MARGIN + 8 }));
        const roots = [...new Set((workspace.code || []).map((g) => g.source.root))];
        root.append(svgText({ class: 'at-cartouche', x: MARGIN, y: MARGIN - 9 }, fitText(`ATLAS OF ${roots.join(' · ').toUpperCase()}${zoomed ? ` · ${zoomed.label.toUpperCase()}` : ''}`, width * 0.6)));
        root.append(svgText({ class: 'at-cartouche at-cartouche-r', x: width - MARGIN, y: height - MARGIN + 16, 'text-anchor': 'end' }, `${m.islands.length} ISLANDS · ${compact(m.islands.reduce((a, i) => a + i.lines, 0))} LINES`));
        // Scale: a bar as long as a file of N lines is wide.
        const lenOf = (L) => 2 * Math.sqrt(L) * s;
        let L = NICE[0];
        for (const n of NICE) if (lenOf(n) <= 110) L = n;
        const sl = lenOf(L);
        const sx = MARGIN;
        const sy = height - MARGIN + 13;
        const scale = svg('g', { class: 'at-scale' });
        scale.append(svg('line', { x1: f1(sx), y1: sy, x2: f1(sx + sl), y2: sy }), svg('line', { x1: f1(sx), y1: sy - 3, x2: f1(sx), y2: sy + 3 }), svg('line', { x1: f1(sx + sl), y1: sy - 3, x2: f1(sx + sl), y2: sy + 3 }));
        scale.append(svgText({ class: 'at-scale-text', x: f1(sx + sl + 6), y: sy + 3 }, `a ${compact(L)}-line file, across`));
        interact(ctx, scale, { tip: () => ['Scale', `The bar is as wide as a file of ${fmt(L)} lines is drawn: a file’s circle has area by its lines.`] });
        root.append(scale);
        const rx = width - MARGIN - 24;
        const ry = MARGIN + 24;
        const rose = svg('g', { class: 'at-rose', transform: `translate(${f1(rx)} ${f1(ry)}) rotate(${f1((m.turn * 180) / Math.PI)})` });
        rose.append(svg('circle', { class: 'at-rose-ring', r: 13 }), svg('path', { class: 'at-rose-n', d: 'M0 -15 L3.5 0 L0 15 L-3.5 0 Z' }), svg('path', { class: 'at-rose-s', d: 'M0 0 L3.5 0 L0 15 L-3.5 0 Z' }), svgText({ class: 'at-rose-text', x: 0, y: -18, 'text-anchor': 'middle' }, 'N'));
        interact(ctx, rose, { tip: () => ['Compass rose', 'The layout’s own north: the map is turned by a hash of its packages, so it lands the same way each visit.'] });
        root.append(rose);

        // Controls: toggles, zoom, replay.
        const toggle = (key, text, has) => {
          const b = el('button', { class: `at-toggle at-toggle-${key}`, text, 'aria-pressed': String(shown[key] && has), disabled: !has, title: has ? `Show or hide the ${text.toLowerCase()}` : `No ${text.toLowerCase()} in what’s loaded` });
          b.addEventListener('click', () => {
            if (!has) return;
            shown[key] = !shown[key];
            draw();
          });
          return b;
        };
        const zoomSel = el('select', { class: 'at-zoom', 'aria-label': 'Zoom to an island' }, [el('option', { value: '', text: 'Whole map' }), ...m.islands.map((i) => el('option', { value: i.id, text: clip(i.label, 32) }))]);
        zoomSel.value = zoom;
        zoomSel.addEventListener('change', () => setZoom(zoomSel.value));
        const controls = el('div', { class: 'at-controls', role: 'group', 'aria-label': 'Atlas layers and zoom' }, [
          el('span', { class: 'at-caps', text: 'Layers' }),
          toggle('roads', 'Roads', m.roads.length > 0),
          toggle('pins', 'Pins', m.pins.length > 0),
          toggle('trails', 'Trails', m.trails.length > 0),
          el('span', { class: 'at-caps', text: 'Zoom' }),
          zoomSel,
        ]);
        const legend = el('div', { class: 'at-legend' }, legendKeys(m));
        frame.replaceChildren(root, el('div', { class: 'at-foot' }, [...(clock.events.length ? [bar.element] : []), controls]), legend);
        scene = { trailParts, pinParts };
        paintFrame();
        note.textContent = noteText(m);
        fitter.settle(height, draw);
      }

      function legendKeys(m) {
        const key = (cls, text) => el('span', { class: 'at-key' }, [el('span', { class: `at-sw ${cls}` }), text]);
        const keys = [key('at-sw-land', 'package (island)'), key('at-sw-contour', 'file: more rings, more lines')];
        if (m.roads.length) keys.push(key('at-sw-road', 'road: imports between packages'));
        if (m.lanes.length) keys.push(key('at-sw-lane', 'sea lane: to an external'));
        const statuses = [...new Set(m.pins.map((p) => p.item.it.status))];
        for (const st of ['open', 'in_progress', 'blocked', 'done', 'deferred', 'dropped']) if (statuses.includes(st)) keys.push(key(`at-sw-pin at-st-${st}`, STATUS_TEXT[st]));
        if (m.blocks.length) keys.push(key('at-sw-route', 'blocks'));
        if (m.trails.length) keys.push(key('at-sw-trail', 'trail: a session’s path'));
        const unsurveyed = m.islands.some((i) => i.loose) || m.roads.some((r) => !r.observed) || m.lanes.some((l) => !l.observed) || m.pins.some((p) => p.inferred) || m.blocks.some((b) => b.inferred) || m.trails.some((t) => t.pts.some((p) => p.inferred));
        if (unsurveyed) keys.push(key('at-sw-unsurveyed', 'unsurveyed (inferred)'));
        return keys;
      }

      function noteText(m) {
        const ws = workspace;
        const parts = [
          'Each package is an island, placed by a force layout over the imports between packages, so islands that depend on each other are neighbors: closeness here is dependency, not similar names. An island’s coast wraps a circle packing of its modules and files; a file’s circle has area by its lines, and a bigger file has more contour rings. Roads join packages that import each other, wider for more imports, bent toward the middle so they bundle; dotted sea lanes run to the externals at the margin.',
        ];
        const missing = [];
        if (subject === 'code') parts.push('Drawing code alone; switch Draw to Workspace for pins and trails.');
        else {
          if (!(ws.plans || []).length) missing.push('no plan is loaded, so there are no pins');
          else if (!m.pins.length) missing.push(m.planItems ? 'no plan item names a file or folder in the loaded code, so there are no pins' : 'the loaded plan has no items, so there are no pins');
          else {
            parts.push(`Pins are plan items on the files or folders they name, hue by status; epics are the small-caps labels over their items; dashed routes are blocks.${m.unpinned ? ` ${fmt(m.unpinned)} of ${fmt(m.planItems)} items name no loaded code and have no pin.` : ''}`);
          }
          if (!(ws.sessions || []).length) missing.push('no sessions are loaded, so there are no trails');
          else if (!m.trails.length) missing.push('the loaded sessions’ events carry no file targets that match this code (the demo traces are redacted), so there are no trails');
          else parts.push(`Trails are each actor’s path over the files its session read or edited, ${fmt(m.touchCount)} touches; as the sessions replay a trail is drawn bright and fades to a faint wake, so the end of the replay is the long exposure.${m.unmatched ? ` ${fmt(m.unmatched)} touches matched no loaded file.` : ''} Pins take their state at the replay’s time (open until closed) and their current state at the end.`);
          if (missing.length) parts.push(`Missing: ${missing.join('; ')}.`);
        }
        const folds = [];
        if (m.foldedIslands.length) folds.push(`the ${fmt(m.foldedIslands.length)} smallest packages fold into one island past ${MAX_ISLANDS}`);
        if (m.foldedToModules) folds.push(`${fmt(m.foldedToModules)} island${m.foldedToModules === 1 ? '' : 's'} with more than ${MAX_ISLAND_FILES} files draw${m.foldedToModules === 1 ? 's' : ''} modules instead of files`);
        if (m.roadsFolded) folds.push(`the lightest ${fmt(m.roadsFolded)} roads are left off past ${MAX_ROADS}`);
        if (m.lanes.some((l) => l.users.size > LANE_SOURCES)) folds.push(`a sea lane is drawn from the ${LANE_SOURCES} islands that use its external most (its tip names them all)`);
        if (m.lanesFolded) folds.push(`${fmt(m.lanesFolded)} externals share one lane past ${MAX_LANES}`);
        if (m.pins.length && [...groupCount(m.pins).values()].some((n) => n > MAX_PINS)) folds.push(`an island with more than ${MAX_PINS} pins shows a numbered marker until you zoom`);
        if (m.trails.length > MAX_TRAILS) folds.push(`only the ${MAX_TRAILS} most recent trails are bright at once`);
        if (folds.length) parts.push(`To keep it readable, ${folds.join('; ')}.`);
        parts.push('Dashed is unsurveyed: inferred links, and files read without a package. The scale bar is in lines; the compass rose is the layout’s own turn, fixed by hashing. Click a file, an island, or an external to select it, a pin or epic for its item, a trail for its session; click an island’s name to zoom.');
        return parts.join(' ');
      }
      function groupCount(pins) {
        const c = new Map();
        for (const p of pins) c.set(p.island, (c.get(p.island) || 0) + 1);
        return c;
      }

      /** The replay's picture at the clock's time: which trail segments show, how bright, and each pin's state then. */
      function paintFrame() {
        bar.sync();
        if (!scene) return;
        // Until the clock first moves, the map rests on its long exposure: every trail drawn, faint.
        if (clock.playing || (opened !== null && clock.time !== opened)) moved = true;
        const replaying = clock.events.length > 0 && moved;
        const T = replaying ? clock.time : Infinity;
        const span = Math.max(1, clock.end - clock.start);
        const fade = span * FADE_SHARE;
        // Trails in flight: the actors most recently active before T; the rest rest faint.
        const live = scene.trailParts.filter((p) => p.tr.first <= T).sort((a, b) => lastBefore(b.tr, T) - lastBefore(a.tr, T));
        const bright = new Set(live.slice(0, MAX_TRAILS));
        for (const part of scene.trailParts) {
          let lastPt = null;
          for (let i = 0; i < part.segs.length; i++) {
            const sg = part.segs[i];
            if (sg.t > T) {
              sg.p.setAttribute('visibility', 'hidden');
              continue;
            }
            const age = T - sg.t;
            const op = replaying && bright.has(part) && age < fade ? 0.25 + 0.7 * (1 - age / fade) : 0.22;
            sg.p.setAttribute('visibility', 'visible');
            sg.p.setAttribute('stroke-opacity', op.toFixed(2));
          }
          for (const pt of part.tr.pts) if (pt.t <= T) lastPt = pt;
          if (lastPt && bright.has(part)) {
            part.headDot.setAttribute('cx', part.X(lastPt.x).toFixed(1));
            part.headDot.setAttribute('cy', part.Y(lastPt.y).toFixed(1));
            const age = T - lastPt.t2;
            part.headDot.setAttribute('visibility', 'visible');
            part.headDot.setAttribute('fill-opacity', (replaying && Number.isFinite(age) && age < fade ? 0.35 + 0.65 * (1 - age / fade) : 0.35).toFixed(2));
          } else part.headDot.setAttribute('visibility', 'hidden');
        }
        // Pins: during the replay, an item not yet created is a ghost, and one closed later is still open.
        const during = replaying && !clock.atEnd();
        for (const p of scene.pinParts) {
          const it = p.item.it;
          let st = it.status;
          let ghost = false;
          if (during) {
            const created = it.created ? Date.parse(it.created) : NaN;
            const closed = it.closed ? Date.parse(it.closed) : NaN;
            if (Number.isFinite(created) && created > T) ghost = true;
            else if ((st === 'done' || st === 'dropped') && Number.isFinite(closed) && closed > T) st = 'open';
          }
          p.head.setAttribute('class', `at-pin-head at-st-${st}`);
          p.g.classList.toggle('at-ghost', ghost);
        }
      }
      function lastBefore(tr, T) {
        let t = -Infinity;
        for (const p of tr.pts) if (p.t <= T) t = p.t2;
        return t;
      }

      function setZoom(id) {
        zoom = id;
        ctx.hideTip();
        draw();
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
