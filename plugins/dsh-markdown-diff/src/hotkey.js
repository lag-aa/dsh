/**
 * The keyboard shortcut that opens the comment box.
 *
 * The combination lives in the preference store as text (`Ctrl+Alt+M`), because a
 * stored value has to survive a reload and stay readable in `localStorage` by hand.
 * Text is also what a settings field can show, while a `KeyboardEvent` is what the
 * preview receives, so this module is the one place that converts between the two:
 * the field parses what the reader pressed, the surface matches what it receives.
 *
 * Parsing is strict on purpose. A shortcut that silently becomes something else is
 * worse than no shortcut: the reader would learn a combination that never fires.
 * Everything not understood here comes back as `undefined`, and a bare key — no
 * Ctrl, Alt or Meta — is refused too, because it would fire while the reader is
 * simply reading the document.
 *
 * @module dsh-markdown-diff/hotkey
 */

/** The combination a fresh profile starts with. */
export const HOTKEY_DEFAULT = 'Ctrl+Enter';

/** Modifiers, their printed names, and every spelling accepted for them. */
const MODIFIERS = [
  ['ctrl', 'Ctrl', ['ctrl', 'control', 'strg']],
  ['alt', 'Alt', ['alt', 'option', 'opt']],
  ['shift', 'Shift', ['shift']],
  ['meta', 'Meta', ['meta', 'cmd', 'command', 'super', 'win']],
];

/** Named keys the reader may bind, by lower-case spelling. */
const NAMED = new Map([
  ['enter', 'Enter'],
  ['escape', 'Escape'],
  ['esc', 'Escape'],
  ['space', 'Space'],
  ['tab', 'Tab'],
  ['backspace', 'Backspace'],
  ['delete', 'Delete'],
  ['insert', 'Insert'],
  ['arrowup', 'ArrowUp'],
  ['up', 'ArrowUp'],
  ['arrowdown', 'ArrowDown'],
  ['down', 'ArrowDown'],
  ['arrowleft', 'ArrowLeft'],
  ['left', 'ArrowLeft'],
  ['arrowright', 'ArrowRight'],
  ['right', 'ArrowRight'],
  ['home', 'Home'],
  ['end', 'End'],
  ['pageup', 'PageUp'],
  ['pagedown', 'PageDown'],
  ...Array.from({ length: 12 }, (unused, index) => [`f${String(index + 1)}`, `F${String(index + 1)}`]),
]);

/** Keys that are modifiers themselves, and so never a shortcut on their own. */
const MODIFIER_KEYS = new Set(['control', 'alt', 'shift', 'meta', 'altgraph', 'capslock', 'dead']);

/**
 * Physical key codes, by the token they stand for.
 *
 * A shortcut binds the *position* of a key, not the character the layout prints
 * there: `Ctrl+M` recorded on the English layout has to fire on the Russian one,
 * where that same key prints `ь`. `KeyboardEvent.code` names the position and is
 * the same in every layout, so both conversions below read it first; `key` stays
 * as the fallback for a synthetic or exotic event that carries no code.
 */
const CODES = new Map([
  ['Space', 'Space'],
  ['Enter', 'Enter'],
  ['NumpadEnter', 'Enter'],
  ['Escape', 'Escape'],
  ['Tab', 'Tab'],
  ['Backspace', 'Backspace'],
  ['Delete', 'Delete'],
  ['Insert', 'Insert'],
  ['Home', 'Home'],
  ['End', 'End'],
  ['PageUp', 'PageUp'],
  ['PageDown', 'PageDown'],
  ['ArrowUp', 'ArrowUp'],
  ['ArrowDown', 'ArrowDown'],
  ['ArrowLeft', 'ArrowLeft'],
  ['ArrowRight', 'ArrowRight'],
  ['Backquote', '`'],
  ['Minus', '-'],
  ['Equal', '='],
  ['BracketLeft', '['],
  ['BracketRight', ']'],
  ['Backslash', '\\'],
  ['Semicolon', ';'],
  ['Quote', "'"],
  ['Comma', ','],
  ['Period', '.'],
  ['Slash', '/'],
  ...Array.from({ length: 12 }, (unused, index) => [`F${String(index + 1)}`, `F${String(index + 1)}`]),
]);

/**
 * Read one key token into its printed name.
 * @param token - a lower-case token from the shortcut text, or a `KeyboardEvent.key`.
 * @returns the printed key, or `undefined` when it cannot be a shortcut key.
 */
function keyOf(token) {
  const named = NAMED.get(token);
  if (named !== undefined) return named;
  // A letter or a digit is printed in upper case; punctuation stands as it is.
  if (/^[a-z]$/u.test(token)) return token.toUpperCase();
  if (/^[0-9]$/u.test(token)) return token;
  if (/^[^\w\s]$/u.test(token)) return token;
  return undefined;
}

/**
 * Read a physical key code into its printed name.
 * @param code - `KeyboardEvent.code`, e.g. `KeyM` or `Period`.
 * @returns the printed key, or `undefined` when the code names no bindable key.
 */
function keyOfCode(code) {
  const text = String(code ?? '');
  if (text === '') return undefined;
  const named = CODES.get(text);
  if (named !== undefined) return named;
  const letter = /^Key([A-Z])$/u.exec(text);
  if (letter !== null) return letter[1];
  const digit = /^(?:Digit|Numpad)([0-9])$/u.exec(text);
  if (digit !== null) return digit[1];
  return undefined;
}

/**
 * The printed key an event stands for, layout-independently.
 * @param event - a `keydown` event.
 * @returns the printed key, or `undefined` when the press binds no key.
 */
function printedKeyOf(event) {
  const byCode = keyOfCode(event?.code);
  if (byCode !== undefined) return byCode;
  return keyOf(String(event?.key ?? '').toLowerCase());
}

/**
 * Parse a shortcut written as text.
 * @param text - e.g. `Ctrl+Alt+M`; case and spacing do not matter.
 * @returns the combination, or `undefined` when the text is not a usable shortcut.
 */
export function parseHotkey(text) {
  const value = String(text ?? '').trim();
  if (value === '') return undefined;
  const tokens = value.split('+').map((token) => token.trim().toLowerCase()).filter((token) => token !== '');
  const raw = tokens.pop();
  if (raw === undefined) return undefined;
  const parsed = { ctrl: false, alt: false, shift: false, meta: false, key: '' };
  for (const token of tokens) {
    const found = MODIFIERS.find(([, , names]) => names.includes(token));
    if (found === undefined) return undefined;
    parsed[found[0]] = true;
  }
  const key = keyOf(raw);
  if (key === undefined) return undefined;
  parsed.key = key;
  // One real modifier at least: Shift alone still types a letter, and no modifier
  // at all would fire while the document is being read.
  if (parsed.ctrl === false && parsed.alt === false && parsed.meta === false) return undefined;
  return parsed;
}

/**
 * Write a combination back as text.
 * @param parsed - the combination.
 * @returns e.g. `Ctrl+Alt+M`, with the modifiers in a fixed order.
 */
export function formatHotkey(parsed) {
  if (parsed === undefined || parsed === null) return '';
  return [...MODIFIERS.filter(([name]) => parsed[name] === true).map(([, label]) => label), parsed.key].join('+');
}

/**
 * Normalise shortcut text for storage.
 * @param text - what the reader typed or pressed.
 * @returns the canonical text, or an empty string when it is not usable (which is
 *   how "no shortcut" is stored).
 */
export function normalizeHotkey(text) {
  return formatHotkey(parseHotkey(text));
}

/**
 * The text for a combination pressed right now.
 * @param event - a `keydown` event.
 * @returns the canonical text, an empty string when the press is not usable as a
 *   shortcut, or `undefined` when the press is only a modifier (nothing to record).
 */
export function hotkeyFromEvent(event) {
  const key = String(event?.key ?? '');
  if (key === '' || MODIFIER_KEYS.has(key.toLowerCase())) return undefined;
  const printed = printedKeyOf(event);
  if (printed === undefined) return '';
  const parsed = {
    ctrl: event.ctrlKey === true,
    alt: event.altKey === true,
    shift: event.shiftKey === true,
    meta: event.metaKey === true,
    key: printed,
  };
  if (parsed.ctrl === false && parsed.alt === false && parsed.meta === false) return '';
  return formatHotkey(parsed);
}

/**
 * Whether a `keydown` event is the shortcut.
 * @param event - a `keydown` event.
 * @param parsed - the combination to compare with.
 * @returns whether the event carries exactly that combination.
 */
export function hotkeyMatches(event, parsed) {
  if (parsed === undefined || parsed === null) return false;
  if (event === undefined || event === null) return false;
  if ((event.ctrlKey === true) !== parsed.ctrl) return false;
  if ((event.altKey === true) !== parsed.alt) return false;
  if ((event.shiftKey === true) !== parsed.shift) return false;
  if ((event.metaKey === true) !== parsed.meta) return false;
  const key = String(event.key ?? '');
  if (key === '' || MODIFIER_KEYS.has(key.toLowerCase())) return false;
  return printedKeyOf(event) === parsed.key;
}
