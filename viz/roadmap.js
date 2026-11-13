// Roadmap: when each item was opened and closed, under which epic. A Gantt
// chart of every loaded plan, a row per item grouped under its epic (the epic's
// own row carries its span), each bar from created to closed, colored by
// status. Items still open run to the moment the plan was read, marked by the
// dashed rule. A markdown plan's `follows` order (step 3 follows step 2) is a
// chain in the gutter beside the bars, so a plan with no dates still shows its
// order. Items with no dates say so on their row. Ids are qualified root::id.
// Clicking a row announces { itemId }. See docs/workspace-explorer.md, "Views
// for the new subjects". Sees only its host and ctx.
(function () {
  const MAX_ROWS = 160; // rows drawn; the rest fold, and the note says how many
  const ROW = 20;
  const BAR_H = 12;
  const AXIS = 22;
  const CHAIN_W = 18; // the follows gutter, when there are follows links
  const MIN_BAR = 3; // px, so an item opened and closed the same hour still shows
  const DAY = 86_400_000;
  const SETTLED = new Set(['done', 'dropped']);
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

  /** Epics in source order, each with its items depth-first; then each plan's loose items under "No epic". */
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
          loose.push({ node: n, depth: 0 });
          continue;
        }
        const members = [];
        const seen = new Set([n.id]);
        const walk = (p, depth) => {
          for (const c of kids.get(p) || []) {
            if (seen.has(c.id)) continue;
            seen.add(c.id);
            members.push({ node: c, depth });
            walk(c.id, depth + 1);
          }
        };
        walk(n.id, 0);
        groups.push({ head: n, root: g.source.root, members });
      }
      if (loose.length) groups.push({ head: null, root: g.source.root, members: loose });
    }
    return groups;
  }

  const time = (s) => (s ? Date.parse(s) : NaN);

  window.factoryClock.register({
    id: 'roadmap',
    title: 'Roadmap',
    tags: { subject: ['plans'], category: ['temporal', 'state'], purpose: ['informative'], level: ['project'], dimension: ['time', 'status', 'structure'], language: ['standard'] },
    mount(host, ctx) {
      const { svg, svgText, fit, clip, fmt, vizPanel, interact, legendKey, shapeSelected } = ctx;
      const panel = vizPanel(host, []);
      let selection = null;
      let data = { graphs: [], items: [], links: [] };

      function draw() {
        const { graphs, items, links } = data;
        if (!graphs.length) return panel.empty('No plan is loaded. Load a plan (a beads export or planning markdown) to see it over time.');
        if (!items.length) return panel.empty('The loaded plan has no items.');
        const many = graphs.length > 1;
        const groups = groupsOf(graphs, items);

        // Rows: a head row per group, then its members.
        const rows = [];
        for (const g of groups) {
          rows.push({ head: true, group: g, node: g.head, depth: 0 });
          for (const m of g.members) rows.push({ head: false, group: g, node: m.node, depth: m.depth + (g.head ? 1 : 0) });
        }
        const shown = rows.slice(0, MAX_ROWS);
        const folded = rows.length - shown.length;
        const rowOf = new Map();
        shown.forEach((r, i) => r.node && rowOf.set(r.node.id, i));

        // The time span: the earliest date to when the plan was read.
        const stamps = items.flatMap((n) => [time(n.item.created), time(n.item.closed)]).filter((t) => !Number.isNaN(t));
        const read = Math.max(...graphs.map((g) => time(g.source.generatedAt)).filter((t) => !Number.isNaN(t)), ...stamps);
        const asOf = Number.isFinite(read) ? read : Date.now();
        const dated = stamps.length > 0;
        const lo = dated ? Math.min(...stamps) : asOf - DAY;
        const hi = Math.max(asOf, lo + DAY);

        const follows = links.filter((l) => l.kind === 'follows' && rowOf.has(l.from) && rowOf.has(l.to));
        const width = Math.max(320, host.clientWidth || 800);
        const labelW = Math.min(260, Math.round(width * 0.32));
        const chainW = follows.length ? CHAIN_W : 0;
        const x0 = labelW + chainW + 6;
        const x1 = width - 12;
        const x = (t) => x0 + ((t - lo) / (hi - lo)) * (x1 - x0);
        const height = AXIS + shown.length * ROW + 6;
        const y = (i) => AXIS + i * ROW;

        const root = svg('svg', { class: 'viz-chart rmap-chart', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Roadmap of ${fmt(items.length)} plan items under ${groups.length} groups${dated ? `, from ${new Date(lo).toDateString()} to ${new Date(hi).toDateString()}` : ', with no dates'}` });

        // Axis: day ticks at a step that leaves room for labels.
        if (dated) {
          const days = (hi - lo) / DAY;
          const step = [1, 2, 7, 14, 30, 61, 91, 182, 365].find((s) => days / s <= Math.max(2, Math.floor((x1 - x0) / 70))) || 730;
          const first = new Date(lo);
          first.setUTCHours(0, 0, 0, 0);
          for (let t = first.getTime() + DAY; t <= hi; t += step * DAY) {
            if (t < lo) continue;
            root.append(svg('line', { class: 'grid', x1: x(t), x2: x(t), y1: AXIS - 4, y2: height - 4 }));
            root.append(svgText({ class: 'axis-label', x: x(t), y: 12, 'text-anchor': 'middle' }, new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })));
          }
          root.append(svg('line', { class: 'rmap-asof', x1: x(asOf), x2: x(asOf), y1: AXIS - 6, y2: height - 4 }));
        } else {
          root.append(svgText({ class: 'axis-label', x: x0, y: 12 }, 'No item has dates'));
        }

        let undated = 0;
        shown.forEach((r, i) => {
          const top = y(i);
          if (r.head) root.append(svg('rect', { class: 'rmap-band', x: 0, y: top, width, height: ROW }));
          if (!r.node) {
            root.append(svgText({ class: 'row-label rmap-head', x: 4, y: top + 14 }, fit(`${many ? `${r.group.root} · ` : ''}No epic`, labelW)));
            return;
          }
          const n = r.node;
          const it = n.item;
          const on = shapeSelected(selection, n.id);
          const g = svg('g', { class: 'rmap-row' });
          g.append(svg('rect', { class: 'hit', x: 0, y: top, width, height: ROW }));
          const indent = 4 + r.depth * 10;
          g.append(svgText({ class: `row-label${r.head ? ' rmap-head' : ''}`, x: indent, y: top + 14 }, fit(`${r.head && many ? `${n.root} · ` : ''}${it.title || it.id}`, labelW - indent)));

          // The span: an epic with no dates of its own takes its items'.
          let from = time(it.created);
          let to = SETTLED.has(it.status) ? time(it.closed) : asOf;
          if (r.head && Number.isNaN(from)) {
            const ts = r.group.members.flatMap((m) => [time(m.node.item.created), time(m.node.item.closed)]).filter((t) => !Number.isNaN(t));
            if (ts.length) {
              from = Math.min(...ts);
              to = SETTLED.has(it.status) ? Math.max(...ts) : asOf;
            }
          }
          if (Number.isNaN(to) && !Number.isNaN(time(it.closed))) to = time(it.closed);
          const cls = `shape-st-${it.status}${it.confidence === 'inferred' ? ' shape-inferred' : ''}${on ? ' shape-on' : ''}`;
          let when;
          if (!Number.isNaN(from) && !Number.isNaN(to)) {
            g.append(svg('rect', { class: `rmap-bar ${cls}`, x: x(from), y: top + (ROW - BAR_H) / 2, width: Math.max(MIN_BAR, x(to) - x(from)), height: BAR_H, rx: 2 }));
            when = SETTLED.has(it.status) ? `${new Date(from).toDateString()} to ${new Date(to).toDateString()}` : `opened ${new Date(from).toDateString()}, still ${STATUS_TEXT[it.status]}`;
          } else if (!Number.isNaN(from) || !Number.isNaN(to)) {
            // One end known: a dot where it is.
            const t = Number.isNaN(from) ? to : from;
            g.append(svg('circle', { class: `rmap-dot ${cls}`, cx: x(t), cy: top + ROW / 2, r: 4 }));
            when = Number.isNaN(from) ? `closed ${new Date(t).toDateString()}, opening not recorded` : `opened ${new Date(t).toDateString()}, closing not recorded`;
          } else {
            undated++;
            if (dated || !r.head) g.append(svgText({ class: 'axis-label', x: x0 + 2, y: top + 14 }, dated ? 'no dates' : ''));
            when = 'no dates';
          }
          interact(ctx, g, {
            label: `${it.title}: ${STATUS_TEXT[it.status]}, ${when}`,
            tip: () => [clip(it.title || n.id, 120), ['Status', STATUS_TEXT[it.status] + (it.confidence === 'inferred' ? ' (inferred)' : '')], ['When', when], ['Kind', it.kind], ['Id', n.id]],
            pick: () => ctx.select({ itemId: n.id }),
          });
          root.append(g);
        });

        // The follows chain, in its gutter: a link from each item to the one it follows.
        const cx = labelW + chainW / 2;
        for (const l of follows) {
          const ya = y(rowOf.get(l.to)) + ROW / 2;
          const yb = y(rowOf.get(l.from)) + ROW / 2;
          const bend = Math.min(chainW / 2 - 2, 3 + Math.abs(yb - ya) / ROW);
          root.append(svg('path', { class: `rmap-follows${l.inferred ? ' shape-inferred' : ''}`, d: `M${cx},${ya} C${cx + bend},${ya} ${cx + bend},${yb} ${cx},${yb}` }));
        }
        for (const id of new Set(follows.flatMap((l) => [l.from, l.to]))) root.append(svg('circle', { class: 'rmap-step', cx, cy: y(rowOf.get(id)) + ROW / 2, r: 2.5 }));

        panel.chart.replaceChildren(root);
        const used = new Set(items.map((n) => n.item.status));
        const keys = STATUS_ORDER.filter((s) => used.has(s)).map((s) => legendKey(`shape-st-${s}`, STATUS_TEXT[s]));
        if (dated) keys.push(legendKey('rmap-asof-key', 'when the plan was read'));
        if (follows.length) keys.push(legendKey('rmap-follows-key', 'follows (list order)'));
        if (items.some((n) => n.item.confidence === 'inferred') || follows.some((l) => l.inferred)) keys.push(legendKey('swatch-shape-inferred', 'inferred'));
        panel.legend.replaceChildren(...keys);

        const parts = [];
        parts.push(dated ? `Each bar runs from when the item was opened to when it was closed; unfinished items run to the dashed rule, when the plan was read (${new Date(asOf).toDateString()}).` : 'No item in the loaded plan has a date (planning markdown carries none), so the rows show the plan’s order and nothing over time.');
        if (dated && undated) parts.push(`${fmt(undated)} item${undated === 1 ? ' has' : 's have'} no dates and say${undated === 1 ? 's' : ''} so on the row.`);
        if (follows.length) parts.push(`The chain beside the bars is the order of the plan’s numbered steps, which isn’t always a dependency.`);
        else if (links.some((l) => l.kind === 'follows')) parts.push('Its follows order joins rows folded out of view.');
        if (folded) parts.push(`${fmt(folded)} rows folded past ${MAX_ROWS}.`);
        parts.push('Click a row to select its item.');
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
