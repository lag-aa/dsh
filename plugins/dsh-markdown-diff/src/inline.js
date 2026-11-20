/**
 * Compare two blocks word by word, so a highlight can cover the words that
 * changed instead of the whole paragraph they sit in.
 *
 * The block splitter in `./blocks.js` is deliberately shallow, so a one-word edit
 * makes the entire paragraph a different block. Block-level marking alone would
 * therefore paint a whole section green because a comma moved, which is what this
 * module narrows down: the two block texts are tokenized into words, punctuation,
 * and the whitespace between them, aligned by a longest-common-subsequence walk,
 * and reported as a flat segment list in reading order.
 *
 * Whitespace is a token of its own on purpose. Treating it as a separator would
 * glue a replaced word onto its neighbour's outline, and treating it as noise
 * would let a re-flowed line masquerade as unchanged text.
 *
 * @module dsh-markdown-diff/inline
 */

/**
 * Above this many cell comparisons one alignment window is split at anchor
 * tokens instead of being walked in one piece.
 *
 * The limit is a memory bound, not a time one: the table costs four bytes per
 * cell, so this is a 4 MB allocation and a few milliseconds of filling. It sits
 * high enough that a long paragraph — a few hundred words — is compared in one
 * exact pass. A bigger block is not compared coarsely: it is cut at tokens that
 * occur exactly once on both sides (see {@link anchorsOf}) and each fragment is
 * aligned exactly, which keeps a table's unrelated columns from being painted.
 */
const MAX_CELLS = 1000000;

/**
 * One token of block text: a word, a punctuation run, or a whitespace run.
 *
 * Unicode-aware, because the prose this previews is Russian and Chinese as often
 * as it is English, and an ASCII-only split would treat a whole sentence of
 * Chinese as one unbreakable token.
 */
const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\p{L}\p{N}_\s]+/gu;

/**
 * Split block text into comparison tokens.
 * @param text - the block's source text.
 * @returns the tokens, in reading order.
 */
export function tokensOf(text) {
  return String(text ?? '').match(TOKEN) ?? [];
}

/**
 * Tokens that pin the alignment: those occurring exactly once on each side.
 *
 * This is the patience-diff idea. A unique token is almost always a real anchor —
 * a term id, a distinctive word — so a huge block can be cut at them into small
 * windows that are each aligned exactly. Unrelated columns of a table then stop
 * being swept into one marked span, which is what a coarse prefix/suffix trim
 * does. A token repeated on either side is skipped: it gives no reliable order.
 *
 * @param left - the base side's tokens.
 * @param right - the working-tree side's tokens.
 * @returns matched `{ left, right }` index pairs, increasing on both sides.
 */
function anchorsOf(left, right) {
  /** How often each token occurs, per side, and where the single one is. */
  const counted = (tokens) => {
    const seen = new Map();
    for (const [at, token] of tokens.entries()) {
      const known = seen.get(token);
      if (known === undefined) seen.set(token, { count: 1, at });
      else known.count += 1;
    }
    return seen;
  };
  const inLeft = counted(left);
  const inRight = counted(right);
  const candidates = [];
  for (const [token, here] of inLeft) {
    if (here.count !== 1) continue;
    const there = inRight.get(token);
    if (there === undefined || there.count !== 1) continue;
    candidates.push({ left: here.at, right: there.at });
  }
  // Keep the longest subsequence that is increasing on both sides, so the parts
  // between anchors cannot overlap and every token is emitted exactly once.
  candidates.sort((one, other) => one.left - other.left);
  const tail = [];
  const previous = new Array(candidates.length).fill(-1);
  for (const [at, candidate] of candidates.entries()) {
    let low = 0;
    let high = tail.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (candidates[tail[middle]].right < candidate.right) low = middle + 1;
      else high = middle;
    }
    if (low > 0) previous[at] = tail[low - 1];
    tail[low] = at;
  }
  const chain = [];
  for (let at = tail.length === 0 ? -1 : tail[tail.length - 1]; at >= 0; at = previous[at]) {
    chain.push(candidates[at]);
    if (previous[at] < 0) break;
  }
  return chain.reverse();
}

/**
 * How many differing tokens {@link myersSteps} will chase before giving up.
 *
 * Myers' walk costs one step per difference, so a big block with a handful of
 * edits answers quickly no matter how long it is — which is exactly the case a
 * table presents. A block that is rewritten wholesale has a difference count near
 * its token count, and there the walk would be quadratic: past this many steps it
 * returns nothing and the caller falls back to a coarse trim.
 */
const MAX_EDITS = 1000;

/**
 * Align two token lists by chasing the shortest edit script (Myers, 1986).
 *
 * The ancestor walk from the previous version trimmed the shared ends and marked
 * everything in between, which painted whole columns of an unchanged table green
 * whenever two cells far apart changed. This walk instead advances along a "furthest
 * reaching path" frontier and costs one iteration per differing token, so a long
 * block with few edits is both exact and cheap.
 *
 * @param left - the base side's tokens.
 * @param right - the working-tree side's tokens.
 * @param leftFrom - absolute index of the window's first left token.
 * @param rightFrom - absolute index of the window's first right token.
 * @returns steps in reading order, or `null` when the edit budget runs out.
 */
function myersSteps(left, right, leftFrom, rightFrom) {
  const rows = left.length;
  const columns = right.length;
  if (rows === 0 || columns === 0) {
    const steps = [];
    for (let at = 0; at < rows; at += 1) steps.push({ op: 'delete', left: leftFrom + at });
    for (let at = 0; at < columns; at += 1) steps.push({ op: 'insert', right: rightFrom + at });
    return steps;
  }
  const widest = rows + columns;
  const offset = widest;
  // frontier[offset + k] is the furthest row reached on diagonal k = x - y.
  const frontier = new Int32Array(2 * widest + 1);
  /** Per depth, the diagonals in use, kept for the walk back. */
  const history = [];
  const deepest = Math.min(MAX_EDITS, widest);
  for (let depth = 0; depth <= deepest; depth += 1) {
    history.push(frontier.slice(offset - depth, offset + depth + 1));
    for (let k = -depth; k <= depth; k += 2) {
      const down = k === -depth
        || (k !== depth && frontier[offset + k - 1] < frontier[offset + k + 1]);
      let x = down ? frontier[offset + k + 1] : frontier[offset + k - 1] + 1;
      let y = x - k;
      while (x < rows && y < columns && left[x] === right[y]) {
        x += 1;
        y += 1;
      }
      frontier[offset + k] = x;
      if (x >= rows && y >= columns) {
        return walkBack(history, rows, columns, leftFrom, rightFrom);
      }
    }
  }
  return null;
}

/**
 * Replay the frontier history backwards and emit the alignment.
 *
 * At each depth the last move either inserted a token (a step down a diagonal) or
 * deleted one (a step along a diagonal); the diagonal changes that ran before it
 * are the shared run, emitted as `equal`. Depth zero is nothing but the initial
 * shared run, so it is unwound directly instead of consulting a diagonal that the
 * history does not hold.
 *
 * @param history - per depth, the diagonals as they stood before that step.
 * @param rows - the left side's token count.
 * @param columns - the right side's token count.
 * @param leftFrom - absolute index of the window's first left token.
 * @param rightFrom - absolute index of the window's first right token.
 * @returns steps in reading order.
 */
function walkBack(history, rows, columns, leftFrom, rightFrom) {
  const steps = [];
  let x = rows;
  let y = columns;
  for (let depth = history.length - 1; depth >= 0; depth -= 1) {
    const snapshot = history[depth];
    if (depth === 0) {
      while (x > 0 && y > 0) {
        steps.push({ op: 'equal', left: leftFrom + x - 1, right: rightFrom + y - 1 });
        x -= 1;
        y -= 1;
      }
      break;
    }
    const at = (diagonal) => snapshot[diagonal + depth];
    const k = x - y;
    const down = k === -depth || (k !== depth && at(k - 1) < at(k + 1));
    const previousK = down ? k + 1 : k - 1;
    const previousX = at(previousK);
    const previousY = previousX - previousK;
    while (x > previousX && y > previousY) {
      steps.push({ op: 'equal', left: leftFrom + x - 1, right: rightFrom + y - 1 });
      x -= 1;
      y -= 1;
    }
    steps.push(down
      ? { op: 'insert', right: rightFrom + y - 1 }
      : { op: 'delete', left: leftFrom + x - 1 });
    x = previousX;
    y = previousY;
  }
  steps.reverse();
  return steps;
}

/**
 * Align two token lists exactly, splitting at anchors when the table is too big.
 *
 * @param left - the base side's tokens.
 * @param right - the working-tree side's tokens.
 * @param leftFrom - first index of the window on the left.
 * @param leftTo - one past the window's last index on the left.
 * @param rightFrom - first index of the window on the right.
 * @param rightTo - one past the window's last index on the right.
 * @returns steps `{ op, left?, right? }` in reading order.
 */
function alignWindow(left, right, leftFrom, leftTo, rightFrom, rightTo) {
  const leftSlice = left.slice(leftFrom, leftTo);
  const rightSlice = right.slice(rightFrom, rightTo);
  if (leftSlice.length * rightSlice.length <= MAX_CELLS) {
    return alignTable(leftSlice, rightSlice, leftFrom, rightFrom);
  }
  const anchors = anchorsOf(leftSlice, rightSlice);
  if (anchors.length === 0) {
    // Nothing unique to cut at — a long table whose cells all read alike. The
    // edit-script walk finds the few real changes without touching the bulk.
    const steps = myersSteps(leftSlice, rightSlice, leftFrom, rightFrom);
    if (steps !== null) return steps;
    return trimSteps(leftSlice, rightSlice, leftFrom, rightFrom);
  }
  const steps = [];
  let leftAt = 0;
  let rightAt = 0;
  // Append by loop: a spread of a whole table's steps overflows the stack.
  const append = (more) => {
    for (const step of more) steps.push(step);
  };
  for (const anchor of anchors) {
    append(alignWindow(left, right, leftFrom + leftAt, leftFrom + anchor.left, rightFrom + rightAt, rightFrom + anchor.right));
    steps.push({ op: 'equal', left: leftFrom + anchor.left, right: rightFrom + anchor.right });
    leftAt = anchor.left + 1;
    rightAt = anchor.right + 1;
  }
  append(alignWindow(left, right, leftFrom + leftAt, leftTo, rightFrom + rightAt, rightTo));
  return steps;
}

/**
 * Shared-prefix and shared-suffix trim with one replaced span in the middle.
 * @param left - the window's left tokens.
 * @param right - the window's right tokens.
 * @param leftFrom - absolute index of the window's first left token.
 * @param rightFrom - absolute index of the window's first right token.
 * @returns steps in reading order.
 */
function trimSteps(left, right, leftFrom, rightFrom) {
  const rows = left.length;
  const columns = right.length;
  const steps = [];
  let prefix = 0;
  while (prefix < rows && prefix < columns && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < rows - prefix
    && suffix < columns - prefix
    && left[rows - 1 - suffix] === right[columns - 1 - suffix]
  ) suffix += 1;
  for (let at = 0; at < prefix; at += 1) {
    steps.push({ op: 'equal', left: leftFrom + at, right: rightFrom + at });
  }
  for (let at = prefix; at < rows - suffix; at += 1) steps.push({ op: 'delete', left: leftFrom + at });
  for (let at = prefix; at < columns - suffix; at += 1) steps.push({ op: 'insert', right: rightFrom + at });
  for (let at = 0; at < suffix; at += 1) {
    steps.push({
      op: 'equal',
      left: leftFrom + rows - suffix + at,
      right: rightFrom + columns - suffix + at,
    });
  }
  return steps;
}

/**
 * The exact LCS walk, for a window that fits in the cell budget.
 * @param left - the window's left tokens.
 * @param right - the window's right tokens.
 * @param leftFrom - absolute index of the window's first left token.
 * @param rightFrom - absolute index of the window's first right token.
 * @returns steps in reading order.
 */
function alignTable(left, right, leftFrom, rightFrom) {
  const rows = left.length;
  const columns = right.length;
  const steps = [];
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
      steps.push({ op: 'equal', left: leftFrom + i, right: rightFrom + j });
      i += 1;
      j += 1;
    } else if (length[(i + 1) * width + j] >= length[i * width + j + 1]) {
      steps.push({ op: 'delete', left: leftFrom + i });
      i += 1;
    } else {
      steps.push({ op: 'insert', right: rightFrom + j });
      j += 1;
    }
  }
  while (i < rows) {
    steps.push({ op: 'delete', left: leftFrom + i });
    i += 1;
  }
  while (j < columns) {
    steps.push({ op: 'insert', right: rightFrom + j });
    j += 1;
  }
  return steps;
}

/**
 * Align two token lists, cutting at anchor tokens when the block is too big.
 *
 * @param left - the base side's tokens.
 * @param right - the working-tree side's tokens.
 * @returns steps `{ op, left?, right? }` in reading order, `op` one of
 *   `equal`, `delete`, `insert`.
 */
function align(left, right) {
  return alignWindow(left, right, 0, left.length, 0, right.length);
}

/**
 * Merge adjacent steps of the same kind into one segment.
 * @param segments - the segments built so far; the last one is extended.
 * @param kind - `equal`, `del`, or `ins`.
 * @param text - the text this step contributes.
 * @returns nothing; `segments` is updated in place.
 */
function push(segments, kind, text) {
  if (text === '') return;
  const last = segments[segments.length - 1];
  if (last !== undefined && last.kind === kind) {
    last.text += text;
    return;
  }
  segments.push({ kind, text });
}

/**
 * Compare two block texts and describe the difference as inline segments.
 *
 * The result is a presentation, not a patch: a change reads as its removals
 * followed by its insertions, so a rewritten clause shows the old words struck
 * through and the new ones marked, side by side, in the place they stand.
 *
 * Every segment contributes the *same* text to both sides when it is `equal`, and
 * only to its own side otherwise. `rangesOf` relies on that: it walks one offset
 * per side, so an `equal` segment carrying text that exists on one side only would
 * shift every later offset and paint the wrong words. Boundary whitespace is
 * therefore left inside the changed segment and trimmed where the range is built —
 * never re-labelled as shared text.
 *
 * @param before - the comparison base's block text.
 * @param after - the working tree's block text.
 * @returns segments `{ kind, text }` in reading order, `kind` one of `equal`,
 *   `del`, `ins`.
 */
export function diffInline(before, after) {
  const left = tokensOf(before);
  const right = tokensOf(after);
  const steps = align(left, right);
  const segments = [];

  // A run of deletions and insertions is emitted removals-first, which is how a
  // reader parses "this became that". The run is buffered so the two halves
  // cannot interleave and turn the sentence into word soup.
  let deletions = '';
  let insertions = '';
  const flush = () => {
    push(segments, 'del', deletions);
    push(segments, 'ins', insertions);
    deletions = '';
    insertions = '';
  };
  for (const step of steps) {
    if (step.op === 'equal') {
      flush();
      push(segments, 'equal', left[step.left]);
    } else if (step.op === 'delete') {
      deletions += left[step.left];
    } else {
      insertions += right[step.right];
    }
  }
  flush();
  return segments;
}

/**
 * Whether a segment list contains any change at all.
 * @param segments - segments from {@link diffInline}.
 * @returns true when at least one segment is marked.
 */
export function hasChange(segments) {
  return segments.some((segment) => segment.kind !== 'equal');
}

/**
 * Turn a segment list into offset ranges on one side's text.
 *
 * The renderer strips Markdown syntax before anything reaches the DOM, so the
 * offsets that matter are the ones into the *rendered* text. A caller therefore
 * hands in the two sides' text content, takes the segments back, and asks for
 * ranges here — no source-to-DOM mapping is needed anywhere.
 *
 * Whitespace at a range's edges is trimmed: a tinted space reads as a much larger
 * edit than it is, and it makes the paragraph look ragged where nothing moved.
 *
 * @param segments - segments from {@link diffInline}.
 * @param side - `del` for the comparison base, `ins` for the working tree.
 * @returns ranges `{ start, end }` in that side's text, in reading order.
 */
export function rangesOf(segments, side) {
  const ranges = [];
  let left = 0;
  let right = 0;
  for (const segment of segments) {
    const length = segment.text.length;
    if (segment.kind === 'equal') {
      left += length;
      right += length;
      continue;
    }
    if (segment.kind === 'del') {
      if (side === 'del') pushRange(ranges, segment.text, left);
      left += length;
      continue;
    }
    if (side === 'ins') pushRange(ranges, segment.text, right);
    right += length;
  }
  return ranges;
}

/**
 * Append one range, narrowed to its first and last non-space character.
 * @param ranges - the ranges built so far.
 * @param text - the segment's text.
 * @param start - the segment's offset in the side's text.
 * @returns nothing; `ranges` is updated in place.
 */
function pushRange(ranges, text, start) {
  const leading = /^\s*/u.exec(text)[0].length;
  const trailing = /\s*$/u.exec(text)[0].length;
  const end = text.length - trailing;
  if (end <= leading) return;
  ranges.push({ start: start + leading, end: start + end });
}
