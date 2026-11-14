// Package wheel: which packages import which, as a chord diagram (docs/workspace-explorer.md,
// "Package wheel"). Each package is an arc as long as the imports that cross its border, in and
// out; an inner ring splits it by module; a ribbon joins two packages, as wide as the imports
// between them, in the importing package's hue. External packages share an arc of their own at
// the bottom. Reads options.workspace.code directly, since a Shape is folded for size rather
// than to packages. Clicking an arc announces { artifactId } of the package, module, or external.
(function () {
  const MAX_PACKAGES = 24; // past this, the smallest fold into "other packages"
  const MAX_EXTERNALS = 16; // past this, the smallest fold into "other externals"
  const MIN_SHARE = 0.012; // a package with no crossing imports still gets this share of the circle
  const PAD = 0.025; // radians between arcs
  const EXT_PAD = 0.12; // radians either side of the externals' arc
  const MIN_ANGLE = 0.004;
  const LABEL_ROOM = 96; // pixels outside the wheel for names
  const FALLBACK_HEIGHT = 560;
  window.factoryClock.register({
    id: 'package-wheel',
    title: 'Package wheel',
    tags: { subject: ['code'], category: ['dependency', 'quantitative'], purpose: ['expressive', 'informative'], level: ['project'], dimension: ['dependency', 'quantity'], language: ['standard'] },
    mount(host, ctx) {
      const { svg, svgText, fmt, fit, el, vizPanel, interact, legendKey, arcPath, fitter } = ctx;
      const panel = vizPanel(host, []);
      const fitH = fitter(host);
      let workspace = null;
      let selection = null;

      /** Groups (packages and the externals), their modules, and the flows between groups. */
      function model(graphs) {
        const many = graphs.length > 1;
        const groups = new Map(); // id -> { id, artifactId, label, external, parts: Map(id -> part), out, in, lines }
        const groupOf = new Map(); // qualified artifact id -> [group id, part id]
        const flows = new Map(); // "from\0to" -> weight
        let internal = 0;
        let inferred = 0;
        const observed = new Set(); // flows with at least one import that wasn't inferred
        for (const g of graphs) {
          const root = g.source.root;
          const q = (id) => `${root}::${id}`;
          const byId = new Map(g.artifacts.map((a) => [a.id, a]));
          const up = (a, kind) => {
            const seen = new Set();
            for (let p = a; p && !seen.has(p.id); p = p.parent ? byId.get(p.parent) : undefined) {
              seen.add(p.id);
              if (p.kind === kind) return p;
            }
            return undefined;
          };
          for (const a of g.artifacts) {
            if (a.kind === 'workspace') continue;
            if (a.kind === 'external') {
              if (!groups.has('external')) groups.set('external', { id: 'external', artifactId: null, label: 'external', external: true, parts: new Map(), out: 0, in: 0 });
              const ext = groups.get('external');
              if (!ext.parts.has(a.name)) ext.parts.set(a.name, { id: q(a.id), label: a.name, flow: 0, lines: 0 });
              groupOf.set(q(a.id), ['external', a.name]);
              continue;
            }
            const pkg = up(a, 'package');
            const gid = pkg ? q(pkg.id) : `${root}::`;
            if (!groups.has(gid)) groups.set(gid, { id: gid, artifactId: pkg ? gid : null, label: `${many ? root + ' · ' : ''}${pkg ? pkg.name : '(no package)'}`, external: false, parts: new Map(), out: 0, in: 0 });
            const mod = up(a, 'module');
            const pid = mod ? q(mod.id) : `${gid}/`;
            const grp = groups.get(gid);
            if (!grp.parts.has(pid)) grp.parts.set(pid, { id: mod ? pid : null, label: mod ? mod.name : '(package root)', flow: 0, lines: 0 });
            if (a.kind === 'file') grp.parts.get(pid).lines += (a.size && a.size.lines) || 1;
            groupOf.set(q(a.id), [gid, pid]);
          }
          for (const d of g.dependencies) {
            const f = groupOf.get(q(d.from));
            const t = groupOf.get(q(d.to));
            if (!f || !t) continue;
            const w = d.weight || 1;
            if (f[0] === t[0]) {
              internal += w;
              continue;
            }
            if (d.inferred) inferred += w;
            const k = `${f[0]}\u0000${t[0]}`;
            flows.set(k, (flows.get(k) || 0) + w);
            if (!d.inferred) observed.add(k);
            const fg = groups.get(f[0]);
            const tg = groups.get(t[0]);
            fg.out += w;
            tg.in += w;
            fg.parts.get(f[1]).flow += w;
            tg.parts.get(t[1]).flow += w;
          }
        }
        return { groups, groupOf, flows, observed, internal, inferred };
      }

      /** Folds the smallest of a list past `max` into one entry. */
      function foldSmall(list, max, make) {
        if (list.length <= max) return { kept: list, folded: [] };
        const sorted = [...list].sort((a, b) => b.out + b.in - (a.out + a.in));
        return { kept: [...sorted.slice(0, max - 1), make(sorted.slice(max - 1))], folded: sorted.slice(max - 1) };
      }

      function draw() {
        const graphs = (workspace && workspace.code) || [];
        if (!graphs.length) {
          panel.empty('No code loaded. Pick a code graph below (Sessions and project ↓).');
          return;
        }
        const m = model(graphs);
        // Packages, folded past MAX_PACKAGES; externals, folded past MAX_EXTERNALS.
        let pkgs = [...m.groups.values()].filter((g) => !g.external).sort((a, b) => a.label.localeCompare(b.label));
        const pk = foldSmall(pkgs, MAX_PACKAGES, (rest) => ({ id: 'other-packages', artifactId: null, label: `${rest.length} other packages`, external: false, parts: new Map(), out: rest.reduce((n, g) => n + g.out, 0), in: rest.reduce((n, g) => n + g.in, 0), members: rest }));
        pkgs = pk.kept;
        const ext = m.groups.get('external');
        let extParts = ext ? [...ext.parts.values()].filter((p) => p.flow > 0).sort((a, b) => b.flow - a.flow) : [];
        let extFolded = 0;
        if (extParts.length > MAX_EXTERNALS) {
          const rest = extParts.slice(MAX_EXTERNALS - 1);
          extFolded = rest.length;
          extParts = [...extParts.slice(0, MAX_EXTERNALS - 1), { id: null, label: `${rest.length} others`, flow: rest.reduce((n, p) => n + p.flow, 0), lines: 0 }];
        }
        const alias = new Map(); // group id -> drawn group id
        for (const g of pkgs) alias.set(g.id, g.id);
        for (const g of pk.folded) alias.set(g.id, 'other-packages');
        if (ext) alias.set('external', 'external');
        // Flows between drawn groups.
        const flows = new Map();
        const observed = new Set();
        for (const [k, w] of m.flows) {
          const [f, t] = k.split('\u0000').map((x) => alias.get(x));
          if (!f || !t || f === t) continue;
          const kk = `${f}\u0000${t}`;
          flows.set(kk, (flows.get(kk) || 0) + w);
          if (m.observed.has(k)) observed.add(kk);
        }
        const total = [...flows.values()].reduce((a, b) => a + b, 0);
        if (!pkgs.length) {
          panel.empty('The loaded code has no packages to draw.');
          return;
        }
        if (!total) {
          panel.empty(`No imports cross a package border in the loaded code (${fmt(pkgs.length)} package${pkgs.length === 1 ? '' : 's'}, ${fmt(m.internal)} imports within them).`);
          return;
        }
        const extIn = extParts.reduce((n, p) => n + p.flow, 0);
        // Angles: packages around the top, externals centered at the bottom.
        const units = (g) => Math.max(g.out + g.in, total * 2 * MIN_SHARE);
        const pkgUnits = pkgs.reduce((n, g) => n + units(g), 0);
        const extUnits = extIn;
        const hasExt = extUnits > 0;
        const free = 2 * Math.PI - PAD * pkgs.length - (hasExt ? 2 * EXT_PAD : 0);
        const scale = free / (pkgUnits + extUnits);
        const arcs = new Map(); // drawn group id -> { a0, a1, outCursor, inCursor }
        let a = hasExt ? Math.PI + (extUnits * scale) / 2 + EXT_PAD : PAD / 2;
        pkgs.forEach((g, i) => {
          const span = units(g) * scale;
          arcs.set(g.id, { group: g, index: i, a0: a, a1: a + span, cursor: a, scale: span / Math.max(1e-9, g.out + g.in) });
          a += span + PAD;
        });
        if (hasExt) {
          const a0 = Math.PI - (extUnits * scale) / 2;
          arcs.set('external', { group: { id: 'external', label: 'external', external: true }, index: -1, a0, a1: a0 + extUnits * scale, cursor: a0, scale });
        }
        const width = Math.max(320, host.clientWidth || 800);
        const avail = fitH.height(FALLBACK_HEIGHT, 280);
        // In a slide the wheel takes the room it's given (width or height); outside one it keeps its old 280 cap.
        const inSlide = ctx.fitHeight(host) !== null;
        const R = Math.max(80, Math.min(width / 2 - LABEL_ROOM, avail / 2 - 24, inSlide ? Infinity : 280));
        const height = Math.max(Math.ceil(2 * R + 48), inSlide ? Math.floor(avail) : 0);
        const cx = width / 2;
        const cy = height / 2;
        const rOuter0 = R - 10;
        const rInner1 = R - 12;
        const rInner0 = R - 20;
        const rRibbon = R - 22;
        const pt = (r, ang) => `${(cx + r * Math.sin(ang)).toFixed(2)} ${(cy - r * Math.cos(ang)).toFixed(2)}`;
        const sel = selection && selection.artifactId ? selection.artifactId : null;
        const selGroup = sel ? (m.groupOf.get(sel) ? alias.get(m.groupOf.get(sel)[0]) : alias.get(sel)) : null;
        const root = svg('svg', { class: 'viz-chart wheel-chart', width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `Package wheel: ${pkgs.length} packages${hasExt ? ' and externals' : ''}, ${fmt(total)} imports across package borders` });
        const hue = (id) => (id === 'external' ? 'wheel-ext' : `line-${arcs.get(id).index % 6}`);

        // Ribbons: each flow takes a slice of its source's arc and of its target's, sources first.
        const sorted = [...flows].map(([k, w]) => {
          const [f, t] = k.split('\u0000');
          return { f, t, w };
        });
        // Out-slices, then in-slices, each in the order of the other end around the wheel, so ribbons cross less.
        const angleOf = (id) => (arcs.get(id).a0 + arcs.get(id).a1) / 2;
        const slices = new Map();
        for (const [id, arc] of arcs) {
          const outs = sorted.filter((s) => s.f === id).sort((x, y) => angleOf(y.t) - angleOf(x.t));
          const ins = sorted.filter((s) => s.t === id).sort((x, y) => angleOf(y.f) - angleOf(x.f));
          let at0 = arc.a0;
          for (const s of [...outs, ...ins]) {
            const span = s.w * arc.scale;
            slices.set(`${s.f}\u0000${s.t}\u0000${s.f === id ? 'out' : 'in'}`, [at0, at0 + span]);
            at0 += span;
          }
        }
        const ribbons = svg('g', { class: 'wheel-ribbons' });
        for (const s of sorted.sort((x, y) => y.w - x.w)) {
          const [s0, s1] = slices.get(`${s.f}\u0000${s.t}\u0000out`);
          const [t0, t1] = slices.get(`${s.f}\u0000${s.t}\u0000in`);
          if (s1 - s0 < MIN_ANGLE / 2 && t1 - t0 < MIN_ANGLE / 2) continue;
          const lg = (x0, x1) => (x1 - x0 > Math.PI ? 1 : 0);
          const d = `M${pt(rRibbon, s0)} A${rRibbon} ${rRibbon} 0 ${lg(s0, s1)} 1 ${pt(rRibbon, s1)} Q${cx} ${cy} ${pt(rRibbon, t0)} A${rRibbon} ${rRibbon} 0 ${lg(t0, t1)} 1 ${pt(rRibbon, t1)} Q${cx} ${cy} ${pt(rRibbon, s0)} Z`;
          const on = selGroup && (s.f === selGroup || s.t === selGroup);
          const guessed = !observed.has(`${s.f}\u0000${s.t}`);
          const p = svg('path', { class: `wheel-ribbon ${hue(s.f)}${guessed ? ' shape-inferred' : ''}${on ? ' wheel-ribbon-on' : selGroup ? ' wheel-ribbon-dim' : ''}`, d });
          const fl = arcs.get(s.f).group.label;
          const tl = arcs.get(s.t).group.label;
          const back = flows.get(`${s.t}\u0000${s.f}`) || 0;
          const src = arcs.get(s.f).group;
          interact(ctx, p, {
            label: `${fl} imports ${tl} ${fmt(s.w)} times`,
            tip: () => [`${fl} → ${tl}`, ['Imports', fmt(s.w) + (guessed ? ' (≈ inferred)' : '')], ...(back ? [['Back the other way', fmt(back)]] : [])],
            pick: src.artifactId ? () => ctx.select({ artifactId: src.artifactId }) : undefined,
          });
          ribbons.append(p);
        }
        root.append(ribbons);

        // Arcs: the group, then its parts (modules, or each external) on the inner ring.
        for (const [id, arc] of arcs) {
          const g = arc.group;
          const on = selGroup === id;
          const outer = svg('path', { class: `wheel-arc ${hue(id)}${on ? ' shape-on' : ''}`, d: arcPath(cx, cy, rOuter0, R, arc.a0, Math.max(arc.a0 + MIN_ANGLE, arc.a1)) });
          const label = g.external ? 'External packages' : g.label;
          interact(ctx, outer, {
            label: `${label}: ${fmt(g.out || 0)} imports out, ${fmt(g.in || extIn)} in`,
            tip: () => [label, ...(g.external ? [['Imports in', fmt(extIn)], ['Packages', fmt(extParts.length + extFolded - (extFolded ? 1 : 0))]] : [['Imports out', fmt(g.out)], ['Imports in', fmt(g.in)], ...(g.members ? [['Folded', g.members.map((x) => x.label).slice(0, 6).join(', ')]] : [])])],
            pick: g.artifactId ? () => ctx.select({ artifactId: g.artifactId }) : undefined,
          });
          root.append(outer);
          // Parts on the inner ring.
          const parts = g.external ? extParts : g.parts ? [...g.parts.values()] : [];
          const flowSum = parts.reduce((n, p) => n + p.flow, 0);
          const lineSum = parts.reduce((n, p) => n + p.lines, 0);
          const by = flowSum > 0 ? 'flow' : 'lines';
          const sum = flowSum > 0 ? flowSum : lineSum;
          if (sum > 0) {
            let at0 = arc.a0;
            for (const part of parts) {
              const span = (part[by] / sum) * (arc.a1 - arc.a0);
              if (span >= MIN_ANGLE) {
                const pOn = sel && part.id === sel;
                const inner = svg('path', { class: `wheel-part ${hue(id)}${pOn ? ' shape-on' : ''}`, d: arcPath(cx, cy, rInner0, rInner1, at0 + 0.002, at0 + span - 0.002 > at0 + 0.002 ? at0 + span - 0.002 : at0 + span) });
                interact(ctx, inner, {
                  label: `${part.label} in ${label}`,
                  tip: () => [part.label, ['In', label], [g.external ? 'Imports in' : 'Imports across', fmt(part.flow)], ...(g.external ? [] : [['Lines', fmt(part.lines)]])],
                  pick: part.id ? () => ctx.select({ artifactId: part.id }) : undefined,
                });
                root.append(inner);
              }
              at0 += span;
            }
          }
          // The name, outside the arc.
          const mid = (arc.a0 + arc.a1) / 2;
          const sin = Math.sin(mid);
          const anchor = Math.abs(sin) < 0.2 ? 'middle' : sin > 0 ? 'start' : 'end';
          const lx = cx + (R + 6) * sin;
          const ly = cy - (R + 6) * Math.cos(mid) + (Math.cos(mid) < 0 ? 10 : 2);
          const room = anchor === 'middle' ? 2 * R : anchor === 'start' ? width - lx - 2 : lx - 2;
          if (arc.a1 - arc.a0 > 0.05) root.append(svgText({ class: `wheel-label${on ? ' wheel-label-on' : ''}`, x: lx.toFixed(1), y: ly.toFixed(1), 'text-anchor': anchor }, fit(label, Math.min(room, LABEL_ROOM + 40))));
        }
        panel.chart.replaceChildren(root);
        panel.legend.replaceChildren(
          legendKey('wheel-swatch-ribbon', 'ribbon: imports, in the importing package’s hue'),
          ...(hasExt ? [legendKey('wheel-ext', 'external packages')] : []),
          legendKey('wheel-swatch-ring', 'inner ring: modules'),
          ...(observed.size < flows.size ? [legendKey('swatch-shape-inferred', 'inferred: every import guessed')] : [])
        );
        panel.note.textContent =
          `${fmt(total)} imports cross package borders (${fmt(m.internal)} more stay inside one). Each package's arc is as long as the imports crossing its border, in and out (at least ${(MIN_SHARE * 100).toFixed(1)}% of the circle); its inner ring splits that by module (by lines when none cross). ` +
          `A ribbon's width at each end is the imports from one package to another, drawn in the importing package's hue${hasExt ? '; external packages share the arc at the bottom, split by package' : ''}. A dependency a manifest declares counts one. ` +
          (m.inferred ? `${fmt(m.inferred)} of the crossing imports were inferred. ` : '') +
          (pk.folded.length ? `${pk.folded.length} smallest packages fold into one arc past ${MAX_PACKAGES}. ` : '') +
          (extFolded ? `${extFolded} smallest externals fold into one past ${MAX_EXTERNALS}. ` : '') +
          'Click an arc to select its package, module, or external; a ribbon selects the importing package.';
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
