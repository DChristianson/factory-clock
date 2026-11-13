import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { SessionView } from '../schema';
import { creditRows } from '../web/credits';
import { buildExplorerState, CATALOG, Credit, creditCite, creditName, TAXONOMY, unusedValues, validateCatalog, VisualizerEntry } from '../index';

// Factory Clock's catalog and explorer state.

const entry = (over: Partial<VisualizerEntry>): VisualizerEntry => ({ ...CATALOG[0], ...over });

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('the catalog conforms to the taxonomy', () => {
    assert.deepStrictEqual(validateCatalog(CATALOG, TAXONOMY), []);
    assert.deepStrictEqual(Object.keys(TAXONOMY), ['subject', 'category', 'purpose', 'level', 'dimension', 'language']);
    assert.deepStrictEqual(Object.keys(TAXONOMY.category.values), ['temporal', 'actor', 'conversational', 'dependency', 'quantitative', 'state', 'semantic']);
    assert.deepStrictEqual(CATALOG.map((v) => v.id), ['turn-tree', 'context-timeline', 'session-strips', 'cost-per-prompt', 'context-fill', 'sequence-diagram', 'event-graph', 'actor-graph', 'prompt-terms', 'gantt', 'treemap', 'heatmap', 'tool-ribbon', 'week-picture', 'histogram', 'box-violin', 'ridgeline', 'scatter', 'bubble', 'sunburst', 'calendar-heatmap', 'radar', 'parallel-coords', 'streamgraph', 'sankey', 'adjacency-matrix', 'swimlane', 'dependency-layers', 'package-wheel', 'file-grid', 'plan-over-code', 'blocking-graph', 'roadmap', 'status-strips', 'burn-up', 'confidence-map', 'living-network', 'session-fingerprint', 'conversation-landscape', 'terminal-board', 'factory-clock']);
  });

  test('only hero views leave the standard design language, each with a language of its own, and they come last', () => {
    const heroes: Record<string, string> = { 'living-network': 'cinematic', 'session-fingerprint': 'risograph', 'conversation-landscape': 'edgeless', 'terminal-board': 'split-flap', 'factory-clock': 'horology' };
    assert.deepStrictEqual(Object.keys(TAXONOMY.language.values), ['standard', ...Object.values(heroes)]);
    for (const v of CATALOG) assert.deepStrictEqual(v.tags.language, [heroes[v.id] ?? 'standard'], v.id);
    const firstHero = CATALOG.findIndex((v) => v.id in heroes);
    assert.ok(CATALOG.slice(firstHero).every((v) => v.id in heroes), 'no standard view after the first hero');
  });

  test('hero is set on exactly the hero views, and the five session heroes stay heroes', () => {
    assert.deepStrictEqual(CATALOG.filter((v) => v.hero).map((v) => v.id), ['living-network', 'session-fingerprint', 'conversation-landscape', 'terminal-board', 'factory-clock']);
    assert.ok(CATALOG.every((v) => v.hero === true || v.hero === undefined));
  });

  test('every view says why to look at it, in one sentence', () => {
    for (const v of CATALOG) {
      assert.ok(v.why.length > 20 && v.why.length < 140, `${v.id}: ${v.why.length} characters`);
      assert.match(v.why, /^[A-Z].*\.$/, v.id);
      assert.ok(!/\.\s+[A-Z]/.test(v.why), `${v.id}: one sentence`);
    }
  });

  test('every vocabulary value is used by some view, so no chip matches nothing', () => {
    assert.deepStrictEqual(unusedValues(CATALOG, TAXONOMY), []);
    assert.deepStrictEqual(unusedValues([CATALOG[0]], TAXONOMY).includes('language:horology'), true);
  });

  test('every view credits prior art, and only prior art: never this project or its own design docs', () => {
    for (const v of CATALOG) {
      assert.ok(v.credits.length > 0, v.id);
      for (const c of v.credits) {
        if (c.url) assert.match(c.url, /^https:\/\//, `${v.id}: ${c.work}`);
        assert.ok(!/DChristianson|ChatGPT|factory-clock|snagboat/i.test(`${c.by} ${c.url ?? ''}`), `${v.id}: ${c.work} credits this project`);
      }
    }
    const treemap = CATALOG.find((v) => v.id === 'treemap')!;
    assert.deepStrictEqual(treemap.credits.map(creditCite), ['Shneiderman 1992', 'Bruls et al. 2000']);
  });

  test('a credit cites its people by last name, or by the short form it gives', () => {
    assert.strictEqual(creditName('Danny Holten'), 'Holten');
    assert.strictEqual(creditName('Richard Wettel and Michele Lanza'), 'Wettel & Lanza');
    assert.strictEqual(creditName('Susan Havre, Beth Hetzler, and Lucy Nowell'), 'Havre et al.');
    assert.strictEqual(creditName('Karen Spärck Jones (Spärck Jones)'), 'Spärck Jones');
    const c: Credit = { work: 'Gantt chart', by: 'Henry L. Gantt', relation: 'form' };
    assert.strictEqual(creditCite(c), 'Gantt');
    assert.strictEqual(creditCite({ ...c, year: 1910 }), 'Gantt 1910');
  });

  test('the puck’s After line names credits as the catalog does', () => {
    // explore.js is a plain browser script with its own copy of creditName.
    const source = fs.readFileSync(path.resolve(__dirname, '..', '..', 'explore.js'), 'utf8');
    const fn = /\n  function creditName\(by\) \{[\s\S]*?\n  \}\n/.exec(source);
    assert.ok(fn, 'explore.js has creditName');
    const sandbox: { creditName?: (by: string) => string } = {};
    vm.runInNewContext(`${fn[0]}\nthis.creditName = creditName;`, sandbox);
    for (const c of CATALOG.flatMap((v) => v.credits)) assert.strictEqual(sandbox.creditName!(c.by), creditName(c.by), c.by);
  });

  test('the Credits list has a row per view, in carousel order, with every credit', () => {
    const rows = creditRows(CATALOG);
    assert.deepStrictEqual(rows.map((r) => r.id), CATALOG.map((v) => v.id));
    for (const [i, r] of rows.entries()) assert.strictEqual(r.credits.length, CATALOG[i].credits.length, r.id);
    const sankey = rows.find((r) => r.id === 'sankey')!;
    assert.deepStrictEqual(sankey.credits[0], { cite: 'Sankey 1898', detail: 'The Thermal Efficiency of Steam Engines, Matthew H. P. R. Sankey. The Sankey diagram, in Kennedy and Sankey’s report to the Institution of Civil Engineers', url: 'https://doi.org/10.1680/imotp.1898.19100', relation: 'form' });
  });

  test('a broken catalog names each problem', () => {
    const problems = (catalog: VisualizerEntry[]) => validateCatalog(catalog, TAXONOMY);
    assert.strictEqual(problems([CATALOG[0], CATALOG[0]]).length, 1);
    assert.match(problems([CATALOG[0], CATALOG[0]])[0], /duplicate id "turn-tree"/);
    assert.match(problems([entry({ tags: { ...CATALOG[0].tags, purpose: [] } })])[0], /"purpose" is missing or empty/);
    const missing = { ...CATALOG[0].tags } as Partial<VisualizerEntry['tags']>;
    delete missing.level;
    assert.match(problems([entry({ tags: missing as VisualizerEntry['tags'] })])[0], /"level" is missing or empty/);
    assert.match(problems([entry({ tags: { ...CATALOG[0].tags, category: ['temporal', 'musical'] } })])[0], /"musical" is not a category value/);
    assert.match(problems([entry({ title: '' })])[0], /empty title/);
    assert.match(problems([entry({ description: '' })])[0], /empty description/);
    assert.match(problems([entry({ id: '' })])[0], /no id/);
    assert.match(problems([entry({ why: ' ' })])[0], /empty why/);
    assert.match(problems([entry({ thumbnail: 'poster' as 'live' })])[0], /thumbnail is not live or title/);
    assert.match(problems([entry({ hero: 'yes' as unknown as boolean })])[0], /hero is not true or false/);
    assert.match(problems([entry({ tags: { ...CATALOG[0].tags, mood: ['calm'] } as VisualizerEntry['tags'] })])[0], /"mood" is not a facet/);
    const credit: Credit = { work: 'Tree visualization with tree-maps', by: 'Ben Shneiderman', year: 1992, url: 'https://doi.org/10.1145/102377.115768', relation: 'form' };
    assert.deepStrictEqual(problems([entry({ credits: [credit] })]), []);
    assert.match(problems([entry({ credits: [{ ...credit, relation: 'design' as 'form' }] })])[0], /"design" is not a relation/);
    assert.match(problems([entry({ credits: [] })])[0], /turn-tree: no credits/);
    assert.match(problems([entry({ credits: undefined as unknown as Credit[] })])[0], /no credits/);
    assert.match(problems([entry({ credits: [{ ...credit, relation: 'homage' as 'form' }] })])[0], /credit 1: "homage" is not a relation/);
    assert.match(problems([entry({ credits: [credit, { ...credit, url: 'http://doi.org/10.1145/102377.115768' }] })])[0], /credit 2: url is not https/);
    assert.match(problems([entry({ credits: [{ ...credit, url: 'https://' }] })])[0], /url is not https/);
    assert.match(problems([entry({ credits: [{ ...credit, work: ' ' }] })])[0], /credit 1 has no work/);
    assert.match(problems([entry({ credits: [{ ...credit, by: '' }] })])[0], /credit 1 has no by/);
    assert.match(problems([entry({ credits: [{ ...credit, year: 92 }] })])[0], /year is not a year/);
    assert.match(problems([entry({ credits: [{ ...credit, note: '' }] })])[0], /empty note/);
  });

  test('the explorer state keeps the picked order and names the ids without a view', () => {
    const views: Record<string, SessionView> = { a: { summary: { sessionId: 'a' } } as SessionView, c: { summary: { sessionId: 'c' } } as SessionView };
    const state = buildExplorerState(['c', 'b', 'a'], (id) => views[id]);
    assert.deepStrictEqual(state.sessions.map((s) => s.summary.sessionId), ['c', 'a']);
    assert.deepStrictEqual(state.notLoaded, ['b']);
    assert.strictEqual(state.catalog, CATALOG);
    assert.strictEqual(state.taxonomy, TAXONOMY);
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
