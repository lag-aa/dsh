/**
 * Checks for the two pure helpers the browser half carries: the file address
 * parser and the image resolver. Both are copies of private sidebar behaviour, so
 * they are tested against the grammar the sidebar actually produces.
 *
 *   node test/address.test.mjs
 */

import assert from 'node:assert/strict';

import { parseAddress, resolveImage } from '../src/MarkdownDiffBody.js';

let passed = 0;
let failed = 0;

/** Run one check and report it. */
function test(name, body) {
  try {
    body();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}`);
    console.log(`     ${error.message}`);
  }
}

// The address helpers are the only part of the body that can be exercised without
// a DOM, so the module is loaded with the bare minimum it reads at import time.
test('a session file address splits into session and path', () => {
  assert.deepEqual(parseAddress('dsh-resource://file/session/s-7/docs/notes.md'), {
    sessionId: 's-7',
    path: 'docs/notes.md',
  });
});

test('an encoded path segment is decoded', () => {
  assert.deepEqual(parseAddress('dsh-resource://file/session/s-7/docs/a%20b/%D1%82.md'), {
    sessionId: 's-7',
    path: 'docs/a b/т.md',
  });
});

test('a query suffix is not part of the path', () => {
  assert.deepEqual(parseAddress('dsh-resource://file/session/s-7/notes.md?line=3'), {
    sessionId: 's-7',
    path: 'notes.md',
  });
});

test('a fragment suffix is not part of the path', () => {
  assert.deepEqual(parseAddress('dsh-resource://file/session/s-7/notes.md#anchor'), {
    sessionId: 's-7',
    path: 'notes.md',
  });
});

test('a non-session address is refused', () => {
  assert.equal(parseAddress('dsh-resource://file/workspace/notes.md'), undefined);
});

test('an address without a path is refused', () => {
  assert.equal(parseAddress('dsh-resource://file/session/s-7/'), undefined);
  assert.equal(parseAddress('dsh-resource://file/session/s-7'), undefined);
});

test('an address without a session id is refused', () => {
  assert.equal(parseAddress('dsh-resource://file/session//notes.md'), undefined);
});

test('a malformed percent escape is refused rather than thrown', () => {
  assert.equal(parseAddress('dsh-resource://file/session/s-7/%E0%A4%A'), undefined);
});

test('a relative destination resolves beside the previewed file', () => {
  assert.equal(
    resolveImage('http://127.0.0.1:59283/', '/w/docs/notes.md', 'img/a.png'),
    'http://127.0.0.1:59283/api/file?path=%2Fw%2Fdocs%2Fimg%2Fa.png',
  );
});

test('a destination above the document keeps its traversal', () => {
  assert.equal(
    resolveImage('http://127.0.0.1:59283/', '/w/docs/notes.md', '../img/a.png'),
    'http://127.0.0.1:59283/api/file?path=%2Fw%2Fdocs%2F..%2Fimg%2Fa.png',
  );
});

test('an absolute destination is used as written', () => {
  assert.equal(
    resolveImage('http://127.0.0.1:59283/', '/w/docs/notes.md', '/w/img/a.png'),
    'http://127.0.0.1:59283/api/file?path=%2Fw%2Fimg%2Fa.png',
  );
});

test('a query on a relative destination is dropped', () => {
  assert.equal(
    resolveImage('http://127.0.0.1:59283/', '/w/n.md', 'a.png?v=2'),
    'http://127.0.0.1:59283/api/file?path=%2Fw%2Fa.png',
  );
});

test('an http destination is left to the browser', () => {
  assert.equal(resolveImage('http://127.0.0.1:59283/', '/w/n.md', 'https://e.test/a.png'), undefined);
});

test('a relative destination with no document path is refused', () => {
  assert.equal(resolveImage('http://127.0.0.1:59283/', undefined, 'a.png'), undefined);
});

test('a non-http base resolves nothing', () => {
  assert.equal(resolveImage('file:///tmp/', '/w/n.md', 'a.png'), undefined);
});

console.log(`\n${String(passed)}/${String(passed + failed)} address checks passed`);
process.exitCode = failed === 0 ? 0 : 1;
