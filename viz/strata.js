// Strata (hero view, design language `strata`): the whole project as three
// stacked tilted planes. The floor is code, a wheel of packages with files as
// blocks; the middle plane is sessions and their agents; the roof is the plan,
// each epic a ring of items. In replay, messages travel between the planes:
// reads and edits drop to the files they touch, mentions, opens, and closes
// rise to the items a session names, and session-to-agent traffic stays on the
// middle plane. A faint shaft stays where each message passed, so the rest
// state is the long exposure of the traffic. See docs/workspace-explorer.md,
// "Strata".
//
// One angular layout is computed once per workspace from the code wheel and
// shared by all three planes, so nothing moves between replays; the tilt is a
// parameter of a fixed-axis projection in SVG, which dragging changes, and
// hovering a plane lifts it apart from the others. Playback comes from the
// shared replay clock, and the messages in flight are derived from its
// position alone, as in the Living Network. Draws whichever of code,
// sessions, and plans are loaded, and says in the note what is missing.
// Clicking a block, session, or item announces { artifactId }, { sessionId },
// or { itemId }. Sees only its host and ctx: no VS Code.
(function () {
  const MAX_WEDGES = 12; // package wedges on the floor, an "other" wedge included
  const MAX_BLOCKS = 40; // blocks per wedge: past it files fold to their modules, then the smallest fold to "other"
  const MAX_DEPTH_RINGS = 5; // rings on the floor by depth from the entry points; deeper files share the last
  const MAX_EPIC_RINGS = 8; // epic rings on the roof, an "other epics" ring included
  const MAX_ITEMS = 24; // items per ring: past it done items fold into one mark, then the rest
  const MAX_AGENTS = 6; // subagents drawn per session, an "+N" agent included
  const MAX_MESSAGES = 48; // messages in flight at once
  const MAX_SHAFTS = 400; // shafts drawn, the busiest pairs first; messages still fly on the rest
  const FLIGHT_MS = 1100; // wall-clock ms a message takes to cross between planes
  const TILT = { min: 0.14, max: 0.62, initial: 0.36 }; // the projection's vertical squash, sin of the elevation
  const LIFT = 16; // px the other planes move away from a hovered one
  const HUB = 0.12; // the floor's hub, as a share of the radius
  const ENTRY_KINDS = new Set(['package', 'target']);
  const PLANES = [
    { key: 'code', name: 'CODE', sub: 'packages · files' },
    { key: 'sessions', name: 'SESSIONS', sub: 'sessions · agents' },
    { key: 'plans', name: 'PLANS', sub: 'epics · items' },
  ]; // floor, middle, roof
  const STATUS_TEXT = { open: 'open', in_progress: 'in progress', blocked: 'blocked', done: 'done', deferred: 'deferred', dropped: 'dropped' };
  const TAU = Math.PI * 2;

  window.factoryClock.register({
    id: 'strata',
    title: 'Strata',
    tags: { subject: ['workspace'], category: ['actor', 'dependency', 'state'], purpose: ['expressive'], level: ['project'], dimension: ['structure', 'actor', 'communication', 'status'], language: ['strata'] },
    mount(host, ctx) {
      const { el, svg, svgText, fmt, compact, clip, short, sessionName, formatTime, showTip, hideTip, hashId, countUpTo, shapeSelected } = ctx;
      const frame = el('div', { class: 'hero-strata' });
      const note = el('p', { class: 'muted small' });
      host.replaceChildren(frame, note);
      let ws = null;
      let views = [];
      let selection = null;
      let layout = null;
      let layoutKey = '';
      let tilt = TILT.initial;
      let scene = null;
      let lifted = -1; // the hovered plane, or -1
      let dragged = false; // a drag just ended: the click that follows isn't a pick
      const clock = ctx.createReplay({ onFrame: () => paintFrame() });
      const bar = ctx.replayBar(clock, { label: 'Strata' });
      const fit = ctx.fitter(host);
      const ms = (ts) => (ts ? Date.parse(ts) : NaN);
      const qualify = (root, id) => `${root}::${id}`;

      function update(sessions, sel, options) {
        const o = options || {};
        const given = o.workspace || null;
        views = sessions && sessions.length ? sessions : given && given.sessions ? given.sessions : [];
        ws = {
          sessions: views,
          code: (given && given.code) || [],
          plans: (given && given.plans) || [],
          touches: given && given.touches instanceof Map ? given.touches : new Map(Object.entries((given && given.touches) || {})),
          joins: { planToCode: [], planToSession: [], sessionToCode: [], ...((given && given.joins) || {}) },
        };
        selection = sel || null;
        const key = [ws.code.map((g) => `${g.source.root}:${g.artifacts.length}`).join(','), ws.plans.map((p) => `${p.source.root}:${p.items.length}`).join(','), views.map((v) => v.summary.sessionId).join(','), ws.joins.sessionToCode.length, ws.joins.planToSession.length].join('|');
        if (key !== layoutKey || !layout) {
          layout = buildLayout();
          layoutKey = key;
        }
        clock.setSessions(views);
        draw();
      }

      // ---------- the one layout, computed once per workspace ----------
      function buildLayout() {
        const floor = buildFloor();
        const middle = buildMiddle(floor);
        const roof = buildRoof(floor);
        const traffic = buildTraffic(floor, middle, roof);
        return { floor, middle, roof, traffic };
      }

      /** The code wheel: wedges by package (sized by file count), blocks by file, ring by depth from the entry points. */
      function buildFloor() {
        const files = [];
        const multi = ws.code.length > 1;
        for (const g of ws.code) {
          const root = g.source.root;
          const byId = new Map(g.artifacts.map((a) => [a.id, a]));
          const packageOf = (a) => {
            for (let p = a, guard = 0; p && guard < 64; p = byId.get(p.parent), guard++) if (ENTRY_KINDS.has(p.kind)) return p;
            return null;
          };
          const moduleOf = (a) => {
            const p = a.parent ? byId.get(a.parent) : null;
            return p && p.kind === 'module' ? p : null;
          };
          // Depth from the entry points: files nothing imports (and that import something) are depth 0; files with no imports either way sit on the outer ring.
          const fileIds = new Set(g.artifacts.filter((a) => a.kind === 'file').map((a) => a.id));
          const out = new Map();
          const inDeg = new Map();
          for (const d of g.dependencies) {
            if (!fileIds.has(d.from) || !fileIds.has(d.to) || d.from === d.to) continue;
            (out.get(d.from) || out.set(d.from, []).get(d.from)).push(d.to);
            inDeg.set(d.to, (inDeg.get(d.to) || 0) + 1);
          }
          const depth = new Map();
          let queue = [...fileIds].filter((id) => !inDeg.get(id) && out.has(id));
          queue.forEach((id) => depth.set(id, 0));
          while (queue.length) {
            const next = [];
            for (const id of queue) for (const to of out.get(id) || []) if (!depth.has(to)) {
              depth.set(to, depth.get(id) + 1);
              next.push(to);
            }
            queue = next;
          }
          for (const id of fileIds) {
            const a = byId.get(id);
            const pkg = packageOf(a);
            const mod = moduleOf(a);
            const linked = out.has(id) || inDeg.has(id);
            files.push({
              qid: qualify(root, id),
              name: a.name,
              path: a.path || a.id,
              lines: (a.size && a.size.lines) || 0,
              depth: depth.has(id) ? depth.get(id) : MAX_DEPTH_RINGS - 1, // unreached: only in a cycle, or loose
              loose: !linked,
              wedgeKey: pkg ? qualify(root, pkg.id) : qualify(root, '(root)'),
              wedgeLabel: `${multi ? root + ' · ' : ''}${pkg ? pkg.name : root}`,
              wedgeSel: pkg ? qualify(root, pkg.id) : null,
              moduleKey: mod ? qualify(root, mod.id) : null,
              moduleName: mod ? mod.name : null,
            });
          }
        }
        const wedgeMap = new Map();
        for (const f of files) {
          let w = wedgeMap.get(f.wedgeKey);
          if (!w) wedgeMap.set(f.wedgeKey, (w = { key: f.wedgeKey, label: f.wedgeLabel, sel: f.wedgeSel, files: [] }));
          w.files.push(f);
        }
        let wedges = [...wedgeMap.values()].sort((a, b) => b.files.length - a.files.length || a.label.localeCompare(b.label));
        let foldedWedges = 0;
        if (wedges.length > MAX_WEDGES) {
          const rest = wedges.slice(MAX_WEDGES - 1);
          foldedWedges = rest.length;
          wedges = [...wedges.slice(0, MAX_WEDGES - 1), { key: '(other)', label: `${rest.length} other packages`, sel: null, files: rest.flatMap((w) => w.files), other: true }];
        }
        const total = files.length || 1;
        const GAP = wedges.length > 1 ? 0.025 : 0;
        const usable = TAU - GAP * wedges.length;
        const minShare = Math.min(0.03, 1 / Math.max(1, wedges.length)) * usable; // a tiny package still gets a wedge you can point at
        const raw = wedges.map((w) => Math.max(minShare, (w.files.length / total) * usable));
        const scale = usable / raw.reduce((a, b) => a + b, 0);
        let at = -Math.PI / 2 - (raw[0] * scale) / 2; // the biggest wedge faces the back
        const blocks = [];
        const blockOf = new Map(); // file qid → its block
        let foldedToModules = 0;
        let foldedToOther = 0;
        wedges.forEach((w, i) => {
          w.a0 = at + GAP / 2;
          w.a1 = at + GAP / 2 + raw[i] * scale;
          w.mid = (w.a0 + w.a1) / 2;
          at = w.a1 + GAP / 2;
          // Blocks: files, or past the limit their modules, then the smallest into one "other" block.
          let marks = w.files.map((f) => ({ id: f.qid, label: f.name, path: f.path, lines: f.lines, depth: f.depth, loose: f.loose, files: [f] }));
          if (marks.length > MAX_BLOCKS) {
            const byMod = new Map();
            for (const f of w.files) {
              const k = f.moduleKey || f.qid;
              let m = byMod.get(k);
              if (!m) byMod.set(k, (m = { id: k, label: f.moduleKey ? `${f.moduleName}/` : f.name, path: f.moduleKey ? f.path.slice(0, f.path.lastIndexOf('/')) : f.path, lines: 0, depth: f.depth, loose: true, files: [], module: !!f.moduleKey }));
              m.lines += f.lines;
              m.depth = Math.min(m.depth, f.depth);
              m.loose = m.loose && f.loose;
              m.files.push(f);
            }
            foldedToModules += w.files.length;
            marks = [...byMod.values()];
          }
          if (marks.length > MAX_BLOCKS) {
            marks.sort((a, b) => b.lines - a.lines || a.id.localeCompare(b.id));
            const rest = marks.slice(MAX_BLOCKS - 1);
            foldedToOther += rest.reduce((n, m) => n + m.files.length, 0);
            marks = [...marks.slice(0, MAX_BLOCKS - 1), { id: null, label: `${rest.length} more`, path: '', lines: rest.reduce((n, m) => n + m.lines, 0), depth: MAX_DEPTH_RINGS - 1, loose: false, files: rest.flatMap((m) => m.files), other: true }];
          }
          // Place by ring: depth from the entry points, the loose files outermost; along the ring by path so neighbors share folders.
          const rings = new Map();
          for (const m of marks) {
            const ring = m.loose ? MAX_DEPTH_RINGS - 1 : Math.min(MAX_DEPTH_RINGS - 1, m.depth);
            (rings.get(ring) || rings.set(ring, []).get(ring)).push(m);
          }
          for (const [ring, list] of rings) {
            list.sort((a, b) => a.path.localeCompare(b.path));
            const span = w.a1 - w.a0;
            list.forEach((m, k) => {
              m.a = w.a0 + (span * (k + 0.5)) / list.length;
              m.r = HUB + 0.08 + ((0.95 - HUB - 0.08) * (ring + 0.5)) / MAX_DEPTH_RINGS;
              m.ring = ring;
              m.wedge = w;
              m.slot = (span * m.r) / list.length; // arc length per block, as a share of the radius
              blocks.push(m);
              for (const f of m.files) blockOf.set(f.qid, m);
            });
          }
        });
        const maxLines = Math.max(1, ...blocks.map((b) => b.lines));
        const paths = new Map(); // path → blocks, for touches
        for (const b of blocks) for (const f of b.files) (paths.get(f.path) || paths.set(f.path, []).get(f.path)).push({ qid: f.qid, block: b });
        return { wedges, blocks, blockOf, paths, maxLines, files: files.length, foldedWedges, foldedToModules, foldedToOther };
      }

      /** The wedge a set of weighted artifact links lands in most, or null. */
      function topWedge(floor, links) {
        const score = new Map();
        for (const [qid, weight] of links) {
          const b = floor.blockOf.get(qid);
          if (b) score.set(b.wedge, (score.get(b.wedge) || 0) + weight);
        }
        let best = null;
        for (const [w, s] of score) if (!best || s > best[1]) best = [w, s];
        return best ? best[0] : null;
      }

      /** Sessions on the inner ring at the angle of the wedge they touched most; their subagents on the outer orbit. */
      function buildMiddle(floor) {
        const touched = new Map();
        for (const j of ws.joins.sessionToCode) (touched.get(j.from) || touched.set(j.from, []).get(j.from)).push([j.to, j.weight || 1]);
        const sessions = views.map((v) => {
          const id = v.summary.sessionId;
          const wedge = topWedge(floor, touched.get(id) || []);
          const agents = new Map();
          for (const x of [...v.calls, ...v.tools]) if (x.agentId) agents.set(x.agentId, (agents.get(x.agentId) || 0) + 1);
          const ranked = [...agents.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([a]) => a);
          const kept = ranked.length > MAX_AGENTS ? ranked.slice(0, MAX_AGENTS - 1) : ranked;
          const folded = ranked.length - kept.length;
          return { id, v, wedge, label: sessionName(v.summary, 40), touches: (touched.get(id) || []).reduce((n, [, w]) => n + w, 0), agentIds: kept, folded };
        });
        // Group by wedge; sessions with no wedge go evenly round, by a stable hash.
        const byWedge = new Map();
        for (const s of sessions) (byWedge.get(s.wedge) || byWedge.set(s.wedge, []).get(s.wedge)).push(s);
        for (const [w, list] of byWedge) {
          list.sort((a, b) => a.id.localeCompare(b.id));
          list.forEach((s, k) => {
            if (w) {
              const step = Math.min(0.9, (w.a1 - w.a0) / list.length); // wide enough apart for their names
              s.a = w.mid + (k - (list.length - 1) / 2) * step;
            } else s.a = ((hashId(s.id) % 3600) / 3600) * TAU;
            s.r = 0.38;
            s.below = list.length > 2 && k % 2 === 1; // three or more in one wedge: alternate labels above and below
          });
        }
        const agents = [];
        const agentOf = new Map(); // `${sessionId}|${agentId}` → agent node
        for (const s of sessions) {
          const ids = [...s.agentIds, ...(s.folded ? ['+'] : [])];
          s.agents = ids.map((agentId, k) => {
            const n = {
              id: `${s.id}|${agentId}`,
              agentId,
              session: s,
              label: agentId === '+' ? `+${s.folded} agents` : `agent ${agentId.replace(/^agent-/, '').slice(0, 6)}`,
              a: s.a + (k - (ids.length - 1) / 2) * 0.24,
              r: 0.8,
            };
            agents.push(n);
            agentOf.set(n.id, n);
            return n;
          });
          for (const agentId of [...agentsOfSession(s.v)].filter((a) => !s.agentIds.includes(a))) if (s.folded) agentOf.set(`${s.id}|${agentId}`, s.agents[s.agents.length - 1]);
        }
        return { sessions, agents, agentOf, byId: new Map(sessions.map((s) => [s.id, s])) };
      }
      function agentsOfSession(v) {
        return new Set([...v.calls, ...v.tools].map((x) => x.agentId).filter(Boolean));
      }

      /** The roof: each epic a ring (bigger epics outside), its items around it in dependency order, starting over the wedge its items name most. */
      function buildRoof(floor) {
        const planToCode = new Map();
        for (const j of ws.joins.planToCode) (planToCode.get(j.from) || planToCode.set(j.from, []).get(j.from)).push([j.to, 1]);
        const items = [];
        let groups = [];
        let foldedEpics = 0;
        for (const p of ws.plans) {
          const root = p.source.root;
          const byId = new Map(p.items.map((i) => [i.id, i]));
          const parentOf = (i) => i.parent || (p.links.find((l) => l.kind === 'parent' && l.from === i.id) || {}).to;
          const epicOf = (i) => {
            for (let x = i, guard = 0; x && guard < 64; x = byId.get(parentOf(x)), guard++) if (x.kind === 'epic' || x.kind === 'milestone') return x;
            return null;
          };
          const local = new Map();
          for (const it of p.items) {
            if (it.kind === 'epic' || it.kind === 'milestone') {
              if (!local.has(it.id)) local.set(it.id, { epic: it, items: [] });
              continue;
            }
            const e = epicOf(it);
            const k = e ? e.id : '';
            if (!local.has(k)) local.set(k, { epic: e, items: [] });
            local.get(k).items.push(it);
          }
          // Dependency order: blocks and follows, then created, then id.
          const before = new Map();
          for (const l of p.links) if (l.kind === 'blocks' || l.kind === 'follows') {
            const [a, b] = l.kind === 'blocks' ? [l.from, l.to] : [l.to, l.from];
            (before.get(b) || before.set(b, new Set()).get(b)).add(a);
          }
          for (const [k, gr] of local) {
            const ids = new Set(gr.items.map((i) => i.id));
            const rank = new Map();
            const rankOf = (id, seen) => {
              if (rank.has(id)) return rank.get(id);
              if (seen.has(id)) return 0; // a cycle: stop
              seen.add(id);
              let r = 0;
              for (const a of before.get(id) || []) if (ids.has(a)) r = Math.max(r, rankOf(a, seen) + 1);
              rank.set(id, r);
              return r;
            };
            gr.items.sort((a, b) => rankOf(a.id, new Set()) - rankOf(b.id, new Set()) || (ms(a.created) || 0) - (ms(b.created) || 0) || a.id.localeCompare(b.id));
            groups.push({
              key: qualify(root, k || '(none)'),
              sel: gr.epic ? qualify(root, gr.epic.id) : null,
              epic: gr.epic,
              label: `${ws.plans.length > 1 ? root + ' · ' : ''}${gr.epic ? gr.epic.title : 'No epic'}`,
              items: gr.items.map((it) => ({ qid: qualify(root, it.id), it })),
            });
          }
        }
        groups = groups.filter((g) => g.items.length || g.epic);
        groups.sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));
        if (groups.length > MAX_EPIC_RINGS) {
          const rest = groups.slice(MAX_EPIC_RINGS - 1);
          foldedEpics = rest.length;
          groups = [...groups.slice(0, MAX_EPIC_RINGS - 1), { key: '(other epics)', sel: null, epic: null, label: `${rest.length} other epics`, items: rest.flatMap((g) => g.items) }];
        }
        groups.reverse(); // smallest inside
        let foldedItems = 0;
        groups.forEach((g, i) => {
          g.r = groups.length === 1 ? 0.62 : 0.22 + ((0.94 - 0.22) * i) / (groups.length - 1);
          let marks = g.items.map((x) => ({ ...x, group: g, count: 1 }));
          if (marks.length > MAX_ITEMS) {
            const done = marks.filter((m) => m.it.status === 'done' || m.it.status === 'dropped');
            if (done.length > 1) {
              marks = marks.filter((m) => !done.includes(m));
              marks.unshift({ qid: null, it: null, group: g, count: done.length, fold: `${done.length} done` });
              foldedItems += done.length;
            }
          }
          if (marks.length > MAX_ITEMS) {
            const rest = marks.slice(MAX_ITEMS - 1);
            foldedItems += rest.reduce((n, m) => n + m.count, 0);
            marks = [...marks.slice(0, MAX_ITEMS - 1), { qid: null, it: null, group: g, count: rest.reduce((n, m) => n + m.count, 0), fold: `${rest.length} more`, members: rest }];
          }
          const w = topWedge(floor, g.items.flatMap((x) => planToCode.get(x.qid) || []));
          const start = w ? w.mid : ((hashId(g.key) % 3600) / 3600) * TAU;
          marks.forEach((m, k) => {
            m.a = start + (TAU * k) / Math.max(1, marks.length);
            m.r = g.r;
            items.push(m);
          });
          g.marks = marks;
        });
        const itemOf = new Map();
        for (const m of items) {
          if (m.qid) itemOf.set(m.qid, m);
          for (const x of m.members || []) if (x.qid) itemOf.set(x.qid, m);
        }
        return { groups, items, itemOf, foldedEpics, foldedItems, total: ws.plans.reduce((n, p) => n + p.items.length, 0) };
      }

      /**
       * Every message, in time order: a touch drops from its session (or agent) to the file's block; a prompt
       * naming an item, or an item opened or closed while a session that names it ran, rises to the item;
       * a subagent's first event in a turn goes out from its session, and its last comes back.
       */
      function buildTraffic(floor, middle, roof) {
        const msgs = [];
        const hasCodeJoin = ws.joins.sessionToCode.length > 0;
        const unanchored = new Map(); // touch path → the one block it matches by suffix, or null
        const pointFor = (sessionId, agentId) => (agentId && middle.agentOf.get(`${sessionId}|${agentId}`)) || middle.byId.get(sessionId);
        if (hasCodeJoin) {
          for (const [sessionId, list] of ws.touches) {
            if (!middle.byId.has(sessionId)) continue;
            for (const t of list) {
              let hit = null;
              let inferred = false;
              if (t.anchored) hit = (floor.paths.get(t.path) || [])[0];
              else {
                if (!unanchored.has(t.path)) {
                  const m = [];
                  for (const [p, list2] of floor.paths) if (p === t.path || p.endsWith('/' + t.path)) m.push(...list2);
                  unanchored.set(t.path, m.length === 1 ? m[0] : null);
                }
                hit = unanchored.get(t.path);
                inferred = true;
              }
              if (!hit) continue;
              const from = pointFor(sessionId, t.agentId);
              msgs.push({ t: ms(t.ts), type: 'down', act: t.kind, from: { plane: 1, node: from }, to: { plane: 0, node: hit.block }, inferred, pair: `d|${from.id}|${hit.block.id || hit.block.label + hit.block.wedge.key}` });
            }
          }
        }
        // Upward: which items each session names.
        const named = new Map(); // sessionId → [{ join, mark, it }]
        for (const j of ws.joins.planToSession) {
          const mark = roof.itemOf.get(j.from);
          if (!mark || !middle.byId.has(j.to)) continue;
          const it = itemByQid(j.from);
          (named.get(j.to) || named.set(j.to, []).get(j.to)).push({ join: j, mark, it });
        }
        for (const [sessionId, list] of named) {
          const s = middle.byId.get(sessionId);
          const from = s;
          const t0 = ms(s.v.summary.firstTs);
          const t1 = ms(s.v.summary.lastTs);
          for (const { join, mark, it } of list) {
            const pair = `u|${s.id}|${mark.qid || mark.fold + mark.group.key}`;
            let sent = 0;
            const id = it ? it.id.toLowerCase() : '';
            const title = it ? it.title.trim().toLowerCase() : '';
            for (const p of s.v.prompts) {
              const text = (p.text || '').toLowerCase();
              if (text && it && (text.includes(id) || (title.length >= 16 && text.includes(title)))) {
                msgs.push({ t: ms(p.ts), type: 'up', act: 'mention', from: { plane: 1, node: from }, to: { plane: 2, node: mark }, inferred: join.inferred, pair });
                sent++;
              }
            }
            if (it) for (const [act, ts] of [['open', it.created], ['close', it.closed]]) {
              const t = ms(ts);
              if (Number.isFinite(t) && t >= t0 && t <= t1) {
                msgs.push({ t, type: 'up', act, from: { plane: 1, node: from }, to: { plane: 2, node: mark }, inferred: join.inferred, pair });
                sent++;
              }
            }
            // An observed link with nothing timed: one message at the session's first prompt.
            if (!sent && s.v.prompts.length) msgs.push({ t: ms(s.v.prompts[0].ts), type: 'up', act: 'mention', from: { plane: 1, node: from }, to: { plane: 2, node: mark }, inferred: join.inferred, pair });
          }
        }
        // Laterally: delegation out and back, per agent and turn.
        for (const s of middle.sessions) {
          const spans = new Map();
          for (const x of [...s.v.calls, ...s.v.tools]) {
            if (!x.agentId) continue;
            const k = `${x.agentId}|${x.turnId || ''}`;
            const t = ms(x.ts);
            const sp = spans.get(k) || spans.set(k, { agentId: x.agentId, first: t, last: t }).get(k);
            sp.first = Math.min(sp.first, t);
            sp.last = Math.max(sp.last, t);
          }
          for (const sp of spans.values()) {
            const agent = middle.agentOf.get(`${s.id}|${sp.agentId}`);
            if (!agent) continue;
            const pair = `l|${agent.id}`;
            msgs.push({ t: sp.first, type: 'lateral', act: 'delegate', from: { plane: 1, node: s }, to: { plane: 1, node: agent }, inferred: true, pair });
            if (sp.last > sp.first) msgs.push({ t: sp.last, type: 'lateral', act: 'reply', from: { plane: 1, node: agent }, to: { plane: 1, node: s }, inferred: true, pair });
          }
        }
        const timed = msgs.filter((m) => Number.isFinite(m.t)).sort((a, b) => a.t - b.t);
        // Shafts: one per pair, the busiest first, with the times its messages passed.
        const pairs = new Map();
        for (const m of timed) {
          let p = pairs.get(m.pair);
          if (!p) pairs.set(m.pair, (p = { key: m.pair, type: m.type, from: m.from, to: m.to, times: [], inferred: true }));
          p.times.push(m);
          p.inferred = p.inferred && m.inferred;
        }
        const ranked = [...pairs.values()].sort((a, b) => b.times.length - a.times.length || a.key.localeCompare(b.key));
        return { msgs: timed, shafts: ranked.slice(0, MAX_SHAFTS), foldedShafts: Math.max(0, ranked.length - MAX_SHAFTS), hasCodeJoin, counts: { down: timed.filter((m) => m.type === 'down').length, up: timed.filter((m) => m.type === 'up').length, lateral: timed.filter((m) => m.type === 'lateral').length } };
      }
      function itemByQid(qid) {
        for (const p of ws.plans) {
          const pre = `${p.source.root}::`;
          if (!qid.startsWith(pre)) continue;
          const it = p.items.find((i) => i.id === qid.slice(pre.length));
          if (it) return it;
        }
        return null;
      }

      // ---------- projection: a fixed-axis tilt ----------
      /** Screen point of polar (a, r) on plane k, z px above it. */
      function project(geo, k, a, r, z) {
        return { x: geo.cx + geo.R * r * Math.cos(a), y: geo.planeY[k] + geo.R * r * Math.sin(a) * geo.tilt - (z || 0) * geo.up };
      }
      const pt = (p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
      /** An annular sector on plane k, as a path. */
      function sector(geo, k, r0, r1, a0, a1) {
        const n = Math.max(4, Math.ceil((a1 - a0) / 0.08));
        const outer = [];
        const inner = [];
        for (let i = 0; i <= n; i++) {
          const a = a0 + ((a1 - a0) * i) / n;
          outer.push(project(geo, k, a, r1));
          inner.push(project(geo, k, a, r0));
        }
        return `M${outer.map(pt).join(' L')} L${inner.reverse().map(pt).join(' L')} Z`;
      }
      /** The message's endpoint on its plane: a block's top, an item, a session or agent. */
      function anchorOf(geo, end) {
        const n = end.node;
        const z = end.plane === 0 ? blockHeight(geo, n) : end.plane === 1 ? 4 : 0;
        return project(geo, end.plane, n.a, n.r, z);
      }
      function blockHeight(geo, b) {
        return 2 + Math.sqrt(b.lines / layout.floor.maxLines) * geo.R * 0.14;
      }

      // ---------- drawing ----------
      function draw() {
        hideTip();
        if (!layout) return;
        const { floor, middle, roof, traffic } = layout;
        const loaded = { code: floor.blocks.length > 0, sessions: middle.sessions.length > 0, plans: roof.items.length > 0 };
        if (!loaded.code && !loaded.sessions && !loaded.plans && !ws.code.length && !ws.plans.length) {
          frame.replaceChildren(el('p', { class: 'st-empty', text: 'Nothing loaded: Strata draws code, sessions, and plans, whichever are there.' }));
          note.textContent = '';
          scene = null;
          return;
        }
        const width = Math.max(320, host.clientWidth || 800);
        const height = fit.height(Math.round(Math.min(720, Math.max(380, width * 0.62))), 340);
        const labelW = Math.min(132, Math.max(84, width * 0.16));
        const pad = 22 + LIFT;
        const up = Math.sqrt(1 - tilt * tilt); // vertical px per px of height above a plane
        const R0 = Math.max(60, (width - labelW) / 2 - 44);
        // The stack: three discs of height 2Rt, spaced so the whole fits with room for blocks and labels.
        const R = Math.max(50, Math.min(R0, (height - 2 * pad - 30) / (2 * tilt + 2 * 1.9 * tilt + 0.14 * up)));
        const gap = (height - 2 * pad - 2 * R * tilt - 14) / 2;
        const cx = labelW + (width - labelW) / 2;
        const roofY = pad + R * tilt + 8;
        const geo = { cx, R, tilt, up, planeY: [roofY + 2 * gap, roofY + gap, roofY] };

        const root = svg('svg', { class: 'st-svg', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', tabindex: 0, 'aria-label': `Strata: ${fmt(floor.files)} files in ${floor.wedges.length} packages, ${middle.sessions.length} sessions, ${fmt(roof.total)} plan items. Drag or use the arrow keys to tilt.` });
        root.append(svg('rect', { class: 'st-void', x: 0, y: 0, width, height }));

        const planeGroups = [];
        const parts = { blocks: [], sessions: [], items: [] };
        // Floor first, roof last: the camera looks down, so the roof is nearest.
        for (const k of [0, 1, 2]) {
          const g = svg('g', { class: `st-plane st-plane-${PLANES[k].key}` });
          planeGroups[k] = g;
          root.append(g);
          g.append(svg('ellipse', { class: 'st-disc', cx, cy: geo.planeY[k], rx: R, ry: R * tilt }));
          g.append(svg('ellipse', { class: 'st-rim', cx, cy: geo.planeY[k], rx: R, ry: R * tilt }));
          g.append(svg('ellipse', { class: 'st-hub', cx, cy: geo.planeY[k], rx: R * HUB, ry: R * HUB * tilt }));
          // The plane's label at the left edge: its name, what's on it, or why it's empty.
          const ly = geo.planeY[k] - 2;
          const what = k === 0 ? (loaded.code ? `${floor.wedges.length} · ${fmt(floor.files)}` : ws.code.length ? 'no files' : 'not loaded') : k === 1 ? (loaded.sessions ? `${middle.sessions.length} · ${middle.agents.length}` : 'not loaded') : loaded.plans ? `${roof.groups.length} · ${fmt(roof.total)}` : ws.plans.length ? 'empty plan' : 'not loaded';
          g.append(svgText({ class: 'st-plane-name', x: 14, y: ly }, PLANES[k].name), svgText({ class: 'st-plane-sub', x: 14, y: ly + 13 }, ctx.fit(PLANES[k].sub, labelW + 10)), svgText({ class: `st-plane-sub${what === 'not loaded' || what === 'no files' || what === 'empty plan' ? ' st-missing' : ''}`, x: 14, y: ly + 25 }, ctx.fit(what, labelW + 10)));
          g.addEventListener('mouseenter', () => lift(k));
          g.addEventListener('mouseleave', () => lift(-1));
        }

        // The floor: wedges, their labels, and blocks back to front.
        const fg = planeGroups[0];
        for (const w of floor.wedges) {
          const p = svg('path', { class: `st-wedge${w.other ? ' st-folded' : ''}${w.sel && shapeSelected(selection, w.sel) ? ' st-on' : ''}`, d: sector(geo, 0, HUB, 1, w.a0, w.a1) });
          ctx.interact(ctx, p, {
            label: `${w.label}: ${w.files.length} files`,
            tip: () => [w.label, ['Files', fmt(w.files.length)], ['Lines', fmt(w.files.reduce((n, f) => n + f.lines, 0))], ...(w.sel ? ['Click to select the package'] : [])],
            pick: w.sel ? () => pick({ artifactId: w.sel }) : undefined,
          });
          fg.append(p);
          const at = project(geo, 0, w.mid, 1.08);
          const span = (w.a1 - w.a0) * R;
          const anchor = Math.abs(Math.cos(w.mid)) < 0.3 ? 'middle' : Math.cos(w.mid) > 0 ? 'start' : 'end';
          const room = anchor === 'start' ? width - at.x - 6 : anchor === 'end' ? at.x - labelW : Math.min(at.x - labelW, width - at.x) * 2;
          const text = ctx.fit(w.label, Math.min(150, Math.max(span, 60), room));
          if (span > 26 && text) fg.append(svgText({ class: 'st-wedge-label', x: at.x.toFixed(1), y: (at.y + (Math.sin(w.mid) > 0 ? 10 : 0)).toFixed(1), 'text-anchor': anchor }, text));
        }
        const sortedBlocks = [...floor.blocks].sort((a, b) => Math.sin(a.a) * a.r - Math.sin(b.a) * b.r);
        for (const b of sortedBlocks) {
          const p = project(geo, 0, b.a, b.r);
          const hw = Math.max(1.6, Math.min(7, b.slot * R * 0.36));
          const ht = hw * tilt * 1.4;
          const h = blockHeight(geo, b) * up;
          const g = svg('g', { class: `st-block${b.other ? ' st-folded' : ''}${b.id && shapeSelected(selection, b.id) ? ' st-on' : ''}` });
          g.append(
            svg('path', { class: 'st-face-l', d: `M${pt({ x: p.x - hw, y: p.y - h })} L${pt({ x: p.x, y: p.y + ht - h })} L${pt({ x: p.x, y: p.y + ht })} L${pt({ x: p.x - hw, y: p.y })} Z` }),
            svg('path', { class: 'st-face-r', d: `M${pt({ x: p.x, y: p.y + ht - h })} L${pt({ x: p.x + hw, y: p.y - h })} L${pt({ x: p.x + hw, y: p.y })} L${pt({ x: p.x, y: p.y + ht })} Z` }),
            svg('path', { class: 'st-face-top', d: `M${pt({ x: p.x, y: p.y - ht - h })} L${pt({ x: p.x + hw, y: p.y - h })} L${pt({ x: p.x, y: p.y + ht - h })} L${pt({ x: p.x - hw, y: p.y - h })} Z` })
          );
          ctx.interact(ctx, g, {
            label: `${b.label}: ${fmt(b.lines)} lines`,
            tip: () => blockTip(b),
            pick: b.id ? () => pick({ artifactId: b.id }) : undefined,
          });
          fg.append(g);
          parts.blocks.push({ b, g });
        }

        // The middle: orbits, spawn lines, agents, sessions.
        const mg = planeGroups[1];
        if (loaded.sessions) {
          for (const r of [0.38, 0.8]) mg.append(svg('ellipse', { class: 'st-orbit', cx, cy: geo.planeY[1], rx: R * r, ry: R * r * tilt }));
          for (const s of middle.sessions) {
            const sp = project(geo, 1, s.a, s.r);
            for (const a of s.agents) {
              const ap = project(geo, 1, a.a, a.r);
              mg.append(svg('line', { class: 'st-spawn', x1: sp.x.toFixed(1), y1: sp.y.toFixed(1), x2: ap.x.toFixed(1), y2: ap.y.toFixed(1) }));
            }
          }
          for (const a of middle.agents) {
            const p = project(geo, 1, a.a, a.r);
            const g = svg('g', { class: 'st-agent' });
            g.append(svg('ellipse', { class: 'st-shadow', cx: p.x.toFixed(1), cy: p.y.toFixed(1), rx: 5.6, ry: 5.6 * tilt * 1.3 }), svg('circle', { class: 'st-node', cx: p.x.toFixed(1), cy: (p.y - 3.5 * up).toFixed(1), r: 3.5 }));
            ctx.interact(ctx, g, {
              label: `${a.label} of ${a.session.label}`,
              tip: () => [a.label, ['Session', clip(a.session.label, 40)], 'Delegation is inferred from the events it made', 'Click to select its session'],
              pick: () => pick({ sessionId: a.session.id }),
            });
            mg.append(g);
          }
          for (const s of middle.sessions) {
            const p = project(geo, 1, s.a, s.r);
            const on = !!selection && selection.sessionId === s.id;
            const g = svg('g', { class: `st-session${on ? ' st-on' : ''}` });
            g.append(svg('ellipse', { class: 'st-shadow', cx: p.x.toFixed(1), cy: p.y.toFixed(1), rx: 9.6, ry: 9.6 * tilt * 1.3 }), svg('circle', { class: 'st-node', cx: p.x.toFixed(1), cy: (p.y - 6 * up).toFixed(1), r: 6 }), svgText({ class: 'st-node-label', x: p.x.toFixed(1), y: (s.below ? p.y + 6 * tilt + 10 : p.y - 6 * up - 10).toFixed(1), 'text-anchor': 'middle' }, clip(s.label, 14)));
            ctx.interact(ctx, g, {
              label: `Session ${s.label}`,
              tip: () => sessionTip(s),
              pick: () => pick({ sessionId: s.id }),
            });
            mg.append(g);
            parts.sessions.push({ s, g });
          }
        }

        // The roof: a ring per epic, items as flat diamonds.
        const rg = planeGroups[2];
        const labelRoom = R * tilt * (roof.groups.length > 1 ? (0.72 / (roof.groups.length - 1)) : 1);
        roof.groups.forEach((gr, i) => {
          const ring = svg('ellipse', { class: `st-epic${gr.sel && shapeSelected(selection, gr.sel) ? ' st-on' : ''}`, cx, cy: geo.planeY[2], rx: R * gr.r, ry: R * gr.r * tilt });
          ctx.interact(ctx, ring, {
            label: `${gr.label}: ${gr.items.length} items`,
            tip: () => epicTip(gr),
            pick: gr.sel ? () => pick({ itemId: gr.sel }) : undefined,
          });
          rg.append(ring);
          // Epic names at the back of their rings, the top of the stack, where there's room between rings.
          if (labelRoom >= 10 || i === roof.groups.length - 1) {
            const at = project(geo, 2, -Math.PI / 2, gr.r);
            rg.append(svgText({ class: 'st-epic-label', x: at.x.toFixed(1), y: (at.y - 3).toFixed(1), 'text-anchor': 'middle' }, ctx.fit(gr.label, Math.max(70, R * 0.9))));
          }
        });
        for (const m of [...roof.items].sort((a, b) => Math.sin(a.a) * a.r - Math.sin(b.a) * b.r)) {
          const p = project(geo, 2, m.a, m.r);
          const hw = m.fold ? 7 : 5.5;
          const ht = hw * tilt * 1.1;
          const status = m.it ? m.it.status : 'done';
          const g = svg('path', { class: `st-item st-st-${status}${m.fold ? ' st-folded' : ''}${m.it && m.it.confidence === 'inferred' ? ' st-inferred' : ''}${m.qid && shapeSelected(selection, m.qid) ? ' st-on' : ''}`, d: `M${pt({ x: p.x, y: p.y - ht })} L${pt({ x: p.x + hw, y: p.y })} L${pt({ x: p.x, y: p.y + ht })} L${pt({ x: p.x - hw, y: p.y })} Z` });
          ctx.interact(ctx, g, {
            label: m.it ? `${m.it.title}: ${STATUS_TEXT[status] || status}` : m.fold,
            tip: () => itemTip(m),
            pick: m.qid ? () => pick({ itemId: m.qid }) : undefined,
          });
          rg.append(g);
          parts.items.push({ m, g, status: null });
        }

        // Shafts and messages over everything.
        const shaftLayer = svg('g', { class: 'st-traffic', 'aria-hidden': 'true' });
        const shafts = traffic.shafts.map((s) => {
          const a = anchorOf(geo, s.from);
          const b = anchorOf(geo, s.to);
          const line = svg('line', { class: `st-shaft st-${s.type}${s.inferred ? ' st-inferred' : ''}`, x1: a.x.toFixed(1), y1: a.y.toFixed(1), x2: b.x.toFixed(1), y2: b.y.toFixed(1), visibility: 'hidden' });
          shaftLayer.append(line);
          return { s, line, n: -1 };
        });
        const pool = [];
        for (let i = 0; i < MAX_MESSAGES; i++) {
          const glow = svg('circle', { class: 'st-glow', r: 6, visibility: 'hidden' });
          const dot = svg('circle', { class: 'st-dot', r: 2.4, visibility: 'hidden' });
          shaftLayer.append(glow, dot);
          pool.push({ glow, dot });
        }
        root.append(shaftLayer);

        // The key, top right, in the plane's own words.
        const keyX = width - 12;
        root.append(
          svgText({ class: 'st-key st-down', x: keyX, y: 16, 'text-anchor': 'end' }, traffic.hasCodeJoin || !loaded.sessions || !loaded.code ? '▼ reads · edits' : '▼ reads · edits (no file targets)'),
          svgText({ class: 'st-key st-up', x: keyX, y: 28, 'text-anchor': 'end' }, '▲ mentions · opens · closes'),
          svgText({ class: 'st-key st-lateral', x: keyX, y: 40, 'text-anchor': 'end' }, '◆ agent traffic')
        );
        const stamp = svgText({ class: 'st-stamp', x: keyX, y: height - 8, 'text-anchor': 'end' }, '');
        root.append(stamp);

        // Drag tilts the stack; the arrow keys do too.
        root.addEventListener('pointerdown', (e) => startDrag(e));
        root.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            if (e.preventDefault) e.preventDefault();
            setTilt(tilt + (e.key === 'ArrowUp' ? 0.04 : -0.04));
          }
        });

        const legend = el('div', { class: 'st-legend' }, [
          ...['done', 'in_progress', 'open', 'blocked', 'deferred', 'dropped'].filter((st) => roof.items.some((m) => m.it && m.it.status === st) || (st === 'done' && roof.items.some((m) => m.fold))).map((st) => el('span', { class: 'st-key-item' }, [el('span', { class: `st-swatch st-sw-${st}` }), STATUS_TEXT[st]])),
          el('span', { class: 'st-key-item' }, [el('span', { class: 'st-swatch st-sw-inferred' }), 'dashed: inferred']),
        ]);
        frame.replaceChildren(root, el('div', { class: 'st-foot' }, [views.length ? bar.element : null, legend]));
        scene = { root, geo, planeGroups, shafts, pool, parts, stamp, shaftLayer };
        lift(lifted);
        paintFrame();

        note.textContent = noteText(loaded);
        fit.settle(height, draw);
      }

      function noteText(loaded) {
        const { floor, middle, roof, traffic } = layout;
        const said = [];
        said.push('The floor is code: a wedge per package sized by its files, a block per file with height by lines, rings outward by import depth from the entry points (files nothing imports); files with no imports either way sit on the outer ring. The middle plane is sessions, at the angle of the package they touched most, and their subagents on the outer orbit. The roof is the plan: an epic per ring, bigger epics outside, items in dependency order starting over the package they name most, hue by status. All three planes share the floor’s angles, so a session or item over a wedge is about that code.');
        if (!loaded.code) said.push(ws.code.length ? 'The code graph has no files, so the floor is empty.' : 'No code is loaded, so the floor is empty and nothing drops.');
        if (!loaded.sessions) said.push('No sessions are loaded, so the middle plane is empty and nothing travels.');
        if (!loaded.plans) said.push(ws.plans.length ? 'The plan has no items, so the roof is empty.' : 'No plan is loaded, so the roof is empty and nothing rises.');
        if (loaded.sessions && loaded.code && !traffic.hasCodeJoin) said.push('The sessions carry no file targets (the session→code join is empty), so only the upward messages and agent traffic draw, and sessions are placed by a stable hash.');
        if (loaded.sessions) said.push(`While the sessions replay, ${fmt(traffic.counts.down)} reads and edits drop to their files, ${fmt(traffic.counts.up)} mentions, opens, and closes rise to the items a session names (found mostly in its prompts, so inferred and dotted), and ${fmt(traffic.counts.lateral)} delegations travel to subagents and back (inferred from their events); at most ${MAX_MESSAGES} fly at once, and a faint shaft stays where each pair has traded, the rest state being the long exposure. Items not yet opened are faint, and items closed later show as they stood.`);
        const folds = [];
        if (floor.foldedWedges) folds.push(`${floor.foldedWedges} small packages into one wedge`);
        if (floor.foldedToModules) folds.push(`${fmt(floor.foldedToModules)} files into their modules (over ${MAX_BLOCKS} per wedge)`);
        if (floor.foldedToOther) folds.push(`${fmt(floor.foldedToOther)} files into a “more” block`);
        if (roof.foldedEpics) folds.push(`${roof.foldedEpics} small epics into one ring`);
        if (roof.foldedItems) folds.push(`${roof.foldedItems} items into count marks (over ${MAX_ITEMS} per ring)`);
        if (traffic.foldedShafts) folds.push(`${fmt(traffic.foldedShafts)} quiet pairs’ shafts (over ${MAX_SHAFTS})`);
        if (folds.length) said.push(`Folded: ${folds.join('; ')}.`);
        said.push('Drag up or down (or use the arrow keys) to tilt; hover a plane to lift it apart; click a block, session, or item to select it.');
        return said.join(' ');
      }

      // ---------- interaction ----------
      function pick(sel) {
        if (dragged) return;
        ctx.select(sel);
      }
      function lift(k) {
        lifted = k;
        if (!scene) return;
        scene.planeGroups.forEach((g, j) => {
          // Index 0 is the floor (lowest on screen): planes below the hovered one go down, above go up.
          const dy = k < 0 || j === k ? 0 : j < k ? LIFT : -LIFT;
          g.setAttribute('transform', `translate(0 ${dy})`);
          g.classList.toggle('st-dim', k >= 0 && j !== k);
        });
        scene.shaftLayer.classList.toggle('st-dim', k >= 0);
      }
      function setTilt(t) {
        const next = Math.max(TILT.min, Math.min(TILT.max, t));
        if (Math.abs(next - tilt) < 0.002) return;
        tilt = next;
        draw();
      }
      function startDrag(e) {
        const y0 = e.clientY;
        const t0 = tilt;
        dragged = false;
        let moved = false;
        const move = (ev) => {
          const dy = ev.clientY - y0;
          if (!moved && Math.abs(dy) < 4) return;
          moved = true;
          setTilt(t0 + dy * 0.003);
        };
        const end = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', end);
          if (moved) {
            dragged = true;
            setTimeout(() => (dragged = false), 0);
          }
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', end);
      }

      // ---------- tooltips ----------
      function blockTip(b) {
        const rows = [b.other ? `${b.label} files` : b.label];
        if (b.path) rows.push(['Path', clip(b.path, 60)]);
        rows.push(['Package', b.wedge.label], ['Lines', fmt(b.lines)]);
        if (b.files.length > 1) rows.push(['Files', fmt(b.files.length)]);
        rows.push(['Ring', b.loose ? 'outer: no imports either way' : b.ring >= MAX_DEPTH_RINGS - 1 ? `depth ${MAX_DEPTH_RINGS - 1} or more` : `depth ${b.ring}`]);
        const touches = layout.traffic.shafts.filter((s) => s.type === 'down' && s.to.node === b).reduce((n, s) => n + s.times.length, 0);
        if (touches) rows.push(['Reads and edits', fmt(touches)]);
        if (b.id) rows.push('Click to select');
        return rows;
      }
      function sessionTip(s) {
        const rows = [s.label, ['Session', short(s.id)], ['Prompts', fmt(s.v.prompts.length)], ['Subagents', fmt(s.agents.length)]];
        rows.push(['Works most in', s.wedge ? s.wedge.label : layout.traffic.hasCodeJoin ? 'no loaded file' : 'unknown (no file targets)']);
        if (s.touches) rows.push(['Reads and edits', fmt(s.touches)]);
        const items = ws.joins.planToSession.filter((j) => j.to === s.id).length;
        if (items) rows.push(['Items it names', `≈ ${fmt(items)}`]);
        if (s.v.summary.firstTs) rows.push(['Started', formatTime(s.v.summary.firstTs)]);
        rows.push('Click to select');
        return rows;
      }
      function epicTip(gr) {
        const by = new Map();
        for (const x of gr.items) by.set(x.it.status, (by.get(x.it.status) || 0) + 1);
        return [gr.label, ['Items', fmt(gr.items.length)], ...[...by.entries()].map(([st, n]) => [STATUS_TEXT[st] || st, fmt(n)]), ...(gr.sel ? ['Click to select the epic'] : [])];
      }
      function itemTip(m) {
        if (!m.it) return [m.fold, ['Ring', m.group.label], ['Items', fmt(m.count)]];
        const rows = [clip(m.it.title, 80), ['Status', STATUS_TEXT[m.it.status] || m.it.status], ['Kind', m.it.kind], ['Epic', m.group.label]];
        if (m.it.created) rows.push(['Opened', formatTime(m.it.created)]);
        if (m.it.closed) rows.push(['Closed', formatTime(m.it.closed)]);
        if (m.it.confidence === 'inferred') rows.push('≈ Inferred from its source');
        rows.push('Click to select');
        return rows;
      }

      // ---------- each frame ----------
      /** The status an item showed at time t: not yet opened, open until it closed, else its own. */
      function statusAt(it, t) {
        if (!views.length || clock.atEnd()) return it.status;
        const c = ms(it.created);
        if (Number.isFinite(c) && c > t) return 'unborn';
        const d = ms(it.closed);
        if ((it.status === 'done' || it.status === 'dropped') && Number.isFinite(d) && d > t) return 'open';
        return it.status;
      }
      function paintFrame() {
        bar.sync();
        if (!scene || !layout) return;
        const t = clock.time;
        const speed = clock.speed || 1;
        const { msgs } = layout.traffic;
        const geo = scene.geo;
        const shown = views.length ? countUpTo(msgs, t) : 0;
        // Shafts: the long exposure so far.
        for (const sh of scene.shafts) {
          const n = clock.atEnd() ? sh.s.times.length : countUpTo(sh.s.times, t);
          if (n === sh.n) continue;
          sh.n = n;
          if (!n) sh.line.setAttribute('visibility', 'hidden');
          else {
            sh.line.setAttribute('visibility', 'visible');
            sh.line.setAttribute('stroke-opacity', Math.min(0.55, 0.12 + 0.07 * Math.sqrt(n)).toFixed(2));
          }
        }
        // Items' state at the clock.
        for (const part of scene.parts.items) {
          if (!part.m.it) continue;
          const st = statusAt(part.m.it, t);
          if (st === part.status) continue;
          if (part.status) part.g.classList.remove(`st-st-${part.status}`);
          part.g.classList.remove(`st-st-${part.m.it.status}`);
          part.g.classList.add(`st-st-${st}`);
          part.status = st;
        }
        // Messages in flight, newest first, capped.
        const flying = [];
        const window_ = FLIGHT_MS * speed;
        for (let i = shown - 1; i >= 0 && flying.length < MAX_MESSAGES; i--) {
          const m = msgs[i];
          if (t - m.t > window_) break;
          flying.push({ m, p: Math.min(1, Math.max(0, (t - m.t) / window_)) });
        }
        if (clock.atEnd() && !clock.playing) flying.length = 0;
        scene.pool.forEach((slot, i) => {
          const f = flying[i];
          if (!f) {
            slot.dot.setAttribute('visibility', 'hidden');
            slot.glow.setAttribute('visibility', 'hidden');
            return;
          }
          const a = anchorOf(geo, f.m.from);
          const b = anchorOf(geo, f.m.to);
          const e = f.p < 0.5 ? 2 * f.p * f.p : 1 - Math.pow(-2 * f.p + 2, 2) / 2; // ease in and out
          const x = (a.x + (b.x - a.x) * e).toFixed(1);
          const y = (a.y + (b.y - a.y) * e).toFixed(1);
          slot.dot.setAttribute('class', `st-dot st-${f.m.type}`);
          slot.glow.setAttribute('class', `st-glow st-${f.m.type}`);
          for (const d of [slot.dot, slot.glow]) {
            d.setAttribute('cx', x);
            d.setAttribute('cy', y);
            d.setAttribute('visibility', 'visible');
          }
          slot.dot.setAttribute('r', f.m.type === 'lateral' ? 1.8 : f.m.act === 'edit' || f.m.act === 'close' ? 2.8 : 2.4);
        });
        scene.stamp.textContent = views.length && clock.events.length ? `${clock.mode() === 'live' ? 'live' : `replay ×${Math.round(speed)}`} · ${formatTime(new Date(t).toISOString())}` : '';
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
