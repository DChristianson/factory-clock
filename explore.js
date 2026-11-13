// The explorer: a stage with one view on it, a shelf of cards (one per view
// the filters allow) under it, pickers for sessions and the project, and a
// puck that names the view on stage and filters the shelf by its tags. See
// docs/workspace-explorer.md, "Stage and shelf". It sees only
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
// ctx: the helpers from vizkit.js plus tooltip, showTip(evt, rows), hideTip(). The tab adds
// select(selection) for each visualizer it mounts (see viz/registry.js).
//
// Saved state: { picked: string[], current: visualizer id, compare: visualizer id | null, filters: { facet: [values] }, replay: { speed, loop },
// collapsed: boolean, corner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right',
// selection: { sessionId?, turnId?, range?, focusId? } | null }.
(function () {
  // The most sessions the picker allows; matches EXPLORE_SESSION_CAP in src/catalog.ts.
  const CAP = 8;
  const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  // The stage never gets shorter than this; in a window too short for it, the page scrolls and the dock sticks to the window's bottom.
  const MIN_STAGE_HEIGHT = 320;
  // Below the dock: the body's bottom padding, and a little air.
  const BELOW_DOCK = 16;
  // A card's glyph per subject, and the order of a card's category dots (a dot's place says which category).
  const SUBJECT_GLYPH = { sessions: '◷', code: '⌗', plans: '☰', workspace: '◫' };
  const CATEGORY_ORDER = ['temporal', 'actor', 'conversational', 'dependency', 'quantitative', 'state', 'semantic'];
  const DRAG_THRESHOLD = 4; // px of movement before a press on the puck's head counts as a drag
  let mounted = null;

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
    const st = {
      picked: Array.isArray(saved.picked) ? saved.picked.slice(0, CAP) : null, // null until the first show pre-checks the open session
      currentId: typeof saved.current === 'string' ? saved.current : null,
      compareId: typeof saved.compare === 'string' ? saved.compare : null, // the view pinned on the stage's left while comparing
      workspace: null, // the Workspace for every subject's picks, when the source serves one
      filters: saved.filters && typeof saved.filters === 'object' ? saved.filters : {},
      collapsed: saved.collapsed !== false, // starts collapsed
      corner: CORNERS.includes(saved.corner) ? saved.corner : 'bottom-right',
      selection: saved.selection && typeof saved.selection === 'object' ? saved.selection : null,
      list: null, // { sessions, headlines }
      taxonomy: null,
      catalog: [],
      sessions: [], // SessionView[] loaded, in picked order
      notLoaded: [],
      requested: false, // whether this page already asked for the picked sessions
    };
    const save = (partial) => source.setState(partial);
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
    const navNote = el('span', { class: 'muted small', 'aria-live': 'polite' });
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
    const puckDesc = el('p', { class: 'muted small puck-desc' });
    // The work the view draws on (entry.credits), one name per credit, linked when it has a url.
    const puckAfter = el('p', { class: 'muted small puck-after', hidden: true });
    const facets = el('div');
    const filterNote = el('span', { class: 'muted small' });
    const clearBtn = el('button', { class: 'link', text: 'Clear' });
    clearBtn.addEventListener('click', () => {
      st.filters = {};
      save({ filters: st.filters });
      applyFilters();
    });
    const mismatchNote = el('p', { class: 'muted small', hidden: true });
    const puckBody = el('div', { class: 'puck-body' }, [puckDesc, puckAfter, facets, el('div', { class: 'puck-foot' }, [filterNote, el('span', { class: 'spacer' }), clearBtn]), mismatchNote]);
    const puckHead = el('div', { class: 'puck-head' }, [puckTitle, puckPos, collapseBtn]);
    const puck = el('aside', { class: 'puck', 'aria-label': 'Current visualizer and tag filters' }, [puckHead, puckBody]);
    function renderCollapsed() {
      puck.classList.toggle('collapsed', st.collapsed);
      const label = st.collapsed ? 'Expand' : 'Collapse';
      collapseBtn.textContent = label;
      collapseBtn.title = `${label}. Drag, or press an arrow key, to move the puck to another corner.`;
      collapseBtn.setAttribute('aria-expanded', String(!st.collapsed));
    }
    renderCollapsed();

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
      el('div', { class: 'below-carousel' }, [el('p', { class: 'muted small', text: 'Experimental: every view draws the same loaded data its own way. The puck names the one on stage and filters the shelf by its tags.' }), picker, projectHost]),
      puck
    );

    // ---------- stage height ----------
    // The stage takes the height left in the window, so the dock under it stays
    // in view and a drawing taller than that scrolls inside its slide. The
    // height doesn't follow the view, so the dock stays put between views.
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
    // workspace it last sent has them. No view draws them yet (that comes with
    // the Shape views), so this only picks.
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
          ? [el('div', { class: 'controls' }, [el('span', { class: 'muted small', text: 'Project: code and plans' })]), ...groups, el('p', { class: 'muted small', text: 'Views that draw code and plans arrive next; the picks are kept for them.' })]
          : [])
      );
    }

    // ---------- stage and shelf ----------
    // [{ entry, slide, host, card, allowed, parts: [{ host, instance, sessionIds }] }] in catalog order
    const slides = [];

    function matches(entry) {
      return Object.entries(st.filters).every(([facet, vals]) => !vals.length || vals.some((v) => (entry.tags[facet] || []).includes(v)));
    }
    const allowed = () => slides.filter((s) => s.allowed);
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
        const slide = el('article', { class: 'slide', 'aria-label': entry.title, hidden: true }, [
          el('div', { class: 'slide-head' }, [el('span', { class: 'muted small', text: `${i + 1}/${st.catalog.length}` }), el('strong', { text: entry.title }), el('span', { class: 'muted small', text: entry.description })]),
          host,
        ]);
        const c = card(entry);
        slides.push({ entry, slide, host, card: c, allowed: true, parts: [] });
        stage.append(slide);
        shelf.append(c);
      });
      if (!current()) st.currentId = st.catalog.length ? st.catalog[0].id : null;
      applyFilters();
    }

    function applyFilters() {
      for (const s of slides) {
        s.allowed = matches(s.entry);
        s.card.hidden = !s.allowed;
      }
      const vis = allowed();
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
      // Keep the current card in view, scrolling only the shelf.
      const cur = current();
      if (cur && cur.allowed && shelf.offsetParent) {
        const left = cur.card.offsetLeft - shelf.offsetLeft;
        const right = left + cur.card.offsetWidth;
        if (left < shelf.scrollLeft) shelf.scrollLeft = left - 8;
        else if (right > shelf.scrollLeft + shelf.clientWidth) shelf.scrollLeft = right - shelf.clientWidth + 8;
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
    function updateSlide(s) {
      const sessions = st.sessions;
      if (!sessions.length) {
        destroyParts(s);
        s.host.replaceChildren(el('p', { class: 'muted', text: 'No sessions loaded. Pick sessions below (Sessions and project ↓) and press Load.' }));
        return;
      }
      const def = viz.get(s.entry.id);
      if (!def) {
        destroyParts(s);
        s.host.replaceChildren(el('p', { class: 'muted', text: `No renderer is registered for “${s.entry.id}”.` }));
        return;
      }
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
    function renderPuck() {
      const cur = current();
      const entry = cur && cur.allowed ? cur.entry : null;
      puckTitle.textContent = entry ? entry.title : st.catalog.length ? 'Nothing matches' : 'Explore';
      puckPos.textContent = entry ? `${slides.indexOf(cur) + 1}/${slides.length}` : '';
      puckDesc.textContent = entry ? entry.description : st.catalog.length ? 'Clear a filter to see visualizers again.' : 'Waiting for the catalog…';
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
                const chip = el('button', {
                  class: `tag${has ? ' has' : ''}${on ? ' on' : ''}`,
                  text: v,
                  'aria-pressed': String(on),
                  title: `${meaning}${on ? ' (filtering)' : has ? ` (${entry.title} is tagged; click to filter)` : ' (click to filter)'}`,
                });
                chip.addEventListener('click', () => {
                  const f = st.filters[facet] || [];
                  st.filters = { ...st.filters, [facet]: on ? f.filter((x) => x !== v) : [...f, v] };
                  save({ filters: st.filters });
                  applyFilters();
                });
                return chip;
              })
            ),
          ])
        )
      );
      const n = Object.values(st.filters).reduce((a, v) => a + v.length, 0);
      filterNote.textContent = n ? `${n} filter${n > 1 ? 's' : ''}: OR within a facet, AND across` : 'No filters. Outlined chips are this visualizer’s tags.';
      clearBtn.hidden = n === 0;
      // Catalog and registry out of step: say so here rather than drawing nothing silently.
      const registered = new Set(viz.ids());
      const unregistered = st.catalog.filter((e) => !registered.has(e.id)).map((e) => e.id);
      const uncataloged = viz.ids().filter((id) => !st.catalog.some((e) => e.id === id));
      const problems = [...(unregistered.length ? [`no renderer registered for ${unregistered.join(', ')}`] : []), ...(uncataloged.length ? [`registered but not in the catalog: ${uncataloged.join(', ')}`] : [])];
      mismatchNote.hidden = problems.length === 0;
      mismatchNote.textContent = problems.length ? `Catalog mismatch: ${problems.join('; ')}.` : '';
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
