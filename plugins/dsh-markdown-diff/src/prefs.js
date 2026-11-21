/**
 * The preferences this plugin keeps in the browser.
 *
 * They live in `localStorage` rather than in the Host's settings document
 * because the preview is a display choice: it has to answer on the first paint,
 * before any round trip, and losing it costs the user one click. The store is a
 * `useSyncExternalStore` source, so the settings section and an open preview see
 * the same value without a context of their own.
 *
 * @module dsh-markdown-diff/prefs
 */

import { HOTKEY_DEFAULT, normalizeHotkey } from './hotkey.js';

/** The key the whole preference set is stored under. */
export const STORAGE_KEY = 'dsh-markdown-diff';

/**
 * Narrow the stored shortcut.
 *
 * An empty string is a real value — it means the reader turned the shortcut off.
 * Anything unreadable falls back to the default instead, because a stored
 * combination this build cannot parse would leave the surface with a shortcut that
 * never fires, and the reader would have no way to tell why.
 *
 * @param value - the untrusted stored value.
 * @returns the shortcut text.
 */
function readHotkey(value) {
  if (typeof value !== 'string') return DEFAULTS.commentHotkey;
  if (value.trim() === '') return '';
  const normalized = normalizeHotkey(value);
  return normalized === '' ? DEFAULTS.commentHotkey : normalized;
}

/** The view a preview opens in; `plain` is the builtin rendering with no marks. */
export const MODES = Object.freeze(['inline', 'side-by-side', 'plain']);

/**
 * The revision the working tree is compared with.
 *
 * `ref` is the third case: a branch the reader picked, whose name and commit
 * choice live in the two fields below. The list of bases is fixed, so the
 * preference can never name a branch that was not offered.
 */
export const BASES = Object.freeze(['head', 'index', 'ref']);

/** Which commit of a picked branch to compare with. */
export const POINTS = Object.freeze(['tip', 'merge-base']);

/**
 * Defaults: inline marks, uncommitted changes as the base, removals shown, and a
 * shortcut for the comment box that no DSH surface claims.
 */
export const DEFAULTS = Object.freeze({
  mode: 'inline',
  base: 'head',
  branch: '',
  point: 'tip',
  showRemoved: false,
  commentHotkey: HOTKEY_DEFAULT,
});

const listeners = new Set();

/** The last snapshot handed to `useSyncExternalStore`, kept stable between changes. */
let snapshot = null;

/**
 * Narrow one candidate preference set, field by field.
 * @param value - an untrusted candidate.
 * @returns the accepted set, with each rejected field replaced by its default.
 */
function normalize(value) {
  const candidate = value !== null && typeof value === 'object' ? value : {};
  const base = BASES.includes(candidate.base) ? candidate.base : DEFAULTS.base;
  const branch = typeof candidate.branch === 'string' ? candidate.branch : DEFAULTS.branch;
  return {
    mode: MODES.includes(candidate.mode) ? candidate.mode : DEFAULTS.mode,
    // A stored branch without a label would compare against nothing, so the two
    // are kept consistent here rather than guarded at every use site.
    base: base === 'ref' && branch === '' ? DEFAULTS.base : base,
    branch,
    point: POINTS.includes(candidate.point) ? candidate.point : DEFAULTS.point,
    showRemoved: typeof candidate.showRemoved === 'boolean' ? candidate.showRemoved : DEFAULTS.showRemoved,
    commentHotkey: readHotkey(candidate.commentHotkey),
  };
}

/**
 * Read the stored preferences.
 * @returns the preference set.
 */
function load() {
  let stored;
  try {
    stored = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    stored = null;
  }
  return normalize(stored);
}

/**
 * The current preferences.
 * @returns the same object until something changes.
 */
export function getPrefs() {
  if (snapshot === null) snapshot = load();
  return snapshot;
}

/**
 * Observe preference changes.
 * @param listener - called after every change, and after a change from another tab.
 * @returns the disposer.
 */
export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Merge a change into the stored preferences.
 * @param patch - the fields to replace.
 * @returns the new preference set.
 */
export function setPrefs(patch) {
  snapshot = normalize({ ...getPrefs(), ...patch });
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // A browser with storage disabled keeps the in-memory value only.
  }
  for (const listener of listeners) listener();
  return snapshot;
}

/** Drop the stored preferences, restoring the defaults. */
export function resetPrefs() {
  try {
    globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored, nothing to drop.
  }
  snapshot = null;
  for (const listener of listeners) listener();
}

/**
 * Read the preferences inside a component.
 * @param useSyncExternalStore - React's reader, passed in by the caller.
 * @returns the current preference set.
 */
export function usePrefs(useSyncExternalStore) {
  return useSyncExternalStore(subscribe, getPrefs, getPrefs);
}

// Another tab changing the same key is worth honouring, so a diff opened in one
// window and switched in another does not disagree with itself.
globalThis.addEventListener?.('storage', (event) => {
  if (event.key !== null && event.key !== STORAGE_KEY) return;
  snapshot = null;
  for (const listener of listeners) listener();
});
