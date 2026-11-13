import * as assert from 'assert';
import { EventSet, SYNTHETIC_ROOT, syntheticCodeGraph, syntheticEvents, syntheticPlanGraph, syntheticSessionIds } from '../web';
import { buildWorkspace, checkCodeGraph, checkPlanGraph, qualify, shapeOfCode, shapeOfPlan } from '../model';

// The demo's example code and plan, and how they meet the example sessions.

/** Strongly connected groups of two or more files, by Tarjan's algorithm. */
function cycles(nodes: string[], edges: Array<[string, string]>): string[][] {
  const out = new Map<string, string[]>();
  for (const [a, b] of edges) out.set(a, [...(out.get(a) ?? []), b]);
  let index = 0;
  const idx = new Map<string, number>(), low = new Map<string, number>(), on = new Set<string>(), stack: string[] = [], found: string[][] = [];
  const visit = (v: string) => {
    idx.set(v, index); low.set(v, index); index++; stack.push(v); on.add(v);
    for (const w of out.get(v) ?? []) {
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const group: string[] = [];
      let w: string;
      do { w = stack.pop()!; on.delete(w); group.push(w); } while (w !== v);
      if (group.length > 1) found.push(group.sort());
    }
  };
  for (const n of nodes) if (!idx.has(n)) visit(n);
  return found;
}

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('the example code and plan are the same every time, and check clean', () => {
    assert.deepStrictEqual(syntheticCodeGraph(), syntheticCodeGraph());
    assert.deepStrictEqual(syntheticPlanGraph(), syntheticPlanGraph());
    const c = checkCodeGraph(JSON.parse(JSON.stringify(syntheticCodeGraph())));
    assert.deepStrictEqual(c.errors, []);
    const p = checkPlanGraph(JSON.parse(JSON.stringify(syntheticPlanGraph())));
    assert.deepStrictEqual(p.errors, []);
  });

  test('the example code is a monorepo of five packages and about 120 files, with tests, docs, and externals', () => {
    const g = syntheticCodeGraph();
    assert.strictEqual(g.source.root, SYNTHETIC_ROOT);
    assert.strictEqual(g.artifacts.filter((a) => a.kind === 'package').length, 5);
    const files = g.artifacts.filter((a) => a.kind === 'file');
    assert.ok(files.length >= 100 && files.length <= 160, `${files.length} files`);
    for (const role of ['source', 'test', 'doc', 'config', 'asset'] as const) assert.ok(files.some((f) => f.role === role), role);
    assert.ok(g.artifacts.filter((a) => a.kind === 'external').length >= 5);
    assert.ok(g.dependencies.some((d) => d.kind === 'dev') && g.dependencies.some((d) => d.kind === 'runtime') && g.dependencies.some((d) => d.inferred));
    // A package imported by name from another package.
    const pkgOf = new Map<string, string>();
    for (const a of g.artifacts) {
      let p = a;
      while (p.parent && p.kind !== 'package') p = g.artifacts.find((x) => x.id === p.parent)!;
      pkgOf.set(a.id, p.id);
    }
    assert.ok(g.dependencies.some((d) => d.kind === 'import' && pkgOf.get(d.from) !== pkgOf.get(d.to) && g.artifacts.find((a) => a.id === d.to)?.kind === 'file'), 'a cross-package import');
  });

  test('the example code has exactly the two import cycles it means to', () => {
    const g = syntheticCodeGraph();
    const files = g.artifacts.filter((a) => a.kind === 'file').map((a) => a.id);
    const found = cycles(files, g.dependencies.filter((d) => d.kind === 'import').map((d) => [d.from, d.to]));
    assert.strictEqual(found.length, 2, JSON.stringify(found));
    assert.ok(found.some((c) => c.length === 2 && c.includes('src/core/retention.ts')));
    assert.ok(found.some((c) => c.length === 3 && c.every((f) => f.startsWith('packages/ui/src/components/'))));
  });

  test('the example plan has three epics over a month, a blocked chain, and an epic with everything done', () => {
    const p = syntheticPlanGraph();
    const epics = p.items.filter((i) => i.kind === 'epic');
    assert.strictEqual(epics.length, 3);
    assert.ok(p.items.length >= 25 && p.items.length <= 35, `${p.items.length} items`);
    const times = p.items.map((i) => Date.parse(i.created!));
    assert.ok((Math.max(...times) - Math.min(...times)) / 86_400_000 >= 25, 'spread over about a month');
    assert.ok(p.items.every((i) => (i.status === 'done') === !!i.closed || i.status === 'dropped'), 'done items have a close time');
    const ui = p.items.filter((i) => i.parent === 'ex-2');
    assert.ok(ui.length > 3 && ui.every((i) => i.status === 'done'), 'every UI item is done');
    assert.strictEqual(epics.find((e) => e.id === 'ex-2')!.status, 'done');
    // A chain of blocks three long, ending in a blocked item.
    const blocks = p.links.filter((l) => l.kind === 'blocks');
    const next = (id: string) => blocks.filter((l) => l.from === id).map((l) => l.to);
    assert.ok(next('ex-1.4').includes('ex-1.5') && next('ex-1.5').includes('ex-1.6') && next('ex-1.6').includes('ex-3.4'));
    for (const s of ['open', 'in_progress', 'blocked', 'done', 'deferred', 'dropped']) assert.ok(p.items.some((i) => i.status === s), s);
  });

  test('the example sessions, code, and plan meet: all three joins find something', () => {
    const events = syntheticEvents();
    const set = new EventSet(events);
    const sessions = syntheticSessionIds().map((id) => set.view(id)!);
    const ws = buildWorkspace({ sessions, events, code: [syntheticCodeGraph()], plans: [syntheticPlanGraph()] });
    const to = (id: string) => qualify(SYNTHETIC_ROOT, id);
    assert.ok(ws.joins.sessionToCode.some((j) => j.to === to('src/core/retention.ts') && !j.inferred), 'sessions edited retention.ts');
    assert.ok(ws.joins.sessionToCode.some((j) => j.to === to('docs/usage.md')));
    assert.ok(ws.joins.planToCode.some((j) => j.from === qualify('example-plan', 'ex-1.3') && j.to === to('src/core/retention.ts')));
    assert.ok(ws.joins.planToSession.some((j) => j.from === qualify('example-plan', 'ex-1.3')), 'the item titled like a prompt finds its session');
    // Every path the plan names is in the code.
    const paths = new Set(syntheticCodeGraph().artifacts.map((a) => a.path).filter(Boolean));
    for (const i of syntheticPlanGraph().items) for (const p of i.refs?.paths ?? []) assert.ok(paths.has(p), `${i.id} names ${p}`);
  });

  test('both draw as Shapes', () => {
    const code = shapeOfCode(syntheticCodeGraph(), 'package');
    assert.ok(code.nodes.find((n) => n.id === SYNTHETIC_ROOT)!.value > 5000);
    assert.ok(code.links.length >= 4);
    const plan = shapeOfPlan(syntheticPlanGraph());
    assert.strictEqual(plan.nodes.find((n) => n.id === 'ex-1')!.value, 9);
  });

  let failures = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (err) {
      failures += 1;
      console.error(`FAIL  ${name}`);
      console.error(err);
    }
  }
  console.log(`\n${tests.length - failures}/${tests.length} passed`);
  if (failures > 0) process.exit(1);
}

main();
