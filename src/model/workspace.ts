/**
 * The workspace subject (docs/workspace-explorer.md, "Workspace and joins"):
 * whichever of sessions, code, and plans are loaded, and the joins the page
 * can make between them. Every join says whether it was read or guessed, and
 * views draw guessed ones as guessed.
 */
import { NormalizedEvent, SessionView } from '../schema';
import { CodeGraph, isAbsolutePath, normalizePath } from './code';
import { PlanGraph } from './plan';

/** One file a session read or edited, from a tool call's target. */
export interface Touch {
  /**
   * Relative to the workspace the session ran in. When the target couldn't be
   * anchored there, only its last few segments are kept, `anchored` is false,
   * and the join matches it by suffix. Never an absolute path.
   */
  path: string;
  anchored: boolean;
  kind: 'read' | 'edit';
  ts: string;
  turnId?: string;
  agentId?: string;
}

/** The segments of an unanchored path that are kept: enough to match a file, too few to name a home folder. */
export const UNANCHORED_SEGMENTS = 3;

const TOUCH_KIND: Record<string, Touch['kind']> = { 'file-read': 'read', 'file-edit': 'edit' };

/**
 * The files each session touched, built at load from its events (decided
 * 2026-11-13). Only file reads and edits count: a search's target is a
 * pattern and a shell command's is a command line, and neither is kept. Event
 * files with no targets, such as the redacted demo traces, give none.
 */
export function touchesOf(events: NormalizedEvent[]): Map<string, Touch[]> {
  const out = new Map<string, Touch[]>();
  for (const e of events) {
    if (e.kind !== 'tool_call' || !e.target || !e.toolCategory) continue;
    const kind = TOUCH_KIND[e.toolCategory];
    if (!kind) continue;
    const place = anchor(e.target, e.workspace);
    if (!place) continue;
    const list = out.get(e.sessionId) ?? [];
    list.push({ ...place, kind, ts: e.ts, ...(e.turnId ? { turnId: e.turnId } : {}), ...(e.agentId ? { agentId: e.agentId } : {}) });
    out.set(e.sessionId, list);
  }
  return out;
}

/** Makes a target relative to its workspace, or cuts it to its last segments when it can't be. */
export function anchor(target: string, workspace?: string): { path: string; anchored: boolean } | null {
  const t = normalizePath(target.trim());
  if (!t || /[\n\r]/.test(t)) return null;
  if (!isAbsolutePath(t)) return t.startsWith('../') ? null : { path: t, anchored: true };
  const ws = workspace && isAbsolutePath(workspace) ? normalizePath(workspace) : '';
  const lower = (s: string) => (/^[A-Za-z]:\//.test(s) ? s.toLowerCase() : s); // Windows drive paths compare case-blind
  if (ws && lower(t).startsWith(lower(ws) + '/')) return { path: t.slice(ws.length + 1), anchored: true };
  const segments = t.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  return { path: segments.slice(-UNANCHORED_SEGMENTS).join('/'), anchored: false };
}

/** A link between two subjects. Ids are qualified (see `qualify`), since two code graphs may share an artifact id. */
export interface Join {
  from: string;
  to: string;
  inferred: boolean;
  /** How many times the link was seen: touches for session→code, mentions for plan→session; 1 otherwise. */
  weight: number;
}

/** An artifact or item id made unique across loaded graphs by its graph's root name. */
export const qualify = (root: string, id: string) => `${root}::${id}`;

export interface Workspace {
  sessions: SessionView[];
  code: CodeGraph[];
  plans: PlanGraph[];
  touches: Map<string, Touch[]>;
  joins: { planToCode: Join[]; planToSession: Join[]; sessionToCode: Join[] };
}

export function buildWorkspace(parts: { sessions?: SessionView[]; events?: NormalizedEvent[]; code?: CodeGraph[]; plans?: PlanGraph[] }): Workspace {
  const sessions = parts.sessions ?? [];
  const code = parts.code ?? [];
  const plans = parts.plans ?? [];
  const loaded = new Set(sessions.map((s) => s.summary.sessionId));
  const touches = touchesOf((parts.events ?? []).filter((e) => loaded.has(e.sessionId)));
  return {
    sessions,
    code,
    plans,
    touches,
    joins: {
      planToCode: plans.flatMap((p) => joinPlanToCode(p, code)),
      planToSession: plans.flatMap((p) => joinPlanToSession(p, sessions)),
      sessionToCode: joinSessionToCode(touches, code),
    },
  };
}

/** Lookup of artifacts by path across every loaded code graph. */
function pathIndex(code: CodeGraph[]): Array<{ path: string; qid: string }> {
  return code.flatMap((g) => g.artifacts.filter((a) => a.path).map((a) => ({ path: a.path!, qid: qualify(g.source.root, a.id) })));
}

/**
 * Plan item → code artifact, by the paths an item names: an exact path links
 * to that artifact; a directory links to the artifact at that path if there
 * is one, or else to every artifact under it. Ids named in `refs.artifacts`
 * link directly. All observed: the item said so.
 */
export function joinPlanToCode(plan: PlanGraph, code: CodeGraph[]): Join[] {
  const index = pathIndex(code);
  const ids = new Set(code.flatMap((g) => g.artifacts.map((a) => qualify(g.source.root, a.id))));
  const byId = new Map(code.flatMap((g) => g.artifacts.map((a) => [a.id, qualify(g.source.root, a.id)] as const)));
  const out: Join[] = [];
  const seen = new Set<string>();
  const add = (from: string, to: string) => {
    const k = `${from}\u0000${to}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ from, to, inferred: false, weight: 1 });
  };
  for (const item of plan.items) {
    const from = qualify(plan.source.root, item.id);
    for (const raw of item.refs?.paths ?? []) {
      const p = normalizePath(raw);
      const exact = index.filter((x) => x.path === p);
      const matches = exact.length ? exact : index.filter((x) => x.path.startsWith(p + '/'));
      for (const m of matches) add(from, m.qid);
    }
    for (const id of item.refs?.artifacts ?? []) {
      const q = ids.has(id) ? id : byId.get(id);
      if (q) add(from, q);
    }
  }
  return out;
}

/**
 * Plan item → session. A session named in `refs.sessions` is observed. A
 * session whose prompts name the item's id, or its title when the title is
 * long enough to be distinctive, is inferred; the weight counts the prompts.
 * Needs prompt text, so it finds nothing when capture was off.
 */
export const MIN_TITLE_MATCH = 16;

export function joinPlanToSession(plan: PlanGraph, sessions: SessionView[]): Join[] {
  const out: Join[] = [];
  const texts = sessions.map((s) => ({ id: s.summary.sessionId, prompts: s.prompts.map((p) => (p.text ?? '').toLowerCase()).filter(Boolean) }));
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const item of plan.items) {
    const from = qualify(plan.source.root, item.id);
    const named = new Set(item.refs?.sessions ?? []);
    const idRe = new RegExp(`(^|[^a-z0-9.-])${escape(item.id.toLowerCase())}(?![a-z0-9]|\\.[a-z0-9])`);
    const title = item.title.trim().toLowerCase();
    for (const s of texts) {
      if (named.has(s.id)) {
        out.push({ from, to: s.id, inferred: false, weight: 1 });
        continue;
      }
      const hits = s.prompts.filter((t) => idRe.test(t) || (title.length >= MIN_TITLE_MATCH && t.includes(title))).length;
      if (hits) out.push({ from, to: s.id, inferred: true, weight: hits });
    }
  }
  return out;
}

/**
 * Session → code artifact, from the touches. An anchored touch matches a path
 * exactly and is observed; an unanchored one matches the one artifact whose
 * path ends with it and is inferred, and is dropped when it matches several.
 * Weight is the number of touches.
 */
export function joinSessionToCode(touches: Map<string, Touch[]>, code: CodeGraph[]): Join[] {
  const index = pathIndex(code);
  const exact = new Map<string, string[]>();
  for (const x of index) exact.set(x.path, [...(exact.get(x.path) ?? []), x.qid]);
  const counts = new Map<string, Join>();
  for (const [sessionId, list] of touches) {
    for (const t of list) {
      let targets: string[];
      let inferred: boolean;
      if (t.anchored) {
        targets = exact.get(t.path) ?? [];
        inferred = false;
      } else {
        const m = index.filter((x) => x.path === t.path || x.path.endsWith('/' + t.path));
        targets = m.length === 1 ? [m[0].qid] : [];
        inferred = true;
      }
      for (const to of targets) {
        const k = `${sessionId}\u0000${to}`;
        const j = counts.get(k);
        if (j) {
          j.weight += 1;
          j.inferred = j.inferred && inferred; // one exact match makes the link observed
        } else counts.set(k, { from: sessionId, to, inferred, weight: 1 });
      }
    }
  }
  return [...counts.values()];
}
