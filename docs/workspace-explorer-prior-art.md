# Prior art: whole-project pictures

Gathered 2026-11-12 for the [workspace explorer](workspace-explorer.md) proposal by a web survey run from this session. Each URL below appeared in search results or was fetched during the survey; none has been read closely by the owner yet, so treat the notes as leads, not citations. The survey was asked for technique and fitness for a no-dependency SVG implementation, which is what the notes report.

Format per entry: **Name** — what it shows / metaphor. *Encoding:* highlights. *URL.* *SVG fitness:* note.

## A. Spatial "maps" of a codebase

1. **Software Cartography / Codemap (Kuhn, Loretan, Erni, Nierstrasz, 2008–2010)** — a consistent "world map" of a codebase; artifacts placed by vocabulary similarity (LSI + MDS), rendered as an island/contour landscape; thematic overlays (packages, calls, open editors of co-workers) reuse the same stable layout like an atlas. *Encoding:* position = semantic similarity, hills = code size, overlay arcs = dependencies, markers = other developers' open files. *URLs:* https://scg.unibe.ch/archive/papers/Kuhn10bSoftwareMaps.pdf , https://arxiv.org/html/1001.2386 . *SVG fitness:* high; precompute layout offline, draw contours as `<path>`s. Known pitfall: users misread semantic proximity as structural dependency.

2. **CodeSurveyor (Hawes, Marshall, Anslow, VISSOFT 2015)** — cartographic map of multi-MLOC code; files = "states" inside "continents", zoomable across abstraction levels. *Encoding:* nested polygon regions (Voronoi-treemap-like), labels by zoom level. *URL:* https://vissoft.dcc.uchile.cl/program.html (program listing). *SVG fitness:* high if polygons are precomputed; no public tool.

3. **Voronoi treemaps for software metrics (Balzer & Deussen, 2005; van Hees' stable variant)** — package/class/method hierarchy as nested organic polygons; stable power-diagram variants keep shape across versions. *Encoding:* area = LOC/metric, nesting = hierarchy, color = metric. *URLs:* https://graphics.uni-konstanz.de/publikationen/Balzer2005VoronoiTreemapsVisualization/Balzer2005VoronoiTreemapsVisualization.pdf , https://www.sciencedirect.com/science/article/abs/pii/S0950584916302828 , https://arxiv.org/pdf/2508.03445 (Neighborhood-Preserving Voronoi Treemaps, 2025). *SVG fitness:* medium; the Lloyd-relaxation layout is ~150 lines of JS but iterative; stable variants matter for animation.

4. **Hilbert/Moore treemaps (varg-dev, EuroVis 2021)** — hierarchy laid along a space-filling curve so siblings stay adjacent and layouts stay stable under change; outputs SVG. *Encoding:* 1-D order → 2-D locality, area = weight. *URL:* https://github.com/varg-dev/hilbert-moore-treemap-layouts-prototype . *SVG fitness:* high; the curve index function is tiny, cells are rects. No published tool maps a repository this way.

5. **Zoomable circle packing / enclosure diagram (Bostock, Flare data)** — the canonical codebase bubble map; "wasted" space reveals hierarchy. *Encoding:* nesting = folders, area = size, color = depth/type. *URLs:* https://gist.github.com/mbostock/7607535 , https://mbostock.github.io/protovis/ex/pack.html . *SVG fitness:* very high; pack layout is a few dozen lines.

6. **GitHub Next repo-visualizer (Wattenberger, 2021)** — circle-pack map committed into READMEs; explored import edges and recently/often-changed highlights. *Encoding:* circle = file, color = language, size = bytes, recursive force relaxation per folder. *URLs:* https://githubnext.com/projects/repo-visualization/ , https://dev.to/aurelionakamura/i-rebuilt-the-archived-repo-visualizer-as-a-zero-dependency-theme-aware-codebase-map-4mmi (zero-dependency rebuild). *SVG fitness:* very high; static SVG output already proven.

7. **CodeScene hotspot map** — circle-packed folders with files colored by Code Health, sized by LOC, filtered by team/author; change-coupling lines appear on hover. *Encoding:* red/yellow severity, temporal (change frequency) × structural overlay. *URL:* https://docs.enterprise.codescene.io/latest/guides/technical/hotspots.html . *SVG fitness:* very high; essentially #5 plus behavioral color.

8. **Sunburst / icicle / radial icicle** — radial or rectangular partition of package structure; icicle is more accurate, sunburst preferred aesthetically. *URLs:* https://people.cs.vt.edu/~north/infoviz/sunburst.pdf , https://www.iadisportal.org/ijcsis/papers/2017210202.pdf , https://arxiv.org/pdf/2307.10481 . *SVG fitness:* very high.

## B. 2.5D / 3D metaphors

9. **CodeCity (Wettel & Lanza, 2007–2011)** — packages = districts, classes = buildings; treemap-based layout gives stable locality. *Encoding:* height = methods, footprint = attributes, color = metric; later variants show evolution and vulnerabilities. *URLs:* https://www.inf.usi.ch/lanza/PUBS/P/Wett2008a.pdf , https://arxiv.org/pdf/1705.05476 (JSCity), https://arxiv.org/pdf/2509.23297 (Code Arcades, 2025). *SVG fitness:* high as an isometric projection (boxes = three parallelograms); treemap layout is simple.

10. **HPI 2.5D software maps (Limberger, Trapp, Scheibel, Döllner)** — treemap with extruded cells; sketchiness encodes uncertainty, color weaving for development activity, in-situ diff of two revisions, procedural textures for change. *URLs:* https://dl.acm.org/doi/pdf/10.1145/3430036.3432753 , https://www.researchgate.net/publication/335062804_Advanced_Visual_Metaphors_and_Techniques_for_Software_Maps . *SVG fitness:* high in isometric; sketchiness and weaving are doable with filters and hatch patterns.

11. **ScrumCity / "Conceptual Visualisation" (Alshakhouri, Buchan, MacDonell, IST 2018)** — the closest prior art to code+plan: CodeCity buildings linked to Scrum artifacts (sprints, stories) with synchronized navigation. *URL:* https://arxiv.org/pdf/2105.00705 . *SVG fitness:* high; the linking is data-level, not rendering-level.

12. **Software Galaxies (HPI, VINCI 2021) and anvaka's Software Galaxies** — files/packages as stars; HPI's uses LDA topics for layout, anvaka's uses force layout of npm/PyPI/etc. dependency graphs (1M+ nodes, Three.js). *URLs:* https://dl.acm.org/doi/fullHtml/10.1145/3481549.3481573 , https://flowingdata.com/2015/07/22/interactive-lets-you-fly-through-a-software-galaxy/ , https://github.com/elthommy/depgalaxy . *SVG fitness:* medium; a 2-D starfield with glow filters is cheap; force layout must be precomputed or small.

13. **Isometric contribution skylines (github-city, contrib-skyline, Skyline)** — commit calendar extruded into an isometric city; pure-SVG generators run in GitHub Actions. *Encoding:* height = commits/day, lit windows = activity, themes. *URLs:* https://github.com/Zain1024/github-city , https://github.com/ilyasaalmadani/contrib-skyline , https://github.com/Naresh-x86/Skyline . *SVG fitness:* very high; all are already static SVG. None encode code structure.

## C. Dependency-centric layouts

14. **Hierarchical Edge Bundling (Holten, TVCG 2006)** — radial tree of the module hierarchy with dependency edges routed as B-splines through the hierarchy, revealing implicit parent-level coupling. *URLs:* https://www.cs.jhu.edu/~misha/ReadingSeminar/Papers/Holten06.pdf , https://www.cs.kent.edu/~jmaletic/cs69995-PC/papers/Holten07.pdf (traces + massive sequence views). *SVG fitness:* very high; cubic Bézier through LCA control points, ~100 lines.

15. **Dependency Wheel / chord diagram (Zaninotto, 2013)** — packages as arcs on a disc, chords = depends-on; hover masks the rest. *URLs:* https://github.com/fzaninotto/DependencyWheel , http://www.redotheweb.com/DependencyWheel/ , https://exakat.readthedocs.io/en/latest/Reference/Reports/dependency_wheel.html . *SVG fitness:* very high; scales to ~50 nodes.

16. **Sourcetrail / SciTools Understand butterfly graph** — ego-centric node-link: selected symbol in the middle, callers left, callees right; bundle nodes collapse fan-out. *URLs:* https://github.com/CoatiSoftware/Sourcetrail/blob/master/DOCUMENTATION.md , https://scitools.com/graphs , https://blog.scitools.com/graphlist/ . *SVG fitness:* high for a focus view; not a whole-system picture.

17. **CodeSee codebase maps / Review Maps (acquired by GitKraken 2024)** — collapsed-folder dependency diagram with arrows; a PR automatically gets a map of touched files and their dependencies. *URLs:* https://docs.codesee.io/docs/explore-your-map , https://docs.codesee.io/docs/review-maps-for-visual-studio-code . *SVG fitness:* high; the "diff-scoped subgraph" idea transfers directly to agent sessions.

## D. Plan / roadmap metaphors

18. **Metro-map project plans (Stott & Rodgers, ~2005; MetroMap SPIE 2010; MetroSets)** — lines = teams/tracks, stations = tasks/milestones, interchanges = shared or dependent items, time left→right, terminus = deprecation. *URLs:* https://www.researchgate.net/publication/4175427_Automatic_layout_of_project_plans_using_a_metro_map_metaphor , https://www.spiedigitallibrary.org/conference-proceedings-of-spie/7530/1/Applying-the-metro-map-to-software-development-management/10.1117/12.837752.short , https://github.com/vincentmakes/metro-map-builder (zero-dependency vanilla-JS SVG), https://github.com/rstockm/Metroviz . *SVG fitness:* very high; octilinear polylines, round-rect station markers, "depends on" arrows already exist in those tools.

19. **Jira Plans dependency map / Linear + issue-graph** — Jira: tiles with arrows, red arrow = off-track dependency; Linear has a Gantt timeline and a scope/velocity "project graph"; the community `issue-graph` renders blocks and parent/sub-issue edges. *URLs:* https://support.atlassian.com/jira-software-cloud/docs/what-is-the-dependencies-report-in-advanced-roadmaps/ , https://linear.app/docs/project-graph , https://github.com/shdennlin/issue-graph . *SVG fitness:* high; simple layered DAG.

20. **Software Evolution Storylines (Ogawa & Ma, SoftVis 2010) / code_swarm** — developers as narrative lines that converge when they touch the same files; metro-map aesthetics; code_swarm is the animated organic version. *URLs:* https://vis.cs.ucdavis.edu/papers/softvis_storylines.pdf , https://flowingdata.com/2010/10/12/software-evolution-storylines/ . *SVG fitness:* high (smooth polylines); layout heuristic needed; a ready-made metaphor for agent sessions as "characters".

21. **Gource (Caudwell, 2009)** — animated force-directed file tree, users fly in and fire beams at files they change. *URLs:* https://github.com/acaudwell/Gource , https://www.researchgate.net/publication/221321566_Gource_visualizing_software_version_control_history . *SVG fitness:* medium; a static "long-exposure" of the Gource tree is feasible.

## E. Knowledge-graph "galaxy" views

22. **Obsidian galaxy plugins (Galaxy View, Stellar Graph 3D, Knowledge Atlas)** — vault as starfield: folders = nebulae, hubs = black holes, time-travel growth, or star/planet/moon hierarchy with "knowledge health" (orphans, stale notes). *URLs:* https://community.obsidian.md/plugins/galaxy-view , https://github.com/thor040175/stellar-graph-3d , https://community.obsidian.md/plugins/knowledge-atlas . *SVG fitness:* medium; the orbital hierarchy is trivially 2-D SVG; untyped edges are the known weakness.

## F. Visualizing AI-agent activity over a codebase (2025–2026)

23. **AgentPlay (Entelligence, open source)** — session as a visual map (files, dirs, tools, subagents, errors) plus replayable timeline with subagent lanes; supports Claude Code, Codex, Cursor, Copilot, OpenCode, Kiro. *URL:* https://dev.to/entelligenceai/agentplay-understand-what-your-coding-agents-actually-do-51k3 . *SVG fitness:* high; the "session map over the file tree" is the nearest neighbor to a code+agent hero.

24. **Hook-based Claude Code observability dashboards (agents-observe, disler's multi-agent-observability, Mohano, CCAM)** — hooks → SQLite/WebSocket → swim-lane timelines per agent, pulse charts, Kanban, task-dependency views; none show code structure. *URLs:* https://github.com/simple10/agents-observe , https://github.com/disler/claude-code-hooks-multi-agent-observability , https://hulryung.github.io/mohano/ , https://github.com/hoangsonww/Claude-Code-Agent-Monitor . *SVG fitness:* high (lanes/timelines), but all are React/Vue.

25. **Academic agent-trace visualization** — "Illuminating LLM Coding Agents" (Wang et al., 2025) compares code evolution across debugging iterations; TraceView (agentic program-repair trajectories); TraceLab (sessions → requests → steps hierarchy, open dataset of Claude Code/Codex traces); Agent ATO (interaction timelines from logs). *URLs:* https://arxiv.org/abs/2508.12555 , https://arxiv.org/pdf/2606.22110 , https://github.com/uw-syfi/TraceLab , https://arxiv.org/pdf/2609.08301 , https://www.heavybit.com/library/article/visualization-for-ai-code-review . *SVG fitness:* n/a (research prototypes); useful for the session→request→step data model.

## Surveys

- Chotisarn, Merino et al., "A Systematic Literature Review of Modern Software Visualization," J. Visualization 2020. https://link.springer.com/article/10.1007/s12650-020-00647-w , https://arxiv.org/pdf/2003.00643
- Alomari, Vendome, Rizkallah, "A Comprehensive Evaluation Framework of Software Visualizations Effectiveness," TVCG 2024. https://www.researchgate.net/publication/374395053_A_Comprehensive_Evaluation_Framework_of_Software_Visualizations_Effectiveness
- "State-of-the-Art in Software Security Visualization: A Systematic Review," 2025 (taxonomy: graph / notation / matrix / metaphor-based). https://arxiv.org/html/2509.20385
- Merino et al., "Software visualization today: systematic literature review" (ACM). https://dl.acm.org/doi/10.1145/2994310.2994327
- Lhuillier et al., "State of the art in edge and trail bundling techniques"; see https://arxiv.org/pdf/2108.05467 for the edge-path bundling follow-up.

## What nobody seems to have done

Every lineage above owns one axis. Code maps (Codemap, CodeSurveyor, circle packing, CodeCity, HPI software maps) give a stable spatial substrate and sometimes overlay dependencies or per-file change activity, but know nothing about *planned* work. Plan tools (Jira Plans, Linear, metro-map roadmaps, issue-graph) draw tasks and blocks/parent edges with no notion of which files a task touches. Agent observability tools (AgentPlay, agents-observe, Mohano, TraceLab) render sessions as swim-lane timelines or file lists; only AgentPlay projects a session onto the file tree, none onto a dependency-aware map, and none link sessions to the task that spawned them. The one explicit code+process bridge is ScrumCity (2018), a 3-D CodeCity synchronized with Scrum sprints, pre-agents and never web/SVG. Storylines and Gource show *humans* converging on files over time but were never applied to agent sessions or to planned work. No found work does the three-way join: a stable code map with build and import edges bundled over it, plan items anchored to the regions they touch with blocks/parent edges drawn as metro lines or storylines, and agent sessions traced as paths across that map over time, in one design language. Also unexplored: a Hilbert-curve layout for a repository (stable, animation-friendly, trivially SVG), and "long-exposure" static renderings of agent activity (a Gource or code_swarm frame frozen as a print) as a hero image.
