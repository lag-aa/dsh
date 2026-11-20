/**
 * Narrow a block's highlight down to the words that actually changed.
 *
 * The Markdown renderer draws parsed nodes directly and turns raw HTML into
 * literal text, so a changed word cannot be wrapped in a marker in the source and
 * cannot be reached with an `ins`/`del` element either: whatever the plugin writes
 * into the Markdown would either be stripped or shown verbatim. What is left is
 * the finished DOM, and the one browser feature that can mark a text range there
 * without mutating it: the CSS Custom Highlight API.
 *
 * Mutating the DOM is the obvious alternative and is rejected here. The subtree
 * belongs to a memoized React component; splitting its text nodes would leave
 * React reconciling a tree it no longer owns, and the first re-render would throw
 * on a child that has moved or vanished. `CSS.highlights` paints from outside the
 * tree, so a re-render simply replaces the ranges.
 *
 * Both sides of a modified group are already rendered next to each other, so the
 * word diff runs on their `textContent` rather than on the Markdown source. That
 * is what keeps offsets exact: the string being compared is the same string the
 * text nodes hold, with no source-to-DOM mapping to drift.
 *
 * @module dsh-markdown-diff/highlight
 */

import { diffInline, rangesOf } from './inline.js';

/** The registered highlight names. One set per document, as the API is global. */
const INS_NAME = 'dsh-markdown-diff-ins';
const DEL_NAME = 'dsh-markdown-diff-del';

/**
 * The surface that most recently painted the shared highlight names.
 *
 * The registry is global while several previews can be mounted at once, so a
 * surface that unmounts must not clear the ranges of the one that replaced it.
 * Cleanup therefore only acts while it still owns the names.
 */
let owner = null;

/**
 * Whether this environment can paint text ranges at all.
 *
 * Firefox and older Chromium lack the API; the caller then keeps the block-level
 * tint, which is the behaviour that shipped before this module existed.
 *
 * @returns true when ranges can be registered.
 */
export function supportsInlineHighlight() {
  if (typeof CSS === 'undefined' || CSS === null) return false;
  if (typeof CSS.highlights === 'undefined' || CSS.highlights === null) return false;
  return typeof Highlight === 'function';
}

/**
 * Elements that start a new block of text.
 *
 * The renderer emits one element per block — a paragraph, a heading, a list item
 * — and `textContent` joins their text with no separator at all. Two blocks then
 * read as one run: the last word of the first and the first word of the second
 * arrive glued into a single token, and a change to either word marks both. The
 * set below is what tells such a seam apart from inline markup, where glue is
 * correct: `**jum**ps` must stay one word.
 */
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'CAPTION', 'DD', 'DIV', 'DL', 'DT',
  'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE',
  'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR', 'UL',
]);

/** What a block seam contributes to the compared text: whitespace, never a word. */
const BLOCK_SEPARATOR = '\n';

/**
 * The nearest block-level element containing a text node.
 *
 * Only the block matters, not the exact element: two text nodes inside one
 * paragraph belong to the same run however much inline markup sits between them.
 *
 * @param node - the text node to place.
 * @param container - the side element being read; the walk stops there.
 * @returns the nearest block ancestor, or null when there is none below the container.
 */
function blockAncestorOf(node, container) {
  for (let at = node.parentNode; at !== null && at !== undefined && at !== container; at = at.parentNode) {
    if (at.nodeType === 1 && BLOCK_TAGS.has(String(at.nodeName).toUpperCase())) return at;
  }
  return null;
}

/**
 * Collect the rendered text nodes of one element, with their offsets.
 *
 * A seam between two blocks contributes {@link BLOCK_SEPARATOR} to the text: it
 * occupies an offset and belongs to no node, so it can never be marked, and the
 * tokenizer reads it as the word break it stands for. Ranges stay in this offset
 * space; {@link documentRanges} maps them back to nodes.
 *
 * @param element - the element whose text is about to be marked.
 * @returns `{ entries, text }` — the nodes with their offsets in document order,
 *   and the text they spell, seams included.
 */
function textNodesOf(element) {
  if (typeof document === 'undefined') return { entries: [], text: '' };
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const entries = [];
  let text = '';
  let previousBlock;
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.data.length === 0) continue;
    const block = blockAncestorOf(node, element);
    // The first node never opens with a separator, and neither does a node that
    // merely continues the block before it.
    if (text !== '' && block !== previousBlock) text += BLOCK_SEPARATOR;
    previousBlock = block;
    entries.push({ node, start: text.length, end: text.length + node.data.length });
    text += node.data;
  }
  return { entries, text };
}

/**
 * Build the DOM ranges for one side's offset ranges.
 *
 * A range that starts in one text node and ends in another is kept whole: the
 * Range API accepts boundary points in different nodes, and splitting the mark at
 * the node boundary would draw a visible seam in the middle of a word.
 *
 * @param entries - the side's text nodes, from {@link textNodesOf}.
 * @param ranges - offset ranges within the side's text.
 * @returns the DOM ranges that could be built.
 */
function documentRanges(entries, ranges) {
  const found = [];
  if (entries.length === 0) return found;
  for (const range of ranges) {
    const start = entries.find((entry) => range.start >= entry.start && range.start < entry.end);
    const last = entries.find((entry) => range.end > entry.start && range.end <= entry.end);
    if (start === undefined || last === undefined) continue;
    const domRange = document.createRange();
    domRange.setStart(start.node, range.start - start.start);
    domRange.setEnd(last.node, range.end - last.start);
    found.push(domRange);
  }
  return found;
}

/**
 * Group the marked elements of one surface into before/after pairs.
 *
 * A modified group renders both sides, so its two halves carry the same pair
 * index. Anything without a pair — an added or removed block — stays wholly
 * tinted, which is correct: none of its text is unchanged.
 *
 * @param root - the surface's root element.
 * @returns one entry per pair, each with whichever sides the view drew.
 */
function pairsOf(root) {
  const pairs = new Map();
  for (const element of root.querySelectorAll('[data-dsmd-pair]')) {
    const index = element.getAttribute('data-dsmd-pair');
    const side = element.getAttribute('data-dsmd-side');
    if (index === null || (side !== 'before' && side !== 'after')) continue;
    const pair = pairs.get(index) ?? {};
    pair[side] = element;
    pairs.set(index, pair);
  }
  return [...pairs.values()];
}

/**
 * Paint the changed words of every modified group in one surface.
 *
 * Failure here must never cost the document: a preview that cannot be marked is
 * still a preview, so every step is guarded and the caller keeps its block tint
 * when nothing could be registered. The `data-dsmd-narrow` attribute is what
 * switches the stylesheet from the block tint to the narrow marking, and it is set
 * only once the ranges are in the registry — a stylesheet that narrowed the block
 * before the words were painted would leave a changed paragraph looking untouched.
 *
 * @param root - the surface's root element, or null before the first render.
 * @returns a cleanup function that removes this surface's highlights.
 */
export function applyInlineHighlight(root) {
  if (!supportsInlineHighlight() || root === null || root === undefined) return () => {};
  try {
    const inserted = [];
    const removed = [];
    for (const pair of pairsOf(root)) {
      if (pair.before === undefined || pair.after === undefined) continue;
      // Both sides are read through the same seam-aware walk as their ranges, so
      // the compared string and the offsets into it describe one and the same
      // text. Comparing raw `textContent` here would glue neighbouring blocks
      // together and mark the word on either side of the seam.
      const before = textNodesOf(pair.before);
      const after = textNodesOf(pair.after);
      const segments = diffInline(before.text, after.text);
      removed.push(...documentRanges(before.entries, rangesOf(segments, 'del')));
      inserted.push(...documentRanges(after.entries, rangesOf(segments, 'ins')));
    }
    // A global registry holds one entry per name, so the previous surface's
    // ranges are replaced rather than merged: the visible preview is the one
    // that wins.
    CSS.highlights.set(INS_NAME, new Highlight(...inserted));
    CSS.highlights.set(DEL_NAME, new Highlight(...removed));
    // Narrowing is a promise that the changed words are painted. When no range
    // could be located — a rewritten paragraph, a group the coarse path folded —
    // the block tint has to stay, so the attribute is withheld and the stylesheet
    // keeps the whole-block marking.
    const located = inserted.length + removed.length;
    if (located === 0) return () => {};
    root.setAttribute('data-dsmd-narrow', 'true');
    owner = root;
    return () => {
      root.removeAttribute('data-dsmd-narrow');
      // Only the surface that painted the ranges may clear them. A second preview
      // can mount while the first still unmounts, and clearing on the way out
      // would then leave the visible document marked nowhere.
      if (owner !== root) return;
      // A re-run of the effect cleans up before painting again, and once the
      // surface is gone there is nothing left to paint: the ranges go either way.
      CSS.highlights.delete(INS_NAME);
      CSS.highlights.delete(DEL_NAME);
      owner = null;
    };
  } catch {
    // An unsupported range or a detached tree leaves the block tint in place.
    return () => {};
  }
}
