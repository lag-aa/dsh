/**
 * What a review comment says, and where in the file it says it.
 *
 * A comment leaves the preview as ordinary Markdown, because that is the only
 * thing the composer accepts: the draft is text, and the model on the other side
 * reads text. So the message has one shape, always the same — a blockquote whose
 * first line names the file and the lines it quotes, then the remark. Keeping the
 * wording here rather than inside the component is what lets the shape be tested
 * without a DOM.
 *
 * The line span is the harder half. The Markdown renderer draws parsed nodes and
 * keeps no source map, so a selection cannot be translated into lines by asking
 * the DOM. What can be done is the reverse lookup: the selection's text is
 * searched for in the block's own Markdown, and an exact single hit gives the
 * precise span. A selection the renderer rewrote (markup, entities, folded
 * whitespace) or one that occurs twice reports nothing, and the caller falls back
 * to the block's own range — one hint less precise, never a line that is wrong.
 *
 * @module dsh-markdown-diff/comments
 */

/**
 * The 1-based line number a character index sits on.
 * @param source - the text to count in.
 * @param index - a character offset.
 * @returns the line, counting from one.
 */
function lineAt(source, index) {
  let line = 1;
  for (let at = 0; at < index && at < source.length; at += 1) {
    if (source.charAt(at) === '\n') line += 1;
  }
  return line;
}

/**
 * Strip the differences a browser adds but a source file does not carry.
 * @param text - the text to normalize.
 * @returns the text with CRLF folded and one trailing newline dropped.
 */
export function normalizeText(text) {
  const value = String(text ?? '').replace(/\r\n?/gu, '\n');
  return value.endsWith('\n') ? value.slice(0, -1) : value;
}

/**
 * Map a selected text back to the source lines it was rendered from.
 *
 * Two rules keep the answer trustworthy. The search must hit exactly once: a
 * phrase that occurs twice cannot be told apart, and guessing would point the
 * reader at the wrong block. And the trailing newline is dropped first, because
 * a browser selection that ends on a line break reports one the source does not
 * have — without that, a selection covering a whole paragraph would never match.
 *
 * @param source - the block's Markdown, as `blocks.js` split it.
 * @param selected - the selection, as the DOM reports it.
 * @param firstLine - the 1-based source line `source` starts on.
 * @returns the `{ start, end }` span, or `undefined` when the text cannot be placed.
 */
export function linesOfSelection(source, selected, firstLine = 1) {
  if (typeof source !== 'string' || source === '') return undefined;
  const text = normalizeText(selected);
  if (text.trim() === '') return undefined;
  const at = source.indexOf(text);
  if (at === -1) return undefined;
  if (source.indexOf(text, at + 1) !== -1) return undefined;
  const start = firstLine + lineAt(source, at) - 1;
  const end = firstLine + lineAt(source, at + Math.max(text.length - 1, 0)) - 1;
  return { start, end };
}

/**
 * The line span of one side of a group, for a selection that cannot be placed.
 * @param blocks - the group's blocks on the side the selection sits in.
 * @returns the span, or `undefined` for an empty side.
 */
export function spanOf(blocks) {
  if (Array.isArray(blocks) === false || blocks.length === 0) return undefined;
  const first = blocks[0];
  const last = blocks[blocks.length - 1];
  const start = Number.isInteger(first?.start) ? first.start + 1 : undefined;
  const end = Number.isInteger(last?.end) ? last.end + 1 : undefined;
  if (start === undefined || end === undefined) return undefined;
  return { start, end };
}

/**
 * The line that says where the quotation comes from, as a reader cites it.
 *
 * The line numbers are optional on purpose. They are only useful when they index
 * the version the text lives in, and the two halves of a diff live in different
 * ones: a comment on the working tree cites the file on disk, a comment on a
 * removed or rewritten block cites lines that no longer exist there. The suffix
 * is what tells the model which of the two it is holding, so it must name the
 * version rather than the line span.
 *
 * @param path - the workspace-relative path of the file.
 * @param lines - the span, when it is known.
 * @param suffix - what to append, e.g. the marker of the comparison base.
 * @returns the address line, e.g. `docs/a.md:12-15 · старая версия`.
 */
export function addressOf(path, lines, suffix = '') {
  const name = String(path ?? '').replace(/\\/gu, '/');
  const where = lines === undefined
    ? ''
    : lines.end > lines.start ? `:${String(lines.start)}-${String(lines.end)}` : `:${String(lines.start)}`;
  return `${name}${where}${suffix}`;
}

/**
 * How much of a selection is worth quoting, in characters.
 *
 * Past this, the quotation is dropped and only the address travels: the composer
 * is a place to write, not a place to paste a chapter, and a comment that fills
 * the draft buries the remark under it. The address stays, which is what the model
 * needs to look the text up itself. The limit matches the sidebar's own
 * `SELECTION_LIMIT`, so both surfaces quote alike.
 */
export const SELECTION_LIMIT = 500;

/**
 * A text fenced as a code block, or an empty string when there is nothing (or too
 * much) to quote.
 *
 * A fence and not a blockquote, because the message has to be compact: no blank
 * line separates the address, the quotation and the remark. A blockquote would
 * swallow the remark line as a lazy continuation — CommonMark lets a paragraph
 * inside a quote continue on a line that has no `>` — so the reader's own words
 * would render inside the quotation they are about. A fenced block ends where its
 * closing fence is, whatever follows, and it also renders the quoted Markdown as
 * source: a quoted `## heading` or `**bold**` shows as written instead of being
 * styled, which is what a review of a Markdown file needs.
 *
 * @param selected - the selected text.
 * @returns the fenced quotation, or an empty string.
 */
export function fenceOf(selected) {
  // Only the trailing whitespace goes: leading spaces are indentation inside a
  // code block, and stripping them would change what the reader quoted.
  const text = normalizeText(selected).replace(/\s+$/u, '');
  if (text.trim() === '' || text.length > SELECTION_LIMIT) return '';
  // The outer fence must be longer than the longest run of backticks inside, or a
  // quotation of a code block would close its own quotation early.
  const longest = [...text.matchAll(/`+/gu)].reduce((size, match) => Math.max(size, match[0].length), 0);
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

/**
 * The whole message one comment puts into the draft.
 *
 * Always the same three parts, in this order and without blank lines between them,
 * so the same record reaches the model whether the reader commented on a line that
 * exists in the file or on one that was removed: the address, the quotation, the
 * remark behind its label. The label is what keeps the remark from being read as
 * part of the quotation; the single blank line after it is what keeps the next
 * comment out of this one, whatever the draft happens to end with.
 *
 * @param parts - the address line, the selected text, the remark, and its label.
 * @returns the Markdown to insert into the composer, ending with one newline.
 */
export function commentMessage(parts) {
  const address = String(parts?.address ?? '').trim();
  const block = fenceOf(parts?.quote);
  const remark = String(parts?.remark ?? '').trim();
  const label = String(parts?.remarkLabel ?? '').trim();
  const tail = remark === '' ? '' : label === '' ? remark : `**${label}** ${remark}`;
  const body = [address, block, tail].filter((part) => part !== '').join('\n');
  return body === '' ? '' : `${body}\n`;
}
