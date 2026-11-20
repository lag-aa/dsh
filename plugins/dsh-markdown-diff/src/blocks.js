/**
 * Split a Markdown document into its top-level blocks.
 *
 * The preview renders Markdown through `primitives.MarkdownText`, which hands
 * back HTML and keeps no source-line map, so a change cannot be anchored to a
 * line. What it can be anchored to is a block: a heading, a paragraph, a list
 * item, a fenced code block, a table, a quote, a rule, an HTML run, or the
 * leading frontmatter. Splitting first and comparing second is what makes the
 * highlight possible at all, at the cost of marking a whole paragraph changed
 * when one word inside it changed.
 *
 * The splitter is deliberately shallow: it never parses inline syntax and never
 * nests containers, so a list item keeps its children inline in the same block.
 *
 * @module dsh-markdown-diff/blocks
 */

/** An opening code fence: three or more backticks or tildes, up to three spaces in. */
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** An ATX heading. */
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+|$)/;

/** A thematic break: three or more of the same marker, spaces allowed between. */
const HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;

/** A block quote line. */
const QUOTE = /^ {0,3}>/;

/** A list item marker with its indentation and the space that follows it. */
const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)/;

/** The delimiter row of a Markdown table. */
const TABLE_DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/** A setext heading underline. */
const SETEXT = /^ {0,3}(?:=+|-+)[ \t]*$/;

/** The opening line of an HTML block. */
const HTML_START = /^ {0,3}<(?:[a-zA-Z][\w:-]*|!--|\/[a-zA-Z])/;

/** Leading YAML frontmatter, the same shape the builtin Markdown body splits off. */
const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)??(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/u;

/** Block kinds this splitter reports. */
export const BLOCK_KINDS = Object.freeze([
  'frontmatter',
  'heading',
  'paragraph',
  'list',
  'code',
  'table',
  'quote',
  'rule',
  'html',
]);

/**
 * Count the leading spaces of a line, counting a tab as four.
 * @param line - one source line.
 * @returns the visual indent width.
 */
function indentOf(line) {
  let width = 0;
  for (const char of line) {
    if (char === ' ') width += 1;
    else if (char === '\t') width += 4;
    else break;
  }
  return width;
}

/**
 * Build the block record.
 * @param kind - one of `BLOCK_KINDS`.
 * @param lines - the source lines the block covers, verbatim.
 * @param start - the block's first line index.
 * @returns the block.
 */
function makeBlock(kind, lines, start) {
  return {
    kind,
    text: lines.join('\n'),
    start,
    end: start + lines.length - 1,
  };
}

/**
 * Find the end of a fenced code block.
 * @param lines - all source lines.
 * @param start - the opening fence's line index.
 * @param fence - the opening fence run.
 * @returns the index of the closing line, or the last line when unterminated.
 */
function fenceEnd(lines, start, fence) {
  const marker = fence[0];
  for (let at = start + 1; at < lines.length; at += 1) {
    const trimmed = lines[at].trim();
    if (trimmed.startsWith(marker.repeat(fence.length)) && /^(`{3,}|~{3,})$/.test(trimmed)) return at;
  }
  // Unterminated: the run ends at the last line that carries content, so a
  // trailing newline does not become an empty line inside the code block.
  let last = lines.length - 1;
  while (last > start && lines[last] === '') last -= 1;
  return last;
}

/**
 * Find the end of a list item, including its continuation and nested lines.
 * @param lines - all source lines.
 * @param start - the item marker's line index.
 * @param indent - the marker's own indent width.
 * @returns the index of the item's last line.
 */
function listItemEnd(lines, start, indent) {
  let at = start + 1;
  while (at < lines.length) {
    const line = lines[at];
    if (line.trim() === '') {
      // A blank line continues the item only when an indented line follows it.
      let next = at + 1;
      while (next < lines.length && lines[next].trim() === '') next += 1;
      if (next >= lines.length || indentOf(lines[next]) <= indent) return at - 1;
      at = next;
      continue;
    }
    if (indentOf(line) <= indent) return at - 1;
    at += 1;
  }
  return lines.length - 1;
}

/**
 * Find the end of a table: the header line plus a run of non-blank lines.
 * @param lines - all source lines.
 * @param start - the header line index.
 * @returns the index of the table's last line.
 */
function tableEnd(lines, start) {
  let at = start + 1;
  while (at < lines.length && lines[at].trim() !== '') at += 1;
  return at - 1;
}

/**
 * Find the end of a block quote run.
 * @param lines - all source lines.
 * @param start - the first quoted line.
 * @returns the index of the run's last line.
 */
function quoteEnd(lines, start) {
  let at = start + 1;
  while (at < lines.length && (QUOTE.test(lines[at]) || (lines[at].trim() === '' && QUOTE.test(lines[at + 1] ?? '')))) at += 1;
  return at - 1;
}

/**
 * Find the end of an HTML run: non-blank lines from the opening tag on.
 * @param lines - all source lines.
 * @param start - the opening line index.
 * @returns the index of the run's last line.
 */
function htmlEnd(lines, start) {
  let at = start + 1;
  while (at < lines.length && lines[at].trim() !== '') at += 1;
  return at - 1;
}

/**
 * Find the end of a paragraph, which is where the next block starts.
 * @param lines - all source lines.
 * @param start - the paragraph's first line.
 * @returns the index of the paragraph's last line.
 */
function paragraphEnd(lines, start) {
  let at = start + 1;
  while (at < lines.length) {
    const line = lines[at];
    if (line.trim() === '') return at - 1;
    if (isBlockStart(lines, at)) return at - 1;
    at += 1;
  }
  return lines.length - 1;
}

/**
 * Whether the line opens a block of its own, which ends a paragraph above it.
 * @param lines - all source lines.
 * @param at - the line index to test.
 * @returns true when a new block starts here.
 */
function isBlockStart(lines, at) {
  const line = lines[at];
  if (FENCE.test(line) || ATX.test(line) || HR.test(line) || QUOTE.test(line) || LIST_ITEM.test(line)) return true;
  if (HTML_START.test(line)) return true;
  if (SETEXT.test(lines[at + 1] ?? '')) return true;
  if (line.includes('|') && TABLE_DELIM.test(lines[at + 1] ?? '')) return true;
  return false;
}

/**
 * Split Markdown source into blocks.
 *
 * Adjacent blocks never overlap and never lose a line: joining every block's
 * `text` with a blank line reproduces the document's content, and blank lines
 * between blocks are dropped as separators.
 *
 * @param text - the Markdown source, with or without a BOM.
 * @returns the blocks in document order; empty text yields no blocks.
 */
export function splitMarkdown(text) {
  const source = String(text ?? '');
  const blocks = [];
  const frontmatter = FRONTMATTER.exec(source);
  let offset = 0;
  if (frontmatter !== null) {
    const lines = frontmatter[0].replace(/\r?\n$/, '').split(/\r?\n/);
    blocks.push(makeBlock('frontmatter', lines, 0));
    offset = frontmatter[0].split(/\r?\n/).length;
  }
  const lines = source.split(/\r?\n/);
  let at = offset;
  while (at < lines.length) {
    const line = lines[at];
    if (line.trim() === '') {
      at += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const end = fenceEnd(lines, at, fence[1]);
      blocks.push(makeBlock('code', lines.slice(at, end + 1), at));
      at = end + 1;
      continue;
    }
    if (ATX.test(line)) {
      blocks.push(makeBlock('heading', [line], at));
      at += 1;
      continue;
    }
    // A line underlined by `===` or `---` is a setext heading; the underline is
    // itself a thematic break, so this test has to come before the paragraph.
    if (SETEXT.test(lines[at + 1] ?? '') && !HR.test(line)) {
      blocks.push(makeBlock('heading', [line, lines[at + 1]], at));
      at += 2;
      continue;
    }
    if (HR.test(line)) {
      blocks.push(makeBlock('rule', [line], at));
      at += 1;
      continue;
    }
    if (QUOTE.test(line)) {
      const end = quoteEnd(lines, at);
      blocks.push(makeBlock('quote', lines.slice(at, end + 1), at));
      at = end + 1;
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const indent = indentOf(line);
      const end = listItemEnd(lines, at, indent);
      blocks.push(makeBlock('list', lines.slice(at, end + 1), at));
      at = end + 1;
      continue;
    }
    if (line.includes('|') && TABLE_DELIM.test(lines[at + 1] ?? '')) {
      const end = tableEnd(lines, at);
      blocks.push(makeBlock('table', lines.slice(at, end + 1), at));
      at = end + 1;
      continue;
    }
    if (HTML_START.test(line)) {
      const end = htmlEnd(lines, at);
      blocks.push(makeBlock('html', lines.slice(at, end + 1), at));
      at = end + 1;
      continue;
    }
    const end = paragraphEnd(lines, at);
    blocks.push(makeBlock('paragraph', lines.slice(at, end + 1), at));
    at = end + 1;
  }
  return blocks;
}

/**
 * The text a block is compared on.
 *
 * Trailing spaces are dropped and line endings normalized so a reformat that
 * changes no wording is not reported as a change. The kind is not part of the
 * key: a paragraph that became a heading still reads as an edit of the same
 * words, and the renderer shows it in its new form.
 *
 * @param block - one split block.
 * @returns the comparison key.
 */
export function blockKey(block) {
  return block.text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .trim();
}
