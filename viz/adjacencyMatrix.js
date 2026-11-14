// Adjacency matrix: who acted on whom, as a grid. Rows are the actor acting, and
// columns the actor acted on: messages, delegation, model calls, and tool calls.
// A pair has one kind of relationship, named in its tooltip, and delegation is
// outlined dashed because it's inferred from agent ids and order. Unlike the
// actor graph, it stays readable when many actors interact. See
// docs/visualization-explorer.md for the contract. Clicking a cell
// announces the turn with the most of that interaction. Given options.shape
// (code or plans, see docs/workspace-explorer.md, "Shapes"), it draws the
// Shape's links instead, the coupling matrix: rows and columns are the nodes
// that have links (code at the level it was folded to, plan items), a cell is
// the summed weight of the row's links to the column, inferred links outlined
// dashed. Nodes are grouped by parent and ordered within a group by degree and
// a barycentric pass, so clusters show as blocks on the diagonal. Past
// MAX_SHAPE_NODES the deepest nodes fold to their parents. A cell or a row
// announces { artifactId } or { itemId }. Sees only its host and ctx: no VS Code.
(function () {
  const MAX_SUBAGENTS = 8;
  const CELL = 34;
  const MAX_SHAPE_NODES = 48; // a Shape's linked nodes before the deepest fold to their parents
  const SHAPE_CELL_MAX = 30;
  const SHAPE_CELL_MIN = 12;
  const FIT_GROW = 1.5; // in the explorer, cells grow up to this many times their usual size to fill the slide's height, as the width allows
  window.factoryClock.register({
    id: 'adjacency-matrix',
    title: 'Adjacency matrix',
    tags: { subject: ['sessions', 'code', 'plans'], category: ['actor', 'dependency'], purpose: ['informative'], level: ['session', 'project'], dimension: ['actor', 'communication', 'quantity', 'structure', 'dependency'], language: ['standard'] },
    mount(host, ctx) {
      const { el, svg, svgText, fmt, compact, fit, modelShort, heatScale, legendKey, vizPanel, interact, shapeClass, shapeSelection, shapeTip, shapeKindText } = ctx;
      let views = [];
      let selection = null;
      let shape = null; // with a subject: the Shape to draw instead of the sessions
      let subject = null;
      const panel = vizPanel(host, []);
      const fitH = ctx.fitter(host); // the matrix fills the slide's height, as far as its width allows

      function build() {
        const subagents = new Set();
        for (const v of views) for (const c of [...v.calls, ...v.tools]) if (c.agentId) subagents.add(c.agentId);
        const fold = subagents.size > MAX_SUBAGENTS;
        const short = (id) => `sub ${id.replace(/^agent-/, '').slice(0, 7)}`;
        const actors = new Map();
        const actor = (key, label, kind, order) => {
          if (!actors.has(key)) actors.set(key, { key, label, kind, order });
          return key;
        };
        const you = () => actor('you', 'You', 'you', 0);
        const agentOf = (id) => (!id ? actor('main', 'Main agent', 'agent', 1) : fold ? actor('subs', 'Subagents', 'subagent', 2) : actor(`sub:${id}`, short(id), 'subagent', 2));
        const cells = new Map();
        const add = (from, to, type, sessionId, turnId, inferred, failed) => {
          const key = `${from}|${to}`;
          const c = cells.get(key) || { from, to, type, inferred, count: 0, failed: 0, turns: new Map() };
          c.count++;
          if (failed) c.failed++;
          const t = `${sessionId}\n${turnId || ''}`;
          c.turns.set(t, (c.turns.get(t) || 0) + 1);
          cells.set(key, c);
        };
        for (const v of views) {
          const id = v.summary.sessionId;
          const turns = new Set(v.prompts.map((p) => p.turnId));
          for (const t of turns) add(you(), agentOf(null), 'Message: a prompt', id, t, false);
          const answered = new Set();
          const delegated = new Set();
          for (const c of v.calls) {
            const model = actor(`model:${c.model || '?'}`, modelShort(c.model || 'unknown model'), 'model', 3);
            add(agentOf(c.agentId), model, 'Model call', id, c.turnId, false);
            if (!c.agentId && c.turnId && !answered.has(c.turnId)) {
              answered.add(c.turnId);
              add(agentOf(null), you(), 'Message: a turn’s reply', id, c.turnId, false);
            }
          }
          for (const e of [...v.calls, ...v.tools]) {
            if (!e.agentId || !e.turnId) continue;
            const k = `${e.turnId}|${e.agentId}`;
            if (delegated.has(k)) continue;
            delegated.add(k);
            add(agentOf(null), agentOf(e.agentId), 'Delegation (inferred)', id, e.turnId, true);
          }
          for (const x of v.tools) {
            const tool = actor(`tool:${x.category}`, x.category, 'tool', 4 + (x.colorGroup || 9) / 10);
            add(agentOf(x.agentId), tool, 'Tool call', id, x.turnId, false, x.status === 'failure');
          }
        }
        const list = [...actors.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
        return { list, cells, fold };
      }

      /** The Shape's links as cells between the nodes that have them; past MAX_SHAPE_NODES, the deepest fold to their parents. */
      function shapeCells() {
        const byId = new Map(shape.nodes.map((n) => [n.id, n]));
        const raw = shape.links.filter((l) => byId.has(l.from) && byId.has(l.to));
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
        let cells = new Map();
        let ids = [];
        let folds = 0;
        for (;;) {
          cells = new Map();
          for (const l of raw) {
            const from = repOf(l.from);
            const to = repOf(l.to);
            if (from === to) continue;
            const key = `${from}\u0000${to}`;
            const c = cells.get(key);
            if (c) {
              c.weight += l.weight;
              c.count++;
              c.kinds.add(l.kind);
              if (!l.inferred) c.inferred = false;
            } else cells.set(key, { from, to, weight: l.weight, count: 1, kinds: new Set([l.kind]), inferred: !!l.inferred });
          }
          ids = [...new Set([...cells.values()].flatMap((c) => [c.from, c.to]))].sort();
          if (ids.length <= MAX_SHAPE_NODES) break;
          const liftable = ids.filter((id) => byId.get(id).parent && byId.has(byId.get(id).parent));
          if (!liftable.length) break;
          const deepest = Math.max(...liftable.map(depth));
          const lift = new Set(liftable.filter((id) => depth(id) === deepest));
          for (const n of shape.nodes) if (lift.has(repOf(n.id))) rep.set(n.id, byId.get(repOf(n.id)).parent);
          folds++;
        }
        const over = ids.length > MAX_SHAPE_NODES;
        if (over) {
          // Still too many with nothing left to fold: keep the most connected.
          const deg = new Map(ids.map((id) => [id, 0]));
          for (const c of cells.values()) {
            deg.set(c.from, deg.get(c.from) + c.weight);
            deg.set(c.to, deg.get(c.to) + c.weight);
          }
          const keep = new Set([...ids].sort((a, b) => deg.get(b) - deg.get(a) || a.localeCompare(b)).slice(0, MAX_SHAPE_NODES));
          ids = ids.filter((id) => keep.has(id));
          for (const [k, c] of cells) if (!keep.has(c.from) || !keep.has(c.to)) cells.delete(k);
        }
        return { byId, cells, ids, folds, over, repOf };
      }

      /** Grouped by parent; within a group by degree, then two barycentric passes over the whole order, groups kept whole. */
      function shapeOrder(ids, cells, byId) {
        const deg = new Map(ids.map((id) => [id, 0]));
        const nbrs = new Map(ids.map((id) => [id, []]));
        for (const c of cells.values()) {
          deg.set(c.from, deg.get(c.from) + c.weight);
          deg.set(c.to, deg.get(c.to) + c.weight);
          nbrs.get(c.from).push([c.to, c.weight]);
          nbrs.get(c.to).push([c.from, c.weight]);
        }
        const groupOf = (id) => byId.get(id).parent || '';
        const groups = new Map();
        for (const id of ids) {
          if (!groups.has(groupOf(id))) groups.set(groupOf(id), []);
          groups.get(groupOf(id)).push(id);
        }
        const groupDeg = (g) => groups.get(g).reduce((a, id) => a + deg.get(id), 0);
        let order = [...groups.keys()].sort((a, b) => groupDeg(b) - groupDeg(a) || a.localeCompare(b)).flatMap((g) => groups.get(g).sort((a, b) => deg.get(b) - deg.get(a) || a.localeCompare(b)));
        for (let pass = 0; pass < 2; pass++) {
          const at = new Map(order.map((id, i) => [id, i]));
          const bary = (id) => {
            const list = nbrs.get(id);
            const w = list.reduce((a, [, x]) => a + x, 0);
            return w ? list.reduce((a, [o, x]) => a + at.get(o) * x, 0) / w : at.get(id);
          };
          const b = new Map(order.map((id) => [id, bary(id)]));
          const gb = new Map([...groups.keys()].map((g) => [g, groups.get(g).reduce((a, id) => a + b.get(id), 0) / groups.get(g).length]));
          const keyOf = (g) => gb.get(g);
          order = [...groups.keys()]
            .sort((x, y) => keyOf(x) - keyOf(y) || x.localeCompare(y))
            .flatMap((g) => groups.get(g).sort((p, q) => b.get(p) - b.get(q) || deg.get(q) - deg.get(p) || p.localeCompare(q)));
        }
        return { order, deg, groupOf };
      }

      function drawShape() {
        const { byId, cells, ids, folds, over, repOf } = shapeCells();
        if (!cells.size) {
          panel.empty(subject === 'plans' ? 'No links between the loaded plans’ items, so there’s nothing to cross.' : 'No dependencies between the loaded code’s artifacts, so there’s nothing to cross.');
          return;
        }
        const { order, deg, groupOf } = shapeOrder(ids, cells, byId);
        const counts = new Map();
        for (const id of order) counts.set(byId.get(id).label, (counts.get(byId.get(id).label) || 0) + 1);
        const nameOf = (id) => {
          const n = byId.get(id);
          const p = n.parent && byId.get(n.parent);
          return counts.get(n.label) > 1 && p ? `${p.label}/${n.label}` : n.label;
        };
        const n = order.length;
        const avail = Math.max(320, host.clientWidth || 800);
        const label = Math.min(170, Math.max(110, avail * 0.2));
        const head = 110;
        const room = fitH.height(0, 0); // 0 outside the explorer: the matrix keeps its own size
        const cap = room ? Math.max(SHAPE_CELL_MAX, Math.min(Math.round(SHAPE_CELL_MAX * FIT_GROW), Math.floor((room - head - 2) / n))) : SHAPE_CELL_MAX;
        const cell = Math.max(SHAPE_CELL_MIN, Math.min(cap, Math.floor((avail - label - head) / n)));
        const fullW = label + n * cell + head;
        const fullH = Math.max(head + n * cell + 2, room);
        const scale = heatScale(Math.max(...[...cells.values()].map((c) => c.weight)));
        const root = svg('svg', { class: 'viz-chart adj-chart', width: fullW, height: fullH, viewBox: `0 0 ${fullW} ${fullH}`, role: 'img', 'aria-label': `Coupling matrix of ${n} ${subject === 'plans' ? 'items' : 'artifacts'} and ${cells.size} links` });
        const sel = selection;
        const selectedId = sel ? [sel.artifactId, sel.itemId].find((id) => id && byId.has(id)) : null;
        const on = selectedId && order.includes(repOf(selectedId)) ? repOf(selectedId) : null;
        // Parent groups as blocks on the diagonal.
        let start = 0;
        order.forEach((id, i) => {
          if (i + 1 < n && groupOf(order[i + 1]) === groupOf(id)) return;
          if (i > start) root.append(svg('rect', { class: 'adj-group', x: label + start * cell - 1, y: head + start * cell - 1, width: (i - start + 1) * cell, height: (i - start + 1) * cell }));
          start = i + 1;
        });
        order.forEach((id, c) => {
          const x = label + c * cell + cell / 2 + 3;
          root.append(svgText({ class: `axis-label${id === on ? ' adj-label-on' : ''}`, transform: `translate(${x} ${head - 6}) rotate(-45)` }, fit(nameOf(id), 130)));
        });
        order.forEach((rowId, r) => {
          const y = head + r * cell;
          const row = byId.get(rowId);
          const g = svg('g', { class: 'adj-row' });
          g.append(svg('rect', { class: `adj-swatch ${shapeClass(row)}${row.inferred ? ' shape-inferred' : ''}`, x: label - 12, y: y + cell / 2 - 4, width: 8, height: 8 }));
          g.append(svgText({ class: `row-label${rowId === on ? ' adj-label-on' : ''}`, x: 0, y: y + cell / 2 + 4 }, fit(nameOf(rowId), label - 16)));
          interact(ctx, g, { label: `${nameOf(rowId)}: select it`, tip: () => shapeTip(shape, row, [['Linked weight', fmt(deg.get(rowId))]]), pick: () => ctx.select(shapeSelection(subject, rowId)) });
          root.append(g);
          order.forEach((colId, c) => {
            const x = label + c * cell;
            const hit = cells.get(`${rowId}\u0000${colId}`);
            const lit = on && (rowId === on || colId === on);
            if (!hit) {
              root.append(svg('rect', { class: `heat-empty${lit ? ' adj-lit' : ''}`, x, y, width: cell - 2, height: cell - 2 }));
              return;
            }
            const cg = svg('g', { class: 'heat-cell' });
            cg.append(svg('rect', { class: `heat heat-${scale.stepOf(hit.weight)}${hit.inferred ? ' adj-inferred' : ''}${lit ? ' adj-on' : ''}`, x, y, width: cell - 2, height: cell - 2 }));
            if (cell >= 22) cg.append(svgText({ class: 'adj-count', x: x + (cell - 2) / 2, y: y + cell / 2 + 3, 'text-anchor': 'middle' }, compact(hit.weight)));
            const kinds = [...hit.kinds].map(shapeKindText).join(', ');
            interact(ctx, cg, {
              label: `${nameOf(rowId)} to ${nameOf(colId)}: ${kinds}, weight ${fmt(hit.weight)}`,
              tip: () => [`${nameOf(rowId)} → ${nameOf(colId)}`, [subject === 'plans' ? 'Link' : 'Kind', kinds + (hit.inferred ? ' (inferred)' : '')], ['Weight', fmt(hit.weight)], ...(hit.count > 1 ? [['Links folded in', fmt(hit.count)]] : [])],
              pick: () => ctx.select(shapeSelection(subject, rowId)),
            });
            root.append(cg);
          });
        });
        panel.chart.replaceChildren(el('div', { class: 'cal-scroll' }, [root]));
        const anyInferred = [...cells.values()].some((c) => c.inferred);
        panel.legend.replaceChildren(
          el('span', { class: 'muted', text: 'weight' }),
          ...Array.from({ length: scale.steps }, (_, i) => [i + 1, scale.text(i + 1, true)])
            .filter(([, text]) => text)
            .map(([i, text]) => legendKey(`heat-swatch heat-${i}`, text)),
          ...(anyInferred ? [legendKey('swatch-adj-inferred', 'inferred')] : [])
        );
        const what = subject === 'plans' ? 'Each row is an item that blocks, relates to, or was found from each column' : 'Each row depends on (imports) each column';
        const folded = folds ? ` More than ${MAX_SHAPE_NODES} had links, so the deepest were folded into their parents${folds > 1 ? ` ${folds} levels` : ''}.` : '';
        const cut = over ? ` Still more than ${MAX_SHAPE_NODES} after folding, so only the most connected are shown.` : '';
        panel.note.textContent = `${what}; a cell is the summed weight of those links. Rows and columns are grouped by parent (the outlined blocks on the diagonal) and ordered so linked ones sit together; the row’s swatch is its ${subject === 'plans' ? 'status' : 'kind'}.${anyInferred ? ' Inferred links are outlined dashed.' : ''}${folded}${cut} Click a row or cell to select ${subject === 'plans' ? 'its item' : 'its artifact'}.`;
        fitH.settle(fullH, drawShape);
      }

      function draw() {
        if (shape) return drawShape();
        const { list, cells, fold } = build();
        if (!cells.size) {
          panel.empty(views.length ? `No interactions in ${views.length === 1 ? 'this session' : 'these sessions'}.` : '');
          return;
        }
        const label = 130;
        const head = 110;
        // Models and tools never act here, so they have a column but no row.
        const rows = list.filter((a) => [...cells.values()].some((c) => c.from === a.key));
        // Cells grow from CELL to fill the slide's height, as far as the width allows.
        const room = fitH.height(0, 0); // 0 outside the explorer
        const byHeight = Math.floor((room - head - 2) / Math.max(1, rows.length));
        const byWidth = Math.floor((Math.max(320, host.clientWidth || 800) - label - 110) / list.length);
        const size = room ? Math.max(CELL, Math.min(Math.round(CELL * FIT_GROW), byHeight, byWidth)) : CELL;
        const fullW = label + list.length * size + 110;
        const fullH = Math.max(head + rows.length * size + 2, room);
        const scale = heatScale(Math.max(...[...cells.values()].map((c) => c.count)));
        const root = svg('svg', { class: 'viz-chart adj-chart', width: fullW, height: fullH, viewBox: `0 0 ${fullW} ${fullH}`, role: 'img', 'aria-label': `Adjacency matrix of ${list.length} actors and ${cells.size} relationships` });
        const sel = selection;
        list.forEach((a, c) => {
          const x = label + c * size + size / 2 + 3;
          root.append(svgText({ class: 'axis-label', transform: `translate(${x} ${head - 6}) rotate(-45)` }, fit(a.label, 130)));
        });
        rows.forEach((row, r) => {
          const y = head + r * size;
          root.append(svgText({ class: 'row-label', x: 0, y: y + size / 2 + 4 }, fit(row.label, label - 4)));
          list.forEach((col, c) => {
            const x = label + c * size;
            const cell = cells.get(`${row.key}|${col.key}`);
            if (!cell) {
              root.append(svg('rect', { class: 'heat-empty', x, y, width: size - 2, height: size - 2 }));
              return;
            }
            const [best] = [...cell.turns].sort((p, q) => q[1] - p[1]);
            const [sessionId, turnId] = best[0].split('\n');
            const on = !!sel && !!sel.turnId && [...cell.turns.keys()].some((k) => k.endsWith(`\n${sel.turnId}`) && (!sel.sessionId || k.startsWith(`${sel.sessionId}\n`)));
            const g = svg('g', { class: 'heat-cell' });
            g.append(svg('rect', { class: `heat heat-${scale.stepOf(cell.count)}${cell.inferred ? ' adj-inferred' : ''}${on ? ' adj-on' : ''}`, x, y, width: size - 2, height: size - 2 }));
            g.append(svgText({ class: 'adj-count', x: x + (size - 2) / 2, y: y + size / 2 + 3, 'text-anchor': 'middle' }, compact(cell.count)));
            interact(ctx, g, {
              label: `${row.label} to ${col.label}: ${cell.type}, ${fmt(cell.count)}`,
              tip: () => [`${row.label} → ${col.label}`, cell.type, ['Times', fmt(cell.count)], ['Turns', fmt(cell.turns.size)], ...(cell.failed ? [['Failed', fmt(cell.failed)]] : [])],
              pick: () => ctx.select(turnId ? { sessionId, turnId } : { sessionId }),
            });
            root.append(g);
          });
        });
        panel.chart.replaceChildren(el('div', { class: 'cal-scroll' }, [root]));
        panel.legend.replaceChildren(
          el('span', { class: 'muted', text: 'times' }),
          ...Array.from({ length: scale.steps }, (_, i) => [i + 1, scale.text(i + 1, true)])
            .filter(([, text]) => text)
            .map(([i, text]) => legendKey(`heat-swatch heat-${i}`, text)),
          legendKey('swatch-adj-inferred', 'inferred')
        );
        panel.note.textContent = `Each row acts on each column; models and tools only receive, so they have no row. Delegation is inferred from agent ids and order, so it’s outlined dashed and counts each subagent once per turn.${fold ? ` More than ${MAX_SUBAGENTS} subagents, so they’re folded into one.` : ''} ${sel && sel.turnId ? 'Outlined cells happened in the selected turn. ' : ''}Click a cell to select the turn with the most of it.`;
        fitH.settle(fullH, draw);
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
