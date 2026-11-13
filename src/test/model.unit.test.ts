import * as assert from 'assert';
import { NormalizedEvent } from '../schema';
import { EventSet, syntheticEvents, syntheticSessionIds } from '../web';
import {
  CodeGraph,
  PlanGraph,
  UNANCHORED_SEGMENTS,
  anchor,
  SHAPE_NODE_LIMIT,
  buildWorkspace,
  checkCodeGraph,
  codeFoldFor,
  checkPlanGraph,
  fanInOut,
  joinPlanToCode,
  joinPlanToSession,
  joinSessionToCode,
  qualify,
  shapeOfCode,
  shapeOfPlan,
  shapeOfSessions,
  shapeOfWorkspace,
  touchesOf,
} from '../model';

const source = (root: string) => ({ adapter: 'test', root, generatedAt: '2026-11-13T10:00:00Z' });

// A small project shaped like the synthetic sessions' world: one package, a src module, tests, docs, one external.
function codeGraph(): CodeGraph {
  return {
    kind: 'code-graph',
    version: 1,
    source: source('demo'),
    artifacts: [
      { id: 'demo', kind: 'package', name: 'demo' },
      { id: 'src/core', kind: 'module', name: 'core', path: 'src/core', parent: 'demo' },
      { id: 'src/core/retention.ts', kind: 'file', name: 'retention.ts', path: 'src/core/retention.ts', parent: 'src/core', size: { lines: 120 }, role: 'source' },
      { id: 'src/core/eventLog.ts', kind: 'file', name: 'eventLog.ts', path: 'src/core/eventLog.ts', parent: 'src/core', size: { lines: 80 }, role: 'source' },
      { id: 'src/test/unit/retention.unit.test.ts', kind: 'file', name: 'retention.unit.test.ts', path: 'src/test/unit/retention.unit.test.ts', parent: 'demo', size: { lines: 40 }, role: 'test' },
      { id: 'docs/usage.md', kind: 'file', name: 'usage.md', path: 'docs/usage.md', parent: 'demo', size: { lines: 30 }, role: 'doc' },
      { id: 'README.md', kind: 'file', name: 'README.md', path: 'README.md', parent: 'demo', size: { lines: 10 }, role: 'doc' },
      { id: 'npm:esbuild', kind: 'external', name: 'esbuild' },
    ],
    dependencies: [
      { from: 'src/core/retention.ts', to: 'src/core/eventLog.ts', kind: 'import', weight: 2 },
      { from: 'src/test/unit/retention.unit.test.ts', to: 'src/core/retention.ts', kind: 'import' },
      { from: 'src/core/eventLog.ts', to: 'npm:esbuild', kind: 'dev', inferred: true },
    ],
  };
}

function planGraph(): PlanGraph {
  return {
    kind: 'plan-graph',
    version: 1,
    source: source('beads'),
    items: [
      { id: 'demo-1', kind: 'epic', title: 'Retention', status: 'in_progress', confidence: 'observed' },
      { id: 'demo-2', kind: 'task', title: 'fix the failing unit test in retention', status: 'done', parent: 'demo-1', confidence: 'observed', refs: { paths: ['src/core/retention.ts'] } },
      { id: 'demo-3', kind: 'task', title: 'Docs', status: 'open', parent: 'demo-1', confidence: 'inferred', refs: { paths: ['docs'] } },
      { id: 'demo-4', kind: 'task', title: 'Core cleanup', status: 'blocked', confidence: 'observed', refs: { paths: ['src/core'], artifacts: ['npm:esbuild'] } },
    ],
    links: [
      { from: 'demo-2', to: 'demo-4', kind: 'blocks' },
      { from: 'demo-2', to: 'demo-1', kind: 'parent' },
      { from: 'demo-3', to: 'demo-4', kind: 'relates', inferred: true },
    ],
  };
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  // ---------- validators ----------

  test('a good code graph and plan graph check clean', () => {
    const c = checkCodeGraph(JSON.parse(JSON.stringify(codeGraph())));
    assert.deepStrictEqual(c.errors, []);
    assert.strictEqual(c.value?.artifacts.length, 8);
    const p = checkPlanGraph(JSON.parse(JSON.stringify(planGraph())));
    assert.deepStrictEqual(p.errors, []);
    assert.strictEqual(p.value?.items.length, 4);
  });

  test('a file of the wrong kind, version, or source is refused whole', () => {
    assert.strictEqual(checkCodeGraph({ kind: 'plan-graph' }).value, undefined);
    assert.strictEqual(checkCodeGraph(null).value, undefined);
    assert.strictEqual(checkCodeGraph({ ...codeGraph(), version: 2 }).value, undefined);
    assert.strictEqual(checkPlanGraph({ ...planGraph(), source: { ...source('x'), root: '/home/someone/project' } }).value, undefined);
    assert.match(checkPlanGraph({ ...planGraph(), source: { ...source('x'), root: 'C:\\Users\\x' } }).errors.join(), /absolute/);
  });

  test('broken rows are reported and dropped, and the rest of the file survives', () => {
    const g = codeGraph() as unknown as { artifacts: unknown[]; dependencies: unknown[] };
    g.artifacts.push({ id: 'README.md', kind: 'file', name: 'dup' }, { id: 'x', kind: 'galaxy', name: 'x' }, { id: 'abs', kind: 'file', name: 'abs', path: '/etc/passwd' }, { id: 'orphan', kind: 'file', name: 'o', parent: 'nowhere' });
    g.dependencies.push({ from: 'README.md', to: 'missing', kind: 'import' }, { from: 'README.md', to: 'docs/usage.md', kind: 'telepathy' });
    const c = checkCodeGraph(g);
    assert.strictEqual(c.errors.length, 6, c.errors.join('\n'));
    assert.strictEqual(c.value!.artifacts.length, 9, 'the orphan stays, without its parent');
    assert.strictEqual(c.value!.artifacts.find((a) => a.id === 'orphan')!.parent, undefined);
    assert.strictEqual(c.value!.dependencies.length, 3);

    const p = planGraph() as unknown as { items: Array<Record<string, unknown>>; links: unknown[] };
    p.items.push({ id: 'bad-status', kind: 'task', title: 't', status: 'wip', confidence: 'observed' }, { id: 'abs-ref', kind: 'task', title: 't', status: 'open', confidence: 'observed', refs: { paths: ['/home/me/x.ts', './docs/'] } });
    p.links.push({ from: 'demo-1', to: 'ghost', kind: 'blocks' });
    const pc = checkPlanGraph(p);
    assert.strictEqual(pc.value!.items.length, 5);
    assert.deepStrictEqual(pc.value!.items.find((i) => i.id === 'abs-ref')!.refs!.paths, ['docs'], 'absolute paths dropped, the rest normalized');
    assert.strictEqual(pc.errors.length, 3, pc.errors.join('\n'));
  });

  test('fan-in and fan-out are weighted', () => {
    const f = fanInOut(codeGraph());
    assert.deepStrictEqual(f.get('src/core/eventLog.ts'), { fanIn: 2, fanOut: 1 });
    assert.deepStrictEqual(f.get('src/core/retention.ts'), { fanIn: 1, fanOut: 2 });
    assert.deepStrictEqual(f.get('README.md'), { fanIn: 0, fanOut: 0 });
  });

  // ---------- touches ----------

  test('a target is made relative to its workspace, or cut to its last segments, never kept absolute', () => {
    assert.deepStrictEqual(anchor('src/a.ts'), { path: 'src/a.ts', anchored: true });
    assert.deepStrictEqual(anchor('./src/a.ts'), { path: 'src/a.ts', anchored: true });
    assert.deepStrictEqual(anchor('/home/me/proj/src/a.ts', '/home/me/proj'), { path: 'src/a.ts', anchored: true });
    assert.deepStrictEqual(anchor('C:\\Users\\me\\proj\\src\\a.ts', 'c:\\users\\me\\proj'), { path: 'src/a.ts', anchored: true });
    const cut = anchor('/home/me/other/deep/src/a.ts', '/home/me/proj');
    assert.deepStrictEqual(cut, { path: 'deep/src/a.ts', anchored: false });
    assert.strictEqual(cut!.path.split('/').length, UNANCHORED_SEGMENTS);
    assert.ok(!cut!.path.includes('me'), 'no home folder survives');
    assert.strictEqual(anchor('../outside.ts'), null);
    assert.strictEqual(anchor('line one\nline two'), null);
  });

  test('touches come from file reads and edits only', () => {
    const base = { sessionId: 'S', agent: 'claude-code' as const, ts: '2026-11-13T10:00:00Z', status: 'success' as const, raw: { adapter: 't', ref: 'r' } };
    const events: NormalizedEvent[] = [
      { ...base, eventId: '1', kind: 'tool_call', toolCategory: 'file-read', target: 'README.md', turnId: 'T1' },
      { ...base, eventId: '2', kind: 'tool_call', toolCategory: 'file-edit', target: '/w/p/src/a.ts', workspace: '/w/p', agentId: 'sub' },
      { ...base, eventId: '3', kind: 'tool_call', toolCategory: 'search', target: 'src/**/*.ts' },
      { ...base, eventId: '4', kind: 'tool_call', toolCategory: 'shell', target: 'rm -rf /' },
      { ...base, eventId: '5', kind: 'tool_call', toolCategory: 'file-read' },
      { ...base, eventId: '6', kind: 'user_prompt', target: 'README.md' },
    ];
    const t = touchesOf(events).get('S')!;
    assert.deepStrictEqual(t, [
      { path: 'README.md', anchored: true, kind: 'read', ts: base.ts, turnId: 'T1' },
      { path: 'src/a.ts', anchored: true, kind: 'edit', ts: base.ts, agentId: 'sub' },
    ]);
  });

  // ---------- joins ----------

  test('plan items join the code they name: exact paths, directories, and artifact ids', () => {
    const j = joinPlanToCode(planGraph(), [codeGraph()]);
    const q = (id: string) => qualify('demo', id);
    const to = (item: string) => j.filter((x) => x.from === qualify('beads', item)).map((x) => x.to).sort();
    assert.deepStrictEqual(to('demo-2'), [q('src/core/retention.ts')]);
    assert.deepStrictEqual(to('demo-3'), [q('docs/usage.md')], 'a directory with no artifact of its own links to what is under it');
    assert.deepStrictEqual(to('demo-4'), [q('npm:esbuild'), q('src/core')], 'a directory that is an artifact links to it alone');
    assert.deepStrictEqual(to('demo-1'), []);
    assert.ok(j.every((x) => !x.inferred && x.weight === 1));
  });

  test('plan items join sessions by named id, by id in a prompt, or by a long title', () => {
    const set = new EventSet(syntheticEvents());
    const sessions = syntheticSessionIds().map((id) => set.view(id)!);
    const plan = planGraph();
    plan.items.push({ id: 'demo-5', kind: 'task', title: 'x', status: 'open', confidence: 'observed', refs: { sessions: [sessions[1].summary.sessionId] } });
    const j = joinPlanToSession(plan, sessions);
    const byTitle = j.filter((x) => x.from === qualify('beads', 'demo-2'));
    assert.ok(byTitle.length >= 1, 'the synthetic prompt "fix the failing unit test in retention" matches its title');
    assert.ok(byTitle.every((x) => x.inferred && x.weight >= 1));
    assert.ok(!j.some((x) => x.from === qualify('beads', 'demo-3')), 'a short title never matches');
    assert.deepStrictEqual(j.filter((x) => x.from === qualify('beads', 'demo-5')), [{ from: qualify('beads', 'demo-5'), to: sessions[1].summary.sessionId, inferred: false, weight: 1 }]);
    // An id in a prompt matches, on its own and not as part of a longer id.
    const one = { ...sessions[0], prompts: [{ turnId: 't', ts: sessions[0].summary.firstTs, index: 0, text: 'close demo-4 now; demo-40 is different' }] };
    const ids = joinPlanToSession(planGraph(), [one]).map((x) => x.from);
    assert.ok(ids.includes(qualify('beads', 'demo-4')));
    const forty = { ...one, prompts: [{ ...one.prompts[0], text: 'demo-40 and demo-4.5' }] };
    assert.ok(!joinPlanToSession(planGraph(), [forty]).some((x) => x.from === qualify('beads', 'demo-4')));
  });

  test('sessions join the code they touched: anchored exactly, unanchored by a unique suffix', () => {
    const touches = new Map([
      ['S', [
        { path: 'src/core/retention.ts', anchored: true, kind: 'edit' as const, ts: 't' },
        { path: 'src/core/retention.ts', anchored: true, kind: 'read' as const, ts: 't' },
        { path: 'core/eventLog.ts', anchored: false, kind: 'read' as const, ts: 't' },
        { path: 'README.md', anchored: false, kind: 'read' as const, ts: 't' },
        { path: 'nowhere.ts', anchored: true, kind: 'read' as const, ts: 't' },
      ]],
    ]);
    const j = joinSessionToCode(touches, [codeGraph()]);
    const q = (id: string) => qualify('demo', id);
    assert.deepStrictEqual(j.sort((a, b) => a.to.localeCompare(b.to)), [
      { from: 'S', to: q('README.md'), inferred: true, weight: 1 },
      { from: 'S', to: q('src/core/eventLog.ts'), inferred: true, weight: 1 },
      { from: 'S', to: q('src/core/retention.ts'), inferred: false, weight: 2 },
    ]);
    // A suffix that matches two files is dropped rather than guessed.
    const two = codeGraph();
    two.artifacts.push({ id: 'other/README.md', kind: 'file', name: 'README.md', path: 'other/README.md' });
    assert.ok(!joinSessionToCode(new Map([['S', [{ path: 'README.md', anchored: false, kind: 'read' as const, ts: 't' }]]]), [two]).length);
  });

  test('a workspace over the synthetic sessions joins all three subjects', () => {
    const events = syntheticEvents();
    const set = new EventSet(events);
    const sessions = syntheticSessionIds().slice(0, 2).map((id) => set.view(id)!);
    const ws = buildWorkspace({ sessions, events, code: [codeGraph()], plans: [planGraph()] });
    assert.deepStrictEqual([...ws.touches.keys()].sort(), sessions.map((s) => s.summary.sessionId).sort(), 'only loaded sessions get touches');
    assert.ok(ws.joins.sessionToCode.some((j) => j.to === qualify('demo', 'src/core/retention.ts') && !j.inferred && j.weight > 1));
    assert.ok(ws.joins.planToCode.length >= 3);
    assert.ok(ws.joins.planToSession.length >= 1);
    const empty = buildWorkspace({});
    assert.deepStrictEqual(empty.joins, { planToCode: [], planToSession: [], sessionToCode: [] });
  });

  // ---------- shapes ----------

  test('code folds to files, modules, or packages, with inclusive values and merged links', () => {
    const files = shapeOfCode(codeGraph(), 'file');
    const v = (s: typeof files, id: string) => s.nodes.find((n) => n.id === id)!;
    assert.strictEqual(v(files, 'demo').value, 280, 'the package holds every line');
    assert.strictEqual(v(files, 'src/core').value, 200);
    assert.strictEqual(v(files, 'src/core/retention.ts').parent, 'src/core');
    assert.strictEqual(v(files, 'npm:esbuild').value, 1, 'an external counts the imports that reach it');
    assert.strictEqual(v(files, 'npm:esbuild').kind, 'external');
    assert.strictEqual(v(files, 'docs/usage.md').kind, 'doc');
    assert.strictEqual(v(files, 'demo').kind, 'container');
    assert.ok(files.nodes.every((n) => n.colorGroup >= 0 && n.colorGroup < files.kinds.length));
    assert.strictEqual(files.links.length, 3);

    const modules = shapeOfCode(codeGraph(), 'module');
    assert.deepStrictEqual(modules.nodes.map((n) => n.id).sort(), ['demo', 'npm:esbuild', 'src/core']);
    assert.strictEqual(v(modules, 'demo').value, 280, 'folding keeps the total');
    assert.strictEqual(v(modules, 'src/core').value, 200);
    // retention→eventLog folds onto itself and goes; the test→retention import becomes package→module; eventLog→esbuild is kept.
    assert.deepStrictEqual(modules.links.map((l) => `${l.from}>${l.to}:${l.weight}${l.inferred ? '?' : ''}`).sort(), ['demo>src/core:1', 'src/core>npm:esbuild:1?']);

    const packages = shapeOfCode(codeGraph(), 'package');
    assert.deepStrictEqual(packages.nodes.map((n) => n.id).sort(), ['demo', 'npm:esbuild']);
    assert.strictEqual(packages.links.length, 1);
  });

  test('plans are counted by item, colored by status, with parent links as the hierarchy', () => {
    const s = shapeOfPlan(planGraph());
    const n = (id: string) => s.nodes.find((x) => x.id === id)!;
    assert.strictEqual(n('demo-1').value, 3);
    assert.strictEqual(n('demo-4').value, 1);
    assert.strictEqual(n('demo-2').parent, 'demo-1');
    assert.strictEqual(n('demo-3').inferred, true);
    assert.strictEqual(s.kinds[n('demo-4').colorGroup], 'blocked');
    assert.deepStrictEqual(s.links.map((l) => l.kind).sort(), ['blocks', 'relates']);
    assert.strictEqual(s.links.find((l) => l.kind === 'relates')!.inferred, true);
  });

  test('sessions are their turn trees, under one root when there are several', () => {
    const set = new EventSet(syntheticEvents());
    const [a, b] = syntheticSessionIds().map((id) => set.view(id)!);
    const one = shapeOfSessions([a]);
    const roots = one.nodes.filter((n) => !n.parent);
    assert.strictEqual(roots.length, 1);
    assert.strictEqual(roots[0].value, a.tree.tokens);
    assert.strictEqual(roots[0].label, 'Explorer carousel');
    const two = shapeOfSessions([a, b]);
    assert.strictEqual(two.nodes.filter((n) => !n.parent).length, 1);
    assert.strictEqual(two.nodes.find((n) => n.id === 'sessions')!.value, a.tree.tokens + b.tree.tokens);
    assert.strictEqual(new Set(two.nodes.map((n) => n.id)).size, two.nodes.length, 'ids are unique across sessions');
    const ids = new Set(two.nodes.map((n) => n.id));
    assert.ok(two.nodes.every((n) => !n.parent || ids.has(n.parent)), 'every parent exists');
  });

  test('a workspace’s code and plans become one Shape each, ids qualified by root as the joins are', () => {
    const second: CodeGraph = { ...codeGraph(), source: source('other') };
    const ws = buildWorkspace({ code: [codeGraph(), second], plans: [planGraph()] });
    const code = shapeOfWorkspace(ws, 'code')!;
    assert.strictEqual(code.fold, 'file');
    assert.strictEqual(code.nodes.length, 2 * shapeOfCode(codeGraph(), 'file').nodes.length);
    assert.ok(code.nodes.some((n) => n.id === qualify('demo', 'src/core')));
    assert.ok(code.nodes.some((n) => n.id === qualify('other', 'src/core')), 'the same id in two graphs stays two nodes');
    const ids = new Set(code.nodes.map((n) => n.id));
    assert.ok(code.nodes.every((n) => !n.parent || ids.has(n.parent)), 'every parent exists');
    assert.ok(code.links.every((l) => ids.has(l.from) && ids.has(l.to)), 'every link ends at a node');
    const plan = shapeOfWorkspace(ws, 'plans')!;
    assert.ok(plan.nodes.find((n) => n.id === qualify('beads', 'demo-2'))!.parent === qualify('beads', 'demo-1'));
    for (const j of ws.joins.planToCode) assert.ok(plan.nodes.some((n) => n.id === j.from), 'a join’s plan end is a node of the plan Shape');
    assert.strictEqual(shapeOfWorkspace(ws, 'sessions'), null, 'no sessions loaded');
    assert.strictEqual(shapeOfWorkspace(buildWorkspace({}), 'code'), null);
    assert.strictEqual(shapeOfWorkspace(ws, 'code', { by: 'package' })!.fold, 'package');
  });

  test('code folds a level when its nodes pass the limit', () => {
    const big = (files: number): CodeGraph => ({
      ...codeGraph(),
      artifacts: [
        { id: 'p', kind: 'package', name: 'p' },
        ...Array.from({ length: Math.ceil(files / 10) }, (_, m) => ({ id: `m${m}`, kind: 'module' as const, name: `m${m}`, path: `m${m}`, parent: 'p' })),
        ...Array.from({ length: files }, (_, i) => ({ id: `f${i}`, kind: 'file' as const, name: `f${i}`, path: `m${Math.floor(i / 10)}/f${i}`, parent: `m${Math.floor(i / 10)}` })),
      ],
      dependencies: [],
    });
    assert.strictEqual(codeFoldFor([codeGraph()]), 'file');
    assert.strictEqual(codeFoldFor([big(SHAPE_NODE_LIMIT)]), 'module');
    assert.strictEqual(codeFoldFor([big(SHAPE_NODE_LIMIT * 10)]), 'package');
  });

  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL ${name}\n${(err as Error).stack}`);
    }
  }
  console.log(`${tests.length - failed}/${tests.length} passed`);
  if (failed) process.exit(1);
}

void main();
