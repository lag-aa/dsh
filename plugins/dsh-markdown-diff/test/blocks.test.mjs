/**
 * Minimal runner: the sandbox refuses `node --test`'s piped stdio, so each
 * check is a plain function and the exit code carries the verdict.
 *
 *   node test/blocks.test.mjs
 */

import assert from 'node:assert/strict';

import { blockKey, splitMarkdown } from '../src/blocks.js';

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

test('splits a document into its block kinds', () => {
  const blocks = splitMarkdown([
    '# Title',
    '',
    'One paragraph',
    'over two lines.',
    '',
    '- first',
    '- second',
    '',
    '```js',
    'const a = 1;',
    '',
    'const b = 2;',
    '```',
    '',
    '| a | b |',
    '| - | - |',
    '| 1 | 2 |',
    '',
    '> quoted',
    '',
    '---',
    '',
    '<div>raw</div>',
  ].join('\n'));
  assert.deepEqual(blocks.map((block) => block.kind), [
    'heading',
    'paragraph',
    'list',
    'list',
    'code',
    'table',
    'quote',
    'rule',
    'html',
  ]);
});

test('keeps a blank line inside a fenced code block', () => {
  const blocks = splitMarkdown('```\na\n\nb\n```\n');
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'code');
  assert.equal(blocks[0].text, '```\na\n\nb\n```');
});

test('an unterminated fence runs to the end of the document', () => {
  const blocks = splitMarkdown('intro\n\n```\nstill code\n');
  assert.deepEqual(blocks.map((block) => block.kind), ['paragraph', 'code']);
  assert.equal(blocks[1].text, '```\nstill code');
});

test('a list item keeps its indented continuation', () => {
  const blocks = splitMarkdown('- item\n\n  continued\n\n  - nested\n\noutro\n');
  assert.deepEqual(blocks.map((block) => block.kind), ['list', 'paragraph']);
  assert.equal(blocks[0].text, '- item\n\n  continued\n\n  - nested');
});

test('a table needs a delimiter row to be a table', () => {
  const withDelimiter = splitMarkdown('| a |\n| - |\n| 1 |\n');
  assert.equal(withDelimiter[0].kind, 'table');
  const withoutDelimiter = splitMarkdown('a | b\n');
  assert.equal(withoutDelimiter[0].kind, 'paragraph');
});

test('a setext underline makes the line above a heading', () => {
  const blocks = splitMarkdown('Title\n=====\n\nbody\n');
  assert.deepEqual(blocks.map((block) => block.kind), ['heading', 'paragraph']);
  assert.equal(blocks[0].text, 'Title\n=====');
});

test('a leading frontmatter block is its own kind', () => {
  const blocks = splitMarkdown('---\ntitle: x\n---\n\n# Heading\n');
  assert.deepEqual(blocks.map((block) => block.kind), ['frontmatter', 'heading']);
  assert.equal(blocks[0].text, '---\ntitle: x\n---');
});

test('a trailing horizontal rule is not frontmatter', () => {
  const blocks = splitMarkdown('# Heading\n\n---\n');
  assert.deepEqual(blocks.map((block) => block.kind), ['heading', 'rule']);
});

test('line numbers cover the source without overlap', () => {
  const source = '# a\n\np1\n\n- l\n\n```\nc\n```\n';
  const blocks = splitMarkdown(source);
  for (let at = 1; at < blocks.length; at += 1) {
    assert.ok(blocks[at].start > blocks[at - 1].end, `block ${at} overlaps its predecessor`);
  }
  assert.equal(blocks[0].start, 0);
});

test('an empty document yields no blocks', () => {
  assert.deepEqual(splitMarkdown(''), []);
  assert.deepEqual(splitMarkdown('  \n\n \n'), []);
});

test('the comparison key ignores trailing spaces and line endings', () => {
  const crlf = blockKey({ text: 'text  \r\nmore  ' });
  const lf = blockKey({ text: 'text\nmore' });
  assert.equal(crlf, lf);
});

test('a heading that became a paragraph keeps the same key', () => {
  assert.equal(blockKey({ text: '## Same' }), '## Same');
  assert.notEqual(blockKey({ text: '## Same' }), blockKey({ text: 'Same' }));
});

console.log(`\n${String(passed)}/${String(passed + failed)} block checks passed`);
process.exitCode = failed === 0 ? 0 : 1;
