// Transit map (hero view, design language `transit`): the plan drawn as a
// metro map over the districts of the code it runs through. Each epic (or, for
// a markdown plan, each document) is a line in its own color; its items are
// stations in order of dependency depth, then creation. An item under two
// epics is a station on both lines, and an item linked by `blocks` to an item
// on another line is an interchange too; both are drawn with an ink ring and a
// transfer between them (explicit links only, nothing guessed). A station's
// ring is its status: hollow open, half in progress, filled done, crossed
// dropped, barred blocked, paused deferred. Under the lines, districts: the
// packages the stations name (workspace.joins.planToCode), shaded faintly and
// named. With sessions, each session is a train that stops at the items it
// mentions (workspace.joins.planToSession) as the replay runs, and waits in
// the depot otherwise. See docs/workspace-explorer.md, "Transit map".
//
// Lines are routed octilinearly by a simple heuristic, not an optimizer: each
// line has a lane of its own, stations sit at equal steps along it, and the
// line drifts up or down a step at 45° where a hash of its id says so; its
// first column is hashed too. So the map is the same each visit, and
// distances mean nothing, as the note says. The layout is built once per
// change in the data; resizing rescales it, and replay moves only the trains
// and the stations' state. Clicking a station or a line announces
// { itemId }, a district { artifactId }, a train { sessionId }. Sees only its
// host and ctx: no VS Code.
(function () {
  const MAX_LINES = 10; // lines drawn in a color of their own; the smallest past this share one "other epics" line
  const MAX_STATIONS = 14; // stations on one line: past it the done ones fold into a count at the start, then the tail into "more"
  const MAX_TRAINS = 12; // trains drawn, the sessions with the most stops first; the rest are counted in the depot
  const MAX_TRANSFERS = 120; // interchange transfers drawn
  const COLORS = 10; // line colors in the palette (--tr-l0 … --tr-l9), one per line; "no epic" and "other" are gray
  const TRAVEL_MS = 900; // wall-clock ms a train takes between stops
  const GUTTER = 26; // px at the left for the line bullets
  const STATUS_TEXT = { open: 'open', in_progress: 'in progress', blocked: 'blocked', done: 'done', deferred: 'deferred', dropped: 'dropped' };
  const STATUS_ORDER = ['open', 'in_progress', 'blocked', 'done', 'deferred', 'dropped'];
  const CONTAINERS = new Set(['epic', 'milestone']);
  const PACKAGE_KINDS = new Set(['package', 'target']);
  const CHAR = 5.4; // px per character of the station names (9.5px sans)

  window.factoryClock.register({
    id: 'transit-map',
    title: 'Transit map',
    tags: { subject: ['workspace', 'plans'], category: ['dependency', 'state', 'temporal'], purpose: ['expressive'], level: ['project'], dimension: ['dependency', 'status', 'structure'], language: ['transit'] },
    mount(host, ctx) {
      const { el, svg, svgText, fmt, clip, short, sessionName, formatTime, hideTip, hashId, shapeSelected } = ctx;
      const frame = el('div', { class: 'hero-transit' });
      const note = el('p', { class: 'muted small' });
      host.replaceChildren(frame, note);
      let ws = null;
      let views = [];
      let selection = null;
      let layout = null;
      let layoutKey = '';
      let scene = null;
      const clock = ctx.createReplay({ onFrame: () => paintFrame() });
      const bar = ctx.replayBar(clock, { label: 'Transit map' });
      const fitter = ctx.fitter(host);
      const ms = (ts) => (ts ? Date.parse(ts) : NaN);
      const qualify = (root, id) => `${root}::${id}`;
      const fitPx = (text, px) => {
        const max = Math.floor(px / CHAR);
        return max < 3 ? '' : text.length <= max ? text : `${text.slice(0, max - 1)}…`;
      };

      function update(sessions, sel, options) {
        const o = options || {};
        const given = o.workspace || null;
        views = sessions && sessions.length ? sessions : given && given.sessions ? given.sessions : [];
        ws = {
          sessions: views,
          code: (given && given.code) || [],
          plans: (given && given.plans) || [],
          joins: { planToCode: [], planToSession: [], sessionToCode: [], ...((given && given.joins) || {}) },
        };
        selection = sel || null;
        const key = [ws.code.map((g) => `${g.source.root}:${g.artifacts.length}`).join(','), ws.plans.map((p) => `${p.source.root}:${p.items.length}:${p.links.length}`).join(','), views.map((v) => v.summary.sessionId).join(','), ws.joins.planToCode.length, ws.joins.planToSession.length].join('|');
        if (key !== layoutKey || !layout) {
          layout = buildLayout();
          layoutKey = key;
        }
        clock.setSessions(views);
        draw();
      }

      // ---------- the layout, computed once per change in the data ----------
      function buildLayout() {
        const network = buildNetwork();
        const districts = buildDistricts(network);
        const trains = buildTrains(network);
        return { ...network, districts, trains };
      }

      /** Lines and their stations, in order, with interchanges. Grid positions only: pixels come at draw time. */
      function buildNetwork() {
        const groups = new Map(); // line key → { key, label, sel, epic, kind, items: [{ qid, it, depth }] }
        const itemByQid = new Map();
        const links = []; // qualified blocks links, for interchanges
        let total = 0;
        for (const p of ws.plans) {
          const root = p.source.root;
          const multi = ws.plans.length > 1;
          const byId = new Map(p.items.map((i) => [i.id, i]));
          const markdown = p.source.adapter === 'markdown';
          // Every parent an item names, by its field and by parent links, so an item under two epics is found.
          const parents = new Map();
          for (const it of p.items) if (it.parent) parents.set(it.id, new Set([it.parent]));
          for (const l of p.links) if (l.kind === 'parent' && byId.has(l.to)) (parents.get(l.from) || parents.set(l.from, new Set()).get(l.from)).add(l.to);
          const linesOf = (it) => {
            if (markdown) {
              const doc = it.id.split('#')[0];
              return [doc];
            }
            const out = new Set();
            const walk = (id, seen, milestone) => {
              if (seen.has(id)) return;
              seen.add(id);
              const ps = parents.get(id);
              if (!ps || !ps.size) {
                if (milestone) out.add(milestone);
                return;
              }
              for (const pid of ps) {
                const x = byId.get(pid);
                if (!x) continue;
                if (x.kind === 'epic') out.add(x.id);
                else walk(pid, seen, milestone || (x.kind === 'milestone' ? x.id : null));
              }
            };
            walk(it.id, new Set(), null);
            return [...out];
          };
          // Global dependency depth: blocks and follows, longest chain of predecessors.
          const before = new Map();
          for (const l of p.links) if (l.kind === 'blocks' || l.kind === 'follows') {
            const [a, b] = l.kind === 'blocks' ? [l.from, l.to] : [l.to, l.from];
            (before.get(b) || before.set(b, new Set()).get(b)).add(a);
            if (l.kind === 'blocks') links.push({ from: qualify(root, l.from), to: qualify(root, l.to), inferred: !!l.inferred });
          }
          const depth = new Map();
          const depthOf = (id, seen) => {
            if (depth.has(id)) return depth.get(id);
            if (seen.has(id)) return 0; // a cycle: stop
            seen.add(id);
            let d = 0;
            for (const a of before.get(id) || []) d = Math.max(d, depthOf(a, seen) + 1);
            depth.set(id, d);
            return d;
          };
          const lineFor = (k) => {
            const gk = qualify(root, k || '(none)');
            if (!groups.has(gk)) {
              const head = k ? byId.get(k) : null;
              const label = head ? head.title || head.id : k ? k : 'No epic';
              groups.set(gk, { key: gk, label: `${multi ? root + ' · ' : ''}${label}`, sel: head ? qualify(root, head.id) : null, epic: head, none: !k, items: [] });
            }
            return groups.get(gk);
          };
          for (const it of p.items) {
            const isLineHead = markdown ? it.kind === 'epic' && !it.id.includes('#') : it.kind === 'epic' || (it.kind === 'milestone' && !linesOf(it).length);
            if (isLineHead) {
              lineFor(markdown ? it.id.split('#')[0] : it.id);
              continue;
            }
            if (markdown && CONTAINERS.has(it.kind)) continue; // a heading's epic or milestone: its entries are the stations
            const qid = qualify(root, it.id);
            itemByQid.set(qid, it);
            total++;
            const ls = linesOf(it);
            const d = depthOf(it.id, new Set());
            for (const k of ls.length ? ls : [null]) lineFor(k).items.push({ qid, it, depth: d });
          }
        }
        let lines = [...groups.values()].filter((g) => g.items.length);
        const emptyLines = groups.size - lines.length;
        lines.sort((a, b) => (a.none ? 1 : 0) - (b.none ? 1 : 0) || b.items.length - a.items.length || a.label.localeCompare(b.label));
        let foldedLines = 0;
        const named = lines.filter((l) => !l.none);
        const loose = lines.find((l) => l.none) || null;
        const room = MAX_LINES - (loose ? 1 : 0);
        if (named.length > room) {
          const rest = named.slice(room - 1);
          foldedLines = rest.length;
          const seen = new Set();
          const items = [];
          for (const l of rest) for (const x of l.items) if (!seen.has(x.qid)) {
            seen.add(x.qid);
            items.push(x);
          }
          lines = [...named.slice(0, room - 1), { key: '(other epics)', label: `${rest.length} other epics`, sel: null, epic: null, other: true, members: rest, items }, ...(loose ? [loose] : [])];
        }
        // Color, order, and folds per line.
        let colorAt = 0;
        let foldedDone = 0;
        let foldedTail = 0;
        lines.forEach((l, i) => {
          l.index = i;
          l.color = l.none || l.other ? 'gray' : String(colorAt++ % COLORS);
          l.items.sort((a, b) => a.depth - b.depth || (ms(a.it.created) || 0) - (ms(b.it.created) || 0) || a.it.id.localeCompare(b.it.id));
          let marks = l.items.map((x) => ({ ...x, line: l, members: [x] }));
          if (marks.length > MAX_STATIONS) {
            const done = marks.filter((m) => m.it.status === 'done');
            if (done.length > 1) {
              marks = [{ qid: null, it: null, line: l, fold: 'done', members: done }, ...marks.filter((m) => m.it.status !== 'done')];
              foldedDone += done.length;
            }
          }
          if (marks.length > MAX_STATIONS) {
            const rest = marks.slice(MAX_STATIONS - 1);
            const members = rest.flatMap((m) => m.members);
            marks = [...marks.slice(0, MAX_STATIONS - 1), { qid: null, it: null, line: l, fold: 'more', members }];
            foldedTail += members.length;
          }
          marks.forEach((m, k) => {
            m.k = k;
            m.id = `${l.key}#${k}`;
          });
          l.stations = marks;
        });
        // Where each item is drawn: its stations (several when it's on several lines; a fold mark when folded).
        const stationsOf = new Map();
        for (const l of lines) for (const m of l.stations) for (const x of m.members) (stationsOf.get(x.qid) || stationsOf.set(x.qid, []).get(x.qid)).push(m);
        // Interchanges: an item on two lines (a transfer between its stations), and blocks across lines.
        const transfers = [];
        const seenT = new Set();
        const addT = (a, b, kind, inferred) => {
          if (a === b || a.line === b.line) return;
          const k = [a.id, b.id].sort().join('|') + kind;
          if (seenT.has(k)) return;
          seenT.add(k);
          a.interchange = b.interchange = true;
          transfers.push({ a, b, kind, inferred });
        };
        for (const [, list] of stationsOf) for (let i = 1; i < list.length; i++) addT(list[0], list[i], 'shared', false);
        for (const l of links) {
          const as = stationsOf.get(l.from);
          const bs = stationsOf.get(l.to);
          if (!as || !bs) continue;
          for (const a of as) for (const b of bs) if (a.line !== b.line) addT(a, b, 'blocks', l.inferred);
        }
        const shownTransfers = transfers.slice(0, MAX_TRANSFERS);
        const maxN = Math.max(1, ...lines.map((l) => l.stations.length));
        // The route on the grid: a hashed first column, and a hashed drift of one step up or down at 45°.
        for (const l of lines) {
          const h = hashId(l.key);
          l.start = (h >>> 3) % (maxN - l.stations.length + 1);
          let o = (h % 3) - 1;
          let bits = h;
          l.stations.forEach((m, k) => {
            if (k > 0) {
              bits = hashId(`${l.key}|${k}`);
              if (bits % 3 === 0) o = o === 0 ? (bits & 8 ? 1 : -1) : 0;
            }
            m.col = l.start + k;
            m.off = o;
          });
        }
        return { lines, maxN, stationsOf, transfers: shownTransfers, foldedTransfers: transfers.length - shownTransfers.length, itemByQid, total, emptyLines, foldedLines, foldedDone, foldedTail };
      }

      /** Each station's district: the package its item names most. Runs of one district on a line become a shaded box. */
      function buildDistricts(network) {
        const pkgOf = new Map(); // artifact qid → { key, label, sel }
        const multi = ws.code.length > 1;
        for (const g of ws.code) {
          const root = g.source.root;
          const byId = new Map(g.artifacts.map((a) => [a.id, a]));
          for (const a of g.artifacts) {
            let pkg = null;
            for (let x = a, guard = 0; x && guard < 64; x = byId.get(x.parent), guard++) if (PACKAGE_KINDS.has(x.kind)) {
              pkg = x;
              break;
            }
            pkgOf.set(qualify(root, a.id), pkg ? { key: qualify(root, pkg.id), label: `${multi ? root + ' · ' : ''}${pkg.name}`, sel: qualify(root, pkg.id) } : { key: qualify(root, '(root)'), label: root, sel: null });
          }
        }
        const named = new Map();
        for (const j of ws.joins.planToCode) (named.get(j.from) || named.set(j.from, []).get(j.from)).push(j.to);
        const all = new Map();
        let joined = 0;
        for (const l of network.lines) for (const m of l.stations) {
          const score = new Map();
          for (const x of m.members) for (const to of named.get(x.qid) || []) {
            const d = pkgOf.get(to);
            if (d) score.set(d.key, (score.get(d.key) || 0) + 1);
          }
          let best = null;
          for (const [k, s] of score) if (!best || s > best[1] || (s === best[1] && k < best[0])) best = [k, s];
          m.district = null;
          if (!best) continue;
          joined++;
          let d = all.get(best[0]);
          if (!d) {
            const info = [...pkgOf.values()].find((p) => p.key === best[0]);
            all.set(best[0], (d = { ...info, stations: [], lines: new Set() }));
          }
          m.district = d;
          d.stations.push(m);
          d.lines.add(l);
        }
        // Runs: consecutive stations of one line in one district. Boxes are merged across neighboring lanes at draw time.
        const runs = [];
        for (const l of network.lines) {
          let run = null;
          for (const m of l.stations) {
            if (m.district && run && run.district === m.district && m.k === run.k1 + 1) run.k1 = m.k;
            else {
              run = m.district ? { district: m.district, line: l, k0: m.k, k1: m.k } : null;
              if (run) runs.push(run);
            }
          }
        }
        return { list: [...all.values()], runs, joined };
      }

      /** Each session's stops: the items it mentions, at the prompts that name them, or when an item opened or closed while it ran. */
      function buildTrains(network) {
        const byS = new Map();
        for (const j of ws.joins.planToSession) (byS.get(j.to) || byS.set(j.to, []).get(j.to)).push(j);
        const trains = [];
        for (const v of views) {
          const id = v.summary.sessionId;
          const t0 = ms(v.summary.firstTs);
          const t1 = ms(v.summary.lastTs);
          const stops = [];
          let inferred = false;
          for (const j of byS.get(id) || []) {
            const st = (network.stationsOf.get(j.from) || [])[0];
            const it = network.itemByQid.get(j.from);
            if (!st || !it) continue;
            inferred = inferred || j.inferred;
            const idLow = it.id.toLowerCase();
            const title = it.title.trim().toLowerCase();
            let n = 0;
            for (const p of v.prompts) {
              const text = (p.text || '').toLowerCase();
              if (text && (text.includes(idLow) || (title.length >= 16 && text.includes(title)))) {
                stops.push({ t: ms(p.ts), station: st, qid: j.from, why: 'mentioned' });
                n++;
              }
            }
            for (const [why, ts] of [['opened', it.created], ['closed', it.closed]]) {
              const t = ms(ts);
              if (Number.isFinite(t) && t >= t0 && t <= t1) {
                stops.push({ t, station: st, qid: j.from, why });
                n++;
              }
            }
            if (!n && v.prompts.length) stops.push({ t: ms(v.prompts[0].ts), station: st, qid: j.from, why: 'named' });
          }
          const timed = stops.filter((s) => Number.isFinite(s.t)).sort((a, b) => a.t - b.t || a.station.id.localeCompare(b.station.id));
          // Consecutive stops at one station are one stop.
          const merged = [];
          for (const s of timed) if (!merged.length || merged[merged.length - 1].station !== s.station) merged.push(s);
          trains.push({ id, v, label: sessionName(v.summary, 28), stops: merged, items: new Set(timed.map((s) => s.qid)).size, t0, t1, inferred });
        }
        trains.sort((a, b) => b.stops.length - a.stops.length || a.id.localeCompare(b.id));
        const shown = trains.slice(0, MAX_TRAINS);
        return { list: shown, all: trains, folded: trains.length - shown.length, moving: trains.filter((t) => t.stops.length).length };
      }

      // ---------- geometry: the grid scaled to the stage ----------
      function geometry(width, height, band) {
        const { lines, maxN } = layout;
        const x0 = 14 + GUTTER;
        const top = 12;
        const mapH = Math.max(80, height - band - top - 8);
        const lh = mapH / (Math.max(1, lines.length) + 0.4);
        const diagLabel = Math.min(140, (lh * 1.2) / Math.SQRT1_2); // the longest a 45° name may be; the room to the line above decides
        const rightPad = 18 + Math.min(70, diagLabel * Math.SQRT1_2 + 6);
        const sp = maxN > 1 ? Math.min(150, (width - x0 - rightPad) / (maxN - 1)) : 60;
        const horizontal = sp >= 74;
        const d = Math.max(0, Math.min(lh * 0.2, sp * 0.45));
        const labels = horizontal ? lh >= 22 : lh >= 34;
        const stagger = horizontal && lh >= 48;
        const pos = (m) => ({ x: x0 + m.col * sp, y: top + (m.line.index + 0.95) * lh + m.off * d });
        for (const l of lines) {
          // An octilinear polyline: horizontal through each station, a 45° step between stations where the lane offset changes.
          const pts = [];
          l.stations.forEach((m, k) => {
            const p = pos(m);
            m.x = p.x;
            m.y = p.y;
            if (k === 0) {
              pts.push({ x: p.x - 16, y: p.y });
              pts.push(p);
              return;
            }
            const prev = l.stations[k - 1];
            const dy = p.y - prev.y;
            if (Math.abs(dy) > 0.5) {
              const xm = (prev.x + p.x) / 2;
              pts.push({ x: xm - Math.abs(dy) / 2, y: prev.y }, { x: xm + Math.abs(dy) / 2, y: p.y });
            }
            pts.push(p);
          });
          l.pts = pts;
          l.bullet = { x: pts[0].x - 6, y: pts[0].y };
        }
        return { x0, top, lh, sp, d, horizontal, stagger, labels, diagLabel, width, height };
      }
      const pathOf = (pts) => `M${pts.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L')}`;
      /** The point on a line (x-monotonic) at x. */
      function pointAtX(l, x) {
        const pts = l.pts;
        if (x <= pts[0].x) return { ...pts[0] };
        for (let i = 1; i < pts.length; i++) if (x <= pts[i].x) {
          const a = pts[i - 1];
          const b = pts[i];
          const f = b.x === a.x ? 1 : (x - a.x) / (b.x - a.x);
          return { x, y: a.y + (b.y - a.y) * f };
        }
        return { ...pts[pts.length - 1] };
      }

      // ---------- drawing ----------
      function draw() {
        hideTip();
        if (!layout) return;
        const { lines, districts, trains } = layout;
        if (!ws.plans.length || !lines.length) {
          drawEmpty(ws.plans.length ? 'The plan has no items: no lines to draw yet.' : 'No plan is loaded: no lines to draw yet.');
          note.textContent = `${ws.plans.length ? 'The plan has no items, so there are no lines or stations.' : 'No plan is loaded, so there are no lines or stations.'} The Transit map draws each epic as a line and its items as stations; ${ws.code.length ? 'the loaded code’s packages are shown as the districts the lines would run through.' : 'code would add the districts under the lines.'} Sessions add the trains.`;
          return;
        }
        const width = Math.max(340, host.clientWidth || 800);
        const height = fitter.height(Math.round(Math.min(760, Math.max(400, lines.length * 64 + 120))), 340);

        // The bottom band: the legend in the corner, the depot beside it.
        const legendW = trains.all.length ? Math.max(180, width * 0.6) : width - 28;
        const colW = 190;
        const cols = Math.max(1, Math.floor((legendW - 16) / colW));
        const lineRows = Math.ceil(lines.length / cols);
        // The key's chips (the rings, the interchange, the transfers), flowed into rows under the lines.
        const anyInferred = lines.some((l) => l.stations.some((m) => m.it && m.it.confidence === 'inferred')) || layout.transfers.some((t) => t.inferred);
        const chips = [...STATUS_ORDER.map((st) => ({ kind: 'status', st, text: STATUS_TEXT[st] })), { kind: 'interchange', text: 'interchange' }, { kind: 'blocks', text: 'blocks across lines' }, ...(anyInferred ? [{ kind: 'inferred', text: 'dashed: inferred' }] : [])];
        let cx0 = 0;
        let chipRow = 0;
        for (const c of chips) {
          c.w = (c.kind === 'blocks' ? 30 : c.kind === 'inferred' ? 0 : 14) + c.text.length * CHAR + 12;
          if (cx0 > 0 && cx0 + c.w > legendW - 24) {
            cx0 = 0;
            chipRow++;
          }
          c.dx = cx0;
          c.row = chipRow;
          cx0 += c.w;
        }
        const legendH = 12 + lineRows * 14 + (chipRow + 1) * 15 + 6;
        const depotW = width - 28 - legendW - 10;
        const slot = 74;
        const depotCols = Math.max(1, Math.floor((depotW - 12) / slot));
        const depotRows = Math.ceil((trains.list.length + (trains.folded ? 1 : 0)) / depotCols);
        const depotH = trains.all.length ? 22 + depotRows * 18 : 0;
        const band = Math.max(legendH, depotH) + 10;
        const geo = geometry(width, height, band);
        const bandY = height - band + 2;

        const root = svg('svg', { class: 'tr-svg', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Transit map: ${lines.length} lines, ${fmt(layout.total)} items as stations${districts.list.length ? `, over ${districts.list.length} districts` : ''}${trains.all.length ? `, ${trains.all.length} sessions as trains` : ''}` });
        root.append(svg('rect', { class: 'tr-ground', x: 0, y: 0, width, height }));

        // Districts: a box per run of stations in one package, merged across neighboring lanes where they overlap.
        const dg = svg('g', { class: 'tr-districts' });
        const boxes = districts.runs.map((r) => {
          const a = r.line.stations[r.k0];
          const b = r.line.stations[r.k1];
          const ys = r.line.stations.slice(r.k0, r.k1 + 1).map((m) => m.y);
          return { district: r.district, lanes: new Set([r.line.index]), x0: a.x - geo.sp * 0.42, x1: b.x + geo.sp * 0.42, y0: Math.min(...ys) - geo.lh * 0.36, y1: Math.max(...ys) + geo.lh * 0.3 };
        });
        for (let changed = true; changed; ) {
          changed = false;
          outer: for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
            const A = boxes[i];
            const B = boxes[j];
            if (A.district !== B.district || A.x1 < B.x0 || B.x1 < A.x0) continue;
            const near = [...A.lanes].some((u) => [...B.lanes].some((v) => Math.abs(u - v) <= 1));
            if (!near) continue;
            boxes[i] = { district: A.district, lanes: new Set([...A.lanes, ...B.lanes]), x0: Math.min(A.x0, B.x0), x1: Math.max(A.x1, B.x1), y0: Math.min(A.y0, B.y0), y1: Math.max(A.y1, B.y1) };
            boxes.splice(j, 1);
            changed = true;
            break outer;
          }
        }
        const clampX = (x) => Math.max(4, Math.min(width - 4, x));
        // A district is named on its biggest box, and on any other its whole name fits.
        const biggest = new Map();
        for (const b of boxes) {
          const area = (b.x1 - b.x0) * (b.y1 - b.y0);
          if (!biggest.has(b.district) || area > biggest.get(b.district)[1]) biggest.set(b.district, [b, area]);
        }
        for (const b of boxes) {
          const x0 = clampX(b.x0);
          const x1 = clampX(b.x1);
          const y0 = Math.max(4, b.y0);
          const y1 = Math.min(bandY - 4, b.y1);
          const d = b.district;
          const on = d.sel && shapeSelected(selection, d.sel);
          const g = svg('g', { class: `tr-district${on ? ' tr-on' : ''}` });
          g.append(svg('rect', { class: 'tr-district-box', x: x0.toFixed(1), y: y0.toFixed(1), width: Math.max(0, x1 - x0).toFixed(1), height: Math.max(0, y1 - y0).toFixed(1), rx: 12 }));
          const name = fitPx(d.label, x1 - x0 - 14);
          if (name && y1 - y0 > 18 && (name === d.label || biggest.get(d)[0] === b)) g.append(svgText({ class: 'tr-district-name', x: (x0 + 8).toFixed(1), y: (y1 - 5).toFixed(1) }, name));
          ctx.interact(ctx, g, {
            label: `District ${d.label}: ${d.stations.length} stations`,
            tip: () => [d.label, ['Stations', fmt(d.stations.length)], ['Lines', [...d.lines].map((l) => clip(l.label, 24)).join(', ')], 'A district is the package its stations’ items name', ...(d.sel ? ['Click to select the package'] : [])],
            pick: d.sel ? () => ctx.select({ artifactId: d.sel }) : undefined,
          });
          dg.append(g);
        }
        root.append(dg);

        // Lines: thick, rounded, one color each; a bullet with the line's number at its start.
        const lg = svg('g', { class: 'tr-lines' });
        for (const l of lines) {
          const on = l.sel && shapeSelected(selection, l.sel);
          const g = svg('g', { class: `tr-line tr-c-${l.color}${on ? ' tr-on' : ''}` });
          const d = pathOf(l.pts);
          if (on) g.append(svg('path', { class: 'tr-line-halo', d }));
          g.append(svg('path', { class: 'tr-line-path', d }), svg('path', { class: 'tr-hit', d }));
          const bullet = svg('g', { class: 'tr-bullet' });
          bullet.append(svg('rect', { class: 'tr-bullet-box', x: (l.bullet.x - 9).toFixed(1), y: (l.bullet.y - 8).toFixed(1), width: 18, height: 16, rx: 4 }), svgText({ class: 'tr-bullet-text', x: l.bullet.x.toFixed(1), y: (l.bullet.y + 3.5).toFixed(1), 'text-anchor': 'middle' }, String(l.index + 1)));
          g.append(bullet);
          ctx.interact(ctx, g, {
            label: `Line ${l.index + 1}: ${l.label}, ${l.items.length} stations`,
            tip: () => lineTip(l),
            pick: l.sel ? () => ctx.select({ itemId: l.sel }) : undefined,
          });
          lg.append(g);
        }
        root.append(lg);

        // Transfers between interchange stations: solid for one item on two lines, dashed for blocks across lines.
        const tg = svg('g', { class: 'tr-transfers', 'aria-hidden': 'true' });
        for (const t of layout.transfers) {
          const attrs = { x1: t.a.x.toFixed(1), y1: t.a.y.toFixed(1), x2: t.b.x.toFixed(1), y2: t.b.y.toFixed(1) };
          if (t.kind === 'shared') tg.append(svg('line', { class: 'tr-transfer-shared', ...attrs }), svg('line', { class: 'tr-transfer-core', ...attrs }));
          else tg.append(svg('line', { class: `tr-transfer-blocks${t.inferred ? ' tr-inferred' : ''}`, ...attrs }));
        }
        root.append(tg);

        // Stations, and their names horizontal or at 45°.
        const sg = svg('g', { class: 'tr-stations' });
        const parts = [];
        for (const l of lines) {
          const placed = []; // this line's names so far, so the next one can step up a tier or narrow to miss them
          for (const m of l.stations) {
          const on = m.members.some((x) => shapeSelected(selection, x.qid));
          const inferred = m.it && m.it.confidence === 'inferred';
          const g = svg('g', { class: `tr-station tr-c-${l.color}${m.interchange ? ' tr-interchange' : ''}${inferred ? ' tr-inferred' : ''}${on ? ' tr-on' : ''}` });
          if (m.fold) {
            g.classList.add('tr-fold', `tr-fold-${m.fold}`);
            g.append(svg('circle', { class: 'tr-fold-disc', cx: m.x.toFixed(1), cy: m.y.toFixed(1), r: 8.5 }), svgText({ class: 'tr-fold-text', x: m.x.toFixed(1), y: (m.y + 3.2).toFixed(1), 'text-anchor': 'middle' }, String(m.members.length)));
          } else ringParts(g, m.x, m.y, m.interchange ? 7.5 : 5.5);
          if (geo.labels) g.append(stationLabel(m, geo, placed));
          ctx.interact(ctx, g, {
            label: m.it ? `${m.it.title}: ${STATUS_TEXT[m.it.status] || m.it.status}` : `${m.members.length} ${m.fold === 'done' ? 'done' : 'more'} stations on ${l.label}`,
            tip: () => stationTip(m),
            pick: m.qid ? () => ctx.select({ itemId: m.qid }) : undefined,
          });
          sg.append(g);
          parts.push({ m, g, status: null });
          }
        }
        root.append(sg);

        // The legend, in the corner: each line, the rings, the transfers.
        const leg = svg('g', { class: 'tr-legend' });
        const lx = 14;
        leg.append(svg('rect', { class: 'tr-legend-box', x: lx, y: bandY, width: legendW.toFixed(1), height: legendH, rx: 6 }));
        lines.forEach((l, i) => {
          const cx = lx + 10 + (i % cols) * colW;
          const cy = bandY + 14 + Math.floor(i / cols) * 14;
          const g = svg('g', { class: `tr-key tr-c-${l.color}` });
          g.append(svg('line', { class: 'tr-key-line', x1: cx, y1: cy - 3, x2: cx + 18, y2: cy - 3 }), svgText({ class: 'tr-key-text', x: cx + 24, y: cy }, `${l.index + 1}  ${fitPx(l.label, colW - 40)}`));
          leg.append(g);
        });
        const ky = bandY + 14 + lineRows * 14 + 4;
        for (const c of chips) {
          const x = lx + 14 + c.dx;
          const y = ky + c.row * 15;
          let tx = x + 9;
          if (c.kind === 'status' || c.kind === 'interchange') {
            const g = svg('g', { class: `tr-station tr-c-ink tr-st-${c.kind === 'status' ? c.st : 'open'}${c.kind === 'interchange' ? ' tr-interchange' : ''}`, 'aria-hidden': 'true' });
            ringParts(g, x, y - 3, c.kind === 'interchange' ? 6 : 5);
            leg.append(g);
            if (c.kind === 'interchange') tx += 2;
          } else if (c.kind === 'blocks') {
            leg.append(svg('line', { class: 'tr-transfer-blocks', x1: x - 4, y1: y - 3, x2: x + 18, y2: y - 3 }));
            tx = x + 24;
          } else tx = x - 4;
          leg.append(svgText({ class: 'tr-key-text', x: tx.toFixed(1), y }, c.text));
        }
        root.append(leg);

        // The depot: where the trains wait when the replay isn't running.
        const trainParts = [];
        if (trains.all.length) {
          const dx = 14 + legendW + 10;
          const depot = svg('g', { class: 'tr-depot' });
          depot.append(svg('rect', { class: 'tr-depot-box', x: dx.toFixed(1), y: bandY, width: Math.max(0, depotW).toFixed(1), height: depotH, rx: 6 }), svgText({ class: 'tr-depot-name', x: (dx + 8).toFixed(1), y: bandY + 13 }, 'DEPOT'));
          for (let r = 0; r < depotRows; r++) depot.append(svg('line', { class: 'tr-depot-track', x1: (dx + 6).toFixed(1), y1: bandY + 31 + r * 18, x2: (dx + depotW - 6).toFixed(1), y2: bandY + 31 + r * 18 }));
          root.append(depot);
          const tl = svg('g', { class: 'tr-trains' });
          trains.list.forEach((tr, i) => {
            const home = { x: dx + 8 + (i % depotCols) * slot, y: bandY + 22 + Math.floor(i / depotCols) * 18 };
            const on = !!selection && selection.sessionId === tr.id;
            const g = svg('g', { class: `tr-train${on ? ' tr-on' : ''}${tr.stops.length ? '' : ' tr-idle'}` });
            g.append(
              svg('rect', { class: 'tr-train-body', x: 0, y: 0, width: 18, height: 10, rx: 3 }),
              svg('rect', { class: 'tr-train-window', x: 3, y: 2.5, width: 4, height: 4, rx: 0.6 }),
              svg('rect', { class: 'tr-train-window', x: 9, y: 2.5, width: 4, height: 4, rx: 0.6 })
            );
            const name = svgText({ class: 'tr-train-name', x: 22, y: 8.5 }, fitPx(tr.label, slot - 26));
            g.append(name);
            ctx.interact(ctx, g, {
              label: `Session ${tr.label}: ${tr.stops.length} stops`,
              tip: () => trainTip(tr),
              pick: () => ctx.select({ sessionId: tr.id }),
            });
            tl.append(g);
            trainParts.push({ tr, g, name, home, at: null });
          });
          if (trains.folded) {
            const i = trains.list.length;
            tl.append(svgText({ class: 'tr-train-name', x: (dx + 8 + (i % depotCols) * slot).toFixed(1), y: (bandY + 30.5 + Math.floor(i / depotCols) * 18).toFixed(1) }, `+${trains.folded} more`));
          }
          root.append(tl);
        }
        const stamp = svgText({ class: 'tr-stamp', x: width - 12, y: 14, 'text-anchor': 'end' }, '');
        root.append(stamp);

        frame.replaceChildren(root, views.length ? el('div', { class: 'tr-foot' }, [bar.element]) : null);
        scene = { root, geo, parts, trainParts, stamp };
        paintFrame();
        note.textContent = noteText();
        fitter.settle(height, draw);
      }

      /** No lines: the ground, the code's packages as empty districts when code is loaded, and a dashed line not yet built. */
      function drawEmpty(message) {
        const width = Math.max(340, host.clientWidth || 800);
        const height = fitter.height(400, 300);
        const root = svg('svg', { class: 'tr-svg', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Transit map: ${message}` });
        root.append(svg('rect', { class: 'tr-ground', x: 0, y: 0, width, height }));
        const pkgs = [];
        const seen = new Set();
        for (const g of ws.code) for (const a of g.artifacts) if (PACKAGE_KINDS.has(a.kind)) {
          const qid = qualify(g.source.root, a.id);
          if (seen.has(qid)) continue;
          seen.add(qid);
          pkgs.push({ qid, label: `${ws.code.length > 1 ? g.source.root + ' · ' : ''}${a.name}` });
        }
        pkgs.sort((a, b) => a.label.localeCompare(b.label));
        const shown = pkgs.slice(0, 24);
        if (shown.length) {
          const cols = Math.max(1, Math.min(shown.length, Math.floor((width - 24) / 150)));
          const rows = Math.ceil(shown.length / cols);
          const cw = (width - 24) / cols;
          const rh = Math.min(90, (height - 24) / rows);
          shown.forEach((pk, i) => {
            const x = 12 + (i % cols) * cw + 5;
            const y = 12 + Math.floor(i / cols) * rh + 5;
            const g = svg('g', { class: `tr-district${shapeSelected(selection, pk.qid) ? ' tr-on' : ''}` });
            g.append(svg('rect', { class: 'tr-district-box', x: x.toFixed(1), y: y.toFixed(1), width: (cw - 10).toFixed(1), height: (rh - 10).toFixed(1), rx: 12 }), svgText({ class: 'tr-district-name', x: (x + 8).toFixed(1), y: (y + rh - 16).toFixed(1) }, fitPx(pk.label, cw - 26)));
            ctx.interact(ctx, g, { label: `District ${pk.label}`, tip: () => [pk.label, 'A package; no plan line runs through it yet', 'Click to select the package'], pick: () => ctx.select({ artifactId: pk.qid }) });
            root.append(g);
          });
        }
        const y = height / 2;
        const g = svg('g', { class: 'tr-c-gray', 'aria-hidden': 'true' });
        g.append(svg('line', { class: 'tr-line-path tr-unbuilt', x1: width * 0.2, y1: y, x2: width * 0.8, y2: y }));
        for (const f of [0.2, 0.5, 0.8]) {
          const s = svg('g', { class: 'tr-station tr-st-open' });
          ringParts(s, width * f, y, 5.5);
          g.append(s);
        }
        root.append(g, svgText({ class: 'tr-empty-text', x: width / 2, y: y - 16, 'text-anchor': 'middle' }, message));
        frame.replaceChildren(root);
        scene = null;
        fitter.settle(height, draw);
      }

      /** The ring and every status mark; the station's class shows the one for its status. */
      function ringParts(g, x, y, r) {
        const ri = r * 0.5;
        const X = x.toFixed(1);
        const Y = y.toFixed(1);
        g.append(
          svg('circle', { class: 'tr-ring', cx: X, cy: Y, r }),
          svg('path', { class: 'tr-mark tr-m-half', d: `M${X} ${(y - ri).toFixed(1)} A${ri} ${ri} 0 0 1 ${X} ${(y + ri).toFixed(1)} Z` }),
          svg('circle', { class: 'tr-mark tr-m-fill', cx: X, cy: Y, r: ri }),
          svg('path', { class: 'tr-mark tr-m-cross', d: `M${(x - ri).toFixed(1)} ${(y - ri).toFixed(1)} L${(x + ri).toFixed(1)} ${(y + ri).toFixed(1)} M${(x - ri).toFixed(1)} ${(y + ri).toFixed(1)} L${(x + ri).toFixed(1)} ${(y - ri).toFixed(1)}` }),
          svg('rect', { class: 'tr-mark tr-m-bar', x: (x - ri * 1.2).toFixed(1), y: (y - 1.1).toFixed(1), width: (ri * 2.4).toFixed(1), height: 2.2 }),
          svg('path', { class: 'tr-mark tr-m-pause', d: `M${(x - ri * 0.55).toFixed(1)} ${(y - ri).toFixed(1)} V${(y + ri).toFixed(1)} M${(x + ri * 0.55).toFixed(1)} ${(y - ri).toFixed(1)} V${(y + ri).toFixed(1)}` })
        );
      }

      function stationLabel(m, geo, placed) {
        const text = m.it ? m.it.title : `${m.members.length} ${m.fold === 'done' ? 'done' : 'more'}`;
        const r = m.interchange ? 8 : m.fold ? 9 : 6;
        if (geo.horizontal) {
          // Above the line, clear of where the line itself runs higher; wide over two steps on two tiers when the
          // lane is tall enough, narrowed to one step when that would still meet the name before; inside the drawing.
          const options = geo.stagger ? [[2 * geo.sp - 14, 0], [2 * geo.sp - 14, 1], [geo.sp - 10, 0], [geo.sp - 10, 1]] : [[geo.sp - 10, 0]];
          let pick = null;
          let fallback = null;
          for (const [w0, tier] of options) {
            const t = fitPx(text, w0);
            const w = t.length * CHAR;
            const x = Math.max(6 + w / 2, Math.min(geo.width - 6 - w / 2, m.x));
            const a = x - w / 2;
            const b = x + w / 2;
            let top = Math.min(m.y, pointAtX(m.line, a).y, pointAtX(m.line, b).y);
            for (const p of m.line.pts) if (p.x > a && p.x < b) top = Math.min(top, p.y);
            const y = top - r - 4 - tier * 11;
            const cand = { a, b, y, t, x };
            if (w0 === geo.sp - 10 && tier === 0) fallback = cand; // one step wide, the lower tier
            if (!placed.some((q) => q.b + 4 > a && b + 4 > q.a && Math.abs(q.y - y) < 11)) {
              pick = cand;
              break;
            }
          }
          pick = pick || fallback;
          placed.push(pick);
          return svgText({ class: 'tr-name', x: pick.x.toFixed(1), y: pick.y.toFixed(1), 'text-anchor': 'middle' }, pick.t);
        }
        // At 45°, as long as the room up to the line above allows (or the top of the drawing, for the first line).
        const x = m.x + r * 0.5;
        const y = m.y - r - 2;
        const above = layout.lines[m.line.index - 1];
        let ceiling = 2;
        if (above) {
          const reach = geo.diagLabel * Math.SQRT1_2;
          const inside = x + reach >= above.pts[0].x - 6 && x <= above.pts[above.pts.length - 1].x + 6;
          ceiling = inside ? Math.max(pointAtX(above, x).y, pointAtX(above, x + reach).y) + 9 : above.pts[0].y - geo.lh * 0.4;
        }
        const len = Math.max(0, Math.min(geo.diagLabel, (y - ceiling) / Math.SQRT1_2));
        if (len < 6 * CHAR) return svgText({ class: 'tr-name', x: x.toFixed(1), y: y.toFixed(1) }, ''); // no room: the tip has the name
        return svgText({ class: 'tr-name', x: x.toFixed(1), y: y.toFixed(1), transform: `rotate(-45 ${x.toFixed(1)} ${y.toFixed(1)})` }, fitPx(text, len));
      }

      function noteText() {
        const { lines, districts, trains } = layout;
        const said = [];
        const markdown = ws.plans.some((p) => p.source.adapter === 'markdown');
        const named = lines.filter((l) => !l.none && !l.other);
        said.push(`Lines are ${markdown ? 'epics and documents' : 'epics'}: ${named.map((l) => `${l.index + 1} ${clip(l.label, 40)}`).join('; ') || 'none'}${lines.some((l) => l.none) ? `; ${lines.find((l) => l.none).index + 1} is the items under no epic` : ''}${layout.foldedLines ? `; ${lines.find((l) => l.other).index + 1} gathers ${layout.foldedLines} smaller epics (over ${MAX_LINES} lines)` : ''}.`);
        said.push('Stations run along each line in order of dependency depth (blocks and follows), then creation; where a line starts and where it steps at 45° come from a hash of its id, so positions and distances mean nothing but order and connection.');
        said.push('An interchange is an item on two lines or an item that blocks one on another line, from explicit links only.');
        if (!ws.code.length) said.push('No code is loaded, so there are no districts under the lines.');
        else if (!districts.joined) said.push('No station’s item names a loaded file or folder (the plan→code join is empty), so there are no districts.');
        else said.push(`Districts are the packages the stations’ items name most (${districts.list.length} of them); a station naming none sits on bare ground.`);
        if (!views.length) said.push('No sessions are loaded, so there are no trains.');
        else if (!trains.moving) said.push('No session mentions an item (the plan→session join is empty, or prompts weren’t captured), so the trains stay in the depot.');
        else said.push(`In replay, a session is a train that stops at the items it mentions in its prompts (a guess from the text), or that opened or closed while it ran; ${trains.moving} of ${trains.all.length} trains move, and they wait in the depot when the replay isn’t running.`);
        const folds = [];
        if (layout.foldedDone) folds.push(`${layout.foldedDone} done stations into a count at their line’s start (over ${MAX_STATIONS} per line)`);
        if (layout.foldedTail) folds.push(`${layout.foldedTail} more stations into a count at their line’s end`);
        if (layout.foldedLines) folds.push(`${layout.foldedLines} epics into one gray line`);
        if (layout.foldedTransfers) folds.push(`${layout.foldedTransfers} transfers left off (over ${MAX_TRANSFERS})`);
        if (trains.folded) folds.push(`${trains.folded} quieter sessions not drawn as trains (over ${MAX_TRAINS}), counted in the depot`);
        if (layout.emptyLines) folds.push(`${layout.emptyLines} epics with no items aren’t drawn`);
        if (folds.length) said.push(`Folded: ${folds.join('; ')}.`);
        if (!scene || !scene.geo.labels) said.push('The lanes are too close for station names; hover a station for its name.');
        said.push('Click a station or a line to select its item or epic, a district for its package, a train for its session.');
        return said.join(' ');
      }

      // ---------- tooltips ----------
      function statusCounts(items) {
        const by = new Map();
        for (const x of items) by.set(x.it.status, (by.get(x.it.status) || 0) + 1);
        return STATUS_ORDER.filter((s) => by.has(s)).map((s) => [STATUS_TEXT[s], fmt(by.get(s))]);
      }
      function lineTip(l) {
        const rows = [`Line ${l.index + 1}: ${clip(l.label, 60)}`, ['Stations', fmt(l.items.length)], ...statusCounts(l.items)];
        if (l.other) rows.push(['Epics', l.members.map((x) => clip(x.label, 20)).slice(0, 4).join(', ') + (l.members.length > 4 ? '…' : '')]);
        if (l.none) rows.push('Items under no epic');
        if (l.sel) rows.push('Click to select the epic');
        return rows;
      }
      function stationTip(m) {
        if (!m.it) return [`${m.members.length} ${m.fold === 'done' ? 'done' : 'more'} stations`, ['Line', clip(m.line.label, 40)], ...statusCounts(m.members), ...m.members.slice(0, 5).map((x) => clip(x.it.title, 50))];
        const it = m.it;
        const rows = [clip(it.title, 80), ['Id', clip(it.id, 40)], ['Status', STATUS_TEXT[it.status] || it.status], ['Kind', it.kind]];
        const on = (layout.stationsOf.get(m.qid) || []).map((s) => s.line);
        rows.push([on.length > 1 ? 'Lines' : 'Line', on.map((l) => `${l.index + 1} ${clip(l.label, 24)}`).join(', ')]);
        if (m.district) rows.push(['District', m.district.label]);
        if (m.interchange) rows.push(['Interchange', layout.transfers.filter((t) => t.a === m || t.b === m).map((t) => (t.kind === 'shared' ? 'on two lines' : 'blocks across lines')).filter((v, i, a) => a.indexOf(v) === i).join(', ')]);
        if (it.created) rows.push(['Opened', formatTime(it.created)]);
        if (it.closed) rows.push(['Closed', formatTime(it.closed)]);
        const trains = layout.trains.all.filter((t) => t.stops.some((s) => s.qid === m.qid)).length;
        if (trains) rows.push(['Trains that stop', `≈ ${fmt(trains)}`]);
        if (it.confidence === 'inferred') rows.push('≈ Inferred from its source');
        rows.push('Click to select');
        return rows;
      }
      function trainTip(tr) {
        const rows = [tr.label, ['Session', short(tr.id)], ['Stops', fmt(tr.stops.length)], ['Items it mentions', `${tr.inferred ? '≈ ' : ''}${fmt(tr.items)}`]];
        if (tr.v.summary.firstTs) rows.push(['Started', formatTime(tr.v.summary.firstTs)]);
        if (!tr.stops.length) rows.push('Mentions no item, so it stays in the depot');
        rows.push('Click to select');
        return rows;
      }

      // ---------- each frame ----------
      /** The status an item showed at time t: not yet opened, open until it closed, else its own. */
      function statusAt(it, t, replaying) {
        if (!replaying) return it.status;
        const c = ms(it.created);
        if (Number.isFinite(c) && c > t) return 'unborn';
        const d = ms(it.closed);
        if ((it.status === 'done' || it.status === 'dropped') && Number.isFinite(d) && d > t) return 'open';
        return it.status;
      }
      /** Where a train is at time t: in the depot, at a stop, or between two. */
      function trainAt(tr, t, travel) {
        if (!tr.stops.length || t > tr.t1 || t < tr.stops[0].t - travel) return null;
        let i = -1;
        for (let k = 0; k < tr.stops.length && tr.stops[k].t <= t; k++) i = k;
        const next = tr.stops[i + 1];
        const cur = i >= 0 ? tr.stops[i].station : null;
        if (next && t > next.t - travel) {
          const f = Math.max(0, Math.min(1, 1 - (next.t - t) / travel));
          const e = f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2;
          const b = next.station;
          if (!cur) return { x: b.x, y: b.y }; // leaving the depot: it appears at its first stop
          if (cur.line === b.line) {
            const x = cur.x + (b.x - cur.x) * e;
            return pointAtX(b.line, x);
          }
          return { x: cur.x + (b.x - cur.x) * e, y: cur.y + (b.y - cur.y) * e };
        }
        return cur ? { x: cur.x, y: cur.y, station: cur } : null;
      }
      function paintFrame() {
        bar.sync();
        if (!scene || !layout) return;
        const t = clock.time;
        const replaying = views.length > 0 && clock.events.length > 0 && (clock.playing || !clock.atEnd());
        for (const part of scene.parts) {
          const st = part.m.it ? statusAt(part.m.it, t, replaying) : part.m.fold === 'done' ? 'done' : 'open';
          if (st === part.status) continue;
          if (part.status) part.g.classList.remove(`tr-st-${part.status}`);
          part.g.classList.add(`tr-st-${st}`);
          part.status = st;
        }
        const travel = TRAVEL_MS * (clock.speed || 1);
        const atStation = new Map();
        for (const p of scene.trainParts) {
          const at = replaying ? trainAt(p.tr, t, travel) : null;
          let x;
          let y;
          if (!at) {
            x = p.home.x;
            y = p.home.y;
          } else {
            const key = at.station ? at.station.id : null;
            const n = key ? atStation.get(key) || 0 : 0;
            if (key) atStation.set(key, n + 1);
            x = at.x - 9 + n * 6;
            y = at.y + 9 + n * 4; // just under the station, clear of its name
          }
          const where = `${x.toFixed(1)} ${y.toFixed(1)}`;
          if (where === p.at) continue;
          p.at = where;
          p.g.setAttribute('transform', `translate(${where})`);
          p.g.classList.toggle('tr-running', !!at);
        }
        scene.stamp.textContent = replaying ? `replay ×${Math.round(clock.speed || 1)} · ${formatTime(new Date(t).toISOString())}` : '';
      }

      return {
        update,
        resize: draw,
        setActive: (on) => clock.setActive(on),
        destroy() {
          clock.destroy();
          hideTip();
          host.replaceChildren();
        },
      };
    },
  });
})();
