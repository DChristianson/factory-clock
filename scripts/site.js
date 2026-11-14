// Builds the web page in site/ (npm run build, after tsc has checked the
// TypeScript): bundles src/main.ts into site/factory-clock.js with esbuild,
// then copies the page's own files from hosts/web/ and the plain scripts and
// stylesheets from the repository root, as they are. A script tag is written
// into index.html for every file under viz/ (the registry first), so a new
// visualizer needs no edit here. When FC_WORKSPACES names a folder of
// workspace packages, they're copied into site/workspaces/ and listed in the
// page (scripts/siteWorkspaces.js); otherwise the page has only its built-in
// workspaces. Nothing generated is committed; the Pages workflow deploys
// site/, without FC_WORKSPACES.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const { siteWorkspaces } = require('./siteWorkspaces');

const root = path.join(__dirname, '..');
const out = path.join(root, 'site');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'viz'), { recursive: true });

// The page's bundle: its model and session builder, for the browser. esbuild
// refuses to resolve a Node builtin for the browser, so a Node import
// creeping into src/ fails the build rather than the deployed page.
esbuild.buildSync({
  entryPoints: [path.join(root, 'src', 'main.ts')],
  bundle: true,
  outfile: path.join(out, 'factory-clock.js'),
  format: 'iife',
  platform: 'browser',
  target: 'es2022',
  sourcemap: false,
  minify: false,
  logLevel: 'warning',
});

const copies = [
  ['vizkit.js', 'vizkit.js'],
  ['explore.js', 'explore.js'],
  ['theme.css', 'theme.css'],
  ['viz.css', 'viz.css'],
  ['hosts/web/web.css', 'web.css'],
  ['hosts/web/analytics.js', 'analytics.js'],
];
const viz = fs
  .readdirSync(path.join(root, 'viz'))
  .filter((f) => f.endsWith('.js'))
  .sort((a, b) => (a === 'registry.js' ? -1 : b === 'registry.js' ? 1 : a.localeCompare(b)));
if (viz[0] !== 'registry.js') {
  console.error('site: viz/registry.js is missing');
  process.exit(1);
}
for (const f of viz) copies.push([`viz/${f}`, `viz/${f}`]);
// The example traces, when they've been made and reviewed: the picker lists them as a workspace of their own.
const traces = fs.existsSync(path.join(root, 'hosts', 'web', 'demo', 'traces.js'));
if (traces) copies.push(['hosts/web/demo/traces.js', 'demo-traces.js']);
for (const [from, to] of copies) fs.copyFileSync(path.join(root, from), path.join(out, to));

const marker = /^[ \t]*<!-- viz-scripts:.*-->[ \t]*$/m;
const html = fs.readFileSync(path.join(root, 'hosts', 'web', 'index.html'), 'utf8');
if (!marker.test(html)) {
  console.error('site: hosts/web/index.html has no <!-- viz-scripts --> marker');
  process.exit(1);
}
const tracesMarker = /^[ \t]*<!-- demo-traces:.*-->[ \t]*$/m;
if (!tracesMarker.test(html)) {
  console.error('site: hosts/web/index.html has no <!-- demo-traces --> marker');
  process.exit(1);
}
let packages;
try {
  packages = siteWorkspaces({ root, out, env: process.env, html: html.replace(marker, viz.map((f) => `<script src="viz/${f}"></script>`).join('\n')).replace(tracesMarker, traces ? '<script src="demo-traces.js"></script>' : '') });
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
fs.writeFileSync(path.join(out, 'index.html'), packages.html);

const listed = packages.from ? `${packages.files.length} workspace files from ${packages.from}` : 'no workspace packages (FC_WORKSPACES is not set)';
console.log(`site: ${traces ? 'with' : 'without'} example traces, ${listed}; wrote ${copies.length + 1} files and the bundle to site/ (visualizers: ${viz.filter((f) => f !== 'registry.js').length})`);
