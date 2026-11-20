/**
 * Compare two block lists and describe the change as groups.
 *
 * The comparison is a block-level longest-common-subsequence walk over the
 * comparison key from `./blocks.js`. What it produces is a flat, ordered list of
 * groups: an `equal` run, an `added` run, a `removed` run, or a `modified` pair
 * made by folding a removal straight into the insertion that replaced it. That
 * last fold is a presentation choice, not a diff fact: git would report the pair
 * as a deletion plus an insertion, and the preview would then have to show a
 * strikethrough paragraph and a green one separately instead of as one edit.
 *
 * @module dsh-markdown-diff/diff
 */

import { blockKey, splitMarkdown } from './blocks.js';

/** Above this many cell comparisons the walk is skipped for a coarse answer. */
const MAX_CELLS = 250000;

/** How alike a removed and an added block must be to fold into one `modified` group. */
const SIMILARITY = 0.3;

/**
 * The words of one block, lowercased, as a set.
 * @param text - block text.
 * @returns the word set used for similarity.
 */
function wordsOf(text) {
  const words = new Set();
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word !== '') words.add(word);
  }
  return words;
}

/**
 * Jaccard similarity of two blocks, by word set.
 * @param left - the removed block's text.
 * @param right - the added block's text.
 * @returns a number in `[0, 1]`.
 */
export function similarityOf(left, right) {
  const a = wordsOf(left);
  const b = wordsOf(right);
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/**
 * Longest-common-subsequence alignment of two key lists.
 *
 * @param left - keys of the comparison base.
 * @param right - keys of the working tree.
 * @returns the operations in document order.
 */
function align(left, right) {
  const operations = [];
  const rows = left.length;
  const columns = right.length;
  if (rows * columns > MAX_CELLS) {
    // Too large to walk: only the shared prefix and suffix are trusted.
    let prefix = 0;
    while (prefix < rows && prefix < columns && left[prefix] === right[prefix]) prefix += 1;
    let suffix = 0;
    while (
      suffix < rows - prefix
      && suffix < columns - prefix
      && left[rows - 1 - suffix] === right[columns - 1 - suffix]
    ) suffix += 1;
    for (let at = 0; at < prefix; at += 1) operations.push({ op: 'equal', left: at, right: at });
    for (let at = prefix; at < rows - suffix; at += 1) operations.push({ op: 'delete', left: at });
    for (let at = prefix; at < columns - suffix; at += 1) operations.push({ op: 'insert', right: at });
    for (let at = 0; at < suffix; at += 1) {
      operations.push({ op: 'equal', left: rows - suffix + at, right: columns - suffix + at });
    }
    return operations;
  }
  // length[i][j] = LCS length of left[i..] and right[j..], filled backwards.
  const width = columns + 1;
  const length = new Uint32Array((rows + 1) * width);
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      length[i * width + j] = left[i] === right[j]
        ? length[(i + 1) * width + j + 1] + 1
        : Math.max(length[(i + 1) * width + j], length[i * width + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < rows && j < columns) {
    if (left[i] === right[j]) {
      operations.push({ op: 'equal', left: i, right: j });
      i += 1;
      j += 1;
    } else if (length[(i + 1) * width + j] >= length[i * width + j + 1]) {
      operations.push({ op: 'delete', left: i });
      i += 1;
    } else {
      operations.push({ op: 'insert', right: j });
      j += 1;
    }
  }
  while (i < rows) {
    operations.push({ op: 'delete', left: i });
    i += 1;
  }
  while (j < columns) {
    operations.push({ op: 'insert', right: j });
    j += 1;
  }
  return operations;
}

/**
 * Fold one deletion run and one insertion run into the groups it presents as.
 *
 * Everything below `SIMILARITY` stays a separate removal and addition, so a
 * rewritten section reads as new text rather than as an edit of the old one.
 *
 * @param removed - comparison-base blocks in the run.
 * @param added - working-tree blocks in the run.
 * @returns the groups for the run, in order.
 */
function foldRun(removed, added) {
  if (removed.length === 0) return [{ kind: 'added', after: added }];
  if (added.length === 0) return [{ kind: 'removed', before: removed }];
  const mark = similarityOf(
    removed.map((block) => blockKey(block)).join('\n'),
    added.map((block) => blockKey(block)).join('\n'),
  );
  if (mark >= SIMILARITY) return [{ kind: 'modified', before: removed, after: added }];
  return [{ kind: 'removed', before: removed }, { kind: 'added', after: added }];
}

/**
 * Compare a document with its comparison base.
 *
 * Groups are runs, not single blocks: one unchanged stretch of the document is
 * one group, so the renderer can hand it to the Markdown parser whole. Splitting
 * an unchanged list into one group per item would render each item as its own
 * list, which changes the spacing of text nobody edited.
 *
 * @param baseText - the base version's Markdown source; empty for a new file.
 * @param currentText - the working tree's Markdown source.
 * @param options - `showRemoved: false` drops groups that only remove text.
 * @returns the groups in document order, the change counters, and whether anything changed.
 */
export function diffDocuments(baseText, currentText, options = {}) {
  const { showRemoved = true } = options;
  const base = splitMarkdown(baseText);
  const current = splitMarkdown(currentText);
  const operations = align(base.map((block) => blockKey(block)), current.map((block) => blockKey(block)));

  const groups = [];
  let equalBefore = [];
  let equalAfter = [];
  let removedRun = [];
  let addedRun = [];
  const flushEqual = () => {
    if (equalAfter.length === 0) return;
    groups.push({ kind: 'equal', before: equalBefore, after: equalAfter });
    equalBefore = [];
    equalAfter = [];
  };
  const flushChange = () => {
    if (removedRun.length === 0 && addedRun.length === 0) return;
    for (const group of foldRun(removedRun, addedRun)) groups.push(group);
    removedRun = [];
    addedRun = [];
  };
  for (const operation of operations) {
    if (operation.op === 'equal') {
      flushChange();
      equalBefore.push(base[operation.left]);
      equalAfter.push(current[operation.right]);
      continue;
    }
    flushEqual();
    if (operation.op === 'delete') removedRun.push(base[operation.left]);
    else addedRun.push(current[operation.right]);
  }
  flushChange();
  flushEqual();

  const stats = { added: 0, removed: 0, modified: 0, groups: 0 };
  for (const group of groups) {
    if (group.kind === 'equal') continue;
    if (group.kind === 'added') stats.added += group.after.length;
    else if (group.kind === 'removed') stats.removed += group.before.length;
    else stats.modified += Math.max(group.before.length, group.after.length);
    stats.groups += 1;
  }
  const visible = showRemoved ? groups : groups.filter((group) => group.kind !== 'removed');
  return {
    base,
    current,
    groups: visible,
    stats,
    changed: stats.groups > 0,
  };
}

/**
 * The Markdown source of one group's base side.
 * @param group - a diff group.
 * @returns the base text, or an empty string for a pure addition.
 */
export function beforeText(group) {
  return (group.before ?? []).map((block) => block.text).join('\n\n');
}

/**
 * The Markdown source of one group's working-tree side.
 * @param group - a diff group.
 * @returns the working-tree text, or an empty string for a pure removal.
 */
export function afterText(group) {
  return (group.after ?? []).map((block) => block.text).join('\n\n');
}

/** The one-line summary shown in the toolbar, e.g. `+3 −1`. */
export function summarize(stats) {
  const parts = [];
  if (stats.added > 0) parts.push(`+${String(stats.added)}`);
  if (stats.removed > 0) parts.push(`−${String(stats.removed)}`);
  if (stats.modified > 0) parts.push(`~${String(stats.modified)}`);
  return parts.join(' ');
}
