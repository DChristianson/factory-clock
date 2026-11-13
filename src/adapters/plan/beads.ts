/**
 * The beads plan adapter (docs/workspace-explorer.md, "Plan adapters"). Beads
 * keeps its issues in a Dolt database the page can't open, so this reads the
 * JSONL export instead: `.beads/issues.jsonl` in the chosen folder, or any
 * dropped file that is a `bd export` (one JSON issue object per line). It runs
 * in the page and in Node alike, so it imports only the model types.
 *
 * The export, as `bd export` writes it (seen in this repository):
 *   { _type: 'issue', id, title, description, notes?, design?, status, priority,
 *     issue_type, owner, created_at, created_by, updated_at, closed_at?,
 *     close_reason?, assignee?, started_at?, labels?, comments?, comment_count,
 *     dependencies?: [{ issue_id, depends_on_id, type, created_at, created_by, metadata }],
 *     dependency_count, dependent_count }
 * `issue_id` depends on `depends_on_id`; `type` is 'parent-child' (the issue's
 * parent) or 'blocks' (the issue waits for the other), among others. Memories
 * and infrastructure beads are left out of `bd export` by default and are
 * never issues here either: a line whose `_type` isn't 'issue' is skipped.
 *
 * Nothing that names a person by address travels: `owner` and `created_by`
 * are never read, and `assignee` is dropped if it looks like an email address.
 */
import { PlanAdapter, ProjectFile } from '../../model/adapter';
import { PlanGraph, PlanItem, PlanItemKind, PlanLink, PlanLinkKind, PlanStatus } from '../../model/plan';
import { compareIds, pathsIn, urlsIn } from './text';

const BEADS_PATH = /(^|\/)\.beads\/issues\.jsonl$/;

type Raw = Record<string, unknown>;
const isObject = (x: unknown): x is Raw => typeof x === 'object' && x !== null && !Array.isArray(x);
const str = (x: unknown): string | undefined => (typeof x === 'string' && x.length > 0 ? x : undefined);
const time = (x: unknown): string | undefined => {
  const s = str(x);
  return s !== undefined && !Number.isNaN(Date.parse(s)) ? s : undefined;
};
const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/;

/** An issue line: an object with an id, title and status that is either typed as an issue or carries an issue_type. */
function isIssue(x: unknown): x is Raw {
  if (!isObject(x) || !str(x.id) || typeof x.title !== 'string' || !str(x.status)) return false;
  if (x._type !== undefined) return x._type === 'issue';
  return str(x.issue_type) !== undefined;
}

function firstLine(text: string): string | undefined {
  for (const line of text.split('\n')) if (line.trim()) return line.trim();
  return undefined;
}

/** Whether a file is a beads export: by its place in the folder, or by its first issue line. */
function isBeadsFile(f: ProjectFile): boolean {
  if (BEADS_PATH.test(f.path)) return true;
  if (!/\.jsonl$/i.test(f.path)) return false;
  const line = firstLine(f.text);
  if (line === undefined) return false;
  try {
    return isIssue(JSON.parse(line));
  } catch {
    return false;
  }
}

const KINDS: Record<string, PlanItemKind> = { epic: 'epic', feature: 'feature', task: 'task', bug: 'bug', chore: 'task' };
const STATUSES: Record<string, PlanStatus> = {
  open: 'open',
  in_progress: 'in_progress',
  blocked: 'blocked',
  closed: 'done',
  deferred: 'deferred',
  tombstone: 'dropped',
  deleted: 'dropped',
};
// Dependency types (beads' `type`) and the link each becomes. The direction is
// decided in linksOf. Types not listed (tracks, replies-to, duplicates, …) are dropped.
const BLOCKING = new Set(['blocks', 'conditional-blocks', 'waits-for']);
const OTHER_LINKS: Record<string, PlanLinkKind> = {
  related: 'relates',
  relates: 'relates',
  'relates-to': 'relates',
  'discovered-from': 'discovered-from',
  supersedes: 'supersedes',
};

export { compareIds, pathsIn, urlsIn } from './text';

interface Edge {
  from: string; // the issue that depends
  to: string; // the issue depended on
  type: string;
}

/** The dependency list in its several spellings: `dependencies` of objects or of ids. */
function edgesOf(issue: Raw, id: string): Edge[] {
  const deps = issue.dependencies ?? issue.deps;
  if (!Array.isArray(deps)) return [];
  const out: Edge[] = [];
  for (const d of deps) {
    if (typeof d === 'string') {
      out.push({ from: id, to: d, type: 'blocks' }); // a bare id list means blocking, as `bd dep add` defaults
      continue;
    }
    if (!isObject(d)) continue;
    const to = str(d.depends_on_id) ?? str(d.depends_on) ?? str(d.target);
    const type = str(d.type) ?? str(d.dep_type) ?? str(d.dependency_type) ?? 'blocks';
    const from = str(d.issue_id) ?? id;
    if (to) out.push({ from, to, type });
  }
  return out;
}

function textOf(issue: Raw): string {
  return ['title', 'description', 'notes', 'design']
    .map((k) => issue[k])
    .filter((v): v is string => typeof v === 'string')
    .join('\n');
}

function itemOf(issue: Raw, id: string, keepText: boolean): PlanItem {
  const item: PlanItem = {
    id,
    kind: KINDS[String(issue.issue_type)] ?? 'task',
    title: String(issue.title),
    status: STATUSES[String(issue.status)] ?? 'open',
    confidence: 'observed',
  };
  const priority = typeof issue.priority === 'number' ? issue.priority : typeof issue.priority === 'string' && /^\d+$/.test(issue.priority) ? Number(issue.priority) : undefined;
  if (priority !== undefined && Number.isFinite(priority)) item.priority = priority;
  const created = time(issue.created_at);
  const updated = time(issue.updated_at);
  const closed = time(issue.closed_at);
  if (created) item.created = created;
  if (updated) item.updated = updated;
  if (closed) item.closed = closed;
  const assignee = str(issue.assignee);
  if (assignee && !EMAIL.test(assignee)) item.assignee = assignee;
  if (Array.isArray(issue.labels)) {
    const labels = [...new Set(issue.labels.map((l) => (isObject(l) ? str(l.label) ?? str(l.name) : str(l))).filter((l): l is string => !!l))].sort();
    if (labels.length) item.labels = labels;
  }
  const text = textOf(issue);
  const paths = [...new Set(pathsIn(text))].sort();
  const urls = [...new Set(urlsIn(text))].sort();
  if (paths.length || urls.length) item.refs = { ...(paths.length ? { paths } : {}), ...(urls.length ? { urls } : {}) };
  if (keepText && typeof issue.description === 'string' && issue.description) item.text = issue.description;
  return item;
}

/** Every issue in the files, one per id; where an id appears twice the later `updated_at` wins (ties: the later line). */
function issuesIn(files: ProjectFile[]): Map<string, Raw> {
  const byId = new Map<string, Raw>();
  // `.beads/issues.jsonl` first, then the others in path order, so the result doesn't depend on drop order.
  const ordered = [...files].sort((a, b) => Number(BEADS_PATH.test(b.path)) - Number(BEADS_PATH.test(a.path)) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const f of ordered) {
    for (const line of f.text.split('\n')) {
      if (!line.trim()) continue;
      let x: unknown;
      try {
        x = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isIssue(x)) continue;
      const id = String(x.id);
      const prev = byId.get(id);
      if (prev) {
        const a = Date.parse(String(prev.updated_at));
        const b = Date.parse(String(x.updated_at));
        if (!Number.isNaN(a) && (Number.isNaN(b) || b < a)) continue;
      }
      byId.set(id, x);
    }
  }
  return byId;
}

function linkKey(l: PlanLink): string {
  return `${l.from}\u0000${l.to}\u0000${l.kind}`;
}

function compareLinks(a: PlanLink, b: PlanLink): number {
  return compareIds(a.from, b.from) || compareIds(a.to, b.to) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0);
}

export const beadsAdapter: PlanAdapter = {
  id: 'beads',
  subject: 'plans',

  detect(files: ProjectFile[]): boolean {
    return files.some(isBeadsFile);
  },

  read(files, options): PlanGraph {
    const issues = issuesIn(files.filter(isBeadsFile));
    const ids = new Set(issues.keys());
    const items = new Map<string, PlanItem>();
    for (const [id, issue] of issues) items.set(id, itemOf(issue, id, options.keepText === true));

    // Edges from every issue's list, deduplicated (a dependency may be listed on both ends).
    const edges = new Map<string, Edge>();
    for (const [id, issue] of issues) for (const e of edgesOf(issue, id)) edges.set(`${e.from}\u0000${e.to}\u0000${e.type}`, e);

    // Parents: the parent-child dependency, else a `parent` field. Only when the
    // export uses neither anywhere does the hierarchical id (`epic.3` under `epic`)
    // stand in, and those links say inferred.
    const parents = new Map<string, { parent: string; inferred: boolean }>();
    let explicit = false;
    for (const e of edges.values()) {
      if (e.type !== 'parent-child') continue;
      explicit = true;
      if (!parents.has(e.from)) parents.set(e.from, { parent: e.to, inferred: false });
    }
    for (const [id, issue] of issues) {
      const p = str(issue.parent);
      if (p === undefined) continue;
      explicit = true;
      if (!parents.has(id)) parents.set(id, { parent: p, inferred: false });
    }
    if (!explicit) {
      for (const id of ids) {
        const m = /^(.+)\.\d+$/.exec(id);
        if (m && ids.has(m[1])) parents.set(id, { parent: m[1], inferred: true });
      }
    }

    const links = new Map<string, PlanLink>();
    const add = (l: PlanLink) => {
      if (l.from === l.to || !ids.has(l.from) || !ids.has(l.to)) return;
      links.set(linkKey(l), l);
    };
    for (const [child, { parent, inferred }] of parents) {
      if (!ids.has(parent) || parent === child) continue;
      items.get(child)!.parent = parent;
      // Child → parent, the direction the model's own fixtures use.
      add({ from: child, to: parent, kind: 'parent', ...(inferred ? { inferred: true } : {}) });
    }
    for (const e of edges.values()) {
      // A depends on B: B blocks A.
      if (BLOCKING.has(e.type)) add({ from: e.to, to: e.from, kind: 'blocks' });
      // Otherwise the link reads as beads writes it: A discovered-from B, A supersedes B, A relates to B.
      else if (OTHER_LINKS[e.type]) add({ from: e.from, to: e.to, kind: OTHER_LINKS[e.type] });
    }

    return {
      kind: 'plan-graph',
      version: 1,
      source: { adapter: 'beads', root: options.name, generatedAt: options.now ?? new Date().toISOString(), tool: 'beads' },
      items: [...items.values()].sort((a, b) => compareIds(a.id, b.id)),
      links: [...links.values()].sort(compareLinks),
    };
  },
};
