import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Factory Clock stands alone. Its TypeScript imports only itself, including its own copy of
// Snagboat's schema in src/schema, which imports only itself. The page loads only its own files:
// no script, style or font from anywhere else, which its security policy also enforces.

async function main() {
  const tests: Array<[string, () => Promise<void> | void]> = [];
  const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

  // Compiled to out/test; the repository root is two levels up.
  const root = path.resolve(__dirname, '..', '..');
  const srcDir = path.join(root, 'src');
  const filesUnder = (dir: string, ext: RegExp): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return filesUnder(full, ext);
      return ext.test(e.name) ? [full] : [];
    });
  const sources = filesUnder(srcDir, /\.ts$/).filter((f) => !f.startsWith(path.join(srcDir, 'test') + path.sep));
  const importsOf = (file: string): string[] =>
    [...fs.readFileSync(file, 'utf8').matchAll(/(?<![\w'".-])(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const rel = (file: string) => path.relative(root, file).split(path.sep).join('/');

  test('the page has its files', () => {
    for (const f of ['src/catalog.ts', 'src/explorerModel.ts', 'src/main.ts', 'src/web/eventSet.ts', 'src/web/page.ts', 'src/web/synthetic.ts', 'src/schema/index.ts', 'src/schema/sessionModel.ts', 'viz/registry.js', 'vizkit.js', 'explore.js', 'viz.css', 'theme.css', 'hosts/web/index.html', 'hosts/web/web.css', 'scripts/site.js']) {
      assert.ok(fs.existsSync(path.join(root, f)), `missing ${f}`);
    }
  });

  test('the TypeScript imports only itself', () => {
    assert.ok(sources.length > 10, `found ${sources.length} files`);
    for (const file of sources) {
      for (const spec of importsOf(file)) {
        assert.ok(spec.startsWith('.'), `${rel(file)} imports ${spec}, outside the repository's sources`);
        const target = path.resolve(path.dirname(file), spec);
        assert.ok(target.startsWith(srcDir + path.sep), `${rel(file)} imports ${spec}, outside src`);
      }
    }
  });

  test('the schema copy imports only itself', () => {
    const schemaDir = path.join(srcDir, 'schema');
    for (const file of sources.filter((f) => f.startsWith(schemaDir + path.sep))) {
      for (const spec of importsOf(file)) {
        const target = path.resolve(path.dirname(file), spec);
        assert.ok(target.startsWith(schemaDir + path.sep), `${rel(file)} imports ${spec}, outside src/schema`);
      }
    }
  });

  test('the page loads only its own files, under a policy that allows nothing but Google Analytics', () => {
    const html = fs.readFileSync(path.join(root, 'hosts', 'web', 'index.html'), 'utf8');
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
    assert.ok(csp, 'index.html has no Content-Security-Policy');
    const policy = new Map(csp[1].split(';').map((d) => d.trim().split(/\s+/)).map(([name, ...sources]) => [name, sources]));
    const google = /^https:\/\/(www\.googletagmanager\.com|\*\.googletagmanager\.com|\*\.google-analytics\.com|\*\.analytics\.google\.com)$/;
    const allowed: Record<string, (s: string) => boolean> = {
      'default-src': (s) => s === "'none'",
      'script-src': (s) => s === "'self'" || s === 'https://www.googletagmanager.com',
      'style-src': (s) => s === "'self'",
      'img-src': (s) => s === "'self'" || s === 'data:' || google.test(s),
      'connect-src': (s) => google.test(s),
      'base-uri': (s) => s === "'none'",
      'form-action': (s) => s === "'none'",
    };
    assert.deepStrictEqual([...policy.keys()].sort(), Object.keys(allowed).sort());
    for (const [name, sources] of policy) for (const s of sources) assert.ok(allowed[name](s), `the policy allows ${s} in ${name}`);
    // The tag loads only on the published site, so a local build or a fork sends nothing.
    const tag = fs.readFileSync(path.join(root, 'hosts', 'web', 'analytics.js'), 'utf8');
    assert.match(tag, /if \(location\.hostname !== 'dchristianson\.github\.io'\) return;/);
    assert.match(html, /<script src="analytics\.js"><\/script>/);
    // Scripts and stylesheets; plain links out (<a href>) load nothing.
    const loaded = [...html.matchAll(/<script src="([^"]+)"|<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1] ?? m[2]);
    assert.ok(loaded.length >= 5, `found ${loaded.length} loads`);
    for (const url of loaded) assert.ok(!/^[a-z]+:|^\/\//i.test(url), `index.html loads ${url} from elsewhere`);
    assert.match(html, /<script src="factory-clock\.js"><\/script>/);
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
