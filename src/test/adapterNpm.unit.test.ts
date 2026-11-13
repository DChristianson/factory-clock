import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { npmAdapter, packageOfSpecifier, scanScript } from '../adapters/code/npm';
import { ProjectFile } from '../model/adapter';
import { CodeGraph, checkCodeGraph } from '../model/code';

const NOW = '2026-11-13T10:00:00Z';
const file = (p: string, text: string): ProjectFile => ({ path: p, text, bytes: Buffer.byteLength(text) });
const json = (x: unknown) => JSON.stringify(x, null, 2);

// A monorepo: two workspace packages, the app importing the core by name.
function monorepo(): ProjectFile[] {
  return [
    file('package.json', json({ name: 'mono', private: true, workspaces: ['packages/*'], devDependencies: { typescript: '^5.0.0' } })),
    file('.gitignore', 'node_modules\n'),
    file('README.md', '# mono\n'),
    file('packages/core/package.json', json({ name: '@mono/core', dependencies: { lodash: '^4' }, peerDependencies: { react: '*' } })),
    file(
      'packages/core/src/index.ts',
      ["export * from './util.js';", "export { b } from './lib';", "import { c } from './exact.js';", "export const all = c;", ''].join('\n'),
    ),
    file(
      'packages/core/src/util.ts',
      [
        "import fp from 'lodash/fp';",
        "import { readFileSync } from 'node:fs';",
        "import * as path from 'path';",
        "import { deep } from '@scope/pkg/deep/er';",
        "// import gone from './gone';",
        "/* const nope = require('./nope');",
        "   import also from './alsogone'; */",
        'const s = "import fake from \'./fake\'";',
        "const re = /['\"]/g; const t = `x ${s.replace(re, '')} y`;",
        "export const lazy = () => import('./lazy');",
        "import { missing } from './missing';",
        "export const a = 1; export const deps = [fp, readFileSync, path, deep, t];",
        '',
      ].join('\n'),
    ),
    file('packages/core/src/lib/index.ts', 'export const b = 2;\n'),
    file('packages/core/src/exact.js', 'exports.c = 3;\n'),
    file('packages/core/src/lazy.ts', 'export default 4;\n'),
    file('packages/core/test/util.test.ts', "import { a } from '../src/util';\nimport type { T } from '../src/util';\nimport assert = require('assert');\n"),
    file('packages/app/package.json', json({ name: 'app', dependencies: { '@mono/core': '*' }, devDependencies: { vitest: '^1' } })),
    file('packages/app/tsconfig.json', '{}\n'),
    file('packages/app/data.json', '{}\n'),
    file('packages/app/vite.config.ts', "import { defineConfig } from 'vite';\nexport default defineConfig({});\n"),
    file('packages/app/README.md', '# app\n'),
    file('packages/app/src/main.ts', '/// <reference path="./types.d.ts" />\nimport { all } from \'@mono/core\';\nimport { b } from \'@mono/core/lib\';\nconsole.log(all, b);\n'),
    file('packages/app/src/types.d.ts', 'declare const X: number;\n'),
    file('packages/app/src/ui/button.tsx', "import React from 'react';\nexport const Button = () => null;\n"),
    file('packages/app/src/ui/button.spec.tsx', "import { Button } from './button';\n"),
    file('packages/app/styles/site.css', 'body {}\n'),
    file('packages/app/dist/main.js', "require('./chunk');\n"),
    file('node_modules/left-pad/package.json', json({ name: 'left-pad' })),
    file('node_modules/left-pad/index.js', 'module.exports = 1;\n'),
  ];
}

// Factory Clock's shape: a page that loads scripts which talk through globals.
function globalsProject(): ProjectFile[] {
  return [
    file('package.json', json({ name: 'page' })),
    file('theme.css', '/* colors; see web/app.js */\nbody {}\n'),
    file('lib/helper.js', 'var helper = 1;\n'),
    file('web/old.js', 'var old = 1;\n'),
    file('web/app.js', '// draws things (see lib/helper.js).\nvar app = helper;\n// see nowhere/missing.js\n'),
    file('web/style.css', 'body {}\n'),
    file(
      'web/index.html',
      [
        '<!doctype html>',
        '<link rel="stylesheet" href="style.css">',
        '<link rel="stylesheet" href="theme.css">',
        '<link rel="stylesheet" href="https://example.com/x.css">',
        '<!-- <script src="old.js"></script> -->',
        '<script src="app.js?v=2"></script>',
        '',
      ].join('\n'),
    ),
  ];
}

const read = (files: ProjectFile[], hints?: string[]) => npmAdapter.read(files, { name: 'fixture', now: NOW, hints });
const art = (g: CodeGraph, id: string) => {
  const a = g.artifacts.find((x) => x.id === id);
  assert.ok(a, `no artifact ${id}`);
  return a;
};
const dep = (g: CodeGraph, from: string, to: string, kind?: string) => g.dependencies.find((d) => d.from === from && d.to === to && (kind === undefined || d.kind === kind));
const clean = (g: CodeGraph) => assert.deepStrictEqual(checkCodeGraph(JSON.parse(JSON.stringify(g))).errors, []);

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  test('detect: a package.json anywhere, but not only under node_modules', () => {
    assert.strictEqual(npmAdapter.id, 'npm');
    assert.strictEqual(npmAdapter.subject, 'code');
    assert.ok(npmAdapter.detect(monorepo()));
    assert.ok(npmAdapter.detect([file('sub/dir/package.json', '{}')]));
    assert.ok(!npmAdapter.detect([file('README.md', '# x'), file('src/a.ts', '')]));
    assert.ok(!npmAdapter.detect([file('node_modules/x/package.json', '{}')]));
  });

  test('source, and the graph checks clean', () => {
    const g = read(monorepo());
    assert.deepStrictEqual(g.source, { adapter: 'npm', root: 'fixture', generatedAt: NOW, tool: 'npm' });
    clean(g);
    for (const a of g.artifacts) if (a.path !== undefined) assert.ok(!a.path.startsWith('/') && !a.path.startsWith('./'), a.path);
    assert.ok(!g.artifacts.some((a) => a.id.includes('node_modules')), 'node_modules is ignored');
  });

  test('workspace, packages, modules and files in a hierarchy', () => {
    const g = read(monorepo());
    const ws = art(g, 'workspace:mono');
    assert.strictEqual(ws.kind, 'workspace');
    assert.strictEqual(art(g, 'mono').parent, 'workspace:mono');
    assert.deepStrictEqual(art(g, '@mono/core'), { id: '@mono/core', kind: 'package', name: '@mono/core', path: 'packages/core', parent: 'workspace:mono' });
    assert.strictEqual(art(g, 'app').parent, 'workspace:mono');
    assert.deepStrictEqual(art(g, 'packages/core/src'), { id: 'packages/core/src', kind: 'module', name: 'src', path: 'packages/core/src', parent: '@mono/core' });
    assert.strictEqual(art(g, 'packages/core/src/lib').parent, 'packages/core/src');
    assert.strictEqual(art(g, 'packages/app/src/ui').parent, 'packages/app/src');
    assert.ok(!g.artifacts.some((a) => a.id === 'packages/app/styles'), 'a folder with no scripts is not a module');
    assert.ok(!g.artifacts.some((a) => a.kind === 'module' && a.id === 'packages/core'), 'a package folder is not a module');
    const util = art(g, 'packages/core/src/util.ts');
    assert.strictEqual(util.parent, 'packages/core/src');
    assert.strictEqual(util.language, 'ts');
    assert.strictEqual(util.size?.lines, 12);
    assert.strictEqual(util.size?.bytes, monorepo().find((f) => f.path === 'packages/core/src/util.ts')!.bytes);
    assert.strictEqual(art(g, 'packages/app/styles/site.css').parent, 'app');
    assert.strictEqual(art(g, 'README.md').parent, 'mono');
    assert.strictEqual(art(g, 'packages/app/src/ui/button.tsx').language, 'tsx');
  });

  test('roles from paths', () => {
    const g = read(monorepo());
    const roles: Record<string, string> = {
      'packages/core/src/util.ts': 'source',
      'packages/core/test/util.test.ts': 'test',
      'packages/app/src/ui/button.spec.tsx': 'test',
      'README.md': 'doc',
      'packages/app/README.md': 'doc',
      'package.json': 'config',
      '.gitignore': 'config',
      'packages/app/tsconfig.json': 'config',
      'packages/app/data.json': 'config',
      'packages/app/vite.config.ts': 'config',
      'packages/app/styles/site.css': 'asset',
      'packages/app/dist/main.js': 'generated',
    };
    for (const [id, role] of Object.entries(roles)) assert.strictEqual(art(g, id).role, role, id);
  });

  test('relative imports resolve: exact, .js meaning .ts, index files; misses are skipped', () => {
    const g = read(monorepo());
    // Following TypeScript's rules (.js meaning .ts, an added extension, an index file) isn't a guess.
    assert.deepStrictEqual(dep(g, 'packages/core/src/index.ts', 'packages/core/src/util.ts'), { from: 'packages/core/src/index.ts', to: 'packages/core/src/util.ts', kind: 'import', weight: 1 });
    assert.strictEqual(dep(g, 'packages/core/src/index.ts', 'packages/core/src/lib/index.ts')?.inferred, undefined);
    assert.deepStrictEqual(dep(g, 'packages/core/src/index.ts', 'packages/core/src/exact.js'), { from: 'packages/core/src/index.ts', to: 'packages/core/src/exact.js', kind: 'import', weight: 1 });
    assert.strictEqual(dep(g, 'packages/core/src/util.ts', 'packages/core/src/lazy.ts')?.kind, 'import', 'dynamic import');
    assert.strictEqual(dep(g, 'packages/core/test/util.test.ts', 'packages/core/src/util.ts')?.weight, 2, 'two statements');
    assert.strictEqual(dep(g, 'packages/app/src/main.ts', 'packages/app/src/types.d.ts')?.inferred, undefined, 'reference path, exact');
    assert.ok(dep(g, 'packages/app/src/ui/button.spec.tsx', 'packages/app/src/ui/button.tsx'));
    assert.ok(!g.dependencies.some((d) => d.from === 'packages/app/dist/main.js'), 'unresolvable import skipped');
    assert.ok(!g.artifacts.some((a) => /missing|chunk/.test(a.id)), 'nothing invented');
  });

  test('an import is a guess only when the rules leave more than one file it could mean', () => {
    const file = (path: string, text = '') => ({ path, text, bytes: text.length });
    const g = read([
      file('package.json', '{"name":"amb"}'),
      file('src/main.ts', "import './a';\nimport './b';\nimport './c';\n"),
      file('src/a.ts'), file('src/a.js'),           // two files for './a'
      file('src/b.ts'), file('src/b/index.ts'),     // a file and a folder for './b'
      file('src/c.ts'), file('src/c.d.ts'),         // a module and its types: one module
    ]);
    assert.deepStrictEqual(dep(g, 'src/main.ts', 'src/a.ts'), { from: 'src/main.ts', to: 'src/a.ts', kind: 'import', weight: 1, inferred: true });
    assert.deepStrictEqual(dep(g, 'src/main.ts', 'src/b.ts'), { from: 'src/main.ts', to: 'src/b.ts', kind: 'import', weight: 1, inferred: true });
    assert.deepStrictEqual(dep(g, 'src/main.ts', 'src/c.ts'), { from: 'src/main.ts', to: 'src/c.ts', kind: 'import', weight: 1 });
  });

  test('comments and strings are not imports', () => {
    const g = read(monorepo());
    const out = g.dependencies.filter((d) => d.from === 'packages/core/src/util.ts').map((d) => d.to);
    assert.deepStrictEqual(out, ['node:fs', 'node:path', 'npm:@scope/pkg', 'npm:lodash', 'packages/core/src/lazy.ts']);
    const s = scanScript("// import a from 'x'\n/* require('y') */\nconst q = \"from 'z'\";\nconst r = /from 'w'/;\nconst t = `${'{'}` + `import('v')`;\nx.require('u');\nimport 'real';\n");
    assert.deepStrictEqual(s.specifiers, ['real']);
    assert.deepStrictEqual(scanScript("import {\n  a,\n  b,\n} from './multi';\nconst m = 2 / 3; import('./after');").specifiers, ['./multi', './after']);
  });

  test('externals: bare imports and manifests; scoped and node: builtins', () => {
    const g = read(monorepo());
    assert.strictEqual(packageOfSpecifier('@a/b/c'), '@a/b');
    assert.strictEqual(packageOfSpecifier('lodash/fp'), 'lodash');
    assert.strictEqual(packageOfSpecifier('fs/promises'), 'node:fs');
    assert.strictEqual(packageOfSpecifier('node:test'), 'node:test');
    assert.strictEqual(packageOfSpecifier('https://x.com/a.js'), null);
    const externals = g.artifacts.filter((a) => a.kind === 'external').map((a) => a.id);
    assert.deepStrictEqual(externals, ['node:assert', 'node:fs', 'node:path', 'npm:@scope/pkg', 'npm:lodash', 'npm:react', 'npm:typescript', 'npm:vite', 'npm:vitest']);
    assert.deepStrictEqual(art(g, 'npm:@scope/pkg'), { id: 'npm:@scope/pkg', kind: 'external', name: '@scope/pkg' });
    assert.ok(!externals.includes('npm:@mono/core'), 'a workspace package is not an external');
  });

  test('a workspace package imported by name links to the package', () => {
    const g = read(monorepo());
    assert.deepStrictEqual(dep(g, 'packages/app/src/main.ts', '@mono/core'), { from: 'packages/app/src/main.ts', to: '@mono/core', kind: 'import', weight: 2 });
    assert.ok(dep(g, 'app', '@mono/core', 'runtime'), 'manifest dependency on a workspace package');
  });

  test('manifest dependencies: runtime and dev', () => {
    const g = read(monorepo());
    assert.deepStrictEqual(dep(g, '@mono/core', 'npm:lodash'), { from: '@mono/core', to: 'npm:lodash', kind: 'runtime', weight: 1 });
    assert.strictEqual(dep(g, '@mono/core', 'npm:react')?.kind, 'runtime', 'peer');
    assert.strictEqual(dep(g, 'app', 'npm:vitest')?.kind, 'dev');
    assert.strictEqual(dep(g, 'mono', 'npm:typescript')?.kind, 'dev');
  });

  test('an unnamed package goes by its folder, the root by the project name', () => {
    const g = read([file('package.json', '{}'), file('tools/package.json', 'not json'), file('tools/x.js', ''), file('a.js', "require('./tools/x')")]);
    clean(g);
    assert.strictEqual(art(g, 'fixture').kind, 'package');
    assert.deepStrictEqual(art(g, 'tools'), { id: 'tools', kind: 'package', name: 'tools', path: 'tools', parent: 'fixture' });
    assert.strictEqual(art(g, 'tools/x.js').parent, 'tools');
    assert.ok(!g.artifacts.some((a) => a.kind === 'workspace'));
  });

  test("the 'globals' hint: pages to what they load, comments to what they see", () => {
    assert.ok(!read(globalsProject()).dependencies.some((d) => d.kind === 'reference'), 'off by default');
    const g = read(globalsProject(), ['globals']);
    clean(g);
    const refs = g.dependencies.filter((d) => d.kind === 'reference').map((d) => `${d.from} -> ${d.to}`);
    assert.deepStrictEqual(refs, ['theme.css -> web/app.js', 'web/app.js -> lib/helper.js', 'web/index.html -> theme.css', 'web/index.html -> web/app.js', 'web/index.html -> web/style.css']);
    assert.ok(g.dependencies.filter((d) => d.kind === 'reference').every((d) => d.inferred === true));
  });

  test('deterministic: two reads deep-equal, input order does not matter', () => {
    const a = read(monorepo());
    const b = read(monorepo().reverse());
    assert.deepStrictEqual(a, b);
    assert.deepStrictEqual(JSON.stringify(a), JSON.stringify(read(monorepo())));
  });

  test('smoke: this repository', () => {
    const root = path.resolve(__dirname, '..', '..');
    const skip = new Set(['.git', 'node_modules', 'out', 'site', '.beads', 'worktrees']);
    const binary = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|pdf|zip|gz)$/i;
    const files: ProjectFile[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile() && !binary.test(e.name)) {
          const buf = fs.readFileSync(full);
          files.push({ path: path.relative(root, full).split(path.sep).join('/'), text: buf.toString('utf8'), bytes: buf.length });
        }
      }
    };
    walk(root);
    assert.ok(npmAdapter.detect(files));
    const g = npmAdapter.read(files, { name: 'factory-clock', now: NOW });
    clean(g);
    assert.ok(dep(g, 'src/model/workspace.ts', 'src/model/code.ts', 'import'), 'workspace.ts imports code.ts');
    assert.strictEqual(art(g, 'npm:esbuild').kind, 'external');
    assert.strictEqual(art(g, 'src/adapters/code/npm.ts').role, 'source');
    assert.strictEqual(art(g, 'src/test/model.unit.test.ts').role, 'test');
    const h = npmAdapter.read(files, { name: 'factory-clock', now: NOW, hints: ['globals'] });
    clean(h);
    const fromPage = h.dependencies.filter((d) => d.from === 'hosts/web/index.html' && d.kind === 'reference').map((d) => d.to);
    assert.ok(fromPage.length > 0, 'index.html references something');
    assert.ok(fromPage.includes('hosts/web/web.css'), fromPage.join(', '));
    assert.ok(fromPage.includes('vizkit.js'), fromPage.join(', '));
    assert.ok(dep(h, 'viz/registry.js', 'docs/visualization-explorer.md', 'reference'), 'a see-line');
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
