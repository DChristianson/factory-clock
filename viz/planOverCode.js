// Plan over code: the file grid (the kit's codeGrid and hilbertBands, as viz/fileGrid.js lays it
// out) with each plan item as a pin on the files it references, through the workspace's plan→code
// join (docs/workspace-explorer.md, "Plan over code"). A pin's hue is the item's status; an item
// that names a module or a package is pinned once, at the middle of that region's cells; an
// inferred join or a guessed item is drawn dashed. Items that reference no code on the grid are
// listed in a margin. Clicking a pin or a margin row announces { itemId }; a file, { artifactId }.
(function () {
  const FILE_LIMIT = 4000; // past this many files, cells are modules (as the file grid)
  const MAX_CELL = 22;
  const MIN_SQUARE = 0.3;
  const PINS_PER_CELL = 4; // more pins on one cell fold into a +N marker
  const MARGIN_ROWS = 24; // unreferenced items listed before "+N more"
  const MARGIN_WIDTH = 220;
  const FALLBACK_HEIGHT = 520;
  window.factoryClock.register({
    id: 'plan-over-code',
    title: 'Plan over code',
    tags: { subject: ['workspace'], category: ['dependency', 'state'], purpose: ['informative'], level: ['project'], dimension: ['place', 'status', 'structure'], language: ['standard'] },
    mount(host, ctx) {
      const { svg, svgText, fmt, fit, clip, el, vizPanel, interact, legendKey, codeGrid, hilbertBands, fitter, shapeKindText } = ctx;
      const panel = vizPanel(host, []);
      const fitH = fitter(host);
      let workspace = null;
      let selection = null;

      function draw() {
        const ws = workspace;
        const hasCode = !!(ws && ws.code && ws.code.length);
        const hasPlans = !!(ws && ws.plans && ws.plans.length);
        if (!hasCode || !hasPlans) {
          panel.empty(
            !hasCode && !hasPlans
              ? 'Plan over code needs code and a plan loaded; neither is (Sessions and project ↓).'
              : !hasPlans
                ? 'Plan over code needs a plan too: only code is loaded. Pick a plan below (Sessions and project ↓).'
                : 'Plan over code needs code too: only plans are loaded. Pick a code graph below (Sessions and project ↓).'
          );
          return;
        }
        const grid = codeGrid(ws.code, { fileLimit: FILE_LIMIT });
        if (!grid.cells.size) {
          panel.empty('The loaded code has no files to pin the plan on.');
          return;
        }
        // Items, qualified as the join's ids are.
        const items = ws.plans.flatMap((p) => p.items.map((it) => ({ ...it, qid: `${p.source.root}::${it.id}`, plan: p.source.root })));
        const byItem = new Map(items.map((i) => [i.qid, i]));
        const joins = (ws.joins && ws.joins.planToCode) || [];
        const width = Math.max(240, host.clientWidth || 800);
        const side = width >= 640; // the margin beside the grid, or below it when narrow
        const gridWidth = side ? width - MARGIN_WIDTH - 16 : width;
        const maxHeight = fitH.height(FALLBACK_HEIGHT, 200);
        const layout = hilbertBands(grid.groups, { width: gridWidth, maxHeight, maxCell: MAX_CELL });
        const c = layout.cell;
        const at = new Map();
        for (const band of layout.bands) for (const cell of band.cells) at.set(cell.item.id, cell);
        // Where each join lands: one cell (a file, or the cell nearest the middle of a region).
        const anchor = (cellIds) => {
          const pts = cellIds.map((id) => at.get(id)).filter(Boolean);
          if (!pts.length) return null;
          if (pts.length === 1) return pts[0];
          const mx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
          const my = pts.reduce((a, p) => a + p.y, 0) / pts.length;
          return pts.reduce((b, p) => ((p.x - mx) ** 2 + (p.y - my) ** 2 < (b.x - mx) ** 2 + (b.y - my) ** 2 ? p : b));
        };
        const pinsAt = new Map(); // cell id -> [{ item, inferred, region }]
        const named = new Map(); // item qid -> Set(cell ids it names)
        for (const j of joins) {
          const item = byItem.get(j.from);
          if (!item) continue;
          const cells = grid.under.get(j.to) || [];
          const a = anchor(cells);
          if (!a) continue;
          if (!named.has(item.qid)) named.set(item.qid, new Set());
          for (const id of cells) named.get(item.qid).add(id);
          const list = pinsAt.get(a.item.id) || [];
          const prev = list.find((p) => p.item === item);
          if (prev) prev.inferred = prev.inferred && j.inferred;
          else list.push({ item, inferred: !!j.inferred, region: cells.length > 1 });
          pinsAt.set(a.item.id, list);
        }
        const unpinned = items.filter((i) => !named.has(i.qid));
        const selItem = selection && selection.itemId ? selection.itemId : null;
        const selArt = selection && selection.artifactId ? selection.artifactId : null;
        const lit = new Set([...(selItem && named.has(selItem) ? named.get(selItem) : []), ...(selArt ? grid.under.get(selArt) || [] : [])]);
        const namedCells = new Set([...named.values()].flatMap((s) => [...s]));
        const maxLines = Math.max(1, ...[...grid.cells.values()].map((i) => i.lines));

        const marginRows = Math.min(unpinned.length, MARGIN_ROWS) + (unpinned.length > MARGIN_ROWS ? 1 : 0);
        const marginH = unpinned.length ? 18 + marginRows * 16 : 0;
        const gridH = Math.ceil(layout.height) + 4;
        const height = Math.max(side ? Math.max(gridH, marginH) : gridH + (marginH ? marginH + 10 : 0), ctx.fitHeight(host) !== null ? maxHeight : 0); // in a slide, its whole height even when cells hit MAX_CELL
        const root = svg('svg', { class: 'viz-chart pog-chart', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Plan over code: ${named.size} of ${items.length} plan items pinned on ${grid.cells.size} files` });
        const pinLayer = svg('g', { class: 'pog-pins' });
        for (const band of layout.bands) {
          const g = band.group;
          const label = svgText({ class: 'pog-pkg', x: 0, y: band.y + 10 }, fit(g.label, gridWidth));
          if (g.artifactId) interact(ctx, label, { label: `Package ${g.label}`, tip: () => [g.label, ['Files', fmt(g.items.reduce((n, i) => n + i.count, 0))]], pick: () => ctx.select({ artifactId: g.artifactId }) });
          root.append(label);
          for (const cell of band.cells) {
            const it = cell.item;
            const grp = svg('g', { class: 'pog-cell' });
            grp.append(svg('rect', { class: 'pog-bg', x: cell.x, y: cell.y, width: c, height: c }));
            const s = Math.max(1, (c - 1) * Math.max(MIN_SQUARE, Math.sqrt(it.lines / maxLines)));
            grp.append(svg('rect', { class: `pog-file${namedCells.has(it.id) ? ' pog-file-named' : ''}`, x: cell.x + (c - s) / 2, y: cell.y + (c - s) / 2, width: s, height: s }));
            if (lit.has(it.id)) grp.append(svg('rect', { class: 'pog-on', x: cell.x + 0.75, y: cell.y + 0.75, width: Math.max(0.5, c - 1.5), height: Math.max(0.5, c - 1.5) }));
            const names = [...named].filter(([, set]) => set.has(it.id)).map(([q]) => byItem.get(q));
            interact(ctx, grp, {
              label: `${it.path}${names.length ? `: named by ${names.length} plan items` : ''}`,
              tip: () => [it.path, ['Kind', shapeKindText(it.role)], ['Lines', fmt(it.lines)], ['Plan items', fmt(names.length)], ...names.slice(0, 6).map((n) => clip(`${n.id} ${n.title}`, 70))],
              pick: () => ctx.select({ artifactId: it.id }),
            });
            root.append(grp);
            // Pins: a small fan in the cell's upper half, past PINS_PER_CELL a count.
            const pins = pinsAt.get(it.id);
            if (!pins) continue;
            const r = Math.max(3, Math.min(6, c * 0.3));
            const shown = pins.length > PINS_PER_CELL ? pins.slice(0, PINS_PER_CELL - 1) : pins;
            const step = Math.min(r * 1.4, c / Math.max(1, shown.length));
            shown.forEach((p, k) => {
              const cx = cell.x + c / 2 + (k - (shown.length - 1) / 2) * step;
              const cy = cell.y + Math.min(c / 2, r + 1);
              const on = selItem === p.item.qid;
              const dashed = p.inferred || p.item.confidence === 'inferred';
              const pin = svg('circle', { class: `pog-pin shape-st-${p.item.status}${dashed ? ' pog-pin-inferred' : ''}${p.region ? ' pog-pin-region' : ''}${on ? ' pog-pin-on' : ''}`, cx, cy, r: on ? r + 1.5 : r });
              interact(ctx, pin, {
                label: `${p.item.title || p.item.id}, ${shapeKindText(p.item.status)}`,
                tip: () => [
                  clip(p.item.title || p.item.id, 80),
                  ['Item', `${p.item.id} (${p.item.kind})`],
                  ['Status', shapeKindText(p.item.status)],
                  ['Names', `${p.region ? 'a region around ' : ''}${it.path}`],
                  ...(dashed ? [['Link', p.inferred ? 'inferred (≈)' : 'item guessed (≈)']] : []),
                ],
                pick: () => ctx.select({ itemId: p.item.qid }),
              });
              pinLayer.append(pin);
            });
            if (shown.length < pins.length) {
              const more = pins.length - shown.length;
              const cx = cell.x + c / 2 + (shown.length - (shown.length - 1) / 2) * step;
              const cy = cell.y + Math.min(c / 2, r + 1);
              const g2 = svg('g', { class: 'pog-more' });
              g2.append(svg('circle', { class: 'pog-more-dot', cx, cy, r }));
              g2.append(svgText({ class: 'pog-more-text', x: cx, y: cy + 3, 'text-anchor': 'middle' }, `+${more}`));
              const rest = pins.slice(shown.length);
              interact(ctx, g2, {
                label: `${more} more plan items`,
                tip: () => [`${more} more on ${it.path}`, ...rest.slice(0, 8).map((p) => clip(`${p.item.id} ${p.item.title}`, 70))],
                pick: () => ctx.select({ itemId: rest[0].item.qid }),
              });
              pinLayer.append(g2);
            }
          }
        }
        root.append(pinLayer);

        // The margin: items that name no code on the grid.
        if (unpinned.length) {
          const mx = side ? gridWidth + 16 : 0;
          const my = side ? 0 : gridH + 10;
          const mw = side ? MARGIN_WIDTH : width;
          root.append(svg('line', { class: 'pog-rule', x1: mx - 8, y1: my, x2: side ? mx - 8 : width, y2: side ? height : my }));
          root.append(svgText({ class: 'pog-margin-head', x: mx, y: my + 11 }, fit(`No code named · ${unpinned.length}`, mw)));
          unpinned.slice(0, MARGIN_ROWS).forEach((item, k) => {
            const y = my + 18 + k * 16;
            const on = selItem === item.qid;
            const row = svg('g', { class: `pog-row${on ? ' pog-row-on' : ''}` });
            row.append(svg('rect', { class: 'pog-row-hit', x: mx, y, width: mw, height: 15 }));
            row.append(svg('circle', { class: `pog-pin shape-st-${item.status}${item.confidence === 'inferred' ? ' pog-pin-inferred' : ''}`, cx: mx + 5, cy: y + 7.5, r: 4 }));
            row.append(svgText({ class: 'pog-row-text', x: mx + 14, y: y + 11 }, fit(`${item.id} ${item.title}`, mw - 14)));
            interact(ctx, row, {
              label: `${item.title || item.id}, ${shapeKindText(item.status)}, names no code`,
              tip: () => [clip(item.title || item.id, 80), ['Item', `${item.id} (${item.kind})`], ['Status', shapeKindText(item.status)], ['Code', 'none named, or none on the grid']],
              pick: () => ctx.select({ itemId: item.qid }),
            });
            root.append(row);
          });
          if (unpinned.length > MARGIN_ROWS) root.append(svgText({ class: 'pog-row-text muted', x: mx + 14, y: my + 18 + MARGIN_ROWS * 16 + 11 }, `+${unpinned.length - MARGIN_ROWS} more`));
        }
        panel.chart.replaceChildren(el('div', { class: 'filegrid-scroll' }, [root]));

        const statuses = [...new Set(items.map((i) => i.status))];
        const order = ['open', 'in_progress', 'blocked', 'done', 'deferred', 'dropped'];
        statuses.sort((a, b) => order.indexOf(a) - order.indexOf(b));
        const anyInferred = joins.some((j) => j.inferred && byItem.has(j.from)) || items.some((i) => i.confidence === 'inferred');
        panel.legend.replaceChildren(
          ...statuses.map((s) => legendKey(`pog-swatch-pin shape-st-${s}`, shapeKindText(s))),
          ...(anyInferred ? [legendKey('pog-swatch-pin pog-swatch-inferred', 'inferred (≈)')] : []),
          legendKey('pog-file pog-file-named', 'named by a plan item'),
          legendKey('pog-file', 'not named')
        );
        const pinnedCount = named.size;
        panel.note.textContent = items.length
          ? `${fmt(pinnedCount)} of ${fmt(items.length)} plan items pinned on the files they name, on the file grid (packages in rows, files along a Hilbert curve, area by lines). ` +
            'An item that names a module or package is pinned once, at the middle of its cells, with a ring. Pin hue is status; a dashed pin is an inferred link or a guessed item. ' +
            (unpinned.length ? `${fmt(unpinned.length)} name no code on the grid and are listed ${side ? 'beside it' : 'below it'}. ` : '') +
            (grid.fold === 'module' ? `With more than ${fmt(FILE_LIMIT)} files, cells are modules. ` : '') +
            'Click a pin or an item to select it, or a file.'
          : `The loaded plan has no items, so there is nothing to pin: this is the bare file grid of ${fmt(grid.cells.size)} files.`;
        fitH.settle(height, draw);
      }

      return {
        update(sessions, sel, options) {
          selection = sel || null;
          workspace = (options && options.workspace) || null;
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
