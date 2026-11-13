/**
 * The code subject (docs/workspace-explorer.md, "CodeGraph"): a project's
 * artifacts in a hierarchy, with typed dependencies between them, as a code
 * adapter produces it. Pure: no DOM, no Node, so the page and the tests run
 * the same module.
 */

export const ARTIFACT_KINDS = ['workspace', 'package', 'target', 'module', 'file', 'external'] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const ARTIFACT_ROLES = ['source', 'test', 'doc', 'config', 'asset', 'generated'] as const;
export type ArtifactRole = (typeof ARTIFACT_ROLES)[number];

export const DEPENDENCY_KINDS = ['import', 'build', 'test', 'runtime', 'dev', 'link', 'reference'] as const;
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];

/** Where a graph or plan came from. `root` is a name, never an absolute path. */
export interface GraphSource {
  adapter: string;
  root: string;
  generatedAt: string;
  tool?: string;
}

export interface Artifact {
  /** Stable within the file: the path for files, the manifest name for packages. */
  id: string;
  kind: ArtifactKind;
  name: string;
  /** Relative to the root; files and modules have one. */
  path?: string;
  /** Containment: file in module in package in workspace. */
  parent?: string;
  language?: string;
  size?: { bytes?: number; lines?: number };
  role?: ArtifactRole;
  /** An adapter's extras; a view that uses one names it. */
  metrics?: Record<string, number>;
}

export interface Dependency {
  from: string;
  to: string;
  kind: DependencyKind;
  /** Import count, or 1. */
  weight?: number;
  /** Found by a heuristic rather than read from a manifest or resolved. */
  inferred?: boolean;
}

export interface CodeGraph {
  kind: 'code-graph';
  version: 1;
  source: GraphSource;
  artifacts: Artifact[];
  dependencies: Dependency[];
}

/** The result of checking a file someone dropped: the graph when it's usable, and every problem found. */
export interface Checked<T> {
  value?: T;
  errors: string[];
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isString = (x: unknown): x is string => typeof x === 'string' && x.length > 0;

/** True for a path that starts at a file system root: `/home/…`, `C:\…`, `\\server\…`. */
export function isAbsolutePath(p: string): boolean {
  return /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p);
}

/** Forward slashes, no `./`, no trailing slash, no doubled slashes. */
export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^(\.\/)+/, '').replace(/\/$/, '');
}

export function checkSource(x: unknown, where: string, errors: string[]): x is GraphSource {
  if (!isObject(x)) {
    errors.push(`${where}: source is missing`);
    return false;
  }
  const start = errors.length;
  if (!isString(x.adapter)) errors.push(`${where}: source.adapter is missing`);
  if (!isString(x.root)) errors.push(`${where}: source.root is missing`);
  else if (isAbsolutePath(x.root)) errors.push(`${where}: source.root is an absolute path; it must be a name`);
  if (!isString(x.generatedAt) || Number.isNaN(Date.parse(x.generatedAt))) errors.push(`${where}: source.generatedAt is not a timestamp`);
  if (x.tool !== undefined && typeof x.tool !== 'string') errors.push(`${where}: source.tool is not a string`);
  return errors.length === start;
}

/**
 * Checks an object read from a `.code.json` file. Artifacts or dependencies
 * that are broken are reported and dropped, so one bad row doesn't cost the
 * whole file; a wrong kind, version, or source makes the file unusable.
 */
export function checkCodeGraph(x: unknown): Checked<CodeGraph> {
  const errors: string[] = [];
  if (!isObject(x) || x.kind !== 'code-graph') return { errors: ['not a code graph (kind is not "code-graph")'] };
  if (x.version !== 1) return { errors: [`code graph version ${String(x.version)} is not supported`] };
  if (!checkSource(x.source, 'code graph', errors)) return { errors };
  if (!Array.isArray(x.artifacts)) return { errors: ['code graph: artifacts is not a list'] };
  if (!Array.isArray(x.dependencies)) return { errors: ['code graph: dependencies is not a list'] };

  const artifacts: Artifact[] = [];
  const ids = new Set<string>();
  x.artifacts.forEach((a: unknown, i: number) => {
    const at = `artifact ${i}`;
    if (!isObject(a) || !isString(a.id)) return errors.push(`${at}: no id`);
    if (ids.has(a.id)) return errors.push(`${at}: id ${a.id} is used twice`);
    if (!(ARTIFACT_KINDS as readonly unknown[]).includes(a.kind)) return errors.push(`${at} (${a.id}): unknown kind ${String(a.kind)}`);
    if (!isString(a.name)) return errors.push(`${at} (${a.id}): no name`);
    if (a.path !== undefined && (!isString(a.path) || isAbsolutePath(a.path))) return errors.push(`${at} (${a.id}): path must be relative`);
    if (a.role !== undefined && !(ARTIFACT_ROLES as readonly unknown[]).includes(a.role)) return errors.push(`${at} (${a.id}): unknown role ${String(a.role)}`);
    ids.add(a.id);
    artifacts.push({ ...(a as unknown as Artifact), ...(a.path !== undefined ? { path: normalizePath(a.path as string) } : {}) });
  });
  // Parents are checked once every id is known; a dangling parent is dropped, not the artifact.
  for (const a of artifacts) {
    if (a.parent !== undefined && !ids.has(a.parent)) {
      errors.push(`artifact ${a.id}: parent ${a.parent} doesn't exist`);
      delete a.parent;
    }
  }
  const dependencies: Dependency[] = [];
  x.dependencies.forEach((d: unknown, i: number) => {
    const at = `dependency ${i}`;
    if (!isObject(d) || !isString(d.from) || !isString(d.to)) return errors.push(`${at}: no from or to`);
    if (!ids.has(d.from) || !ids.has(d.to)) return errors.push(`${at}: ${d.from} → ${d.to} names an artifact that doesn't exist`);
    if (!(DEPENDENCY_KINDS as readonly unknown[]).includes(d.kind)) return errors.push(`${at}: unknown kind ${String(d.kind)}`);
    if (d.weight !== undefined && !(typeof d.weight === 'number' && d.weight > 0)) return errors.push(`${at}: weight must be a positive number`);
    dependencies.push(d as unknown as Dependency);
  });
  return { value: { kind: 'code-graph', version: 1, source: x.source as GraphSource, artifacts, dependencies }, errors };
}

/** How many dependencies point at and from each artifact, weighted. Every adapter gets these for free. */
export function fanInOut(graph: CodeGraph): Map<string, { fanIn: number; fanOut: number }> {
  const out = new Map(graph.artifacts.map((a) => [a.id, { fanIn: 0, fanOut: 0 }]));
  for (const d of graph.dependencies) {
    const w = d.weight ?? 1;
    out.get(d.from)!.fanOut += w;
    out.get(d.to)!.fanIn += w;
  }
  return out;
}
