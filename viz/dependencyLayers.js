// Dependency layers: the code's files (or modules, or packages, as far as options.shape is folded)
// in columns by the longest path to something that depends on nothing (docs/workspace-explorer.md,
// "Dependency layers"). Foundations on the right, what builds on them to the left, so every edge
// runs left to right. The members of a cycle (a strongly connected component, by Tarjan's
// algorithm) share a column and a warning ring; edges between two columns bundle through a shared
// waist. Clicking a node announces { artifactId }.
(function () {
  const MAX_EDGES = 1500; // the heaviest are drawn past this, and the note says so
  const ROW_MAX = 16;
  const ROW_MIN = 3;
  const LABEL_MIN_ROW = 9; // rows thinner than this go unlabeled
  const SWEEPS = 6; // barycenter passes that order each column
  const BUNDLE = 0.75; // how far an edge is pulled toward its bundle's waist
  const FALLBACK_HEIGHT = 520;
  window.factoryClock.register({
    id: 'dependency-layers',
    title: 'Dependency layers',
    tags: { subject: ['code'], category: ['dependency'], purpose: ['informative'], level: ['project'], dimension: ['dependency', 'structure'], language: ['standard'] },
    mount(host, ctx) {
      const { svg, svgText, fmt, fit, el, vizPanel, interact, legendKey, shapeChildren, shapeClass, shapeSelected, shapeSelection, shapeTip, shapeNote, shapeKindText, fitter } = ctx;
      const panel = vizPanel(host, []);
      const fitH = fitter(host);
      let shape = null;
      let selection = null;

      /** Strongly connected components (Tarjan, iterative): comp index per node index. */
      function tarjan(n, out) {
        const index = new Array(n).fill(-1);
        const low = new Array(n).fill(0);
        const onStack = new Array(n).fill(false);
        const comp = new Array(n).fill(-1);
        const stack = [];
        let next = 0;
        let comps = 0;
        for (let s = 0; s < n; s++) {
          if (index[s] >= 0) continue;
          const work = [[s, 0]];
          index[s] = low[s] = next++;
          stack.push(s);
          onStack[s] = true;
          while (work.length) {
            const top = work[work.length - 1];
            const v = top[0];
            if (top[1] < out[v].length) {
              const w = out[v][top[1]++];
              if (index[w] < 0) {
                index[w] = low[w] = next++;
                stack.push(w);
                onStack[w] = true;
                work.push([w, 0]);
              } else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
            } else {
              work.pop();
              if (work.length) {
                const u = work[work.length - 1][0];
                low[u] = Math.min(low[u], low[v]);
              }
              if (low[v] === index[v]) {
                let w;
                do {
                  w = stack.pop();
                  onStack[w] = false;
                  comp[w] = comps;
                } while (w !== v);
                comps++;
              }
            }
          }
        }
        return { comp, count: comps };
      }

      function model() {
        const kids = shapeChildren(shape);
        // The drawn nodes: leaves of the hierarchy that aren't externals.
        const nodes = shape.nodes.filter((n) => !(kids.get(n.id) || []).length && n.kind !== 'external');
        const at = new Map(nodes.map((n, i) => [n.id, i]));
        const pair = new Map();
        let externals = 0;
        const extIds = new Set(shape.nodes.filter((n) => n.kind === 'external').map((n) => n.id));
        for (const l of shape.links) {
          if (extIds.has(l.to)) externals += l.weight;
          const a = at.get(l.from);
          const b = at.get(l.to);
          if (a === undefined || b === undefined || a === b) continue;
          const k = `${a},${b}`;
          const p = pair.get(k);
          if (p) {
            p.weight += l.weight;
            p.inferred = p.inferred && !!l.inferred;
          } else pair.set(k, { a, b, weight: l.weight, inferred: !!l.inferred });
        }
        const edges = [...pair.values()];
        const out = nodes.map(() => []);
        for (const e of edges) out[e.a].push(e.b);
        const { comp, count } = tarjan(nodes.length, out);
        const members = Array.from({ length: count }, () => []);
        comp.forEach((c, i) => members[c].push(i));
        // Longest path to a sink over the condensation; Tarjan numbers a component after all it reaches.
        const layerOfComp = new Array(count).fill(0);
        const compOut = Array.from({ length: count }, () => new Set());
        for (const e of edges) if (comp[e.a] !== comp[e.b]) compOut[comp[e.a]].add(comp[e.b]);
        for (let c = 0; c < count; c++) for (const d of compOut[c]) layerOfComp[c] = Math.max(layerOfComp[c], layerOfComp[d] + 1);
        const layers = Math.max(0, ...layerOfComp) + 1;
        return { nodes, edges, comp, members, layerOfComp, layers, externals, kids };
      }

      function draw() {
        if (!shape) {
          panel.empty('No code loaded. Pick a code graph below (Sessions and project ↓).');
          return;
        }
        const m = model();
        if (!m.nodes.length) {
          panel.empty('The loaded code has no files or modules to place.');
          return;
        }
        const { nodes, edges, comp, members, layerOfComp, layers } = m;
        const parentLabel = new Map(shape.nodes.map((n) => [n.id, n.label]));
        // Columns: layer (layers - 1) on the left, layer 0 on the right.
        const colOfComp = layerOfComp.map((l) => layers - 1 - l);
        const cols = Array.from({ length: layers }, () => []);
        members.forEach((list, c) => {
          list.sort((a, b) => (nodes[a].parent || '').localeCompare(nodes[b].parent || '') || nodes[a].label.localeCompare(nodes[b].label));
          cols[colOfComp[c]].push(c);
        });
        for (const col of cols) col.sort((a, b) => (nodes[members[a][0]].parent || '').localeCompare(nodes[members[b][0]].parent || '') || nodes[members[a][0]].label.localeCompare(nodes[members[b][0]].label));
        // Order components within columns by the mean position of their neighbors.
        const pos = new Array(nodes.length).fill(0);
        const place = () => {
          for (const col of cols) {
            let k = 0;
            for (const c of col) for (const i of members[c]) pos[i] = k++ / Math.max(1, col.reduce((n, x) => n + members[x].length, 0) - 1);
          }
        };
        const nbrs = nodes.map(() => []);
        for (const e of edges) {
          if (comp[e.a] === comp[e.b]) continue;
          nbrs[e.a].push(e.b);
          nbrs[e.b].push(e.a);
        }
        place();
        for (let s = 0; s < SWEEPS; s++) {
          for (const col of cols) {
            const key = new Map(col.map((c) => {
              const ns = members[c].flatMap((i) => nbrs[i]);
              const own = members[c].reduce((a, i) => a + pos[i], 0) / members[c].length;
              return [c, ns.length ? ns.reduce((a, j) => a + pos[j], 0) / ns.length : own];
            }));
            col.sort((a, b) => key.get(a) - key.get(b));
          }
          place();
        }

        const width = Math.max(320, host.clientWidth || 800);
        const counts = cols.map((col) => col.reduce((n, c) => n + members[c].length, 0));
        const most = Math.max(...counts);
        const avail = fitH.height(FALLBACK_HEIGHT, 220) - 24;
        const row = Math.max(ROW_MIN, Math.min(ROW_MAX, avail / most));
        const height = Math.max(Math.ceil(24 + most * row + 4), ctx.fitHeight(host) !== null ? Math.floor(avail + 24) : 0); // in a slide, its whole height even when rows hit ROW_MAX
        const colW = width / layers;
        const gutter = Math.min(80, Math.max(24, colW * 0.3));
        const markW = 6;
        const textW = Math.max(0, colW - gutter - markW - 4);
        const xy = new Array(nodes.length);
        cols.forEach((col, ci) => {
          const x = ci * colW;
          const top = 24 + (most - counts[ci]) * row / 2;
          let k = 0;
          for (const c of col) for (const i of members[c]) xy[i] = { x, y: top + k++ * row + row / 2, ci };
        });
        const sel = selection;
        const selIdx = nodes.findIndex((n) => shapeSelected(sel, n.id));
        const root = svg('svg', { class: 'viz-chart deplayers-chart', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Dependency layers: ${nodes.length} nodes in ${layers} layers, ${edges.length} dependencies` });
        // Column heads.
        cols.forEach((col, ci) => {
          const l = layers - 1 - ci;
          root.append(svgText({ class: 'axis-label', x: ci * colW, y: 12 }, fit(`Layer ${l}`, colW - 4)));
        });
        // Edges, bundled per column pair: each pulled toward the mean height of its bundle's ends.
        const drawn = edges.length > MAX_EDGES ? [...edges].sort((a, b) => b.weight - a.weight).slice(0, MAX_EDGES) : edges;
        const bundles = new Map();
        for (const e of drawn) {
          if (comp[e.a] === comp[e.b]) continue;
          const k = `${xy[e.a].ci},${xy[e.b].ci}`;
          if (!bundles.has(k)) bundles.set(k, []);
          bundles.get(k).push(e);
        }
        const edgeLayer = svg('g', { class: 'deplayers-edges' });
        const maxW = Math.max(1, ...drawn.map((e) => e.weight));
        for (const list of bundles.values()) {
          const waist = list.reduce((a, e) => a + xy[e.a].y + xy[e.b].y, 0) / (2 * list.length);
          for (const e of list) {
            const p = xy[e.a];
            const q = xy[e.b];
            const x0 = p.x + markW + 4 + textW;
            const x1 = q.x - 1;
            const xm1 = x0 + gutter * 0.9;
            const xm2 = x1 - gutter * 0.9;
            const y1 = p.y + (waist - p.y) * BUNDLE;
            const y2 = q.y + (waist - q.y) * BUNDLE;
            const on = selIdx >= 0 && (e.a === selIdx || e.b === selIdx);
            const path = svg('path', {
              class: `shape-link deplayers-edge${e.inferred ? ' shape-inferred' : ''}${on ? ' deplayers-edge-on' : selIdx >= 0 ? ' deplayers-edge-dim' : ''}`,
              d: `M${x0.toFixed(1)} ${p.y.toFixed(1)} C${xm1.toFixed(1)} ${y1.toFixed(1)} ${xm2.toFixed(1)} ${y2.toFixed(1)} ${x1.toFixed(1)} ${q.y.toFixed(1)}`,
              'stroke-width': (0.6 + 2 * Math.sqrt(e.weight / maxW)).toFixed(2),
            });
            edgeLayer.append(path);
          }
        }
        root.append(edgeLayer);
        // Cycles: a ring around each component of two or more, and its inner edges as arcs on the ring's right.
        const cycles = members.filter((list) => list.length > 1);
        for (const list of cycles) {
          const ys = list.map((i) => xy[i].y);
          const x = xy[list[0]].x;
          const top = Math.min(...ys) - row / 2;
          const bottom = Math.max(...ys) + row / 2;
          const ring = svg('rect', { class: 'deplayers-cycle', x: x + 0.5, y: top + 0.5, width: Math.max(4, markW + 4 + textW - 1), height: bottom - top - 1, rx: 3 });
          interact(ctx, ring, { tip: () => [`A cycle of ${list.length}`, ...list.slice(0, 8).map((i) => nodes[i].label)] });
          root.append(ring);
        }
        for (const e of drawn) {
          if (comp[e.a] !== comp[e.b]) continue;
          const p = xy[e.a];
          const q = xy[e.b];
          const xr = p.x + markW + 4 + textW + 2;
          const bulge = Math.min(gutter * 0.6, 6 + Math.abs(q.y - p.y) * 0.3);
          edgeLayer.append(svg('path', { class: `shape-link deplayers-cycle-edge${e.inferred ? ' shape-inferred' : ''}`, d: `M${xr} ${p.y} C${xr + bulge} ${p.y} ${xr + bulge} ${q.y} ${xr} ${q.y}` }));
        }
        // Nodes.
        const ins = nodes.map(() => 0);
        const outs = nodes.map(() => 0);
        for (const e of edges) {
          outs[e.a]++;
          ins[e.b]++;
        }
        nodes.forEach((n, i) => {
          const { x, y } = xy[i];
          const on = i === selIdx;
          const g = svg('g', { class: `deplayers-node${on ? ' deplayers-node-on' : ''}` });
          g.append(svg('rect', { class: 'deplayers-hit', x, y: y - row / 2, width: markW + 4 + textW, height: row }));
          g.append(svg('rect', { class: `${shapeClass(n)}${n.inferred ? ' shape-inferred' : ''}${on ? ' shape-on' : ''}`, x: x + 1, y: y - Math.max(1, row / 2 - 1), width: markW, height: Math.max(2, row - 2) }));
          if (row >= LABEL_MIN_ROW && textW > 20) g.append(svgText({ class: `deplayers-label${row < 11 ? ' deplayers-label-small' : ''}`, x: x + markW + 4, y: y + 3.2 }, fit(n.label, row < 11 ? textW * 1.15 : textW)));
          const size = members[comp[i]].length;
          interact(ctx, g, {
            label: `${n.label}: layer ${layerOfComp[comp[i]]}${size > 1 ? `, in a cycle of ${size}` : ''}`,
            tip: () => shapeTip(shape, n, [
              ['Layer', fmt(layerOfComp[comp[i]])],
              ['Depends on', fmt(outs[i])],
              ['Used by', fmt(ins[i])],
              ...(n.parent ? [['In', parentLabel.get(n.parent) || n.parent]] : []),
              ...(size > 1 ? [['Cycle', `with ${size - 1} other${size > 2 ? 's' : ''}`]] : []),
            ]),
            pick: () => ctx.select(shapeSelection('code', n.id)),
          });
          root.append(g);
        });
        panel.chart.replaceChildren(el('div', { class: 'filegrid-scroll' }, [root]));
        const kinds = new Set(nodes.map((n) => n.kind));
        const anyInferred = edges.some((e) => e.inferred) || nodes.some((n) => n.inferred);
        panel.legend.replaceChildren(
          ...shape.kinds.map((k, i) => [k, i]).filter(([k]) => kinds.has(k)).map(([k, i]) => legendKey(`shape-k-${i}`, shapeKindText(k))),
          ...(cycles.length ? [legendKey('deplayers-swatch-cycle', `cycle (${cycles.length})`)] : []),
          ...(anyInferred ? [legendKey('swatch-shape-inferred', 'inferred')] : [])
        );
        const what = shape.fold === 'package' ? 'packages' : shape.fold === 'module' ? 'modules' : 'files';
        panel.note.textContent =
          `${fmt(nodes.length)} ${what} in ${layers} layer${layers === 1 ? '' : 's'} by the longest chain of dependencies beneath each: layer 0, on the right, depends on nothing drawn; every edge runs left to right, from a dependent to what it depends on. ` +
          (cycles.length ? `${cycles.length} cycle${cycles.length === 1 ? '' : 's'} (ringed): their members depend on each other, so they share a layer. ` : 'No cycles. ') +
          `Edges between the same two layers bundle through a shared waist; width is import weight. ` +
          (drawn.length < edges.length ? `Only the ${fmt(MAX_EDGES)} heaviest of ${fmt(edges.length)} edges are drawn. ` : '') +
          (m.externals ? `${fmt(m.externals)} imports of external packages aren't drawn. ` : '') +
          `${shapeNote(shape)} Click a node to select it.`;
        fitH.settle(height, draw);
      }

      return {
        update(sessions, sel, options) {
          selection = sel || null;
          shape = options && options.subject === 'code' && options.shape ? options.shape : null;
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
