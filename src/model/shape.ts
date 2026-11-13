/**
 * Shapes (docs/workspace-explorer.md, "Shapes: one view, several subjects"):
 * the one form every subject can take, boxes inside boxes plus lines between
 * them, so the treemap, sunburst, adjacency matrix, Sankey, and actor graph
 * can draw code and plans as well as sessions.
 *
 * A node's `value` is inclusive: a parent's is its own plus its children's,
 * as the turn tree's tokens are. Roots have no parent.
 */
import { SessionView, TreeNode } from '../schema';
import { ARTIFACT_ROLES, Artifact, CodeGraph } from './code';
import { PLAN_STATUSES, PlanGraph } from './plan';

export interface ShapeNode {
  id: string;
  label: string;
  parent?: string;
  value: number;
  kind: string;
  /** Index into `kinds`, which is the legend's order. */
  colorGroup: number;
  status?: string;
  inferred?: boolean;
}

export interface ShapeLink {
  from: string;
  to: string;
  weight: number;
  kind: string;
  inferred?: boolean;
}

export interface Shape {
  nodes: ShapeNode[];
  links: ShapeLink[];
  /** What `value` counts: 'tokens', 'lines', 'items'. */
  valueLabel: string;
  /** The legend, in color order. */
  kinds: string[];
}

// ---------- sessions ----------

const SESSION_KINDS = ['session', 'prompt', 'agent', 'category'];

/**
 * Sessions by tokens: each session's turn tree. Several sessions hang under
 * one `sessions` root, as the turn tree's forest does. Node ids are prefixed
 * by session, since every tree's root is `s`. Links come when the actor graph
 * is ported (plan step 12).
 */
export function shapeOfSessions(sessions: SessionView[]): Shape {
  const nodes: ShapeNode[] = [];
  const many = sessions.length > 1;
  if (many) nodes.push({ id: 'sessions', label: 'Sessions', value: sessions.reduce((n, s) => n + s.tree.tokens, 0), kind: 'session', colorGroup: 0 });
  for (const s of sessions) {
    const prefix = s.summary.sessionId + '/';
    const walk = (t: TreeNode, parent: string | undefined) => {
      const id = prefix + t.id;
      const label = t.kind === 'session' ? s.summary.name ?? s.summary.sessionId.slice(0, 8) : t.label;
      nodes.push({ id, label, ...(parent ? { parent } : {}), value: t.tokens, kind: t.kind, colorGroup: SESSION_KINDS.indexOf(t.kind), ...(t.approximate ? { inferred: true } : {}) });
      for (const c of t.children) walk(c, id);
    };
    walk(s.tree, many ? 'sessions' : undefined);
  }
  return { nodes, links: [], valueLabel: 'tokens', kinds: SESSION_KINDS };
}

// ---------- code ----------

export type CodeFold = 'file' | 'module' | 'package';

/** The artifact kinds that stand for themselves at each fold; anything finer folds into its nearest such ancestor. */
const FOLD_KEEPS: Record<CodeFold, ReadonlySet<string>> = {
  file: new Set(['workspace', 'package', 'target', 'module', 'file', 'external']),
  module: new Set(['workspace', 'package', 'target', 'module', 'external']),
  package: new Set(['workspace', 'package', 'target', 'external']),
};

const CODE_KINDS = [...ARTIFACT_ROLES, 'external', 'container'];

/**
 * Code by lines: containment as the hierarchy, dependencies as links,
 * folded to files, modules, or packages. A link between two artifacts that
 * fold into the same node is dropped; links that fold onto the same pair
 * merge, weights summed, inferred only if every one of them was. An external
 * dependency's value is the imports that reach it, since it has no lines here.
 */
export function shapeOfCode(graph: CodeGraph, by: CodeFold = 'file'): Shape {
  const keep = FOLD_KEEPS[by];
  const byId = new Map(graph.artifacts.map((a) => [a.id, a]));
  const visible = (a: Artifact | undefined): Artifact | undefined => {
    let cur = a;
    const guard = new Set<string>();
    while (cur && !keep.has(cur.kind)) {
      if (guard.has(cur.id)) return undefined; // a containment cycle: give up on this branch
      guard.add(cur.id);
      cur = cur.parent ? byId.get(cur.parent) : undefined;
    }
    return cur;
  };
  const shown = graph.artifacts.filter((a) => keep.has(a.kind));
  const ownValue = new Map<string, number>(shown.map((a) => [a.id, 0]));
  // Every artifact's own lines go to the node it folds into.
  for (const a of graph.artifacts) {
    if (a.kind === 'external') continue;
    const v = visible(a);
    if (v) ownValue.set(v.id, (ownValue.get(v.id) ?? 0) + (a.size?.lines ?? (a.kind === 'file' ? 1 : 0)));
  }
  for (const d of graph.dependencies) {
    const to = byId.get(d.to);
    if (to?.kind === 'external') ownValue.set(to.id, (ownValue.get(to.id) ?? 0) + (d.weight ?? 1));
  }
  // Parents among the shown nodes: the nearest shown ancestor.
  const parentOf = new Map<string, string | undefined>();
  for (const a of shown) parentOf.set(a.id, a.parent ? visible(byId.get(a.parent))?.id : undefined);
  // Inclusive totals: add each node's own value to every shown ancestor.
  const total = new Map(ownValue);
  for (const a of shown) {
    let p = parentOf.get(a.id);
    const guard = new Set<string>([a.id]);
    while (p && !guard.has(p)) {
      total.set(p, (total.get(p) ?? 0) + (ownValue.get(a.id) ?? 0));
      guard.add(p);
      p = parentOf.get(p);
    }
  }
  // Files are colored by role; packages, modules, and the rest are containers.
  const kindOf = (a: Artifact) => (a.kind === 'external' ? 'external' : a.kind === 'file' ? a.role ?? 'source' : 'container');
  const nodes: ShapeNode[] = shown.map((a) => {
    const kind = kindOf(a);
    const parent = parentOf.get(a.id);
    return { id: a.id, label: a.name, ...(parent ? { parent } : {}), value: total.get(a.id) ?? 0, kind, colorGroup: CODE_KINDS.indexOf(kind) };
  });
  const merged = new Map<string, ShapeLink>();
  for (const d of graph.dependencies) {
    const from = visible(byId.get(d.from))?.id;
    const to = visible(byId.get(d.to))?.id;
    if (!from || !to || from === to) continue;
    const k = `${from}\u0000${to}\u0000${d.kind}`;
    const prev = merged.get(k);
    if (prev) {
      prev.weight += d.weight ?? 1;
      if (!d.inferred) delete prev.inferred;
    } else merged.set(k, { from, to, weight: d.weight ?? 1, kind: d.kind, ...(d.inferred ? { inferred: true } : {}) });
  }
  return { nodes, links: [...merged.values()], valueLabel: 'lines', kinds: CODE_KINDS };
}

// ---------- plans ----------

/**
 * Plans by count: parents as the hierarchy, every link but `parent` as a
 * link. Each item counts one, so an epic's value is itself plus everything
 * under it. Colored by status; a guessed item is marked inferred.
 */
export function shapeOfPlan(graph: PlanGraph): Shape {
  const ids = new Set(graph.items.map((i) => i.id));
  const parentOf = new Map(graph.items.map((i) => [i.id, i.parent && ids.has(i.parent) ? i.parent : undefined]));
  const total = new Map(graph.items.map((i) => [i.id, 1]));
  for (const i of graph.items) {
    let p = parentOf.get(i.id);
    const guard = new Set<string>([i.id]);
    while (p && !guard.has(p)) {
      total.set(p, total.get(p)! + 1);
      guard.add(p);
      p = parentOf.get(p);
    }
  }
  const kinds = [...PLAN_STATUSES];
  const nodes: ShapeNode[] = graph.items.map((i) => {
    const parent = parentOf.get(i.id);
    return { id: i.id, label: i.title, ...(parent ? { parent } : {}), value: total.get(i.id)!, kind: i.status, colorGroup: kinds.indexOf(i.status), status: i.status, ...(i.confidence === 'inferred' ? { inferred: true } : {}) };
  });
  const links: ShapeLink[] = graph.links.filter((l) => l.kind !== 'parent').map((l) => ({ from: l.from, to: l.to, weight: 1, kind: l.kind, ...(l.inferred ? { inferred: true } : {}) }));
  return { nodes, links, valueLabel: 'items', kinds };
}
