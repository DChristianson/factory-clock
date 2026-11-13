/**
 * The visualizer catalog and the taxonomy its tags come from (see
 * docs/visualization-explorer.md, and docs/workspace-explorer.md for the
 * subject facet, why, hero, thumbnail, and credits). Renderers live in the package's viz/ and
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

/** How a view draws on someone's work (docs/workspace-explorer.md, "Credits"). */
export const CREDIT_RELATIONS = {
  form: 'The chart type itself',
  technique: 'A layout or algorithm it uses',
  metaphor: 'A picture it borrows',
  design: 'The source of its own design',
} as const;

export type CreditRelation = keyof typeof CREDIT_RELATIONS;

/**
 * One work a view draws on. `by` is written out in full; the short form on
 * screen is each person's last name ("Wettel & Lanza", "Bruls et al."), or,
 * where a last name won't do (an organization, a two-word surname), the
 * short form given in parentheses at the end: 'Karen Spärck Jones (Spärck Jones)'.
 */
export interface Credit {
  work: string;
  by: string;
  year?: number;
  /** Only a link someone has opened and checked; https. */
  url?: string;
  relation: CreditRelation;
  /** One line: what was taken. */
  note?: string;
}

/** The short form of a credit's `by`, as the puck's After line and the Credits list show it. */
export function creditName(by: string): string {
  const given = /\(([^()]+)\)\s*$/.exec(by);
  if (given) return given[1].trim();
  const people = by.split(/\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*/).map((p) => p.trim()).filter(Boolean);
  const last = people.map((p) => p.split(/\s+/).pop() as string);
  return last.length > 2 ? `${last[0]} et al.` : last.join(' & ');
}

/** A credit as the After line cites it: "Shneiderman 1992". */
export function creditCite(credit: Credit): string {
  return credit.year === undefined ? creditName(credit.by) : `${creditName(credit.by)} ${credit.year}`;
}

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
  /** The work it draws on, at least one; a view that is original names this project's design document. The puck's After line and the page's Credits list show them. */
  credits: Credit[];
  tags: VisualizerTags;
}

/** The most sessions the explorer loads at once; every SessionView carries all of a session's calls and prompts. */
export const EXPLORE_SESSION_CAP = 8;

/** This project's design documents, and the other sources the views' designs came from. Every URL below was opened before it was recorded. */
const DESIGN_DOC = 'https://github.com/DChristianson/factory-clock/blob/main/docs/visualization-explorer.md';
const SNAGBOAT_DESIGN = 'https://github.com/DChristianson/snagboat/blob/fc9a72bb87925445fc279bf8b352484fe32fb262/docs/design';
const designDoc = (anchor: string, note: string): Credit => ({ work: 'Design: visualization explorer', by: 'DChristianson', year: 2026, url: `${DESIGN_DOC}#${anchor}`, relation: 'design', note });
const CONVERSATION_VIEW: Credit = { work: 'Design: conversation-aware view', by: 'DChristianson', url: `${SNAGBOAT_DESIGN}/conversation-view.md`, relation: 'design', note: 'Snagboat’s design that first drew this view' };
const CONCEPT_PAGES: Credit = { work: 'Hero visualization concept pages', by: 'ChatGPT', url: `${SNAGBOAT_DESIGN}/agent_visualization_concept_pages.pdf`, relation: 'design', note: 'Generated by ChatGPT (gpt-6): the view’s purpose, visual model, encoding, interactions, and guardrails' };
const heroDoc = (anchor: string): Credit => designDoc(anchor, 'The hero view’s design, with its look from the design canvas’s mockup');
const PLAYFAIR_LINE: Credit = { work: 'The Commercial and Political Atlas', by: 'William Playfair', year: 1786, url: 'https://en.wikipedia.org/wiki/William_Playfair', relation: 'form', note: 'The line chart of a quantity over time' };
const PLAYFAIR_BAR: Credit = { ...PLAYFAIR_LINE, note: 'The bar chart' };
const SANKEY: Credit = { work: 'The Thermal Efficiency of Steam Engines', by: 'Matthew H. P. R. Sankey', year: 1898, url: 'https://doi.org/10.1680/imotp.1898.19100', relation: 'form', note: 'The Sankey diagram, in Kennedy and Sankey’s report to the Institution of Civil Engineers' };
const HERSCHEL: Credit = { work: 'A scatterplot of double-star observations', by: 'John F. W. Herschel', year: 1833, url: 'https://doi.org/10.1002/jhbs.20078', relation: 'form', note: 'The first scatterplot, as Friendly and Denis (2005, linked) attribute it' };
const FORCE_LAYOUT: Credit = { work: 'Graph drawing by force-directed placement', by: 'Thomas M. J. Fruchterman and Edward M. Reingold', year: 1991, url: 'https://doi.org/10.1002/spe.4380211102', relation: 'technique', note: 'Force-directed layout: pairs repel, links pull; the kit’s is a small variant' };

/** One entry per visualizer, in carousel order. */
export const CATALOG: VisualizerEntry[] = [
  {
    id: 'turn-tree',
    title: 'Turn tree',
    description: 'Where the tokens went: by session, then prompt, then agent, then tool category.',
    why: 'To find which prompt, agent, or kind of tool spent the tokens, and click down into it.',
    credits: [{ work: 'Icicle Plots: Better Displays for Hierarchical Clustering', by: 'J. B. Kruskal and J. M. Landwehr', year: 1983, url: 'https://doi.org/10.1080/00031305.1983.10482733', relation: 'form', note: 'The icicle plot' }, CONVERSATION_VIEW],
    tags: { subject: ['sessions'], category: ['quantitative', 'actor'], purpose: ['informative'], level: ['session', 'project'], dimension: ['quantity', 'actor', 'hierarchy'], language: ['standard'] },
  },
  {
    id: 'context-timeline',
    title: 'Context timeline',
    description: 'Context sent by each model call over clock time, with prompts, compactions, findings, and limits.',
    why: 'To see the context grow toward its limit and what each compaction gave back.',
    credits: [PLAYFAIR_LINE, CONVERSATION_VIEW],
    tags: { subject: ['sessions'], category: ['temporal', 'quantitative', 'state'], purpose: ['informative'], level: ['session'], dimension: ['time', 'quantity'], language: ['standard'] },
  },
  {
    id: 'session-strips',
    title: 'Session strips',
    description: 'One row per session over clock time: turns as blocks, compactions as ticks, findings as badges. Idle gaps stay visible.',
    why: 'To see when each session ran and where the long pauses were.',
    credits: [designDoc('new-visualizers', 'An original view: one strip per session over clock time')],
    tags: { subject: ['sessions'], category: ['temporal', 'state'], purpose: ['expressive', 'informative'], level: ['project'], dimension: ['time'], language: ['standard'] },
  },
  {
    id: 'cost-per-prompt',
    title: 'Cost per prompt',
    description: 'One column per turn, tokens stacked by agent or by tool category, sessions side by side on one y axis.',
    why: 'To spot the one prompt that cost more than all the others.',
    credits: [PLAYFAIR_BAR, { ...CONVERSATION_VIEW, note: 'Snagboat’s design that proposed this view and deferred it' }],
    tags: { subject: ['sessions'], category: ['quantitative', 'conversational'], purpose: ['informative'], level: ['session', 'project'], dimension: ['quantity', 'actor'], language: ['standard'] },
  },
  {
    id: 'context-fill',
    title: 'Context fill',
    description: 'Context size per call by call index, one line per session, so sessions line up by progress rather than clock.',
    why: 'To compare how fast different sessions fill their context, whatever the clock said.',
    credits: [PLAYFAIR_LINE, designDoc('new-visualizers', 'An original view: sessions lined up by call index rather than clock')],
    tags: { subject: ['sessions'], category: ['state', 'quantitative'], purpose: ['expressive', 'informative'], level: ['project'], dimension: ['time', 'quantity'], language: ['standard'] },
  },
  {
    id: 'sequence-diagram',
    title: 'Sequence diagram',
    description: 'Who sent what to whom, in order: you, the main agent, subagents, and tool categories as lifelines, read top to bottom.',
    why: 'To read a turn as a conversation, message by message, between you, the agents, and their tools.',
    credits: [{ work: 'Unified Modeling Language 1.1', by: 'Grady Booch, James Rumbaugh, and Ivar Jacobson', year: 1997, url: 'https://en.wikipedia.org/wiki/Unified_Modeling_Language', relation: 'form', note: 'The UML sequence diagram, adopted by the OMG in 1997' }, { work: 'Message Sequence Chart (ITU-T Z.120)', by: 'International Telecommunication Union (ITU-T)', year: 1993, url: 'https://en.wikipedia.org/wiki/Message_sequence_chart', relation: 'form', note: 'Lifelines and messages read top to bottom; UML 2’s sequence diagram draws on it' }],
    tags: { subject: ['sessions'], category: ['conversational', 'actor'], purpose: ['informative'], level: ['session'], dimension: ['communication', 'actor', 'time'], language: ['standard'] },
  },
  {
    id: 'event-graph',
    title: 'Event graph',
    description: 'What led to what: prompts, model calls, tool calls, subagents, and compactions as nodes, with inferred links drawn dashed.',
    why: 'To trace which event led to which, and see which links were read and which were guessed.',
    credits: [designDoc('more-visualizers-from-the-proposal', 'From the proposal’s event or dependency graph, with inferred links drawn dashed')],
    tags: { subject: ['sessions'], category: ['dependency', 'conversational'], purpose: ['expressive', 'informative'], level: ['session'], dimension: ['dependency', 'communication'], language: ['standard'] },
  },
  {
    id: 'actor-graph',
    title: 'Actor graph',
    description: 'Who worked with whom: you, agents, subagents, models, and tool categories, joined by typed edges sized by how often they interacted.',
    why: 'To see who did the work, and who handed work to whom.',
    credits: [{ work: 'Who Shall Survive?', by: 'Jacob L. Moreno', year: 1934, url: 'https://en.wikipedia.org/wiki/Sociogram', relation: 'form', note: 'The sociogram: who chose whom, as points and lines' }, designDoc('more-visualizers-from-the-proposal', 'From the proposal’s actor interaction graph, with typed edges in fixed columns')],
    tags: { subject: ['sessions'], category: ['actor'], purpose: ['expressive', 'informative'], level: ['session', 'project'], dimension: ['actor', 'communication', 'quantity'], language: ['standard'] },
  },
  {
    id: 'prompt-terms',
    title: 'Prompt terms',
    description: 'What your prompts were about: words you used, joined when they appear in the same prompt. Word counts, not a model’s reading.',
    why: 'To see what you kept asking about, from the words in your prompts.',
    credits: [designDoc('built-so-far', 'From the proposal’s word and phrase graph, counted rather than read by a model')],
    tags: { subject: ['sessions'], category: ['semantic'], purpose: ['expressive'], level: ['session', 'project'], dimension: ['content'], language: ['standard'] },
  },
  {
    id: 'gantt',
    title: 'Gantt and waterfall',
    description: 'Where the time went: rows for you, each agent, and each tool category over clock time, or one row per turn that opens into its own time axis.',
    why: 'To see where the hours went, and how long each actor and turn was busy.',
    credits: [{ work: 'Gantt chart', by: 'Henry L. Gantt', url: 'https://en.wikipedia.org/wiki/Gantt_chart', relation: 'form', note: 'Bars of activity over time, designed around 1910–1915' }, { work: 'Dapper, a Large-Scale Distributed Systems Tracing Infrastructure', by: 'Benjamin H. Sigelman, Luiz André Barroso, Mike Burrows, Pat Stephenson, Manoj Plakal, Donald Beaver, Saul Jaspan, and Chandan Shanbhag', year: 2010, url: 'https://research.google/pubs/dapper-a-large-scale-distributed-systems-tracing-infrastructure/', relation: 'technique', note: 'A trace’s spans on one time axis, nested by what called what: the waterfall' }],
    tags: { subject: ['sessions'], category: ['temporal'], purpose: ['informative'], level: ['session'], dimension: ['time', 'actor', 'hierarchy'], language: ['standard'] },
  },
  {
    id: 'treemap',
    title: 'Treemap',
    description: 'Tokens as area: by session, turn, and tool category, or by tool category across sessions.',
    why: 'To compare spending at a glance, with area for tokens.',
    credits: [{ work: 'Tree visualization with tree-maps: 2-d space-filling approach', by: 'Ben Shneiderman', year: 1992, url: 'https://doi.org/10.1145/102377.115768', relation: 'form', note: 'The treemap' }, { work: 'Squarified Treemaps', by: 'Mark Bruls, Kees Huizing, and Jarke J. van Wijk', year: 2000, url: 'https://doi.org/10.1007/978-3-7091-6783-0_4', relation: 'technique', note: 'The squarified layout, which keeps blocks near square' }],
    tags: { subject: ['sessions'], category: ['quantitative'], purpose: ['expressive', 'informative'], level: ['session', 'project'], dimension: ['quantity', 'hierarchy'], language: ['standard'] },
  },
  {
    id: 'heatmap',
    title: 'Heatmap',
    description: 'Patterns across sessions: tokens by session and hour, tool calls by session and category, or findings by heuristic and day.',
    why: 'To find the hours, sessions, or tools where activity clusters.',
    credits: [{ work: 'A shaded table of statistics for Paris', by: 'Toussaint Loua', year: 1873, url: 'https://doi.org/10.1198/tas.2009.0033', relation: 'form', note: 'The shaded table, earliest in Loua’s 1873 atlas of Paris, as Wilkinson and Friendly (2009, linked) trace it' }],
    tags: { subject: ['sessions'], category: ['quantitative', 'temporal'], purpose: ['expressive', 'informative'], level: ['project'], dimension: ['quantity', 'time'], language: ['standard'] },
  },
  {
    id: 'tool-ribbon',
    title: 'Tool-call ribbon',
    description: 'Which tool category followed which within turns: sources on the left, what came next on the right, ribbons as wide as the step was common.',
    why: 'To see the agent’s habits: which kind of tool usually comes after which.',
    credits: [{ work: 'Mapping Change in Large Networks', by: 'Martin Rosvall and Carl T. Bergstrom', year: 2010, url: 'https://doi.org/10.1371/journal.pone.0008694', relation: 'form', note: 'The alluvial diagram, nearest to this view, which shows steps rather than stages' }, designDoc('more-visualizers-from-the-proposal', 'An original view, added beside the proposal’s')],
    tags: { subject: ['sessions'], category: ['dependency', 'conversational'], purpose: ['expressive', 'informative'], level: ['session'], dimension: ['dependency', 'communication'], language: ['standard'] },
  },
  {
    id: 'week-picture',
    title: 'Week in one picture',
    description: 'Seven days as rings around a 24-hour clock: tokens by hour as color, findings as dots, over the loaded sessions.',
    why: 'To see a week of work as one picture, by day and hour.',
    credits: [{ work: 'Design: trusted advisor, abilities', by: 'DChristianson', url: `${SNAGBOAT_DESIGN}/trusted-advisor.md#abilities`, relation: 'design', note: 'Snagboat’s advisor design, which named the week in one picture' }, designDoc('later-additions', 'An original view: seven days as rings around a 24-hour clock')],
    tags: { subject: ['sessions'], category: ['temporal', 'quantitative'], purpose: ['expressive'], level: ['project'], dimension: ['time', 'quantity'], language: ['standard'] },
  },
  {
    id: 'histogram',
    title: 'Histogram',
    description: 'How a measurement is spread: tokens per call, time between calls, or per-turn counts, stacked by session.',
    why: 'To see whether a measurement is steady, or has a long tail of outliers.',
    credits: [{ work: 'Contributions to the Mathematical Theory of Evolution. II. Skew Variation in Homogeneous Material', by: 'Karl Pearson', year: 1895, url: 'https://doi.org/10.1098/rsta.1895.0010', relation: 'form', note: 'Named the histogram, a graph already in common use' }],
    tags: { subject: ['sessions'], category: ['quantitative'], purpose: ['informative'], level: ['session', 'project'], dimension: ['quantity'], language: ['standard'] },
  },
  {
    id: 'box-violin',
    title: 'Box and violin',
    description: 'How a measurement varies from session to session: density, quartiles, and outliers, one row each.',
    why: 'To compare the spread of a measurement across sessions, not just the averages.',
    credits: [{ work: 'Exploratory Data Analysis', by: 'John W. Tukey', year: 1977, url: 'https://en.wikipedia.org/wiki/Box_plot', relation: 'form', note: 'The box-and-whisker plot' }, { work: 'Violin Plots: A Box Plot-Density Trace Synergism', by: 'Jerry L. Hintze and Ray D. Nelson', year: 1998, url: 'https://doi.org/10.1080/00031305.1998.10480559', relation: 'form', note: 'The violin plot: a box plot with the density around it' }],
    tags: { subject: ['sessions'], category: ['quantitative'], purpose: ['informative'], level: ['project'], dimension: ['quantity'], language: ['standard'] },
  },
  {
    id: 'ridgeline',
    title: 'Ridgeline',
    description: 'The shape of a per-call measurement by session or by model, as overlapping density curves on one axis.',
    why: 'To compare the shape of a distribution across sessions or models at once.',
    credits: [{ work: 'Goodbye joyplots', by: 'Claus O. Wilke', year: 2017, url: 'https://clauswilke.com/blog/2017/09/15/goodbye-joyplots/', relation: 'form', note: 'Named the ridgeline plot, formerly the joyplot' }, { work: 'Unknown Pleasures (cover)', by: 'Peter Saville', year: 1979, url: 'https://en.wikipedia.org/wiki/Unknown_Pleasures', relation: 'metaphor', note: 'Stacked pulse profiles of a pulsar, from Harold Craft’s 1970 dissertation' }],
    tags: { subject: ['sessions'], category: ['quantitative'], purpose: ['expressive', 'informative'], level: ['project'], dimension: ['quantity'], language: ['standard'] },
  },
  {
    id: 'scatter',
    title: 'Scatter plot',
    description: 'Every turn as a point: how long it ran against its tokens, model calls, or tool calls, on log axes.',
    why: 'To check whether long turns are also expensive turns, and find the ones that aren’t.',
    credits: [HERSCHEL],
    tags: { subject: ['sessions'], category: ['quantitative'], purpose: ['informative'], level: ['session', 'project'], dimension: ['quantity', 'time'], language: ['standard'] },
  },
  {
    id: 'bubble',
    title: 'Bubble chart',
    description: 'Each session by span and tokens, with area for tool calls and color for its worst finding.',
    why: 'To compare whole sessions on size, length, tool use, and findings in one view.',
    credits: [{ ...HERSCHEL, note: 'The scatterplot, here with area for a third measure; Herschel’s is the first, as Friendly and Denis (2005, linked) attribute it' }],
    tags: { subject: ['sessions'], category: ['quantitative'], purpose: ['expressive', 'informative'], level: ['project'], dimension: ['quantity', 'time'], language: ['standard'] },
  },
  {
    id: 'sunburst',
    title: 'Sunburst',
    description: 'The turn tree as rings: sessions, prompts, agents, then tool categories, with angle for tokens.',
    why: 'To follow the tokens from session to tool in one round picture.',
    credits: [{ work: 'Focus+Context Display and Navigation Techniques for Enhancing Radial, Space-Filling Hierarchy Visualizations', by: 'John Stasko and Eugene Zhang', year: 2000, url: 'https://doi.org/10.1109/INFVIS.2000.885091', relation: 'form', note: 'The sunburst' }],
    tags: { subject: ['sessions'], category: ['quantitative'], purpose: ['expressive'], level: ['session', 'project'], dimension: ['quantity', 'hierarchy', 'actor'], language: ['standard'] },
  },
  {
    id: 'calendar-heatmap',
    title: 'Calendar heatmap',
    description: 'The loaded sessions by day over weeks: tokens, model calls, or findings, a column per week.',
    why: 'To see the rhythm of work over weeks: busy days, quiet days, streaks.',
    credits: [{ work: 'Cluster and Calendar based Visualization of Time Series Data', by: 'Jarke J. van Wijk and Edward R. van Selow (van Wijk & van Selow)', year: 1999, url: 'https://doi.org/10.1109/INFVIS.1999.801851', relation: 'form', note: 'Days laid out as a calendar, colored by a measure' }],
    tags: { subject: ['sessions'], category: ['temporal', 'quantitative'], purpose: ['expressive', 'informative'], level: ['project'], dimension: ['time', 'quantity'], language: ['standard'] },
  },
  {
    id: 'radar',
    title: 'Radar',
    description: 'A profile of each session over seven measures, each axis scaled to the largest among those loaded.',
    why: 'To compare sessions’ profiles: which leaned on tools, which on long prompts, which on subagents.',
    credits: [{ work: 'Radar chart', by: 'Georg von Mayr (von Mayr)', year: 1877, url: 'https://en.wikipedia.org/wiki/Radar_chart', relation: 'form', note: 'The star plot, first used by von Mayr' }],
    tags: { subject: ['sessions'], category: ['quantitative'], purpose: ['expressive'], level: ['session', 'project'], dimension: ['quantity', 'actor'], language: ['standard'] },
  },
  {
    id: 'parallel-coords',
    title: 'Parallel coordinates',
    description: 'Every turn as a line across six measures, each axis on its own scale, colored by session.',
    why: 'To find turns that are unusual on several measures at once.',
    credits: [{ work: 'The plane with parallel coordinates', by: 'Alfred Inselberg', year: 1985, url: 'https://doi.org/10.1007/BF01898350', relation: 'form', note: 'Parallel coordinates' }],
    tags: { subject: ['sessions'], category: ['quantitative'], purpose: ['informative'], level: ['session', 'project'], dimension: ['quantity', 'time'], language: ['standard'] },
  },
  {
    id: 'streamgraph',
    title: 'Streamgraph',
    description: 'How a session’s activity changed over time: tokens by agent or model, or tool calls by category.',
    why: 'To watch the mix of agents, models, or tools shift over a session.',
    credits: [{ work: 'Stacked Graphs – Geometry & Aesthetics', by: 'Lee Byron and Martin Wattenberg', year: 2008, url: 'https://doi.org/10.1109/TVCG.2008.166', relation: 'form', note: 'The streamgraph' }, { work: 'ThemeRiver: visualizing theme changes over time', by: 'Susan Havre, Beth Hetzler, and Lucy Nowell', year: 2000, url: 'https://doi.org/10.1109/INFVIS.2000.885098', relation: 'technique', note: 'Layers stacked around a central axis' }],
    tags: { subject: ['sessions'], category: ['temporal', 'quantitative'], purpose: ['expressive'], level: ['session'], dimension: ['time', 'quantity', 'actor'], language: ['standard'] },
  },
  {
    id: 'sankey',
    title: 'Sankey',
    description: 'Where tokens went: from sessions, through the main agent or subagents, to models.',
    why: 'To follow tokens from each session, through its agents, to the models that spent them.',
    credits: [SANKEY],
    tags: { subject: ['sessions'], category: ['actor', 'quantitative'], purpose: ['expressive', 'informative'], level: ['session', 'project'], dimension: ['quantity', 'actor'], language: ['standard'] },
  },
  {
    id: 'adjacency-matrix',
    title: 'Adjacency matrix',
    description: 'Who acted on whom, as a grid: messages, delegation, model calls, and tool calls, by count.',
    why: 'To read exact counts of who acted on whom, without a tangle of lines.',
    credits: [{ work: 'A Comparison of the Readability of Graphs Using Node-Link and Matrix-Based Representations', by: 'Mohammad Ghoniem, Jean-Daniel Fekete, and Philippe Castagliola', year: 2004, url: 'https://doi.org/10.1109/INFVIS.2004.1', relation: 'technique', note: 'Why a matrix reads better than lines once a graph is dense' }],
    tags: { subject: ['sessions'], category: ['actor'], purpose: ['informative'], level: ['session', 'project'], dimension: ['actor', 'communication', 'quantity'], language: ['standard'] },
  },
  {
    id: 'swimlane',
    title: 'Swimlane',
    description: 'Who had the ball, in order: lanes for you, each agent, and tool calls, with hand-offs between them.',
    why: 'To follow the hand-offs: who had the work at each moment.',
    credits: [{ work: 'Improving Performance', by: 'Geary A. Rummler and Alan P. Brache', year: 1990, url: 'https://en.wikipedia.org/wiki/Swimlane', relation: 'form', note: 'Named the swim lane diagram; multi-column process charts date from the 1940s' }],
    tags: { subject: ['sessions'], category: ['conversational', 'actor'], purpose: ['informative', 'expressive'], level: ['session'], dimension: ['communication', 'actor'], language: ['standard'] },
  },
  // Hero views: each carries a design language of its own, and they go last.
  {
    id: 'living-network',
    title: 'Living Network',
    description: 'You, the agents, subagents, and tool categories of every loaded session on one dark field, lit by the work moving between them as the sessions replay.',
    why: 'To watch the whole system at work, with the work moving between its actors.',
    hero: true,
    credits: [heroDoc('living-network'), CONCEPT_PAGES, FORCE_LAYOUT],
    tags: { subject: ['sessions'], category: ['actor', 'temporal'], purpose: ['expressive'], level: ['session', 'project'], dimension: ['actor', 'communication', 'time'], language: ['cinematic'] },
  },
  {
    id: 'session-fingerprint',
    title: 'Session Fingerprint',
    description: 'Each run as a signature of turns, subagent branches, retry loops, and quiet gaps, up to three overprinted as ink passes to compare, the rest in a library row.',
    why: 'To compare runs of similar work by their shape: branches, retries, and pauses.',
    hero: true,
    credits: [heroDoc('session-fingerprint'), CONCEPT_PAGES, { work: 'Risograph', by: 'Riso Kagaku Corporation (Riso)', url: 'https://en.wikipedia.org/wiki/Risograph', relation: 'metaphor', note: 'Spot-color passes overprinted on uncoated stock' }],
    tags: { subject: ['sessions'], category: ['dependency', 'temporal'], purpose: ['expressive', 'informative'], level: ['session', 'project'], dimension: ['time', 'hierarchy', 'dependency', 'quantity'], language: ['risograph'] },
  },
  {
    id: 'conversation-landscape',
    title: 'Conversation Landscape',
    description: 'What each actor talked about: a dot per actor in its own hue, its most distinctive words around it, no lines; closeness is how much they interacted.',
    why: 'To see what each actor talked about, not just that they talked.',
    hero: true,
    credits: [heroDoc('conversation-landscape'), CONCEPT_PAGES, FORCE_LAYOUT, { work: 'A statistical interpretation of term specificity and its application in retrieval', by: 'Karen Spärck Jones (Spärck Jones)', year: 1972, url: 'https://doi.org/10.1108/eb026526', relation: 'technique', note: 'Inverse document frequency: a word weighs more the fewer actors use it' }],
    tags: { subject: ['sessions'], category: ['semantic', 'conversational', 'actor'], purpose: ['expressive'], level: ['session'], dimension: ['content', 'actor', 'communication'], language: ['edgeless'] },
  },
  {
    id: 'terminal-board',
    title: 'Terminal Board',
    description: 'A split-flap board with a fixed region per actor across every loaded session, showing what each last said or did as they replay, plus the queue, tokens, and status.',
    why: 'To follow what every actor is saying or doing right now, as on a station departure board.',
    hero: true,
    credits: [heroDoc('terminal-board'), CONCEPT_PAGES, { work: 'Split-flap departure boards', by: 'Solari di Udine (Solari)', url: 'https://en.wikipedia.org/wiki/Split-flap_display', relation: 'metaphor', note: 'The station board of flaps falling into place' }],
    tags: { subject: ['sessions'], category: ['conversational', 'state'], purpose: ['expressive'], level: ['session', 'project'], dimension: ['communication', 'actor', 'content'], language: ['split-flap'] },
  },
  {
    id: 'factory-clock',
    title: 'Factory Clock',
    description: 'A dial read like a watch for every loaded session: angle is time, rings are depth from you to the tools, arcs are stretches of activity, hatching is a quiet gap, and the hand sweeps through.',
    why: 'To read when work happened and how deep it went, on a dial read like a watch.',
    hero: true,
    credits: [heroDoc('factory-clock'), CONCEPT_PAGES],
    tags: { subject: ['sessions'], category: ['temporal'], purpose: ['expressive', 'informative'], level: ['session', 'project'], dimension: ['time', 'actor', 'hierarchy'], language: ['horology'] },
  },
];

/**
 * Human-readable problems with a catalog against a taxonomy: a duplicate id,
 * an empty title or description, a facet missing or empty on an entry, a
 * value outside the facet's vocabulary, or no credits or a malformed one. An empty list means it conforms.
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
    const credits: unknown = entry.credits;
    if (!Array.isArray(credits) || credits.length === 0) problems.push(`${name}: no credits`);
    else credits.forEach((c: Partial<Credit>, i) => {
      const at = `${name}: credit ${i + 1}`;
      if (!c || typeof c !== 'object') return problems.push(`${at} is not a credit`);
      if (typeof c.work !== 'string' || !c.work.trim()) problems.push(`${at} has no work`);
      if (typeof c.by !== 'string' || !c.by.trim()) problems.push(`${at} has no by`);
      if (typeof c.relation !== 'string' || !(c.relation in CREDIT_RELATIONS)) problems.push(`${at}: "${String(c.relation)}" is not a relation`);
      if (c.url !== undefined && (typeof c.url !== 'string' || !/^https:\/\/[^\s/]+\.[^\s]+$/.test(c.url))) problems.push(`${at}: url is not https`);
      if (c.year !== undefined && !(Number.isInteger(c.year) && c.year > 1000 && c.year <= 2100)) problems.push(`${at}: year is not a year`);
      if (c.note !== undefined && (typeof c.note !== 'string' || !c.note.trim())) problems.push(`${at}: empty note`);
    });
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
