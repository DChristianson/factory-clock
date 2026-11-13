/**
 * The plans subject (docs/workspace-explorer.md, "PlanGraph"): items of work
 * with status, in a hierarchy, with typed links. Every item says whether it
 * was read from its source or guessed by a heuristic. Pure, like code.ts.
 */
import { Checked, GraphSource, checkSource, isAbsolutePath, normalizePath } from './code';

export const PLAN_ITEM_KINDS = ['epic', 'milestone', 'feature', 'task', 'bug', 'step', 'decision', 'question', 'note'] as const;
export type PlanItemKind = (typeof PLAN_ITEM_KINDS)[number];

/** In the order views list them: what's left first, what's settled last. */
export const PLAN_STATUSES = ['open', 'in_progress', 'blocked', 'done', 'deferred', 'dropped'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export const PLAN_LINK_KINDS = ['blocks', 'parent', 'relates', 'supersedes', 'discovered-from', 'follows'] as const;
export type PlanLinkKind = (typeof PLAN_LINK_KINDS)[number];

export interface PlanItem {
  id: string;
  kind: PlanItemKind;
  title: string;
  status: PlanStatus;
  /** 0 is highest, as beads counts. */
  priority?: number;
  parent?: string;
  created?: string;
  updated?: string;
  closed?: string;
  assignee?: string;
  labels?: string[];
  refs?: { paths?: string[]; artifacts?: string[]; sessions?: string[]; urls?: string[] };
  confidence: 'observed' | 'inferred';
  /** The description; present only when the adapter was told to keep text. */
  text?: string;
}

export interface PlanLink {
  from: string;
  to: string;
  kind: PlanLinkKind;
  inferred?: boolean;
}

export interface PlanGraph {
  kind: 'plan-graph';
  version: 1;
  source: GraphSource;
  items: PlanItem[];
  links: PlanLink[];
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isString = (x: unknown): x is string => typeof x === 'string' && x.length > 0;
const isTime = (x: unknown) => x === undefined || (typeof x === 'string' && !Number.isNaN(Date.parse(x)));
const stringList = (x: unknown) => x === undefined || (Array.isArray(x) && x.every((s) => typeof s === 'string'));

/** Checks an object read from a `.plan.json` file. Broken items and links are reported and dropped. */
export function checkPlanGraph(x: unknown): Checked<PlanGraph> {
  const errors: string[] = [];
  if (!isObject(x) || x.kind !== 'plan-graph') return { errors: ['not a plan graph (kind is not "plan-graph")'] };
  if (x.version !== 1) return { errors: [`plan graph version ${String(x.version)} is not supported`] };
  if (!checkSource(x.source, 'plan graph', errors)) return { errors };
  if (!Array.isArray(x.items)) return { errors: ['plan graph: items is not a list'] };
  if (!Array.isArray(x.links)) return { errors: ['plan graph: links is not a list'] };

  const items: PlanItem[] = [];
  const ids = new Set<string>();
  x.items.forEach((it: unknown, i: number) => {
    const at = `item ${i}`;
    if (!isObject(it) || !isString(it.id)) return errors.push(`${at}: no id`);
    if (ids.has(it.id)) return errors.push(`${at}: id ${it.id} is used twice`);
    if (!(PLAN_ITEM_KINDS as readonly unknown[]).includes(it.kind)) return errors.push(`${at} (${it.id}): unknown kind ${String(it.kind)}`);
    if (typeof it.title !== 'string') return errors.push(`${at} (${it.id}): no title`);
    if (!(PLAN_STATUSES as readonly unknown[]).includes(it.status)) return errors.push(`${at} (${it.id}): unknown status ${String(it.status)}`);
    if (it.confidence !== 'observed' && it.confidence !== 'inferred') return errors.push(`${at} (${it.id}): confidence must be observed or inferred`);
    if (!isTime(it.created) || !isTime(it.updated) || !isTime(it.closed)) return errors.push(`${at} (${it.id}): a timestamp doesn't parse`);
    if (it.priority !== undefined && typeof it.priority !== 'number') return errors.push(`${at} (${it.id}): priority is not a number`);
    if (!stringList(it.labels)) return errors.push(`${at} (${it.id}): labels is not a list of strings`);
    let refs = it.refs as PlanItem['refs'];
    if (refs !== undefined) {
      if (!isObject(refs) || !stringList(refs.paths) || !stringList(refs.artifacts) || !stringList(refs.sessions) || !stringList(refs.urls)) return errors.push(`${at} (${it.id}): refs is malformed`);
      if (refs.paths) {
        const bad = refs.paths.filter(isAbsolutePath);
        if (bad.length) errors.push(`${at} (${it.id}): dropped absolute paths in refs`);
        refs = { ...refs, paths: refs.paths.filter((p) => !isAbsolutePath(p)).map(normalizePath) };
      }
    }
    ids.add(it.id);
    items.push({ ...(it as unknown as PlanItem), ...(refs ? { refs } : {}) });
  });
  for (const it of items) {
    if (it.parent !== undefined && !ids.has(it.parent)) {
      errors.push(`item ${it.id}: parent ${it.parent} doesn't exist`);
      delete it.parent;
    }
  }
  const links: PlanLink[] = [];
  x.links.forEach((l: unknown, i: number) => {
    const at = `link ${i}`;
    if (!isObject(l) || !isString(l.from) || !isString(l.to)) return errors.push(`${at}: no from or to`);
    if (!ids.has(l.from) || !ids.has(l.to)) return errors.push(`${at}: ${l.from} → ${l.to} names an item that doesn't exist`);
    if (!(PLAN_LINK_KINDS as readonly unknown[]).includes(l.kind)) return errors.push(`${at}: unknown kind ${String(l.kind)}`);
    links.push(l as unknown as PlanLink);
  });
  return { value: { kind: 'plan-graph', version: 1, source: x.source as GraphSource, items, links }, errors };
}
