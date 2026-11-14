import * as assert from 'assert';
import * as vm from 'vm';
import { NormalizedEvent } from '../schema';
import { CodeGraph, PlanGraph } from '../model';
import {
  SYNTHETIC_WORKSPACE_NAME,
  WorkspacePackage,
  WorkspaceStore,
  checkWorkspacePackage,
  makeWorkspacePackage,
  readRegisteredWorkspace,
  readWorkspaceIndex,
  syntheticCodeGraph,
  syntheticEvents,
  syntheticPlanGraph,
  syntheticWorkspacePackage,
  timeRangeOf,
  workspaceId,
  workspaceIndexScript,
  workspaceScript,
} from '../web';

// Workspace packages, their time range, and the store that groups them by name and range.

const ev = (id: string, ts: string, sessionId = 's1'): NormalizedEvent => ({ eventId: id, sessionId, agent: 'claude-code', kind: 'user_prompt', ts, status: 'unknown' } as NormalizedEvent);

const code = (generatedAt: string): CodeGraph => ({ kind: 'code-graph', version: 1, source: { adapter: 'npm', root: 'proj', generatedAt }, artifacts: [{ id: 'proj', kind: 'package', name: 'proj' }], dependencies: [] });

const plan = (generatedAt: string, items: Array<{ id: string; created?: string; updated?: string; closed?: string }>): PlanGraph => ({
  kind: 'plan-graph',
  version: 1,
  source: { adapter: 'beads', root: 'proj-plan', generatedAt },
  items: items.map((i) => ({ ...i, kind: 'task', title: i.id, status: 'open', confidence: 'observed' })),
  links: [],
});

const SOURCE = { tool: 'test', generatedAt: '2026-11-14T00:00:00.000Z' };

const pkg = (name: string, events: NormalizedEvent[], extra: { code?: CodeGraph[]; plans?: PlanGraph[] } = {}) => makeWorkspacePackage({ name, source: SOURCE, events, ...extra });

/** A package as it would arrive from a file: plain JSON. */
const asRead = (p: unknown) => JSON.parse(JSON.stringify(p));

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  // Time range

  test('the range is the first and last event, whatever order they come in', () => {
    const r = timeRangeOf({ events: [ev('b', '2026-11-03T10:00:00Z'), ev('a', '2026-11-01T09:00:00.000Z'), ev('c', '2026-11-02T00:00:00Z')] });
    assert.deepStrictEqual(r, { range: { first: '2026-11-01T09:00:00.000Z', last: '2026-11-03T10:00:00.000Z' }, unparsed: 0 });
  });

  test('timestamps are normalized to UTC ISO, so the same instant written two ways is one range', () => {
    const a = timeRangeOf({ events: [ev('a', '2026-11-01T10:00:00+01:00')] }).range;
    const b = timeRangeOf({ events: [ev('a', '2026-11-01T09:00:00.000Z')] }).range;
    assert.deepStrictEqual(a, b);
    assert.strictEqual(a!.first, '2026-11-01T09:00:00.000Z');
  });

  test('one event gives a range of one instant', () => {
    assert.deepStrictEqual(timeRangeOf({ events: [ev('a', '2026-11-01T09:00:00Z')] }).range, { first: '2026-11-01T09:00:00.000Z', last: '2026-11-01T09:00:00.000Z' });
  });

  test('nothing with a time gives no range', () => {
    assert.deepStrictEqual(timeRangeOf({}), { range: null, unparsed: 0 });
    assert.deepStrictEqual(timeRangeOf({ events: [], code: [], plans: [] }), { range: null, unparsed: 0 });
  });

  test('timestamps that do not parse are skipped and counted', () => {
    const r = timeRangeOf({ events: [ev('a', 'yesterday'), ev('b', '2026-11-02T00:00:00Z'), ev('c', '')] });
    assert.deepStrictEqual(r, { range: { first: '2026-11-02T00:00:00.000Z', last: '2026-11-02T00:00:00.000Z' }, unparsed: 2 });
    assert.deepStrictEqual(timeRangeOf({ events: [ev('a', 'never')] }), { range: null, unparsed: 1 });
  });

  test('plan item times are events too, and widen the range', () => {
    const r = timeRangeOf({
      events: [ev('a', '2026-11-05T00:00:00Z')],
      plans: [plan('2026-12-01T00:00:00Z', [{ id: 'x', created: '2026-10-01T00:00:00Z', closed: '2026-11-10T00:00:00Z' }, { id: 'y', updated: 'bad' }])],
    });
    assert.deepStrictEqual(r, { range: { first: '2026-10-01T00:00:00.000Z', last: '2026-11-10T00:00:00.000Z' }, unparsed: 1 });
  });

  test('graphs’ generatedAt stand in only when nothing else has a time', () => {
    // With an event, generatedAt is ignored.
    assert.deepStrictEqual(timeRangeOf({ events: [ev('a', '2026-11-05T00:00:00Z')], code: [code('2027-01-01T00:00:00Z')] }).range, { first: '2026-11-05T00:00:00.000Z', last: '2026-11-05T00:00:00.000Z' });
    // Code alone, and a plan whose items have no times: the graphs' times.
    const r = timeRangeOf({ code: [code('2026-11-07T00:00:00Z')], plans: [plan('2026-11-06T00:00:00Z', [{ id: 'x' }])] });
    assert.deepStrictEqual(r.range, { first: '2026-11-06T00:00:00.000Z', last: '2026-11-07T00:00:00.000Z' });
  });

  // Identity, grouping, duplicates

  test('the id names the name and the range, and differs when either does', () => {
    const r = { first: '2026-11-01T00:00:00.000Z', last: '2026-11-02T00:00:00.000Z' };
    assert.strictEqual(workspaceId('proj', r), 'proj @ 2026-11-01T00:00:00.000Z..2026-11-02T00:00:00.000Z');
    assert.strictEqual(workspaceId('proj', null), 'proj @ -');
    assert.notStrictEqual(workspaceId('proj', r), workspaceId('proj', { ...r, last: '2026-11-03T00:00:00.000Z' }));
    assert.notStrictEqual(workspaceId('proj', r), workspaceId('proj2', r));
  });

  test('the store groups by name, alphabetically, and each group newest first, no range last', () => {
    const store = new WorkspaceStore();
    store.add(pkg('beta', [ev('a', '2026-01-01T00:00:00Z')]), 'built-in');
    store.add(pkg('Alpha', [ev('a', '2026-03-01T00:00:00Z'), ev('b', '2026-03-05T00:00:00Z')]), 'loaded');
    store.add(pkg('Alpha', []), 'loaded');
    store.add(pkg('Alpha', [ev('a', '2026-05-01T00:00:00Z')]), 'built-in');
    store.add(pkg('Alpha', [ev('a', '2026-03-01T00:00:00Z'), ev('b', '2026-03-09T00:00:00Z')]), 'loaded');
    const groups = store.list();
    assert.deepStrictEqual(groups.map((g) => g.name), ['Alpha', 'beta']);
    assert.deepStrictEqual(
      groups[0].entries.map((e) => (e.range ? `${e.range.first.slice(0, 10)}..${e.range.last.slice(0, 10)}` : '-')),
      ['2026-05-01..2026-05-01', '2026-03-01..2026-03-09', '2026-03-01..2026-03-05', '-']
    );
    assert.strictEqual(groups[1].entries.length, 1);
  });

  test('built-in and loaded workspaces share one store and one group', () => {
    const store = new WorkspaceStore();
    store.add(pkg('proj', [ev('a', '2026-01-01T00:00:00Z')]), 'built-in');
    store.add(pkg('proj', [ev('a', '2026-02-01T00:00:00Z')]), 'loaded');
    const [group] = store.list();
    assert.deepStrictEqual(group.entries.map((e) => e.origin), ['loaded', 'built-in']);
  });

  test('a workspace is found by its identity', () => {
    const store = new WorkspaceStore();
    const p = pkg('proj', [ev('a', '2026-01-01T00:00:00Z'), ev('b', '2026-01-02T00:00:00Z')]);
    const { entry } = store.add(p, 'loaded');
    assert.strictEqual(store.get(entry.id), entry);
    assert.strictEqual(store.find('proj', p.range), entry);
    assert.strictEqual(store.find('proj', null), undefined);
    assert.strictEqual(store.get('nope @ -'), undefined);
  });

  test('adding the same identity again replaces it, and says so', () => {
    const store = new WorkspaceStore();
    const first = pkg('proj', [ev('a', '2026-01-01T00:00:00Z'), ev('b', '2026-01-02T00:00:00Z')]);
    const second = pkg('proj', [ev('a', '2026-01-01T00:00:00Z'), ev('m', '2026-01-01T12:00:00Z'), ev('b', '2026-01-02T00:00:00Z')]);
    assert.strictEqual(store.add(first, 'built-in').replaced, false);
    const again = store.add(second, 'loaded');
    assert.strictEqual(again.replaced, true);
    assert.strictEqual(store.list()[0].entries.length, 1);
    assert.strictEqual(store.get(again.entry.id)!.package, second);
    assert.strictEqual(store.get(again.entry.id)!.origin, 'loaded');
  });

  test('a listed site package is filled when loaded, and only by the package the index promised', () => {
    const store = new WorkspaceStore();
    const p = pkg('proj', [ev('a', '2026-01-01T00:00:00Z')]);
    const { entry } = store.addListed({ name: 'proj', range: p.range, file: 'workspaces/proj.js' });
    assert.strictEqual(entry.package, undefined);
    assert.strictEqual(entry.origin, 'built-in');
    assert.throws(() => store.fill(entry.id, pkg('proj', [ev('a', '2026-01-02T00:00:00Z')])), /its package is/);
    assert.strictEqual(store.get(entry.id)!.package, undefined);
    assert.strictEqual(store.fill(entry.id, p).package, p);
    assert.throws(() => store.fill('other @ -', p), /no workspace/);
  });

  // The package check

  test('a good package checks clean', () => {
    const p = pkg('proj', [ev('a', '2026-01-01T00:00:00Z')], { code: [code('2026-01-03T00:00:00Z')], plans: [plan('2026-01-03T00:00:00Z', [{ id: 'x', created: '2025-12-30T00:00:00Z' }])] });
    const c = checkWorkspacePackage(asRead(p));
    assert.deepStrictEqual(c.errors, []);
    assert.deepStrictEqual(c.value, asRead(p));
    assert.deepStrictEqual(c.value!.range, { first: '2025-12-30T00:00:00.000Z', last: '2026-01-01T00:00:00.000Z' });
  });

  test('a package with nothing in it checks clean, with no range', () => {
    const c = checkWorkspacePackage(asRead(pkg('empty', [])));
    assert.deepStrictEqual(c.errors, []);
    assert.strictEqual(c.value!.range, null);
  });

  test('a wrong kind, version, name, source, or contents makes a package unusable', () => {
    const good = asRead(pkg('proj', [ev('a', '2026-01-01T00:00:00Z')]));
    const bad = (patch: Record<string, unknown>, want: RegExp) => {
      const c = checkWorkspacePackage({ ...good, ...patch });
      assert.strictEqual(c.value, undefined, JSON.stringify(patch));
      assert.ok(c.errors.some((e) => want.test(e)), `${JSON.stringify(patch)}: ${c.errors.join('; ')}`);
    };
    assert.deepStrictEqual(checkWorkspacePackage(null).errors, ['not a workspace package (kind is not "workspace-package")']);
    bad({ kind: 'code-graph' }, /not a workspace package/);
    bad({ version: 2 }, /version 2 is not supported/);
    bad({ name: '' }, /name is missing/);
    bad({ name: ' proj' }, /spaces/);
    bad({ name: '/home/me/proj' }, /absolute path/);
    bad({ name: 'x'.repeat(200) }, /longer than/);
    bad({ source: undefined }, /source is missing/);
    bad({ source: { tool: 'x', generatedAt: 'soon' } }, /generatedAt is not a timestamp/);
    bad({ source: { generatedAt: '2026-01-01T00:00:00Z' } }, /source.tool is missing/);
    bad({ events: {} }, /events is not a list/);
    bad({ code: undefined }, /code is not a list/);
  });

  test('broken rows are dropped and reported; the rest is kept', () => {
    const p = asRead(pkg('proj', [ev('a', '2026-01-01T00:00:00Z'), ev('b', '2026-01-04T00:00:00Z')], { code: [code('2026-01-03T00:00:00Z')] }));
    p.events.push({ nope: true }, ev('c', 'whenever'), ev('a', '2026-01-09T00:00:00Z'));
    p.code.push({ kind: 'code-graph', version: 9 });
    p.code[0].dependencies.push({ from: 'proj', to: 'ghost', kind: 'import' });
    const c = checkWorkspacePackage(p);
    assert.deepStrictEqual(c.value!.events.map((e) => e.eventId), ['a', 'b']);
    assert.strictEqual(c.value!.code.length, 1);
    assert.strictEqual(c.value!.code[0].dependencies.length, 0);
    for (const want of [/1 event\(s\) dropped: not an event/, /1 event\(s\) dropped: the time doesn't parse/, /1 event\(s\) dropped: event id seen before/, /code graph 1: code graph version 9/, /code graph 0: dependency 0/]) {
      assert.ok(c.errors.some((e) => want.test(e)), `${want}: ${c.errors.join('; ')}`);
    }
    assert.deepStrictEqual(c.value!.range, { first: '2026-01-01T00:00:00.000Z', last: '2026-01-04T00:00:00.000Z' });
  });

  test('the range is always computed from the contents; a wrong or missing stated range is reported', () => {
    const p = asRead(pkg('proj', [ev('a', '2026-01-01T00:00:00Z')]));
    const right = p.range;
    const wrong = checkWorkspacePackage({ ...p, range: { first: '2020-01-01T00:00:00Z', last: '2030-01-01T00:00:00Z' } });
    assert.deepStrictEqual(wrong.value!.range, right);
    assert.ok(wrong.errors.some((e) => /doesn't match the contents/.test(e)));
    const missing = checkWorkspacePackage({ ...p, range: undefined });
    assert.deepStrictEqual(missing.value!.range, right);
    assert.ok(missing.errors.some((e) => /range is missing/.test(e)));
    // Written another way, the same instants are the same range.
    assert.deepStrictEqual(checkWorkspacePackage({ ...p, range: { first: '2026-01-01T01:00:00+01:00', last: '2026-01-01T00:00:00Z' } }).errors, []);
  });

  // Site package scripts

  test('a package script registers the package under its id, and reads back the same', () => {
    const p = pkg('proj </script> \u2028 \u2029 end', [ev('a', '2026-01-01T00:00:00Z')]);
    const script = workspaceScript(p);
    assert.ok(!script.includes('</script>') && !script.includes('\u2028') && !script.includes('\u2029'));
    const sandbox: Record<string, unknown> = {};
    vm.runInNewContext(script, sandbox);
    vm.runInNewContext(workspaceScript(pkg('other', [])), sandbox);
    const read = readRegisteredWorkspace(sandbox.factoryClockWorkspaces, workspaceId(p.name, p.range));
    assert.deepStrictEqual(read.errors, []);
    assert.deepStrictEqual(asRead(read.value), asRead(p)); // the script's objects are another realm's
    assert.match(readRegisteredWorkspace(sandbox.factoryClockWorkspaces, 'nope @ -').errors[0], /didn't register/);
    assert.match(readRegisteredWorkspace(undefined, 'nope @ -').errors[0], /didn't register/);
  });

  test('the index script lists packages; malformed entries are dropped', () => {
    const range = { first: '2026-01-01T00:00:00.000Z', last: '2026-01-02T00:00:00.000Z' };
    const sandbox: Record<string, unknown> = {};
    vm.runInNewContext(workspaceIndexScript([{ name: 'proj', range, file: 'workspaces/proj-1.js' }]), sandbox);
    assert.deepStrictEqual(asRead(readWorkspaceIndex(sandbox.factoryClockWorkspaceIndex)), [{ name: 'proj', range, file: 'workspaces/proj-1.js' }]);
    assert.deepStrictEqual(readWorkspaceIndex(undefined), []);
    const kept = readWorkspaceIndex([
      { name: 'a', range: null, file: 'workspaces/a.js' },
      { name: 'b', range, file: 'https://elsewhere.example/b.js' },
      { name: 'c', range, file: 'workspaces/../c.js' },
      { name: '', range, file: 'workspaces/d.js' },
      { name: 'e', range: { first: 'x', last: 'y' }, file: 'workspaces/e.js' },
      { name: 'f', file: 'workspaces/f.js' },
    ]);
    assert.deepStrictEqual(kept.map((k) => k.name), ['a']);
  });

  // The synthetic workspace

  test('the synthetic workspace packages the generated sessions, code, and plan, and round-trips', () => {
    const p = syntheticWorkspacePackage();
    assert.strictEqual(p.name, SYNTHETIC_WORKSPACE_NAME);
    assert.deepStrictEqual(p.events, syntheticEvents());
    assert.deepStrictEqual(p.code, [syntheticCodeGraph()]);
    assert.deepStrictEqual(p.plans, [syntheticPlanGraph()]);
    assert.deepStrictEqual(p, syntheticWorkspacePackage(), 'the same every time');
    // The plan spans about a month before the sessions' day, so the range runs from the first plan item to the last session event.
    const firstPlan = Math.min(...p.plans[0].items.map((i) => Date.parse(i.created!)));
    assert.strictEqual(Date.parse(p.range!.first), firstPlan);
    const lastEvent = Math.max(...p.events.map((e) => Date.parse(e.ts)));
    const lastPlan = Math.max(...p.plans[0].items.flatMap((i) => [i.created, i.updated, i.closed]).filter((t): t is string => !!t).map(Date.parse));
    assert.strictEqual(Date.parse(p.range!.last), Math.max(lastEvent, lastPlan));

    const c = checkWorkspacePackage(asRead(p));
    assert.deepStrictEqual(c.errors, []);
    assert.deepStrictEqual(c.value, asRead(p));
    // Through a site script too.
    const sandbox: Record<string, unknown> = {};
    vm.runInNewContext(workspaceScript(p), sandbox);
    assert.deepStrictEqual(asRead(readRegisteredWorkspace(sandbox.factoryClockWorkspaces, workspaceId(p.name, p.range)).value), asRead(p));
    const store = new WorkspaceStore();
    const { entry } = store.add(c.value!, 'built-in');
    assert.deepStrictEqual(store.list(), [{ name: SYNTHETIC_WORKSPACE_NAME, entries: [entry] }]);
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
