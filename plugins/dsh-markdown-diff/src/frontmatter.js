/**
 * Read the leading YAML frontmatter block as a small property model.
 *
 * The block is metadata, and a preview that echoes it as source makes the reader
 * parse YAML by eye. It is also not dense: the files this previews carry a dozen
 * keys, several of them long URLs and dates. So the block is turned into
 * key/value rows instead, which is what Obsidian and the shipped previews do with
 * it.
 *
 * This is deliberately not a YAML parser. It understands the shapes that actually
 * occur in a document header — scalars, quoted scalars, block and flow lists,
 * one level of nesting, lists of maps — and reports `null` for anything else,
 * including anchors, tags, multi-line block scalars, and malformed indentation.
 * The caller then falls back to the verbatim block, so an unparsed header is
 * shown as it is written rather than mangled or dropped.
 *
 * @module dsh-markdown-diff/frontmatter
 */

/** How deep a header may nest before the block is left to the fallback. */
const MAX_DEPTH = 5;

/** The most properties worth drawing; a longer header is suspicious, not a header. */
const MAX_ENTRIES = 200;

/**
 * Remove one layer of matching quotes.
 * @param text - a scalar as written.
 * @returns the scalar without its quotes.
 */
function unquote(text) {
  const trimmed = text.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/**
 * Read a scalar value, taking an inline comment off an unquoted one.
 *
 * `#` inside a quoted scalar is part of the value, and inside a URL it is common
 * enough (`.../page#anchor`) that only a comment marker after whitespace counts.
 *
 * @param raw - everything after the colon.
 * @returns the scalar node, or a flow list when the value is bracketed.
 */
function scalarOf(raw) {
  const text = String(raw ?? '').trim();
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim();
    const items = inner === '' ? [] : inner.split(',').map((part) => ({
      kind: 'scalar',
      value: unquote(part),
    }));
    return { kind: 'list', items };
  }
  const quoted = text.startsWith('"') || text.startsWith("'");
  const value = quoted ? unquote(text) : unquote(stripComment(text));
  return { kind: 'scalar', value };
}

/**
 * Drop a trailing ` # comment` from an unquoted scalar.
 * @param text - the raw scalar.
 * @returns the scalar without the comment.
 */
function stripComment(text) {
  const at = text.search(/\s#/u);
  return at === -1 ? text : text.slice(0, at);
}

/**
 * Read a block scalar's continuation lines into one value.
 *
 * `|` keeps the line breaks, `>` folds them into spaces; both drop the trailing
 * newline the YAML spec would keep, because a preview has no use for it. The
 * indentation of the least indented line is removed, which is how the block's own
 * structure is meant to be read.
 *
 * @param lines - the block's lines, the marker line already consumed.
 * @param from - the first line that may belong to the block.
 * @param base - the key's column, which ends the block.
 * @returns `{ value, next }`.
 */
function blockScalarOf(lines, from, base) {
  let end = from;
  while (end < lines.length) {
    const line = lines[end];
    if (line.trim() === '') {
      end += 1;
      continue;
    }
    if (indentOf(line) <= base) break;
    end += 1;
  }
  const body = lines.slice(from, end);
  while (body.length > 0 && body[body.length - 1].trim() === '') body.pop();
  const widths = body.filter((line) => line.trim() !== '').map((line) => indentOf(line));
  const common = widths.length === 0 ? 0 : Math.min(...widths);
  return { body: body.map((line) => line.slice(common)), next: end };
}

/**
 * Fold a block scalar's lines into its value.
 * @param body - the unindented lines.
 * @param marker - the `|` or `>` marker, with any chomping indicator.
 * @returns the scalar's text.
 */
function foldBlockScalar(body, marker) {
  if (marker.startsWith('|')) return body.join('\n').replace(/\n+$/u, '');
  return body.join('\n').replace(/\n+$/u, '').replace(/\n+/gu, ' ').trim();
}

/**
 * Count the leading spaces of a line.
 * @param line - one source line.
 * @returns the indent width.
 */
function indentOf(line) {
  return line.length - line.trimStart().length;
}

/**
 * Whether a line carries no content: blank, or a whole-line comment.
 * @param line - one source line.
 * @returns true when the parser should skip it.
 */
function isNoise(line) {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('#');
}

/**
 * The first line at or after `from` that carries content.
 * @param lines - the header's lines, without the delimiters.
 * @param from - where to start looking.
 * @returns that line's index, or the array length when there is none.
 */
function nextContent(lines, from) {
  let at = from;
  while (at < lines.length && isNoise(lines[at])) at += 1;
  return at;
}

/**
 * Parse the body of one list item into either a scalar or a map.
 *
 * A `- title: X` item continues on the following, more indented lines, so those
 * lines are re-based onto the item's own column and handed to {@link parseMap}.
 * That keeps one indentation rule for both shapes instead of two.
 *
 * @param content - the item's text after the dash.
 * @param tail - the item's continuation lines, already collected.
 * @param column - the column the item's content starts at.
 * @param depth - the current nesting depth.
 * @returns the item node, or null when the shape is unsupported.
 */
function itemOf(content, tail, column, depth) {
  const mapLike = /^[^\s:][^:]*:(\s|$)/u.test(content);
  if (mapLike === false) {
    if (tail.length > 0) return null;
    const nested = /^-\s/u.test(content);
    return nested ? null : scalarOf(content);
  }
  const rebased = [' '.repeat(column) + content, ...tail];
  const map = parseMap(rebased, 0, column, depth + 1);
  if (map === null) return null;
  return { kind: 'map', entries: map.entries };
}

/**
 * Parse a list whose items sit at `base`.
 *
 * @param lines - the header's lines, without the delimiters.
 * @param start - the first item's index.
 * @param base - the column the dashes sit at.
 * @param depth - the current nesting depth.
 * @returns `{ items, next }`, or null when the shape is unsupported.
 */
function parseList(lines, start, base, depth) {
  if (depth > MAX_DEPTH) return null;
  const items = [];
  let at = start;
  while (at < lines.length) {
    const line = lines[at];
    if (isNoise(line)) {
      at += 1;
      continue;
    }
    const indent = indentOf(line);
    if (indent < base) break;
    if (indent > base || /^\s*-(\s|$)/u.test(line) === false) return null;
    // The item's own text starts after the dash and its spacing; that column is
    // the base its continuation lines are re-based onto.
    const afterDash = line.slice(indent + 1);
    const content = afterDash.trimStart();
    const column = indent + 1 + (afterDash.length - content.length);
    // The item's continuation lines are the following more-indented ones.
    let end = at + 1;
    while (end < lines.length) {
      const next = lines[end];
      if (isNoise(next)) {
        // A blank line does not end the item, but a following line at the list's
        // own indent does: the loop below stops on it anyway.
        end += 1;
        continue;
      }
      if (indentOf(next) <= base) break;
      end += 1;
    }
    const tail = lines.slice(at + 1, end).filter((entry) => isNoise(entry) === false);
    const item = itemOf(content, tail, column, depth);
    if (item === null) return null;
    items.push(item);
    at = end;
    if (items.length > MAX_ENTRIES) return null;
  }
  return { items, next: at };
}

/**
 * Parse a mapping whose keys sit at `base`.
 *
 * @param lines - the header's lines, without the delimiters.
 * @param start - where to start reading.
 * @param base - the column this mapping's keys sit at.
 * @param depth - the current nesting depth.
 * @returns `{ entries, next }`, or null when the shape is unsupported.
 */
function parseMap(lines, start, base, depth) {
  if (depth > MAX_DEPTH) return null;
  const entries = [];
  let at = start;
  while (at < lines.length) {
    const line = lines[at];
    if (isNoise(line)) {
      at += 1;
      continue;
    }
    const indent = indentOf(line);
    if (indent < base) break;
    if (indent > base) return null;
    if (/^-(\s|$)/u.test(line.trim()) === true) break;
    const match = /^([^\s:][^:]*):(?:[ \t]+(.*))?$/u.exec(line.slice(indent));
    if (match === null) return null;
    const key = match[1].trim();
    const rest = match[2];
    at += 1;
    if (rest !== undefined && rest.trim() !== '') {
      // A block scalar keeps its content on the following lines. Folding it here
      // rather than refusing the header matters: a half-folded pair would compare
      // different text and mis-mark the changed words.
      if (/^[|>][-+]?$/u.test(rest.trim()) === true) {
        const scalar = blockScalarOf(lines, at, base);
        entries.push({ key, kind: 'scalar', value: foldBlockScalar(scalar.body, rest.trim()) });
        at = scalar.next;
      } else {
        entries.push({ key, ...scalarOf(rest) });
      }
    } else {
      const ahead = nextContent(lines, at);
      if (ahead < lines.length && indentOf(lines[ahead]) > base) {
        const childBase = indentOf(lines[ahead]);
        if (/^-(\s|$)/u.test(lines[ahead].trim()) === true) {
          const list = parseList(lines, ahead, childBase, depth + 1);
          if (list === null) return null;
          entries.push({ key, kind: 'list', items: list.items });
          at = list.next;
        } else {
          const map = parseMap(lines, ahead, childBase, depth + 1);
          if (map === null) return null;
          entries.push({ key, kind: 'map', entries: map.entries });
          at = map.next;
        }
      } else {
        entries.push({ key, kind: 'scalar', value: '' });
      }
    }
    if (entries.length > MAX_ENTRIES) return null;
  }
  return { entries, next: at };
}

/**
 * Read a frontmatter block into property rows.
 *
 * @param source - the block's text, delimiters included.
 * @returns the property entries, or null when the block is not one this reader
 *   understands. An empty header returns an empty list.
 */
export function parseProperties(source) {
  const lines = String(source ?? '').replace(/\r?\n$/u, '').split(/\r?\n/u);
  if (lines.length < 2) return null;
  const first = lines[0].replace(/^\uFEFF/u, '').trim();
  if (first !== '---') return null;
  const last = lines[lines.length - 1].trim();
  if (last !== '---' && last !== '...') return null;
  const body = lines.slice(1, -1);
  // A header is a mapping; a tab-indented line would make this reader guess at
  // its width, and a document that uses one is better shown verbatim.
  if (body.some((line) => /^\t/u.test(line))) return null;
  const parsed = parseMap(body, 0, 0, 0);
  if (parsed === null) return null;
  return parsed.entries;
}

/**
 * How a scalar should be presented.
 *
 * URLs and dates are the two shapes that dominate a document header and look
 * wrong in body type: a URL wants a monospace run it can be copied from, a
 * timestamp wants tabular figures. Everything else stays body text.
 *
 * @param value - the scalar's text.
 * @returns a class suffix, or an empty string.
 */
export function shapeOf(value) {
  const text = String(value ?? '');
  if (/^[a-z][a-z0-9+.-]*:\/\/\S+$/iu.test(text) === true) return 'url';
  if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/u.test(text) === true) return 'date';
  if (/^(?:true|false|null|~)$/iu.test(text) === true) return 'flag';
  if (/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/iu.test(text) === true) return 'number';
  return '';
}

/**
 * The number of leaf values in a property list, for the header's hint.
 * @param entries - parsed property entries.
 * @returns how many values the block holds.
 */
export function propertyCount(entries) {
  return entries.length;
}
