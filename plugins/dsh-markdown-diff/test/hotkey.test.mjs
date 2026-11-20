/**
 * Shortcut checks: the text a reader stores, the key they press, and the event the
 * surface receives all describe one combination, and these checks pin that the
 * conversion between the three loses nothing.
 *
 * Two failures are worth a check of their own. A shortcut that silently becomes
 * something else teaches the reader a combination that never fires, and a shortcut
 * without a real modifier fires while the document is merely being read.
 *
 *   node test/hotkey.test.mjs
 */

import assert from 'node:assert/strict';

import {
  HOTKEY_DEFAULT,
  formatHotkey,
  hotkeyFromEvent,
  hotkeyMatches,
  normalizeHotkey,
  parseHotkey,
} from '../src/hotkey.js';
import { DEFAULTS, STORAGE_KEY, getPrefs, setPrefs } from '../src/prefs.js';

let passed = 0;
let failed = 0;

/**
 * Run one named check.
 * @param name - what the check proves.
 * @param body - the assertions.
 */
function test(name, body) {
  try {
    body();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${error.message.split('\n')[0]}`);
  }
}

/**
 * A `keydown` event, as the field and the surface would see it.
 * @param key - the key name, e.g. `m` or `Enter`.
 * @param overrides - the modifier flags, and `code`, to set.
 * @returns the event.
 */
function keydown(key, overrides = {}) {
  return { key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...overrides };
}

test('the default combination is readable text and comes back unchanged', () => {
  assert.equal(HOTKEY_DEFAULT, 'Ctrl+Enter');
  assert.equal(normalizeHotkey(HOTKEY_DEFAULT), HOTKEY_DEFAULT);
  assert.equal(DEFAULTS.commentHotkey, HOTKEY_DEFAULT);
  assert.equal(typeof STORAGE_KEY, 'string');
});

test('case, spacing and spelled-out modifiers do not matter', () => {
  assert.equal(normalizeHotkey(' ctrl + alt + m '), 'Ctrl+Alt+M');
  assert.equal(normalizeHotkey('CONTROL+OPTION+M'), 'Ctrl+Alt+M');
  assert.equal(normalizeHotkey('meta+shift+k'), 'Shift+Meta+K');
  // The printed order is fixed, so one combination has one spelling.
  assert.equal(normalizeHotkey('Shift+Ctrl+K'), 'Ctrl+Shift+K');
});

test('a combination without a real modifier is refused', () => {
  // Shift alone still types a letter, and no modifier at all would fire while the
  // document is being read.
  assert.equal(normalizeHotkey(''), '');
  assert.equal(normalizeHotkey('M'), '');
  assert.equal(normalizeHotkey('Shift+M'), '');
  assert.equal(normalizeHotkey('Shift+Alt'), '');
});

test('a key this build does not know is refused instead of guessed', () => {
  assert.equal(normalizeHotkey('Ctrl+Alt+NoSuchKey'), '');
  assert.equal(normalizeHotkey('Hyper+M'), '');
});

test('named keys and punctuation are recordable', () => {
  assert.equal(normalizeHotkey('Ctrl+Enter'), 'Ctrl+Enter');
  assert.equal(normalizeHotkey('Alt+F5'), 'Alt+F5');
  assert.equal(normalizeHotkey('Ctrl+.'), 'Ctrl+.');
  assert.equal(normalizeHotkey('Ctrl+ArrowDown'), 'Ctrl+ArrowDown');
});

test('the same combination matches its event and nothing else', () => {
  const parsed = parseHotkey('Ctrl+Alt+M');
  assert.equal(hotkeyMatches(keydown('m', { ctrlKey: true, altKey: true }), parsed), true);
  // The same key without both modifiers is a different combination.
  assert.equal(hotkeyMatches(keydown('m', { ctrlKey: true }), parsed), false);
  assert.equal(hotkeyMatches(keydown('m', { altKey: true }), parsed), false);
  // An extra modifier means the reader pressed something else entirely.
  assert.equal(hotkeyMatches(keydown('m', { ctrlKey: true, altKey: true, shiftKey: true }), parsed), false);
  // A plain letter must never look like a shortcut.
  assert.equal(hotkeyMatches(keydown('m'), parsed), false);
});

test('a modifier pressed on its own is never the shortcut', () => {
  const parsed = parseHotkey('Ctrl+Alt+M');
  assert.equal(hotkeyMatches(keydown('Control', { ctrlKey: true }), parsed), false);
  assert.equal(hotkeyMatches(keydown('Alt', { ctrlKey: true, altKey: true }), parsed), false);
});

test('what the reader presses round-trips through the stored text', () => {
  const pressed = hotkeyFromEvent(keydown('k', { ctrlKey: true, shiftKey: true }));
  assert.equal(pressed, 'Ctrl+Shift+K');
  const parsed = parseHotkey(pressed);
  assert.equal(hotkeyMatches(keydown('k', { ctrlKey: true, shiftKey: true }), parsed), true);
  // The stored text is also what the settings field shows and what round-trips.
  assert.equal(normalizeHotkey(pressed), pressed);
  assert.equal(formatHotkey(parsed), pressed);
});

test('a shortcut follows the key position, not the character the layout prints', () => {
  // Recorded on the English layout: `key` is the letter, `code` says where it sits.
  const stored = hotkeyFromEvent(keydown('m', { code: 'KeyM', ctrlKey: true }));
  assert.equal(stored, 'Ctrl+M');
  // On the Russian layout that same physical key prints `ь`. The press has to stay
  // the shortcut, or the combination would stop working the moment the reader
  // switches layout — `code` is the same in every layout, `key` is not.
  const parsed = parseHotkey(stored);
  assert.equal(hotkeyMatches(keydown('ь', { code: 'KeyM', ctrlKey: true }), parsed), true);
  // Recording on the Russian layout writes the position as well, so the field can
  // never show a Cyrillic letter that the stored text could not parse back.
  assert.equal(hotkeyFromEvent(keydown('ь', { code: 'KeyM', ctrlKey: true })), 'Ctrl+M');
  // A different position is a different combination, whatever it prints there.
  assert.equal(hotkeyMatches(keydown('м', { code: 'KeyV', ctrlKey: true }), parsed), false);
  // Named keys carry their position in `code` too, and the numpad Enter is the
  // same key as the main one: the default has to fire from either.
  assert.equal(hotkeyMatches(keydown('Enter', { code: 'NumpadEnter', ctrlKey: true }), parseHotkey('Ctrl+Enter')), true);
});

test('a press that cannot be a shortcut is reported, not silently recorded', () => {
  // A modifier alone means the reader is still spelling the combination.
  assert.equal(hotkeyFromEvent(keydown('Control', { ctrlKey: true })), undefined);
  assert.equal(hotkeyFromEvent(keydown('Shift', { shiftKey: true })), undefined);
  // A bare key is a press with an answer: nothing to record.
  assert.equal(hotkeyFromEvent(keydown('k')), '');
});

test('a stored shortcut this build cannot parse falls back to the default', () => {
  // The value is normalised on read, so something written by another build — or by
  // hand — can never reach the surface as a combination that silently never fires.
  // The empty string is the exception: it is how "no shortcut" is stored.
  const store = new Map([[STORAGE_KEY, JSON.stringify({ commentHotkey: 'Ctrl+Alt+NoSuchKey' })]]);
  globalThis.localStorage = {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
    removeItem: (key) => store.delete(key),
  };
  assert.equal(getPrefs().commentHotkey, HOTKEY_DEFAULT);
  assert.equal(setPrefs({ commentHotkey: 'ctrl+shift+k' }).commentHotkey, 'Ctrl+Shift+K');
  assert.equal(setPrefs({ commentHotkey: '' }).commentHotkey, '', 'an empty value means "no shortcut"');
  assert.equal(JSON.parse(store.get(STORAGE_KEY)).commentHotkey, '', 'and it is stored that way');
});

console.log(`\n${String(passed)}/${String(passed + failed)} shortcut checks passed`);
process.exitCode = failed === 0 ? 0 : 1;
