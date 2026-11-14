// Burn-up: how fast work is closing against how fast it's opened. Two
// cumulative step lines over every loaded plan: items created (the scope) and
// items closed, with the gap between them, the work still open, shaded. Epics
// and milestones are containers and aren't counted, so nothing counts twice.
// A dot per item where it joined each line; clicking one announces { itemId }.
// With no timestamps (planning markdown has none) it says so instead. Ids are
// qualified root::id. See docs/workspace-explorer.md, "Views for the new
// subjects". Sees only its host and ctx.
(function () {
  const MAX_DOTS = 400; // dots per line; past this the lines are drawn without them
  const CONTAINERS = new Set(['epic', 'milestone']);
  const SETTLED = new Set(['done', 'dropped']);
  const DAY = 86_400_000;

  /** Every loaded plan's items, ids qualified root::id. */
  function readPlans(options) {
    const ws = options && options.workspace;
    const graphs = (ws && ws.plans) || [];
    const items = [];
    for (const g of graphs) for (const it of g.items) items.push({ id: `${g.source.root}::${it.id}`, item: it, root: g.source.root });
    return { graphs, items };
  }
  const time = (s) => (s ? Date.parse(s) : NaN);

  window.factoryClock.register({
    id: 'burn-up',
    title: 'Burn-up',
    tags: { subject: ['plans'], category: ['quantitative', 'temporal'], purpose: ['informative'], level: ['project'], dimension: ['quantity', 'time'], language: ['standard'] },
    mount(host, ctx) {
      const { svg, svgText, clip, fmt, niceAxis, vizPanel, interact, legendKey, shapeSelected } = ctx;
      const panel = vizPanel(host, []);
      const fitH = ctx.fitter(host); // the plot fills the slide's height
      let selection = null;
      let data = { graphs: [], items: [] };

      function draw() {
        const { graphs, items } = data;
        if (!graphs.length) return panel.empty('No plan is loaded. Load a plan (a beads export) to see work opened against work closed.');
        const work = items.filter((n) => !CONTAINERS.has(n.item.kind));
        if (!work.length) return panel.empty(items.length ? 'The loaded plan has only epics and milestones, and a burn-up counts the items under them.' : 'The loaded plan has no items.');
        const opened = work.filter((n) => !Number.isNaN(time(n.item.created))).map((n) => ({ n, t: time(n.item.created) })).sort((a, b) => a.t - b.t);
        if (!opened.length) return panel.empty('No timestamps in the loaded plan: a burn-up needs the dates items were opened and closed. Planning markdown has none; a beads export has both.');
        const settledNoDate = work.filter((n) => SETTLED.has(n.item.status) && Number.isNaN(time(n.item.closed)));
        const closed = work.filter((n) => SETTLED.has(n.item.status) && !Number.isNaN(time(n.item.closed)) && !Number.isNaN(time(n.item.created))).map((n) => ({ n, t: time(n.item.closed) })).sort((a, b) => a.t - b.t);
        const undated = work.length - opened.length;

        const lo = opened[0].t;
        const read = Math.max(...graphs.map((g) => time(g.source.generatedAt)).filter((t) => !Number.isNaN(t)), opened[opened.length - 1].t, closed.length ? closed[closed.length - 1].t : -Infinity);
        const hi = Math.max(read, lo + DAY);

        const width = Math.max(320, host.clientWidth || 800);
        const m = { l: 40, r: 76, t: 12, b: 24 };
        const height = fitH.height(m.t + 220 + m.b, m.t + 160 + m.b);
        const ph = height - m.t - m.b;
        const axis = niceAxis(opened.length);
        const x = (t) => m.l + ((t - lo) / (hi - lo)) * (width - m.l - m.r);
        const y = (k) => m.t + ph - (k / axis.top) * ph;
        const root = svg('svg', { class: 'viz-chart burn-chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Burn-up: ${opened.length} items opened and ${closed.length} closed between ${new Date(lo).toDateString()} and ${new Date(hi).toDateString()}` });
        for (const t of axis.ticks) {
          root.append(svg('line', { class: 'grid', x1: m.l, x2: width - m.r, y1: y(t), y2: y(t) }));
          root.append(svgText({ class: 'axis-label', x: m.l - 6, y: y(t) + 4, 'text-anchor': 'end' }, fmt(t)));
        }
        const days = (hi - lo) / DAY;
        const step = [1, 2, 7, 14, 30, 61, 91, 182, 365].find((s) => days / s <= Math.max(2, Math.floor((width - m.l - m.r) / 70))) || 730;
        const first = new Date(lo);
        first.setUTCHours(0, 0, 0, 0);
        for (let t = first.getTime() + DAY; t <= hi; t += step * DAY) root.append(svgText({ class: 'axis-label', x: x(t), y: m.t + ph + 16, 'text-anchor': 'middle' }, new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })));

        // Step functions: [t, count] at each change, held to the end.
        const steps = (list) => {
          const pts = [[lo, 0]];
          list.forEach((e, i) => pts.push([e.t, i + 1]));
          pts.push([hi, list.length]);
          return pts;
        };
        const path = (pts) => pts.map(([t, k], i) => (i ? `H${x(t)}V${y(k)}` : `M${x(t)},${y(k)}`)).join('');
        const top = steps(opened);
        const bottom = steps(closed);
        // The gap: along the opened line, back along the closed one.
        const back = [...bottom].reverse().map(([t, k], i) => (i ? `V${y(k)}H${x(t)}` : `L${x(t)},${y(k)}`)).join('');
        root.append(svg('path', { class: 'burn-gap', d: `${path(top)}${back}Z` }));
        root.append(svg('path', { class: 'burn-line burn-opened', d: path(top) }));
        if (closed.length) root.append(svg('path', { class: 'burn-line burn-closed', d: path(bottom) }));

        const dots = (list, cls, what) => {
          if (list.length > MAX_DOTS) return false;
          list.forEach((e, i) => {
            const it = e.n.item;
            const on = shapeSelected(selection, e.n.id);
            const c = svg('circle', { class: `burn-dot ${cls}${it.confidence === 'inferred' ? ' shape-inferred' : ''}${on ? ' shape-on' : ''}`, cx: x(e.t), cy: y(i + 1), r: on ? 4.5 : 3 });
            interact(ctx, c, {
              label: `${it.title}: ${what} ${new Date(e.t).toDateString()}`,
              tip: () => [clip(it.title || e.n.id, 120), [what[0].toUpperCase() + what.slice(1), new Date(e.t).toDateString()], [cls === 'burn-opened' ? 'Opened so far' : 'Closed so far', fmt(i + 1)], ['Status', it.status.replace('_', ' ') + (it.confidence === 'inferred' ? ' (inferred)' : '')], ['Id', e.n.id]],
              pick: () => ctx.select({ itemId: e.n.id }),
            });
            root.append(c);
          });
          return true;
        };
        const dottedOpened = dots(opened, 'burn-opened', 'opened');
        const dotted = dots(closed, 'burn-closed', 'closed') && dottedOpened;

        // End labels: the two totals and the gap.
        const open = opened.length - closed.length;
        root.append(svgText({ class: 'axis-label burn-end', x: width - m.r + 6, y: y(opened.length) + 4 }, `${fmt(opened.length)} opened`));
        root.append(svgText({ class: 'axis-label burn-end', x: width - m.r + 6, y: Math.max(y(closed.length) + 4, y(opened.length) + 16) }, `${fmt(closed.length)} closed`));
        if (open > 0 && y(closed.length) - y(opened.length) > 34) root.append(svgText({ class: 'axis-label', x: width - m.r + 6, y: (y(closed.length) + y(opened.length)) / 2 + 4 }, `${fmt(open)} open`));
        panel.chart.replaceChildren(root);
        panel.legend.replaceChildren(
          legendKey('burn-opened-key', 'opened (scope)'),
          legendKey('burn-closed-key', 'closed (done or dropped)'),
          legendKey('burn-gap-key', 'still open'),
          ...(work.some((n) => n.item.confidence === 'inferred') ? [legendKey('swatch-shape-inferred', 'inferred')] : []),
        );

        const parts = [`Items opened and closed over time, through when the plan was read (${new Date(hi).toDateString()}); the shaded gap is the work still open, ${fmt(open)} item${open === 1 ? '' : 's'} at the end.`];
        parts.push('Epics and milestones aren’t counted, only the work under them.');
        if (!closed.length) parts.push('No item has a close date yet.');
        if (settledNoDate.length) parts.push(`${fmt(settledNoDate.length)} settled item${settledNoDate.length === 1 ? ' has no close date and isn’t' : 's have no close date and aren’t'} counted closed.`);
        if (undated) parts.push(`${fmt(undated)} item${undated === 1 ? ' has' : 's have'} no open date and ${undated === 1 ? 'isn’t' : 'aren’t'} counted.`);
        if (graphs.length > 1) parts.push(`The ${graphs.length} loaded plans are counted together.`);
        parts.push(dotted ? 'Click a dot to select its item.' : `More than ${MAX_DOTS} items: the dots are left out.`);
        panel.note.textContent = parts.join(' ');
        fitH.settle(height, draw);
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
