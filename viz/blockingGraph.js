// Blocking graph: what's blocked on what, and what unblocks the most. Every
// loaded plan's `blocks` links as a DAG read left to right: an item's column is
// how many blockers deep it sits (the longest chain of blockers before it). The
// critical path, the longest chain of unfinished work (open, in progress, or
// blocked), is lit; inferred links and guessed items are dashed. Items in no
// blocks link are folded into a compact row of status squares below, not
// scattered through the graph. Ids are qualified root::id, as the workspace's
// joins are. Clicking an item announces { itemId }. See
// docs/workspace-explorer.md, "Views for the new subjects". Sees only its host and ctx.
(function () {
  const MAX_NODES = 150; // items drawn in the graph; past this, settled items fold out first
  const MAX_LOOSE = 300; // squares in the row of items with no blocks links
  const MIN_COL = 130; // px per column before the drawing grows wider than the slide
  const ROW = 30; // px per item in a column, the least; rows stretch to fill the slide up to ROW_MAX
  const ROW_MAX = 60;
  const BOX_H = 22;
  const SQUARE = 10;
  const UNFINISHED = new Set(['open', 'in_progress', 'blocked']);
  const STATUS_ORDER = ['open', 'in_progress', 'blocked', 'done', 'deferred', 'dropped'];
  const STATUS_TEXT = { open: 'open', in_progress: 'in progress', blocked: 'blocked', done: 'done', deferred: 'deferred', dropped: 'dropped' };

  /** Every loaded plan's items and links, ids qualified root::id. */
  function readPlans(options) {
    const ws = options && options.workspace;
    const graphs = (ws && ws.plans) || [];
    const items = [];
    const links = [];
    for (const g of graphs) {
      const q = (id) => `${g.source.root}::${id}`;
      for (const it of g.items) items.push({ id: q(it.id), item: it, root: g.source.root, parent: it.parent ? q(it.parent) : undefined });
      for (const l of g.links) links.push({ ...l, from: q(l.from), to: q(l.to) });
    }
    return { graphs, items, links };
  }

  window.factoryClock.register({
    id: 'blocking-graph',
    title: 'Blocking graph',
    tags: { subject: ['plans'], category: ['dependency', 'state'], purpose: ['informative'], level: ['project'], dimension: ['dependency', 'status'], language: ['standard'] },
    mount(host, ctx) {
      const { svg, svgText, fit, clip, fmt, vizPanel, interact, legendKey, shapeSelected } = ctx;
      const panel = vizPanel(host, []);
      const fitH = ctx.fitter(host); // the graph fills the slide's height
      let selection = null;
      let data = { graphs: [], items: [], links: [] };

      function draw() {
        const { graphs, items, links } = data;
        if (!graphs.length) return panel.empty('No plan is loaded. Load a plan (a beads export or planning markdown) to see what blocks what.');
        if (!items.length) return panel.empty('The loaded plan has no items.');
        const byId = new Map(items.map((n) => [n.id, n]));
        const blocks = links.filter((l) => l.kind === 'blocks' && l.from !== l.to && byId.has(l.from) && byId.has(l.to));
        const inGraph = new Set(blocks.flatMap((l) => [l.from, l.to]));
        let nodes = items.filter((n) => inGraph.has(n.id));
        const loose = items.filter((n) => !inGraph.has(n.id));

        // Fold: past MAX_NODES keep unfinished items first, then the rest in source order.
        let folded = 0;
        if (nodes.length > MAX_NODES) {
          const ranked = [...nodes].sort((a, b) => (UNFINISHED.has(b.item.status) ? 1 : 0) - (UNFINISHED.has(a.item.status) ? 1 : 0));
          const keep = new Set(ranked.slice(0, MAX_NODES).map((n) => n.id));
          folded = nodes.length - keep.size;
          nodes = nodes.filter((n) => keep.has(n.id));
        }
        const kept = new Set(nodes.map((n) => n.id));
        const edges = blocks.filter((l) => kept.has(l.from) && kept.has(l.to));
        const preds = new Map(nodes.map((n) => [n.id, []]));
        const succs = new Map(nodes.map((n) => [n.id, []]));
        for (const e of edges) {
          preds.get(e.to).push(e.from);
          succs.get(e.from).push(e.to);
        }

        // Layers by longest path from the unblocked (Kahn's order); items in a cycle take one past their placed blockers.
        const layer = new Map();
        const indeg = new Map(nodes.map((n) => [n.id, preds.get(n.id).length]));
        const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
        const topo = [];
        while (queue.length) {
          const id = queue.shift();
          topo.push(id);
          layer.set(id, Math.max(0, ...preds.get(id).map((p) => (layer.has(p) ? layer.get(p) + 1 : 0))));
          for (const s of succs.get(id)) {
            indeg.set(s, indeg.get(s) - 1);
            if (indeg.get(s) === 0) queue.push(s);
          }
        }
        const cyclic = nodes.filter((n) => !layer.has(n.id)).map((n) => n.id);
        for (const id of cyclic) layer.set(id, Math.max(0, ...preds.get(id).filter((p) => layer.has(p)).map((p) => layer.get(p) + 1)));

        // Critical path: the longest chain of unfinished items over blocks links (acyclic part only).
        const open = (id) => UNFINISHED.has(byId.get(id).item.status);
        const chain = new Map(); // id -> { len, prev }
        for (const id of topo) {
          if (!open(id)) continue;
          let best = { len: 1, prev: null };
          for (const p of preds.get(id)) if (chain.has(p) && chain.get(p).len + 1 > best.len) best = { len: chain.get(p).len + 1, prev: p };
          chain.set(id, best);
        }
        let end = null;
        for (const [id, c] of chain) if (!end || c.len > chain.get(end).len) end = id;
        const critical = new Set();
        if (end && chain.get(end).len >= 2) for (let id = end; id; id = chain.get(id).prev) critical.add(id);
        const critEdge = (e) => critical.has(e.from) && critical.has(e.to) && chain.get(e.to).prev === e.from;

        // What each item unblocks: unfinished items downstream of it, transitively.
        const unblocks = new Map();
        const downstream = (id) => {
          const seen = new Set();
          const stack = [...succs.get(id)];
          while (stack.length) {
            const s = stack.pop();
            if (seen.has(s) || s === id) continue;
            seen.add(s);
            stack.push(...succs.get(s));
          }
          return [...seen].filter(open).length;
        };
        for (const n of nodes) unblocks.set(n.id, downstream(n.id));
        let most = null;
        for (const n of nodes) if (open(n.id) && unblocks.get(n.id) > 0 && (!most || unblocks.get(n.id) > unblocks.get(most.id))) most = n;

        // Order within a column: source order, then two barycenter sweeps to untangle the links.
        const layers = [];
        for (const n of nodes) {
          const l = layer.get(n.id);
          (layers[l] = layers[l] || []).push(n.id);
        }
        for (let i = 0; i < layers.length; i++) layers[i] = layers[i] || [];
        const pos = new Map();
        const index = () => layers.forEach((col) => col.forEach((id, i) => pos.set(id, i)));
        index();
        const sweep = (neighbors, from, to, step) => {
          for (let l = from; l !== to; l += step) {
            const bary = (id) => {
              const ns = neighbors.get(id).filter((x) => pos.has(x));
              return ns.length ? ns.reduce((a, x) => a + pos.get(x), 0) / ns.length : pos.get(id);
            };
            layers[l].sort((a, b) => bary(a) - bary(b));
            index();
          }
        };
        if (edges.length) {
          sweep(preds, 1, layers.length, 1);
          sweep(succs, layers.length - 2, -1, -1);
        }

        const width = Math.max(320, host.clientWidth || 800);
        const pad = 8;
        const cols = Math.max(1, layers.length);
        const colW = Math.max(MIN_COL, (width - 2 * pad) / cols);
        const boxW = colW - 26;
        const drawW = Math.max(width, cols * colW + 2 * pad);
        const tallest = Math.max(0, ...layers.map((c) => c.length));

        // The folded row: items in no blocks link, as squares in status order.
        const looseShown = [...loose].sort((a, b) => STATUS_ORDER.indexOf(a.item.status) - STATUS_ORDER.indexOf(b.item.status)).slice(0, MAX_LOOSE);
        const perLine = Math.max(1, Math.floor((drawW - 2 * pad) / (SQUARE + 3)));
        const looseH = loose.length ? 22 + Math.ceil(looseShown.length / perLine) * (SQUARE + 3) + 4 : 0;
        // The slide's height in drawing units (a drawing wider than the slide is scaled down to its width).
        const room = Math.round((fitH.height(0, 0) * drawW) / width);
        const row = tallest ? Math.max(ROW, Math.min(ROW_MAX, Math.floor((room - looseH - 6 - 22) / tallest))) : ROW;
        const graphH = nodes.length ? tallest * row + 22 : 0;
        const height = Math.max(60, graphH + looseH + 6, room);

        const root = svg('svg', { class: 'viz-chart blk-chart', viewBox: `0 0 ${drawW} ${height}`, role: 'img', 'aria-label': `Blocking graph: ${nodes.length} items in ${edges.length} blocks links over ${cols} columns, ${critical.size ? `a critical path of ${critical.size}` : 'no chain of unfinished work'}, and ${loose.length} items in no blocks link` });
        const at = (id) => {
          const l = layer.get(id);
          const col = layers[l];
          const off = ((tallest - col.length) * row) / 2;
          return { x: pad + l * colW, y: 18 + off + pos.get(id) * row };
        };
        if (nodes.length) {
          for (let l = 0; l < cols; l++) root.append(svgText({ class: 'axis-label', x: pad + l * colW, y: 11 }, l === 0 ? 'no blockers' : `${l} deep`));
          // Links first, critical ones last so they sit on top.
          for (const e of [...edges].sort((a, b) => (critEdge(a) ? 1 : 0) - (critEdge(b) ? 1 : 0))) {
            const a = at(e.from);
            const b = at(e.to);
            const x1 = a.x + boxW;
            const y1 = a.y + BOX_H / 2;
            const x2 = b.x;
            const y2 = b.y + BOX_H / 2;
            const back = x2 <= x1; // a cycle's link runs backward
            const dx = back ? 40 : (x2 - x1) / 2;
            const d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
            root.append(svg('path', { class: `blk-edge${critEdge(e) ? ' blk-crit' : ''}${e.inferred ? ' shape-inferred' : ''}`, d }));
          }
          for (const n of nodes) {
            const { x, y } = at(n.id);
            const it = n.item;
            const on = shapeSelected(selection, n.id);
            const g = svg('g', { class: `blk-node${critical.has(n.id) ? ' blk-crit' : ''}${open(n.id) ? '' : ' blk-settled'}` });
            g.append(svg('rect', { class: `blk-box${it.confidence === 'inferred' ? ' shape-inferred' : ''}${on ? ' shape-on' : ''}`, x, y, width: boxW, height: BOX_H, rx: 3 }));
            g.append(svg('rect', { class: `shape-st-${it.status}`, x: x + 1, y: y + 1, width: 5, height: BOX_H - 2, rx: 1 }));
            g.append(svgText({ class: 'blk-label', x: x + 10, y: y + 15 }, fit(it.title || n.id, boxW + 4)));
            const un = unblocks.get(n.id);
            interact(ctx, g, {
              label: `${it.title}: ${STATUS_TEXT[it.status]}${un ? `, unblocks ${un}` : ''}`,
              tip: () => [
                clip(it.title || n.id, 120),
                ['Status', STATUS_TEXT[it.status] + (it.confidence === 'inferred' ? ' (inferred)' : '')],
                ['Blocked by', fmt(preds.get(n.id).length)],
                ['Blocks', fmt(succs.get(n.id).length)],
                ['Unblocks, in all', `${fmt(un)} unfinished`],
                ...(critical.has(n.id) ? [['On the critical path', `${critical.size} items`]] : []),
                ['Id', n.id],
              ],
              pick: () => ctx.select({ itemId: n.id }),
            });
            root.append(g);
          }
        }
        if (loose.length) {
          const top = graphH + 4;
          root.append(svgText({ class: 'axis-label', x: pad, y: top + 12 }, `In no blocks link: ${fmt(loose.length)} item${loose.length === 1 ? '' : 's'}, by status${looseShown.length < loose.length ? ` (first ${fmt(looseShown.length)})` : ''}`));
          looseShown.forEach((n, i) => {
            const it = n.item;
            const on = shapeSelected(selection, n.id);
            const sq = svg('rect', { class: `blk-square shape-st-${it.status}${it.confidence === 'inferred' ? ' shape-inferred' : ''}${on ? ' shape-on' : ''}`, x: pad + (i % perLine) * (SQUARE + 3), y: top + 20 + Math.floor(i / perLine) * (SQUARE + 3), width: SQUARE, height: SQUARE, rx: 2 });
            interact(ctx, sq, {
              label: `${it.title}: ${STATUS_TEXT[it.status]}`,
              tip: () => [clip(it.title || n.id, 120), ['Status', STATUS_TEXT[it.status] + (it.confidence === 'inferred' ? ' (inferred)' : '')], ['Kind', it.kind], ['Id', n.id]],
              pick: () => ctx.select({ itemId: n.id }),
            });
            root.append(sq);
          });
        }
        panel.chart.replaceChildren(root);

        const used = new Set(items.map((n) => n.item.status));
        const keys = STATUS_ORDER.filter((s) => used.has(s)).map((s) => legendKey(`shape-st-${s}`, STATUS_TEXT[s]));
        if (critical.size) keys.push(legendKey('blk-crit-key', 'critical path'));
        if (edges.some((e) => e.inferred) || items.some((n) => n.item.confidence === 'inferred')) keys.push(legendKey('swatch-shape-inferred', 'inferred'));
        panel.legend.replaceChildren(...keys);

        const plural = (n, word) => `${fmt(n)} ${word}${n === 1 ? '' : 's'}`;
        const parts = [];
        if (!blocks.length) parts.push(`No item in ${graphs.length === 1 ? 'the loaded plan' : `the ${graphs.length} loaded plans`} blocks another, so there is no graph to draw: every item is in the row of squares.`);
        else {
          parts.push(`Left blocks right: an item's column is how many blockers deep it sits.`);
          parts.push(critical.size ? `Lit: the critical path, the longest chain of unfinished work (${plural(critical.size, 'item')}).` : 'No two unfinished items block each other, so there is no critical path to light.');
          if (most) parts.push(`Finishing “${clip(most.item.title, 60)}” unblocks the most: ${plural(unblocks.get(most.id), 'unfinished item')}.`);
          if (cyclic.length) parts.push(`${plural(cyclic.length, 'item')} sit in a cycle of blocks links, placed one past their other blockers.`);
          if (folded) parts.push(`${plural(folded, 'settled item')} folded out past ${MAX_NODES} in the graph.`);
          if (edges.some((e) => e.inferred)) parts.push('Dashed links were inferred from the text, not read.');
        }
        if (loose.length > looseShown.length) parts.push(`The row shows the first ${MAX_LOOSE} of ${fmt(loose.length)}.`);
        parts.push('Click an item to select it.');
        panel.note.textContent = parts.join(' ');
        fitH.settle(Math.round((height * width) / drawW), draw);
      }

      return {
        update(sessions, sel, options) {
          selection = sel || null;
          data = readPlans(options);
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
