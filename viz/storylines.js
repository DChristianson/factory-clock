// Storylines (hero view, design language `narrative`): the project told as a
// narrative chart. Lanes, one per package, are stacked top to bottom; time
// runs left to right over the loaded sessions' span. Each actor (you, the main
// agent of each session, each subagent) is a line through time that bends into
// the lane of the file it touches and stays there until its next touch, so
// actors working in the same package at the same time run side by side, and
// actors sharing a file are drawn together in one shaded scene. Plan items are
// small marks on the lanes they name, at their opened and closed times. See
// docs/workspace-explorer.md, "Storylines", after Ogawa and Ma's Software
// Evolution Storylines and Munroe's movie narrative charts.
//
// The layout is computed once per workspace on a fixed grid of time slices:
// lanes in order of first touch, actors ordered within a lane by a barycentric
// pass over the slices (each slice ordered by where its actors were in the
// slice before, then after), so lines cross and wiggle little and the same
// input draws the same picture. Replay reveals the lines up to the shared
// clock; before the clock moves, and at the end, the rest state is the long
// exposure, every line drawn. Clicking a line announces { sessionId, turnId },
// a lane { artifactId }, a plan mark { itemId }. Sees only its host and ctx.
(function () {
  const MAX_LANES = 10; // package lanes, an "other packages" lane included
  const MAX_SUBAGENTS = 8; // subagent lines per session; the rest are noted, not drawn
  const MAX_ACTORS = 40; // lines in all, the busiest first
  const SLICES = 120; // time slices the layout is computed on, whatever the width
  const SWEEPS = 4; // barycentric passes over the slices (forward, backward, ...)
  const MAX_EVENTS = 400; // plan marks drawn, the earliest first
  const MAX_SCENES = 200; // shaded scenes where actors share a file
  const UNIT = { min: 3, max: 13 }; // px between lines running side by side in a lane
  const RAIL = 9; // px at the foot of each lane for plan marks
  const LANE_PAD = 5; // px above and below the lines in a lane
  const GUTTER = 20; // px for the "earlier" and "later" plan marks at either side
  const END_ROOM = 92; // px on the right for the labels at the lines' ends
  const ENTRY_KINDS = new Set(['package', 'target']);
  const STATUS_TEXT = { open: 'open', in_progress: 'in progress', blocked: 'blocked', done: 'done', deferred: 'deferred', dropped: 'dropped' };
  const HUES = 6;
  let clipSeq = 0;

  window.factoryClock.register({
    id: 'storylines',
    title: 'Storylines',
    tags: { subject: ['workspace'], category: ['actor', 'temporal'], purpose: ['expressive'], level: ['project'], dimension: ['actor', 'time', 'place'], language: ['narrative'] },
    mount(host, ctx) {
      const { el, svg, svgText, fmt, clip, short, sessionName, agentName, formatTime, hideTip, shapeSelected } = ctx;
      const frame = el('div', { class: 'hero-storylines' });
      const note = el('p', { class: 'muted small' });
      host.replaceChildren(frame, note);
      const clipId = `sl-clip-${++clipSeq}`;
      let ws = null;
      let views = [];
      let selection = null;
      let layout = null;
      let layoutKey = '';
      let scene = null;
      let moved = false; // whether the replay has moved since the data came: until then the rest state shows
      let opened = null;
      const clock = ctx.createReplay({ onFrame: () => paintFrame() });
      const bar = ctx.replayBar(clock, { label: 'Storylines' });
      const fit = ctx.fitter(host);
      const ms = (ts) => (ts ? Date.parse(ts) : NaN);
      const qualify = (root, id) => `${root}::${id}`;

      function update(sessions, sel, options) {
        const o = options || {};
        const given = o.workspace || null;
        views = sessions && sessions.length ? sessions : given && given.sessions ? given.sessions : [];
        ws = {
          code: (given && given.code) || [],
          plans: (given && given.plans) || [],
          touches: given && given.touches instanceof Map ? given.touches : new Map(Object.entries((given && given.touches) || {})),
          joins: { planToCode: [], ...((given && given.joins) || {}) },
        };
        selection = sel || null;
        const key = [ws.code.map((g) => `${g.source.root}:${g.artifacts.length}`).join(','), ws.plans.map((p) => `${p.source.root}:${p.items.length}`).join(','), views.map((v) => v.summary.sessionId).join(','), [...ws.touches.values()].reduce((n, l) => n + l.length, 0), ws.joins.planToCode.length].join('|');
        if (key !== layoutKey || !layout) {
          layout = buildLayout();
          layoutKey = key;
          moved = false;
          clock.setSessions(views);
          opened = clock.time;
        }
        draw();
      }

      // ---------- the layout, computed once per workspace ----------
      function buildLayout() {
        // Lanes: a package (or target) per lane; files under neither share one lane per graph.
        const laneMap = new Map();
        const laneOfArt = new Map(); // qualified artifact id → lane key
        const exact = new Map(); // path → [{ qid, lane }]
        const all = [];
        const multi = ws.code.length > 1;
        for (const g of ws.code) {
          const root = g.source.root;
          const byId = new Map(g.artifacts.map((a) => [a.id, a]));
          const laneFor = (a) => {
            for (let p = a, guard = 0; p && guard < 64; p = byId.get(p.parent), guard++) if (ENTRY_KINDS.has(p.kind)) return p;
            return null;
          };
          for (const a of g.artifacts) {
            if (a.kind === 'external' || a.kind === 'workspace') continue;
            const pkg = laneFor(a);
            const key = pkg ? qualify(root, pkg.id) : qualify(root, '(no package)');
            if (!laneMap.has(key)) laneMap.set(key, { key, label: `${multi ? root + ' · ' : ''}${pkg ? pkg.name : '(no package)'}`, sel: pkg ? key : null, files: 0, touches: 0, first: Infinity, actors: new Set(), loose: !pkg });
            const lane = laneMap.get(key);
            const qid = qualify(root, a.id);
            laneOfArt.set(qid, key);
            if (a.kind === 'file') lane.files += 1;
            if (a.path && a.kind === 'file') {
              if (!exact.has(a.path)) exact.set(a.path, []);
              exact.get(a.path).push({ qid, lane: key, path: a.path });
              all.push({ path: a.path, qid, lane: key });
            }
          }
        }
        const suffix = new Map();
        const match = (t) => {
          if (t.anchored) return (exact.get(t.path) || [])[0] || null;
          if (!suffix.has(t.path)) {
            const m = all.filter((x) => x.path === t.path || x.path.endsWith('/' + t.path));
            suffix.set(t.path, m.length === 1 ? m[0] : null);
          }
          return suffix.get(t.path);
        };

        // Sessions in order of start, and the span time runs over.
        const sessions = [...views].sort((a, b) => (ms(a.summary.firstTs) || 0) - (ms(b.summary.firstTs) || 0) || a.summary.sessionId.localeCompare(b.summary.sessionId));
        let t0 = Infinity;
        let t1 = -Infinity;
        for (const v of sessions) {
          for (const ts of [v.summary.firstTs, v.summary.lastTs]) {
            const t = ms(ts);
            if (Number.isFinite(t)) {
              t0 = Math.min(t0, t);
              t1 = Math.max(t1, t);
            }
          }
        }

        // Actors: each session's main agent and subagents, from the touches they made.
        const actors = [];
        let touchCount = 0;
        let unmatched = 0;
        let foldedAgents = 0;
        let rawTouches = 0;
        sessions.forEach((v, si) => {
          const sid = v.summary.sessionId;
          const list = ws.touches.get(sid) || [];
          rawTouches += list.length;
          const byActor = new Map();
          for (const t of list) {
            const tt = ms(t.ts);
            if (!Number.isFinite(tt)) continue;
            const hit = match(t);
            if (!hit) {
              unmatched += 1;
              continue;
            }
            touchCount += 1;
            const a = t.agentId || '';
            if (!byActor.has(a)) byActor.set(a, []);
            byActor.get(a).push({ t: tt, lane: hit.lane, file: hit.qid, path: hit.path, inferred: !t.anchored, turnId: t.turnId || null, kind: t.kind });
          }
          const life = new Map(); // agentId → [first, last] from its events
          for (const x of [...(v.calls || []), ...(v.tools || [])]) {
            const t = ms(x.ts);
            if (!Number.isFinite(t)) continue;
            const a = x.agentId || '';
            const l = life.get(a);
            life.set(a, l ? [Math.min(l[0], t), Math.max(l[1], t)] : [t, t]);
          }
          const subs = [...byActor.keys()].filter((a) => a).sort((a, b) => byActor.get(b).length - byActor.get(a).length || a.localeCompare(b));
          const keptSubs = subs.slice(0, MAX_SUBAGENTS);
          foldedAgents += subs.length - keptSubs.length;
          const sname = sessionName(v.summary, 40);
          for (const a of ['', ...keptSubs]) {
            const pts = byActor.get(a);
            if (!pts || !pts.length) continue;
            pts.sort((p, q) => p.t - q.t);
            const l = life.get(a) || [pts[0].t, pts[pts.length - 1].t];
            const start = a ? Math.min(l[0], pts[0].t) : Math.min(ms(v.summary.firstTs) || pts[0].t, pts[0].t);
            const end = a ? Math.max(l[1], pts[pts.length - 1].t) : Math.max(ms(v.summary.lastTs) || pts[pts.length - 1].t, pts[pts.length - 1].t);
            actors.push({
              id: `${sid}|${a}`,
              kind: a ? 'sub' : 'main',
              sid,
              si,
              agentId: a,
              session: v,
              sname,
              label: a ? `S${si + 1} agent ${a.replace(/^agent-/, '').slice(0, 4)}` : `S${si + 1} ${agentName(v.summary.agent || 'agent')}`,
              pts,
              start,
              end,
            });
          }
        });
        let foldedActors = 0;
        if (actors.length > MAX_ACTORS - 1) {
          const ranked = [...actors].sort((a, b) => b.pts.length - a.pts.length || a.id.localeCompare(b.id));
          const keep = new Set(ranked.slice(0, MAX_ACTORS - 1));
          foldedActors = actors.length - keep.size;
          for (let i = actors.length - 1; i >= 0; i--) if (!keep.has(actors[i])) actors.splice(i, 1);
        }
        const hasCode = laneMap.size > 0;
        const storied = actors.length > 0;
        if (!Number.isFinite(t0) && storied) {
          t0 = Math.min(...actors.map((a) => a.start));
          t1 = Math.max(...actors.map((a) => a.end));
        }
        // Without sessions, plan marks still run over their own span.
        const planTimes = [];
        for (const p of ws.plans) for (const it of p.items) for (const ts of [it.created, it.closed]) if (Number.isFinite(ms(ts))) planTimes.push(ms(ts));
        let spanFrom = 'sessions';
        if (!Number.isFinite(t0) && planTimes.length) {
          t0 = Math.min(...planTimes);
          t1 = Math.max(...planTimes);
          spanFrom = 'plan';
        }
        if (!Number.isFinite(t0)) {
          t0 = 0;
          t1 = 1;
          spanFrom = 'none';
        }
        if (t1 <= t0) t1 = t0 + 60000;
        const dt = (t1 - t0) / SLICES;
        const sliceOf = (t) => Math.max(0, Math.min(SLICES - 1, Math.floor((t - t0) / dt)));

        // You: in the scene of the session you prompt, until your next prompt.
        if (storied) {
          const mains = new Map(actors.filter((a) => a.kind === 'main').map((a) => [a.sid, a]));
          const pts = [];
          for (const v of sessions) {
            const main = mains.get(v.summary.sessionId);
            if (!main) continue;
            for (const p of v.prompts || []) {
              const t = ms(p.ts);
              if (!Number.isFinite(t)) continue;
              const at = laneAt(main, t);
              pts.push({ t, lane: at.lane, file: null, inferred: at.inferred, turnId: p.turnId || null, sid: v.summary.sessionId, prompt: true });
            }
          }
          if (pts.length) {
            pts.sort((p, q) => p.t - q.t);
            const end = Math.max(...actors.filter((a) => a.kind === 'main').map((a) => a.end));
            actors.unshift({ id: 'you', kind: 'you', sid: null, si: -1, label: 'you', pts, start: pts[0].t, end: Math.max(end, pts[pts.length - 1].t) });
          }
        }

        // Lanes in order of their first touch, then the untouched by size; past the limit the rest share one.
        for (const a of actors) for (const p of a.pts) {
          const lane = laneMap.get(p.lane);
          if (a.kind !== 'you') lane.touches += 1;
          lane.first = Math.min(lane.first, p.t);
          lane.actors.add(a.id);
        }
        let lanes = [...laneMap.values()].sort((a, b) => (a.first === b.first ? 0 : a.first - b.first) || b.files - a.files || a.label.localeCompare(b.label));
        let foldedLanes = 0;
        const laneIndex = new Map();
        if (lanes.length > MAX_LANES) {
          const rest = lanes.slice(MAX_LANES - 1);
          foldedLanes = rest.length;
          const other = { key: '(other)', label: `${rest.length} other packages`, sel: null, files: rest.reduce((n, l) => n + l.files, 0), touches: rest.reduce((n, l) => n + l.touches, 0), first: Math.min(...rest.map((l) => l.first)), actors: new Set(rest.flatMap((l) => [...l.actors])), other: true, members: rest };
          lanes = [...lanes.slice(0, MAX_LANES - 1), other];
          for (const l of rest) laneIndex.set(l.key, lanes.length - 1);
        }
        lanes.forEach((l, i) => {
          l.index = i;
          laneIndex.set(l.key, i);
        });

        // Each actor's lane, file, and turn at each slice of its life: its last touch so far, or its first before it.
        for (const a of actors) {
          a.s0 = sliceOf(a.start);
          a.s1 = sliceOf(a.end);
          a.at = [];
          let k = 0;
          let cur = a.pts[0];
          for (let s = a.s0; s <= a.s1; s++) {
            const slot = { lane: laneIndex.get(cur.lane), file: cur.file, inferred: cur.inferred, turnId: cur.turnId, sid: cur.sid || a.sid, before: a.pts[0].t > t0 + (s + 1) * dt };
            let touched = null;
            while (k < a.pts.length && sliceOf(a.pts[k].t) <= s) {
              cur = a.pts[k];
              touched = cur;
              k++;
            }
            if (touched || k > 0) Object.assign(slot, { lane: laneIndex.get(cur.lane), file: cur.file, inferred: cur.inferred, turnId: cur.turnId, sid: cur.sid || a.sid, before: false });
            slot.path = cur.path || null;
            a.at[s] = slot;
          }
        }

        // Order within lanes: a barycentric pass over the slices.
        const rank = new Map(actors.map((a, i) => [a, i]));
        const pos = new Map(actors.map((a) => [a, []])); // actor → units from the top of the stack, per slice
        const cap = lanes.map(() => 1);
        const present = []; // slice → lane → actors
        for (let s = 0; s < SLICES; s++) {
          const byLane = lanes.map(() => []);
          for (const a of actors) if (a.at[s]) byLane[a.at[s].lane].push(a);
          present.push(byLane);
          byLane.forEach((list, i) => (cap[i] = Math.max(cap[i], list.length)));
        }
        const laneTop = [];
        let acc = 0;
        for (let i = 0; i < lanes.length; i++) {
          laneTop.push(acc);
          acc += cap[i];
        }
        const order = present.map((byLane) => byLane.map((list) => [...list].sort((a, b) => rank.get(a) - rank.get(b))));
        const place = (s) => {
          order[s].forEach((list, i) => {
            const off = laneTop[i] + (cap[i] - list.length) / 2;
            list.forEach((a, k) => (pos.get(a)[s] = off + k + 0.5));
          });
        };
        for (let s = 0; s < SLICES; s++) place(s);
        const reorder = (s, from) => {
          order[s] = order[s].map((list) => {
            if (list.length < 2) return list;
            const key = new Map(list.map((a) => {
              const p = pos.get(a);
              const k = p[from] !== undefined ? p[from] : p[s];
              return [a, k];
            }));
            // Actors sharing a file sit together: a group's key is the mean of its members'.
            const groups = new Map();
            for (const a of list) {
              const f = a.at[s].file || `(${a.id})`;
              if (!groups.has(f)) groups.set(f, []);
              groups.get(f).push(a);
            }
            const gk = new Map();
            for (const [f, members] of groups) gk.set(f, members.reduce((n, a) => n + key.get(a), 0) / members.length);
            const fileOf = (a) => a.at[s].file || `(${a.id})`;
            return [...list].sort((a, b) => gk.get(fileOf(a)) - gk.get(fileOf(b)) || (fileOf(a) === fileOf(b) ? 0 : fileOf(a) < fileOf(b) ? -1 : 1) || key.get(a) - key.get(b) || rank.get(a) - rank.get(b));
          });
          place(s);
        };
        for (let sweep = 0; sweep < SWEEPS; sweep++) {
          if (sweep % 2 === 0) for (let s = 1; s < SLICES; s++) reorder(s, s - 1);
          else for (let s = SLICES - 2; s >= 0; s--) reorder(s, s + 1);
        }
        for (let s = 1; s < SLICES; s++) reorder(s, s - 1); // end forward, so a line keeps its place from the left

        // Scenes: two or more actors on one file at once, merged over consecutive slices.
        const scenes = [];
        const openScenes = new Map();
        for (let s = 0; s < SLICES; s++) {
          const seen = new Set();
          for (const list of order[s]) {
            const byFile = new Map();
            for (const a of list) if (a.at[s].file && a.kind !== 'you') (byFile.get(a.at[s].file) || byFile.set(a.at[s].file, []).get(a.at[s].file)).push(a);
            for (const [file, members] of byFile) {
              if (members.length < 2) continue;
              const ys = members.map((a) => pos.get(a)[s]);
              const k = `${file}|${members.map((a) => a.id).sort().join(',')}`;
              const top = Math.min(...ys);
              const bot = Math.max(...ys);
              const prev = openScenes.get(k);
              if (prev && prev.s1 === s - 1 && prev.top === top && prev.bot === bot) prev.s1 = s;
              else {
                const sc = { key: k, file, path: members[0].at[s].path, lane: members[0].at[s].lane, members, s0: s, s1: s, top, bot };
                scenes.push(sc);
                openScenes.set(k, sc);
              }
              seen.add(k);
            }
          }
          for (const k of [...openScenes.keys()]) if (!seen.has(k)) openScenes.delete(k);
        }
        scenes.sort((a, b) => b.s1 - b.s0 - (a.s1 - a.s0) || a.s0 - b.s0);
        const foldedScenes = Math.max(0, scenes.length - MAX_SCENES);
        scenes.length = Math.min(scenes.length, MAX_SCENES);

        // Plan marks: an item's opening and closing on each lane it names.
        const itemLanes = new Map();
        for (const j of ws.joins.planToCode) {
          const lk = laneOfArt.get(j.to);
          if (lk === undefined || !laneIndex.has(lk)) continue;
          if (!itemLanes.has(j.from)) itemLanes.set(j.from, new Set());
          itemLanes.get(j.from).add(laneIndex.get(lk));
        }
        const events = [];
        let planItems = 0;
        for (const p of ws.plans) {
          for (const it of p.items) {
            planItems += 1;
            const qid = qualify(p.source.root, it.id);
            const ls = itemLanes.get(qid);
            if (!ls) continue;
            for (const [act, ts] of [['opened', it.created], ['closed', it.closed]]) {
              const t = ms(ts);
              if (!Number.isFinite(t)) continue;
              if (act === 'closed' && it.status !== 'done' && it.status !== 'dropped') continue;
              for (const li of ls) events.push({ qid, it, act, t, lane: li, side: t < t0 ? 'before' : t > t1 ? 'after' : 'in' });
            }
          }
        }
        events.sort((a, b) => a.t - b.t || a.qid.localeCompare(b.qid) || a.lane - b.lane);
        const foldedEvents = Math.max(0, events.length - MAX_EVENTS);
        events.length = Math.min(events.length, MAX_EVENTS);
        const stack = new Map();
        for (const e of events) {
          const k = e.side === 'in' ? `${e.lane}|${sliceOf(e.t)}` : `${e.lane}|${e.side}`;
          e.k = stack.get(k) || 0;
          stack.set(k, e.k + 1);
        }
        const gutters = new Map(); // `${lane}|${side}` → events
        for (const e of events) if (e.side !== 'in') (gutters.get(`${e.lane}|${e.side}`) || gutters.set(`${e.lane}|${e.side}`, []).get(`${e.lane}|${e.side}`)).push(e);

        return { lanes, cap, laneTop, units: acc, actors, pos, scenes, events, gutters, t0, t1, dt, sliceOf, spanFrom, hasCode, storied, touchCount, unmatched, rawTouches, sessions, foldedLanes, foldedAgents, foldedActors, foldedScenes, foldedEvents, planItems, linkedItems: itemLanes.size, laneOfArt, laneIndex };
      }
      /** Where an actor was at time t: its last touch at or before t, or its first. */
      function laneAt(actor, t) {
        let cur = actor.pts[0];
        for (const p of actor.pts) if (p.t <= t) cur = p;
        return cur;
      }

      // ---------- drawing ----------
      function draw() {
        hideTip();
        if (!layout) return;
        const L = layout;
        if (!L.hasCode) {
          frame.replaceChildren(el('p', { class: 'sl-empty', text: ws.code.length ? 'The loaded code graph has no packages or files, so there are no lanes to tell the story in.' : 'No code is loaded. Storylines draws a lane per package and each actor’s line through them: load a code graph and sessions (Sessions and project ↓).' }));
          note.textContent = '';
          scene = null;
          return;
        }
        const width = Math.max(320, host.clientWidth || 800);
        const labelW = Math.round(Math.min(150, Math.max(78, width * 0.15)));
        const axisH = 22;
        const n = L.lanes.length;
        const fallback = Math.round(Math.min(640, Math.max(340, axisH + 12 + n * (2 * LANE_PAD + RAIL) + L.units * 9)));
        const height = fit.height(fallback, 260);
        const fixed = axisH + 10 + n * (2 * LANE_PAD + RAIL);
        const unit = Math.max(UNIT.min, Math.min(UNIT.max, (height - fixed) / Math.max(1, L.units)));
        const stretch = Math.max(0, height - fixed - unit * L.units) / Math.max(1, n); // spare height, shared by the lanes
        const laneY = [];
        const laneH = [];
        let y = axisH + 4;
        for (let i = 0; i < n; i++) {
          laneY.push(y);
          laneH.push(2 * LANE_PAD + RAIL + L.cap[i] * unit + stretch);
          y += laneH[i];
        }
        const x0 = labelW + GUTTER + 6;
        const endRoom = L.storied ? Math.min(END_ROOM, width * 0.14) : 0;
        const x1 = Math.max(x0 + 60, width - GUTTER - 8 - endRoom);
        const sw = (x1 - x0) / SLICES;
        const X = (s) => x0 + (s + 0.5) * sw;
        const XT = (t) => x0 + ((t - L.t0) / (L.t1 - L.t0)) * (x1 - x0);
        // Units are from the top of the stack; a lane's lines sit in its band above its rail, centered when it has room to spare.
        const unitY = (u) => {
          let i = 0;
          while (i < n - 1 && u >= L.laneTop[i + 1]) i++;
          return laneY[i] + LANE_PAD + stretch / 2 + (u - L.laneTop[i]) * unit;
        };
        const f1 = (v) => v.toFixed(1);

        const sel = selection || {};
        const selLane = sel.artifactId ? (L.laneIndex.has(sel.artifactId) ? L.laneIndex.get(sel.artifactId) : L.laneOfArt.has(sel.artifactId) ? L.laneIndex.get(L.laneOfArt.get(sel.artifactId)) : -1) : -1;
        const root = svg('svg', { class: 'sl-svg', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Storylines: ${n} package lanes${L.storied ? `, ${L.actors.length} actors’ lines over ${fmt(L.touchCount)} file touches` : ''}${L.events.length ? `, ${L.events.length} plan marks` : ''}.` });
        root.append(svg('rect', { class: 'sl-sheet', x: 0, y: 0, width, height }));

        // Lanes: alternating bands, a rule, the name at the left.
        for (let i = 0; i < n; i++) {
          const lane = L.lanes[i];
          const g = svg('g', { class: `sl-lane${i % 2 ? ' sl-alt' : ''}${lane.other ? ' sl-folded' : ''}${i === selLane ? ' sl-on' : ''}` });
          g.append(svg('rect', { class: 'sl-band', x: 0, y: f1(laneY[i]), width, height: f1(laneH[i]) }));
          g.append(svg('line', { class: 'sl-rail', x1: x0 - GUTTER, x2: x1 + GUTTER, y1: f1(laneY[i] + laneH[i] - RAIL / 2 - 1), y2: f1(laneY[i] + laneH[i] - RAIL / 2 - 1) }));
          const midY = laneY[i] + laneH[i] / 2;
          g.append(svgText({ class: 'sl-lane-name', x: 8, y: f1(midY - (laneH[i] > 26 ? 2 : -3)) }, ctx.fit(lane.label, labelW + 4)));
          if (laneH[i] > 26) g.append(svgText({ class: 'sl-lane-sub', x: 8, y: f1(midY + 10) }, ctx.fit(`${fmt(lane.files)} files${lane.touches ? ` · ${fmt(lane.touches)} touches` : ''}`, labelW + 4)));
          ctx.interact(ctx, g, {
            label: `${lane.label}: ${lane.files} files`,
            tip: () => laneTip(lane),
            pick: lane.sel ? () => ctx.select({ artifactId: lane.sel }) : undefined,
          });
          root.append(g);
        }
        root.append(svg('line', { class: 'sl-margin', x1: labelW, x2: labelW, y1: axisH, y2: height }));

        // The time axis along the top, and the gutters' names.
        const axis = svg('g', { class: 'sl-axis', 'aria-hidden': 'true' });
        const span = L.t1 - L.t0;
        const ticks = L.spanFrom === 'none' ? -1 : Math.max(2, Math.min(6, Math.floor((x1 - x0) / 110))); // no dates at all: no axis
        for (let k = 0; k <= ticks; k++) {
          const t = L.t0 + (span * k) / ticks;
          const x = XT(t);
          axis.append(svg('line', { class: 'sl-tick', x1: f1(x), x2: f1(x), y1: axisH - 4, y2: height }));
          axis.append(svgText({ class: 'sl-tick-label', x: f1(x), y: axisH - 8, 'text-anchor': k === 0 ? 'start' : k === ticks ? 'end' : 'middle' }, tickText(t, span)));
        }
        if (L.gutters.size) {
          axis.append(svgText({ class: 'sl-gutter-label', x: f1(x0 - GUTTER / 2 - 3), y: axisH - 8, 'text-anchor': 'middle' }, '←'));
          axis.append(svgText({ class: 'sl-gutter-label', x: f1(x1 + GUTTER / 2 + 3), y: axisH - 8, 'text-anchor': 'middle' }, '→'));
        }
        root.append(axis);

        // Scenes: actors on one file at once, shaded behind their lines.
        const reveal = svg('g', { class: 'sl-story', 'clip-path': `url(#${clipId})` });
        const clipRect = svg('rect', { x: 0, y: 0, width, height });
        const defs = svg('defs');
        const cp = svg('clipPath', { id: clipId });
        cp.append(clipRect);
        defs.append(cp);
        root.append(defs);
        for (const sc of L.scenes) {
          const top = unitY(sc.top) - unit * 0.5 - 1;
          const bot = unitY(sc.bot) + unit * 0.5 + 1;
          const r = svg('rect', { class: 'sl-scene', x: f1(X(sc.s0) - sw / 2), y: f1(top), width: f1((sc.s1 - sc.s0 + 1) * sw), height: f1(bot - top), rx: f1(Math.min(6, (bot - top) / 2)) });
          ctx.interact(ctx, r, {
            label: `${sc.members.length} actors on ${sc.path}`,
            tip: () => [clip(sc.path || 'a file', 60), ['Together', sc.members.map((a) => a.label).join(', ')], ['From', fmtT(L.t0 + sc.s0 * L.dt)], ['To', fmtT(L.t0 + (sc.s1 + 1) * L.dt)], 'Actors on the same file at the same time'],
          });
          reveal.append(r);
        }

        // The lines: a casing, the line itself (dashed where the file was matched by name only), a wide hit path.
        const parts = [];
        for (const a of L.actors) {
          const p = L.pos.get(a);
          const pts = [];
          for (let s = a.s0; s <= a.s1; s++) pts.push({ s, x: X(s), y: unitY(p[s] - 0.5) + unit * 0.5, inf: a.at[s].inferred });
          if (pts.length === 1) pts.push({ ...pts[0], x: pts[0].x + Math.max(3, sw * 0.6) }); // a moment still reads as a stroke
          pts[0].x -= sw * 0.45;
          pts[pts.length - 1].x += sw * 0.45;
          const d = pathOf(pts);
          const hue = a.kind === 'you' ? '' : ` sl-h${a.si % HUES}`;
          const on = sel.sessionId && (a.sid === sel.sessionId || (a.kind === 'you' && a.pts.some((q) => q.sid === sel.sessionId)));
          const g = svg('g', { class: `sl-actor sl-${a.kind}${hue}${on ? ' sl-on' : ''}${sel.sessionId && !on ? ' sl-dim' : ''}` });
          g.append(svg('path', { class: 'sl-casing', d }));
          g.append(svg('path', { class: 'sl-line', d }));
          if (a.kind === 'you') g.append(svg('path', { class: 'sl-core', d }));
          // Inferred runs drawn again, dashed, over the line.
          let run = [];
          const flush = () => {
            if (run.length > 1) g.append(svg('path', { class: 'sl-inferred', d: pathOf(run) }));
            run = [];
          };
          pts.forEach((q, i) => {
            if (q.inf) {
              if (!run.length && i > 0) run.push(pts[i - 1]);
              run.push(q);
            } else if (run.length) {
              run.push(q);
              flush();
            }
          });
          flush();
          const hit = svg('path', { class: 'sl-hit', d });
          g.append(hit);
          const sliceAt = (e) => {
            if (!e || typeof e.clientX !== 'number' || !root.getBoundingClientRect) return null;
            const r = root.getBoundingClientRect();
            const x = ((e.clientX - r.left) * width) / (r.width || width);
            return Math.max(a.s0, Math.min(a.s1, Math.floor((x - x0) / sw)));
          };
          ctx.interact(ctx, g, {
            label: `${a.label}${a.kind === 'you' ? '' : `, ${a.sname}`}: ${a.pts.length} ${a.kind === 'you' ? 'prompts' : 'touches'}`,
            tip: (e) => actorTip(a, sliceAt(e)),
            pick: (e) => {
              const s = sliceAt(e);
              const at = s === null ? null : a.at[s];
              const sid = (at && at.sid) || a.sid || (a.pts[0] && a.pts[0].sid);
              if (!sid) return;
              ctx.select(at && at.turnId && !at.before ? { sessionId: sid, turnId: at.turnId } : { sessionId: sid });
            },
          });
          reveal.append(g);
          parts.push({ a, g, pts });
        }
        root.append(reveal);

        // Labels at both ends of each line, so actors read without color.
        const labels = svg('g', { class: 'sl-labels' });
        const heads = svg('g', { class: 'sl-heads', 'aria-hidden': 'true' });
        for (const part of parts) {
          const first = part.pts[0];
          const last = part.pts[part.pts.length - 1];
          const cls = `sl-label sl-${part.a.kind}${part.a.kind === 'you' ? '' : ` sl-h${part.a.si % HUES}`}`;
          const startRoom = Math.max(40, Math.min(140, (x1 - first.x) * 0.5));
          labels.append(svgText({ class: cls, x: f1(first.x + 1), y: f1(first.y - Math.max(3, unit * 0.4)) }, ctx.fit(part.a.label, startRoom)));
          // The end gets a label too, unless the line is too short to carry two.
          if (last.x - first.x > part.a.label.length * 5.5 + 24) {
            part.endText = svgText({ class: `${cls} sl-end`, x: f1(last.x + 4), y: f1(last.y + 3) }, ctx.fit(part.a.label, Math.max(40, width - last.x - 4)));
            labels.append(part.endText);
          }
          const head = svg('circle', { class: `sl-head sl-${part.a.kind}${part.a.kind === 'you' ? '' : ` sl-h${part.a.si % HUES}`}`, r: part.a.kind === 'sub' ? 2.6 : 3.4, visibility: 'hidden' });
          heads.append(head);
          part.head = head;
        }
        root.append(labels, heads);

        // Plan marks: opened hollow, closed filled by status, on the lane's rail; outside the span in the gutters.
        const evParts = [];
        const evLayer = svg('g', { class: 'sl-events' });
        for (const e of L.events) {
          if (e.side !== 'in') continue;
          const cy = laneY[e.lane] + laneH[e.lane] - RAIL / 2 - 1;
          const cx = XT(e.t) + e.k * 4;
          const m = eventMark(e, cx, cy, sel);
          ctx.interact(ctx, m, { label: `${e.it.title}, ${e.act}`, tip: () => eventTip([e]), pick: () => ctx.select({ itemId: e.qid }) });
          evLayer.append(m);
          evParts.push({ e, m });
        }
        for (const [k, list] of L.gutters) {
          const [li, side] = k.split('|');
          const lane = Number(li);
          const cy = laneY[lane] + laneH[lane] - RAIL / 2 - 1;
          const cx = side === 'before' ? x0 - GUTTER / 2 - 3 : x1 + GUTTER / 2 + 3;
          const one = new Set(list.map((e) => e.qid)).size === 1;
          const m = eventMark(list[list.length - 1], cx, cy, sel, list.length);
          ctx.interact(ctx, m, {
            label: `${list.length} plan marks ${side === 'before' ? 'before' : 'after'} the sessions`,
            tip: () => eventTip(list, side),
            pick: one ? () => ctx.select({ itemId: list[0].qid }) : undefined,
          });
          evLayer.append(m);
          if (list.length > 1) evLayer.append(svgText({ class: 'sl-count', x: f1(cx), y: f1(cy - 6), 'text-anchor': 'middle' }, String(list.length)));
          evParts.push({ e: list[0], m, gutter: side });
        }
        root.append(evLayer);

        // Without lines, say why where they would be.
        if (!L.storied) {
          const why = !L.sessions.length
            ? 'No sessions loaded: lanes and plan marks only, no one’s story yet.'
            : L.rawTouches
              ? 'No file the sessions touched matches loaded code: no lines to draw.'
              : 'These sessions name no files (the demo traces are redacted): no lines to draw.';
          const cy = axisH + (height - axisH) / 2;
          root.append(svg('rect', { class: 'sl-empty-card', x: f1(x0 + 10), y: f1(cy - 16), width: f1(Math.max(40, x1 - x0 - 20)), height: 28, rx: 4 }));
          root.append(svgText({ class: 'sl-empty-text', x: f1((x0 + x1) / 2), y: f1(cy + 2), 'text-anchor': 'middle' }, ctx.fit(why, x1 - x0 - 24)));
        }
        const stamp = svgText({ class: 'sl-stamp', x: width - 8, y: 12, 'text-anchor': 'end' }, '');
        root.append(stamp);

        const key = (cls, text) => el('span', { class: 'sl-key' }, [el('span', { class: `sl-swatch ${cls}` }), text]);
        const legend = el('div', { class: 'sl-legend' }, [
          ...(L.storied ? [key('sl-sw-you', 'you'), key('sl-sw-main', 'a session’s agent'), key('sl-sw-sub', 'a subagent'), key('sl-sw-scene', 'together on one file'), key('sl-sw-inferred', 'dashed: file matched by name (inferred)')] : []),
          ...(L.events.length ? [key('sl-sw-opened', 'item opened'), ...['done', 'dropped'].filter((st) => L.events.some((e) => e.act === 'closed' && e.it.status === st)).map((st) => key(`sl-sw-closed sl-st-${st}`, `item ${STATUS_TEXT[st]}`))] : []),
        ]);
        frame.replaceChildren(root, el('div', { class: 'sl-foot' }, [views.length ? bar.element : null, legend]));
        scene = { parts, evParts, clipRect, stamp, X, XT, x0, x1, width };
        paintFrame();
        note.textContent = noteText();
        fit.settle(height, draw);
      }

      function pathOf(pts) {
        let d = `M${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1];
          const b = pts[i];
          if (Math.abs(a.y - b.y) < 0.05) d += ` L${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
          else {
            const mx = (a.x + b.x) / 2;
            d += ` C${mx.toFixed(1)} ${a.y.toFixed(1)} ${mx.toFixed(1)} ${b.y.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
          }
        }
        return d;
      }
      function eventMark(e, cx, cy, sel, count) {
        const on = sel.itemId && sel.itemId === e.qid;
        const inferred = e.it.confidence === 'inferred';
        const cls = `sl-event sl-${e.act}${e.act === 'closed' ? ` sl-st-${e.it.status}` : ''}${inferred ? ' sl-inferred-item' : ''}${on ? ' sl-on' : ''}${count > 1 ? ' sl-many' : ''}`;
        if (e.act === 'opened') return svg('circle', { class: cls, cx: cx.toFixed(1), cy: cy.toFixed(1), r: 2.8 });
        const h = 3.4;
        return svg('path', { class: cls, d: `M${cx.toFixed(1)} ${(cy - h).toFixed(1)} L${(cx + h).toFixed(1)} ${cy.toFixed(1)} L${cx.toFixed(1)} ${(cy + h).toFixed(1)} L${(cx - h).toFixed(1)} ${cy.toFixed(1)} Z` });
      }
      function tickText(t, span) {
        const d = new Date(t);
        if (span < 36 * 3600e3) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
      }
      const fmtT = (t) => formatTime(new Date(t).toISOString());

      function noteText() {
        const L = layout;
        const said = [];
        said.push(`A lane per package, stacked in the order the work first reached them; time runs left to right over the ${L.spanFrom === 'plan' ? 'plan’s dates (no sessions are loaded)' : 'loaded sessions’ span'}.`);
        if (L.storied) {
          said.push(`Each line is an actor, you, each session’s agent, and each subagent, bending into the lane of the file it reads or edits and staying there until its next touch (${fmt(L.touchCount)} touches matched to files the way the session→code join matches them; dashed where a file was matched by name alone, which is inferred). Your line follows the session you prompt. Lines run side by side when actors work in one package at once, and a shaded scene marks actors on the same file. Actors are ordered within a lane by a barycentric pass over ${SLICES} time slices, so lines cross little and the same input draws the same picture. As the sessions replay the lines are revealed up to the clock; at rest every line is drawn.`);
          if (L.unmatched) said.push(`${fmt(L.unmatched)} touches matched no loaded file.`);
        } else if (L.sessions.length) said.push(L.rawTouches ? 'None of the sessions’ file reads or edits match a loaded file, so there are no lines.' : 'The loaded sessions’ events carry no file targets (the demo traces are redacted), so there are no lines to draw: only the lanes and the plan.');
        else said.push('No sessions are loaded, so there are no lines: Storylines needs sessions whose events name files.');
        if (!ws.plans.length) said.push('No plan is loaded, so there are no plan marks.');
        else if (!L.planItems) said.push('The plan has no items, so there are no plan marks.');
        else if (!L.events.length) said.push('No plan item names loaded code with an opening or closing date, so there are no plan marks.');
        else {
          const out = L.events.filter((e) => e.side !== 'in').length;
          said.push(`Plan marks sit on the lanes an item names: hollow where it was opened, filled by status where it was closed${out ? `; ${fmt(out)} fall outside the span and are gathered in the gutters at either side` : ''}.`);
        }
        const folds = [];
        if (L.foldedLanes) folds.push(`${L.foldedLanes} packages into one lane (over ${MAX_LANES})`);
        if (L.foldedAgents) folds.push(`${L.foldedAgents} quieter subagents not drawn (over ${MAX_SUBAGENTS} per session)`);
        if (L.foldedActors) folds.push(`${L.foldedActors} quieter actors not drawn (over ${MAX_ACTORS} lines)`);
        if (L.foldedScenes) folds.push(`${L.foldedScenes} short scenes not shaded (over ${MAX_SCENES})`);
        if (L.foldedEvents) folds.push(`${L.foldedEvents} later plan marks not drawn (over ${MAX_EVENTS})`);
        if (folds.length) said.push(`Folded: ${folds.join('; ')}.`);
        said.push('Click a line for its session (and the turn at that point), a lane for its package, a mark for its item.');
        return said.join(' ');
      }

      // ---------- tooltips ----------
      function laneTip(lane) {
        const rows = [lane.label, ['Files', fmt(lane.files)]];
        if (lane.touches) rows.push(['Touches', fmt(lane.touches)]);
        const who = layout.actors.filter((a) => lane.actors.has(a.id) && a.kind !== 'you');
        if (who.length) rows.push(['Actors', clip(who.map((a) => a.label).join(', '), 60)]);
        const marks = layout.events.filter((e) => layout.lanes[e.lane] === lane).length;
        if (marks) rows.push(['Plan marks', fmt(marks)]);
        if (lane.other) rows.push(clip(lane.members.map((l) => l.label).join(', '), 80));
        if (lane.sel) rows.push('Click to select the package');
        return rows;
      }
      function actorTip(a, s) {
        const rows = [a.label];
        if (a.kind !== 'you') rows.push(['Session', clip(a.sname, 40)], ['Actor', a.kind === 'sub' ? `subagent ${short(a.agentId.replace(/^agent-/, ''))}` : agentName(a.session.summary.agent || 'agent')], ['Touches', fmt(a.pts.length)]);
        else rows.push(['Prompts', fmt(a.pts.length)]);
        const at = s === null || s === undefined ? null : a.at[s];
        if (at) {
          rows.push(['At', fmtT(layout.t0 + (s + 0.5) * layout.dt)], ['In', layout.lanes[at.lane].label]);
          if (at.path) rows.push(['File', clip(at.path, 48)]);
          if (at.inferred) rows.push('≈ File matched by name only');
          if (at.before) rows.push('Before its first touch');
        }
        rows.push(a.kind === 'you' ? 'Click for the session you were prompting' : 'Click to select the session at this turn');
        return rows;
      }
      function eventTip(list, side) {
        if (list.length === 1) {
          const e = list[0];
          const rows = [clip(e.it.title, 80), [e.act === 'opened' ? 'Opened' : 'Closed', fmtT(e.t)], ['Status', STATUS_TEXT[e.it.status] || e.it.status], ['Lane', layout.lanes[e.lane].label]];
          if (side) rows.push(side === 'before' ? 'Before the sessions began' : 'After the sessions ended');
          if (e.it.confidence === 'inferred') rows.push('≈ Inferred from its source');
          rows.push('Click to select');
          return rows;
        }
        return [`${list.length} plan marks ${side === 'after' ? 'after the sessions ended' : 'before the sessions began'}`, ...list.slice(-6).reverse().map((e) => [e.act, clip(e.it.title, 40)]), ...(list.length > 6 ? [`and ${list.length - 6} more`] : [])];
      }

      // ---------- each frame ----------
      function paintFrame() {
        bar.sync();
        if (!scene || !layout) return;
        if (clock.playing || (opened !== null && clock.time !== opened)) moved = true;
        const replaying = views.length > 0 && clock.events.length > 0 && moved && !clock.atEnd();
        const T = replaying ? clock.time : Infinity;
        const xr = replaying ? Math.max(0, Math.min(scene.width, scene.XT(T))) : scene.width;
        scene.clipRect.setAttribute('width', xr.toFixed(1));
        const sT = replaying ? layout.sliceOf(T) : -1;
        for (const part of scene.parts) {
          const a = part.a;
          const live = replaying && sT >= a.s0 && sT <= a.s1;
          if (live) {
            const p = part.pts[sT - a.s0] || part.pts[part.pts.length - 1];
            part.head.setAttribute('cx', Math.min(xr, p.x).toFixed(1));
            part.head.setAttribute('cy', p.y.toFixed(1));
            part.head.setAttribute('visibility', 'visible');
          } else part.head.setAttribute('visibility', 'hidden');
          if (part.endText) part.endText.setAttribute('visibility', !replaying || sT > a.s1 ? 'visible' : 'hidden');
        }
        for (const ev of scene.evParts) {
          const show = !replaying || (ev.gutter ? ev.gutter === 'before' : ev.e.t <= T);
          ev.m.setAttribute('visibility', show ? 'visible' : 'hidden');
        }
        scene.stamp.textContent = replaying ? `replay · ${fmtT(T)}` : '';
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
