/**
 * The Markdown preview with git changes highlighted.
 *
 * This replaces the builtin Markdown body rather than sitting beside it: the
 * registry ranks an `extension` implementation above a `builtin` one, so once
 * this registration is live the sidebar opens `.md` here. Falling back to the
 * builtin rendering is therefore this component's own job, and it does that in
 * four places — no repository, no changes, an incomplete document, and plain mode.
 *
 * The working-tree text is the one the preview already loaded; only the base is
 * fetched. Comparing happens in the browser, so saving the file re-runs the diff
 * against the same base without another round trip.
 *
 * `React` and `primitives` are the platform modules the bundle's banner requires
 * from the client module table, which keeps one React and one Markdown renderer
 * on the page.
 *
 * @module dsh-markdown-diff/MarkdownDiffBody
 */

import { readBase, readRefs } from './api.js';
import { commentMessage, SELECTION_LIMIT } from './comments.js';
import { diffDocuments } from './diff.js';
import { appendToDraft } from './draft.js';
import { applyInlineHighlight } from './highlight.js';
import { parseHotkey, hotkeyMatches } from './hotkey.js';
import { parseProperties, shapeOf } from './frontmatter.js';
import { currentLabels } from './labels.js';
import { BASES, getPrefs, setPrefs, subscribe } from './prefs.js';
import { readSelection } from './selection.js';
import { noteRender } from './diagnostics.js';

/** The address grammar the sidebar uses for session files. */
const FILE_ADDRESS_PREFIX = 'dsh-resource://file/session/';

const CSS_TAG = 'dsh-markdown-diff/MarkdownDiffBody.css';

/**
 * The stylesheet, written against the shell's own tokens so both themes need no
 * separate rules. The two tints are mixed from the status colours rather than
 * from fixed hex values, so a retheme carries them along.
 *
 * The root deliberately does not scroll. The preview owns the scrollport — it is
 * the element with `data-textpreview-body` — and it reads that element's scroll
 * position to page the next chunk of the file in, so an `overflow` here would
 * stop long documents from ever finishing loading. The root only resets what the
 * scrollport imposes on its children: monospace, `white-space: pre`, and the code
 * font size.
 */
const css = [
  '.dsmd-root{position:relative;box-sizing:border-box;min-width:100%;font-family:var(--dsw-font,inherit);font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.6;white-space:normal;color:var(--dsw-alias-label-primary)}',
  // The file tab hands a viewer a flex column that does not scroll, so the
  // viewer root has to fill it and own the scrollbar. Only this surface scrolls:
  // the document preview's root must stay non-scrolling so its paging keeps
  // working off the scrollport it controls itself.
  '.dsmd-root--viewer{flex:1;min-height:0;height:100%;overflow:auto}',
  '.dsmd-bar{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:0;padding:6px 12px;border-bottom:.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-document-preview,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.4}',
  '.dsmd-group{display:inline-flex;align-items:center;gap:2px;padding:1px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1)}',
  '.dsmd-tab{padding:2px 8px;border:none;border-radius:calc(var(--dsw-radius-sm) - 1px);background:0 0;color:inherit;font:inherit;cursor:pointer;white-space:nowrap}',
  '.dsmd-tab:hover:not([aria-pressed="true"]){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.dsmd-tab[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-3,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary);font-weight:500}',
  '.dsmd-sep{flex:none;width:.5px;height:16px;background:var(--dsw-alias-border-l2)}',
  '.dsmd-pick{display:inline-flex;align-items:center;gap:2px;padding:1px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1)}',
  '.dsmd-select{max-width:150px;padding:2px 4px;border:none;border-radius:calc(var(--dsw-radius-sm) - 1px);background:0 0;color:inherit;font:inherit;cursor:pointer}',
  '.dsmd-select:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary,var(--dsw-alias-border-l1));outline-offset:-1px}',
  '.dsmd-tab:disabled{opacity:.45;cursor:default}',
  '.dsmd-mark{margin-left:auto;flex:none;display:inline-flex;align-items:center;gap:8px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}',
  '.dsmd-add{color:var(--dsw-alias-state-success-primary)}',
  '.dsmd-del{color:var(--dsw-alias-state-error-primary)}',
  '.dsmd-tool{display:inline-flex;align-items:center;justify-content:center;flex:none;min-width:22px;height:20px;padding:0 4px;border:none;border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;line-height:1;cursor:pointer}',
  '.dsmd-tool svg{width:13px;height:13px}',
  '.dsmd-tool:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
  '.dsmd-tool:disabled{opacity:.5;cursor:default}',
  '.dsmd-doc{min-width:0;padding:10px 12px;white-space:normal;font-family:var(--dsw-font,inherit)}',
  '.dsmd-block{position:relative;border-radius:var(--dsw-radius-sm)}',
  '.dsmd-block + .dsmd-block{margin-top:2px}',
  // A wholly new block is itself the change, so it carries the same wash as the
  // inserted words inside a modified block (26%): the two markings then read as
  // one colour. A modified block keeps the lighter 14% frame, because there the
  // colour belongs to the changed words, not to the block.
  '.dsmd-block[data-kind="added"]{background:color-mix(in srgb, var(--dsw-alias-state-success-secondary, #2ea043) 26%, transparent);box-shadow:inset 2px 0 0 var(--dsw-alias-state-success-primary, #2ea043)}',
  '.dsmd-block[data-kind="modified"]{background:color-mix(in srgb, var(--dsw-alias-state-success-secondary, #2ea043) 14%, transparent);box-shadow:inset 2px 0 0 var(--dsw-alias-state-success-primary, #2ea043)}',
  '.dsmd-block[data-kind="removed"]{background:color-mix(in srgb, var(--dsw-alias-state-error-secondary, #f85149) 12%, transparent);box-shadow:inset 2px 0 0 var(--dsw-alias-state-error-primary, #f85149)}',
  '.dsmd-block[data-kind="removed"] .dsmd-content{text-decoration:line-through;text-decoration-color:color-mix(in srgb, var(--dsw-alias-state-error-primary, #f85149) 60%, transparent);opacity:.75}',
  '.dsmd-block[data-kind="modified"] .dsmd-before{padding-bottom:6px;margin-bottom:6px;border-bottom:1px dashed var(--dsw-alias-border-l2);opacity:.7}',
  '.dsmd-block[data-kind="modified"] .dsmd-before .dsmd-content{text-decoration:line-through;text-decoration-color:color-mix(in srgb, var(--dsw-alias-state-error-primary, #f85149) 50%, transparent)}',
  // Narrowed marking, used only where ranges can actually be painted. The block
  // keeps a frame and a very light wash so it stays findable in a long document,
  // while the changed words carry the colour: a whole paragraph no longer turns
  // green because one word in it moved. Both sides of a pair also stop being
  // struck or dimmed as a whole — otherwise the narrow marking would sit inside a
  // paragraph that already reads as entirely removed.
  '.dsmd-root[data-dsmd-narrow="true"] .dsmd-block[data-kind="modified"]{background:color-mix(in srgb, var(--dsw-alias-state-success-secondary, #2ea043) 5%, transparent)}',
  // Side by side, the base column is the removed side and the file column the
  // added one; each keeps its own colour, only lighter.
  '.dsmd-root[data-dsmd-narrow="true"] .dsmd-block[data-kind="removed"][data-dsmd-paired="true"]{background:color-mix(in srgb, var(--dsw-alias-state-error-secondary, #f85149) 5%, transparent)}',
  '.dsmd-root[data-dsmd-narrow="true"] .dsmd-block[data-kind="added"][data-dsmd-paired="true"]{background:color-mix(in srgb, var(--dsw-alias-state-success-secondary, #2ea043) 5%, transparent)}',
  '.dsmd-root[data-dsmd-narrow="true"] .dsmd-block[data-dsmd-paired="true"] .dsmd-content,.dsmd-root[data-dsmd-narrow="true"] .dsmd-block[data-dsmd-paired="true"] .dsmd-before{text-decoration:none;opacity:1}',
  // With removals hidden the old half of a modified block is taken out of the
  // flow rather than out of the tree: the inline highlighter still needs its text
  // to tell a changed word from an inserted one, and `textContent` survives
  // `display:none`. The element costs no space and paints no ink, but the
  // comparison it feeds still sees the old wording.
  '.dsmd-before[data-dsmd-hidden="true"]{display:none}',
  // Inline marking through the CSS Custom Highlight API: the renderer's own DOM is
  // painted from the outside instead of being split into marked-up text nodes,
  // which would leave React reconciling a tree it no longer owns.
  '::highlight(dsh-markdown-diff-ins){background:color-mix(in srgb, var(--dsw-alias-state-success-secondary, #2ea043) 26%, transparent);text-decoration:underline;text-decoration-color:var(--dsw-alias-state-success-primary, #2ea043);text-underline-offset:2px}',
  '::highlight(dsh-markdown-diff-del){background:color-mix(in srgb, var(--dsw-alias-state-error-secondary, #f85149) 22%, transparent);text-decoration:line-through;text-decoration-color:var(--dsw-alias-state-error-primary, #f85149)}',
  '.dsmd-gutter{position:absolute;top:2px;left:2px;color:var(--dsw-alias-label-tertiary);font-family:var(--dsw-font-mono, ui-monospace, monospace);font-size:10px;line-height:1;user-select:none;pointer-events:none}',
  // The line an address named is marked briefly so the reader sees where they
  // arrived; the outline fades rather than lingering over the diff's own tints.
  '.dsmd-block[data-dsmd-landed="true"]{outline:1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary, #4a8cf7) 55%, transparent);outline-offset:2px;border-radius:var(--dsw-radius-sm);animation:dsmd-land 2.4s ease-out forwards}',
  '@keyframes dsmd-land{0%,55%{outline-color:color-mix(in srgb, var(--dsw-alias-state-business-primary, #4a8cf7) 55%, transparent)}100%{outline-color:transparent}}',
  '.dsmd-block[data-kind="added"] .dsmd-gutter{color:var(--dsw-alias-state-success-primary)}',
  '.dsmd-block[data-kind="removed"] .dsmd-gutter{color:var(--dsw-alias-state-error-primary)}',
  '.dsmd-marked{padding-left:10px}',
  '.dsmd-frontmatter{margin:0 0 16px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:var(--dsw-font-markdown-small);white-space:pre-wrap;overflow-wrap:anywhere}',
  // The properties sheet. It has to read as metadata rather than as body text, so
  // it is quieter than the document: a small type, hairline rules, no paragraph
  // margin. The grid puts every value on a shared left edge, which is the whole
  // reason to prefer it over the YAML it came from.
  '.dsmd-props{margin:0 0 16px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:var(--dsw-font-markdown-small);overflow:hidden}',
  '.dsmd-propsHead{display:flex;align-items:center;gap:6px;width:100%;margin:0;padding:7px 10px;border:0;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;letter-spacing:.02em;text-align:left;cursor:pointer}',
  '.dsmd-propsHead:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsmd-propsHead:focus-visible{outline:1px solid var(--dsw-alias-state-business-primary);outline-offset:-1px}',
  '.dsmd-chevron{flex:none;transition:transform .15s ease}',
  '.dsmd-chevron--open{transform:rotate(90deg)}',
  '.dsmd-propsTitle{font-weight:600;text-transform:uppercase}',
  '.dsmd-propsCount{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:10px}',
  // Folding clips the body; it never removes it. The collapsed half of a modified
  // group must keep the same text content as the expanded one, because the inline
  // highlighter compares those two halves to find the changed words.
  '.dsmd-props[data-dsmd-collapsed="true"] .dsmd-propsBody{display:none}',
  '.dsmd-props[data-dsmd-collapsed="true"]{margin-bottom:16px}',
  '.dsmd-propsBody{display:grid;grid-template-columns:minmax(88px,max-content) 1fr;gap:2px 12px;padding:2px 10px 9px;border-top:.5px solid var(--dsw-alias-border-l3)}',
  '.dsmd-propRow{display:contents}',
  '.dsmd-propKey{padding:3px 0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5;overflow-wrap:anywhere}',
  '.dsmd-propKey--inline{padding:0;margin-right:6px;font-size:10px}',
  '.dsmd-propValue{min-width:0;padding:3px 0;line-height:1.5;overflow-wrap:anywhere}',
  '.dsmd-prop-url{font-family:var(--dsw-font-mono, ui-monospace, monospace);font-size:11px;word-break:break-all}',
  '.dsmd-prop-date,.dsmd-prop-number{font-variant-numeric:tabular-nums}',
  '.dsmd-prop-flag{color:var(--dsw-alias-label-secondary)}',
  '.dsmd-propEmpty{color:var(--dsw-alias-label-disabled, var(--dsw-alias-label-tertiary))}',
  '.dsmd-propChips{display:flex;flex-wrap:wrap;gap:4px;padding:3px 0}',
  '.dsmd-propChip{padding:0 6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;background:var(--dsw-alias-bg-layer-2, transparent);font-size:10.5px;line-height:1.7;overflow-wrap:anywhere}',
  '.dsmd-propStack{display:flex;flex-direction:column;gap:2px;min-width:0;padding:3px 0}',
  '.dsmd-propItem{padding:0 0 2px;border-bottom:.5px dotted var(--dsw-alias-border-l3)}',
  '.dsmd-propItem:last-child{border-bottom:0}',
  '.dsmd-propPair{display:block;min-width:0;overflow-wrap:anywhere}',
  '.dsmd-note{margin:0;padding:8px 12px 4px;color:var(--dsw-alias-label-tertiary);font-size:12px;white-space:normal}',
  '.dsmd-note button{margin-left:6px;padding:1px 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:0 0;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}',
  '.dsmd-note button:hover{background:var(--dsw-alias-interactive-bg-hover)}',
  '.dsmd-split{display:grid;grid-template-columns:1fr 1fr;align-items:start;gap:0;padding:0 12px 10px;white-space:normal}',
  '.dsmd-col{min-width:0;padding:10px 8px;white-space:normal;font-family:var(--dsw-font,inherit)}',
  '.dsmd-col + .dsmd-col{border-left:.5px solid var(--dsw-alias-border-l3)}',
  '.dsmd-colHead{margin:-10px -8px 8px;padding:4px 8px;color:var(--dsw-alias-label-tertiary);font-size:11px;letter-spacing:.02em}',
  // Review comments. The button floats inside the root rather than in a portal:
  // the root is the positioning box, and a portal would need `ReactDOM`, which the
  // client module table does not hand a plugin. `left`/`top` come from the
  // selection's own geometry, so the button lands beside the text being read.
  '.dsmd-commentBtn{position:absolute;z-index:3;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-base));color:var(--dsw-alias-label-secondary);cursor:pointer;box-shadow:0 1px 2px rgba(0,0,0,.18)}',
  '.dsmd-commentBtn:hover{background:var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary)}',
  '.dsmd-commentBtn svg{width:16px;height:16px}',
  '.dsmd-comment{margin:4px 0 8px;padding:8px 10px;border:.5px solid var(--dsw-alias-border-l2);border-left:2px solid var(--dsw-alias-state-business-primary, #4a8cf7);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1, transparent);white-space:normal;font-size:12px;line-height:1.5}',
  '.dsmd-commentHead{display:flex;align-items:baseline;gap:8px;margin-bottom:4px;color:var(--dsw-alias-label-tertiary);font-size:11px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}',
  // The remark's marker stays at the right edge, so it cannot be read as the tail
  // of the address when the path is long.
  '.dsmd-commentHead>:last-child{margin-left:auto;white-space:nowrap}',
  '.dsmd-commentQuote{margin:0 0 6px;max-height:88px;overflow:auto;padding:2px 0 2px 8px;border-left:2px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-mono, ui-monospace, monospace);font-size:11px;line-height:1.5;white-space:pre-wrap;overflow-wrap:anywhere}',
  '.dsmd-commentLong{margin:0 0 6px;padding:2px 0 2px 8px;border-left:2px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5;font-style:italic}',
  '.dsmd-commentInput{width:100%;min-height:52px;max-height:200px;resize:vertical;box-sizing:border-box;padding:5px 7px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base, transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:1.5}',
  '.dsmd-commentInput:focus{outline:1px solid var(--dsw-alias-state-business-primary, #4a8cf7);outline-offset:-1px}',
  '.dsmd-commentFoot{display:flex;align-items:center;gap:6px;margin-top:6px}',
  '.dsmd-commentSend{padding:2px 10px;border:none;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-state-business-primary, #4a8cf7);color:#fff;font:inherit;font-size:11.5px;line-height:1.6;cursor:pointer}',
  '.dsmd-commentSend:disabled{opacity:.5;cursor:default}',
  '.dsmd-commentCancel{padding:2px 8px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:0 0;color:inherit;font:inherit;font-size:11.5px;line-height:1.6;cursor:pointer}',
  '.dsmd-commentCancel:hover{background:var(--dsw-alias-interactive-bg-hover, transparent)}',
  '.dsmd-commentHint{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:10.5px}',
  '.dsmd-commentError{margin:6px 0 0;color:var(--dsw-alias-state-error-primary, #f85149);font-size:11px}',
  '.dsmd-commentMark{position:absolute;top:2px;right:2px;display:inline-flex;color:var(--dsw-alias-state-business-primary, #4a8cf7);opacity:.85;pointer-events:none}',
  '.dsmd-commentMark svg{width:13px;height:13px}',
].join('');

/**
 * Install the stylesheet, keeping its contents current.
 *
 * A plugin can be reloaded without the page being reloaded, and this module is
 * re-evaluated while the old `<style>` element is still in the document. Creating
 * the element only when it is missing would therefore pin the first version of
 * the rules for the life of the page: newly added selectors would never apply,
 * making a control that sets an attribute look broken while it works. Rewriting
 * the contents on every call is cheap and makes the sheet match whichever build
 * is running.
 */
function injectStyles() {
  if (typeof document === 'undefined') return;
  const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG)}]`);
  if (existing !== null) {
    if (existing.textContent !== css) existing.textContent = css;
    return;
  }
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-markdown-diff';
  tag.dataset.pluginCss = CSS_TAG;
  tag.textContent = css;
  document.head.appendChild(tag);
}

/**
 * Split a session file address into the parts the route wants.
 * @param address - a `dsh-resource://file/session/<id>/<path>` address.
 * @returns the Session id and the workspace-relative path, or `undefined`.
 */
export function parseAddress(address) {
  if (typeof address !== 'string' || !address.startsWith(FILE_ADDRESS_PREFIX)) return undefined;
  // A query or fragment suffix is not part of the path, and the Host route would
  // reject it as one more path segment.
  const end = address.search(/[?#]/u);
  const rest = address.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end);
  const cut = rest.indexOf('/');
  if (cut <= 0 || cut === rest.length - 1) return undefined;
  try {
    return {
      sessionId: decodeURIComponent(rest.slice(0, cut)),
      path: rest.slice(cut + 1).split('/').map(decodeURIComponent).join('/'),
    };
  } catch {
    return undefined;
  }
}

/**
 * Resolve one Markdown image destination beside the previewed file.
 *
 * A copy of the builtin body's resolver rather than an import, because the
 * preview package keeps it private: the plugin must not depend on a shipped
 * package's internals, only on the module table.
 *
 * @param base - document base URI, including any deployment prefix.
 * @param documentPath - absolute path of the previewed file, when the Host reported it.
 * @param destination - the authored destination.
 * @returns the file URL, or `undefined` for a destination that cannot be served.
 */
export function resolveImage(base, documentPath, destination) {
  const suffix = destination.search(/[?#]/u);
  let path;
  try {
    path = decodeURIComponent(suffix === -1 ? destination : destination.slice(0, suffix));
  } catch {
    return undefined;
  }
  if (path === '') return undefined;
  if (!/^[a-z]:[/\\]/iu.test(path) && /^[a-z][a-z\d+.-]*:/iu.test(path)) return undefined;
  if (!/^(?:\/|[a-z]:[/\\]|\\\\)/iu.test(path)) {
    if (documentPath === undefined) return undefined;
    const trimmed = documentPath.replace(/[/\\]+$/, '');
    const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1;
    path = trimmed.slice(0, cut) + path;
  }
  if (!/^https?:/u.test(base) && !base.startsWith('dsh-app://app/')) return undefined;
  if (!/^(?:\/|[a-z]:[/\\])/iu.test(path)) return undefined;
  return new URL(`api/file?path=${encodeURIComponent(path)}`, base).href;
}

/** A row of mutually exclusive choices. */
function Segmented({ label, options, value, onPick }) {
  return React.createElement('span', { className: 'dsmd-group', role: 'group', 'aria-label': label },
    options.map((option) => React.createElement('button', {
      key: option.id,
      type: 'button',
      className: 'dsmd-tab',
      'aria-pressed': value === option.id,
      title: option.title,
      // A disabled choice stays visible: hiding it would make the toolbar change
      // shape depending on the repository, and a reader who cannot see "Ветка"
      // has no way to learn that branch comparison exists.
      disabled: option.disabled === true,
      onClick: () => {
        if (option.disabled === true) return;
        onPick(option.id);
      },
    }, option.label)));
}

/** A circular arrow for the recompute control. */
function ReloadIcon() {
  return React.createElement('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
    React.createElement('path', {
      d: 'M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3',
      stroke: 'currentColor',
      strokeWidth: 1.3,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    }));
}

/** A minus-in-a-box, struck through when removals are hidden. */
function RemovedIcon({ shown }) {
  return React.createElement('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
    React.createElement('rect', { x: 2.5, y: 3.5, width: 11, height: 9, rx: 1.5, stroke: 'currentColor', strokeWidth: 1.2 }),
    React.createElement('path', { d: 'M5.5 8h5', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round' }),
    shown
      ? null
      : React.createElement('path', { d: 'M3.5 12.5 12.5 3.5', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }));
}

/**
 * The comparison-base controls: the two fixed bases, and a branch picker.
 *
 * The picker is a native select rather than a custom popup: it keeps the keyboard
 * behaviour and the screen-reader announcement the shell's own controls have, and
 * a branch list is exactly what a select is for. It appears only once `ref` is
 * chosen, so the toolbar stays two groups wide in the ordinary case.
 *
 * @param props - the preferences, and the ref list when it has arrived.
 * @returns the base controls.
 */
function BaseControls({ prefs, refs }) {
  const labels = currentLabels();
  // The list is absent until the Host answers, and a preview drawn on the first
  // paint has not heard back yet; an empty list is the same state as a failure.
  const list = refs?.ok === true ? refs.refs : [];
  const options = [
    { id: 'head', label: labels.toolbar.baseHead, title: labels.toolbar.baseHeadHint },
    { id: 'index', label: labels.toolbar.baseIndex, title: labels.toolbar.baseIndexHint },
    { id: 'ref', label: labels.toolbar.baseBranch, title: labels.toolbar.branchHint, disabled: list.length === 0 },
  ];
  return React.createElement(React.Fragment, null,
    React.createElement(Segmented, {
      label: labels.toolbar.baseHint,
      value: prefs.base,
      // Picking a branch only switches the base: the name is kept in step with the
      // list by the surface itself, which also rescues a stored name that this
      // repository does not have.
      onPick: (base) => {
        setPrefs({ base });
      },
      options,
    }),
    prefs.base === 'ref' && list.length > 0
      ? React.createElement('span', { className: 'dsmd-pick' },
        React.createElement('select', {
          className: 'dsmd-select',
          'aria-label': labels.toolbar.branchHint,
          title: labels.toolbar.branchHint,
          value: prefs.branch,
          onChange: (event) => {
            setPrefs({ branch: event.target.value });
          },
        },
        list.map((entry) => React.createElement('option', {
          key: entry.name,
          value: entry.name,
        }, `${entry.name}${entry.current ? ' ·' : ''}`))),
        React.createElement('button', {
          type: 'button',
          className: 'dsmd-tool',
          title: prefs.point === 'merge-base' ? labels.toolbar.branchPointHint : labels.toolbar.branchTipHint,
          'aria-label': prefs.point === 'merge-base' ? labels.toolbar.branchPoint : labels.toolbar.branchTip,
          'aria-pressed': prefs.point === 'merge-base',
          onClick: () => {
            setPrefs({ point: prefs.point === 'merge-base' ? 'tip' : 'merge-base' });
          },
        }, React.createElement(BranchPointIcon, { point: prefs.point })))
      : null);
}

/** A fork: the branch tip, or the fork itself when the divergence point is chosen. */
function BranchPointIcon({ point }) {
  return React.createElement('svg', { viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
    React.createElement('path', { d: 'M5 3v10', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
    React.createElement('path', { d: 'M5 8h3.5a2.5 2.5 0 0 0 2.5-2.5V3', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
    React.createElement('circle', { cx: 5, cy: 3, r: point === 'merge-base' ? 1.9 : 1.3, stroke: 'currentColor', strokeWidth: 1.2 }),
    React.createElement('circle', { cx: 11, cy: 3, r: 1.3, stroke: 'currentColor', strokeWidth: 1.2 }),
    React.createElement('circle', { cx: 5, cy: 13, r: 1.3, stroke: 'currentColor', strokeWidth: 1.2 }));
}

/**
 * The toolbar: view, comparison base, removals, recompute, and the counters.
 *
 * @param props - the preferences, the counters, the reload callback, and the ref list.
 * @returns the toolbar row.
 */
function Toolbar({ prefs, stats, onReload, busy, refs }) {
  const labels = currentLabels();
  return React.createElement('div', { className: 'dsmd-bar', 'data-markdown-diff-bar': 'true' },
    React.createElement(Segmented, {
      label: labels.toolbar.viewHint,
      value: prefs.mode,
      onPick: (mode) => {
        setPrefs({ mode });
      },
      options: [
        { id: 'inline', label: labels.toolbar.inline },
        { id: 'side-by-side', label: labels.toolbar.sideBySide },
        { id: 'plain', label: labels.toolbar.plain },
      ],
    }),
    React.createElement('span', { className: 'dsmd-sep' }),
    React.createElement(BaseControls, { prefs, refs }),
    React.createElement('button', {
      type: 'button',
      className: 'dsmd-tool',
      title: prefs.showRemoved ? labels.toolbar.hideRemovedHint : labels.toolbar.showRemovedHint,
      'aria-label': prefs.showRemoved ? labels.toolbar.hideRemoved : labels.toolbar.showRemoved,
      'aria-pressed': prefs.showRemoved,
      onClick: () => {
        setPrefs({ showRemoved: !prefs.showRemoved });
      },
    }, React.createElement(RemovedIcon, { shown: prefs.showRemoved })),
    React.createElement('button', {
      type: 'button',
      className: 'dsmd-tool',
      title: labels.toolbar.reload,
      'aria-label': labels.toolbar.reload,
      disabled: busy,
      onClick: onReload,
    }, React.createElement(ReloadIcon)),
    React.createElement('span', { className: 'dsmd-mark' },
      React.createElement('span', { className: 'dsmd-add' }, `+${String(stats.added)}`),
      stats.modified > 0 ? React.createElement('span', null, `~${String(stats.modified)}`) : null,
      React.createElement('span', { className: 'dsmd-del' }, `−${String(stats.removed)}`),
      React.createElement('span', null, labels.groups(stats.groups))));
}

/** The subscription that keeps the body in step with the settings section. */
function usePrefs() {
  return React.useSyncExternalStore(subscribe, getPrefs, getPrefs);
}

/**
 * The body registered under `sidebar.right.tab.document`.
 *
 * This is the shape the built-in document preview hands a renderer: the text
 * arrives already paged into `content`, together with the file address and the
 * resource hook. It exists so `.md` still opens here when the sidebar's own file
 * tab is unavailable and the host preview takes the address back.
 *
 * @param props - the loaded content, its address, and the resource hook.
 * @returns the preview, marked or plain.
 */
export function MarkdownDiffBody({ content, resourceAddress, useResource, ctx }) {
  const text = content !== null && typeof content === 'object' && content.kind === 'text' ? content.text : '';
  const eof = content !== null && typeof content === 'object' && content.eof === true;
  // `useResource` is a standard slot prop, but reading it must not be the thing
  // that costs the document its rendering: the path only feeds image resolution,
  // which is worth a broken picture rather than a blank preview.
  const absolutePath = typeof useResource === 'function'
    ? useResource(resourceAddress)?.value?.absolutePath
    : undefined;
  const target = React.useMemo(() => parseAddress(resourceAddress), [resourceAddress]);
  noteRender(`preview | ${String(resourceAddress)} | chars=${String(text.length)} | eof=${String(eof)} | target=${target === undefined ? 'unparsed' : 'ok'}`);
  // The resource hook already resolved the absolute file, so the workspace root
  // is that path minus the relative one. It is a hint for the Host's root chain,
  // which is what keeps the comparison alive when the Session id no longer
  // answers on the Host.
  const cwd = React.useMemo(() => rootOf(absolutePath, target?.path), [absolutePath, target]);
  return React.createElement(DiffSurface, { text, eof, target, absolutePath, surface: 'preview', cwd, ctx });
}

/**
 * The workspace root, derived from an absolute file and its relative path.
 * @param absolutePath - the resolved file path, when the caller knows it.
 * @param relative - the workspace-relative path of the same file.
 * @returns the directory above `relative`, or `undefined` when either is absent.
 */
function rootOf(absolutePath, relative) {
  if (typeof absolutePath !== 'string' || absolutePath === '') return undefined;
  if (typeof relative !== 'string' || relative === '') return undefined;
  const suffix = `/${relative.replace(/\\/g, '/')}`;
  const normalized = absolutePath.replace(/\\/g, '/');
  return normalized.endsWith(suffix) ? normalized.slice(0, normalized.length - suffix.length) : undefined;
}
/**
 * The viewer registered with the sidebar's file-tab service.
 *
 * The file tab loads the bytes itself and hands a viewer the decoded string, the
 * workspace-relative path, and the scope it read them in — no address, no paging.
 * A file above the tab's read limit arrives without `content` and flagged as
 * large, which is the one case where there is no document to draw.
 *
 * @param props - the decoded text, the path, the scope, and the large-file flag.
 * @returns the preview, marked or plain.
 */
export function MarkdownDiffViewer(props) {
  const path = typeof props?.path === 'string' ? props.path : '';
  const cwd = typeof props?.scope?.cwd === 'string' ? props.scope.cwd : undefined;
  const sessionId = props?.scope?.sessionId;
  const text = typeof props?.content === 'string' ? props.content : '';
  const target = React.useMemo(() => (
    typeof sessionId === 'string' && path !== '' ? { sessionId, path } : undefined
  ), [sessionId, path]);
  const absolutePath = React.useMemo(() => joinPath(cwd, path), [cwd, path]);
  const largeFile = props?.largeFile === true || (typeof props?.content !== 'string' && path !== '');
  // The sidebar's own Markdown viewer is the editor this tab used to open. It is
  // reachable through the service's public viewer list, so the tab can hand the
  // document back to it for editing instead of losing that ability to the
  // intercept. A file above the tab's limit was never editable either.
  const editor = React.useMemo(() => shippedMarkdownViewer(props?.ctx), [props?.ctx]);
  const canEdit = editor !== undefined && largeFile === false;
  const [editing, setEditing] = React.useState(false);
  const leaveEditor = React.useCallback(() => { setEditing(false); }, []);
  // Editing stops being possible when the file stops being loadable: the viewer
  // remounts for every path switch, but a reload that grows the file past the
  // limit keeps this instance alive.
  React.useEffect(() => {
    if (canEdit === false) setEditing(false);
  }, [canEdit]);
  noteRender(`viewer | ${path} | chars=${String(text.length)} | large=${String(largeFile)} | target=${target === undefined ? 'unparsed' : 'ok'} | editor=${canEdit ? 'yes' : 'no'}`);
  // Every hook of this component has to run before the first branch below: the
  // editor handoff and the plain mode return from different paths, and a hook
  // that sits between them changes the hook order when the reader switches —
  // React then throws #300 (more hooks than expected on the way out of edit).
  const prefs = usePrefs();
  if (editing === true && editor !== undefined) {
    return React.createElement(ShippedEditor, { descriptor: editor, hostProps: props, onLeave: leaveEditor });
  }
  // "Без подсветки" is the tab as the sidebar drew it before this plugin claimed
  // `.md`: the shipped preview, with its frontmatter hiding, its rendered HTML and
  // Mermaid, and the "add to conversation" popup for a selection. Only the diff
  // views belong to this plugin; the unmarked reading view does not, so it is
  // delegated whole rather than imitated.
  const shippedPlain = prefs.mode === 'plain' && canEdit
    ? { descriptor: editor, hostProps: props }
    : undefined;
  return React.createElement(DiffSurface, {
    text,
    eof: true,
    target,
    absolutePath,
    surface: 'viewer',
    cwd,
    ctx: props?.ctx,
    largeFile,
    anchorLine: props?.line,
    onLineConsumed: props?.onLineConsumed,
    onToolbarState: shippedPlain === undefined ? props?.onToolbarState : undefined,
    onToolbarControls: shippedPlain === undefined ? props?.onToolbarControls : undefined,
    onEdit: canEdit ? () => { setEditing(true); } : undefined,
    shipped: shippedPlain,
  });
}

/**
 * The sidebar's own Markdown viewer, looked up for the editor handoff.
 *
 * The service's `getFileViewers()` is public and returns every descriptor, so
 * the tab can render the shipped component itself — no private module import,
 * and no second copy of CodeMirror. The builtin's id is `markdown`; this
 * plugin's own viewer is `dsh-markdown-diff:markdown`, so the two never collide.
 *
 * @param ctx - the client context the viewer was rendered with.
 * @returns the shipped descriptor, or `undefined` when it is not available.
 */
function shippedMarkdownViewer(ctx) {
  let service;
  try {
    service = ctx?.get?.('betterSidebar');
  } catch {
    service = undefined;
  }
  if (service === undefined || service === null) return undefined;
  let list;
  try {
    list = service.getFileViewers?.();
  } catch {
    list = undefined;
  }
  if (Array.isArray(list) === false) return undefined;
  for (const descriptor of list) {
    if (descriptor?.id !== 'markdown') continue;
    if (typeof descriptor.component !== 'function') continue;
    // A viewer the reader switched off in the sidebar's settings must not come
    // back through this door.
    try {
      if (service.isViewerEnabled?.('markdown') === false) continue;
    } catch {
      // A service without the gate keeps the descriptor.
    }
    return descriptor;
  }
  return undefined;
}

/**
 * The shipped editor, rendered inside this tab.
 *
 * It is mounted in the host-toolbar mode, so the tab's own header draws the
 * mode toggle and the save button. Only `setMode` is intercepted: the editor's
 * "preview" means its own Markdown preview, while the reader asking for preview
 * here means going back to the diff. Everything else — the state report, the
 * save command, the dirty guard — is the editor's own, so the tab behaves
 * exactly as it did before this plugin claimed `.md`.
 *
 * @param props - the shipped descriptor, the viewer props to forward, and the way back.
 * @returns the editor.
 */
function ShippedEditor({ descriptor, hostProps, onLeave }) {
  const inner = React.useRef(null);
  const controls = React.useMemo(() => ({
    setMode: (mode) => {
      if (mode === 'preview') {
        onLeave();
        return;
      }
      inner.current?.setMode(mode);
    },
    save: () => {
      inner.current?.save();
    },
  }), [onLeave]);
  const onToolbarControls = React.useCallback((next) => {
    inner.current = next ?? null;
    // The shipped editor always mounts in its own preview mode (`useState
    // <ViewMode>('preview')` in TextEditor). The reader clicked "edit" to get
    // here, so the document has to open in the editor, not in a second preview
    // that looks like the diff they just left.
    if (next !== null && next !== undefined) next.setMode('edit');
    // Reporting the wrapper on mount and nothing on unmount is what the host
    // expects: a stale command set would outlive the editor it drives.
    hostProps?.onToolbarControls?.(next === null || next === undefined ? null : controls);
  }, [controls, hostProps]);
  return React.createElement(descriptor.component, {
    ...hostProps,
    viewerId: descriptor.id,
    toolbar: 'host',
    onToolbarControls,
  });
}

/**
 * The shipped viewer, drawing its own unmarked reading view.
 *
 * It is mounted in host-toolbar mode like the editor, so the tab's header keeps
 * working; the component reports its own state, so nothing here forks it. This is
 * the whole reason "Без подсветки" is delegated rather than imitated: the YAML
 * frontmatter stays hidden, HTML and Mermaid render, and selecting text offers
 * "add to conversation" — all of it inside the shipped component.
 *
 * @param props - the shipped descriptor and the viewer props to forward.
 * @returns the shipped reading view.
 */
function ShippedPlain({ descriptor, hostProps }) {
  return React.createElement(descriptor.component, { ...hostProps, viewerId: descriptor.id, toolbar: 'host' });
}

/**
 * The Markdown source a preview should render.
 *
 * A closed YAML frontmatter block at the top of the file is metadata, but the
 * shared renderer reads its `---` delimiters as a thematic break and a setext
 * heading. Only a block that opens on the first line and closes with its own
 * `---` line is dropped; an unclosed or non-leading delimiter is left alone so
 * ordinary Markdown is never truncated. Mirrors the sidebar's own preview
 * helper; the diff itself always sees the untouched source.
 *
 * @param source - the document as it is on disk.
 * @returns the source without a leading frontmatter block.
 */
function previewSource(source) {
  const firstLineEnd = source.indexOf('\n');
  if (firstLineEnd === -1) return source;
  const firstLineStart = source.charCodeAt(0) === 0xFEFF ? 1 : 0;
  const firstLine = source.slice(firstLineStart, firstLineEnd).replace(/\r$/u, '');
  if (firstLine !== '---') return source;
  let lineStart = firstLineEnd + 1;
  while (lineStart <= source.length) {
    const newline = source.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? source.length : newline;
    const line = source.slice(lineStart, lineEnd).replace(/\r$/u, '');
    if (line === '---') {
      if (newline === -1) return '';
      // The blank line that separated the block from the document would otherwise
      // arrive as a leading newline, which the renderer turns into empty space
      // above the first heading.
      return source.slice(newline + 1).replace(/^(?:\r?\n)+/u, '');
    }
    if (newline === -1) return source;
    lineStart = newline + 1;
  }
  return source;
}

/**
 * The group that holds a 1-based source line.
 *
 * Blocks keep the source lines they came from, which is what makes a file
 * reference like `docs/a.md#L131` land somewhere after the document has been
 * split and re-joined.
 *
 * @param groups - the diff groups, in document order.
 * @param line - the 1-based line the address named.
 * @returns the group's index, or `-1` when no group covers that line.
 */
export function anchorLineOf(groups, line) {
  if (Number.isInteger(line) === false || line < 1) return -1;
  for (const [index, group] of groups.entries()) {
    // Only the working tree has the line the address named: a removed group's
    // blocks carry the *base* file's numbering, and landing on one of them would
    // point the reader at text their file no longer contains.
    const blocks = group.after ?? [];
    for (const block of blocks) {
      if (block.start + 1 <= line && line <= block.end + 1) return index;
    }
  }
  return -1;
}

/**
 * Join a workspace directory and a relative path, without importing `node:path`
 * into a browser bundle.
 * @param cwd - the absolute workspace directory, when the scope reported one.
 * @param path - the workspace-relative path.
 * @returns the absolute path, or `undefined` when the directory is unknown.
 */
function joinPath(cwd, path) {
  if (typeof cwd !== 'string' || cwd === '' || path === '') return undefined;
  const cut = Math.max(cwd.lastIndexOf('/'), cwd.lastIndexOf('\\'));
  return cut === cwd.length - 1 ? cwd + path : `${cwd}/${path}`;
}

/**
 * The preview itself, shared by both registrations.
 *
 * @param props - the working-tree text, whether it is complete, where it lives,
 *   which surface is drawing it, the caller's workspace directory when known, and
 *   whether the file was too large to load.
 * @returns the preview, marked or plain.
 */
function DiffSurface({ text, eof, target, absolutePath, surface, cwd, ctx, largeFile = false, anchorLine, onLineConsumed, onToolbarState, onToolbarControls, onEdit, shipped }) {
  injectStyles();
  const labels = currentLabels();
  const prefs = usePrefs();
  const MarkdownText = primitives?.MarkdownText;
  const pathImages = React.useMemo(() => ({
    resolve: (value) => resolveImage(document.baseURI, absolutePath, value),
  }), [absolutePath]);

  const markdownLabels = React.useMemo(() => markdownLabelsOf(labels), [labels]);
  const [state, setState] = React.useState({ phase: 'loading' });
  // The branch list is fetched once per surface and only when a branch is
  // actually asked for, so the ordinary two-base preview makes one request.
  const [refs, setRefs] = React.useState({ ok: false, code: 'idle', refs: [], suggested: '', current: '' });
  const generation = React.useRef(0);
  const surfaceRef = React.useRef(null);
  // Frontmatter folds as one block per surface, not per half of a modified group:
  // the two halves are compared by their text content, so folding only the newer
  // one would make the highlighter compare a short text against a long one and
  // mis-mark every word after the header.
  const [frontmatterCollapsed, setFrontmatterCollapsed] = React.useState(false);
  const onToggleFrontmatter = React.useCallback(() => {
    setFrontmatterCollapsed((value) => value === false);
  }, []);

  // The diff is computed here, above every early return, because the comment
  // layer needs the groups: its listener is an effect, and an effect cannot wait
  // for a value produced after those returns without a new hook appearing on one
  // path only — React #300, the crash this tab already had once (see NOTES.md).
  const diff = React.useMemo(() => {
    const source = state.answer;
    if (source?.ok !== true || prefs.mode === 'plain' || eof === false) return undefined;
    return diffDocuments(source.base, text, { showRemoved: prefs.showRemoved });
  }, [state.answer, prefs.mode, prefs.showRemoved, text, eof]);

  // A comment is written about a selection, so the selection is the first half of
  // the interaction: while one exists inside a block, a button stands beside it and
  // opens the box. The box lives in this surface rather than inside one block,
  // because a group is the smallest thing the renderer can identify — a selection
  // can span several source blocks that are drawn as one element.
  const [anchor, setAnchor] = React.useState(null);
  const [comment, setComment] = React.useState(null);
  const [marks, setMarks] = React.useState([]);
  const canComment = typeof ctx?.get === 'function' && typeof target?.sessionId === 'string' && target.sessionId !== '';
  const filePath = target?.path ?? '';
  React.useEffect(() => {
    if (canComment === false) return undefined;
    if (typeof document === 'undefined' || typeof window === 'undefined') return undefined;
    const root = surfaceRef.current;
    if (root === null || root === undefined) return undefined;
    let timer = 0;
    const update = () => {
      timer = 0;
      // One box at a time: while it is open, a second selection would replace the
      // remark the reader is in the middle of typing.
      if (comment !== null) {
        setAnchor(null);
        return;
      }
      const next = readSelection(root, diff?.groups ?? [], filePath, labels.comment.oldVersion);
      setAnchor((current) => (sameAnchor(current, next) ? current : next ?? null));
    };
    // The event fires while the browser is still laying the range out, and a mouse
    // drag fires it many times a second; one timeout per burst is enough and stops
    // a re-render per character dragged over.
    const schedule = () => {
      if (timer !== 0) return;
      timer = window.setTimeout(update, 30);
    };
    document.addEventListener('selectionchange', schedule);
    return () => {
      document.removeEventListener('selectionchange', schedule);
      if (timer !== 0) window.clearTimeout(timer);
    };
  }, [canComment, diff, filePath, labels.comment.oldVersion, comment]);

  const openComment = React.useCallback(() => {
    if (anchor === null) return;
    setComment(anchor);
    setAnchor(null);
    // The highlight stays behind only while a range remains; clearing it lets the
    // block read normally again once the box is what the reader is looking at.
    if (typeof window !== 'undefined') window.getSelection?.()?.removeAllRanges();
  }, [anchor]);

  const cancelComment = React.useCallback(() => {
    setComment(null);
  }, []);

  // The keyboard is the other way into the same box: a reader who selected with
  // Shift+arrows never has to reach for the mouse. The combination is a
  // preference, so it is parsed once per change instead of once per key press.
  const hotkey = React.useMemo(() => parseHotkey(prefs.commentHotkey), [prefs.commentHotkey]);
  React.useEffect(() => {
    if (hotkey === undefined) return undefined;
    if (canComment === false) return undefined;
    if (typeof document === 'undefined') return undefined;
    const onKeyDown = (event) => {
      // With the box open there is nothing to open, and without a selection there
      // is nothing to comment on, so the combination stays out of the way.
      if (comment !== null || anchor === null) return;
      // A caret in a field — the remark itself, the composer — means the reader is
      // typing, not reading: the shortcut belongs to the document.
      const active = document.activeElement;
      if (active?.tagName === 'TEXTAREA' || active?.tagName === 'INPUT') return;
      // The composer is a contenteditable host rather than a textarea, and the
      // default combination is the one that sends a message there: opening a
      // comment box in the middle of writing would be worse than a missed press.
      if (active?.isContentEditable === true) return;
      if (event.defaultPrevented === true) return;
      if (hotkeyMatches(event, hotkey) === false) return;
      event.preventDefault();
      openComment();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [anchor, canComment, comment, hotkey, openComment]);

  const sendComment = React.useCallback((remark) => {
    if (comment === null) return { ok: false, reason: 'empty' };
    const outcome = appendToDraft(ctx, target?.sessionId, commentMessage({
      address: comment.address,
      quote: comment.quote,
      remark,
      remarkLabel: labels.comment.remark,
    }));
    if (outcome.ok !== true) return outcome;
    // The comment lives in the draft from here on; the marker only records that
    // this block has one. Markers are deliberately not persisted: a reload would
    // otherwise claim comments the draft may no longer hold.
    setMarks((list) => [
      ...list.filter((mark) => mark.groupIndex !== comment.groupIndex || mark.side !== comment.side),
      { groupIndex: comment.groupIndex, side: comment.side, text: String(remark) },
    ]);
    setComment(null);
    setAnchor(null);
    return { ok: true };
  }, [comment, ctx, target, labels.comment.remark]);

  // Narrow the marking to the changed words once the document is in the DOM.
  // This runs after every commit that could have replaced the rendered tree, and
  // its cleanup drops this surface's ranges so a hidden preview cannot keep
  // painting a document that is no longer on screen.
  React.useEffect(() => applyInlineHighlight(surfaceRef.current), [state, prefs, text, eof]);

  // Report this surface's toolbar state to the file tab's header. Without it the
  // header draws neither the mode toggle nor the refresh button, and a tab with
  // unsaved changes would close without asking — which is what claiming `.md`
  // cost before this. The diff is never dirty and never saves: `editable` stays
  // false, so the save button does not appear, while `modes` turns on the
  // preview/edit pair whose "edit" half is the way into the shipped editor.
  React.useEffect(() => {
    if (typeof onToolbarState !== 'function') return;
    onToolbarState({
      modes: typeof onEdit === 'function',
      mode: 'preview',
      dirty: false,
      editable: false,
      saveState: 'idle',
    });
  }, [onToolbarState, onEdit]);

  React.useEffect(() => {
    if (typeof onToolbarControls !== 'function') return;
    if (typeof onEdit === 'function') {
      onToolbarControls({
        setMode: (mode) => {
          if (mode === 'edit') onEdit();
        },
        save: () => {},
      });
    } else {
      onToolbarControls(null);
    }
    return () => {
      onToolbarControls(null);
    };
  }, [onToolbarControls, onEdit]);

  // The branch list is wanted as soon as the reader can reach the picker, which
  // is before they choose it: a select that opens empty and fills a moment later
  // is worse than one that is ready. It is skipped entirely when the address is
  // unusable, since the Host would refuse the same way the base call does.
  const wantsRefs = target !== undefined;
  React.useEffect(() => {
    if (!wantsRefs) return undefined;
    const controller = new AbortController();
    void readRefs(target.sessionId, controller.signal, cwd).then((answer) => {
      if (controller.signal.aborted) return;
      setRefs(answer.ok === true ? answer : { ok: false, code: answer.code, refs: [], suggested: '', current: '' });
    });
    return () => {
      controller.abort();
    };
  }, [wantsRefs, target, cwd]);

  // A branch name means something only inside the repository that has it, while the
  // preference is one value for the whole app: it outlives a switch to another
  // project, a worktree of another repository, and a reload weeks later. Asking for
  // a name the current repository has never heard of costs the reader the whole diff
  // and an error page, so the stored name is checked against the list as soon as the
  // list arrives and replaced by the same suggestion the picker would have made. An
  // empty name is the same case: `ref` with nothing picked would reach the Host as a
  // request that names no branch.
  React.useEffect(() => {
    if (refs.ok !== true || refs.refs.length === 0) return;
    const known = (name) => name !== '' && refs.refs.some((entry) => entry.name === name);
    if (known(prefs.branch)) return;
    setPrefs({ branch: known(refs.suggested) ? refs.suggested : refs.refs[0].name });
  }, [prefs.branch, refs]);

  const load = React.useCallback((signal) => {
    if (target === undefined) {
      setState({ phase: 'ready', answer: { ok: false, code: 'no-address', message: 'Not a session file address.' } });
      return Promise.resolve();
    }
    const mine = generation.current + 1;
    generation.current = mine;
    setState((previous) => ({ phase: previous.answer === undefined ? 'loading' : 'computing' }));
    // A branch base needs its name and its commit choice; the two fixed bases
    // ignore them, so they are passed only when they mean something.
    const picked = prefs.base === 'ref' ? { branch: prefs.branch, point: prefs.point } : undefined;
    return readBase(target.sessionId, target.path, prefs.base, signal, cwd, picked).then((answer) => {
      if (signal?.aborted === true || generation.current !== mine) return;
      setState({ phase: 'ready', answer });
    });
  }, [prefs.base, prefs.branch, prefs.point, target, cwd]);

  React.useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [load]);

  const onReload = React.useCallback(() => {
    void load(new AbortController().signal);
  }, [load]);

  /**
   * The unmarked rendering.
   *
   * The whole text goes to the renderer in one call, with the preview's own
   * streaming hint: a partially loaded file must keep growing in place rather than
   * be re-parsed block by block.
   *
   * @param delegate - draw the shipped viewer instead of this plugin's renderer.
   */
  const plainDocument = (delegate) => (shipped !== undefined && delegate === true
    ? React.createElement(ShippedPlain, shipped)
    : React.createElement('div', { className: 'dsmd-doc' },
      React.createElement(MarkdownText, {
        text: previewSource(text),
        streaming: !eof,
        labels: markdownLabels,
        pathImages,
      })));

  // Without the platform renderer there is no preview to draw; say so rather than
  // show an empty frame, since the builtin body would fail the same way.
  if (MarkdownText === undefined) {
    return React.createElement('div', { className: rootClass(surface), 'data-markdown-diff': 'true' },
      React.createElement('p', { className: 'dsmd-note' }, labels.unavailable('MarkdownText is unavailable.')));
  }

  const answer = state.answer;
  const busy = state.phase !== 'ready';
  const empty = { added: 0, removed: 0, modified: 0, groups: 0 };
  // What the base column is called: the two fixed bases already have a label, and
  // a branch names itself, including the commit of it that was used.
  const baseLabel = answer?.ok === true && typeof answer.baseRef === 'string'
    ? (prefs.base === 'ref' ? answer.baseRef : undefined)
    : undefined;

  // The file tab refuses to hand over the bytes of a file above its read limit.
  // The diff cannot be computed without the working-tree text, so say why the
  // frame is empty instead of drawing a document made of nothing.
  if (largeFile === true && text === '') {
    return React.createElement('div', { className: rootClass(surface), 'data-markdown-diff': 'true' },
      React.createElement('p', { className: 'dsmd-note' }, labels.tooLarge));
  }

  if (answer !== undefined && answer.ok !== true) {
    const line = answer.code === 'no-repo' || answer.code === 'outside-repo' ? labels.notRepository : labels.unavailable(answer.message);
    return React.createElement('div', { className: rootClass(surface), 'data-markdown-diff': 'true' },
      React.createElement('p', { className: 'dsmd-note' }, line,
        React.createElement('button', { type: 'button', onClick: onReload }, labels.retry)),
      plainDocument());
  }

  // A branch the file predates, or never had, is not "no changes": the whole
  // document is new against it, and saying so is the difference between a reader
  // trusting the marks and re-reading the file by hand.
  const absentNote = answer?.ok === true && answer.status === 'absent'
    ? React.createElement('p', { className: 'dsmd-note' }, labels.absentIn(answer.baseRef))
    : null;

  if (answer === undefined || prefs.mode === 'plain' || eof === false) {
    return React.createElement('div', { className: rootClass(surface), 'data-markdown-diff': 'true' },
      // The toolbar stays even when the shipped viewer draws the document: it is
      // the only way back to a diff, and the whole point of the mode is that the
      // reader can leave it.
      React.createElement(Toolbar, { prefs, stats: empty, onReload, busy, refs }),
      absentNote,
      answer !== undefined && prefs.mode !== 'plain' && eof === false
        ? React.createElement('p', { className: 'dsmd-note' }, labels.incomplete)
        : null,
      plainDocument(prefs.mode === 'plain'));
  }

  // Computed above the first return for the comment layer; the fallback is what
  // keeps a future branch that reaches this line from throwing, and never runs
  // while the guards above hold.
  const result = diff ?? diffDocuments(answer.base, text, { showRemoved: prefs.showRemoved });

  // A reference like `docs/a.md#L131` names a source line, and the diff knows
  // which block holds it. Scrolling there once on arrival is what the shipped
  // editor does; a preview that always started at the top would lose the reader
  // who came for that line.
  const anchorAt = anchorLineOf(result.groups, anchorLine);

  if (result.changed === false) {
    return React.createElement('div', { className: rootClass(surface), 'data-markdown-diff': 'true' },
      React.createElement(Toolbar, { prefs, stats: result.stats, onReload, busy, refs }),
      absentNote,
      React.createElement('p', { className: 'dsmd-note' }, labels.unchanged),
      plainDocument());
  }

  const view = prefs.mode === 'side-by-side'
    ? React.createElement(SideBySide, {
      result,
      MarkdownText,
      pathImages,
      markdownLabels,
      base: prefs.base,
      baseLabel,
      anchorAt,
      frontmatterLabels: labels.frontmatter,
      frontmatterCollapsed,
      onToggleFrontmatter,
      comment,
      marks,
      commentLabels: labels.comment,
      onSendComment: sendComment,
      onCancelComment: cancelComment,
    })
    : React.createElement(Inline, {
      result,
      MarkdownText,
      pathImages,
      markdownLabels,
      hideRemoved: prefs.showRemoved === false,
      anchorAt,
      frontmatterLabels: labels.frontmatter,
      frontmatterCollapsed,
      onToggleFrontmatter,
      comment,
      marks,
      commentLabels: labels.comment,
      onSendComment: sendComment,
      onCancelComment: cancelComment,
    });

  return React.createElement('div', { className: rootClass(surface), 'data-markdown-diff': 'true', ref: surfaceRef },
    React.createElement(Anchored, { anchorAt, surfaceRef, onLineConsumed }),
    React.createElement(Toolbar, { prefs, stats: result.stats, onReload, busy, refs }),
    absentNote,
    anchor === null
      ? null
      : React.createElement('button', {
        type: 'button',
        className: 'dsmd-commentBtn',
        style: { left: `${String(anchor.left)}px`, top: `${String(anchor.top)}px` },
        // The title names the shortcut, so the button is also where the reader
        // finds out that one exists.
        title: prefs.commentHotkey === '' ? labels.comment.add : `${labels.comment.add} · ${prefs.commentHotkey}`,
        'aria-label': labels.comment.add,
        // The press must not collapse the selection the comment is about, and
        // `mousedown` is what collapses it.
        onMouseDown: (event) => { event.preventDefault(); },
        onClick: openComment,
      }, React.createElement(CommentIcon, null)),
    view);
}

/**
 * Land the reader on the line the address named, once.
 *
 * The block is scrolled into view and marked for a moment so the reader sees
 * where they arrived; `onLineConsumed` then tells the host the line has been
 * spent, which stops it from being handed out again after a reload.
 *
 * @param props - the target group index, the surface root, and the host's receipt.
 * @returns nothing to draw.
 */
function Anchored({ anchorAt, surfaceRef, onLineConsumed }) {
  React.useEffect(() => {
    if (anchorAt === undefined || anchorAt < 0) return;
    const root = surfaceRef.current;
    if (root === null || root === undefined) return;
    // The view marks its target group with this attribute, so the effect does not
    // have to know which of the two layouts is drawing it.
    const target = root.querySelector(`[data-dsmd-anchor="${String(anchorAt)}"]`);
    if (target === null) return;
    if (typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'center' });
    }
    target.setAttribute('data-dsmd-landed', 'true');
    if (typeof onLineConsumed === 'function') onLineConsumed();
  }, [anchorAt, surfaceRef, onLineConsumed]);
  return null;
}

/**
 * The root class for a surface.
 *
 * The document preview owns its scrollport, so its root must not scroll. A file
 * tab hands the viewer a flex column with no scrolling of its own, so the viewer
 * root has to scroll and fill that column.
 *
 * @param surface - `preview` or `viewer`.
 * @returns the classes for the root element.
 */
function rootClass(surface) {
  return surface === 'viewer' ? 'dsmd-root dsmd-root--viewer' : 'dsmd-root';
}

/** Translate the interface labels into the platform renderer's shape. */
function markdownLabelsOf(labels) {
  return {
    code: {
      copyLabel: labels.markdown.copy,
      copiedLabel: labels.markdown.copied,
      toolbarLabels: {
        codeLabel: labels.markdown.codeLabel,
        wrapLabel: labels.markdown.wrap,
        unwrapLabel: labels.markdown.unwrap,
      },
    },
    footnotes: labels.markdown.footnotes,
  };
}

/** One rendered fragment of a document. */
function Fragment({ text, MarkdownText, pathImages, labels }) {
  if (text === '') return null;
  return React.createElement(MarkdownText, { text, streaming: false, labels, pathImages });
}

/**
 * One value inside a property row.
 *
 * The text is what the reader is after, so it is the only thing drawn; the shape
 * only picks the type the value reads in. A URL is finished in mono so it can be
 * copied and compared by eye, a timestamp in tabular figures so two dates line up
 * on their digits.
 *
 * @param props - the scalar node.
 * @returns the value, or an em dash for an empty one.
 */
function PropertyValue({ node }) {
  const value = String(node?.value ?? '');
  if (value === '') return React.createElement('span', { className: 'dsmd-propEmpty' }, '—');
  const shape = shapeOf(value);
  return React.createElement('span', {
    className: shape === '' ? 'dsmd-propValue' : `dsmd-propValue dsmd-prop-${shape}`,
    title: shape === '' ? undefined : value,
  }, value);
}

/**
 * A list value, drawn as compact chips rather than as a nested bullet list.
 *
 * A header's lists are short and homogeneous — tags, breadcrumb titles, aliases —
 * and a chip keeps them on one line each instead of doubling the block's height.
 * A list of maps is the one shape a chip cannot hold, so its items fall back to a
 * small stacked group, still one line per key.
 *
 * @param props - the list node.
 * @returns the list's presentation.
 */
function PropertyList({ node }) {
  const items = Array.isArray(node.items) ? node.items : [];
  // An empty list is a value like an empty scalar and has to say so, or the row
  // reads as a rendering fault rather than as `[]`.
  if (items.length === 0) return React.createElement('span', { className: 'dsmd-propEmpty' }, '—');
  const maps = items.some((item) => item.kind === 'map');
  if (maps === true) {
    return React.createElement('div', { className: 'dsmd-propStack' }, items.map((item, index) => {
      const entries = Array.isArray(item.entries) ? item.entries : [];
      return React.createElement('div', { className: 'dsmd-propItem', key: `m${String(index)}` },
        entries.map((entry) => React.createElement('span', { className: 'dsmd-propPair', key: entry.key },
          React.createElement('span', { className: 'dsmd-propKey dsmd-propKey--inline' }, entry.key),
          React.createElement(PropertyValue, { node: entry }))));
    }));
  }
  return React.createElement('div', { className: 'dsmd-propChips' },
    items.map((item, index) => React.createElement('span', {
      className: 'dsmd-propChip',
      key: `c${String(index)}`,
    }, item.kind === 'map'
      ? String((item.entries ?? []).map((entry) => entry.value ?? '').join(' / '))
      : String(item.value ?? ''))));
}

/**
 * One key/value row of the metadata block.
 *
 * @param props - the entry to draw.
 * @returns the row.
 */
function PropertyRow({ entry }) {
  const isList = entry.kind === 'list';
  const isMap = entry.kind === 'map';
  return React.createElement('div', {
    className: isList || isMap ? 'dsmd-propRow dsmd-propRow--wide' : 'dsmd-propRow',
    'data-dsmd-prop': entry.key,
  },
  React.createElement('span', { className: 'dsmd-propKey' }, entry.key),
  isList
    ? React.createElement(PropertyList, { node: entry })
    : isMap
      ? React.createElement('span', { className: 'dsmd-propStack' }, (entry.entries ?? []).map((child) => React.createElement('span', {
        className: 'dsmd-propPair',
        key: child.key,
      },
      React.createElement('span', { className: 'dsmd-propKey dsmd-propKey--inline' }, child.key),
      React.createElement(PropertyValue, { node: child }))))
      : React.createElement(PropertyValue, { node: entry }));
}

/**
 * The leading frontmatter block, as a collapsible sheet of properties.
 *
 * The Markdown parser cannot be handed this text: it reads the `---` delimiters as
 * a horizontal rule and the keys as setext headings, which is why it used to be a
 * `<pre>`. But echoing YAML back at the reader asks them to parse it by eye, and a
 * document header is metadata — it wants a key/value shape, the way Obsidian and
 * the shipped previews present it.
 *
 * `collapsed` is an attribute of the surface, not of this block: a modified group
 * draws the same header twice, once per half, and the inline highlighter compares
 * those halves by their text content. Two halves folded differently would compare
 * different text and mis-mark the words. So the fold is applied to both halves at
 * once, and — the part that keeps the comparison honest — the rows stay in the DOM
 * when folded. The collapsed look comes from CSS clipping, never from removing
 * text the other half still shows.
 *
 * @param props - the block's source text, the fold state, and the labels.
 * @returns the properties block.
 */
function Frontmatter({ text, collapsed, onToggle, labels }) {
  const entries = React.useMemo(() => parseProperties(text), [text]);
  // A header this reader cannot show faithfully falls back to the verbatim block:
  // half a header would be worse than the source it came from.
  if (entries === null) {
    return React.createElement('pre', {
      className: 'dsmd-frontmatter dsmd-frontmatter--source',
      'data-markdown-diff-frontmatter': 'true',
      'data-dsmd-collapsed': collapsed ? 'true' : 'false',
    }, text);
  }
  const count = entries.length;
  return React.createElement('section', {
    className: 'dsmd-props',
    'data-markdown-diff-frontmatter': 'true',
    'data-dsmd-collapsed': collapsed ? 'true' : 'false',
    'aria-label': labels.title,
  },
  React.createElement('button', {
    type: 'button',
    className: 'dsmd-propsHead',
    'aria-expanded': collapsed ? 'false' : 'true',
    title: collapsed ? labels.expand : labels.collapse,
    onClick: () => { if (typeof onToggle === 'function') onToggle(); },
  },
  React.createElement(ChevronIcon, { open: collapsed === false }),
  React.createElement('span', { className: 'dsmd-propsTitle' }, labels.title),
  React.createElement('span', { className: 'dsmd-propsCount' }, count === 0 ? labels.empty : labels.count(count))),
  React.createElement('div', { className: 'dsmd-propsBody' },
    count === 0 ? null : entries.map((entry) => React.createElement(PropertyRow, {
      key: entry.key,
      entry,
    }))));
}

/**
 * The twisty that marks the properties block as foldable.
 * @param props - whether the block is open.
 * @returns the icon.
 */
function ChevronIcon({ open }) {
  return React.createElement('svg', {
    className: open ? 'dsmd-chevron dsmd-chevron--open' : 'dsmd-chevron',
    viewBox: '0 0 16 16',
    width: '12',
    height: '12',
    'aria-hidden': 'true',
    focusable: 'false',
  }, React.createElement('path', {
    d: 'M6 4l4 4-4 4',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.6',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  }));
}

/**
 * Render one side of a group.
 *
 * A leading frontmatter block is drawn as a metadata sheet rather than handed to
 * the Markdown parser, which would read its `---` delimiters as a rule and a
 * setext heading. The remaining blocks go over in a single call so an unchanged
 * run stays one document, which is what keeps list spacing and table alignment
 * looking the way the file does.
 *
 * @param props - the group's blocks for this side.
 * @returns the rendered side.
 */
function Side({ blocks, MarkdownText, pathImages, labels, frontmatterLabels, collapsed, onToggleFrontmatter }) {
  if (blocks.length === 0) return null;
  const hasFrontmatter = blocks[0].kind === 'frontmatter';
  const rest = hasFrontmatter ? blocks.slice(1) : blocks;
  const text = rest.map((block) => block.text).join('\n\n');
  if (hasFrontmatter === false) return React.createElement(Fragment, { text, MarkdownText, pathImages, labels });
  return React.createElement(React.Fragment, null,
    React.createElement(Frontmatter, {
      text: blocks[0].text,
      collapsed,
      onToggle: onToggleFrontmatter,
      labels: frontmatterLabels,
    }),
    text === '' ? null : React.createElement(Fragment, { text, MarkdownText, pathImages, labels }));
}

/** The speech bubble of the comment button and of the mark left behind. */
function CommentIcon() {
  return React.createElement('svg', {
    viewBox: '0 0 16 16',
    fill: 'none',
    'aria-hidden': 'true',
    focusable: 'false',
  }, React.createElement('path', {
    d: 'M3 3h10a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H7.2L4.6 12.6V10H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z',
    stroke: 'currentColor',
    'stroke-width': '1.2',
    'stroke-linejoin': 'round',
    'stroke-linecap': 'round',
  }));
}

/**
 * Whether two selection anchors describe the same place, so a drag that does not
 * move the button does not re-render the surface on every `selectionchange`.
 * @param current - the anchor on screen, or `null`.
 * @param next - the anchor just read, or `undefined`.
 * @returns whether nothing would change.
 */
function sameAnchor(current, next) {
  if (current === null && next === undefined) return true;
  if (current === null || next === undefined) return false;
  return current.groupIndex === next.groupIndex
    && current.side === next.side
    && current.address === next.address
    && current.quote === next.quote
    && current.top === next.top
    && current.left === next.left;
}

/**
 * The remark already written about one block, when there is one.
 * @param marks - the comments sent from this surface.
 * @param index - the group index.
 * @param side - the side to match, or `undefined` for either.
 * @returns the remark text, or `undefined`.
 */
function markTextOf(marks, index, side) {
  if (Array.isArray(marks) === false) return undefined;
  const found = marks.find((entry) => entry.groupIndex === index && (side === undefined || entry.side === side));
  return found?.text;
}

/**
 * The comment box: what is being quoted, a place to write, and the way out.
 *
 * It is opened by the floating button and closed by its own buttons, `Esc`, or a
 * successful insert. Nothing is sent to the chat from here — the remark joins the
 * draft, so the reader keeps control of when the message goes out.
 *
 * @param props - the pending anchor, its labels, and the insert/cancel handlers.
 * @returns the box.
 */
function CommentBox({ draft, labels, onSend, onCancel }) {
  const [text, setText] = React.useState('');
  const [error, setError] = React.useState('');
  const area = React.useRef(null);
  React.useEffect(() => {
    if (area.current?.focus !== undefined) area.current.focus();
  }, []);
  const submit = () => {
    const remark = text.trim();
    if (remark === '') return;
    const outcome = typeof onSend === 'function' ? onSend(remark) : undefined;
    if (outcome !== undefined && outcome?.ok !== true) {
      const reason = outcome?.reason ?? 'failed';
      setError(labels.errors?.[reason] ?? labels.errors?.failed ?? reason);
      return;
    }
    // A successful insert unmounts the box, so there is no state to reset.
    setError('');
  };
  return React.createElement('div', { className: 'dsmd-comment', 'data-markdown-diff-comment': 'true' },
    // The preview is the message itself, block for block: address, quotation,
    // remark. Showing one shape here and writing another would make every comment
    // a small surprise in the chat.
    React.createElement('div', { className: 'dsmd-commentHead' },
      React.createElement('span', null, draft.address),
      React.createElement('span', null, labels.remark)),
    // The reader must learn before sending that the text will not travel: past the
    // limit only the address goes, and showing the quotation anyway would promise
    // a message that is not the one written.
    String(draft.quote ?? '').length > SELECTION_LIMIT
      ? React.createElement('div', { className: 'dsmd-commentLong' }, labels.tooLong(SELECTION_LIMIT))
      : React.createElement('div', { className: 'dsmd-commentQuote' }, draft.quote),
    React.createElement('textarea', {
      className: 'dsmd-commentInput',
      ref: area,
      value: text,
      rows: 2,
      placeholder: labels.placeholder,
      'aria-label': labels.placeholder,
      onChange: (event) => { setText(event.target.value); },
      onKeyDown: (event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          if (typeof onCancel === 'function') onCancel();
          return;
        }
        if (event.key === 'Enter' && (event.ctrlKey === true || event.metaKey === true)) {
          event.preventDefault();
          submit();
        }
      },
    }),
    error === '' ? null : React.createElement('p', { className: 'dsmd-commentError' }, error),
    React.createElement('div', { className: 'dsmd-commentFoot' },
      React.createElement('button', {
        type: 'button',
        className: 'dsmd-commentSend',
        disabled: text.trim() === '',
        onClick: submit,
      }, labels.send),
      React.createElement('button', {
        type: 'button',
        className: 'dsmd-commentCancel',
        onClick: typeof onCancel === 'function' ? onCancel : undefined,
      }, labels.cancel),
      React.createElement('span', { className: 'dsmd-commentHint' }, labels.hint)));
}

/**
 * The content box of one block side.
 *
 * `pair` and `side` name the two halves of a modified group so the inline
 * highlighter can find them in the finished DOM and compare their text. They are
 * absent on a one-sided block, which is wholly new or wholly gone and so has no
 * unchanged words to leave alone.
 *
 * @param props - the block kind, the pair identity, and the rendered content.
 * @returns the content box.
 */
function Content({ kind, pair, side, children }) {
  return React.createElement('div', {
    className: kind === 'equal' ? 'dsmd-content' : 'dsmd-content dsmd-marked',
    'data-dsmd-pair': pair,
    'data-dsmd-side': side,
  }, children);
}

/**
 * One highlighted block: a frame, a gutter mark, and the rendered fragment.
 *
 * `group` is the index of the group this block draws, and it is what makes the
 * block addressable from a selection: the renderer gives no other handle on
 * which part of the document a range fell into.
 *
 * @param props - the block kind, the pair identity, the group index, the rendered
 *   content, and the remark already written about it, if any.
 * @returns the framed block.
 */
function Block({ kind, children, pair, side, anchor, group, mark }) {
  const gutter = kind === 'added' ? '+' : kind === 'removed' ? '−' : kind === 'modified' ? '±' : '';
  return React.createElement('div', {
    className: 'dsmd-block',
    'data-kind': kind,
    'data-dsmd-paired': pair === undefined ? undefined : 'true',
    'data-dsmd-anchor': anchor,
    'data-dsmd-group': group === undefined ? undefined : String(group),
  },
  gutter === '' ? null : React.createElement('span', { className: 'dsmd-gutter', 'aria-hidden': 'true' }, gutter),
  React.createElement(Content, { kind, pair, side }, children),
  mark === undefined ? null : React.createElement('span', {
    className: 'dsmd-commentMark',
    title: mark,
    'aria-label': mark,
  }, React.createElement(CommentIcon, null)));
}

/**
 * A modified block in the inline view: the old side struck above, the new side
 * below, both identified as one pair.
 *
 * With removals hidden the old side is not dropped from the tree — it is only
 * hidden. The inline highlighter compares the two sides' text to find the changed
 * words, so removing the base side would leave it with nothing to compare the new
 * text against and every word would come out as inserted. Hidden means "not
 * painted", not "not there".
 *
 * @param props - the pair index, both rendered sides, whether to hide the old one,
 *   the group index, and the remark already written about it.
 * @returns the framed block.
 */
function ModifiedBlock({ pair, before, after, hideBefore, anchor, group, mark }) {
  return React.createElement('div', {
    className: 'dsmd-block',
    'data-kind': 'modified',
    'data-dsmd-paired': 'true',
    'data-dsmd-anchor': anchor,
    'data-dsmd-group': group === undefined ? undefined : String(group),
  },
    React.createElement('span', { className: 'dsmd-gutter', 'aria-hidden': 'true' }, '±'),
    React.createElement('div', {
      className: 'dsmd-before',
      // Hidden through the element's own style, not through a stylesheet rule.
      // The rule exists as well, but a page can be running the stylesheet of an
      // earlier build while executing this one, and then a new selector never
      // applies: the attribute would be set and nothing would move on screen.
      // An inline declaration cannot be left behind by a stale sheet.
      style: hideBefore ? { display: 'none' } : undefined,
      'data-dsmd-hidden': hideBefore ? 'true' : undefined,
    }, React.createElement(Content, { kind: 'modified', pair, side: 'before' }, before)),
    React.createElement(Content, { kind: 'modified', pair, side: 'after' }, after),
    mark === undefined ? null : React.createElement('span', {
      className: 'dsmd-commentMark',
      title: mark,
      'aria-label': mark,
    }, React.createElement(CommentIcon, null)));
}

/**
 * Render a group's working-tree side, or its base side, in the inline view.
 * @param props - which side to draw.
 * @returns the rendered side.
 */
function inlineSide(group, useBase) {
  return useBase ? group.before ?? [] : group.after ?? [];
}

/** The inline view: one document, changed blocks framed where they stand. */
function Inline({ result, MarkdownText, pathImages, markdownLabels, hideRemoved, anchorAt, frontmatterLabels, frontmatterCollapsed, onToggleFrontmatter, comment, marks, commentLabels, onSendComment, onCancelComment }) {
  return React.createElement('div', { 'data-markdown-diff-view': 'inline' },
    React.createElement('div', { className: 'dsmd-doc' }, result.groups.map((group, index) => {
      const key = `g${String(index)}`;
      const anchor = index === anchorAt ? String(index) : undefined;
      const mark = markTextOf(marks, index);
      const side = (blocks) => React.createElement(Side, {
        blocks,
        MarkdownText,
        pathImages,
        labels: markdownLabels,
        frontmatterLabels,
        collapsed: frontmatterCollapsed,
        onToggleFrontmatter,
      });
      let block;
      if (group.kind === 'equal') {
        block = React.createElement(Block, { key, kind: 'equal', anchor, group: index, mark }, side(group.after));
      } else if (group.kind === 'modified') {
        block = React.createElement(ModifiedBlock, {
          key,
          pair: String(index),
          before: side(group.before),
          after: side(group.after),
          hideBefore: hideRemoved,
          anchor,
          group: index,
          mark,
        });
      } else {
        // A removed inline block draws the base half, and says so: without the
        // side the selection reader would look for the text in the working-tree
        // half, find nothing there, and offer no comment on a deletion.
        block = React.createElement(Block, {
          key,
          kind: group.kind,
          side: group.kind === 'removed' ? 'before' : 'after',
          anchor,
          group: index,
          mark,
        }, side(group.kind === 'removed' ? group.before : group.after));
      }
      // The box follows the whole group, whichever half the remark is about: the
      // inline view draws both halves inside one frame, so the remark belongs
      // under that frame rather than between its lines.
      if (comment === null || comment === undefined || comment.groupIndex !== index) return block;
      return React.createElement(React.Fragment, { key: `box${String(index)}` }, block,
        React.createElement(CommentBox, {
          key: 'comment',
          draft: comment,
          labels: commentLabels,
          onSend: onSendComment,
          onCancel: onCancelComment,
        }));
    })));
}

/** The side-by-side view: the comparison base on the left, the file on the right. */
function SideBySide({ result, MarkdownText, pathImages, markdownLabels, base, baseLabel, anchorAt, frontmatterLabels, frontmatterCollapsed, onToggleFrontmatter, comment, marks, commentLabels, onSendComment, onCancelComment }) {
  const labels = currentLabels();
  const left = [];
  const right = [];
  const side = (blocks) => React.createElement(Side, {
    blocks,
    MarkdownText,
    pathImages,
    labels: markdownLabels,
    frontmatterLabels,
    collapsed: frontmatterCollapsed,
    onToggleFrontmatter,
  });
  // The box joins the column of the half it quotes, not the frame's edge: a
  // remark about the base belongs beside the base text, where the reader was
  // looking when they wrote it.
  const pushComment = (stack, index, half) => {
    if (comment === null || comment === undefined) return;
    if (comment.groupIndex !== index || comment.side !== half) return;
    stack.push(React.createElement(CommentBox, {
      key: `c${String(index)}${half}`,
      draft: comment,
      labels: commentLabels,
      onSend: onSendComment,
      onCancel: onCancelComment,
    }));
  };
  for (const [index, group] of result.groups.entries()) {
    const key = `s${String(index)}`;
    // Only the working-tree column is anchored: the base column shows the other
    // file, and `querySelector` would scroll to it first.
    const anchor = index === anchorAt ? String(index) : undefined;
    if (group.kind === 'equal') {
      left.push(React.createElement(Block, { key, kind: 'equal', group: index, mark: markTextOf(marks, index, 'before') }, side(group.before)));
      right.push(React.createElement(Block, { key, kind: 'equal', anchor, group: index, mark: markTextOf(marks, index, 'after') }, side(group.after)));
      pushComment(left, index, 'before');
      pushComment(right, index, 'after');
      continue;
    }
    if (group.kind === 'modified') {
      left.push(React.createElement(Block, { key, kind: 'removed', pair: String(index), side: 'before', group: index, mark: markTextOf(marks, index, 'before') }, side(group.before)));
      right.push(React.createElement(Block, { key, kind: 'added', pair: String(index), side: 'after', anchor, group: index, mark: markTextOf(marks, index, 'after') }, side(group.after)));
      pushComment(left, index, 'before');
      pushComment(right, index, 'after');
      continue;
    }
    // A one-sided change keeps both columns advancing, so the rows stay aligned.
    left.push(group.kind === 'removed'
      ? React.createElement(Block, { key, kind: 'removed', group: index, mark: markTextOf(marks, index, 'before') }, side(group.before))
      : React.createElement('div', { key, className: 'dsmd-block', 'data-kind': 'empty' }));
    right.push(group.kind === 'added'
      ? React.createElement(Block, { key, kind: 'added', anchor, group: index, mark: markTextOf(marks, index, 'after') }, side(group.after))
      : React.createElement('div', { key, className: 'dsmd-block', 'data-kind': 'empty' }));
    pushComment(left, index, 'before');
    pushComment(right, index, 'after');
  }
  return React.createElement('div', { className: 'dsmd-split', 'data-markdown-diff-view': 'side-by-side' },
    React.createElement('div', { className: 'dsmd-col', 'data-side': 'base' },
      React.createElement('div', { className: 'dsmd-colHead' }, baseLabel ?? (base === 'index' ? labels.toolbar.baseIndex : labels.toolbar.baseHead)),
      left),
    React.createElement('div', { className: 'dsmd-col', 'data-side': 'worktree' },
      React.createElement('div', { className: 'dsmd-colHead' }, labels.columnWorktree),
      right));
}

export { injectStyles };
