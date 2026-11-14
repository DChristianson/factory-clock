# Factory Clock

Factory Clock is a set of visualizations for coding-agent sessions. It draws each session 32 ways: timelines, trees, graphs, distributions, and five "hero" views with a look of their own. The explorer puts one on a stage, with a shelf of cards under it to move between them (or two side by side, to compare). A small panel called the puck filters the shelf by tags.

It runs as a static web page: <https://dchristianson.github.io/factory-clock/>. Under the explorer, a workspace picker lists the workspaces the page has, each a project's sessions, code, and plans, by name and time range. One is selected at a time, and every view draws it; the page starts on a generated example. You can also choose your own files, which become a workspace. Nothing is installed, and the files you choose never leave your browser. The published page counts visits with Google Analytics.

Factory Clock started inside [Snagboat](https://github.com/DChristianson/snagboat), a VS Code extension that records Claude Code and GitHub Copilot sessions. It moved to this repository in November 2026, keeping the git history of its folder in Snagboat (`packages/viz`). Earlier history, from before that folder existed, stays in Snagboat. Factory Clock reads the event files Snagboat writes.

## The views

The shelf shows them in this order. Standard views use the page's theme. Hero views draw their own ground and palette, and go last.

**Hero views**

| View | What it shows |
| --- | --- |
| Living Network | You, the agents, subagents, and tool categories on one dark field, lit by the work moving between them as the sessions replay. |
| Session Fingerprint | Each run as a signature of turns, subagent branches, retry loops, and quiet gaps. Up to three are overprinted to compare. |
| Conversation Landscape | What each actor talked about. A dot per actor, its most distinctive words around it, and closeness for how much they interacted. |
| Terminal Board | A split-flap board with a region per actor, showing what each last said or did as the sessions replay. |
| Factory Clock | A dial for every loaded session. Angle is time, rings are depth from you to the tools, arcs are activity, and a hand sweeps through. |

The hero views replay sessions on a shared clock with play, scrub, speed and loop controls.

**Standard views:** Turn tree, Context timeline, Session strips, Cost per prompt, Context fill, Sequence diagram, Event graph, Actor graph, Prompt terms, Gantt and waterfall, Treemap, Heatmap, Tool-call ribbon, Week in one picture, Histogram, Box and violin, Ridgeline, Scatter plot, Bubble chart, Sunburst, Calendar heatmap, Radar, Parallel coordinates, Streamgraph, Sankey, Adjacency matrix, Swimlane.

Each view has an address: the page's URL with `#` and the view's catalog id, such as `https://dchristianson.github.io/factory-clock/#atlas`. Opening it puts that view on the stage, dropping any filters that hide it. The address bar follows the view on stage as you flip, without adding to the browser's history, so copying it links to what you see. An id the catalog doesn't have opens the view you saw last, or the first.

The catalog in [`src/catalog.ts`](src/catalog.ts) has each view's description and tags. Tags come from five facets: category (what question it answers), purpose (informative or expressive), level (one session, or several), dimension (time, actor, quantity, ...), and design language. The design behind each view is in [docs/visualization-explorer.md](docs/visualization-explorer.md).

Every view acknowledges the prior art it draws on: the chart type it is, and any technique or picture it borrows. Each view names them at the foot of its slide ("After Shneiderman 1992 · …"); press the line for the full credits, with links to the sources. They come from the `credits` in the catalog.

## Build and run

Requires Node.js 24 or later.

```bash
npm ci
npm run build    # type-check, bundle, and assemble the page in site/
npm test         # the unit tests
```

Open `site/index.html` in a browser, or serve the `site/` folder with any static file server. The page starts on the generated example workspace. To see your own, choose or drop Snagboat's daily event files (`events/YYYY-MM-DD.jsonl`), a project folder, or a `.workspace.json` package under the picker.

To list workspace packages made by the scrape script on the page, name their folder (the one holding `index.js`) in `FC_WORKSPACES` when you build, as an absolute path or relative to the repository:

```bash
FC_WORKSPACES=../my-workspaces npm run build
```

The build copies that folder's `.js` files into `site/workspaces/` and adds `workspaces/index.js` to the page. Without the variable it copies nothing, and the page lists only its built-in workspaces. The Pages workflow doesn't set it, so the public page never carries real project data. Packages are never committed to this repository.

The build script is [`scripts/site.js`](scripts/site.js). It bundles [`src/main.ts`](src/main.ts) into `site/factory-clock.js` with esbuild, copies the page's scripts and stylesheets into `site/`, and writes a script tag for every file in `viz/`. A new visualizer needs no edit to the page.

On every push to `main`, the [Pages workflow](.github/workflows/pages.yml) runs the same build and deploys `site/` to GitHub Pages. The [CI workflow](.github/workflows/ci.yml) builds and tests every push and pull request.

## Add a visualizer

A visualizer is one plain browser script in `viz/` that registers itself with `window.factoryClock.register`, plus an entry in the catalog. [CONTRIBUTING.md](CONTRIBUTING.md) has the steps and a checklist. [docs/visualizer-contract.md](docs/visualizer-contract.md) has the full interface: `register`, `mount`, the instance methods, `ctx`, the data, and styling.

## How the page fits together

The page's script tags set three globals, in this order.

| Global | Set by | What it is |
| --- | --- | --- |
| `window.factoryClockKit` | `vizkit.js` | The helpers each visualizer gets as `ctx` |
| `window.factoryClock` | `viz/registry.js` | The registry the visualizers call `register` on |
| `window.factoryClockExplore` | `explore.js` | The explorer, mounted by the page with a source object that lists and loads sessions |

The page's bundle, `factory-clock.js`, loads last. It holds the workspaces in memory, draws the picker, builds the session views of the selected one, and mounts the explorer over it. The visualizers don't know which page they run in. The explorer hands them the sessions.

## Input

Every view draws `SessionView` objects. `buildSessionView` in [`src/schema/sessionModel.ts`](src/schema/sessionModel.ts) builds one per session from `NormalizedEvent`s, the event format in Snagboat's [schema.md](https://github.com/DChristianson/snagboat/blob/main/docs/schema.md). Snagboat stores those events as daily JSONL files.

`src/schema/` is a copy of the parts of Snagboat's schema package this page uses. Its [README](src/schema/README.md) says which Snagboat commit it came from. Factory Clock keeps its own copy instead of sharing a package with Snagboat. The copies will drift, and an agent can bring them back in step when needed.

Any tool that writes `NormalizedEvent` JSONL can feed Factory Clock. The page reads no other format. The fields the views use are listed in [the visualizer contract](docs/visualizer-contract.md#the-data).

Text fields (prompts, reply excerpts, session names) are present only when Snagboat's text capture was on. Every view draws without them.

### Findings come later

The page shows no findings. Inside Snagboat, the page replayed Snagboat's heuristics to mark findings on the sessions. Factory Clock has no heuristics of its own. A later plan will have Snagboat export its findings and plans to a file, and the page will load that file beside the event files. Until then, views that can show findings show none.

## Rules the code keeps

- **No runtime dependencies.** Each visualizer is one plain browser script. There are no modules, no framework, and no charting library. They draw with SVG and the DOM. Fonts are system stacks, and no font files load.
- **Its own theme.** Colors come from `--fc-*` tokens in [`theme.css`](theme.css), with a light and a dark value from `prefers-color-scheme`. Hero views keep their own palettes, scoped to the view in [`viz.css`](viz.css). The theme test checks both.
- **Only its own imports.** The TypeScript imports only its own files, including the schema copy. The boundary test checks it.
- **Text through `textContent`.** Prompt and reply text is never written as HTML.

## Privacy

The files you load never leave your browser. The published page sends one page view to Google Analytics, with no query or hash in its address. The hash holds only the id of the view on stage. A copy you build or serve yourself sends nothing. See [PRIVACY.md](PRIVACY.md).

## Layout

| Path | What's there |
| --- | --- |
| `viz/` | One script per visualizer, and `registry.js`, which they register with |
| `vizkit.js` | The helpers the visualizers get as `ctx`: DOM, formatting, tooltip, replay clock, force layout |
| `explore.js` | The explorer: session and project pickers, stage and shelf, and puck |
| `theme.css`, `viz.css` | The color tokens, and the visualizers' and explorer's styles |
| `hosts/web/` | The page's `index.html` and stylesheet |
| `src/main.ts` | The page's bundle entry |
| `src/catalog.ts` | The catalog and the tag taxonomy |
| `src/explorerModel.ts` | The explorer's state |
| `src/web/` | The page's code: example workspace, the JSONL reader, the loader, the workspace store and picker, an in-memory session source |
| `src/schema/` | The copy of Snagboat's event types and session-view builder |
| `src/test/` | The unit tests, run by `scripts/runUnit.js` |
| `scripts/site.js` | Builds the page in `site/`, with `scripts/siteWorkspaces.js` for `FC_WORKSPACES` |
| `docs/` | The visualizer contract and the explorer's design |

## License

MIT. See [LICENSE](LICENSE).
