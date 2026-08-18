import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreExtension, changeRecords } from '../src/background/inventory.js';
import { decodeBody, extractPromptText } from '../src/background/network-watch.js';

test('capability score tracks browser-driving power, not popularity', () => {
  const driver = scoreExtension({
    name: 'Web Copilot', permissions: ['debugger', 'tabs', 'scripting'],
    hostPermissions: ['<all_urls>'], installType: 'normal',
  });
  const benign = scoreExtension({ name: 'Dark Reader', permissions: ['storage'], hostPermissions: [], installType: 'normal' });
  assert.ok(driver.score > benign.score);
  assert.equal(driver.agentic, true);
  assert.equal(benign.agentic, false);
  assert.ok(driver.flags.includes('permission:debugger'));
  assert.ok(driver.flags.includes('host:all_urls'));
});

test('the debugger permission alone marks an extension agentic', () => {
  const res = scoreExtension({ name: 'Quiet Helper', permissions: ['debugger'], hostPermissions: [], installType: 'normal' });
  assert.equal(res.agentic, true);
});

test('unpacked and sideloaded installs are flagged', () => {
  assert.ok(scoreExtension({ name: 'x', permissions: [], hostPermissions: [], installType: 'development' }).flags.includes('install:unpacked'));
  assert.ok(scoreExtension({ name: 'x', permissions: [], hostPermissions: [], installType: 'sideload' }).flags.includes('install:sideloaded'));
});

test('inventory changes become audit payloads', () => {
  const [record] = changeRecords([
    { change: 'installed', ext: { id: 'abc', name: 'Agent', version: '1.0', capabilityScore: 80, flags: [], agentic: true, installType: 'normal' } },
  ]);
  assert.equal(record.decision, 'warn');
  assert.match(record.reason, /installed/);
  assert.equal(record.extension.id, 'abc');
});

test('request bodies decode from both raw bytes and form data', () => {
  const bytes = new TextEncoder().encode('{"prompt":"hi"}');
  assert.equal(decodeBody({ raw: [{ bytes: bytes.buffer }] }).text, '{"prompt":"hi"}');
  assert.equal(decodeBody({ formData: { q: ['hello'], r: ['a', 'b'] } }).text, 'q=hello&r=a,b');
  assert.equal(decodeBody(null).kind, 'none');
  assert.equal(decodeBody({}).kind, 'empty');
});

test('prompt text is pulled out of provider payload shapes', () => {
  const anthropic = JSON.stringify({
    model: 'claude', system: 'be helpful',
    messages: [{ role: 'user', content: 'my key is sk-ant-x' }],
  });
  const extracted = extractPromptText(anthropic);
  assert.ok(extracted.includes('be helpful'));
  assert.ok(extracted.includes('my key is sk-ant-x'));
  assert.equal(extracted.includes('claude'), false, 'model name is scaffolding, not prompt content');
});

test('gemini-style nested parts are extracted too', () => {
  const gemini = JSON.stringify({ contents: [{ parts: [{ text: 'secret 4111111111111111' }] }] });
  assert.ok(extractPromptText(gemini).includes('4111111111111111'));
});

test('non-JSON bodies fall back to a bounded sample', () => {
  const out = extractPromptText('x'.repeat(9000));
  assert.ok(out.length <= 4001);
});
