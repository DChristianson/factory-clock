import { CATALOG, TAXONOMY, validateCatalog } from './index';
import { EventSet, parseJsonl, syntheticEvents, syntheticSessionIds } from './web';
import { startPage } from './web/page';

/**
 * The web page's bundle entry (built by scripts/site.js into
 * site/factory-clock.js). Loaded last by hosts/web/index.html, after
 * vizkit.js, the visualizers, and explore.js, which the page mounts. The page
 * shows no findings yet: they will come from a file Snagboat exports. The
 * model is also put on window.factoryClockWeb for the console; the page itself
 * doesn't read it from there.
 */
(window as unknown as { factoryClockWeb: unknown }).factoryClockWeb = { EventSet, parseJsonl, syntheticEvents, syntheticSessionIds, CATALOG, TAXONOMY, validateCatalog };

startPage();
