/**
 * The settings section for the Markdown diff plugin.
 *
 * A settings row is a plain component: the shell projects `{ id, order, label }`
 * out of whatever a plugin registers and mounts the component underneath. There
 * is no form schema to describe, so the section reads the same preference store
 * the preview writes and offers the same three choices the toolbar does — plus a
 * reset, because a preference that changes the default rendering is worth having
 * a way back from.
 *
 * No descriptive paragraph and no registration status: the nav row already says
 * what the section is, and every field carries its own hint. The bookkeeping in
 * `diagnostics.js` still runs, it is just not on the screen.
 *
 * @module dsh-markdown-diff/settings
 */

import { BASES, MODES, POINTS, getPrefs, resetPrefs, setPrefs, subscribe } from './prefs.js';
import { HOTKEY_DEFAULT, hotkeyFromEvent } from './hotkey.js';
import { currentLabels } from './labels.js';

const CSS_TAG = 'dsh-markdown-diff/settings.css';

const css = [
  '.dsmd-set{display:flex;flex-direction:column;gap:16px;max-width:640px;padding:4px 0 8px;color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.5}',
  '.dsmd-setTitle{margin:0;font-size:15px;font-weight:600}',
  '.dsmd-setField{display:flex;flex-direction:column;gap:6px}',
  '.dsmd-setLabel{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500}',
  '.dsmd-setHint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px}',
  '.dsmd-setRow{display:flex;flex-wrap:wrap;gap:6px}',
  '.dsmd-setChoice{padding:4px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}',
  '.dsmd-setChoice:hover:not([aria-pressed="true"]){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.dsmd-setChoice[aria-pressed="true"]{border-color:var(--dsw-alias-state-business-primary,var(--dsw-alias-border-l1));background:color-mix(in srgb, var(--dsw-alias-state-business-primary, #4c8dff) 12%, transparent);color:var(--dsw-alias-label-primary);font-weight:500}',
  '.dsmd-setToggle{display:inline-flex;align-items:center;gap:8px;cursor:pointer}',
  '.dsmd-setToggle input{margin:0}',
  '.dsmd-setReset{align-self:flex-start;padding:3px 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}',
  '.dsmd-setReset:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.dsmd-setSelect{max-width:320px;padding:3px 6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit}',
  // The shortcut is recorded, not typed: the field takes the next keydown and
  // writes what it was, so the reader never has to spell a combination this build
  // might parse differently.
  '.dsmd-setHotkey{min-width:200px;padding:3px 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-family:var(--dsw-font-mono, ui-monospace, monospace);text-align:center;cursor:pointer}',
  '.dsmd-setHotkey:focus{outline:1px solid var(--dsw-alias-state-business-primary, #4a8cf7);outline-offset:-1px}',
  '.dsmd-setChoice:disabled{opacity:.45;cursor:default}',
].join('');

/** Inject the section's stylesheet once per document. */
function injectStyles() {
  if (typeof document === 'undefined') return;
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG)}]`) !== null) return;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-markdown-diff';
  tag.dataset.pluginCss = CSS_TAG;
  tag.textContent = css;
  document.head.appendChild(tag);
}

/**
 * The settings section.
 * @returns the rendered section.
 */
export function MarkdownDiffSettings() {
  injectStyles();
  const labels = currentLabels();
  const copy = labels.settings;
  const prefs = React.useSyncExternalStore(subscribe, getPrefs, getPrefs);
  // Shown instead of the hint after a press that cannot be recorded, so a reader
  // who pressed Shift+M learns why nothing happened instead of pressing it again.
  const [hotkeyNote, setHotkeyNote] = React.useState('');
  const modeLabels = {
    inline: copy.modeInline,
    'side-by-side': copy.modeSideBySide,
    plain: copy.modePlain,
  };
  const baseLabels = { head: copy.baseHead, index: copy.baseIndex, ref: copy.baseBranch };
  const pointLabels = { tip: copy.pointTip, 'merge-base': copy.pointMergeBase };
  return React.createElement('section', { className: 'dsmd-set', 'data-markdown-diff-settings': 'true' },
    React.createElement('h2', { className: 'dsmd-setTitle' }, copy.title),
    React.createElement('div', { className: 'dsmd-setField' },
      React.createElement('span', { className: 'dsmd-setLabel' }, copy.mode),
      React.createElement('div', { className: 'dsmd-setRow', role: 'group', 'aria-label': copy.mode },
        MODES.map((mode) => React.createElement('button', {
          key: mode,
          type: 'button',
          className: 'dsmd-setChoice',
          'aria-pressed': prefs.mode === mode,
          onClick: () => {
            setPrefs({ mode });
          },
        }, modeLabels[mode])))),
    React.createElement('div', { className: 'dsmd-setField' },
      React.createElement('span', { className: 'dsmd-setLabel' }, copy.base),
      React.createElement('div', { className: 'dsmd-setRow', role: 'group', 'aria-label': copy.base },
        BASES.map((base) => React.createElement('button', {
          key: base,
          type: 'button',
          className: 'dsmd-setChoice',
          'aria-pressed': prefs.base === base,
          onClick: () => {
            setPrefs({ base });
          },
        }, baseLabels[base])))),
    React.createElement('div', { className: 'dsmd-setField' },
      React.createElement('span', { className: 'dsmd-setLabel' }, copy.point),
      React.createElement('div', { className: 'dsmd-setRow', role: 'group', 'aria-label': copy.point },
        POINTS.map((point) => React.createElement('button', {
          key: point,
          type: 'button',
          className: 'dsmd-setChoice',
          'aria-pressed': prefs.point === point,
          onClick: () => {
            setPrefs({ point });
          },
        }, pointLabels[point]))),
      React.createElement('p', { className: 'dsmd-setHint' }, copy.branchHint)),
    React.createElement('div', { className: 'dsmd-setField' },
      React.createElement('label', { className: 'dsmd-setToggle' },
        React.createElement('input', {
          type: 'checkbox',
          checked: prefs.showRemoved,
          onChange: (event) => {
            setPrefs({ showRemoved: event.target.checked });
          },
        }),
        React.createElement('span', null, copy.showRemoved))),
    React.createElement('div', { className: 'dsmd-setField' },
      React.createElement('span', { className: 'dsmd-setLabel' }, copy.hotkey),
      React.createElement('div', { className: 'dsmd-setRow' },
        React.createElement('input', {
          className: 'dsmd-setHotkey',
          type: 'text',
          readOnly: true,
          value: prefs.commentHotkey,
          placeholder: copy.hotkeyEmpty,
          'aria-label': copy.hotkey,
          'data-markdown-diff-hotkey': 'true',
          onKeyDown: (event) => {
            // A bare Esc means "off": the field holds nothing to clear otherwise,
            // and a reader who wants no shortcut should not have to hunt a button.
            if (event.key === 'Escape' && event.ctrlKey !== true && event.altKey !== true && event.metaKey !== true) {
              event.preventDefault();
              setHotkeyNote('');
              setPrefs({ commentHotkey: '' });
              return;
            }
            const next = hotkeyFromEvent(event);
            // Only a modifier held on its own: the reader is still spelling the
            // combination, so nothing is decided and nothing is swallowed.
            if (next === undefined) return;
            event.preventDefault();
            if (next === '') {
              setHotkeyNote(copy.hotkeyNeed);
              return;
            }
            setHotkeyNote('');
            setPrefs({ commentHotkey: next });
          },
        }),
        React.createElement('button', {
          type: 'button',
          className: 'dsmd-setChoice',
          onClick: () => {
            setHotkeyNote('');
            setPrefs({ commentHotkey: HOTKEY_DEFAULT });
          },
        }, copy.hotkeyDefault),
        React.createElement('button', {
          type: 'button',
          className: 'dsmd-setChoice',
          disabled: prefs.commentHotkey === '',
          onClick: () => {
            setHotkeyNote('');
            setPrefs({ commentHotkey: '' });
          },
        }, copy.hotkeyOff)),
      React.createElement('p', { className: 'dsmd-setHint' }, hotkeyNote === '' ? copy.hotkeyHint : hotkeyNote)),
    React.createElement('p', { className: 'dsmd-setHint' }, copy.openHint),
    React.createElement('button', {
      type: 'button',
      className: 'dsmd-setReset',
      onClick: () => {
        resetPrefs();
      },
    }, copy.reset));
}
