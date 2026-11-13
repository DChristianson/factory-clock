/**
 * The visualizer catalog and the taxonomy its tags come from (see
 * docs/visualization-explorer.md, and docs/workspace-explorer.md for the
 * subject facet, why, hero, and thumbnail). Renderers live in the package's viz/ and
 * register by id; the page matches them to these entries, so a visualizer
 * with no entry, or an entry with a tag outside the vocabulary, is caught in
 * unit tests rather than on screen. Nothing here touches vscode or disk: the
 * web demo bundles it for the browser.
 */

export interface TaxonomyFacet {
  label: string;
  /** Each value's one-line question or meaning, shown as a tooltip in the puck. */
  values: Record<string, string>;
}

export type Taxonomy = Record<string, TaxonomyFacet>;

/**
 * Six facets. Values within a facet are not mutually exclusive: a visualizer
 * gives one or more per facet, and every facet must be given, so filters never
 * silently miss a visualizer. `dimension` is the open-ended one. Every value
 * arrives with the first view that uses it, so the puck never offers a chip
 * that matches nothing: `subject` gains code, plans, and workspace, `level`
 * gains unit, and `language` gains a look, each with its first view.
 */
export const TAXONOMY = {
  subject: {
    label: 'Subject',
    values: {
      sessions: 'What the coding agents did: sessions, turns, calls, and tools',
    },
  },
  category: {
    label: 'Category',
    values: {
      temporal: 'When did something happen, and for how long?',
      actor: 'Who interacted with whom?',
      conversational: 'What was communicated, and in what sequence?',
      dependency: 'What depended on what?',
      quantitative: 'How much, how often, how expensive?',
      state: 'What state was the system in, and how did it change?',
      semantic: 'What was the content about, and how did ideas relate?',
    },
  },
  purpose: {
    label: 'Purpose',
    values: {
      informative: 'Communicates precise information, supports inspection, or enables diagnosis',
      expressive: 'Communicates patterns, scale, complexity, activity, or structure through an engaging visual',
    },
  },
  level: {
    label: 'Level',
    values: {
      session: 'One continuous conversation or workflow',
      project: 'Multiple sessions within a project (a workspace)',
    },
  },
  dimension: {
    label: 'Dimension',
    values: {
      time: 'Time',
      actor: 'Actor (human, agent, tool)',
      hierarchy: 'Hierarchy',
      dependency: 'Dependency',
      communication: 'Communication',
      quantity: 'Quantity (cost)',
      content: 'Content (what was said)',
    },
  },
  language: {
    label: 'Design language',
    values: {
      standard: 'The page’s shared look: theme colors, in both themes',
      cinematic: 'A dark field lit by the work moving through it: glow, particles, letterbox (Living Network)',
      risograph: 'Spot-color passes overprinted on uncoated stock, grain and halftone (Session Fingerprint)',
      edgeless: 'Paper-white space, one saturated hue per actor, words instead of lines (Conversation Landscape)',
      'split-flap': 'A station board of fixed character cells; change arrives as falling flaps (Terminal Board)',
      horology: 'An enamel dial read like a watch: serif numerals, ink arcs, one orange sweep hand (Factory Clock)',
    },
  },
} satisfies Taxonomy;

export type Facet = keyof typeof TAXONOMY;

export type VisualizerTags = Record<Facet, string[]>;

export interface VisualizerEntry {
  id: string;
  title: string;
  description: string;
  /** One sentence for a visitor: why look at this view. The puck's guide shows it. */
  why: string;
  /** One of the hero views: a look of its own, meant to be shown. Kept by the shelf for last, and by the tour for its end. */
  hero?: boolean;
  /** How the gallery draws its tile: the view itself, small (the default), or a title card when it can't read at that size. */
  thumbnail?: 'live' | 'title';
  tags: VisualizerTags;
}

/** The most sessions the explorer loads at once; every SessionView carries all of a session's calls and prompts. */
export const EXPLORE_SESSION_CAP = 8;

/** One entry per visualizer, in carousel order. */
export const CATALOG: VisualizerEntry[] = [
  {
    id: 'turn-tree',
    title: 'Turn tree',
    description: 'Where the tokens went: by session, then prompt, then agent, then tool category.',
    why: 'To find which prompt, agent, or kind of tool spent the tokens, and click down into it.',
    tags: { subject: ['sessions'], category: ['quantitative', 'actor'], purpose: ['informative'], level: ['session', 'project'], dimension: ['quantity', 'actor', 'hierarchy'], language: ['standard'] },
  },
  {
    id: 'context-timeline',
    title: 'Context timeline',
    description: 'Context sent by each model call over clock time, with prompts, compactions, findings, and limits.',
    why: 'To see the context grow toward its limit and what each compaction gave back.',
    tags: { subject: ['sessions'], category: ['temporal', 'quantitative', 'state'], purpose: ['informative'], level: ['session'], dimension: ['time', 'quantity'], language: ['standard'] },
  },
  {
    id: 'session-strips',
    title: 'Session strips',
    description: 'One row per session over clock time: turns as blocks, compactions as ticks, findings as badges. Idle gaps stay visible.',
    why: 'To see when each session ran and where the long pauses were.',
    tags: { subject: ['sessions'], category: ['temporal', 'state'], purpose: ['expressive', 'informative'], level: ['project'], dimension: ['time'], language: ['standard'] },
  },
  {
    id: 'cost-per-prompt',
    title: 'Cost per prompt',
    description: 'One column per turn, tokens stacked by agent or by tool category, sessions side by side on one y axis.',
    why: 'To spot the one prompt that cost more than all the others.',
    tags: { subject: ['sessions'], category: ['quantitative', 'conversational'], purpose: ['informative'], level: ['session', 'project'], dimension: ['quantity', 'actor'], language: ['standard'] },
  },
  {
    id: 'context-fill',
    title: 'Context fill',
    description: 'Context size per call by call index, one line per session, so sessions line up by progress rather than clock.',
    why: 'To compare how fast different sessions fill their context, whatever the clock said.',
    tags: { subject: ['sessions'], category: ['state', 'quantitative'], purpose: ['expressive', 'informative'], level: ['project'], dimension: ['time', 'quantity'], language: ['standard'] },
  },
  {
    id: 'sequence-diagram',
    title: 'Sequence diagram',
    description: 'Who sent what to whom, in order: you, the main agent, subagents, and tool categories as lifelines, read top to bottom.',
    why: 'To read a turn as a conversation, message by message, between you, the agents, and their tools.',
    tags: { subject: ['sessions'], category: ['conversational', 'actor'], purpose: ['informative'], level: ['session'], dimension: ['communication', 'actor', 'time'], language: ['standard'] },
  },
  {
    id: 'event-graph',
    title: 'Event graph',
    description: 'What led to what: prompts, model calls, tool calls, subagents, and compactions as nodes, with inferred links drawn dashed.',
    why: 'To trace which event led to which, and see which links were read and which were guessed.',
    tags: { subject: ['sessions'], category: ['dependency', 'conversational'], purpose: ['expressive', 'informative'], level: ['session'], dimension: ['dependency', 'communication'], language: ['standard'] },
  },
  {
    id: 'actor-graph',
    title: 'Actor graph',
    description: 'Who worked with whom: you, agents, subagents, models, and tool categories, joined by typed edges sized by how often they interacted.',
    why: 'To see who did the work, and who handed work to whom.',
    tags: { subject: ['sessions'], category: ['actor'], purpose: ['expressive', 'informative'], level: ['session', 'project'], dimension: ['actor', 'communication', 'quantity'], language: ['standard'] },
  },
  {
    id: 'prompt-terms',
    title: 'Prompt terms',
    description: 'What your prompts were about: words you used, joined when they appear in the same prompt. Word counts, not a model’s reading.',
    why: 'To see what you kept asking about, from the words in your prompts.',
    tags: { subject: ['sessions'], category: ['semantic'], purpose: ['expressive'], level: ['session', 'project'], dimension: ['content'], language: ['standard'] },
  },
  {
    id: 'gantt',
    title: 'Gantt and waterfall',
    description: 'Where the time went: rows for you, each agent, and each tool category over clock time, or one row per turn that opens into its own time axis.',
    why: 'To see where the hours went, and how long each actor and turn was busy.',
    tags: { subject: ['sessions'], category: ['temporal'], purpose: ['informative'], level: ['session'], dimension: ['time', 'actor', 'hierarchy'], language: ['standard'] },
  },
  {
    id: 'treemap',
    title: 'Treemap',
    description: 'Tokens as area: by session, turn, and tool category, or by tool category across sessions.',
    why: 'To compare spending at a glance, with area for tokens.',
    tags: { subject: ['sessions'], category: ['quantitative'], purpose: ['expressive', 'informative'], level: ['session', 'project'], dimension: ['quantity', 'hierarchy'], language: ['standard'] },
  },
  {
    id: 'heatmap',
    title: 'Heatmap',
    description: 'Patterns across sessions: tokens by session and hour, tool calls by session and category, or findings by heuristic and day.',
    why: 'To find the hours, sessions, or tools where activity clusters.',
    tags: { subject: ['sessions'], category: ['quantitative', 'temporal'], purpose: ['expressive', 'informative'], level: ['project'], dimension: ['quantity', 'time'], language: ['standard'] },
  },
  {
    id: 'tool-ribbon',
    title: 'Tool-call ribbon',
    description: 'Which tool category followed which within turns: sources on the left, what came next on the right, ribbons as wide as the step was common.',
    why: 'To see the agent’s habits: which kind of tool usually comes after which.',
    tags: { subject: ['sessions'], category: ['dependency', 'conversational'], purpose: ['expressive', 'informative'], level: ['session'], dimension: ['dependency', 'communication'], language: ['standard'] },
  },
  {
    id: 'week-picture',
    title: 'Week in one picture',
    description: 'Seven days as rings around a 24-hour clock: tokens by hour as color, findings as dots, over the loaded sessions.',
    why: 'To see a week of work as one picture, by day and hour.',
    tags: { subject: ['sessions'], category: ['temporal', 'quantitative'], purpose: ['expressive'], level: ['project'], dimension: ['time', 'quantity'], language: ['standard'] },
  },
  {
    id: 'histogram',
    title: 'Histogram',
    description: 'How a measurement is spread: tokens per call, time between calls, or per-turn counts, stacked by session.',
    why: 'To see whether a measurement is steady, or has a long tail of outliers.',
    tags: { subject: ['sessions'], category: ['quantitative'], purpose: ['informative'], level: ['session', 'project'], dimension: ['quantity'], language: ['standard'] },
  },
  {
    id: 'box-violin',
    title: 'Box and violin',
    description: 'How a measurement varies from session to session: density, quartiles, and outliers, one row each.',
    why: 'To compare the spread of a measurement across sessions, not just the averages.',
    tags: { subject: ['sessions'], category: ['quantitative'], purpose: ['informative'], level: ['project'], dimension: ['quantity'], language: ['standard'] },
  },
  {
    id: 'ridgeline',
    title: 'Ridgeline',
    description: 'The shape of a per-call measurement by session or by model, as overlapping density curves on one axis.',
    why: 'To compare the shape of a distribution across sessions or models at once.',
    tags: { subject: ['sessions'], category: ['quantitative'], purpose: ['expressive', 'informative'], level: ['project'], dimension: ['quantity'], language: ['standard'] },
  },
  {
    id: 'scatter',
    title: 'Scatter plot',
    description: 'Every turn as a point: how long it ran against its tokens, model calls, or tool calls, on log axes.',
    why: 'To check whether long turns are also expensive turns, and find the ones that aren’t.',
    tags: { subject: ['sessions'], category: ['quantitative'], purpose: ['informative'], level: ['session', 'project'], dimension: ['quantity', 'time'], language: ['standard'] },
  },
  {
    id: 'bubble',
    title: 'Bubble chart',
    description: 'Each session by span and tokens, with area for tool calls and color for its worst finding.',
    why: 'To compare whole sessions on size, length, tool use, and findings in one view.',
    tags: { subject: ['sessions'], category: ['quantitative'], purpose: ['expressive', 'informative'], level: ['project'], dimension: ['quantity', 'time'], language: ['standard'] },
  },
  {
    id: 'sunburst',
    title: 'Sunburst',
    description: 'The turn tree as rings: sessions, prompts, agents, then tool categories, with angle for tokens.',
    why: 'To follow the tokens from session to tool in one round picture.',
    tags: { subject: ['sessions'], category: ['quantitative'], purpose: ['expressive'], level: ['session', 'project'], dimension: ['quantity', 'hierarchy', 'actor'], language: ['standard'] },
  },
  {
    id: 'calendar-heatmap',
    title: 'Calendar heatmap',
    description: 'The loaded sessions by day over weeks: tokens, model calls, or findings, a column per week.',
    why: 'To see the rhythm of work over weeks: busy days, quiet days, streaks.',
    tags: { subject: ['sessions'], category: ['temporal', 'quantitative'], purpose: ['expressive', 'informative'], level: ['project'], dimension: ['time', 'quantity'], language: ['standard'] },
  },
  {
    id: 'radar',
    title: 'Radar',
    description: 'A profile of each session over seven measures, each axis scaled to the largest among those loaded.',
    why: 'To compare sessions’ profiles: which leaned on tools, which on long prompts, which on subagents.',
    tags: { subject: ['sessions'], category: ['quantitative'], purpose: ['expressive'], level: ['session', 'project'], dimension: ['quantity', 'actor'], language: ['standard'] },
  },
  {
    id: 'parallel-coords',
    title: 'Parallel coordinates',
    description: 'Every turn as a line across six measures, each axis on its own scale, colored by session.',
    why: 'To find turns that are unusual on several measures at once.',
    tags: { subject: ['sessions'], category: ['quantitative'], purpose: ['informative'], level: ['session', 'project'], dimension: ['quantity', 'time'], language: ['standard'] },
  },
  {
    id: 'streamgraph',
    title: 'Streamgraph',
    description: 'How a session’s activity changed over time: tokens by agent or model, or tool calls by category.',
    why: 'To watch the mix of agents, models, or tools shift over a session.',
    tags: { subject: ['sessions'], category: ['temporal', 'quantitative'], purpose: ['expressive'], level: ['session'], dimension: ['time', 'quantity', 'actor'], language: ['standard'] },
  },
  {
    id: 'sankey',
    title: 'Sankey',
    description: 'Where tokens went: from sessions, through the main agent or subagents, to models.',
    why: 'To follow tokens from each session, through its agents, to the models that spent them.',
    tags: { subject: ['sessions'], category: ['actor', 'quantitative'], purpose: ['expressive', 'informative'], level: ['session', 'project'], dimension: ['quantity', 'actor'], language: ['standard'] },
  },
  {
    id: 'adjacency-matrix',
    title: 'Adjacency matrix',
    description: 'Who acted on whom, as a grid: messages, delegation, model calls, and tool calls, by count.',
    why: 'To read exact counts of who acted on whom, without a tangle of lines.',
    tags: { subject: ['sessions'], category: ['actor'], purpose: ['informative'], level: ['session', 'project'], dimension: ['actor', 'communication', 'quantity'], language: ['standard'] },
  },
  {
    id: 'swimlane',
    title: 'Swimlane',
    description: 'Who had the ball, in order: lanes for you, each agent, and tool calls, with hand-offs between them.',
    why: 'To follow the hand-offs: who had the work at each moment.',
    tags: { subject: ['sessions'], category: ['conversational', 'actor'], purpose: ['informative', 'expressive'], level: ['session'], dimension: ['communication', 'actor'], language: ['standard'] },
  },
  // Hero views: each carries a design language of its own, and they go last.
  {
    id: 'living-network',
    title: 'Living Network',
    description: 'You, the agents, subagents, and tool categories of every loaded session on one dark field, lit by the work moving between them as the sessions replay.',
    why: 'To watch the whole system at work, with the work moving between its actors.',
    hero: true,
    tags: { subject: ['sessions'], category: ['actor', 'temporal'], purpose: ['expressive'], level: ['session', 'project'], dimension: ['actor', 'communication', 'time'], language: ['cinematic'] },
  },
  {
    id: 'session-fingerprint',
    title: 'Session Fingerprint',
    description: 'Each run as a signature of turns, subagent branches, retry loops, and quiet gaps, up to three overprinted as ink passes to compare, the rest in a library row.',
    why: 'To compare runs of similar work by their shape: branches, retries, and pauses.',
    hero: true,
    tags: { subject: ['sessions'], category: ['dependency', 'temporal'], purpose: ['expressive', 'informative'], level: ['session', 'project'], dimension: ['time', 'hierarchy', 'dependency', 'quantity'], language: ['risograph'] },
  },
  {
    id: 'conversation-landscape',
    title: 'Conversation Landscape',
    description: 'What each actor talked about: a dot per actor in its own hue, its most distinctive words around it, no lines; closeness is how much they interacted.',
    why: 'To see what each actor talked about, not just that they talked.',
    hero: true,
    tags: { subject: ['sessions'], category: ['semantic', 'conversational', 'actor'], purpose: ['expressive'], level: ['session'], dimension: ['content', 'actor', 'communication'], language: ['edgeless'] },
  },
  {
    id: 'terminal-board',
    title: 'Terminal Board',
    description: 'A split-flap board with a fixed region per actor across every loaded session, showing what each last said or did as they replay, plus the queue, tokens, and status.',
    why: 'To follow what every actor is saying or doing right now, as on a station departure board.',
    hero: true,
    tags: { subject: ['sessions'], category: ['conversational', 'state'], purpose: ['expressive'], level: ['session', 'project'], dimension: ['communication', 'actor', 'content'], language: ['split-flap'] },
  },
  {
    id: 'factory-clock',
    title: 'Factory Clock',
    description: 'A dial read like a watch for every loaded session: angle is time, rings are depth from you to the tools, arcs are stretches of activity, hatching is a quiet gap, and the hand sweeps through.',
    why: 'To read when work happened and how deep it went, on a dial read like a watch.',
    hero: true,
    tags: { subject: ['sessions'], category: ['temporal'], purpose: ['expressive', 'informative'], level: ['session', 'project'], dimension: ['time', 'actor', 'hierarchy'], language: ['horology'] },
  },
];

/**
 * Human-readable problems with a catalog against a taxonomy: a duplicate id,
 * an empty title or description, a facet missing or empty on an entry, or a
 * value outside the facet's vocabulary. An empty list means it conforms.
 */
export function validateCatalog(catalog: VisualizerEntry[], taxonomy: Taxonomy): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of catalog) {
    const name = entry.id || '(no id)';
    if (!entry.id) problems.push('an entry has no id');
    else if (seen.has(entry.id)) problems.push(`duplicate id "${entry.id}"`);
    seen.add(entry.id);
    if (!entry.title) problems.push(`${name}: empty title`);
    if (!entry.description) problems.push(`${name}: empty description`);
    if (typeof entry.why !== 'string' || !entry.why.trim()) problems.push(`${name}: empty why`);
    if (entry.hero !== undefined && typeof entry.hero !== 'boolean') problems.push(`${name}: hero is not true or false`);
    if (entry.thumbnail !== undefined && entry.thumbnail !== 'live' && entry.thumbnail !== 'title') problems.push(`${name}: thumbnail is not live or title`);
    const tags: Record<string, unknown> = entry.tags ?? {};
    for (const [facet, def] of Object.entries(taxonomy)) {
      const values = tags[facet];
      if (!Array.isArray(values) || values.length === 0) {
        problems.push(`${name}: facet "${facet}" is missing or empty`);
        continue;
      }
      for (const v of values) if (typeof v !== 'string' || !(v in def.values)) problems.push(`${name}: "${String(v)}" is not a ${facet} value`);
    }
    for (const facet of Object.keys(tags)) if (!(facet in taxonomy)) problems.push(`${name}: "${facet}" is not a facet`);
  }
  return problems;
}

/** Vocabulary values no visualizer is tagged with: chips that would match nothing. The catalog keeps this empty. */
export function unusedValues(catalog: VisualizerEntry[], taxonomy: Taxonomy): string[] {
  const used = new Set(catalog.flatMap((e) => Object.entries(e.tags ?? {}).flatMap(([f, vs]) => (vs ?? []).map((v) => `${f}:${v}`))));
  return Object.entries(taxonomy).flatMap(([f, def]) => Object.keys(def.values).filter((v) => !used.has(`${f}:${v}`)).map((v) => `${f}:${v}`));
}
