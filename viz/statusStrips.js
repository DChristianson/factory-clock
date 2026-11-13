// Status strips: where the work stands. A strip per epic of every loaded plan
// (and one for each plan's items under no epic), its items as blocks in status
// order, done first, so the strip reads like a progress bar; behind the blocks
// the strip fills to its done fraction (done of everything not dropped). The
// session strips' idea, over plans. Guessed items are outlined dashed. Ids are
// qualified root::id. Clicking a block, or an epic's name, announces
// { itemId }. See docs/workspace-explorer.md, "Views for the new subjects".
// Sees only its host and ctx.
(function () {
  const MAX_STRIPS = 40; // strips drawn; the rest fold, and the note says how many
  const MIN_BLOCK = 3; // px; narrower, a strip draws a segment per status instead of a block per item
  const ROW = 34;
  const STRIP_H = 20;
  const AXIS = 16;
  // Done first, so the blocks fill the strip as the work does; then what's moving, stuck, waiting, set aside.
  const BLOCK_ORDER = ['done', 'in_progress', 'blocked', 'open', 'deferred', 'dropped'];
  const STATUS_ORDER = ['open', 'in_progress', 'blocked', 'done', 'deferred', 'dropped'];
  const STATUS_TEXT = { open: 'open', in_progress: 'in progress', blocked: 'blocked', done: 'done', deferred: 'deferred', dropped: 'dropped' };

  /** Every loaded plan's items, ids qualified root::id. */
  function readPlans(options) {
    const ws = options && options.workspace;
    const graphs = (ws && ws.plans) || [];
    const items = [];
    for (const g of graphs) {
      const q = (id) => `${g.source.root}::${id}`;
      for (const it of g.items) items.push({ id: q(it.id), item: it, root: g.source.root, parent: it.parent ? q(it.parent) : undefined });
    }
    return { graphs, items };
  }

  /** Epics (top-level items with items under them) in source order, each with every item under it; then each plan's loose items. */
  function groupsOf(graphs, items) {
    const byId = new Map(items.map((n) => [n.id, n]));
    const kids = new Map();
    for (const n of items) if (n.parent && byId.has(n.parent)) (kids.get(n.parent) || kids.set(n.parent, []).get(n.parent)).push(n);
    const groups = [];
    for (const g of graphs) {
      const loose = [];
      for (const n of items) {
        if (n.root !== g.source.root || (n.parent && byId.has(n.parent))) continue;
        if (!(kids.get(n.id) || []).length) {
          loose.push(n);
          continue;
        }
        const members = [];
        const seen = new Set([n.id]);
        const walk = (p) => {
          for (const c of kids.get(p) || []) {
            if (seen.has(c.id)) continue;
            seen.add(c.id);
            members.push(c);
            walk(c.id);
          }
        };
        walk(n.id);
        groups.push({ head: n, root: g.source.root, members });
      }
      if (loose.length) groups.push({ head: null, root: g.source.root, members: loose });
    }
    return groups;
  }

  window.factoryClock.register({
    id: 'status-strips',
    title: 'Status strips',
    tags: { subject: ['plans'], category: ['state', 'quantitative'], purpose: ['expressive', 'informative'], level: ['project'], dimension: ['status', 'quantity'], language: ['standard'] },
    mount(host, ctx) {
      const { svg, svgText, fit, clip, fmt, vizPanel, interact, legendKey, shapeSelected } = ctx;
      const panel = vizPanel(host, []);
      let selection = null;
      let data = { graphs: [], items: [] };

      const doneShare = (list) => {
        const counted = list.filter((n) => n.item.status !== 'dropped');
        const done = counted.filter((n) => n.item.status === 'done').length;
        return { done, counted: counted.length, dropped: list.length - counted.length, frac: counted.length ? done / counted.length : 0 };
      };

      function draw() {
        const { graphs, items } = data;
        if (!graphs.length) return panel.empty('No plan is loaded. Load a plan (a beads export or planning markdown) to see where its work stands.');
        if (!items.length) return panel.empty('The loaded plan has no items.');
        const many = graphs.length > 1;
        const groups = groupsOf(graphs, items);
        const shown = groups.slice(0, MAX_STRIPS);
        const folded = groups.length - shown.length;

        const width = Math.max(320, host.clientWidth || 800);
        const labelW = Math.min(240, Math.round(width * 0.3));
        const x0 = labelW + 8;
        const statW = 74; // the "5/7 · 71%" at the end
        const stripW = Math.max(60, width - x0 - statW - 8);
        const height = AXIS + shown.length * ROW + 4;
        const root = svg('svg', { class: 'viz-chart pstrip-chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Status strips: ${shown.length} epics of ${fmt(items.length)} plan items` });
        for (const f of [0, 0.5, 1]) {
          root.append(svg('line', { class: 'grid', x1: x0 + f * stripW, x2: x0 + f * stripW, y1: AXIS - 2, y2: height - 4 }));
          root.append(svgText({ class: 'axis-label', x: x0 + f * stripW, y: 11, 'text-anchor': f === 0 ? 'start' : f === 1 ? 'end' : 'middle' }, `${f * 100}% done`));
        }

        let aggregated = 0;
        shown.forEach((grp, i) => {
          const top = AXIS + i * ROW + (ROW - STRIP_H) / 2;
          const list = [...grp.members].sort((a, b) => BLOCK_ORDER.indexOf(a.item.status) - BLOCK_ORDER.indexOf(b.item.status));
          const share = doneShare(list);
          const name = grp.head ? grp.head.item.title || grp.head.id : 'No epic';
          const label = `${many ? `${grp.root} · ` : ''}${name}`;

          // The epic's name selects the epic.
          const head = svgText({ class: `row-label${grp.head && shapeSelected(selection, grp.head.id) ? ' pstrip-on' : ''}`, x: 4, y: top + 14 }, fit(label, labelW));
          if (grp.head) {
            const e = grp.head;
            interact(ctx, head, {
              label: `${name}: ${share.done} of ${share.counted} done`,
              tip: () => [clip(name, 120), ['Epic status', STATUS_TEXT[e.item.status] + (e.item.confidence === 'inferred' ? ' (inferred)' : '')], ['Done', `${fmt(share.done)} of ${fmt(share.counted)}`], ...(share.dropped ? [['Dropped', fmt(share.dropped)]] : []), ['Id', e.id]],
              pick: () => ctx.select({ itemId: e.id }),
            });
          }
          root.append(head);
          root.append(svg('rect', { class: 'pstrip-track', x: x0, y: top, width: stripW, height: STRIP_H, rx: 3 }));
          if (share.frac > 0) root.append(svg('rect', { class: 'pstrip-fill', x: x0, y: top, width: share.frac * stripW, height: STRIP_H, rx: 3 }));

          const bw = stripW / Math.max(1, list.length);
          if (bw >= MIN_BLOCK) {
            list.forEach((n, k) => {
              const it = n.item;
              const on = shapeSelected(selection, n.id);
              const b = svg('rect', { class: `pstrip-block shape-st-${it.status}${it.confidence === 'inferred' ? ' shape-inferred' : ''}${on ? ' shape-on' : ''}`, x: x0 + k * bw + 0.5, y: top + 4, width: Math.max(1, bw - 1), height: STRIP_H - 8, rx: bw > 6 ? 1.5 : 0 });
              interact(ctx, b, {
                label: `${it.title}: ${STATUS_TEXT[it.status]}`,
                tip: () => [clip(it.title || n.id, 120), ['Status', STATUS_TEXT[it.status] + (it.confidence === 'inferred' ? ' (inferred)' : '')], ['Kind', it.kind], ['Epic', clip(name, 60)], ['Id', n.id]],
                pick: () => ctx.select({ itemId: n.id }),
              });
              root.append(b);
            });
          } else {
            // Too many items for a block each: a segment per status, which counts them.
            aggregated++;
            let at = x0;
            for (const s of BLOCK_ORDER) {
              const k = list.filter((n) => n.item.status === s).length;
              if (!k) continue;
              const w = (k / list.length) * stripW;
              const seg = svg('rect', { class: `pstrip-block shape-st-${s}`, x: at, y: top + 4, width: Math.max(1, w - 1), height: STRIP_H - 8 });
              interact(ctx, seg, { tip: () => [clip(name, 80), [STATUS_TEXT[s], `${fmt(k)} item${k === 1 ? '' : 's'}`]] });
              root.append(seg);
              at += w;
            }
          }
          root.append(svgText({ class: 'axis-label', x: width - 6, y: top + 14, 'text-anchor': 'end' }, share.counted ? `${share.done}/${share.counted} · ${Math.round(share.frac * 100)}%` : 'all dropped'));
        });
        panel.chart.replaceChildren(root);

        const used = new Set(items.map((n) => n.item.status));
        const keys = STATUS_ORDER.filter((s) => used.has(s)).map((s) => legendKey(`shape-st-${s}`, STATUS_TEXT[s]));
        keys.push(legendKey('pstrip-fill-key', 'done fraction'));
        if (items.some((n) => n.item.confidence === 'inferred')) keys.push(legendKey('swatch-shape-inferred', 'inferred'));
        panel.legend.replaceChildren(...keys);

        const all = doneShare(items.filter((n) => !groups.some((g) => g.head === n)));
        const complete = groups.filter((g) => g.head && doneShare(g.members).counted && doneShare(g.members).frac === 1).length;
        const parts = [`A strip per epic, its items as blocks, done first; the strip fills to its done fraction, done of everything not dropped.`];
        parts.push(`Across ${many ? `${graphs.length} plans` : 'the plan'}, ${fmt(all.done)} of ${fmt(all.counted)} items are done (${Math.round(all.frac * 100)}%)${complete ? `, and ${complete} epic${complete === 1 ? ' is' : 's are'} finished` : ''}.`);
        if (!groups.some((g) => g.head)) parts.push('No item has items under it, so there are no epics: one strip holds everything.');
        if (aggregated) parts.push(`${aggregated} strip${aggregated === 1 ? ' has' : 's have'} too many items for a block each and show${aggregated === 1 ? 's' : ''} a segment per status.`);
        if (folded) parts.push(`${folded} strips folded past ${MAX_STRIPS}.`);
        parts.push('Click a block or an epic’s name to select it.');
        panel.note.textContent = parts.join(' ');
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
