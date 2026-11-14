// The site's workspace packages, for scripts/site.js (docs/workspace-explorer.md,
// "Where packages live"). Live workspaces never live in this repository: the
// scrape script writes a folder holding index.js and one <file>.js per
// workspace, and the build copies that folder's top-level .js files into
// site/workspaces/ and writes a tag for workspaces/index.js into the page only
// when the environment variable FC_WORKSPACES names the folder (absolute, or
// relative to the repository). Without it nothing is copied and no tag is
// written, so the page lists only its built-in workspaces; a normal build and
// the public Pages deploy, which doesn't set it, never carry project data.
const fs = require('fs');
const path = require('path');

const marker = /^[ \t]*<!-- workspaces-index:.*-->[ \t]*$/m;
const packageFile = /^[A-Za-z0-9._-]+\.js$/;

/**
 * Copies the named folder's packages into <out>/workspaces and fills the
 * page's marker. Returns the page's HTML, the folder used (null when unset),
 * and the files copied. Throws when the page has no marker or the folder has
 * no index.js.
 */
function siteWorkspaces({ root, out, html, env }) {
  if (!marker.test(html)) throw new Error('site: hosts/web/index.html has no <!-- workspaces-index --> marker');
  const named = (env.FC_WORKSPACES || '').trim();
  if (!named) return { html: html.replace(marker, ''), from: null, files: [] };
  const from = path.resolve(root, named);
  if (!fs.existsSync(path.join(from, 'index.js'))) throw new Error(`site: FC_WORKSPACES names ${from}, which has no index.js`);
  // Only the scripts the page can load: index.js and the packages beside it, nothing in subfolders.
  const files = fs
    .readdirSync(from, { withFileTypes: true })
    .filter((e) => e.isFile() && packageFile.test(e.name))
    .map((e) => e.name)
    .sort();
  fs.mkdirSync(path.join(out, 'workspaces'), { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(from, f), path.join(out, 'workspaces', f));
  return { html: html.replace(marker, '<script src="workspaces/index.js"></script>'), from, files };
}

module.exports = { siteWorkspaces };
