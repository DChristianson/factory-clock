// Confidence map: how much of a plan was read and how much guessed. A row per
// source document and epic (a markdown plan's items name their document before
// the '#'; anything else is its plan's root), and two columns: items the
// adapter read (observed) and items it guessed (inferred), one square per item
// colored by status. A markdown plan shows its seams: the checkboxes it read
// beside the steps and tables it inferred. Ids are qualified root::id.
// Clicking a square, or an epic's name, announces { itemId }. See
// docs/workspace-explorer.md, "Views for the new subjects". Sees only its host and ctx.
(function () {
  const MAX_ROWS = 60; // rows drawn; the rest fold, and the note says how many
  const MAX_LINES = 6; // lines of squares in one cell; past this the cell is a bar that counts them
  const SQUARE = 10;
  const GAP = 2;
  const HEAD = 20;
  const DOC_ROW = 20;
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
      for (const it of g.items) items.push({ id: q(it.id), item: it, root: g.source.root, adapter: g.source.adapter, parent: it.parent ? q(it.parent) : undefined });
      for (const l of g.links) links.push({ ...l, root: g.source.root });
    }
    return { graphs, items, links };
  }

  /** Documents in source order, each with its epics (an item's topmost ancestor), each with its items. */
  function documentsOf(graphs, items) {
    const byId = new Map(items.map((n) => [n.id, n]));
    const top = (n) => {
      const seen = new Set();
      let at = n;
      while (at.parent && byId.has(at.parent) && !seen.has(at.parent)) {
        seen.add(at.id);
        at = byId.get(at.parent);
      }
      return at;
    };
    const hasKids = new Set(items.filter((n) => n.parent && byId.has(n.parent)).map((n) => n.parent));
    const docs = new Map();
    for (const n of items) {
      // A markdown item's document is the part of its topmost ancestor's id before the '#'; anything else is its plan's.
      const t = top(n);
      const doc = n.adapter === 'markdown' ? t.item.id.split('#')[0] : '';
      const key = `${n.root}\u0000${doc}`;
      if (!docs.has(key)) docs.set(key, { root: n.root, doc, adapter: n.adapter, epics: new Map() });
      const epicKey = hasKids.has(t.id) ? t.id : '';
      const epics = docs.get(key).epics;
      if (!epics.has(epicKey)) epics.set(epicKey, { head: epicKey ? t : null, items: [] });
      epics.get(epicKey).items.push(n);
    }
    // Loose items last in each document.
    for (const d of docs.values()) {
      const loose = d.epics.get('');
      if (loose) {
        d.epics.delete('');
        d.epics.set('', loose);
      }
    }
    return [...docs.values()];
  }

  window.factoryClock.register({
    id: 'confidence-map',
    title: 'Confidence map',
    tags: { subject: ['plans'], category: ['state'], purpose: ['informative'], level: ['project'], dimension: ['status'], language: ['standard'] },
    mount(host, ctx) {
      const { svg, svgText, fit, clip, fmt, vizPanel, interact, legendKey, shapeSelected } = ctx;
      const panel = vizPanel(host, []);
      let selection = null;
      let data = { graphs: [], items: [], links: [] };

      function draw() {
        const { graphs, items, links } = data;
        if (!graphs.length) return panel.empty('No plan is loaded. Load a plan (a beads export or planning markdown) to see how much of it was read and how much guessed.');
        if (!items.length) return panel.empty('The loaded plan has no items.');
        const docs = documentsOf(graphs, items);
        const many = graphs.length > 1;

        const width = Math.max(320, host.clientWidth || 800);
        const labelW = Math.min(220, Math.round(width * 0.28));
        const statW = 64;
        const cellW = Math.max(40, (width - labelW - statW - 16) / 2);
        const per = Math.max(1, Math.floor((cellW - 4) / (SQUARE + GAP)));
        const colX = [labelW + 8, labelW + 8 + cellW + 8];

        // Rows: a heading per document (when there's more than one, or it has a name), then a row per epic.
        const rows = [];
        const named = docs.length > 1 || docs.some((d) => d.doc);
        for (const d of docs) {
          if (named) rows.push({ doc: d });
          for (const e of d.epics.values()) {
            const obs = e.items.filter((n) => n.item.confidence !== 'inferred').sort((a, b) => STATUS_ORDER.indexOf(a.item.status) - STATUS_ORDER.indexOf(b.item.status));
            const inf = e.items.filter((n) => n.item.confidence === 'inferred').sort((a, b) => STATUS_ORDER.indexOf(a.item.status) - STATUS_ORDER.indexOf(b.item.status));
            const lines = (k) => (k > per * MAX_LINES ? 1 : Math.ceil(k / per));
            rows.push({ doc: d, epic: e, obs, inf, h: Math.max(1, lines(obs.length), lines(inf.length)) * (SQUARE + GAP) + 10 });
          }
        }
        const shown = rows.slice(0, MAX_ROWS);
        const folded = rows.filter((r) => r.epic).length - shown.filter((r) => r.epic).length;
        const height = HEAD + shown.reduce((a, r) => a + (r.epic ? r.h : DOC_ROW), 0) + 4;
        const nObs = items.filter((n) => n.item.confidence !== 'inferred').length;
        const root = svg('svg', { class: 'viz-chart conf-chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Confidence map: ${fmt(nObs)} of ${fmt(items.length)} plan items read, ${fmt(items.length - nObs)} inferred, over ${docs.length} source${docs.length === 1 ? '' : 's'}` });
        root.append(svgText({ class: 'axis-label', x: colX[0], y: 13 }, `read (observed): ${fmt(nObs)}`));
        root.append(svgText({ class: 'axis-label', x: colX[1], y: 13 }, `guessed (inferred): ${fmt(items.length - nObs)}`));
        root.append(svgText({ class: 'axis-label', x: width - 4, y: 13, 'text-anchor': 'end' }, 'read'));
        root.append(svg('line', { class: 'grid', x1: colX[1] - 4, x2: colX[1] - 4, y1: HEAD - 2, y2: height - 2 }));

        let aggregated = 0;
        let y = HEAD;
        const square = (n, x, yy) => {
          const it = n.item;
          const on = shapeSelected(selection, n.id);
          const sq = svg('rect', { class: `conf-square shape-st-${it.status}${it.confidence === 'inferred' ? ' shape-inferred' : ''}${on ? ' shape-on' : ''}`, x, y: yy, width: SQUARE, height: SQUARE, rx: 2 });
          interact(ctx, sq, {
            label: `${it.title}: ${it.confidence}, ${STATUS_TEXT[it.status]}`,
            tip: () => [clip(it.title || n.id, 120), ['Confidence', it.confidence === 'inferred' ? 'inferred (guessed)' : 'observed (read)'], ['Status', STATUS_TEXT[it.status]], ['Kind', it.kind], ['Id', n.id]],
            pick: () => ctx.select({ itemId: n.id }),
          });
          root.append(sq);
        };
        const cell = (list, x, top, name) => {
          if (list.length > per * MAX_LINES) {
            // Too many to square: a bar per status that counts them.
            aggregated++;
            let at = x;
            for (const s of STATUS_ORDER) {
              const k = list.filter((n) => n.item.status === s).length;
              if (!k) continue;
              const w = (k / list.length) * (cellW - 8);
              const seg = svg('rect', { class: `conf-square shape-st-${s}${list[0].item.confidence === 'inferred' ? ' shape-inferred' : ''}`, x: at, y: top, width: Math.max(1, w - 1), height: SQUARE });
              interact(ctx, seg, { tip: () => [clip(name, 80), [STATUS_TEXT[s], `${fmt(k)} item${k === 1 ? '' : 's'}`]] });
              root.append(seg);
              at += w;
            }
            return;
          }
          list.forEach((n, i) => square(n, x + (i % per) * (SQUARE + GAP), top + Math.floor(i / per) * (SQUARE + GAP)));
        };
        for (const r of shown) {
          if (!r.epic) {
            const d = r.doc;
            const title = d.doc ? `${many ? `${d.root} · ` : ''}${d.doc}` : `${d.root}${d.adapter ? ` (${d.adapter})` : ''}`;
            root.append(svg('rect', { class: 'conf-band', x: 0, y, width, height: DOC_ROW }));
            root.append(svgText({ class: 'row-label conf-doc', x: 4, y: y + 14 }, fit(title, width - 8)));
            y += DOC_ROW;
            continue;
          }
          const e = r.epic;
          const name = e.head ? e.head.item.title || e.head.id : 'No epic';
          const label = svgText({ class: `row-label${e.head && shapeSelected(selection, e.head.id) ? ' conf-on' : ''}`, x: named ? 14 : 4, y: y + 14 }, fit(name, labelW - (named ? 14 : 4)));
          const total = r.obs.length + r.inf.length;
          if (e.head) {
            const h = e.head;
            interact(ctx, label, {
              label: `${name}: ${r.obs.length} of ${total} read`,
              tip: () => [clip(name, 120), ['Read', fmt(r.obs.length)], ['Guessed', fmt(r.inf.length)], ['Epic itself', h.item.confidence], ['Id', h.id]],
              pick: () => ctx.select({ itemId: h.id }),
            });
          }
          root.append(label);
          cell(r.obs, colX[0], y + 5, name);
          cell(r.inf, colX[1], y + 5, name);
          root.append(svgText({ class: 'axis-label', x: width - 4, y: y + 14, 'text-anchor': 'end' }, `${Math.round((r.obs.length / total) * 100)}%`));
          root.append(svg('line', { class: 'grid', x1: 0, x2: width, y1: y + r.h, y2: y + r.h }));
          y += r.h;
        }
        panel.chart.replaceChildren(root);

        const used = new Set(items.map((n) => n.item.status));
        const keys = STATUS_ORDER.filter((s) => used.has(s)).map((s) => legendKey(`shape-st-${s}`, STATUS_TEXT[s]));
        if (nObs < items.length) keys.push(legendKey('swatch-shape-inferred', 'inferred'));
        panel.legend.replaceChildren(...keys);

        const inferredLinks = links.filter((l) => l.inferred).length;
        const parts = [`Each square is an item, colored by status, in the column for how its adapter knew it: read from the source (observed) or guessed by a heuristic (inferred).`];
        if (nObs === items.length) parts.push(`Every item in ${many ? 'the loaded plans' : 'the loaded plan'} was read${graphs.every((g) => g.source.adapter !== 'markdown') ? ', as a tracker’s items are' : ''}: nothing here was guessed.`);
        else if (nObs === 0) parts.push('Every item was guessed: none was read from a checkbox or a tracker.');
        else {
          const seams = rows.filter((r) => r.epic && r.obs.length && r.inf.length).length;
          parts.push(`${Math.round((nObs / items.length) * 100)}% of the items were read. ${seams ? `${seams} row${seams === 1 ? ' is' : 's are'} split between the columns: the plan’s seams, where it was part read and part guessed.` : 'No row mixes the two: each document or epic was either read or guessed whole.'}`);
        }
        parts.push(links.length ? `${fmt(inferredLinks)} of ${fmt(links.length)} links were inferred.` : 'The plan has no links.');
        if (aggregated) parts.push(`${aggregated} cell${aggregated === 1 ? ' has' : 's have'} too many items to square and show${aggregated === 1 ? 's' : ''} a bar per status.`);
        if (folded) parts.push(`${fmt(folded)} rows folded past ${MAX_ROWS}.`);
        parts.push('Click a square or an epic’s name to select it.');
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
