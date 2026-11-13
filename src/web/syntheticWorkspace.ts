import { Artifact, CodeGraph, Dependency, PlanGraph, PlanItem, PlanLink, PlanStatus } from '../model';
import { SYNTHETIC_DAY } from './synthetic';

/**
 * The web demo's example code and plan (docs/workspace-explorer.md, "What the
 * page does with a file"), beside the example sessions in synthetic.ts. Seeded,
 * so every visit draws the same project. They're made to meet the example
 * sessions: the code holds the files those sessions read and edit, and one
 * plan item has the title of one of their prompts, so all three joins find
 * something. Shapes that exercise the views: a root package with four
 * workspace packages, about 120 files, two import cycles, tests, externals;
 * three epics over a month, a blocked chain, and an epic with everything done.
 */

/** The example project's name, as an adapter would put it in `source.root`. */
export const SYNTHETIC_ROOT = 'example-monorepo';

const GENERATED_AT = `${SYNTHETIC_DAY}T18:00:00.000Z`;

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface PackageSpec {
  name: string;
  /** Folder of the package; '' for the root. */
  dir: string;
  /** Source modules under src/, with how many files each holds beyond the named ones. */
  modules: Array<{ name: string; files: string[]; extra: number }>;
  tests: number;
  /** Other packages this one imports by name. */
  uses: string[];
  externals: Array<{ name: string; dev?: boolean }>;
  language: 'ts' | 'tsx';
}

const PACKAGES: PackageSpec[] = [
  {
    name: 'example',
    dir: '',
    // The files the example sessions touch come first, with their exact paths.
    modules: [
      { name: 'core', files: ['retention.ts', 'eventLog.ts', 'sessionController.ts', 'statusBar.ts'], extra: 8 },
      { name: 'adapters', files: [], extra: 9 },
      { name: 'ui', files: [], extra: 7 },
    ],
    tests: 10,
    uses: ['@example/schema'],
    externals: [{ name: 'esbuild', dev: true }, { name: 'typescript', dev: true }],
    language: 'ts',
  },
  { name: '@example/schema', dir: 'packages/schema', modules: [{ name: 'types', files: [], extra: 6 }, { name: 'validate', files: [], extra: 4 }], tests: 4, uses: [], externals: [{ name: 'typescript', dev: true }], language: 'ts' },
  { name: '@example/ui', dir: 'packages/ui', modules: [{ name: 'components', files: [], extra: 12 }, { name: 'charts', files: [], extra: 9 }], tests: 6, uses: ['@example/schema'], externals: [{ name: 'react' }, { name: 'react-dom' }], language: 'tsx' },
  { name: '@example/cli', dir: 'packages/cli', modules: [{ name: 'commands', files: [], extra: 7 }], tests: 3, uses: ['@example/schema', 'example'], externals: [{ name: 'commander' }], language: 'ts' },
  { name: '@example/web', dir: 'packages/web', modules: [{ name: 'pages', files: [], extra: 6 }, { name: 'server', files: [], extra: 4 }], tests: 3, uses: ['@example/ui', '@example/schema'], externals: [{ name: 'express' }, { name: '@types/express', dev: true }], language: 'tsx' },
];

const WORDS = ['index', 'store', 'reader', 'writer', 'format', 'parse', 'render', 'layout', 'theme', 'cache', 'queue', 'limits', 'marks', 'model', 'view', 'table', 'chart', 'panel', 'menu', 'route', 'config', 'logger', 'timer', 'replay'];

/** The example project's code: seeded, the same every time. */
export function syntheticCodeGraph(): CodeGraph {
  const rnd = prng(20261113);
  const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  const artifacts: Artifact[] = [];
  const deps = new Map<string, Dependency>();
  const dep = (from: string, to: string, kind: Dependency['kind'], inferred = false) => {
    if (from === to) return;
    const k = `${from}\u0000${to}\u0000${kind}`;
    const d = deps.get(k);
    if (d) d.weight = (d.weight ?? 1) + 1;
    else deps.set(k, { from, to, kind, weight: 1, ...(inferred ? { inferred: true } : {}) });
  };
  const file = (path: string, parent: string, role: Artifact['role'], language: string, lines: number) =>
    artifacts.push({ id: path, kind: 'file', name: path.slice(path.lastIndexOf('/') + 1), path, parent, language, role, size: { lines, bytes: lines * 34 } });
  const at = (dir: string, rest: string) => (dir ? `${dir}/${rest}` : rest);

  artifacts.push({ id: SYNTHETIC_ROOT, kind: 'workspace', name: SYNTHETIC_ROOT });
  const sourcesOf = new Map<string, string[]>(); // package name → its source file ids
  const moduleFiles = new Map<string, string[]>(); // module id → its file ids
  for (const pkg of PACKAGES) {
    artifacts.push({ id: pkg.name, kind: 'package', name: pkg.name, ...(pkg.dir ? { path: pkg.dir } : {}), parent: SYNTHETIC_ROOT });
    file(at(pkg.dir, 'package.json'), pkg.name, 'config', 'json', 20 + Math.floor(rnd() * 20));
    file(at(pkg.dir, 'README.md'), pkg.name, 'doc', 'md', 15 + Math.floor(rnd() * 60));
    const sources: string[] = [];
    for (const m of pkg.modules) {
      const modPath = at(pkg.dir, `src/${m.name}`);
      artifacts.push({ id: modPath, kind: 'module', name: m.name, path: modPath, parent: pkg.name });
      const names = [...m.files];
      while (names.length < m.files.length + m.extra) {
        const n = `${pick(WORDS)}${names.length % 3 === 0 ? '' : pick(['', 'Utils', 'View', 'Model'])}.${pkg.language === 'tsx' && rnd() < 0.5 ? 'tsx' : 'ts'}`;
        if (!names.includes(n)) names.push(n);
      }
      const ids = names.map((n) => `${modPath}/${n}`);
      for (const id of ids) file(id, modPath, 'source', id.endsWith('.tsx') ? 'tsx' : 'ts', 30 + Math.floor(rnd() * rnd() * 600));
      moduleFiles.set(modPath, ids);
      sources.push(...ids);
    }
    sourcesOf.set(pkg.name, sources);
    // Tests: each imports one or two sources of its package.
    const testDir = at(pkg.dir, pkg.dir ? 'test' : 'src/test/unit');
    artifacts.push({ id: testDir, kind: 'module', name: 'tests', path: testDir, parent: pkg.name });
    for (let i = 0; i < pkg.tests; i++) {
      const subject = i === 0 && !pkg.dir ? `src/core/retention.ts` : pick(sources);
      const base = subject.slice(subject.lastIndexOf('/') + 1).replace(/\.tsx?$/, '');
      let id = `${testDir}/${base}.unit.test.ts`;
      if (artifacts.some((a) => a.id === id)) id = `${testDir}/${base}${i}.unit.test.ts`;
      file(id, testDir, 'test', 'ts', 40 + Math.floor(rnd() * 200));
      dep(id, subject, 'import');
      if (rnd() < 0.4) dep(id, pick(sources), 'import');
    }
    // Imports inside the package: mostly within a module, some across.
    for (const [mod, ids] of moduleFiles) {
      if (!mod.startsWith(at(pkg.dir, 'src/'))) continue;
      for (const id of ids) {
        const n = Math.floor(rnd() * 4);
        for (let k = 0; k < n; k++) {
          const sameModule = rnd() < 0.65;
          const to = sameModule ? pick(ids) : pick(sources);
          // Only point "down" the list, so the cycles below are the only ones.
          if (sources.indexOf(to) > sources.indexOf(id)) dep(id, to, 'import', rnd() < 0.1);
        }
      }
    }
    moduleFiles.clear();
    // Imports of other packages by name, from a few files.
    for (const used of pkg.uses) {
      for (let k = 0; k < 3; k++) dep(pick(sources), pick(sourcesOf.get(used) ?? [used]), 'import');
      dep(pkg.name, used, 'runtime');
    }
    for (const ext of pkg.externals) {
      const extId = `npm:${ext.name}`;
      if (!artifacts.some((a) => a.id === extId)) artifacts.push({ id: extId, kind: 'external', name: ext.name });
      dep(pkg.name, extId, ext.dev ? 'dev' : 'runtime');
      if (!ext.dev) for (let k = 0; k < 2; k++) dep(pick(sources), extId, 'import');
    }
  }
  // Docs and the changelog at the root, which the example sessions edit.
  artifacts.push({ id: 'docs', kind: 'module', name: 'docs', path: 'docs', parent: 'example' });
  for (const [p, lines] of [['docs/usage.md', 240], ['docs/architecture.md', 180], ['docs/roadmap.md', 90]] as const) file(p, 'docs', 'doc', 'md', lines);
  file('CHANGELOG.md', 'example', 'doc', 'md', 60);
  file('tsconfig.json', 'example', 'config', 'json', 25);
  file('packages/ui/src/theme.css', '@example/ui', 'asset', 'css', 140);
  // Two cycles, on purpose: a pair in core, and three files in ui's components.
  dep('src/core/retention.ts', 'src/core/eventLog.ts', 'import');
  dep('src/core/eventLog.ts', 'src/core/retention.ts', 'import');
  const comps = (sourcesOf.get('@example/ui') ?? []).filter((s) => s.includes('/components/')).slice(0, 3);
  if (comps.length === 3) {
    dep(comps[0], comps[1], 'import');
    dep(comps[1], comps[2], 'import');
    dep(comps[2], comps[0], 'import');
  }
  const order = new Map(artifacts.map((a, i) => [a.id, i]));
  const dependencies = [...deps.values()].sort((a, b) => order.get(a.from)! - order.get(b.from)! || order.get(a.to)! - order.get(b.to)! || a.kind.localeCompare(b.kind));
  return { kind: 'code-graph', version: 1, source: { adapter: 'synthetic', root: SYNTHETIC_ROOT, generatedAt: GENERATED_AT, tool: 'npm' }, artifacts, dependencies };
}

/** Days before the example sessions' day, as an ISO timestamp at a fixed hour. */
const daysBefore = (days: number, hour = 10) => new Date(Date.parse(`${SYNTHETIC_DAY}T00:00:00Z`) - days * 86_400_000 + hour * 3_600_000).toISOString();

interface ItemSpec {
  id: string;
  title: string;
  kind?: PlanItem['kind'];
  status: PlanStatus;
  /** Opened this many days before the sessions' day; closed `took` days later when done. */
  opened: number;
  took?: number;
  paths?: string[];
  priority?: number;
  blocks?: string[];
}

const EPICS: Array<{ id: string; title: string; opened: number; paths: string[]; items: ItemSpec[] }> = [
  {
    id: 'ex-1',
    title: 'Retention and the event log',
    opened: 30,
    paths: ['src/core'],
    items: [
      { id: 'ex-1.1', title: 'Keep 30 days of events by default', status: 'done', opened: 29, took: 4, paths: ['src/core/retention.ts'], priority: 1 },
      { id: 'ex-1.2', title: 'Compact old days into summaries', status: 'done', opened: 27, took: 6, paths: ['src/core/eventLog.ts'], blocks: ['ex-1.4'] },
      { id: 'ex-1.3', title: 'fix the failing unit test in retention', kind: 'bug', status: 'done', opened: 3, took: 2, paths: ['src/test/unit/retention.unit.test.ts', 'src/core/retention.ts'], priority: 0 },
      { id: 'ex-1.4', title: 'Report retention in the status bar', status: 'in_progress', opened: 12, paths: ['src/core/statusBar.ts'], blocks: ['ex-1.5'] },
      { id: 'ex-1.5', title: 'Retention settings page', status: 'blocked', opened: 10, paths: ['packages/ui/src/components'], blocks: ['ex-1.6'] },
      { id: 'ex-1.6', title: 'Document retention', status: 'open', opened: 9, paths: ['docs/usage.md'], blocks: ['ex-3.4'] },
      { id: 'ex-1.7', title: 'Import retention from the old format', status: 'deferred', opened: 20, paths: ['src/adapters'] },
      { id: 'ex-1.8', title: 'Retention per workspace', status: 'dropped', opened: 25, took: 3 },
    ],
  },
  {
    id: 'ex-2',
    title: 'Charts in the UI package',
    opened: 24,
    paths: ['packages/ui'],
    items: [
      { id: 'ex-2.1', title: 'Shared theme tokens', status: 'done', opened: 24, took: 3, paths: ['packages/ui/src/theme.css'], blocks: ['ex-2.2', 'ex-2.3'] },
      { id: 'ex-2.2', title: 'Line chart', status: 'done', opened: 22, took: 5, paths: ['packages/ui/src/charts'] },
      { id: 'ex-2.3', title: 'Tooltip that stays inside the window', status: 'done', opened: 8, took: 6, paths: ['packages/ui/src/components'] },
      { id: 'ex-2.4', title: 'Treemap', status: 'done', opened: 18, took: 9, paths: ['packages/ui/src/charts'] },
      { id: 'ex-2.5', title: 'Chart schema types', status: 'done', opened: 21, took: 2, paths: ['packages/schema/src/types'], blocks: ['ex-2.2', 'ex-2.4'] },
      { id: 'ex-2.6', title: 'Dark theme check', status: 'done', opened: 15, took: 4, paths: ['packages/ui'] },
      { id: 'ex-2.7', title: 'Chart gallery page', status: 'done', opened: 12, took: 7, paths: ['packages/web/src/pages'] },
    ],
  },
  {
    id: 'ex-3',
    title: 'Release 0.2',
    opened: 14,
    paths: ['CHANGELOG.md'],
    items: [
      { id: 'ex-3.1', title: 'Add a changelog section for 0.0.3', status: 'done', opened: 6, took: 1, paths: ['CHANGELOG.md'] },
      { id: 'ex-3.2', title: 'CLI: export command', status: 'in_progress', opened: 11, paths: ['packages/cli/src/commands'], blocks: ['ex-3.5'] },
      { id: 'ex-3.3', title: 'Web: serve the chart gallery', status: 'open', opened: 9, paths: ['packages/web/src/server'], blocks: ['ex-3.5'] },
      { id: 'ex-3.4', title: 'Usage guide for the release', status: 'open', opened: 7, paths: ['docs/usage.md'], blocks: ['ex-3.5'] },
      { id: 'ex-3.5', title: 'Tag and publish 0.2', status: 'blocked', opened: 5, priority: 1 },
      { id: 'ex-3.6', title: 'Architecture notes', status: 'open', opened: 4, paths: ['docs/architecture.md'] },
    ],
  },
];

const LOOSE: ItemSpec[] = [
  { id: 'ex-4', title: 'Flaky integration suite on CI', kind: 'bug', status: 'open', opened: 2, priority: 2 },
  { id: 'ex-5', title: 'Should the CLI share the UI theme?', kind: 'question', status: 'open', opened: 6 },
  { id: 'ex-6', title: 'Use esbuild for every package', kind: 'decision', status: 'done', opened: 26, took: 1 },
  { id: 'ex-7', title: 'Logger levels', status: 'open', opened: 16, paths: ['src/core'] },
];

/** The example project's plan: seeded, the same every time. Read from a tracker, so every item is observed. */
export function syntheticPlanGraph(): PlanGraph {
  const items: PlanItem[] = [];
  const links: PlanLink[] = [];
  const item = (spec: ItemSpec, parent?: string, kind: PlanItem['kind'] = 'task') => {
    const created = daysBefore(spec.opened);
    const closedAt = spec.took !== undefined && (spec.status === 'done' || spec.status === 'dropped') ? daysBefore(spec.opened - spec.took, 16) : undefined;
    items.push({
      id: spec.id,
      kind: spec.kind ?? kind,
      title: spec.title,
      status: spec.status,
      ...(spec.priority !== undefined ? { priority: spec.priority } : { priority: 2 }),
      ...(parent ? { parent } : {}),
      created,
      updated: closedAt ?? daysBefore(Math.max(0, spec.opened - 2)),
      ...(closedAt ? { closed: closedAt } : {}),
      ...(spec.paths ? { refs: { paths: spec.paths } } : {}),
      confidence: 'observed',
    });
    if (parent) links.push({ from: spec.id, to: parent, kind: 'parent' });
    for (const b of spec.blocks ?? []) links.push({ from: spec.id, to: b, kind: 'blocks' });
  };
  for (const e of EPICS) {
    const done = e.items.every((i) => i.status === 'done' || i.status === 'dropped');
    const lastClose = Math.min(...e.items.map((i) => i.opened - (i.took ?? 0)));
    item({ id: e.id, title: e.title, status: done ? 'done' : 'in_progress', opened: e.opened, ...(done ? { took: e.opened - lastClose } : {}), paths: e.paths, priority: 1 }, undefined, 'epic');
    for (const i of e.items) item(i, e.id);
  }
  for (const i of LOOSE) item(i);
  links.push({ from: 'ex-7', to: 'ex-1', kind: 'relates' });
  links.push({ from: 'ex-4', to: 'ex-3.2', kind: 'discovered-from' });
  return { kind: 'plan-graph', version: 1, source: { adapter: 'synthetic', root: 'example-plan', generatedAt: GENERATED_AT, tool: 'beads' }, items, links };
}
