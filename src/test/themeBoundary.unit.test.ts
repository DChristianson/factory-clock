import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Factory Clock styles itself with its own --fc-* tokens from theme.css. No file reads a host's
// theme variables, such as VS Code's --vscode-*, from its time inside Snagboat.

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  // Compiled to out/test; the repository root is two levels up.
  const root = path.resolve(__dirname, '..', '..');
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
  const filesUnder = (rel: string): string[] =>
    fs.readdirSync(path.join(root, rel), { withFileTypes: true }).flatMap((e) => {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) return filesUnder(child);
      return /\.(js|ts|css|html)$/.test(e.name) ? [child] : [];
    });
  const pageFiles = [
    'theme.css',
    'viz.css',
    'vizkit.js',
    'explore.js',
    ...filesUnder('viz'),
    ...filesUnder('hosts/web').filter((f) => !f.startsWith('hosts/web/demo/')),
    ...filesUnder('src').filter((f) => !f.startsWith('src/test/')),
  ];

  const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
  const decls = (prefix: string, css: string): Map<string, string> =>
    new Map([...stripComments(css).matchAll(new RegExp(`(${prefix}[\\w-]+)\\s*:\\s*([^;]+);`, 'g'))].map((m) => [m[1], m[2].trim()]));
  const [lightCss, darkCss] = stripComments(read('theme.css')).split('@media (prefers-color-scheme: dark)');
  const light = decls('--fc-', lightCss);
  const dark = decls('--fc-', darkCss ?? '');

  test('no page file reads a VS Code theme variable or theme class', () => {
    assert.ok(pageFiles.length > 40, `found ${pageFiles.length} files`);
    for (const file of pageFiles) {
      const text = read(file);
      assert.ok(!text.includes('--vscode-'), `${file} reads a --vscode-* variable; use a theme token`);
      assert.ok(!/\bvscode-(dark|light|high-contrast)\b/.test(text), `${file} keys on a VS Code theme class`);
    }
  });

  test('theme.css defines every token the page uses, in light and dark', () => {
    assert.ok(darkCss !== undefined, 'theme.css has no prefers-color-scheme: dark block');
    for (const file of pageFiles) {
      for (const [token] of read(file).matchAll(/--fc-[\w-]+/g)) {
        assert.ok(light.has(token), `${file} uses ${token}, which theme.css does not define`);
      }
    }
    for (const token of dark.keys()) assert.ok(light.has(token), `theme.css sets ${token} only in dark`);
    for (const token of light.keys()) {
      if (/-(font|font-size|mono)$/.test(token)) continue;
      assert.ok(dark.has(token), `theme.css has no dark value for ${token}`);
    }
  });

  test('the page loads its theme, then the visualizer styles, then its own styles', () => {
    const links = [...read('hosts/web/index.html').matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
    assert.deepStrictEqual(links, ['theme.css', 'viz.css', 'web.css']);
    assert.ok(read('scripts/site.js').includes("['theme.css', 'theme.css']"), 'site.js does not copy theme.css');
    assert.ok(read('scripts/site.js').includes("['viz.css', 'viz.css']"), 'site.js does not copy viz.css');
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
