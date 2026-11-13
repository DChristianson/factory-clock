// File grid: every file of the loaded code as a cell, a row of cells per package, laid along a
// Hilbert curve in path order so a module's files sit together and a new file moves only the
// cells after it (docs/workspace-explorer.md, "File grid"). A cell's square has area by lines; a
// source file's fill is its fan-in (weighted imports from other files); tests and docs have hues
// of their own. Reads options.workspace.code directly (the kit's codeGrid and hilbertBands, shared
// with Plan over code). Clicking a file or a package's name announces { artifactId }.
(function () {
  const FILE_LIMIT = 4000; // past this many files, cells are modules
  const MAX_CELL = 22;
  const MIN_SQUARE = 0.3; // the smallest file's square, as a share of the cell's side
  const FALLBACK_HEIGHT = 520;
  window.factoryClock.register({
    id: 'file-grid',
    title: 'File grid',
    tags: { subject: ['code'], category: ['quantitative'], purpose: ['informative'], level: ['project'], dimension: ['quantity', 'structure', 'place'], language: ['standard'] },
    mount(host, ctx) {
      const { svg, svgText, fmt, fit, el, vizPanel, interact, legendKey, heatScale, codeGrid, hilbertBands, fitter, shapeKindText } = ctx;
      const panel = vizPanel(host, []);
      const fitH = fitter(host);
      let workspace = null;
      let selection = null;

      function draw() {
        const graphs = (workspace && workspace.code) || [];
        if (!graphs.length) {
          panel.empty('No code loaded. Pick a code graph below (Sessions and project ↓).');
          return;
        }
        const grid = codeGrid(graphs, { fileLimit: FILE_LIMIT });
        if (!grid.cells.size) {
          panel.empty('The loaded code has no files to draw.');
          return;
        }
        const width = Math.max(240, host.clientWidth || 800);
        const maxHeight = fitH.height(FALLBACK_HEIGHT, 200);
        const layout = hilbertBands(grid.groups, { width, maxHeight, maxCell: MAX_CELL });
        const c = layout.cell;
        const items = [...grid.cells.values()];
        const maxLines = Math.max(1, ...items.map((i) => i.lines));
        const maxIn = Math.max(0, ...items.filter((i) => i.role === 'source').map((i) => i.fanIn));
        const heat = heatScale(Math.max(1, maxIn));
        const sel = selection && selection.artifactId ? selection.artifactId : null;
        const lit = new Set(sel ? grid.under.get(sel) || [] : []);
        const height = Math.ceil(layout.height) + 2;
        const root = svg('svg', { class: 'viz-chart filegrid-chart', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `File grid: ${grid.cells.size} ${grid.fold === 'module' ? 'modules' : 'files'} in ${layout.bands.length} packages` });
        const unit = grid.fold === 'module' ? 'module' : 'file';
        for (const band of layout.bands) {
          const g = band.group;
          const label = svgText({ class: `filegrid-pkg${g.artifactId && g.artifactId === sel ? ' filegrid-pkg-on' : ''}`, x: 0, y: band.y + 10 }, fit(`${g.label} · ${g.items.length}`, width));
          if (g.artifactId) {
            interact(ctx, label, {
              label: `Package ${g.label}`,
              tip: () => [g.label, ['Files', fmt(g.items.reduce((n, i) => n + i.count, 0))], ['Lines', fmt(g.items.reduce((n, i) => n + i.lines, 0))]],
              pick: () => ctx.select({ artifactId: g.artifactId }),
            });
          }
          root.append(label);
          // Modules alternate a faint ground, so where one ends and the next begins shows.
          let modIndex = -1;
          let lastMod;
          for (const cell of band.cells) {
            const it = cell.item;
            if (it.module !== lastMod) {
              modIndex++;
              lastMod = it.module;
            }
            const grp = svg('g', { class: 'filegrid-cell' });
            grp.append(svg('rect', { class: `filegrid-bg filegrid-mod-${modIndex % 2}`, x: cell.x, y: cell.y, width: c, height: c }));
            const side = Math.max(1, (c - 1) * Math.max(MIN_SQUARE, Math.sqrt(it.lines / maxLines)));
            const off = (c - side) / 2;
            const fill = it.role === 'source' ? (it.fanIn > 0 ? `heat heat-${heat.stepOf(it.fanIn)}` : 'filegrid-zero') : it.role === 'test' ? 'shape-k-1' : it.role === 'doc' ? 'shape-k-2' : 'filegrid-other';
            grp.append(svg('rect', { class: `filegrid-file ${fill}`, x: cell.x + off, y: cell.y + off, width: side, height: side }));
            if (lit.has(it.id)) grp.append(svg('rect', { class: 'filegrid-on', x: cell.x + 0.75, y: cell.y + 0.75, width: Math.max(0.5, c - 1.5), height: Math.max(0.5, c - 1.5) }));
            interact(ctx, grp, {
              label: `${it.path}: ${fmt(it.lines)} lines, fan-in ${fmt(it.fanIn)}`,
              tip: () => [
                it.path,
                ['Kind', shapeKindText(it.role) + (grid.fold === 'module' ? ` (${it.count} files)` : '')],
                ['Lines', fmt(it.lines)],
                ['Fan-in', fmt(it.fanIn) + (it.inferredIn ? ` (≈ ${fmt(it.inferredIn)} inferred)` : '')],
                ['Fan-out', fmt(it.fanOut)],
                ['Package', g.label],
              ],
              pick: () => ctx.select({ artifactId: it.id }),
            });
            root.append(grp);
          }
        }
        panel.chart.replaceChildren(el('div', { class: 'filegrid-scroll' }, [root]));
        const heatKeys = [];
        for (let i = 1; i <= heat.steps; i++) {
          const t = heat.text(i, true);
          if (t) heatKeys.push(el('span', { class: 'key' }, [el('span', { class: `swatch heat-swatch heat-${i}` }), t]));
        }
        const roles = new Set(items.map((i) => i.role));
        panel.legend.replaceChildren(
          el('span', { class: 'muted', text: 'Fan-in:' }),
          legendKey('filegrid-zero', '0'),
          ...heatKeys,
          ...(roles.has('test') ? [legendKey('shape-k-1', 'test')] : []),
          ...(roles.has('doc') ? [legendKey('shape-k-2', 'doc')] : []),
          ...([...roles].some((r) => !['source', 'test', 'doc'].includes(r)) ? [legendKey('filegrid-other', 'config, asset, generated')] : [])
        );
        const inferred = items.reduce((n, i) => n + i.inferredIn, 0);
        panel.note.textContent =
          `${fmt(grid.cells.size)} ${unit}s in ${layout.bands.length} packages, a row each; within a row, ${unit}s follow a Hilbert curve in path order, so a module's files sit together and a new file moves only the cells after it. ` +
          `A square's area is its lines (the smallest drawn at ${Math.round(MIN_SQUARE * 100)}% of the cell's side); a source file's shade is its fan-in, the weighted imports from other files. ` +
          (inferred ? `Fan-in includes ${fmt(inferred)} inferred imports (≈ in the tip). ` : '') +
          (grid.fold === 'module' ? `With more than ${fmt(FILE_LIMIT)} files (${fmt(grid.files)}), cells are modules. ` : '') +
          'Click a file or a package name to select it.';
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
