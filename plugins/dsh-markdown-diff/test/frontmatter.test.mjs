/**
 * Checks for the frontmatter property reader.
 *
 *   node test/frontmatter.test.mjs
 */

import assert from 'node:assert/strict';

import { parseProperties, shapeOf } from '../src/frontmatter.js';

let passed = 0;
let failed = 0;

/**
 * Run one named check.
 * @param name - what the check proves.
 * @param body - the assertions.
 */
function test(name, body) {
  try {
    body();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${error.message.split('\n')[0]}`);
  }
}

test('reads flat scalars, dropping the delimiters', () => {
  const entries = parseProperties(['---', 'id: 1000000001', 'space_name: Sample', '---'].join('\n'));
  assert.deepEqual(entries, [
    { key: 'id', kind: 'scalar', value: '1000000001' },
    { key: 'space_name', kind: 'scalar', value: 'Sample' },
  ]);
});

test('unquotes a quoted scalar and keeps a colon inside it', () => {
  const entries = parseProperties([
    '---',
    `modified_at: '2026-10-14T15:40:49.000+03:00'`,
    'note: "a: b"',
    '---',
  ].join('\n'));
  assert.deepEqual(entries, [
    { key: 'modified_at', kind: 'scalar', value: '2026-10-14T15:40:49.000+03:00' },
    { key: 'note', kind: 'scalar', value: 'a: b' },
  ]);
});

test('keeps a hash that belongs to a URL instead of a comment', () => {
  const entries = parseProperties(['---', 'url: https://example.test/page#anchor', '---'].join('\n'));
  assert.equal(entries[0].value, 'https://example.test/page#anchor');
});

test('drops a trailing comment from an unquoted scalar', () => {
  const entries = parseProperties(['---', 'id: 12 # the page id', '---'].join('\n'));
  assert.equal(entries[0].value, '12');
});

test('reads a block list of maps one level deep', () => {
  const entries = parseProperties([
    '---',
    'breadcrumbs:',
    '  - title: Рабочая группа',
    '    url: https://example.test/a',
    '  - title: CR 2026',
    '    url: https://confluence.example.test/display/SPACE/CR+2026',
    '---',
  ].join('\n'));
  assert.deepEqual(entries, [
    {
      key: 'breadcrumbs',
      kind: 'list',
      items: [
        { kind: 'map', entries: [{ key: 'title', kind: 'scalar', value: 'Рабочая группа' }, { key: 'url', kind: 'scalar', value: 'https://example.test/a' }] },
        { kind: 'map', entries: [{ key: 'title', kind: 'scalar', value: 'CR 2026' }, { key: 'url', kind: 'scalar', value: 'https://confluence.example.test/display/SPACE/CR+2026' }] },
      ],
    },
  ]);
});

test('reads a block list of scalars', () => {
  const entries = parseProperties(['---', 'tags:', '  - alpha', '  - beta', '---'].join('\n'));
  assert.deepEqual(entries[0], {
    key: 'tags',
    kind: 'list',
    items: [
      { kind: 'scalar', value: 'alpha' },
      { kind: 'scalar', value: 'beta' },
    ],
  });
});

test('reads a flow list', () => {
  const entries = parseProperties(['---', 'tags: [alpha, beta]', '---'].join('\n'));
  assert.deepEqual(entries[0], {
    key: 'tags',
    kind: 'list',
    items: [
      { kind: 'scalar', value: 'alpha' },
      { kind: 'scalar', value: 'beta' },
    ],
  });
});

test('reads a nested map', () => {
  const entries = parseProperties(['---', 'owner:', '  name: Анна', '  team: AI', '---'].join('\n'));
  assert.deepEqual(entries[0], {
    key: 'owner',
    kind: 'map',
    entries: [
      { key: 'name', kind: 'scalar', value: 'Анна' },
      { key: 'team', kind: 'scalar', value: 'AI' },
    ],
  });
});

test('keeps a key whose value is empty', () => {
  const entries = parseProperties(['---', 'empty:', '---'].join('\n'));
  assert.deepEqual(entries, [{ key: 'empty', kind: 'scalar', value: '' }]);
});

test('skips blank lines and whole-line comments', () => {
  const entries = parseProperties(['---', '# a header comment', '', 'id: 1', '', '---'].join('\n'));
  assert.deepEqual(entries, [{ key: 'id', kind: 'scalar', value: '1' }]);
});

test('returns an empty list for an empty header', () => {
  assert.deepEqual(parseProperties(['---', '---'].join('\n')), []);
});

test('accepts the dot terminator', () => {
  assert.deepEqual(parseProperties(['---', 'id: 1', '...'].join('\n')), [
    { key: 'id', kind: 'scalar', value: '1' },
  ]);
});

test('tolerates CRLF and a BOM', () => {
  const text = ['\uFEFF---', 'id: 1', '---'].join('\r\n');
  assert.deepEqual(parseProperties(text), [{ key: 'id', kind: 'scalar', value: '1' }]);
});

// A block scalar is folded rather than refused, so both halves of a modified
// group carry the same text and the word-level marking stays aligned.
test('folds a literal block scalar, keeping its line breaks', () => {
  const entries = parseProperties(['---', 'body: |', '  one', '  two', 'id: 1', '---'].join('\n'));
  assert.deepEqual(entries, [
    { key: 'body', kind: 'scalar', value: 'one\ntwo' },
    { key: 'id', kind: 'scalar', value: '1' },
  ]);
});

test('folds a folded block scalar onto one line', () => {
  const entries = parseProperties(['---', 'note: >', '  one', '  two', '---'].join('\n'));
  assert.deepEqual(entries, [{ key: 'note', kind: 'scalar', value: 'one two' }]);
});

test('strips the common indent a block scalar carries', () => {
  const entries = parseProperties(['---', 'body: |', '    deep', '      deeper', '---'].join('\n'));
  assert.deepEqual(entries, [{ key: 'body', kind: 'scalar', value: 'deep\n  deeper' }]);
});

test('refuses an unclosed block', () => {
  assert.equal(parseProperties(['---', 'id: 1'].join('\n')), null);
});

test('refuses a block that does not start with a delimiter', () => {
  assert.equal(parseProperties(['id: 1', '---'].join('\n')), null);
});

test('refuses an infeasible indentation instead of guessing', () => {
  // The second key is deeper than the first with no parent to belong to.
  assert.equal(parseProperties(['---', 'id: 1', '  stray: 2', '---'].join('\n')), null);
});

test('refuses a tab-indented line', () => {
  assert.equal(parseProperties(['---', 'owner:', '\tname: a', '---'].join('\n')), null);
});

test('refuses a document with no keys at all', () => {
  assert.equal(parseProperties(['---', 'just a line', '---'].join('\n')), null);
});

test('names the shapes worth setting apart', () => {
  assert.equal(shapeOf('https://confluence.example.test/pages/viewpage.action?pageId=1'), 'url');
  assert.equal(shapeOf('2026-10-14T15:40:49.000+03:00'), 'date');
  assert.equal(shapeOf('2026-10-14'), 'date');
  assert.equal(shapeOf('1000000001'), 'number');
  assert.equal(shapeOf('true'), 'flag');
  assert.equal(shapeOf('null'), 'flag');
  assert.equal(shapeOf('Sample'), '');
  assert.equal(shapeOf(''), '');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
