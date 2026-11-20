/**
 * Read the reader's selection inside a diff surface.
 *
 * This is the half of commenting that needs a DOM: which block was selected,
 * which side of a modified pair it belongs to, where the floating button should
 * stand, and what the selection actually says. Everything it derives from those
 * answers is string math in `comments.js`, so only the reading lives here.
 *
 * The block is found through `data-dsmd-group`, which every block element
 * carries, and the side through the nearest `data-dsmd-side` element — the
 * content box of a modified half — or, for an unchanged row in the split view,
 * through the column the selection sits in. A group is the smallest thing the
 * renderer can identify: it draws one element per group, not per source block,
 * so a selection covering several blocks of one paragraph group is still one
 * answer.
 *
 * @module dsh-markdown-diff/selection
 */

import { addressOf, linesOfSelection, normalizeText, spanOf } from './comments.js';

/**
 * How far left of the block the button stands, in pixels.
 *
 * The button is positioned absolutely, so this offset is the only thing keeping it
 * off the text it points at. It mirrors the button's own width in the surface
 * stylesheet plus a small gap; a stylesheet check pins the two together, because a
 * mismatch would either overlap the text or drift away from it.
 */
export const BTN_OFFSET = 30;

/** The gap between the button and the text, in pixels. */
export const BTN_GAP = 4;

/**
 * The element a selection endpoint sits in.
 * @param node - a text node, element, or the boundary of a range.
 * @returns the element, or `null`.
 */
function elementOf(node) {
  if (node === null || node === undefined) return null;
  if (node.nodeType === 1) return node;
  const parent = node.parentElement ?? (node.parentNode?.nodeType === 1 ? node.parentNode : null);
  return parent ?? null;
}

/**
 * Which half of a pair a selected element belongs to.
 *
 * A modified group names its halves outright. An unchanged row is drawn twice in
 * the split view with no side attribute of its own, so the column decides: the
 * left column is the comparison base, the right one is the file on disk.
 *
 * @param element - the element the selection starts in.
 * @returns `'before'` or `'after'`.
 */
export function sideOf(element) {
  const named = element.closest('[data-dsmd-side]');
  if (named !== null) {
    const value = named.getAttribute('data-dsmd-side');
    if (value === 'before' || value === 'after') return value;
  }
  const column = element.closest('.dsmd-col');
  return column?.getAttribute('data-side') === 'base' ? 'before' : 'after';
}

/**
 * What to quote: the selection itself, or the block's Markdown when the whole
 * block is selected.
 *
 * A whole-block selection is the common case for "this paragraph is wrong", and
 * quoting the source rather than the rendering keeps the markup the author wrote
 * — the model reads `**bold**` as emphasis and a fenced block as code, while the
 * rendered text would arrive stripped of it.
 *
 * The comparison is against the content box the selection actually sits in, not
 * the first one in the frame: a modified group draws both halves, and reading the
 * base half's text against a working-tree selection would never match — or worse,
 * match the other half and quote the wrong text.
 *
 * @param content - the content box the selection starts in, or `null`.
 * @param text - the selected text.
 * @param source - the group side's Markdown.
 * @returns the text to quote.
 */
function quoteFor(content, text, source) {
  if (source === '' || content === null) return text;
  const rendered = normalizeText(String(content.textContent ?? '')).trim();
  return rendered !== '' && rendered === text.trim() ? source : text;
}

/**
 * Read the current selection as something a comment can be written about.
 *
 * @param root - the surface root the selection must be inside.
 * @param groups - the diff groups, in the order the view drew them.
 * @param path - the workspace-relative path of the previewed file.
 * @param baseSuffix - what the address appends for a selection in the base half.
 * @returns the anchor — group index, side, address, quote, and the button's
 *   position relative to the surface — or `undefined` when there is no usable
 *   selection.
 */
export function readSelection(root, groups, path, baseSuffix = '') {
  if (typeof window === 'undefined' || root === null || root === undefined) return undefined;
  const active = typeof document === 'undefined' ? null : document.activeElement;
  // A caret inside the comment box is a selection too, but not one to comment on.
  if (active !== null && active !== undefined && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
    return undefined;
  }
  const selection = window.getSelection?.();
  if (selection === undefined || selection === null) return undefined;
  if (selection.rangeCount === 0 || selection.isCollapsed === true) return undefined;
  const range = selection.getRangeAt(0);
  if (root.contains(range.commonAncestorContainer) === false) return undefined;
  const start = elementOf(range.startContainer);
  if (start === null) return undefined;
  const block = start.closest('[data-dsmd-group]');
  if (block === null || root.contains(block) === false) return undefined;
  // The content box the selection starts in, not the block: a modified group draws
  // two of them, and the quotation must be checked against the one being read.
  const content = start.closest('.dsmd-content');
  const groupIndex = Number(block.getAttribute('data-dsmd-group'));
  const group = Array.isArray(groups) ? groups[groupIndex] : undefined;
  if (Number.isInteger(groupIndex) === false || group === undefined) return undefined;

  const text = normalizeText(selection.toString());
  if (text.trim() === '') return undefined;
  const side = sideOf(start);
  const blocks = side === 'before' ? group.before ?? [] : group.after ?? [];
  if (blocks.length === 0) return undefined;
  const source = blocks.map((entry) => entry.text).join('\n\n');
  const firstLine = Number.isInteger(blocks[0].start) ? blocks[0].start + 1 : 1;
  // A selection the renderer rewrote cannot be placed in the source; the block's
  // own span is then the honest answer — one hint less precise, never a wrong one.
  const lines = linesOfSelection(source, text, firstLine) ?? spanOf(blocks);
  const suffix = side === 'before' ? baseSuffix : '';

  const rootRect = root.getBoundingClientRect();
  const blockRect = block.getBoundingClientRect();
  const lineRect = typeof range.getClientRects === 'function'
    ? range.getClientRects()[0] ?? range.getBoundingClientRect()
    : range.getBoundingClientRect();
  const scrollTop = typeof root.scrollTop === 'number' ? root.scrollTop : 0;
  const scrollLeft = typeof root.scrollLeft === 'number' ? root.scrollLeft : 0;
  return {
    groupIndex,
    side,
    address: addressOf(path, lines, suffix),
    quote: quoteFor(content, text, source),
    lines,
    // Left of the block, level with the first selected line. The offset is the
    // button's own width plus a small gap, so it clears the text it points at.
    // Clamped at the surface's own edge: a narrow panel has no margin to spare,
    // and a button pushed outside the box would be unreachable.
    left: Math.max(0, Math.round(blockRect.left - rootRect.left - BTN_OFFSET + scrollLeft)),
    top: Math.max(0, Math.round(lineRect.top - rootRect.top + scrollTop)),
  };
}
