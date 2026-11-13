/**
 * The planning-markdown plan adapter (docs/workspace-explorer.md, "Plan
 * adapters"). It reads the plans a project writes in prose: design documents,
 * roadmaps, READMEs with a Steps section. It is a heuristic, and says so:
 * every item and link it makes is `inferred`, except a checkbox's status,
 * which the document states and is `observed`. It runs in the page and in
 * Node alike, so it imports only the model types.
 *
 * The unit is decided by the document's shape (the Decisions table there):
 *  - A document with a Steps, Plan, Phases, or Roadmap section (a heading that
 *    ends in one of those words: "Steps", "Preliminary plan") is one epic, the
 *    document itself, whose items are that section's list entries (`step`s;
 *    `task`s when checkboxes) and the rows of a table in it with a Status-like
 *    column. A subheading inside the section with items of its own is a
 *    `milestone`. The first such section with items is the plan; others are not.
 *  - Otherwise, a document with checkboxes or a Status-like table anywhere is
 *    read by heading: each top-level heading (the second level under a single
 *    title, else the shallowest) with such content is one epic, its
 *    subheadings with content milestones. Plain bullet and numbered lists are
 *    left alone here, since a README's install steps are not a plan.
 *  - Anything else, a README of prose, gives nothing, and `detect` says no
 *    unless some markdown file has one of those shapes.
 *
 * Within a unit: nested list entries are children (`parent`); each entry
 * `follows` the one before it in its list; phrases in an entry ("after 5",
 * "depends on step 3", "blocked by X", "waits for", "once", "needs", "only if",
 * "as soon as") make the named entries block it, "decides step 23" or
 * "unblocks 4" make it block them, "replaces X" supersede them. X is a number
 * among the unit's entries or another entry's title. "∥ with 3" (in parallel)
 * makes no link. A Decisions section's table rows or list entries are
 * `decision`s, settled unless they say "not decided"; an Open questions
 * section's entries are `question`s, open unless their lead says otherwise.
 * In a plan-shaped document both hang under the epic; read by heading they are
 * epics of their own.
 *
 * Ids are the document's path and an anchor: `docs/plan.md` for a document's
 * epic, `docs/plan.md#step-6` for its sixth step, `docs/plan.md#step-6.1` for
 * that step's first child, `docs/plan.md#<heading-slug>` for a heading's epic
 * or milestone, `#decision-<slug>` and `#question-<n>`. They depend only on
 * the text, so the same document reads the same way every time.
 */
import { PlanAdapter, ProjectFile } from '../../model/adapter';
import { isAbsolutePath } from '../../model/code';
import { PlanGraph, PlanItem, PlanItemKind, PlanLink, PlanLinkKind, PlanStatus } from '../../model/plan';
import { compareIds, pathsIn, urlsIn } from './text';

const MARKDOWN_PATH = /\.(md|markdown)$/i;

// ---------------------------------------------------------------------------
// The vocabulary. Each row is one word's effect; a project's own words are a row.

/** Status words, first match wins, so "done, but for the review" is in progress. */
export const STATUS_WORDS: ReadonlyArray<readonly [RegExp, PlanStatus]> = [
  [/\b(not (yet )?(started|done|begun|decided)|undecided|to ?do|tbd)\b/i, 'open'],
  [/\b(in[ -]progress|started|partly|partially|but for|underway|under way|wip|ongoing)\b/i, 'in_progress'],
  [/\b(blocked|stuck)\b/i, 'blocked'],
  [/\b(dropped|cancell?ed|abandoned|won'?t do|wontfix|rejected|withdrawn)\b/i, 'dropped'],
  [/\b(later|deferred|postponed|not planned|on hold|waits|someday)\b/i, 'deferred'],
  [/\b(done|built|shipped|accepted|closed|complete|completed|finished|merged|landed|decided|settled|resolved)\b|✓|✅|✔/i, 'done'],
];

/** The status a phrase names, if any. */
export function statusOf(text: string): PlanStatus | undefined {
  for (const [re, status] of STATUS_WORDS) if (re.test(text)) return status;
  return undefined;
}

/** A heading that names a plan: it ends in one of these words. "Plan adapters" is not one. */
const PLAN_HEADING = /\b(steps|plan|phases|roadmap)$/i;
const DECISIONS_HEADING = /^(decisions?|decision log|decisions made|key decisions)$/i;
const QUESTIONS_HEADING = /^(open questions|questions|unresolved questions|open issues)$/i;
/** A table column that holds status. */
const STATUS_COLUMN = /^(status|state|done|progress)$/i;
/** A Done column's cell that means done. */
const DONE_CELL = /^(✓|✅|✔|x|yes|y|true|done)$/i;
/** A decision still open. Every other decision row is settled. */
const UNDECIDED = /\b(not decided|undecided|tbd|to be decided)\b/i;

/** Phrases saying the entry waits for the ones named after it. */
const BLOCKED_BY = /\b(after|depends on|depending on|dependent on|blocked by|blocked on|waits for|waiting for|waits on|once|needs|requires|only if|as soon as)\b/gi;
/** Phrases saying the entry holds up the ones named after it. */
const BLOCKS_OTHERS = /\b(blocks|unblocks|decides|enables)\b/gi;
const SUPERSEDES = /\b(replaces|supersedes)\b/gi;
/** "∥ with 3", "in parallel with step 3": what follows is not a dependency. */
const PARALLEL = /∥|\bparallel\b|\bbeside\b|\balongside\b/i;

// ---------------------------------------------------------------------------
// A small markdown reader: headings, lists (nested, numbered, checkboxes), and
// tables, outside code fences and HTML comments. Paragraphs are passed over.

interface ListItem {
  indent: number;
  number?: number;
  /** true for `[x]`, false for `[ ]`, undefined for no checkbox. */
  checked?: boolean;
  lines: string[];
  children: ListItem[];
}
interface List {
  ordered: boolean;
  items: ListItem[];
}
interface Table {
  header: string[];
  rows: string[][];
}
type Block = { list: List } | { table: Table };
interface Section {
  level: number;
  title: string;
  slug: string;
  blocks: Block[];
  children: Section[];
}

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to dashes. */
export function slugOf(text: string): string {
  return plain(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

/** Inline markdown to plain text: links to their text, emphasis and code marks removed. */
function plain(md: string): string {
  return md
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?!\s)([^*]+?)\*(?!\w)/g, '$1$2')
    .replace(/(^|\W)_(?!\s)([^_]+?)_(?!\w)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function cellsOf(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const out: string[] = [];
  let cur = '';
  let code = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (c === '`') code = !code;
    if (c === '|' && !code) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const LIST_MARKER = /^(\s*)([-*+]|(\d{1,9})[.)])(\s+)(.*)$/;
const CHECKBOX = /^\[([ xX])\]\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;

function parse(text: string): Section {
  const root: Section = { level: 0, title: '', slug: '', blocks: [], children: [] };
  const path: Section[] = [root];
  const slugCount = new Map<string, number>();
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  let fence: string | undefined;
  let comment = false;
  let list: List | undefined;
  let stack: ListItem[] = [];
  let blank = false;
  const closeList = () => {
    list = undefined;
    stack = [];
  };
  const section = () => path[path.length - 1];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\t/g, '    ');
    const trimmed = line.trim();
    if (fence) {
      if (trimmed.startsWith(fence)) fence = undefined;
      continue;
    }
    if (comment) {
      if (trimmed.includes('-->')) comment = false;
      continue;
    }
    const f = FENCE.exec(line);
    if (f) {
      fence = f[1][0].repeat(f[1].length);
      if (!/^\s/.test(line)) closeList();
      continue;
    }
    if (trimmed.startsWith('<!--')) {
      if (!trimmed.includes('-->')) comment = true;
      continue;
    }
    if (!trimmed) {
      blank = true;
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      closeList();
      const level = h[1].length;
      let slug = slugOf(h[2]);
      const seen = slugCount.get(slug) ?? 0;
      slugCount.set(slug, seen + 1);
      if (seen > 0) slug = `${slug}-${seen}`;
      const sec: Section = { level, title: plain(h[2]), slug, blocks: [], children: [] };
      while (path.length > 1 && section().level >= level) path.pop();
      section().children.push(sec);
      path.push(sec);
      blank = false;
      continue;
    }
    if (RULE.test(line)) {
      closeList();
      blank = false;
      continue;
    }
    if (trimmed.startsWith('|') && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1])) {
      closeList();
      const table: Table = { header: cellsOf(line).map(plain), rows: [] };
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith('|')) table.rows.push(cellsOf(lines[i++]));
      i--;
      section().blocks.push({ table });
      blank = false;
      continue;
    }
    const m = LIST_MARKER.exec(line);
    if (m) {
      const indent = m[1].length;
      const ordered = m[3] !== undefined;
      let body = m[5];
      let checked: boolean | undefined;
      const c = CHECKBOX.exec(body);
      if (c) {
        checked = c[1] !== ' ';
        body = c[2];
      }
      const item: ListItem = { indent, lines: [body], children: [], ...(ordered ? { number: Number(m[3]) } : {}), ...(checked !== undefined ? { checked } : {}) };
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      if (stack.length) stack[stack.length - 1].children.push(item);
      else {
        // After a blank line a marker of the same kind continues the list ("5." then a blank then "6.").
        if (!list || list.ordered !== ordered) {
          list = { ordered, items: [] };
          section().blocks.push({ list });
        }
        list.items.push(item);
      }
      stack.push(item);
      blank = false;
      continue;
    }
    // Text: a continuation of the open list entry, or a paragraph that ends the list.
    if (stack.length) {
      const indent = line.length - line.trimStart().length;
      if (!blank) {
        stack[stack.length - 1].lines.push(trimmed);
        continue;
      }
      const owner = [...stack].reverse().find((it) => it.indent < indent);
      if (owner) {
        owner.lines.push(trimmed);
        blank = false;
        continue;
      }
    }
    closeList();
    blank = false;
  }
  return root;
}

function sectionsOf(root: Section): Section[] {
  const out: Section[] = [];
  const walk = (s: Section) => {
    out.push(s);
    s.children.forEach(walk);
  };
  walk(root);
  return out;
}

const hasCheckbox = (items: ListItem[]): boolean => items.some((it) => it.checked !== undefined || hasCheckbox(it.children));
const statusColumn = (t: Table): number => t.header.findIndex((h) => STATUS_COLUMN.test(h.replace(/[^\p{L}\s]/gu, '').trim()));
const isSideSection = (s: Section) => DECISIONS_HEADING.test(s.title) || QUESTIONS_HEADING.test(s.title);

type Mode = 'plan' | 'heading';
const listCounts = (mode: Mode, l: List) => mode === 'plan' || hasCheckbox(l.items);

/** Whether a section (or a subsection not about decisions or questions) has items to read. */
function hasContent(s: Section, mode: Mode): boolean {
  for (const b of s.blocks) {
    if ('list' in b && listCounts(mode, b.list)) return true;
    if ('table' in b && statusColumn(b.table) >= 0) return true;
  }
  return s.children.some((c) => !isSideSection(c) && hasContent(c, mode));
}

/**
 * The plan section: the first heading ending in Steps, Plan, Phases, or Roadmap
 * that has items, a more specific section inside one winning. A document's own
 * title ("# Release plan") with lists directly under it counts for those lists
 * only; with none, its subsections are the plan's milestones.
 */
function planSectionOf(root: Section): { section: Section; ownOnly: boolean } | undefined {
  const title = root.children.filter((s) => s.level === 1).length === 1 ? root.children.find((s) => s.level === 1) : undefined;
  const named = (s: Section) => s.level > 0 && PLAN_HEADING.test(s.title.replace(/[.:]+$/, ''));
  const own = (s: Section) => hasContent({ ...s, children: [] }, 'plan');
  const candidates = sectionsOf(root).filter((s) => named(s) && hasContent(s, 'plan'));
  const section = candidates.find((s) => !sectionsOf(s).some((d) => d !== s && candidates.includes(d)));
  return section && { section, ownOnly: section === title && own(section) };
}

/** Whether a document has a plan's shape: a plan section, a checkbox, or a table with a Status column. */
function isPlanDoc(root: Section): boolean {
  if (planSectionOf(root)) return true;
  return sectionsOf(root).some((s) => s.blocks.some((b) => ('list' in b && hasCheckbox(b.list.items)) || ('table' in b && statusColumn(b.table) >= 0)));
}

// ---------------------------------------------------------------------------
// Reading items out of a parsed document.

function firstSentence(text: string): string {
  const m = /^(.+?[.!?])(\s|$)/.exec(text);
  const s = m ? m[1] : text;
  if (s.length <= 120) return s;
  const cut = s.slice(0, 120);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), 60)) + '…';
}

/** An entry's title, from its bold lead or its first sentence, and the status a tail on it names ("— done"). */
export function titleAndStatus(md: string): { title: string; status?: PlanStatus } {
  const text = md.trim();
  const bold = /^(\*\*|__)(.+?)\1/.exec(text);
  const lead = (bold ? plain(bold[2]) : firstSentence(plain(text))).replace(/[.:;,]+$/, '').trim();
  const tails: RegExp[] = [/^(.+?)\s+(?:—|–|--|-)\s+(.+)$/, /^(.+?)\s*[([]([^()[\]]+)[)\]]$/, /^(.+?)\s*(✓|✅|✔)$/, /^(✓|✅|✔)\s*(.+)$/];
  for (const re of tails) {
    const m = re.exec(lead);
    if (!m) continue;
    const [title, tail] = /^(✓|✅|✔)$/.test(m[1]) ? [m[2], m[1]] : [m[1], m[2]];
    const status = statusOf(tail);
    if (status) return { title: title.replace(/[.:;,]+$/, '').trim(), status };
  }
  return { title: lead || plain(text).slice(0, 120) };
}

function resolveLink(dir: string, target: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('//') || isAbsolutePath(target)) return undefined;
  let t = target.split(/[#?]/)[0];
  try {
    t = decodeURI(t);
  } catch {
    // keep it as written
  }
  if (!t) return undefined;
  const out: string[] = dir ? dir.split('/') : [];
  for (const seg of t.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (!out.length) return undefined; // above the chosen folder
      out.pop();
    } else out.push(seg);
  }
  return out.length ? out.join('/') : undefined;
}

/** Paths and URLs an entry names: relative paths in its text, and its links' targets resolved against the document's folder. */
function refsOf(md: string, docPath: string): PlanItem['refs'] | undefined {
  const dir = docPath.includes('/') ? docPath.slice(0, docPath.lastIndexOf('/')) : '';
  const linked = [...md.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)]
    .map((m) => resolveLink(dir, m[1]))
    .filter((p): p is string => p !== undefined);
  const bare = md.replace(/\]\([^)]*\)/g, ']');
  const paths = [...new Set([...pathsIn(bare), ...linked])].filter((p) => !isAbsolutePath(p)).sort();
  const urls = [...new Set(urlsIn(md))].sort();
  if (!paths.length && !urls.length) return undefined;
  return { ...(paths.length ? { paths } : {}), ...(urls.length ? { urls } : {}) };
}

/** Numbers at the start of a phrase: "5", "step 5", "steps 11 and 12", "5–7", "(steps 2, 3)". */
function numbersAt(s: string): number[] {
  const head = /^\s*\(?\s*((?:steps?|phases?|items?)\s+|#)?/i.exec(s)!;
  let i = head[0].length;
  const prefixed = head[1] !== undefined;
  const NUM = /(\d{1,4})(?:\s*(?:[-–—]|to|through)\s*(\d{1,4}))?/y;
  const SEP = /(?:\s*,\s*(?:(?:and|or)\s+)?|\s+(?:and|or|&)\s+)(?:(?:steps?|phases?)\s+|#)?/y;
  const out: number[] = [];
  for (;;) {
    NUM.lastIndex = i;
    const n = NUM.exec(s);
    if (!n) break;
    const a = Number(n[1]);
    const b = n[2] !== undefined ? Number(n[2]) : a;
    if (b >= a && b - a <= 50) for (let k = a; k <= b; k++) out.push(k);
    i = NUM.lastIndex;
    SEP.lastIndex = i;
    if (!SEP.exec(s)) break;
    const next = SEP.lastIndex;
    NUM.lastIndex = next;
    if (!NUM.test(s)) break;
    i = next;
  }
  if (!out.length) return [];
  const after = s.slice(i);
  if (/^[.\d]\d|^-\d|^\.\d/.test(after)) return []; // a version, a date, a decimal
  // A bare number must end the phrase ("after 5", "after 5 is in"), so "needs 2 files" isn't step 2.
  if (!prefixed && !/^\s*($|[,;:.)!?]|(and|or|is|are|has|have|lands?|ships?|says)\b)/i.test(after)) return [];
  return out;
}

interface Pending {
  id: string;
  text: string;
  scope: Map<number, string>;
}

class DocReader {
  readonly items: PlanItem[] = [];
  readonly links = new Map<string, PlanLink>();
  private readonly ids = new Set<string>();
  private readonly pending: Pending[] = [];
  /** Containers (epics, milestones) whose status comes from their children. */
  private readonly containers: string[] = [];

  constructor(
    private readonly path: string,
    private readonly keepText: boolean,
    private readonly taken: Set<string>,
  ) {}

  private uniqueId(base: string): string {
    let id = base;
    for (let n = 2; this.ids.has(id) || this.taken.has(id); n++) id = `${base}~${n}`;
    this.ids.add(id);
    return id;
  }

  link(from: string, to: string, kind: PlanLinkKind) {
    if (from === to) return;
    this.links.set(`${from}\u0000${to}\u0000${kind}`, { from, to, kind, inferred: true });
  }

  add(base: string, kind: PlanItemKind, title: string, status: PlanStatus, opts: { parent?: string; observed?: boolean; md?: string; container?: boolean; refs?: PlanItem['refs'] }): string {
    const id = this.uniqueId(base);
    const item: PlanItem = { id, kind, title, status, confidence: opts.observed ? 'observed' : 'inferred' };
    if (opts.parent) {
      item.parent = opts.parent;
      this.link(id, opts.parent, 'parent');
    }
    const refs = opts.refs ?? (opts.md !== undefined ? refsOf(opts.md, this.path) : undefined);
    if (refs) item.refs = refs;
    if (this.keepText && opts.md) item.text = opts.md;
    this.items.push(item);
    if (opts.container) this.containers.push(id);
    return id;
  }

  /** A unit's lists, status tables, and subsections (as milestones), under `parent`. */
  collect(sec: Section, parent: string, prefix: string, mode: Mode) {
    const scope = new Map<number, string>();
    const counter = { n: 0 };
    for (const b of sec.blocks) {
      if ('list' in b && listCounts(mode, b.list)) this.list(b.list.items, parent, (n) => `${this.path}#${prefix}-${n}`, mode === 'plan' ? 'step' : 'task', scope, counter);
      if ('table' in b && statusColumn(b.table) >= 0) this.statusTable(b.table, parent, prefix);
    }
    for (const c of sec.children) {
      if (isSideSection(c)) this.side(c, parent);
      else if (hasContent(c, mode)) {
        const id = this.add(`${this.path}#${c.slug}`, 'milestone', c.title, 'open', { parent, container: true });
        this.collect(c, id, c.slug, mode);
      }
    }
  }

  private list(items: ListItem[], parent: string, idFor: (n: number) => string, kind: PlanItemKind, scope: Map<number, string>, counter: { n: number }) {
    let prev: string | undefined;
    for (const it of items) {
      const n = it.number ?? counter.n + 1;
      counter.n = Math.max(counter.n, n);
      const md = it.lines.join('\n');
      const { title, status } = titleAndStatus(md);
      const observed = it.checked !== undefined;
      const id = this.add(idFor(n), observed ? 'task' : kind, title, observed ? (it.checked ? 'done' : 'open') : status ?? 'open', { parent, observed, md });
      if (!scope.has(n)) scope.set(n, id);
      if (prev) this.link(id, prev, 'follows');
      prev = id;
      this.pending.push({ id, text: plain(md), scope });
      if (it.children.length) this.list(it.children, id, (k) => `${id}.${k}`, kind, new Map(), { n: 0 });
    }
  }

  private statusTable(t: Table, parent: string, prefix: string) {
    const col = statusColumn(t);
    const done = /^done$/i.test(t.header[col].replace(/[^\p{L}]/gu, ''));
    const titleCol = t.header.findIndex((_, i) => i !== col);
    for (const row of t.rows) {
      const title = plain(row[titleCol] ?? '');
      if (!title) continue;
      const cell = plain(row[col] ?? '');
      const status = done && DONE_CELL.test(cell) ? 'done' : statusOf(cell) ?? 'open';
      this.add(`${this.path}#${prefix}-${slugOf(title) || 'row'}`, 'task', title, status, { parent, md: row.join(' | ') });
    }
  }

  /** A Decisions or Open questions section's entries, under `parent`. */
  side(sec: Section, parent: string) {
    const decisions = DECISIONS_HEADING.test(sec.title);
    let q = 0;
    const one = (md: string, title: string, lead?: PlanStatus) => {
      if (!title) return;
      if (decisions) this.add(`${this.path}#decision-${slugOf(title) || 'row'}`, 'decision', title, UNDECIDED.test(md) ? 'open' : 'done', { parent, md });
      else this.add(`${this.path}#question-${++q}`, 'question', title, lead ?? 'open', { parent, md });
    };
    for (const b of sec.blocks) {
      if ('table' in b) for (const row of b.table.rows) one(row.join(' | '), plain(row[0] ?? ''));
      else
        for (const it of b.list.items) {
          const md = it.lines.join('\n');
          const { title, status } = titleAndStatus(md);
          one(md, title, status);
        }
    }
  }

  /** Blocks and supersedes from the entries' phrases, once every entry is known; then containers' status from their children. */
  finish() {
    const titles = new Map<string, string | null>();
    for (const it of this.items) {
      if (it.kind === 'epic' || it.kind === 'decision' || it.kind === 'question' || it.title.length < 4) continue;
      const k = it.title.toLowerCase();
      titles.set(k, titles.has(k) ? null : it.id); // a title used twice names neither
    }
    const byLength = [...titles.entries()].filter((e): e is [string, string] => e[1] !== null).sort((a, b) => b[0].length - a[0].length);
    const refsAfter = (rest: string, scope: Map<number, string>): string[] => {
      const cut = rest.search(PARALLEL);
      const r = cut >= 0 ? rest.slice(0, cut) : rest;
      let nums = numbersAt(r);
      if (!nums.length) {
        const at = r.search(/\b(steps?|phases?)\s+\d/i);
        if (at >= 0) nums = numbersAt(r.slice(at));
      }
      if (nums.length) return nums.map((n) => scope.get(n)).filter((id): id is string => id !== undefined);
      const lower = r.trim().toLowerCase();
      for (const cand of [lower, lower.replace(/^the\s+/, '')]) {
        const hit = byLength.find(([t]) => cand.startsWith(t) && !/^[\p{L}\p{N}]/u.test(cand.slice(t.length)));
        if (hit) return [hit[1]];
      }
      return [];
    };
    for (const p of this.pending) {
      for (const clause of p.text.split(/[.;!?](?:\s+|$)/)) {
        const scan = (re: RegExp, add: (ref: string) => void) => {
          for (const m of clause.matchAll(re)) for (const ref of refsAfter(clause.slice(m.index! + m[0].length), p.scope)) add(ref);
        };
        scan(BLOCKED_BY, (ref) => this.link(ref, p.id, 'blocks'));
        scan(BLOCKS_OTHERS, (ref) => this.link(p.id, ref, 'blocks'));
        scan(SUPERSEDES, (ref) => this.link(p.id, ref, 'supersedes'));
      }
    }
    // Innermost first, so a milestone's status is known before its epic's.
    const byId = new Map(this.items.map((i) => [i.id, i]));
    for (const id of [...this.containers].reverse()) {
      const kids = this.items.filter((i) => i.parent === id && i.kind !== 'decision' && i.kind !== 'question');
      const c = byId.get(id)!;
      if (!kids.length) continue;
      if (kids.every((k) => k.status === 'done' || k.status === 'dropped')) c.status = 'done';
      else if (kids.some((k) => k.status === 'done' || k.status === 'in_progress')) c.status = 'in_progress';
      else if (kids.every((k) => k.status === 'deferred' || k.status === 'dropped')) c.status = 'deferred';
    }
  }
}

function readDoc(file: ProjectFile, keepText: boolean, taken: Set<string>): DocReader | undefined {
  const root = parse(file.text);
  if (!isPlanDoc(root)) return undefined;
  const r = new DocReader(file.path, keepText, taken);
  const all = sectionsOf(root);
  const h1 = all.filter((s) => s.level === 1);
  const docTitle = h1[0]?.title || file.path.replace(/^.*\//, '').replace(MARKDOWN_PATH, '');
  const plan = planSectionOf(root);
  if (plan) {
    const epic = r.add(file.path, 'epic', docTitle, 'open', { container: true, refs: { paths: [file.path] } });
    const unit = plan.ownOnly ? { ...plan.section, children: [] } : plan.section;
    r.collect(unit, epic, 'step', 'plan');
    const inPlan = new Set(sectionsOf(unit));
    for (const s of all) if (!inPlan.has(s) && isSideSection(s)) r.side(s, epic);
  } else {
    const levels = all.filter((s) => s.level > 0).map((s) => s.level);
    const top = h1.length === 1 && levels.includes(2) ? 2 : Math.min(...levels);
    const tops = all.filter((s) => s.level === top);
    for (const s of tops) {
      if (isSideSection(s)) {
        if (!s.blocks.length) continue;
        const epic = r.add(`${file.path}#${s.slug}`, 'epic', s.title, 'open', {});
        r.side(s, epic);
      } else if (hasContent(s, 'heading')) {
        const epic = r.add(`${file.path}#${s.slug}`, 'epic', s.title, 'open', { container: true });
        r.collect(s, epic, s.slug, 'heading');
      }
    }
    // Checkboxes above the first heading, or a document with no headings: the document is the epic.
    const before = { ...root, children: [] };
    if (hasContent(before, 'heading')) {
      const epic = r.add(file.path, 'epic', docTitle, 'open', { container: true, refs: { paths: [file.path] } });
      r.collect(before, epic, 'item', 'heading');
    }
  }
  r.finish();
  return r;
}

const isMarkdown = (f: ProjectFile) => MARKDOWN_PATH.test(f.path);

export const markdownAdapter: PlanAdapter = {
  id: 'markdown',
  subject: 'plans',

  detect(files: ProjectFile[]): boolean {
    return files.some((f) => isMarkdown(f) && isPlanDoc(parse(f.text)));
  },

  read(files, options): PlanGraph {
    const items: PlanItem[] = [];
    const links: PlanLink[] = [];
    const taken = new Set<string>();
    const ordered = files.filter(isMarkdown).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const f of ordered) {
      const r = readDoc(f, options.keepText === true, taken);
      if (!r) continue;
      for (const it of r.items) taken.add(it.id);
      items.push(...r.items);
      links.push(...r.links.values());
    }
    links.sort((a, b) => compareIds(a.from, b.from) || compareIds(a.to, b.to) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
    return {
      kind: 'plan-graph',
      version: 1,
      source: { adapter: 'markdown', root: options.name, generatedAt: options.now ?? new Date().toISOString() },
      items,
      links,
    };
  },
};
