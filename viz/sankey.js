// Sankey: where tokens went, flowing from sessions to the main agent or
// subagents to models. Widths are measured tokens, with no tool category split,
// which would be an approximation. See docs/visualization-explorer.md for
// the contract. Clicking a ribbon lists the turns behind it, each announcing
// { sessionId, turnId }; a selected turn narrows the ribbons to its own. The
// pinned ribbon lives in the instance. Given options.shape (code or plans, see
// docs/workspace-explorer.md, "Shapes"), it draws the Shape's links as flows
// instead: code from what imports to what it imports (modules and externals),
// plans from blocker to blocked, width by link weight, columns by dependency
// depth. Past MAX_SHAPE_NODES, ends fold to their parents; a cycle's members
// share a column and the links that close it are drawn as dashed arcs. A node
// or ribbon announces { artifactId } or { itemId }. Sees only its host and
// ctx: no VS Code.
(function () {
  const NODE_W = 12;
  const NODE_GAP = 14;
  const HEIGHT = 340; // the flows' height outside the explorer; in a slide they take its height, down to MIN_HEIGHT
  const MIN_HEIGHT = 240;
  const MAX_SHAPE_NODES = 36; // a Shape's linked nodes before their ends fold to parents
  const SHAPE_NODE_GAP = 8;

  /** Strongly connected components (iterative Tarjan): Map(id -> component index). */
  function components(ids, out) {
    const index = new Map();
    const low = new Map();
    const comp = new Map();
    const stack = [];
    const onStack = new Set();
    let next = 0;
    let count = 0;
    for (const start of ids) {
      if (index.has(start)) continue;
      const work = [[start, 0]];
      index.set(start, next);
      low.set(start, next++);
      stack.push(start);
      onStack.add(start);
      while (work.length) {
        const frame = work[work.length - 1];
        const [v, i] = frame;
        const succ = out.get(v) || [];
        if (i < succ.length) {
          frame[1]++;
          const w = succ[i];
          if (!index.has(w)) {
            index.set(w, next);
            low.set(w, next++);
            stack.push(w);
            onStack.add(w);
            work.push([w, 0]);
          } else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
          continue;
        }
        work.pop();
        if (work.length) {
          const u = work[work.length - 1][0];
          low.set(u, Math.min(low.get(u), low.get(v)));
        }
        if (low.get(v) === index.get(v)) {
          let w;
          do {
            w = stack.pop();
            onStack.delete(w);
            comp.set(w, count);
          } while (w !== v);
          count++;
        }
      }
    }
    return comp;
  }
  window.factoryClock.register({
    id: 'sankey',
    title: 'Sankey',
    tags: { subject: ['sessions', 'code', 'plans'], category: ['actor', 'quantitative', 'dependency'], purpose: ['expressive', 'informative'], level: ['session', 'project'], dimension: ['quantity', 'actor', 'structure', 'dependency', 'status'], language: ['standard'] },
    mount(host, ctx) {
      const { el, svg, svgText, fmt, compact, clip, fit, modelShort, callTokens, sessionName, sessionClass, legendKey, vizPanel, interact, shapeClass, shapeLegend, shapeSelection, shapeTip, shapeKindText } = ctx;
      let views = [];
      let selection = null;
      let pinned = null;
      let shape = null; // with a subject: the Shape to draw instead of the sessions
      let subject = null;
      const panel = vizPanel(host, []);
      const fitH = ctx.fitter(host); // the flows fill the slide's height
      const turnsHost = el('div');
      host.append(turnsHost);

      /** Links: Map(from|to -> { from, to, tokens, turns: Map(session\nturn -> tokens) }), between three columns of nodes. */
      function flows() {
        const nodes = [new Map(), new Map(), new Map()];
        const links = new Map();
        const addNode = (col, key, label, cls, tokens) => {
          const n = nodes[col].get(key) || { key, col, label, cls, value: 0 };
          n.value += tokens;
          nodes[col].set(key, n);
        };
        const addLink = (from, to, cls, tokens, sessionId, turnId) => {
          const key = `${from}|${to}`;
          const l = links.get(key) || { key, from, to, cls, tokens: 0, turns: new Map() };
          l.tokens += tokens;
          const t = `${sessionId}\n${turnId || ''}`;
          l.turns.set(t, (l.turns.get(t) || 0) + tokens);
          links.set(key, l);
        };
        views.forEach((v, s) => {
          const id = v.summary.sessionId;
          for (const c of v.calls) {
            const t = callTokens(c);
            if (t <= 0) continue;
            const agent = c.agentId ? 'a:Subagents' : 'a:Main agent';
            const model = `m:${c.model || 'unknown model'}`;
            addNode(0, `s:${id}`, sessionName(v.summary, 40), sessionClass(s), t);
            addNode(1, agent, agent.slice(2), c.agentId ? 's2' : 's1', t);
            addNode(2, model, modelShort(c.model || 'unknown model'), 'sankey-model', t);
            addLink(`s:${id}`, agent, sessionClass(s), t, id, c.turnId);
            addLink(agent, model, c.agentId ? 's2' : 's1', t, id, c.turnId);
          }
        });
        return { columns: nodes.map((m) => [...m.values()]), links: [...links.values()] };
      }

      function drawTurns(links) {
        const link = links.find((l) => l.key === pinned);
        if (!link) {
          turnsHost.replaceChildren();
          return;
        }
        const rows = [...link.turns].sort((a, b) => b[1] - a[1]).slice(0, 12);
        const nameOf = (k) => {
          if (k.startsWith('m:')) return modelShort(k.slice(2));
          if (k.startsWith('a:')) return k.slice(2);
          return sessionName(views.find((v) => v.summary.sessionId === k.slice(2)).summary, 40);
        };
        turnsHost.replaceChildren(
          el('p', { class: 'small ribbon-turns-head', text: `${nameOf(link.from)} → ${nameOf(link.to)}: the costliest turns${link.turns.size > rows.length ? ` (${rows.length} of ${fmt(link.turns.size)})` : ''}` }),
          el(
            'ul',
            { class: 'terms-prompts' },
            rows.map(([key, tokens]) => {
              const [sessionId, turnId] = key.split('\n');
              const v = views.find((x) => x.summary.sessionId === sessionId);
              const p = turnId && v.prompts.find((q) => q.turnId === turnId);
              const text = turnId && (v.prompts.find((q) => q.turnId === turnId && q.text) || {}).text;
              const b = el('button', { class: 'terms-prompt' }, [el('span', { class: 'muted', text: `${p ? `P${p.index}` : 'Unlinked'} · ${compact(tokens)} tokens ` }), text ? clip(text, 120) : '']);
              b.addEventListener('click', () => ctx.select(turnId ? { sessionId, turnId } : { sessionId }));
              return el('li', {}, [b]);
            })
          )
        );
      }

      /**
       * The Shape's links as flows: plans' blocks links, or every code dependency. Past MAX_SHAPE_NODES linked
       * nodes, the deepest ends fold to their parents, a level at a time; links that fold onto one pair merge.
       */
      function shapeFlows() {
        const byId = new Map(shape.nodes.map((n) => [n.id, n]));
        const raw = shape.links.filter((l) => (subject === 'plans' ? l.kind === 'blocks' : true) && byId.has(l.from) && byId.has(l.to));
        const depthOf = new Map();
        const depth = (id) => {
          if (depthOf.has(id)) return depthOf.get(id);
          let d = 0;
          const seen = new Set([id]);
          for (let p = byId.get(id).parent; p && byId.has(p) && !seen.has(p); p = byId.get(p).parent) {
            seen.add(p);
            d++;
          }
          depthOf.set(id, d);
          return d;
        };
        const rep = new Map();
        const repOf = (id) => rep.get(id) || id;
        let merged = [];
        let ends = new Set();
        let folds = 0;
        for (;;) {
          const pairs = new Map();
          for (const l of raw) {
            const from = repOf(l.from);
            const to = repOf(l.to);
            if (from === to) continue;
            const key = `${from}\u0000${to}`;
            const m = pairs.get(key);
            if (m) {
              m.weight += l.weight;
              m.count++;
              m.kinds.add(l.kind);
              if (!l.inferred) m.inferred = false;
            } else pairs.set(key, { key, from, to, weight: l.weight, count: 1, kinds: new Set([l.kind]), inferred: !!l.inferred });
          }
          merged = [...pairs.values()];
          ends = new Set(merged.flatMap((l) => [l.from, l.to]));
          if (ends.size <= MAX_SHAPE_NODES) break;
          const liftable = [...ends].filter((id) => byId.get(id).parent && byId.has(byId.get(id).parent));
          if (!liftable.length) break;
          const deepest = Math.max(...liftable.map(depth));
          const lift = new Set(liftable.filter((id) => depth(id) === deepest));
          for (const n of shape.nodes) if (lift.has(repOf(n.id))) rep.set(n.id, byId.get(repOf(n.id)).parent);
          folds++;
        }
        return { byId, links: merged, ends, folds, repOf };
      }

      function drawShape() {
        turnsHost.replaceChildren();
        const { byId, links, ends, folds, repOf } = shapeFlows();
        if (!links.length) {
          panel.empty(subject === 'plans' ? 'No item blocks another in the loaded plans, so there’s nothing to flow.' : 'No dependencies between the loaded code’s artifacts, so there’s nothing to flow.');
          return;
        }
        // Columns by dependency depth. A depth-first walk (in id order, so the same input gives the same picture)
        // finds the links that close cycles; the rest form a DAG, and a node's column is its longest path in it.
        const ids = [...ends].sort();
        const out = new Map(ids.map((id) => [id, []]));
        for (const l of links) out.get(l.from).push(l);
        for (const list of out.values()) list.sort((a, b) => a.to.localeCompare(b.to));
        const state = new Map(); // 1 on the walk's path, 2 done
        const closes = new Set();
        for (const start of ids) {
          if (state.has(start)) continue;
          const work = [[start, 0]];
          state.set(start, 1);
          while (work.length) {
            const frame = work[work.length - 1];
            const list = out.get(frame[0]);
            if (frame[1] < list.length) {
              const l = list[frame[1]++];
              if (state.get(l.to) === 1) closes.add(l);
              else if (!state.has(l.to)) {
                state.set(l.to, 1);
                work.push([l.to, 0]);
              }
              continue;
            }
            state.set(frame[0], 2);
            work.pop();
          }
        }
        const dag = links.filter((l) => !closes.has(l));
        const indeg = new Map(ids.map((id) => [id, 0]));
        for (const l of dag) indeg.set(l.to, indeg.get(l.to) + 1);
        const level = new Map(ids.map((id) => [id, 0]));
        const queue = ids.filter((id) => !indeg.get(id));
        while (queue.length) {
          const id = queue.shift();
          for (const l of out.get(id)) {
            if (closes.has(l)) continue;
            level.set(l.to, Math.max(level.get(l.to), level.get(id) + 1));
            indeg.set(l.to, indeg.get(l.to) - 1);
            if (!indeg.get(l.to)) queue.push(l.to);
          }
        }
        const colOf = (id) => level.get(id);
        const forward = dag;
        const back = [...closes];
        const comp = components(ids, new Map(ids.map((id) => [id, out.get(id).map((l) => l.to)])));
        const sizes = new Map();
        for (const c of comp.values()) sizes.set(c, (sizes.get(c) || 0) + 1);
        const cycles = [...sizes.values()].filter((k) => k > 1).length;
        const ncols = Math.max(...ids.map(colOf)) + 1;
        const nodes = new Map(
          ids.map((id) => {
            const inW = forward.filter((l) => l.to === id).reduce((a, l) => a + l.weight, 0);
            const outW = forward.filter((l) => l.from === id).reduce((a, l) => a + l.weight, 0);
            return [id, { id, node: byId.get(id), col: colOf(id), value: Math.max(inW, outW), inW, outW }];
          })
        );
        const columns = Array.from({ length: ncols }, () => []);
        for (const n of nodes.values()) columns[n.col].push(n);
        // Names that repeat (every package has its tests) take their parent's name in front.
        const seen = new Map();
        for (const n of nodes.values()) seen.set(n.node.label, (seen.get(n.node.label) || 0) + 1);
        for (const n of nodes.values()) {
          const p = n.node.parent && byId.get(n.node.parent);
          n.label = seen.get(n.node.label) > 1 && p ? `${p.label}/${n.node.label}` : n.node.label;
        }
        // Order: by parent, then largest first; then a barycentric pass left to right, so flows cross less.
        const parentLabel = (n) => (n.node.parent && byId.has(n.node.parent) ? byId.get(n.node.parent).label : '');
        for (const col of columns) col.sort((a, b) => parentLabel(a).localeCompare(parentLabel(b)) || b.value - a.value || a.id.localeCompare(b.id));
        columns.forEach((col, c) => {
          col.forEach((n, i) => (n.rank = i));
          if (!c) return;
          const bary = (n) => {
            const from = forward.filter((l) => l.to === n.id).map((l) => nodes.get(l.from));
            return from.length ? from.reduce((a, m) => a + (m.rank + 0.5) / columns[m.col].length, 0) / from.length : (n.rank + 0.5) / col.length;
          };
          const keyed = col.map((n) => [bary(n), n]);
          keyed.sort((a, b) => a[0] - b[0] || a[1].id.localeCompare(b[1].id));
          col.splice(0, col.length, ...keyed.map(([, n]) => n));
          col.forEach((n, i) => (n.rank = i));
        });

        const width = Math.max(420, host.clientWidth || 800);
        const most = Math.max(...columns.map((c) => c.length));
        const fitted = fitH.height(HEIGHT + 30, MIN_HEIGHT + 30) - 30;
        const height = Math.max(fitted, most * (SHAPE_NODE_GAP + 10));
        const heaviest = Math.max(1, ...columns.map((col) => col.reduce((a, n) => a + n.value, 0)));
        const scale = (height - (most - 1) * SHAPE_NODE_GAP - most * 2) / heaviest;
        const labelRoom = Math.min(170, width * 0.22);
        const step = ncols > 1 ? (width - 8 - labelRoom - NODE_W) / (ncols - 1) : 0;
        let bottom = height;
        columns.forEach((col, c) => {
          const span = col.reduce((a, n) => a + Math.max(2, n.value * scale), 0) + (col.length - 1) * SHAPE_NODE_GAP;
          let y = (height - span) / 2 + 3;
          for (const n of col) {
            n.x = 4 + c * step;
            n.y = y;
            n.h = Math.max(2, n.value * scale);
            n.out = 0;
            n.in = 0;
            y += n.h + SHAPE_NODE_GAP;
          }
          bottom = Math.max(bottom, y - SHAPE_NODE_GAP);
        });
        const sel = selection;
        const selectedId = sel ? [sel.artifactId, sel.itemId].find((id) => id && byId.has(id)) : null;
        // A selected node folded away is shown by the node it folded into, or its nearest drawn ancestor.
        let on = selectedId ? repOf(selectedId) : null;
        const guard = new Set();
        while (on && !nodes.has(on) && !guard.has(on)) {
          guard.add(on);
          on = byId.has(on) ? byId.get(on).parent || null : null;
        }
        if (on && !nodes.has(on)) on = null;
        const total = forward.reduce((a, l) => a + l.weight, 0);
        const root = svg('svg', { class: 'viz-chart sankey-chart', viewBox: `0 0 ${width} ${bottom + 30}`, role: 'img', 'aria-label': `Sankey of ${links.length} ${subject === 'plans' ? 'blocking links' : 'dependencies'} among ${nodes.size} ${subject === 'plans' ? 'items' : 'artifacts'}, in ${ncols} columns` });
        const linkTip = (l, a, b) => [`${a.label} → ${b.label}`, [subject === 'plans' ? 'Link' : 'Kind', [...l.kinds].map(shapeKindText).join(', ') + (l.inferred ? ' (inferred)' : '')], ['Weight', fmt(l.weight)], ...(l.count > 1 ? [['Links folded in', fmt(l.count)]] : [])];
        const linkMark = (l, a, b, g) => {
          interact(ctx, g, {
            label: `${a.label} to ${b.label}: weight ${fmt(l.weight)}`,
            tip: () => linkTip(l, a, b),
            pick: () => ctx.select(shapeSelection(subject, l.from)),
          });
          root.append(g);
        };
        const sorted = [...forward].sort((p, q) => nodes.get(p.from).y - nodes.get(q.from).y || nodes.get(p.to).y - nodes.get(q.to).y);
        for (const l of sorted) {
          const a = nodes.get(l.from);
          const b = nodes.get(l.to);
          const h = l.weight * scale;
          const y0 = a.y + a.out;
          const y1 = b.y + b.in;
          a.out += h;
          b.in += h;
          const x0 = a.x + NODE_W;
          const x1 = b.x;
          const mid = (x0 + x1) / 2;
          const dim = on && l.from !== on && l.to !== on;
          const g = svg('g', { class: `ribbon${dim ? ' ribbon-dim' : ''}` });
          g.append(svg('path', { class: `ribbon-shape ${shapeClass(a.node)}${l.inferred ? ' shape-inferred' : ''}`, d: `M${x0} ${y0} C${mid} ${y0} ${mid} ${y1} ${x1} ${y1} L${x1} ${y1 + h} C${mid} ${y1 + h} ${mid} ${y0 + h} ${x0} ${y0 + h} Z` }));
          linkMark(l, a, b, g);
        }
        for (const l of back) {
          // A link that closes a cycle (or stays in its column) loops back under its ends, dashed.
          const a = nodes.get(l.from);
          const b = nodes.get(l.to);
          const x0 = a.x + NODE_W;
          const ya = a.y + a.h / 2;
          const yb = b.y + b.h / 2;
          const dip = Math.min(bottom + 24, Math.max(ya, yb) + 24);
          const d = `M${x0} ${ya} C${x0 + 30} ${dip} ${b.x - 30} ${dip} ${b.x} ${yb}`;
          const dim = on && l.from !== on && l.to !== on;
          const g = svg('g', { class: `ribbon sankey-back-group${dim ? ' ribbon-dim' : ''}` });
          g.append(svg('path', { class: `sankey-back${l.inferred ? ' shape-inferred' : ''}`, d }));
          g.append(svg('path', { class: 'sankey-back-hit', d }));
          linkMark(l, a, b, g);
        }
        for (const col of columns) {
          for (const n of col) {
            const g = svg('g', { class: 'sankey-shape-node' });
            g.append(svg('rect', { class: `sankey-node ${shapeClass(n.node)}${n.node.inferred ? ' shape-inferred' : ''}${n.id === on ? ' shape-on' : ''}`, x: n.x, y: n.y, width: NODE_W, height: n.h, rx: 2 }));
            const last = n.col === ncols - 1;
            const avail = last ? labelRoom - 8 : Math.max(0, step - NODE_W - 10);
            const text = fit(n.label, avail);
            if (text) g.append(svgText({ class: 'row-label sankey-label', x: n.x + NODE_W + 6, y: n.y + n.h / 2 + 4 }, text));
            interact(ctx, g, {
              label: `${n.label}: ${fmt(n.outW)} out, ${fmt(n.inW)} in`,
              tip: () => shapeTip(shape, n.node, [[subject === 'plans' ? 'Blocks' : 'Depends on', fmt(n.outW)], [subject === 'plans' ? 'Blocked by' : 'Depended on by', fmt(n.inW)]]),
              pick: () => ctx.select(shapeSelection(subject, n.id)),
            });
            root.append(g);
          }
        }
        panel.chart.replaceChildren(root);
        const drawn = { nodes: [...nodes.values()].map((n) => n.node), links: links.filter((l) => l.inferred) };
        panel.legend.replaceChildren(...shapeLegend({ ...shape, ...drawn }), ...(back.length ? [legendKey('swatch-sankey-back', 'points back (a cycle)')] : []));
        const flow = subject === 'plans' ? 'From blocker to blocked, one link each' : `From what imports to what it imports, width by weight (${fmt(total)} in all)`;
        const folded = folds ? ` More than ${MAX_SHAPE_NODES} ${subject === 'plans' ? 'items' : 'artifacts'} had links, so ends were folded into their parents ${folds === 1 ? 'one level' : `${folds} levels`}.` : '';
        const cyc = back.length ? ` ${cycles ? `${cycles === 1 ? 'A cycle' : `${cycles} cycles`} (a group that depends on itself): ` : ''}${back.length} link${back.length === 1 ? '' : 's'} closing ${cycles === 1 ? 'it' : 'them'} ${back.length === 1 ? 'is' : 'are'} drawn back as ${back.length === 1 ? 'a dashed arc' : 'dashed arcs'}.` : '';
        panel.note.textContent = `${flow}; columns by dependency depth.${cyc}${folded} Ribbons take their source’s color${drawn.links.length ? '; inferred links are outlined dashed' : ''}. Click a node or ribbon to select ${subject === 'plans' ? 'an item' : 'an artifact'}${on ? '; flows away from the selection are dimmed' : ''}.`;
        fitH.settle(bottom + 30, draw);
      }

      function draw() {
        if (shape) return drawShape();
        const { columns, links } = flows();
        if (!links.length) {
          panel.empty(views.length ? `No model calls with token usage in ${views.length === 1 ? 'this session' : 'these sessions'}.` : '');
          turnsHost.replaceChildren();
          return;
        }
        const width = Math.max(420, host.clientWidth || 800);
        const total = columns[1].reduce((a, n) => a + n.value, 0);
        const most = Math.max(...columns.map((c) => c.length));
        const plotH = fitH.height(HEIGHT + 9, MIN_HEIGHT + 9) - 9; // the columns sit 3px down, so 9 below the plot covers the svg
        const scale = (plotH - (most - 1) * NODE_GAP) / total;
        const label = Math.min(150, width * 0.22);
        const xs = [label, (width - NODE_W) / 2, width - label - NODE_W];
        const byKey = new Map();
        let bottom = plotH;
        columns.forEach((col, c) => {
          const room = plotH - (col.reduce((a, n) => a + n.value * scale, 0) + (col.length - 1) * NODE_GAP);
          let y = room / 2 + 3;
          col.sort((a, b) => (c === 1 ? a.key.localeCompare(b.key) : b.value - a.value));
          for (const n of col) {
            n.y = y;
            n.h = Math.max(2, n.value * scale);
            n.out = 0;
            n.in = 0;
            n.x = xs[c];
            byKey.set(n.key, n);
            y += n.h + NODE_GAP;
          }
          bottom = Math.max(bottom, y - NODE_GAP);
        });
        const root = svg('svg', { class: 'viz-chart sankey-chart', viewBox: `0 0 ${width} ${bottom + 6}`, role: 'img', 'aria-label': `Sankey of ${compact(total)} tokens from sessions through agents to models` });
        const sel = selection;
        for (const l of [...links].sort((a, b) => byKey.get(a.from).y - byKey.get(b.from).y || byKey.get(a.to).y - byKey.get(b.to).y)) {
          const a = byKey.get(l.from);
          const b = byKey.get(l.to);
          const h = l.tokens * scale;
          const y0 = a.y + a.out;
          const y1 = b.y + b.in;
          a.out += h;
          b.in += h;
          const x0 = a.x + NODE_W;
          const x1 = b.x;
          const mid = (x0 + x1) / 2;
          const inTurn = !sel || !sel.turnId || [...l.turns.keys()].some((k) => k.endsWith(`\n${sel.turnId}`) && (!sel.sessionId || k.startsWith(`${sel.sessionId}\n`)));
          const g = svg('g', { class: `ribbon${inTurn ? '' : ' ribbon-dim'}${l.key === pinned ? ' ribbon-on' : ''}` });
          g.append(svg('path', { class: `ribbon-shape ${l.cls}`, d: `M${x0} ${y0} C${mid} ${y0} ${mid} ${y1} ${x1} ${y1} L${x1} ${y1 + h} C${mid} ${y1 + h} ${mid} ${y0 + h} ${x0} ${y0 + h} Z` }));
          interact(ctx, g, {
            label: `${a.label} to ${b.label}: ${compact(l.tokens)} tokens; list its turns`,
            tip: () => [`${a.label} → ${b.label}`, ['Tokens', fmt(l.tokens)], ['Share', `${Math.round((l.tokens / total) * 100)}%`], ['Turns', fmt(l.turns.size)]],
            pick: () => {
              pinned = pinned === l.key ? null : l.key;
              draw();
            },
          });
          root.append(g);
        }
        for (const col of columns) {
          for (const n of col) {
            root.append(svg('rect', { class: `sankey-node ${n.cls}`, x: n.x, y: n.y, width: NODE_W, height: n.h, rx: 2 }));
            const left = n.x < width / 3;
            const right = n.x > (width * 2) / 3;
            const avail = left || right ? label - 8 : 160;
            const t = svgText({ class: 'row-label sankey-label', x: left ? n.x - 6 : n.x + NODE_W + 6, y: n.y + n.h / 2 + 4, 'text-anchor': left ? 'end' : 'start' }, fit(`${n.label} ${compact(n.value)}`, avail));
            root.append(t);
          }
        }
        panel.chart.replaceChildren(root);
        panel.legend.replaceChildren(legendKey('s1', 'main agent'), legendKey('s2', 'subagents'), legendKey('sankey-model', 'model'));
        panel.note.textContent = `Width is measured tokens, ${compact(total)} in all. A ribbon takes its source’s color. Click a ribbon to list its costliest turns${sel && sel.turnId ? '; ribbons outside the selected turn are dimmed' : ''}.`;
        drawTurns(links);
        // A ribbon's list of turns scrolls below the flows rather than shrinking them, so it's left out of the measure.
        turnsHost.hidden = true;
        fitH.settle(bottom + 6, draw);
        turnsHost.hidden = false;
      }
      return {
        update(sessions, sel, options) {
          views = sessions;
          selection = sel || null;
          shape = (options && options.shape) || null;
          subject = (options && options.subject) || null;
          draw();
        },
        resize: draw,
        destroy() {
          ctx.hideTip();
          host.replaceChildren();
        },
      };
    },
  });
})();
