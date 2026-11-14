// The explorer: a stage with one view on it, a shelf of cards (one per view
// the filters allow) under it, pickers for sessions and the project, and a
// puck that names the view on stage and filters the shelf by its tags. See
// docs/workspace-explorer.md, "Stage and shelf" and "The puck as a guide". It sees only
// ctx (the visualization kit and the tooltip) and a source object, which the
// web page (src/web/page.ts) gives it.
// Plain DOM; all data is written with textContent, never innerHTML.
//
//   window.factoryClockExplore.mount(root, source, ctx) -> { shown(), hidden(), loading(text | null), destroy() }
//     mount replaces root's children; loading(text) covers the stage with a loading screen until loading(null)
//   window.factoryClockExplore.shown()  forwards to the mounted tab (for the page's tab switch)
//   window.factoryClockExplore.hidden() the tab was hidden: every slide stops (setActive(false))
//
// source, a plain object:
//   listSessions()       ask for every session, newest start first; answered through onSessions
//   loadSessions(ids)    load these sessions for the explorer, in this order; answered through onExplorer
//   closeExplorer()      unload them; answered through onExplorer with null
//   getState()           the tab's saved state, {} the first time
//   setState(partial)    merge these keys into the saved state
//   onSessions(cb)       cb({ sessions, headlines }) on each list push
//   onExplorer(cb)       cb(ExplorerState | null) on each explorer push (src/explorerModel.ts)
//   openSessionId()      the session open in the Sessions tab, or null (pre-checked the first time)
//   listUnits(subject)   optional: the pickable units of 'code' or 'plans' ({ subject, id, label, detail }[])
//   loadUnits(subject, ids) optional: pick those units; answered through onWorkspace
//   onWorkspace(cb)      optional: cb(Workspace) whenever any subject's picks change
//
// ctx: the helpers from vizkit.js plus tooltip, showTip(evt, rows), hideTip(), and optionally
// shapeFor(workspace, subject) -> Shape | null (src/model/shape.ts shapeOfWorkspace) and
// guideShelf(catalog, filters) -> entries (src/explorerModel.ts: the views the filters allow, in the
// guide's order; without it, the filters alone in catalog order). The tab adds
// select(selection) for each visualizer it mounts (see viz/registry.js).
//
// Saved state: { picked: string[], current: visualizer id, compare: visualizer id | null, filters: { facet: [values] }, replay: { speed, loop },
// subjects: { [visualizer id]: 'sessions' | 'code' | 'plans' | 'workspace' },
// collapsed: boolean, corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right',
// selection: { sessionId?, turnId?, range?, focusId? } | null,
// puckTab: 'here' | 'ask' | 'map', tourPace: seconds per view, asked: true once the first visit has opened Ask }.
// The guide's answers are the filters (subject, category, purpose, language) and replay.stills (Motion).
(function () {
  // The most sessions the picker allows; matches EXPLORE_SESSION_CAP in src/catalog.ts.
  const CAP = 8;
  const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  // The stage never gets shorter than this; in a window too short for it, the page scrolls and the dock sticks to the window's bottom.
  const MIN_STAGE_HEIGHT = 320;
  // Below the dock: the body's bottom padding, and a little air.
  const BELOW_DOCK = 16;
  // The room the collapsed puck takes at the dock's end when it sits at the bottom; matches the 112px in viz.css .dock.
  const PUCK_ROOM = 112;
  // A card's glyph per subject, and the order of a card's category dots (a dot's place says which category).
  const SUBJECT_GLYPH = { sessions: '◷', code: '⌗', plans: '☰', workspace: '◫' };
  const CATEGORY_ORDER = ['temporal', 'actor', 'conversational', 'dependency', 'quantitative', 'state', 'semantic'];
  const DRAG_THRESHOLD = 4; // px of movement before a press on the puck's head counts as a drag
  // The puck's three bodies (docs/workspace-explorer.md, "The puck as a guide").
  const PUCK_TABS = [['here', 'Here'], ['ask', 'Ask'], ['map', 'Map']];
  // Ask's words for the category values (the taxonomy's own question is the chip's title).
  const CATEGORY_ASK = { temporal: 'when?', actor: 'who?', conversational: 'what was said?', dependency: 'what depends?', quantitative: 'how much?', state: 'what state?', semantic: 'about what?' };
  const PURPOSE_ASK = { informative: 'understanding', expressive: 'impressing' };
  // Tour pace, seconds per view; the tour reads it (hero views get their replay's length instead).
  const TOUR_PACES = [10, 20, 40, 60];
  const DEFAULT_PACE = 20;
  // The Map's grid, in viewBox units: the row labels' column, the column labels' band, a cell's width, a dot's radius and pitch.
  const MAP_LABEL_W = 70;
  const MAP_HEAD_H = 58;
  const MAP_CELL_W = 40;
  const MAP_RIGHT = 30; // room for the last column's slanted label
  const MAP_DOT_R = 3;
  const MAP_PITCH = 9;
  const MAP_PAD = 4;
  const MAP_LANG_HUES = 7; // .puck-map .lang-1 … lang-7 in viz.css; standard is lang-0
  let mounted = null;

  // The shelf without ctx.guideShelf: the filters alone (any value within a facet, every facet), in catalog order.
  function filterShelf(catalog, filters) {
    return catalog.filter((e) => Object.entries(filters).every(([facet, vals]) => !vals || !vals.length || vals.some((v) => (e.tags[facet] || []).includes(v))));
  }

  // A credit's people as the After line cites them; matches creditName in src/catalog.ts, whose unit tests cover it.
  function creditName(by) {
    const given = /\(([^()]+)\)\s*$/.exec(by);
    if (given) return given[1].trim();
    const last = by.split(/\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*/).map((p) => p.trim()).filter(Boolean).map((p) => p.split(/\s+/).pop());
    return last.length > 2 ? `${last[0]} et al.` : last.join(' & ');
  }

  function mount(root, source, ctx) {
    const viz = window.factoryClock;
    const { el, compact, fmt, clip, short, duration, agentName, modelShort, ms } = ctx;
    const saved = source.getState() || {};
    // The first visit (nothing saved about the puck or its answers) opens Ask, brief, once.
    const firstVisit = saved.asked === undefined && saved.collapsed === undefined && !(saved.filters && Object.values(saved.filters).some((v) => Array.isArray(v) && v.length));
    const st = {
      picked: Array.isArray(saved.picked) ? saved.picked.slice(0, CAP) : null, // null until the first show pre-checks the open session
      currentId: typeof saved.current === 'string' ? saved.current : null,
      compareId: typeof saved.compare === 'string' ? saved.compare : null, // the view pinned on the stage's left while comparing
      workspace: null, // the Workspace for every subject's picks, when the source serves one
      filters: saved.filters && typeof saved.filters === 'object' ? saved.filters : {},
      collapsed: firstVisit ? false : saved.collapsed !== false, // starts collapsed, but for the first visit
      tab: firstVisit ? 'ask' : PUCK_TABS.some(([k]) => k === saved.puckTab) ? saved.puckTab : 'here',
      askBrief: firstVisit, // Ask shows only its first two questions until asked for more
      pace: TOUR_PACES.includes(saved.tourPace) ? saved.tourPace : DEFAULT_PACE,
      order: [], // the allowed view ids, in the guide's order
      corner: CORNERS.includes(saved.corner) ? saved.corner : 'bottom-right',
      selection: saved.selection && typeof saved.selection === 'object' ? saved.selection : null,
      list: null, // { sessions, headlines }
      taxonomy: null,
      catalog: [],
      sessions: [], // SessionView[] loaded, in picked order
      notLoaded: [],
      requested: false, // whether this page already asked for the picked sessions
      subjects: saved.subjects && typeof saved.subjects === 'object' ? saved.subjects : {}, // the subject picked on a view that draws several, by view id
    };
    const save = (partial) => source.setState(partial);
    if (firstVisit) save({ asked: true });
    // The hero views' playback settings (speed, loop) are shared by every replay and remembered with the tab.
    if (saved.replay && typeof ctx.setReplayPrefs === 'function') ctx.setReplayPrefs(saved.replay);
    const stopReplayPrefs = typeof ctx.onReplayPrefs === 'function' ? ctx.onReplayPrefs((prefs) => save({ replay: prefs })) : () => {};
    const isLive = (s) => Date.now() - ms(s.lastTs) < 10 * 60 * 1000;
    const sessionLabel = (s) => (s.name ? clip(s.name, 48) : short(s.sessionId));

    // ---------- layout ----------
    const pickNote = el('span', { class: 'muted small' });
    const loadBtn = el('button', { text: 'Load', title: 'Load the picked sessions into the explorer' });
    loadBtn.addEventListener('click', () => {
      if (!st.picked || !st.picked.length) return;
      st.requested = true;
      source.loadSessions(st.picked);
    });
    const unloadBtn = el('button', { text: 'Unload', title: 'Drop the loaded sessions', hidden: true });
    unloadBtn.addEventListener('click', () => {
      st.requested = true;
      source.closeExplorer();
    });
    const listHost = el('div', { class: 'session-list' });
    const loadedNote = el('p', { class: 'muted small' });
    const picker = el('section', { class: 'picker', 'aria-label': 'Pick sessions' }, [
      el('div', { class: 'controls' }, [el('span', { class: 'muted small', text: 'Sessions, newest first' }), el('span', { class: 'spacer' }), pickNote, loadBtn, unloadBtn]),
      listHost,
      loadedNote,
    ]);

    const stage = el('div', { class: 'stage', tabindex: 0, role: 'group', 'aria-label': 'The view on stage; the arrow keys move along the shelf' });
    const prevBtn = el('button', { text: '‹ Previous', 'aria-label': 'Previous view on the shelf' });
    const nextBtn = el('button', { text: 'Next ›', 'aria-label': 'Next view on the shelf' });
    const compareBtn = el('button', { text: 'Compare', 'aria-pressed': 'false', title: 'Keep this view on the left and step through the others beside it' });
    const navNote = el('span', { class: 'muted small nav-note', 'aria-live': 'polite' }); // its text never wraps the nav (viz.css .nav-note), so the dock keeps its height
    const toPicker = el('button', { class: 'link to-picker', text: 'Sessions and project ↓', title: 'Pick and load sessions and the project, below the explorer' });
    toPicker.addEventListener('click', () => picker.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    const shelf = el('div', { class: 'shelf', role: 'group', 'aria-label': 'Views the filters allow; click one to put it on the stage' });
    const nav = el('div', { class: 'nav' }, [prevBtn, nextBtn, compareBtn, navNote, el('span', { class: 'spacer' }), toPicker]);
    const dock = el('div', { class: 'dock' }, [shelf, nav]);
    const explorer = el('section', { class: 'explorer', 'aria-label': 'Visualizers' }, [stage, dock]);
    prevBtn.addEventListener('click', () => step(-1));
    nextBtn.addEventListener('click', () => step(1));
    compareBtn.addEventListener('click', toggleCompare);
    const arrowKeys = (e) => {
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        step(1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        step(-1);
      }
    };
    stage.addEventListener('keydown', (e) => {
      if (e.target === stage) arrowKeys(e); // a visualizer's own focusable parts keep their keys
    });
    shelf.addEventListener('keydown', (e) => {
      if (e.target.classList && e.target.classList.contains('card')) arrowKeys(e);
    });

    const puckTitle = el('strong', { text: 'Explore' });
    const puckPos = el('span', { class: 'muted small' });
    const collapseBtn = el('button', { class: 'link puck-toggle', 'aria-expanded': String(!st.collapsed) });
    collapseBtn.addEventListener('click', () => {
      st.collapsed = !st.collapsed;
      save({ collapsed: st.collapsed });
      renderCollapsed();
    });

    // Here: the view on stage, why to look at it, what it's after, what's next, and its tags as chips that filter.
    const puckDesc = el('p', { class: 'muted small puck-desc' });
    const puckWhy = el('p', { class: 'small puck-why', hidden: true });
    // The work the view draws on (entry.credits), one name per credit, linked when it has a url.
    const puckAfter = el('p', { class: 'muted small puck-after', hidden: true });
    const puckNext = el('p', { class: 'small puck-next', hidden: true });
    const facets = el('div');
    const filterNote = el('span', { class: 'muted small' });
    const clearBtn = el('button', { class: 'link', text: 'Clear', 'data-key': 'here:clear' });
    clearBtn.addEventListener('click', () => setFilters({}));
    const hereBody = el('div', { class: 'puck-panel puck-here' }, [puckDesc, puckWhy, puckAfter, puckNext, facets, el('div', { class: 'puck-foot' }, [filterNote, el('span', { class: 'spacer' }), clearBtn])]);

    // Ask: the preferences as questions; the answers are the filters (and the replay's stills, and the tour's pace).
    const askQuestions = el('div', { class: 'ask-questions' });
    const askMore = el('button', { class: 'link small ask-more', text: 'More questions: For, Look, Motion, Tour pace', 'data-key': 'ask:more' });
    askMore.addEventListener('click', () => {
      st.askBrief = false;
      renderPuck();
    });
    const askCount = el('span', { class: 'small ask-count', 'aria-live': 'polite' });
    const askClear = el('button', { class: 'link', text: 'Clear', title: 'Clear every answer', 'data-key': 'ask:clear' });
    askClear.addEventListener('click', () => {
      st.pace = DEFAULT_PACE;
      save({ tourPace: st.pace });
      if (typeof ctx.setReplayPrefs === 'function') ctx.setReplayPrefs({ stills: false });
      setFilters({});
    });
    const askBody = el('div', { class: 'puck-panel puck-ask' }, [askQuestions, askMore, el('div', { class: 'puck-foot' }, [askCount, el('span', { class: 'spacer' }), askClear])]);

    // Map: the catalog as a grid of subject by category, a dot per view.
    const mapHost = el('div', { class: 'map-host' });
    const mapCaption = el('p', { class: 'muted small map-caption', 'aria-live': 'polite' });
    const mapKey = el('div', { class: 'map-key small muted' });
    const mapBody = el('div', { class: 'puck-panel puck-map' }, [mapHost, mapCaption, mapKey]);

    const panels = { here: hereBody, ask: askBody, map: mapBody };
    const tabBtns = {};
    const tabRow = el(
      'div',
      { class: 'puck-tabs', role: 'tablist', 'aria-label': 'Guide' },
      PUCK_TABS.map(([k, label], i) => {
        const b = el('button', { class: 'puck-tab', role: 'tab', id: `puck-tab-${k}`, 'aria-controls': `puck-panel-${k}`, text: label });
        panels[k].id = `puck-panel-${k}`;
        panels[k].setAttribute('role', 'tabpanel');
        panels[k].setAttribute('aria-labelledby', `puck-tab-${k}`);
        b.addEventListener('click', () => setTab(k));
        // The tab row is one stop: the arrow keys (and Home, End) move along it.
        b.addEventListener('keydown', (e) => {
          const to = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: PUCK_TABS.length - 1 }[e.key];
          if (to === undefined) return;
          e.preventDefault();
          const [next] = PUCK_TABS[(to + PUCK_TABS.length) % PUCK_TABS.length];
          setTab(next);
          tabBtns[next].focus();
        });
        tabBtns[k] = b;
        return b;
      })
    );
    function setTab(k) {
      st.tab = k;
      save({ puckTab: k });
      renderTabs();
      renderPuck();
    }
    function renderTabs() {
      for (const [k] of PUCK_TABS) {
        const on = k === st.tab;
        tabBtns[k].classList.toggle('on', on);
        tabBtns[k].setAttribute('aria-selected', String(on));
        tabBtns[k].setAttribute('tabindex', on ? '0' : '-1');
        panels[k].hidden = !on;
      }
    }

    const mismatchNote = el('p', { class: 'muted small', hidden: true });
    const puckBody = el('div', { class: 'puck-body' }, [hereBody, askBody, mapBody, mismatchNote]);
    const puckHead = el('div', { class: 'puck-head' }, [puckTitle, puckPos, collapseBtn]);
    const puck = el('aside', { class: 'puck', 'aria-label': 'Guide: the view on stage, what you want to see, and a map of the views' }, [puckHead, tabRow, puckBody]);
    function renderCollapsed() {
      puck.classList.toggle('collapsed', st.collapsed);
      const label = st.collapsed ? 'Expand' : 'Collapse';
      collapseBtn.textContent = label;
      collapseBtn.title = `${label}. Drag, or press an arrow key, to move the puck to another corner.`;
      collapseBtn.setAttribute('aria-expanded', String(!st.collapsed));
    }
    renderCollapsed();
    renderTabs();

    // The puck sits in one of the window's corners. The explorer hears which, so its dock can stand clear.
    function placePuck(corner) {
      st.corner = corner;
      puck.dataset.corner = corner;
      explorer.dataset.puck = corner;
    }
    function movePuck(corner) {
      placePuck(corner);
      save({ corner });
    }
    placePuck(st.corner);

    // Dragging by the head (the whole circle when collapsed) drops the puck in the corner of the quadrant it's let go in.
    // Move and up are heard on the window: a quick drag leaves the head before the threshold is crossed.
    let drag = null; // { id, x, y, moved } while pressed
    let dragged = false; // the press that just ended was a drag, so its click isn't a click on the toggle
    const onDragMove = (e) => {
      if (e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!drag.moved) {
        drag.moved = true;
        puckHead.setPointerCapture(e.pointerId); // so a release outside the window still ends the drag
        puck.classList.add('dragging');
      }
      puck.style.transform = `translate(${dx}px, ${dy}px)`;
    };
    const endDrag = (e, drop) => {
      if (e.pointerId !== drag.id) return;
      const { moved } = drag;
      stopDragging();
      if (!moved) return;
      dragged = true;
      if (drop) movePuck(`${e.clientY < window.innerHeight / 2 ? 'top' : 'bottom'}-${e.clientX < window.innerWidth / 2 ? 'left' : 'right'}`);
    };
    const onDragUp = (e) => endDrag(e, true);
    const onDragCancel = (e) => endDrag(e, false);
    function stopDragging() {
      drag = null;
      window.removeEventListener('pointermove', onDragMove);
      window.removeEventListener('pointerup', onDragUp);
      window.removeEventListener('pointercancel', onDragCancel);
      puck.classList.remove('dragging');
      puck.style.transform = '';
    }
    puckHead.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || drag) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
      dragged = false;
      window.addEventListener('pointermove', onDragMove);
      window.addEventListener('pointerup', onDragUp);
      window.addEventListener('pointercancel', onDragCancel);
    });
    puckHead.addEventListener(
      'click',
      (e) => {
        if (dragged) e.stopPropagation();
        dragged = false;
      },
      true
    );
    // The keyboard's way to the same place: an arrow key crosses to that side, keeping the other axis.
    puckHead.addEventListener('keydown', (e) => {
      const [v, h] = st.corner.split('-');
      const to = { ArrowUp: `top-${h}`, ArrowDown: `bottom-${h}`, ArrowLeft: `${v}-left`, ArrowRight: `${v}-right` }[e.key];
      if (!to) return;
      e.preventDefault();
      movePuck(to);
    });

    // The explorer takes the window; picking and loading sit below it, a scroll (or the nav's button) away.
    const projectHost = el('div', { class: 'project-picker' });
    // Replaces whatever the page put here before mounting (the web page's loading screen).
    root.replaceChildren(
      explorer,
      el('div', { class: 'below-carousel' }, [el('p', { class: 'muted small', text: 'Experimental: every view draws the same loaded data its own way. The puck names the one on stage, asks what you want to see, and orders the shelf by your answers.' }), picker, projectHost]),
      puck
    );

    // ---------- stage height ----------
    // The stage takes the height left in the window, so the dock under it stays
    // in view and a drawing taller than that scrolls inside its slide. The
    // height doesn't follow the view: nothing on the stage or in the dock
    // changes height from one view to the next (the slide head is one line at
    // a fixed height, the nav's "n of m" can't wrap it, off-stage neighbors
    // sit out of flow), so it changes only with the window, and every view
    // fills the same slide (vizkit's fitHeight / fitter).
    function fitStage() {
      if (!explorer.offsetParent) return; // the tab is hidden; shown() fits it
      const top = stage.getBoundingClientRect().top + window.scrollY;
      stage.style.height = `${Math.max(MIN_STAGE_HEIGHT, window.innerHeight - top - dock.offsetHeight - BELOW_DOCK)}px`;
    }

    // ---------- session picker ----------
    function renderPicker() {
      const picked = st.picked || [];
      pickNote.textContent = `${picked.length} of ${CAP} picked`;
      loadBtn.disabled = picked.length === 0;
      const list = st.list;
      if (!list) {
        listHost.replaceChildren(el('p', { class: 'muted', text: 'Loading…' }));
        return;
      }
      if (list.sessions.length === 0) {
        listHost.replaceChildren(el('p', { class: 'muted', text: 'No agent sessions yet.' }));
        return;
      }
      const rows = list.sessions.map((s) => {
        const on = picked.includes(s.sessionId);
        const box = el('input', { type: 'checkbox', 'aria-label': `Pick ${s.name ? `${s.name} (${short(s.sessionId)})` : s.sessionId}` });
        box.checked = on;
        box.disabled = !on && picked.length >= CAP;
        const toggle = () => {
          const now = st.picked || [];
          if (now.includes(s.sessionId)) st.picked = now.filter((id) => id !== s.sessionId);
          else if (now.length < CAP) st.picked = [...now, s.sessionId];
          else return;
          save({ picked: st.picked });
          renderPicker();
        };
        box.addEventListener('change', toggle);
        const tr = el('tr', { class: on ? 'selected' : undefined, tabindex: 0, 'aria-selected': String(on) }, [
          el('td', { class: 'pick' }, [box]),
          el('td', { text: `${isLive(s) ? '● ' : ''}${new Date(s.firstTs).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` }),
          el('td', { text: agentName(s.agent) }),
          el('td', { text: s.models.map(modelShort).join(', ') || '—' }),
          el('td', { class: 'num', text: fmt(s.prompts) }),
          el('td', { class: 'num', text: fmt(s.modelCalls) }),
          el('td', { class: 'num', text: compact(s.tokens) }),
          el('td', { class: 'num', text: duration(s.firstTs, s.lastTs) }),
          el('td', { title: s.name ? `${s.name} (${s.sessionId})` : s.sessionId }, [
            ...(s.name ? [el('span', { text: clip(s.name, 48) }), el('span', { class: 'muted', text: ` ${short(s.sessionId)}` })] : [el('span', { class: 'muted', text: short(s.sessionId) })]),
            list.headlines && list.headlines[s.sessionId] ? el('div', { class: 'muted small', text: clip(list.headlines[s.sessionId], 90), title: `Headline by the advisor (model output): ${list.headlines[s.sessionId]}` }) : null,
          ]),
        ]);
        // The row is the checkbox's hit target; the checkbox itself already toggled.
        tr.addEventListener('click', (e) => e.target !== box && toggle());
        tr.addEventListener('keydown', (e) => e.key === 'Enter' && toggle());
        return tr;
      });
      // The list is rebuilt on every pick and push, and can be long now: keep its scroll position.
      const scrolled = listHost.querySelector('.list-wrap');
      const scrollTop = scrolled ? scrolled.scrollTop : 0;
      const wrap = el('div', { class: 'list-wrap' }, [
        el('table', {}, [
          el('thead', {}, [el('tr', {}, ['', 'Started', 'Agent', 'Models', 'Prompts', 'Model calls', 'Tokens', 'Span', 'Session'].map((h, i) => el('th', { class: i === 0 ? 'pick' : i >= 4 && i <= 7 ? 'num' : undefined, text: h })))]),
          el('tbody', {}, rows),
        ]),
      ]);
      listHost.replaceChildren(wrap);
      wrap.scrollTop = scrollTop;
    }

    function renderLoaded() {
      unloadBtn.hidden = st.sessions.length === 0;
      if (!st.sessions.length && !st.notLoaded.length) {
        loadedNote.textContent = st.picked && st.picked.length ? 'Nothing loaded yet: press Load to draw the picked sessions.' : 'Nothing loaded: pick sessions here and press Load.';
        return;
      }
      const names = st.sessions.map((v) => sessionLabel(v.summary)).join(', ');
      const missing = st.notLoaded.map(short).join(', ');
      loadedNote.textContent = `Loaded ${st.sessions.length} session${st.sessions.length === 1 ? '' : 's'}: ${names || '—'}.${missing ? ` Not loaded (unknown, or no longer retained): ${missing}.` : ''}`;
    }

    // ---------- project picker ----------
    // Code roots and plan roots, as the source lists them; checked when the
    // workspace it last sent has them. The views that draw them read the
    // workspace from onWorkspace.
    function renderProject() {
      if (typeof source.listUnits !== 'function') {
        projectHost.replaceChildren();
        return;
      }
      const ws = st.workspace;
      const groups = [['code', 'Code'], ['plans', 'Plans']].map(([subject, label]) => {
        const units = source.listUnits(subject) || [];
        if (!units.length) return null;
        const have = new Set(((ws && ws[subject]) || []).map((g) => g.source.root));
        const rows = units.map((u) => {
          const box = el('input', { type: 'checkbox', 'aria-label': `Pick ${u.label}` });
          box.checked = have.has(u.id);
          box.addEventListener('change', () => {
            const now = units.filter((x) => (x.id === u.id ? box.checked : have.has(x.id))).map((x) => x.id);
            source.loadUnits(subject, now);
          });
          return el('li', {}, [el('label', {}, [box, ` ${u.label} `, el('span', { class: 'muted small', text: u.detail })])]);
        });
        return el('div', { class: 'unit-group' }, [el('span', { class: 'muted small', text: label }), el('ul', { class: 'unit-list' }, rows)]);
      }).filter(Boolean);
      projectHost.replaceChildren(
        ...(groups.length
          ? [el('div', { class: 'controls' }, [el('span', { class: 'muted small', text: 'Project: code and plans' })]), ...groups, el('p', { class: 'muted small', text: 'Views that draw code or plans have a Draw switch above them on the stage.' })]
          : [])
      );
    }

    // ---------- stage and shelf ----------
    // [{ entry, slide, host, card, allowed, parts: [{ host, instance, sessionIds }] }] in catalog order
    const slides = [];

    // The guide's recommendation is the shelf's order: the allowed views, as ctx.guideShelf orders them.
    const shelfOrder = typeof ctx.guideShelf === 'function' ? ctx.guideShelf : filterShelf;
    const slideById = (id) => slides.find((s) => s.entry.id === id) || null;
    const allowed = () => st.order.map(slideById).filter(Boolean);
    const current = () => slides.find((s) => s.entry.id === st.currentId) || null;
    const onStage = (s) => s.allowed && (s.entry.id === st.currentId || s.entry.id === st.compareId);

    function card(entry) {
      const subjects = entry.tags.subject || [];
      const cats = entry.tags.category || [];
      const c = el(
        'button',
        {
          class: `card${entry.hero ? ' hero' : ''}`,
          title: `${entry.title}: ${entry.description}${entry.why ? `\n${entry.why}` : ''}\n${cats.join(', ')}`,
          'aria-label': entry.title,
        },
        [
          el('span', { class: 'card-glyph', 'aria-hidden': 'true', text: subjects.map((x) => SUBJECT_GLYPH[x] || '·').join('') }),
          el('span', { class: 'card-title', text: entry.title }),
          el('span', { class: 'card-dots', 'aria-hidden': 'true' }, CATEGORY_ORDER.map((cat) => el('i', { class: cats.includes(cat) ? 'on' : undefined }))),
        ]
      );
      c.addEventListener('click', () => goTo(entry.id));
      return c;
    }

    function buildSlides() {
      for (const s of slides) destroyParts(s);
      slides.length = 0;
      stage.replaceChildren();
      shelf.replaceChildren();
      st.catalog.forEach((entry, i) => {
        const host = el('div', { class: 'slide-host' });
        const subjectHost = el('div', { class: 'slide-subject' });
        const slide = el('article', { class: 'slide', 'aria-label': entry.title, hidden: true }, [
          // One line at a fixed height whatever the view (the description clips), so every slide gives its view the same room.
          el('div', { class: 'slide-head' }, [el('span', { class: 'muted small slide-pos', text: `${i + 1}/${st.catalog.length}` }), el('strong', { class: 'slide-title', text: entry.title, title: entry.title }), el('span', { class: 'muted small slide-desc', text: entry.description, title: entry.description }), subjectHost]),
          host,
        ]);
        const c = card(entry);
        slides.push({ entry, slide, host, subjectHost, card: c, allowed: true, parts: [], subjectKey: null });
        stage.append(slide);
        shelf.append(c);
      });
      if (!current()) st.currentId = st.catalog.length ? st.catalog[0].id : null;
      applyFilters();
    }

    function applyFilters() {
      st.order = shelfOrder(st.catalog, st.filters).map((e) => e.id);
      const ok = new Set(st.order);
      for (const s of slides) {
        s.allowed = ok.has(s.entry.id);
        s.card.hidden = !s.allowed;
      }
      const vis = allowed();
      // The cards in the guide's order; the hidden ones after them, in catalog order.
      shelf.replaceChildren(...vis.map((s) => s.card), ...slides.filter((s) => !s.allowed).map((s) => s.card));
      if (vis.length) {
        const cur = current();
        if (!cur || !cur.allowed) {
          // The nearest view that stays, by catalog distance.
          const at = cur ? slides.indexOf(cur) : 0;
          const nearest = vis.reduce((best, s) => (Math.abs(slides.indexOf(s) - at) < Math.abs(slides.indexOf(best) - at) ? s : best), vis[0]);
          st.currentId = nearest.entry.id;
          save({ current: st.currentId });
        }
      }
      const pinned = slides.find((s) => s.entry.id === st.compareId);
      if (st.compareId && (!pinned || !pinned.allowed || st.compareId === st.currentId)) setCompare(null);
      layout();
    }

    function goTo(id) {
      const s = slides.find((x) => x.entry.id === id);
      if (!s || !s.allowed) return;
      if (id === st.compareId) setCompare(st.currentId === id ? null : st.currentId); // the pinned view swaps sides
      st.currentId = id;
      save({ current: id });
      layout();
    }

    function step(dir) {
      const vis = allowed().filter((s) => s.entry.id !== st.compareId);
      const pos = vis.findIndex((s) => s.entry.id === st.currentId);
      const next = vis[pos + dir];
      if (next) goTo(next.entry.id);
    }

    function setFilters(filters) {
      st.filters = filters;
      save({ filters: st.filters });
      applyFilters();
    }
    // A chip, in Here or Ask: picking a value adds it to the end of its facet's picks (their order is the shelf's subject order).
    function toggleFilter(facet, v) {
      const f = st.filters[facet] || [];
      setFilters({ ...st.filters, [facet]: f.includes(v) ? f.filter((x) => x !== v) : [...f, v] });
    }

    function setCompare(id) {
      st.compareId = id;
      save({ compare: id });
    }

    // Compare pins the view on stage to the left and moves the stage on to its neighbor, so the two halves differ.
    function toggleCompare() {
      if (st.compareId) {
        setCompare(null);
        layout();
        return;
      }
      const vis = allowed();
      const pos = vis.findIndex((s) => s.entry.id === st.currentId);
      const other = vis[pos + 1] || vis[pos - 1];
      if (!other) return;
      setCompare(st.currentId);
      st.currentId = other.entry.id;
      save({ current: st.currentId });
      layout();
    }

    /**
     * Puts the current view (and the pinned one, comparing) on the stage, keeps
     * the current view's two shelf neighbors mounted off stage so the next
     * press is instant, and unmounts the rest: the carousel's three-mounted rule.
     */
    function layout() {
      const vis = allowed();
      const pos = vis.findIndex((s) => s.entry.id === st.currentId);
      stage.classList.toggle('comparing', !!st.compareId);
      for (const s of slides) {
        const i = vis.indexOf(s);
        const shown = onStage(s);
        const near = !shown && pos >= 0 && i >= 0 && Math.abs(i - pos) <= 1;
        const wasShown = !s.slide.hidden && !s.slide.classList.contains('offstage');
        s.slide.hidden = !(shown || near);
        s.slide.classList.toggle('offstage', near);
        s.slide.classList.toggle('pinned', shown && s.entry.id === st.compareId);
        if (shown || near) updateSlide(s);
        else destroyParts(s);
        // Its width may have changed (off stage, or the other half of a comparison).
        if (shown && !wasShown) for (const p of s.parts) p.instance.resize();
      }
      activate();
      renderShelf();
      renderPuck();
    }

    function renderShelf() {
      const vis = allowed();
      const pos = vis.findIndex((s) => s.entry.id === st.currentId);
      for (const s of slides) {
        const isCur = s.entry.id === st.currentId;
        s.card.classList.toggle('current', isCur);
        s.card.classList.toggle('pinned', s.entry.id === st.compareId);
        s.card.setAttribute('aria-current', String(isCur));
      }
      const out = slides.length - vis.length;
      navNote.textContent = !slides.length ? '' : vis.length ? `${pos + 1} of ${vis.length}${out ? ` (${out} filtered out)` : ''}` : 'No view has every picked tag.';
      const stepable = vis.filter((s) => s.entry.id !== st.compareId);
      const at = stepable.findIndex((s) => s.entry.id === st.currentId);
      prevBtn.disabled = at <= 0;
      nextBtn.disabled = at < 0 || at >= stepable.length - 1;
      compareBtn.setAttribute('aria-pressed', String(!!st.compareId));
      compareBtn.disabled = !st.compareId && vis.length < 2;
      compareBtn.textContent = st.compareId ? 'Stop comparing' : 'Compare';
      // Keep the current card in view, scrolling only the shelf, and clear of the puck when it sits at the bottom (viz.css .dock).
      const cur = current();
      if (cur && cur.allowed && shelf.offsetParent) {
        const left = cur.card.offsetLeft - shelf.offsetLeft;
        const right = left + cur.card.offsetWidth;
        const underLeft = st.corner === 'bottom-left' ? PUCK_ROOM : 0;
        const underRight = st.corner === 'bottom-right' ? PUCK_ROOM : 0;
        if (left < shelf.scrollLeft + underLeft) shelf.scrollLeft = left - underLeft - 8;
        else if (right > shelf.scrollLeft + shelf.clientWidth - underRight) shelf.scrollLeft = right - shelf.clientWidth + underRight + 8;
      }
    }

    // Only what's on stage runs: a visualizer that animates stops while it's off stage or the tab is hidden.
    let tabVisible = true;
    function activate() {
      for (const s of slides) {
        const on = tabVisible && onStage(s);
        for (const p of s.parts) if (typeof p.instance.setActive === 'function') p.instance.setActive(on);
      }
    }

    function destroyParts(s) {
      for (const p of s.parts) p.instance.destroy();
      s.parts = [];
      s.host.replaceChildren();
    }

    // A session-level visualizer gets one instance per loaded session, stacked
    // under the session's name; any other gets one instance with the whole list.
    // ---------- subjects ----------
    // A view lists the subjects it draws (tags.subject). It draws one that's
    // loaded: the one picked on its slide, else the first the puck's Subject
    // filter names, else the first it lists. The workspace subject needs two
    // of the others. Shapes are built once per workspace and subject.
    const SUBJECT_TEXT = { sessions: 'Sessions', code: 'Code', plans: 'Plans', workspace: 'Workspace' };
    let shapes = { workspace: null, bySubject: new Map() };
    function shapeOf(subject) {
      if (shapes.workspace !== st.workspace) shapes = { workspace: st.workspace, bySubject: new Map() };
      if (!shapes.bySubject.has(subject)) shapes.bySubject.set(subject, st.workspace && typeof ctx.shapeFor === 'function' ? ctx.shapeFor(st.workspace, subject) : null);
      return shapes.bySubject.get(subject);
    }
    function loadedSubjects() {
      const ws = st.workspace;
      const have = [];
      if (st.sessions.length) have.push('sessions');
      if (ws && ws.code && ws.code.length) have.push('code');
      if (ws && ws.plans && ws.plans.length) have.push('plans');
      if (have.length >= 2) have.push('workspace');
      return have;
    }
    const subjectsOf = (entry) => entry.tags.subject || ['sessions'];
    function subjectFor(entry, options) {
      if (!options.length) return null;
      const picked = st.subjects[entry.id];
      if (options.includes(picked)) return picked;
      return (st.filters.subject || []).find((x) => options.includes(x)) || options[0];
    }
    function needsText(entry) {
      const wants = subjectsOf(entry);
      if (wants.length === 1 && wants[0] === 'sessions') return 'No sessions loaded. Pick sessions below (Sessions and project ↓) and press Load.';
      if (wants.length === 1 && wants[0] === 'workspace') return 'This view draws the workspace: load two of sessions, code, and plans (Sessions and project ↓).';
      const names = wants.map((x) => SUBJECT_TEXT[x].toLowerCase());
      return `This view draws ${names.slice(0, -1).join(', ')}${names.length > 1 ? ' or ' : ''}${names[names.length - 1]}; none is loaded. Pick some below (Sessions and project ↓).`;
    }
    function renderSubjectSwitch(s, options, subject) {
      if (options.length < 2) {
        s.subjectHost.replaceChildren();
        return;
      }
      s.subjectHost.replaceChildren(
        ctx.modeButtons('Draw', options.map((x) => [x, SUBJECT_TEXT[x] || x]), subject, (x) => {
          st.subjects = { ...st.subjects, [s.entry.id]: x };
          save({ subjects: st.subjects });
          updateSlide(s);
        })
      );
    }

    function updateSlide(s) {
      const options = subjectsOf(s.entry).filter((x) => loadedSubjects().includes(x));
      const subject = subjectFor(s.entry, options);
      const switchKey = `${options.join()}|${subject}`;
      if (s.switchKey !== switchKey) {
        s.switchKey = switchKey;
        renderSubjectSwitch(s, options, subject);
      }
      if (!subject) {
        destroyParts(s);
        s.host.replaceChildren(el('p', { class: 'muted', text: needsText(s.entry) }));
        return;
      }
      const def = viz.get(s.entry.id);
      if (!def) {
        destroyParts(s);
        s.host.replaceChildren(el('p', { class: 'muted', text: `No renderer is registered for “${s.entry.id}”.` }));
        return;
      }
      if (subject === 'sessions') {
        updateSessions(s, def);
        return;
      }
      // Code, plans, or the workspace: one drawing of everything loaded of it.
      const key = `subject:${subject}`;
      if (s.parts.length !== 1 || s.parts[0].sessionIds !== key) {
        destroyParts(s);
        const host = el('div', { class: 'viz-host' });
        s.host.append(host);
        s.parts = [{ host, sessionIds: key, instance: def.mount(host, { ...ctx, select }) }];
      }
      const shape = subject === 'workspace' ? null : shapeOf(subject);
      s.parts[0].instance.update(st.sessions, st.selection, { subject, workspace: st.workspace, ...(shape ? { shape } : {}) });
    }

    /** Sessions, as every view has always drawn them: stacked one per session unless the view is project-level. */
    function updateSessions(s, def) {
      const sessions = st.sessions;
      const stacked = !(s.entry.tags.level || []).includes('project');
      const groups = stacked ? sessions.map((v) => [v]) : [sessions];
      const wantedIds = groups.map((g) => g.map((v) => v.summary.sessionId).join('\n'));
      const haveIds = s.parts.map((p) => p.sessionIds);
      if (wantedIds.join('\u0000') !== haveIds.join('\u0000')) {
        destroyParts(s);
        s.parts = groups.map((g, i) => {
          const host = el('div', { class: 'viz-host' });
          const part = stacked
            ? el('div', { class: 'stacked' }, [el('div', { class: 'stack-head' }, [el('strong', { text: sessionLabel(g[0].summary) }), el('span', { class: 'muted small', text: ` ${agentName(g[0].summary.agent)} · ${fmt(g[0].summary.prompts)} prompts · ${compact(g[0].summary.tokens)} tokens` })]), host])
            : host;
          s.host.append(part);
          return { host, sessionIds: wantedIds[i], instance: def.mount(host, { ...ctx, select }) };
        });
      }
      s.parts.forEach((p, i) => p.instance.update(groups[i], st.selection, {}));
    }

    // ---------- shared selection ----------
    function select(selection) {
      st.selection = selection || null;
      save({ selection: st.selection });
      for (const s of slides) if (s.parts.length) updateSlide(s);
    }

    // ---------- puck ----------
    // Every body is rebuilt on each change; the control that had focus gets it back by its data-key.
    function focusedKey() {
      const a = typeof document !== 'undefined' ? document.activeElement : null;
      return a && puck.contains(a) && typeof a.getAttribute === 'function' ? a.getAttribute('data-key') : null;
    }
    function refocus(key) {
      if (!key) return;
      const find = (n) => {
        for (const c of n.children || []) {
          if (typeof c.getAttribute === 'function' && c.getAttribute('data-key') === key) return c;
          const hit = find(c);
          if (hit) return hit;
        }
        return null;
      };
      const hit = find(puck);
      if (hit && typeof hit.focus === 'function') hit.focus();
    }
    // A chip: a button that says whether it's pressed, with the value's meaning as its title.
    function chip(text, { on, has, title, key, onClick }) {
      const c = el('button', { class: `tag${has ? ' has' : ''}${on ? ' on' : ''}`, text, 'aria-pressed': String(!!on), title, 'data-key': key });
      c.addEventListener('click', onClick);
      return c;
    }

    function renderPuck() {
      const key = focusedKey();
      const cur = current();
      const entry = cur && cur.allowed ? cur.entry : null;
      puckTitle.textContent = entry ? entry.title : st.catalog.length ? 'Nothing matches' : 'Explore';
      puckPos.textContent = entry ? `${slides.indexOf(cur) + 1}/${slides.length}` : '';
      renderHere(entry);
      renderAsk();
      renderMap(entry);
      // Catalog and registry out of step: say so here rather than drawing nothing silently.
      const registered = new Set(viz.ids());
      const unregistered = st.catalog.filter((e) => !registered.has(e.id)).map((e) => e.id);
      const uncataloged = viz.ids().filter((id) => !st.catalog.some((e) => e.id === id));
      const problems = [...(unregistered.length ? [`no renderer registered for ${unregistered.join(', ')}`] : []), ...(uncataloged.length ? [`registered but not in the catalog: ${uncataloged.join(', ')}`] : [])];
      mismatchNote.hidden = problems.length === 0;
      mismatchNote.textContent = problems.length ? `Catalog mismatch: ${problems.join('; ')}.` : '';
      refocus(key);
    }

    function renderHere(entry) {
      puckDesc.textContent = entry ? entry.description : st.catalog.length ? 'Clear a filter to see visualizers again.' : 'Waiting for the catalog…';
      puckWhy.hidden = !(entry && entry.why);
      puckWhy.replaceChildren(...(entry && entry.why ? [el('span', { class: 'puck-label', text: 'Why this view' }), entry.why] : []));
      const credits = entry && Array.isArray(entry.credits) ? entry.credits : [];
      puckAfter.hidden = credits.length === 0;
      puckAfter.replaceChildren(
        ...(credits.length ? ['After '] : []),
        ...credits.flatMap((c, i) => {
          const cite = c.year === undefined ? creditName(c.by) : `${creditName(c.by)} ${c.year}`;
          const title = `${c.work}, ${c.by}${c.year === undefined ? '' : `, ${c.year}`} (${c.relation})${c.note ? `: ${c.note}` : ''}`;
          const name = c.url ? el('a', { href: c.url, target: '_blank', rel: 'noopener', title, text: cite }) : el('span', { title, text: cite });
          return i ? [' · ', name] : [name];
        })
      );
      // Next: the following card on the shelf, in the guide's order, so the shelf reads as a path.
      const vis = allowed().filter((s) => s.entry.id !== st.compareId);
      const pos = entry ? vis.findIndex((s) => s.entry.id === entry.id) : -1;
      const next = pos >= 0 ? vis[pos + 1] : null;
      puckNext.hidden = !entry;
      if (next) {
        const go = el('button', { class: 'link puck-next-go', text: next.entry.title, title: `Put ${next.entry.title} on the stage`, 'data-key': 'here:next' });
        go.addEventListener('click', () => goTo(next.entry.id));
        puckNext.replaceChildren(el('span', { class: 'puck-label', text: 'Next' }), go, ...(next.entry.why ? [el('span', { class: 'muted', text: ` · ${next.entry.why}` })] : []));
      } else puckNext.replaceChildren(el('span', { class: 'puck-label', text: 'Next' }), el('span', { class: 'muted', text: 'This is the last view on the shelf.' }));
      const tax = st.taxonomy || {};
      facets.replaceChildren(
        ...Object.entries(tax).map(([facet, def]) =>
          el('div', { class: 'facet' }, [
            el('span', { class: 'fname', text: def.label }),
            el(
              'div',
              { class: 'chips' },
              Object.entries(def.values).map(([v, meaning]) => {
                const has = !!entry && (entry.tags[facet] || []).includes(v);
                const on = (st.filters[facet] || []).includes(v);
                return chip(v, {
                  on,
                  has,
                  key: `here:${facet}:${v}`,
                  title: `${meaning}${on ? ' (filtering)' : has ? ` (${entry.title} is tagged; click to filter)` : ' (click to filter)'}`,
                  onClick: () => toggleFilter(facet, v),
                });
              })
            ),
          ])
        )
      );
      const n = Object.values(st.filters).reduce((a, v) => a + v.length, 0);
      filterNote.textContent = n ? `${n} filter${n > 1 ? 's' : ''}: OR within a facet, AND across` : 'No filters. Outlined chips are this visualizer’s tags.';
      clearBtn.hidden = n === 0;
    }

    function renderAsk() {
      const tax = st.taxonomy;
      if (!tax) {
        askQuestions.replaceChildren(el('p', { class: 'muted small', text: 'Waiting for the catalog…' }));
        askMore.hidden = true;
        askCount.textContent = '';
        askClear.hidden = true;
        return;
      }
      const picks = (facet) => st.filters[facet] || [];
      const facetChip = (facet, v, text) => chip(text, { on: picks(facet).includes(v), key: `ask:${facet}:${v}`, title: (tax[facet] && tax[facet].values[v]) || v, onClick: () => toggleFilter(facet, v) });
      const question = (label, chips, hint) =>
        el('div', { class: 'ask-q', role: 'group', 'aria-label': label }, [el('span', { class: 'puck-label', text: label }), el('div', { class: 'chips' }, chips), hint ? el('span', { class: 'muted small ask-hint', text: hint }) : null]);
      const valuesOf = (facet) => Object.keys(tax[facet] ? tax[facet].values : {});
      const loaded = loadedSubjects();
      const notLoaded = valuesOf('subject').filter((v) => !loaded.includes(v));
      const lookingAt = question(
        'Looking at',
        valuesOf('subject').map((v) => {
          const c = facetChip('subject', v, v);
          if (!loaded.includes(v)) {
            c.classList.add('dim');
            c.title = `${c.title}. Not loaded: load a file (Sessions and project ↓)${v === 'workspace' ? '; the workspace needs two of sessions, code, and plans' : ''}.`;
          }
          return c;
        }),
        notLoaded.length ? `Dimmed: not loaded; load a file to draw ${notLoaded.join(', ')}.` : picks('subject').length > 1 ? 'The shelf puts them in the order picked.' : ''
      );
      const asking = question('Asking', valuesOf('category').map((v) => facetChip('category', v, CATEGORY_ASK[v] || v)));
      const qs = [lookingAt, asking];
      const prefs = typeof ctx.getReplayPrefs === 'function' ? ctx.getReplayPrefs() : {};
      if (!st.askBrief) {
        const purpose = picks('purpose');
        qs.push(
          question(
            'For',
            valuesOf('purpose').map((v) => facetChip('purpose', v, PURPOSE_ASK[v] || v)),
            purpose.includes('expressive') && !purpose.includes('informative') ? 'Impressing: the shelf leads with the hero views.' : purpose.length ? '' : 'Neither picked means both.'
          )
        );
        const any = chip('any', { on: !picks('language').length, key: 'ask:language:any', title: 'Every look', onClick: () => setFilters({ ...st.filters, language: [] }) });
        qs.push(question('Look', [any, ...valuesOf('language').map((v) => facetChip('language', v, v === 'standard' ? 'shared' : v))]));
        const sysReduced = typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        const setStills = (on) => {
          if (typeof ctx.setReplayPrefs === 'function') ctx.setReplayPrefs({ stills: on });
          renderPuck();
        };
        qs.push(
          question(
            'Motion',
            [
              chip('on', { on: !prefs.stills, key: 'ask:motion:on', title: 'Replays play when a view comes on stage', onClick: () => setStills(false) }),
              chip('stills', { on: !!prefs.stills, key: 'ask:motion:stills', title: 'Replays rest on their final frame, as with reduced motion; Play still plays', onClick: () => setStills(true) }),
            ],
            sysReduced ? 'Your system asks for reduced motion, so replays rest on their final frame either way.' : ''
          )
        );
        qs.push(
          question(
            'Tour pace',
            TOUR_PACES.map((n) =>
              chip(`${n}s`, {
                on: st.pace === n,
                key: `ask:pace:${n}`,
                title: `${n} seconds per view on the tour (hero views get their replay's length)`,
                onClick: () => {
                  st.pace = n;
                  save({ tourPace: n });
                  renderPuck();
                },
              })
            )
          )
        );
      }
      askQuestions.replaceChildren(...qs);
      askMore.hidden = !st.askBrief;
      askCount.textContent = st.catalog.length ? `${allowed().length} of ${slides.length} views remain` : '';
      askClear.hidden = Object.values(st.filters).every((v) => !v.length) && st.pace === DEFAULT_PACE && !prefs.stills;
    }

    // The Map: rows are subjects, columns categories; a view is a dot in every cell its tags name,
    // colored by its language, lit when the filters allow it, ringed when it's a hero, marked when on stage.
    const MAP_CAPTION = 'A dot per view in each cell its tags name, colored by look. Lit: the filters allow it. Ringed: a hero view. Marked: on stage. Empty cells: no view yet.';
    const langClass = (langs, v) => {
      const i = langs.indexOf(v);
      return `lang-${i <= 0 ? 0 : ((i - 1) % MAP_LANG_HUES) + 1}`;
    };
    function renderMap(entry) {
      const tax = st.taxonomy;
      if (!tax || !tax.subject || !tax.category || !st.catalog.length) {
        mapHost.replaceChildren(el('p', { class: 'muted small', text: 'Waiting for the catalog…' }));
        mapCaption.textContent = '';
        mapKey.replaceChildren();
        return;
      }
      const { svg, svgText } = ctx;
      const rows = Object.keys(tax.subject.values);
      const cols = Object.keys(tax.category.values);
      const langs = Object.keys(tax.language ? tax.language.values : {});
      const ok = new Set(st.order);
      const cells = rows.map((r) => cols.map((c) => st.catalog.filter((e) => (e.tags.subject || ['sessions']).includes(r) && (e.tags.category || []).includes(c))));
      // Dots per line in a cell, and each row's height from its fullest cell.
      const perLine = Math.max(1, Math.floor((MAP_CELL_W - 2 * MAP_PAD - 2 * MAP_DOT_R) / MAP_PITCH) + 1);
      const inset = (MAP_CELL_W - (perLine - 1) * MAP_PITCH - 2 * MAP_DOT_R) / 2; // the dots centered across a cell
      const rowH = cells.map((line) => Math.max(18, Math.ceil(Math.max(1, ...line.map((x) => x.length)) / perLine) * MAP_PITCH + 2 * MAP_PAD - (MAP_PITCH - 2 * MAP_DOT_R)));
      const W = MAP_LABEL_W + cols.length * MAP_CELL_W + MAP_RIGHT;
      const H = MAP_HEAD_H + rowH.reduce((a, h) => a + h + 2, 0);
      const root = svg('svg', { class: 'map-svg', viewBox: `0 0 ${W} ${H}`, role: 'group', 'aria-label': 'The views as a map: subjects by categories. Arrow keys move between views; Enter puts one on the stage.' });
      cols.forEach((c, j) => {
        const x = MAP_LABEL_W + j * MAP_CELL_W + MAP_CELL_W / 2 - 2;
        const t = svgText({ class: 'map-col', x, y: MAP_HEAD_H - 6, transform: `rotate(-45 ${x} ${MAP_HEAD_H - 6})` }, c);
        const tip = svg('title', {});
        tip.textContent = tax.category.values[c];
        t.append(tip);
        root.append(t);
      });
      const dots = []; // { g, entry, row, col }, in reading order
      let y = MAP_HEAD_H;
      rows.forEach((r, i) => {
        root.append(svgText({ class: 'map-row', x: MAP_LABEL_W - 6, y: y + 12.5 }, r));
        cols.forEach((c, j) => {
          const x0 = MAP_LABEL_W + j * MAP_CELL_W;
          const list = cells[i][j];
          root.append(svg('rect', { class: `map-cell${list.length ? '' : ' empty'}`, x: x0 + 1, y, width: MAP_CELL_W - 2, height: rowH[i], rx: 2 }));
          list.forEach((e, k) => {
            const cx = x0 + inset + MAP_DOT_R + (k % perLine) * MAP_PITCH;
            const cy = y + MAP_PAD + MAP_DOT_R + Math.floor(k / perLine) * MAP_PITCH;
            const lit = ok.has(e.id);
            const isCur = !!entry && e.id === entry.id;
            const g = svg('g', {
              class: `map-dot ${langClass(langs, (e.tags.language || [])[0])}${lit ? ' lit' : ''}${e.hero ? ' hero' : ''}${isCur ? ' current' : ''}`,
              role: 'button',
              tabindex: -1,
              'data-key': `map:${e.id}:${r}:${c}`,
              'aria-label': `${e.title}, ${r}, ${c}${e.hero ? ', hero view' : ''}${isCur ? ', on stage' : lit ? '' : ', filtered out'}`,
            });
            g.append(svg('circle', { class: 'map-hit', cx, cy, r: MAP_PITCH / 2 }), svg('circle', { class: 'map-fill', cx, cy, r: MAP_DOT_R }));
            if (e.hero) g.append(svg('circle', { class: 'map-hero-ring', cx, cy, r: MAP_DOT_R + 1.6 }));
            if (isCur) g.append(svg('circle', { class: 'map-current-ring', cx, cy, r: MAP_DOT_R + 3.4 }));
            dots.push({ g, entry: e, row: i, col: j });
            root.append(g);
          });
        });
        y += rowH[i] + 2;
      });
      // One tab stop: the stage's view's first dot (else the first); the arrow keys rove from there.
      const home = dots.find((d) => entry && d.entry.id === entry.id) || dots[0];
      if (home) home.g.setAttribute('tabindex', '0');
      const caption = (d) => {
        mapCaption.textContent = d ? `${d.entry.title}${d.entry.hero ? ' (hero)' : ''}: ${d.entry.why || d.entry.description}${ok.has(d.entry.id) ? '' : ' Filtered out: opening it drops the filters that hide it.'}` : MAP_CAPTION;
      };
      const moveTo = (d) => {
        if (!d) return;
        for (const x of dots) x.g.setAttribute('tabindex', x === d ? '0' : '-1');
        d.g.focus();
      };
      dots.forEach((d, n) => {
        d.g.addEventListener('click', () => openFromMap(d.entry));
        d.g.addEventListener('mouseenter', () => caption(d));
        d.g.addEventListener('mouseleave', () => caption(null));
        d.g.addEventListener('focus', () => caption(d));
        d.g.addEventListener('blur', () => caption(null));
        d.g.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openFromMap(d.entry);
            return;
          }
          let to = null;
          if (e.key === 'ArrowRight') to = dots[n + 1];
          else if (e.key === 'ArrowLeft') to = dots[n - 1];
          else if (e.key === 'Home') to = dots[0];
          else if (e.key === 'End') to = dots[dots.length - 1];
          else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            // The nearest column in the next row, down or up, that has any dot.
            const dir = e.key === 'ArrowDown' ? 1 : -1;
            for (let row = d.row + dir; row >= 0 && row < rows.length && !to; row += dir) {
              const there = dots.filter((x) => x.row === row);
              if (there.length) to = there.reduce((best, x) => (Math.abs(x.col - d.col) < Math.abs(best.col - d.col) ? x : best), there[0]);
            }
          } else return;
          e.preventDefault();
          moveTo(to);
        });
      });
      mapHost.replaceChildren(root);
      caption(null);
      mapKey.replaceChildren(...langs.map((v) => el('span', { class: 'map-key-item', title: tax.language.values[v] }, [el('i', { class: `map-swatch ${langClass(langs, v)}`, 'aria-hidden': 'true' }), v === 'standard' ? 'shared' : v])));
    }
    // A dot opens its view; one the filters hide first drops the filters that hide it (only those facets).
    function openFromMap(entry) {
      if (!st.order.includes(entry.id)) {
        const kept = {};
        for (const [facet, vals] of Object.entries(st.filters)) if (!vals.length || vals.some((v) => (entry.tags[facet] || []).includes(v))) kept[facet] = vals;
        st.currentId = entry.id; // so applyFilters keeps it rather than moving to a neighbor
        save({ current: entry.id });
        setFilters(kept);
      }
      goTo(entry.id);
    }

    // ---------- wiring ----------
    source.onSessions((list) => {
      st.list = list;
      renderPicker();
    });
    source.onExplorer((state) => {
      if (state) {
        const catalogChanged = state.catalog.map((e) => e.id).join() !== st.catalog.map((e) => e.id).join();
        st.taxonomy = state.taxonomy;
        st.catalog = state.catalog;
        st.sessions = state.sessions;
        st.notLoaded = state.notLoaded;
        if (catalogChanged) buildSlides();
      } else {
        st.sessions = [];
        st.notLoaded = [];
      }
      renderLoaded();
      layout();
    });
    if (typeof source.onWorkspace === 'function') {
      source.onWorkspace((workspace) => {
        st.workspace = workspace;
        renderProject();
        if (slides.length) layout(); // views drawing code or plans redraw; a subject that arrived or left changes their switches
      });
    }
    let resizeTimer;
    const onResize = () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fitStage();
        for (const s of slides) for (const p of s.parts) p.instance.resize();
        renderShelf();
      }, 150);
    };
    window.addEventListener('resize', onResize);
    // What's above the stage changes height too (the picker's list, the notes, the web demo's header).
    const pageObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(fitStage) : null;
    if (pageObserver) pageObserver.observe(document.body);

    renderPicker();
    renderLoaded();
    renderProject();
    renderPuck();
    renderShelf();

    let veil = null; // the loading screen over the stage, while the page reads data
    const tab = {
      /** The tab was just made visible: ask for what it hasn't got, and lay out at its real width. */
      shown() {
        tabVisible = true;
        source.listSessions();
        if (!st.picked) {
          const open = source.openSessionId();
          st.picked = open ? [open] : [];
          save({ picked: st.picked });
          renderPicker();
        }
        if (st.picked.length && !st.requested && !st.sessions.length) {
          st.requested = true;
          source.loadSessions(st.picked);
        }
        fitStage();
        renderProject();
        for (const s of slides) for (const p of s.parts) p.instance.resize();
        renderShelf();
        activate();
      },
      /** Covers the stage with the loading screen and this text while the page reads data; null takes it away. */
      loading(text) {
        if (!text) {
          if (veil) veil.remove();
          veil = null;
          stage.removeAttribute('aria-busy');
          return;
        }
        if (!veil) {
          veil = el('div', { class: 'stage-loading veil', role: 'status' }, [
            el('div', { class: 'stage-loading-bar', 'aria-hidden': 'true' }, [el('i')]),
            el('p', { class: 'stage-loading-text' }),
          ]);
        }
        veil.lastChild.textContent = text;
        stage.append(veil); // again after a rebuild emptied the stage
        stage.setAttribute('aria-busy', 'true');
      },
      /** The tab was hidden: stop every view. */
      hidden() {
        tabVisible = false;
        activate();
      },
      destroy() {
        stopReplayPrefs();
        window.removeEventListener('resize', onResize);
        if (pageObserver) pageObserver.disconnect();
        if (drag) stopDragging();
        for (const s of slides) destroyParts(s);
        root.replaceChildren();
        if (mounted === tab) mounted = null;
      },
    };
    mounted = tab;
    return tab;
  }

  window.factoryClockExplore = {
    mount,
    shown() {
      if (mounted) mounted.shown();
    },
    hidden() {
      if (mounted) mounted.hidden();
    },
  };
})();
