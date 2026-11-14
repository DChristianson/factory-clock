/**
 * A view's address (bqx.46): the page's URL with #<view id> opens that view on
 * the stage. Only a catalog id goes in the hash, never a selection, a session,
 * or anything loaded (PRIVACY.md). DOM-free, so Node tests use it; the page
 * (./page) reads and writes location.hash with these.
 */

/** The view id a location.hash names ('#atlas' -> 'atlas'), or null for an empty or unreadable one. Whether it's a known view is the explorer's call. */
export function viewIdFromHash(hash: string): string | null {
  let id = hash.startsWith('#') ? hash.slice(1) : hash;
  try {
    id = decodeURIComponent(id);
  } catch {
    return null;
  }
  id = id.trim();
  return id ? id : null;
}

/** The hash for a view id ('atlas' -> '#atlas'). Catalog ids are lowercase letters, digits, and hyphens, so this is '#' + id for every one of them. */
export function hashForViewId(id: string): string {
  return '#' + encodeURIComponent(id);
}
