/**
 * Text helpers the plan adapters share (beads, markdown): the natural order of
 * ids, and the relative paths and URLs an item's text names. Pure, like the
 * model: no Node builtins, no DOM.
 */
import { isAbsolutePath, normalizePath } from '../../model/code';

/** Natural order: `x.2` before `x.10`, numbers inside ids compared as numbers. */
export function compareIds(a: string, b: string): number {
  const pa = a.split(/(\d+)/);
  const pb = b.split(/(\d+)/);
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] === pb[i]) continue;
    const numeric = i % 2 === 1; // split with a capture group puts digit runs at odd indexes
    if (numeric) {
      const d = Number(pa[i]) - Number(pb[i]);
      if (d !== 0) return d;
    }
    return pa[i] < pb[i] ? -1 : 1;
  }
  return pa.length - pb.length;
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`()[\]{}]+/g;
const trimTrailing = (s: string) => s.replace(/[.,;:!?]+$/, '');

/** http(s) URLs in the text, trailing sentence punctuation removed. */
export function urlsIn(text: string): string[] {
  return [...text.matchAll(URL_RE)].map((m) => trimTrailing(m[0]));
}

// A relative path: segments of word characters, dots, dashes, ending in a file
// extension or a slash. Globs, `..`, absolute paths and URLs are refused; one
// brace group (`src/model/{code,plan}.ts`, as beads notes write) is expanded.
const PATH_SHAPE = /^[\w@~-][\w@~.-]*(\/[\w@~.-]+)*(\/|\.[A-Za-z][A-Za-z0-9]{0,7})$/;

function expandBraces(token: string): string[] {
  const m = /^([^{}]*)\{([^{}]*)\}([^{}]*)$/.exec(token);
  if (!m) return /[{}]/.test(token) ? [] : [token];
  return m[2].split(',').map((part) => m[1] + part + m[3]);
}

/** Relative file paths named in the text, normalized; conservative on purpose. */
export function pathsIn(text: string): string[] {
  const out: string[] = [];
  const bare = text.replace(URL_RE, ' ');
  for (const raw of bare.split(/[\s`'"()[\]<>|]+/)) {
    const token = raw.replace(/^[,;:]+/, '').replace(/[.,;:!?]+$/, '');
    if (!token.includes('/') || token.includes('://') || isAbsolutePath(token)) continue;
    // A list without braces ("a.ts,b.ts") splits on its commas; braces keep theirs.
    const pieces = /[{}]/.test(token) ? [token] : token.split(',');
    for (const piece of pieces) {
      for (let p of expandBraces(piece)) {
        p = p.replace(/^(\.\/)+/, '');
        if (!p.includes('/') || !PATH_SHAPE.test(p)) continue;
        if (p.split('/').some((seg) => seg === '..' || seg === '.')) continue;
        const n = normalizePath(p);
        if (n && !isAbsolutePath(n)) out.push(n);
      }
    }
  }
  return out;
}
