import test from 'node:test';
import assert from 'node:assert/strict';
import { urlMatches, hostMatches, deepMerge, stableStringify, redact, sample, clamp } from '../src/core/util.js';

test('hostMatches only matches on label boundaries', () => {
  assert.equal(hostMatches('a.b.example.com', 'example.com'), true);
  assert.equal(hostMatches('example.com', 'example.com'), true);
  assert.equal(hostMatches('evilexample.com', 'example.com'), false);
  assert.equal(hostMatches('example.com.attacker.net', 'example.com'), false);
});

test('urlMatches understands bare hosts, globs and regexes', () => {
  assert.equal(urlMatches('https://a.example.com/x', 'example.com'), true);
  assert.equal(urlMatches('https://example.com/admin/users', '*.example.com/admin/*'), true);
  assert.equal(urlMatches('https://sub.example.com/admin/users', '*.example.com/admin/*'), true);
  assert.equal(urlMatches('https://example.com/public', '*.example.com/admin/*'), false);
  assert.equal(urlMatches('http://example.com/a', 'https://example.com/*'), false);
  assert.equal(urlMatches('https://example.com/a?b=1', 'example.com/a*'), true);
  assert.equal(urlMatches('https://x.com/abc', 're:^https://x\\.com/a.c$'), true);
  assert.equal(urlMatches('https://anything/', '*'), true);
});

test('urlMatches survives malformed input instead of throwing', () => {
  assert.equal(urlMatches('not a url', 'example.com'), false);
  assert.equal(urlMatches('https://x.com', 're:([unclosed'), false);
  assert.equal(urlMatches('', 'example.com'), false);
  assert.equal(urlMatches('https://x.com', ''), false);
});

test('deepMerge replaces arrays and merges objects', () => {
  const merged = deepMerge({ a: { b: 1, c: 2 }, list: [1, 2] }, { a: { c: 3 }, list: [9] });
  assert.deepEqual(merged, { a: { b: 1, c: 3 }, list: [9] });
});

test('deepMerge does not mutate its inputs', () => {
  const base = { a: { b: 1 } };
  deepMerge(base, { a: { b: 2 } });
  assert.equal(base.a.b, 1);
});

test('stableStringify is key-order independent', () => {
  assert.equal(stableStringify({ b: 1, a: 2 }), stableStringify({ a: 2, b: 1 }));
  assert.notEqual(stableStringify({ a: 1 }), stableStringify({ a: 2 }));
});

test('redact keeps a prefix and hides the rest', () => {
  assert.equal(redact('abcdefghij').startsWith('abcd'), true);
  assert.equal(redact('abcdefghij').includes('efghij'), false);
  assert.equal(redact('ab'), '**');
});

test('sample collapses whitespace and truncates', () => {
  assert.equal(sample('  a\n\n b  '), 'a b');
  assert.equal(sample('x'.repeat(300), 10).length, 11); // 10 chars + ellipsis
});

test('clamp bounds values', () => {
  assert.equal(clamp(5, 0, 1), 1);
  assert.equal(clamp(-5, 0, 1), 0);
});
