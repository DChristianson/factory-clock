// Loom (hero view, design language `textile`): the whole project as woven
// cloth. The warp is the code: one vertical thread per file (or module, or
// package, past a limit), grouped by package with an empty dent between
// packages. Above the cloth, the heading: where a thread's imports cross to
// another thread, a short float marks it. The weft is time, running down the
// cloth: each plan item a band over the threads it names, from its creation to
// its close, dyed by status; each session a pass of the shuttle, with a pick
// per turn that rides over the threads the turn read or edited, so the cloth
// grows downward as the sessions replay. See docs/workspace-explorer.md,
// "Loom".
//
// The layout (thread order, float lanes, the time axis) is computed once per
// workspace and reused on every replay frame, hover, and resize; the replay
// only moves the fell (the woven edge) down the cloth and redyes the bands to
// their state at the clock. Before the clock first moves, and at its end, the
// cloth shows its long exposure: everything woven. Clicking a thread, band,
// or pick announces { artifactId }, { itemId }, or { sessionId[, turnId] }.
// Sees only its host and ctx: no VS Code.
(function () {
  const MAX_THREADS = 160; // warp threads: past it files fold to their modules, then whole packages to one thread, then the smallest packages share one
  const MAX_ROWS = 120; // session rows: past it the oldest sessions are left off
  const MAX_PICKS = 24; // picks per session row, one per turn: past it neighboring turns share a pick
  const MAX_BANDS = 80; // plan bands: past it done and dropped items go first, then the oldest
  const MAX_FLOATS = 400; // thread pairs with a float in the heading, the heaviest first
  const MAX_FLOAT_LANES = 12; // lanes in the heading; a float that finds no free lane keeps its mark on the importing thread, in one more row, without its run
  const PACKAGE_GAP = 2; // empty dents between packages, in thread pitches (even, so the weave keeps its parity)
  const LANE_PX = 4; // a heading lane’s height
  const GROUND_PX = 5; // the ground weave's pick pitch
  const FRINGE = 9; // px of bare warp below the cloth
  const SELVEDGE = 6; // px of selvedge at each edge
  const ROOM = { start: 0.8, pick: 0.6, item: 0.15, end: 0.5 }; // room down the cloth a moment takes, by kind
  const TIME_ROOM = 6; // room time itself takes: this many units times the square root of its share of the span
  const ENTRY_KINDS = new Set(['package', 'target']);
  const STATUS_TEXT = { open: 'open', in_progress: 'in progress', blocked: 'blocked', done: 'done', deferred: 'deferred', dropped: 'dropped' };
  const STATUS_ORDER = ['done', 'in_progress', 'open', 'blocked', 'deferred', 'dropped'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DYES = 3; // weft dyes the session rows take in turn
  let serial = 0; // for clip-path ids, unique per mount

  window.factoryClock.register({
    id: 'loom',
    title: 'Loom',
    tags: { subject: ['workspace', 'code'], category: ['temporal', 'dependency', 'state'], purpose: ['expressive'], level: ['project'], dimension: ['time', 'structure', 'place', 'status'], language: ['textile'] },
    mount(host, ctx) {
      const { el, svg, svgText, fmt, clip, short, sessionName, formatTime, hideTip } = ctx;
      const frame = el('div', { class: 'hero-loom' });
      const note = el('p', { class: 'muted small' });
      host.replaceChildren(frame, note);
      const clipId = `lm-clip-${++serial}`;
      let ws = null;
      let subject = 'workspace';
      let views = [];
      let selection = null;
      let layout = null;
      let layoutKey = null;
      let scene = null;
      let opened = null; // the clock's time when the sessions were set
      let moved = false; // whether the replay has moved since: until then the cloth shows its long exposure
      const clock = ctx.createReplay({ onFrame: () => paintFrame() });
      const bar = ctx.replayBar(clock, { label: 'the Loom' });
      const fit = ctx.fitter(host);
      const ms = (ts) => (ts ? Date.parse(ts) : NaN);
      const qualify = (root, id) => `${root}::${id}`;

      function update(sessions, sel, options) {
        const o = options || {};
        const given = o.workspace || null;
        subject = o.subject === 'code' ? 'code' : 'workspace';
        const withRest = subject === 'workspace';
        views = withRest ? (sessions && sessions.length ? sessions : given && given.sessions ? given.sessions : []) : [];
        ws = {
          code: (given && given.code) || [],
          plans: withRest ? (given && given.plans) || [] : [],
          touches: given && given.touches instanceof Map ? given.touches : new Map(Object.entries((given && given.touches) || {})),
          joins: { planToCode: [], planToSession: [], sessionToCode: [], ...((given && given.joins) || {}) },
        };
        selection = sel || null;
        const key = [subject, ws.code.map((g) => `${g.source.root}:${g.artifacts.length}:${g.dependencies.length}`).join(','), ws.plans.map((p) => `${p.source.root}:${p.items.length}`).join(','), views.map((v) => `${v.summary.sessionId}:${v.summary.lastTs || ''}`).join(','), ws.joins.planToCode.length, ws.joins.sessionToCode.length, ws.touches.size].join('|');
        if (key !== layoutKey || !layout) {
          layoutKey = key;
          layout = build();
          moved = false;
          opened = null;
          clock.setSessions(views);
          opened = clock.time;
        }
        draw();
      }

      // ---------- the one layout, computed once per workspace ----------
      function build() {
        const warp = buildWarp();
        const heading = buildHeading(warp);
        const rows = subject === 'workspace' ? buildRows(warp) : { rows: [], folded: 0, touches: 0, unmatched: 0 };
        const bands = subject === 'workspace' ? buildBands(warp) : { bands: [], folded: 0, unjoined: 0, total: 0 };
        const time = buildTime(rows.rows, bands.bands);
        return { warp, heading, rows, bands, time, hasCodeJoin: ws.joins.sessionToCode.length > 0 };
      }

      /** The warp: a thread per file, grouped by package, folding to modules and then packages past the limit. */
      function buildWarp() {
        const pkgMap = new Map();
        const multi = ws.code.length > 1;
        for (const g of ws.code) {
          const root = g.source.root;
          const byId = new Map(g.artifacts.map((a) => [a.id, a]));
          for (const a of g.artifacts) {
            if (a.kind !== 'file') continue;
            const anc = [];
            let pkg = null;
            let mod = null;
            for (let p = a, guard = 0; p && guard < 64; p = p.parent ? byId.get(p.parent) : null, guard++) {
              anc.push(qualify(root, p.id));
              if (p !== a && !mod && p.kind === 'module') mod = p;
              if (!pkg && ENTRY_KINDS.has(p.kind)) pkg = p;
            }
            const pkgKey = pkg ? qualify(root, pkg.id) : qualify(root, '(root)');
            let k = pkgMap.get(pkgKey);
            if (!k) pkgMap.set(pkgKey, (k = { key: pkgKey, label: `${multi ? root + ' · ' : ''}${pkg ? pkg.name : root}`, sel: pkg ? pkgKey : null, files: [] }));
            k.files.push({ qid: qualify(root, a.id), name: a.name, path: a.path || a.id, lines: (a.size && a.size.lines) || 0, anc, modKey: mod ? qualify(root, mod.id) : null, modName: mod ? mod.name : null, modPath: mod ? mod.path || mod.id : null });
          }
        }
        let pkgs = [...pkgMap.values()].sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
        for (const p of pkgs) p.files.sort((a, b) => a.path.localeCompare(b.path));
        const fileCount = pkgs.reduce((n, p) => n + p.files.length, 0);
        const threadsAt = (p, level) => {
          if (level === 'package' || p.other) return [{ key: p.key, sel: p.sel, label: p.label, path: '', kind: p.other ? 'other' : 'package', files: p.files }];
          if (level === 'file') return p.files.map((f) => ({ key: f.qid, sel: f.qid, label: f.name, path: f.path, kind: 'file', files: [f] }));
          const byMod = new Map();
          for (const f of p.files) {
            const k = f.modKey || f.qid;
            let t = byMod.get(k);
            if (!t) byMod.set(k, (t = f.modKey ? { key: k, sel: k, label: `${f.modName}/`, path: f.modPath, kind: 'module', files: [] } : { key: k, sel: k, label: f.name, path: f.path, kind: 'file', files: [] }));
            t.files.push(f);
          }
          return [...byMod.values()];
        };
        let level = fileCount > MAX_THREADS ? 'module' : 'file';
        const levels = new Map(pkgs.map((p) => [p.key, level]));
        const count = () => pkgs.reduce((n, p) => n + threadsAt(p, levels.get(p.key)).length, 0);
        let foldedToModules = level === 'module' ? fileCount : 0;
        let foldedPackages = 0;
        if (count() > MAX_THREADS) {
          // Whole packages to one thread each, the fewest threads first, until the warp fits.
          const order = [...pkgs].sort((a, b) => threadsAt(a, level).length - threadsAt(b, level).length || a.key.localeCompare(b.key));
          for (const p of order) {
            if (count() <= MAX_THREADS) break;
            if (threadsAt(p, level).length > 1) foldedPackages++;
            levels.set(p.key, 'package');
          }
        }
        let foldedToOther = 0;
        if (pkgs.length > MAX_THREADS) {
          const bySize = [...pkgs].sort((a, b) => a.files.length - b.files.length || a.key.localeCompare(b.key));
          const rest = new Set(bySize.slice(0, pkgs.length - MAX_THREADS + 1));
          foldedToOther = rest.size;
          const other = { key: '(other)', label: `${rest.size} other packages`, sel: null, files: [...rest].flatMap((p) => p.files), other: true };
          pkgs = [...pkgs.filter((p) => !rest.has(p)), other];
          levels.set(other.key, 'package');
        }
        const threads = [];
        pkgs.forEach((p, pi) => {
          p.threads = threadsAt(p, levels.get(p.key));
          for (const t of p.threads) {
            t.i = threads.length;
            t.u = threads.length + PACKAGE_GAP * pi + 0.5;
            t.pkg = p;
            t.lines = t.files.reduce((n, f) => n + f.lines, 0);
            t.anc = new Set(t.files.flatMap((f) => f.anc));
            if (t.sel) t.anc.add(t.sel);
            if (p.sel) t.anc.add(p.sel);
            threads.push(t);
          }
        });
        const fileThread = new Map();
        const under = new Map(); // any artifact qid → the threads holding its files
        const paths = new Map(); // file path → threads, for touches
        for (const t of threads) for (const f of t.files) {
          fileThread.set(f.qid, t);
          for (const q of f.anc) (under.get(q) || under.set(q, new Set()).get(q)).add(t);
          (paths.get(f.path) || paths.set(f.path, []).get(f.path)).push(t);
        }
        const units = threads.length ? threads.length + PACKAGE_GAP * (pkgs.length - 1) : 1;
        return { pkgs, threads, fileThread, under, paths, units, files: fileCount, foldedToModules, foldedPackages, foldedToOther };
      }

      /** The heading: a float per pair of threads one imports the other, packed into lanes. */
      function buildHeading(warp) {
        const pairs = new Map();
        for (const g of ws.code) {
          const root = g.source.root;
          const threadOf = (id) => {
            const q = qualify(root, id);
            const t = warp.fileThread.get(q);
            if (t) return t;
            const set = warp.under.get(q);
            return set && set.size === 1 ? [...set][0] : null;
          };
          for (const d of g.dependencies) {
            const a = threadOf(d.from);
            const b = threadOf(d.to);
            if (!a || !b || a === b) continue;
            const k = `${a.i}|${b.i}`;
            let p = pairs.get(k);
            if (!p) pairs.set(k, (p = { from: a, to: b, weight: 0, count: 0, inferred: true }));
            p.weight += d.weight || 1;
            p.count++;
            p.inferred = p.inferred && !!d.inferred;
          }
        }
        const ranked = [...pairs.values()].sort((a, b) => b.weight - a.weight || a.from.i - b.from.i || a.to.i - b.to.i);
        const kept = ranked.slice(0, MAX_FLOATS);
        let folded = ranked.length - kept.length;
        kept.sort((a, b) => Math.min(a.from.i, a.to.i) - Math.min(b.from.i, b.to.i) || Math.max(a.from.i, a.to.i) - Math.max(b.from.i, b.to.i));
        const laneEnd = [];
        const floats = [];
        const overflow = new Map(); // importing thread → its floats that found no lane
        for (const f of kept) {
          const lo = Math.min(f.from.u, f.to.u);
          const hi = Math.max(f.from.u, f.to.u);
          let lane = laneEnd.findIndex((end) => end < lo - 0.5);
          if (lane < 0 && laneEnd.length < MAX_FLOAT_LANES) lane = laneEnd.push(-Infinity) - 1;
          if (lane < 0) {
            (overflow.get(f.from) || overflow.set(f.from, []).get(f.from)).push(f);
            continue;
          }
          laneEnd[lane] = hi;
          floats.push({ ...f, lane, lo, hi, run: true });
        }
        // Floats with no lane: one mark per importing thread in a last row, its runs left out.
        let unrun = 0;
        for (const [from, list] of overflow) {
          unrun += list.length;
          floats.push({ from, to: null, list, lane: laneEnd.length, lo: from.u, hi: from.u, run: false, count: list.reduce((n, f) => n + f.count, 0), weight: list.reduce((n, f) => n + f.weight, 0), inferred: list.every((f) => f.inferred) });
        }
        const out = new Map();
        const into = new Map();
        for (const p of ranked) {
          out.set(p.from, (out.get(p.from) || 0) + p.count);
          into.set(p.to, (into.get(p.to) || 0) + p.count);
        }
        return { floats, lanes: laneEnd.length + (overflow.size ? 1 : 0), folded, unrun, pairs: ranked.length, out, into };
      }

      /** Session rows: a pass per session, a pick per turn, riding over the threads the turn touched. */
      function buildRows(warp) {
        const sorted = [...views].filter((v) => Number.isFinite(ms(v.summary.firstTs))).sort((a, b) => ms(a.summary.firstTs) - ms(b.summary.firstTs) || a.summary.sessionId.localeCompare(b.summary.sessionId));
        const kept = sorted.slice(Math.max(0, sorted.length - MAX_ROWS));
        const unanchored = new Map(); // touch path → the one thread it matches by suffix, or null
        const matchTouch = (t) => {
          if (t.anchored) return { thread: (warp.paths.get(t.path) || [])[0] || null, inferred: false };
          if (!unanchored.has(t.path)) {
            const m = [];
            for (const [p, list] of warp.paths) if (p === t.path || p.endsWith('/' + t.path)) m.push(...list);
            unanchored.set(t.path, m.length === 1 ? m[0] : null);
          }
          return { thread: unanchored.get(t.path), inferred: true };
        };
        let touches = 0;
        let unmatched = 0;
        const rows = kept.map((v, k) => {
          const id = v.summary.sessionId;
          const t0 = ms(v.summary.firstTs);
          const t1 = Math.max(t0, ms(v.summary.lastTs) || t0);
          // Turns in order, by their first prompt; past the limit neighbors share a pick.
          const firstOf = new Map();
          for (const p of v.prompts) {
            const t = ms(p.ts);
            if (!p.turnId || !Number.isFinite(t)) continue;
            if (!firstOf.has(p.turnId) || t < firstOf.get(p.turnId)) firstOf.set(p.turnId, t);
          }
          const turns = [...firstOf.entries()].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]));
          const per = Math.max(1, Math.ceil(turns.length / MAX_PICKS));
          const picks = [];
          turns.forEach(([turnId, t], n) => {
            if (n % per === 0) picks.push({ t, turnIds: [], first: n + 1, over: new Map() });
            picks[picks.length - 1].turnIds.push(turnId);
          });
          if (!picks.length) picks.push({ t: t0, turnIds: [], first: 0, over: new Map() });
          const pickOfTurn = new Map();
          for (const p of picks) for (const tid of p.turnIds) pickOfTurn.set(tid, p);
          for (const t of ws.touches.get(id) || []) {
            touches++;
            const m = matchTouch(t);
            if (!m.thread) {
              unmatched++;
              continue;
            }
            let pick = t.turnId ? pickOfTurn.get(t.turnId) : null;
            if (!pick) {
              const ts = ms(t.ts);
              pick = picks[0];
              for (const p of picks) if (p.t <= ts) pick = p;
            }
            let o = pick.over.get(m.thread);
            if (!o) pick.over.set(m.thread, (o = { thread: m.thread, reads: 0, edits: 0, inferred: true }));
            if (t.kind === 'edit') o.edits++;
            else o.reads++;
            o.inferred = o.inferred && m.inferred;
          }
          const threads = new Set();
          for (const p of picks) for (const t of p.over.keys()) threads.add(t);
          return { id, v, k, t0, t1, picks, label: sessionName(v.summary, 40), threads, dye: k % DYES, turns: turns.length };
        });
        return { rows, folded: sorted.length - kept.length, undated: views.length - sorted.length, touches, unmatched };
      }

      /** Plan bands: each item a band over the threads it names, from created to closed. */
      function buildBands(warp) {
        const named = new Map(); // item qid → threads
        for (const j of ws.joins.planToCode) {
          const set = warp.under.get(j.to);
          if (!set) continue;
          const s = named.get(j.from) || named.set(j.from, new Set()).get(j.from);
          for (const t of set) s.add(t);
        }
        const all = [];
        let total = 0;
        for (const p of ws.plans) {
          for (const it of p.items) {
            total++;
            const qid = qualify(p.source.root, it.id);
            const threads = named.get(qid);
            if (!threads || !threads.size) continue;
            const closed = it.status === 'done' || it.status === 'dropped' ? ms(it.closed) || ms(it.updated) : ms(it.closed);
            all.push({ qid, it, threads: [...threads].sort((a, b) => a.i - b.i), t0: ms(it.created), t1: closed });
          }
        }
        const finished = (b) => b.it.status === 'done' || b.it.status === 'dropped';
        const ranked = [...all].sort((a, b) => Number(finished(a)) - Number(finished(b)) || (b.t0 || 0) - (a.t0 || 0) || a.qid.localeCompare(b.qid));
        const kept = new Set(ranked.slice(0, MAX_BANDS));
        // Drawn in time order, finished work first, so open work lies on top.
        const bands = all.filter((b) => kept.has(b)).sort((a, b) => Number(finished(b)) - Number(finished(a)) || (Number.isFinite(a.t0) ? a.t0 : -Infinity) - (Number.isFinite(b.t0) ? b.t0 : -Infinity) || a.qid.localeCompare(b.qid));
        return { bands, folded: all.length - kept.size, unjoined: total - all.length, total, undated: bands.filter((b) => !Number.isFinite(b.t0)).length };
      }

      /** Time down the cloth: each moment takes room, and time itself takes room by the square root of its share, so a quiet month doesn't swallow a busy day. */
      function buildTime(rows, bands) {
        const knots = new Map(); // t → room
        const add = (t, room) => {
          if (Number.isFinite(t)) knots.set(t, Math.max(knots.get(t) || 0, room));
        };
        for (const r of rows) {
          add(r.t0, ROOM.start);
          for (const p of r.picks) add(p.t, ROOM.pick);
          add(r.t1, ROOM.item);
        }
        for (const b of bands) {
          add(b.t0, ROOM.item);
          add(b.t1, ROOM.item);
        }
        if (!knots.size) return null;
        const ts = [...knots.keys()].sort((a, b) => a - b);
        const span = Math.max(1, ts[ts.length - 1] - ts[0]);
        const ys = [];
        let y = 0;
        ts.forEach((t, k) => {
          y += knots.get(t) + (k ? TIME_ROOM * Math.sqrt((t - ts[k - 1]) / span) : 0);
          ys.push(y);
        });
        const total = y + ROOM.end;
        const ny = ys.map((v) => v / total);
        const unit = 1 / total; // one unit of room, as a share of the cloth
        const at = (t) => {
          if (!Number.isFinite(t)) return null;
          if (t <= ts[0]) return ny[0];
          if (t >= ts[ts.length - 1]) return ny[ny.length - 1];
          let lo = 0;
          let hi = ts.length - 1;
          while (hi - lo > 1) {
            const mid = (lo + hi) >> 1;
            if (ts[mid] <= t) lo = mid;
            else hi = mid;
          }
          return ny[lo] + ((ny[hi] - ny[lo]) * (t - ts[lo])) / Math.max(1, ts[hi] - ts[lo]);
        };
        return { ts, ny, at, unit, first: ts[0], last: ts[ts.length - 1] };
      }

      // ---------- drawing ----------
      function draw() {
        hideTip();
        scene = null;
        if (!layout || !layout.warp.threads.length) {
          frame.replaceChildren(el('p', { class: 'lm-empty', text: ws && ws.code.length ? 'The code graph has no files, so there is no warp to weave on.' : 'No code is loaded. The Loom weaves on the code: its warp is a thread per file. Load a code graph (Sessions and project ↓), and plans and sessions weave across it.' }));
          note.textContent = '';
          return;
        }
        const { warp, heading, rows, bands, time } = layout;
        const width = Math.max(320, host.clientWidth || 800);
        const height = fit.height(Math.round(Math.min(720, Math.max(380, width * 0.66))), 320);
        const left = time ? 52 : 14;
        const right = rows.rows.length ? Math.round(Math.min(130, Math.max(70, width * 0.13))) : 14;
        const x0 = left;
        const x1 = width - right;
        const pitch = (x1 - x0 - 2 * SELVEDGE) / warp.units;
        const X = (u) => x0 + SELVEDGE + u * pitch;
        const headTop = 26;
        const headH = heading.lanes ? heading.lanes * LANE_PX + 6 : 0;
        const clothTop = headTop + headH + (headH ? 6 : 0);
        const clothBottom = height - 14 - FRINGE;
        const clothH = Math.max(20, clothBottom - clothTop);
        const Y = (n) => clothTop + n * clothH;
        const tw = Math.max(0.7, Math.min(3.2, pitch * 0.5)); // warp thread width
        const r1 = (v) => v.toFixed(1);

        const root = svg('svg', { class: 'lm-svg', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Loom: ${fmt(warp.threads.length)} warp threads in ${warp.pkgs.length} packages, ${fmt(bands.bands.length)} plan bands, ${rows.rows.length} session rows. Time runs down the cloth.` });
        const defs = svg('defs');
        const clipRect = svg('rect', { x: 0, y: 0, width, height });
        const clipPath = svg('clipPath', { id: clipId });
        clipPath.append(clipRect);
        defs.append(clipPath);
        root.append(defs, svg('rect', { class: 'lm-sheet', x: 0, y: 0, width, height }), svg('rect', { class: 'lm-cloth', x: x0, y: clothTop, width: x1 - x0, height: clothH }));

        // Under the warp: the heading's weft, the shuttle's passes, and each pick's run between the threads it rides over.
        const headUnder = svg('g', { class: 'lm-heading' });
        const laneY = (lane) => headTop + 3 + (lane + 0.5) * LANE_PX;
        if (headH) headUnder.append(svg('rect', { class: 'lm-head-ground', x: x0, y: headTop, width: x1 - x0, height: headH }));
        for (const f of heading.floats) if (f.run) headUnder.append(svg('line', { class: `lm-float-weft${f.inferred ? ' lm-loose' : ''}`, x1: r1(X(f.lo)), x2: r1(X(f.hi)), y1: r1(laneY(f.lane)), y2: r1(laneY(f.lane)) }));
        root.append(headUnder);
        const woven = svg('g', { 'clip-path': `url(#${clipId})` });
        root.append(woven);
        const under = svg('g', { class: 'lm-under' });
        woven.append(under);
        for (const b of bands.bands) {
          const y0 = Number.isFinite(b.t0) ? Y(time.at(b.t0)) : clothTop;
          const a = X(b.threads[0].u) - pitch / 2;
          const z = X(b.threads[b.threads.length - 1].u) + pitch / 2;
          if (b.threads.length > 1) under.append(svg('line', { class: `lm-band-run lm-st-${b.it.status}`, 'data-qid': b.qid, x1: r1(a), x2: r1(z), y1: r1(y0 + 0.6), y2: r1(y0 + 0.6) }));
        }
        const pickH = time ? Math.max(1.2, Math.min(4, time.unit * clothH * ROOM.pick * 0.7)) : 2;
        for (const r of rows.rows) {
          const y = Y(time.at(r.t0));
          under.append(svg('line', { class: `lm-pass lm-dye-${r.dye}`, x1: x0, x2: x1, y1: r1(y), y2: r1(y) }));
          // The shuttle turns at the selvedge: alternate edges, row by row.
          const sx = r.k % 2 ? x1 : x0;
          const dir = r.k % 2 ? 1 : -1;
          under.append(svg('path', { class: `lm-turn lm-dye-${r.dye}`, d: `M${r1(sx)} ${r1(y - 2.5)} q${r1(dir * 4)} 0 ${r1(dir * 4)} 2.5 q0 2.5 ${r1(-dir * 4)} 2.5` }));
          for (const p of r.picks) {
            if (p.over.size < 2) continue;
            const us = [...p.over.keys()].map((t) => t.u);
            const py = Y(time.at(p.t));
            under.append(svg('line', { class: `lm-pick-run lm-dye-${r.dye}`, x1: r1(X(Math.min(...us))), x2: r1(X(Math.max(...us))), y1: r1(py), y2: r1(py) }));
          }
        }

        // The warp: a thread per file, running past the cloth into a fringe.
        const warpG = svg('g', { class: 'lm-warp-layer' });
        const threadParts = [];
        for (const t of warp.threads) {
          const line = svg('line', { class: `lm-warp${t.kind === 'file' ? '' : ' lm-folded'}`, x1: r1(X(t.u)), x2: r1(X(t.u)), y1: headTop - 3, y2: r1(clothBottom + FRINGE), 'stroke-width': tw.toFixed(2) });
          warpG.append(line);
          threadParts.push({ t, line });
        }
        root.insertBefore(warpG, woven);
        // The ground weave: picks that pass over every other thread, alternating, drawn over the warp.
        const ground = svg('g', { class: 'lm-ground' });
        const g0 = x0 + SELVEDGE;
        const gw = x1 - x0 - 2 * SELVEDGE;
        for (let y = clothTop + GROUND_PX / 2, k = 0; y < clothBottom; y += GROUND_PX, k++) {
          ground.append(svg('line', { x1: r1(g0), x2: r1(g0 + gw), y1: r1(y), y2: r1(y), 'stroke-dasharray': `${pitch.toFixed(2)} ${pitch.toFixed(2)}`, 'stroke-dashoffset': k % 2 ? pitch.toFixed(2) : 0, 'stroke-width': (GROUND_PX * 0.5).toFixed(2) }));
        }
        woven.append(ground);
        // Selvedges: denser edge threads either side.
        for (const sx of [x0 + 1.5, x0 + 4, x1 - 4, x1 - 1.5]) root.append(svg('line', { class: 'lm-selvedge', x1: sx, x2: sx, y1: clothTop, y2: clothBottom }));

        // Hit areas: a column per thread, under the bands and picks.
        const hits = svg('g', { class: 'lm-hits' });
        for (const t of warp.threads) {
          const r = svg('rect', { class: 'lm-hit', x: r1(X(t.u) - pitch / 2), y: headTop - 3, width: r1(Math.max(1, pitch)), height: r1(clothBottom + FRINGE - headTop + 3) });
          ctx.interact(ctx, r, {
            label: `${t.label}: ${fmt(t.lines)} lines`,
            tip: () => threadTip(t),
            pick: t.sel ? () => ctx.select({ artifactId: t.sel }) : undefined,
          });
          hits.append(r);
        }
        root.append(hits);

        // The heading's floats: the importing thread passes over its weft; a small bind where the weft ends.
        const headOver = svg('g', { class: 'lm-heading' });
        for (const f of heading.floats) {
          const y = laneY(f.lane);
          const g = svg('g', { class: `lm-float-mark${f.inferred ? ' lm-loose' : ''}` });
          g.append(
            svg('line', { class: 'lm-float', x1: r1(X(f.from.u)), x2: r1(X(f.from.u)), y1: r1(y - LANE_PX * 0.48), y2: r1(y + LANE_PX * 0.48), 'stroke-width': (tw + 1.2).toFixed(2) }),
            ...(f.run ? [svg('rect', { class: 'lm-bind', x: r1(X(f.to.u) - 1.4), y: r1(y - 1.4), width: 2.8, height: 2.8 })] : [])
          );
          const tip = f.run
            ? [`${clip(f.from.label, 40)} → ${clip(f.to.label, 40)}`, ['Dependencies', fmt(f.count)], ['Weight', fmt(f.weight)]]
            : [`${clip(f.from.label, 40)} imports ${f.list.length} more threads`, ...f.list.slice(0, 4).map((x) => ['→', clip(x.to.label, 40)]), ...(f.list.length > 4 ? [`and ${f.list.length - 4} more`] : []), 'No lane was free for their wefts'];
          ctx.interact(ctx, g, {
            label: f.run ? `${f.from.label} imports ${f.to.label}` : `${f.from.label} imports ${f.list.length} more threads`,
            tip: () => [...tip, ...(f.inferred ? ['≈ Inferred by a heuristic'] : []), ...(f.from.sel ? ['Click to select the importing thread'] : [])],
            pick: f.from.sel ? () => ctx.select({ artifactId: f.from.sel }) : undefined,
          });
          headOver.append(g);
        }
        root.append(headOver);

        // Bands: the item's weft rides over each thread it names, a pick at a time, alternating thread to thread.
        const over = svg('g', { class: 'lm-over-layer' });
        woven.append(over);
        const bandParts = [];
        for (const b of bands.bands) {
          const y0 = Number.isFinite(b.t0) ? Y(time.at(b.t0)) : clothTop;
          const y1 = Number.isFinite(b.t1) ? Y(time.at(b.t1)) : clothBottom;
          const yb = Math.max(y1, y0 + 3);
          const inferred = b.it.confidence === 'inferred';
          const d = inferred ? [1.2, 3] : [2.2, 2.2];
          const on = !!selection && selection.itemId === b.qid;
          const g = svg('g', { class: `lm-band lm-st-${b.it.status}${inferred ? ' lm-loose' : ''}${on ? ' lm-on' : ''}${Number.isFinite(b.t0) ? '' : ' lm-undated'}` });
          for (const t of b.threads) {
            g.append(svg('line', { x1: r1(X(t.u)), x2: r1(X(t.u)), y1: r1(y0), y2: r1(yb), 'stroke-width': Math.max(1.4, pitch * 0.92).toFixed(2), 'stroke-dasharray': `${d[0]} ${d[1]}`, 'stroke-dashoffset': t.i % 2 ? d[0] : 0 }));
          }
          ctx.interact(ctx, g, {
            label: `${b.it.title}: ${STATUS_TEXT[b.it.status] || b.it.status}`,
            tip: () => bandTip(b),
            pick: () => ctx.select({ itemId: b.qid }),
          });
          over.append(g);
          bandParts.push({ b, g, status: null });
        }

        // Rows: each pick rides over the threads its turn read or edited.
        const rowParts = [];
        for (const r of rows.rows) {
          const on = !!selection && selection.sessionId === r.id;
          const g = svg('g', { class: `lm-row lm-dye-${r.dye}${on ? ' lm-on' : ''}` });
          for (const p of r.picks) {
            if (!p.over.size) continue;
            const py = Y(time.at(p.t));
            const pg = svg('g', { class: `lm-pick${on && selection.turnId && p.turnIds.includes(selection.turnId) ? ' lm-on' : ''}` });
            for (const o of p.over.values()) {
              const h = o.edits ? pickH : pickH * 0.7;
              pg.append(svg('rect', { class: `lm-over${o.edits ? '' : ' lm-read'}${o.inferred ? ' lm-loose' : ''}`, x: r1(X(o.thread.u) - pitch * 0.62), y: r1(py - h / 2), width: r1(Math.max(1.6, pitch * 1.24)), height: r1(h) }));
            }
            const turnId = p.turnIds.length === 1 ? p.turnIds[0] : null;
            ctx.interact(ctx, pg, {
              label: `${r.label}, ${turnId ? `turn ${p.first}` : 'turns'}: ${p.over.size} threads`,
              tip: () => pickTip(r, p),
              pick: () => ctx.select(turnId ? { sessionId: r.id, turnId } : { sessionId: r.id }),
            });
            g.append(pg);
          }
          over.append(g);
          rowParts.push({ r, g });
        }

        // The right margin: a session's name at its pass, where there's room.
        const rowLabels = [];
        let lastY = -Infinity;
        for (const r of rows.rows) {
          const y = Y(time.at(r.t0));
          if (y - lastY < 11) continue;
          lastY = y;
          const on = !!selection && selection.sessionId === r.id;
          const t = svgText({ class: `lm-row-label lm-dye-${r.dye}${on ? ' lm-on' : ''}`, x: r1(x1 + 8), y: r1(y + 3) }, ctx.fit(r.label, right - 12));
          ctx.interact(ctx, t, { label: `Session ${r.label}`, tip: () => rowTip(r), pick: () => ctx.select({ sessionId: r.id }) });
          root.append(t);
          rowLabels.push({ r, t });
        }

        // The left margin: dates down the cloth, a label where the day changes and there's room.
        if (time) {
          let lastDay = '';
          let lastLY = -Infinity;
          time.ts.forEach((t, k) => {
            const d = new Date(t);
            const day = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
            const y = Y(time.ny[k]);
            if (day === lastDay || y - lastLY < 12) return;
            lastDay = day;
            lastLY = y;
            root.append(svg('line', { class: 'lm-tick', x1: x0 - 4, x2: x0, y1: r1(y), y2: r1(y) }), svgText({ class: 'lm-date', x: x0 - 7, y: r1(y + 3), 'text-anchor': 'end' }, day));
          });
        }

        // Package names across the top, each over its threads.
        for (const p of warp.pkgs) {
          const a = X(p.threads[0].u) - pitch / 2;
          const z = X(p.threads[p.threads.length - 1].u) + pitch / 2;
          root.append(svg('path', { class: 'lm-bracket', d: `M${r1(a)} ${headTop - 6} v-3 H${r1(z)} v3` }));
          const text = ctx.fit(p.label, Math.max(0, z - a + pitch * PACKAGE_GAP - 2));
          if (!text || z - a < 14) continue;
          const on = !!selection && p.sel && selection.artifactId === p.sel;
          const t = svgText({ class: `lm-pkg${on ? ' lm-on' : ''}`, x: r1(a), y: headTop - 12 }, text);
          ctx.interact(ctx, t, {
            label: `${p.label}: ${p.files.length} files`,
            tip: () => [p.label, ['Files', fmt(p.files.length)], ['Threads', fmt(p.threads.length)], ['Lines', fmt(p.files.reduce((n, f) => n + f.lines, 0))], ...(p.sel ? ['Click to select the package'] : [])],
            pick: p.sel ? () => ctx.select({ artifactId: p.sel }) : undefined,
          });
          root.append(t);
        }

        // Selection on the warp: the thread named, or every thread under a named module or package.
        for (const { t, line } of threadParts) if (selection && selection.artifactId && t.anc.has(selection.artifactId)) line.classList.add('lm-on');

        // The fell: the woven edge, which moves down the cloth as the sessions replay.
        const fell = svg('line', { class: 'lm-fell', x1: x0 - 3, x2: x1 + 3, y1: 0, y2: 0, visibility: 'hidden' });
        const stamp = svgText({ class: 'lm-stamp', x: width - 8, y: height - 4, 'text-anchor': 'end' }, '');
        root.append(fell, stamp);

        const legend = el('div', { class: 'lm-legend' }, [
          ...STATUS_ORDER.filter((st) => bands.bands.some((b) => b.it.status === st)).map((st) => el('span', { class: 'lm-key' }, [el('span', { class: `lm-swatch lm-sw-${st}` }), STATUS_TEXT[st]])),
          ...(rows.rows.length ? [el('span', { class: 'lm-key' }, [el('span', { class: 'lm-swatch lm-sw-weft' }), 'session pick: edit']), el('span', { class: 'lm-key' }, [el('span', { class: 'lm-swatch lm-sw-weft lm-sw-read' }), 'read'])] : []),
          ...(heading.floats.length ? [el('span', { class: 'lm-key' }, [el('span', { class: 'lm-swatch lm-sw-float' }), 'float: imports']) ] : []),
          el('span', { class: 'lm-key' }, [el('span', { class: 'lm-swatch lm-sw-loose' }), 'loose weave: inferred']),
        ]);
        frame.replaceChildren(root, el('div', { class: 'lm-foot' }, [views.length ? bar.element : null, legend]));
        scene = { clipRect, fell, stamp, bandParts, rowLabels, Y, clothTop, clothBottom, width, height };
        paintFrame();
        note.textContent = noteText();
        fit.settle(height, draw);
      }

      function noteText() {
        const { warp, heading, rows, bands, time, hasCodeJoin } = layout;
        const said = [];
        const per = warp.foldedToModules || warp.foldedPackages || warp.foldedToOther ? 'a thread per file, module, or package (see Folded)' : 'a thread per file';
        said.push(`The warp is the code: ${per}, grouped by package with an empty dent between packages, in path order. ${heading.floats.length ? 'The heading above the cloth has a float wherever a thread’s imports cross to another: the importing thread passes over a short weft that runs to the thread it imports.' : 'No file imports another loaded file, so the heading has no floats.'}`);
        if (subject === 'code') {
          said.push('Drawn for code alone, the cloth is plain weave: switch to Workspace to weave the plan and the sessions across it.');
        } else {
          if (time) said.push('The weft is time, running down the cloth: quiet stretches are shortened (time takes room by the square root of its share of the span) so that each session and each plan item has room.');
          if (bands.bands.length) said.push(`Each plan item that names loaded code is a band over the threads it names, from its creation down to its close (open work runs to the bottom, still on the loom), dyed by status.${bands.undated ? ` ${bands.undated} undated items start at the top.` : ''}${bands.unjoined ? ` ${fmt(bands.unjoined)} of ${fmt(bands.total)} items name no loaded code and aren’t woven.` : ''}`);
          else if (!ws.plans.length) said.push('No plan is loaded, so there are no bands.');
          else said.push(bands.total ? `None of the plan’s ${fmt(bands.total)} items names loaded code, so there are no bands.` : 'The plan has no items, so there are no bands.');
          if (!views.length) said.push('No sessions are loaded, so there are no rows and nothing replays.');
          else if (!hasCodeJoin) said.push(`The sessions carry no file targets (the session→code join is empty, as in redacted traces), so this is a plain plan-over-code weave: each of the ${rows.rows.length} sessions is a bare pass of the shuttle across the cloth at its start, catching no threads.`);
          else said.push(`A row is a session: a pass of the shuttle across the cloth at its start, then a pick per turn that rides over the threads the turn read (light) or edited (full); ${fmt(rows.touches - rows.unmatched)} of ${fmt(rows.touches)} reads and edits found a loaded file. Unanchored matches are inferred and drawn as a looser weave. As the sessions replay, the fell (the woven edge) moves down the cloth; before the replay moves and at its end, the whole cloth shows, its long exposure, and bands take their state at the replay’s time (open until closed).`);
        }
        const folds = [];
        if (warp.foldedToModules) folds.push(`${fmt(warp.files)} files to their modules (over ${MAX_THREADS} threads)`);
        if (warp.foldedPackages) folds.push(`${warp.foldedPackages} packages to one thread each`);
        if (warp.foldedToOther) folds.push(`${warp.foldedToOther} small packages into one thread`);
        if (heading.folded) folds.push(`${fmt(heading.folded)} of ${fmt(heading.pairs)} import pairs left out of the heading (over ${MAX_FLOATS})`);
        if (heading.unrun) folds.push(`${fmt(heading.unrun)} import pairs found no free lane (over ${MAX_FLOAT_LANES}), so their floats share one mark per importing thread in the heading’s last row, without the weft to the thread imported`);
        if (bands.folded) folds.push(`${fmt(bands.folded)} plan items left off, finished and oldest first (over ${MAX_BANDS} bands)`);
        if (rows.folded) folds.push(`the ${fmt(rows.folded)} oldest sessions left off (over ${MAX_ROWS} rows)`);
        if (rows.rows.some((r) => r.turns > MAX_PICKS)) folds.push(`turns sharing picks in sessions of more than ${MAX_PICKS} turns`);
        if (folds.length) said.push(`Folded: ${folds.join('; ')}.`);
        said.push('Click a thread for its file, a band for its item, a pick for its session’s turn, or a name in the margin for the session.');
        return said.join(' ');
      }

      // ---------- tooltips ----------
      function threadTip(t) {
        const rows = [t.kind === 'other' ? t.label : clip(t.label, 60)];
        if (t.path) rows.push(['Path', clip(t.path, 60)]);
        rows.push(['Package', t.pkg.label], ['Lines', fmt(t.lines)]);
        if (t.files.length > 1) rows.push(['Files', fmt(t.files.length)]);
        const out = layout.heading.out.get(t) || 0;
        const into = layout.heading.into.get(t) || 0;
        if (out || into) rows.push(['Imports, imported by', `${fmt(out)}, ${fmt(into)}`]);
        const items = layout.bands.bands.filter((b) => b.threads.includes(t)).length;
        if (items) rows.push(['Plan items', fmt(items)]);
        const sessions = layout.rows.rows.filter((r) => r.threads.has(t)).length;
        if (sessions) rows.push(['Sessions', fmt(sessions)]);
        if (t.sel) rows.push('Click to select');
        return rows;
      }
      function bandTip(b) {
        const rows = [clip(b.it.title, 80), ['Status', STATUS_TEXT[b.it.status] || b.it.status], ['Kind', b.it.kind]];
        if (b.it.created) rows.push(['Opened', formatTime(b.it.created)]);
        if (Number.isFinite(b.t1)) rows.push(['Closed', formatTime(new Date(b.t1).toISOString())]);
        rows.push(['Threads', `${fmt(b.threads.length)}: ${clip(b.threads.slice(0, 4).map((t) => t.label).join(', '), 60)}`]);
        if (b.it.confidence === 'inferred') rows.push('≈ Inferred from its source');
        rows.push('Click to select');
        return rows;
      }
      function rowTip(r) {
        const rows = [r.label, ['Session', short(r.id)], ['Started', formatTime(r.v.summary.firstTs)], ['Turns', fmt(r.turns)], ['Threads touched', fmt(r.threads.size)]];
        if (!layout.hasCodeJoin) rows.push('No file targets in these traces');
        rows.push('Click to select');
        return rows;
      }
      function pickTip(r, p) {
        const list = [...p.over.values()].sort((a, b) => b.edits - a.edits || b.reads - a.reads);
        const rows = [r.label, [p.turnIds.length > 1 ? 'Turns' : 'Turn', p.turnIds.length > 1 ? `${p.first}–${p.first + p.turnIds.length - 1}` : String(p.first || '—')], ['At', formatTime(new Date(p.t).toISOString())]];
        rows.push(['Edits, reads', `${fmt(list.reduce((n, o) => n + o.edits, 0))}, ${fmt(list.reduce((n, o) => n + o.reads, 0))}`]);
        for (const o of list.slice(0, 5)) rows.push([clip(o.thread.label, 30), `${o.edits ? `${o.edits} edit${o.edits > 1 ? 's' : ''}` : `${o.reads} read${o.reads > 1 ? 's' : ''}`}${o.inferred ? ' ≈' : ''}`]);
        if (list.length > 5) rows.push(`and ${list.length - 5} more threads`);
        rows.push(p.turnIds.length === 1 ? 'Click to select the turn' : 'Click to select the session');
        return rows;
      }

      // ---------- each frame ----------
      function statusAt(it, T, during) {
        if (!during) return it.status;
        const d = ms(it.closed) || ms(it.updated);
        if ((it.status === 'done' || it.status === 'dropped') && Number.isFinite(d) && d > T) return 'open';
        return it.status;
      }
      function paintFrame() {
        bar.sync();
        if (!scene || !layout) return;
        if (clock.playing || (opened !== null && clock.time !== opened)) moved = true;
        const during = views.length > 0 && clock.events.length > 0 && moved && !clock.atEnd() && !!layout.time;
        const T = during ? clock.time : Infinity;
        const fellY = during ? scene.Y(layout.time.at(T)) : scene.height;
        scene.clipRect.setAttribute('height', Math.max(0, fellY).toFixed(1));
        if (during) {
          scene.fell.setAttribute('y1', fellY.toFixed(1));
          scene.fell.setAttribute('y2', fellY.toFixed(1));
          scene.fell.setAttribute('visibility', 'visible');
        } else scene.fell.setAttribute('visibility', 'hidden');
        for (const part of scene.bandParts) {
          const st = statusAt(part.b.it, T, during);
          if (st === part.status) continue;
          for (const s of STATUS_ORDER) part.g.classList.remove(`lm-st-${s}`);
          part.g.classList.add(`lm-st-${st}`);
          part.status = st;
        }
        for (const { r, t } of scene.rowLabels) t.setAttribute('visibility', r.t0 <= T ? 'visible' : 'hidden');
        scene.stamp.textContent = during || (views.length && clock.events.length && clock.atEnd() && moved) ? `${clock.mode() === 'live' ? 'live' : `replay ×${Math.round(clock.speed || 1)}`} · ${formatTime(new Date(clock.time).toISOString())}` : '';
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
