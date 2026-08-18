import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLog, memoryStore, toCsv } from '../src/core/audit-log.js';
import { STORE } from '../src/core/constants.js';

const event = (i) => ({
  type: 'element.click',
  decision: i % 2 ? 'block' : 'allow',
  reason: `event ${i}`,
  url: `https://example.com/${i}`,
  actor: { kind: 'agent', confidence: 0.8 },
  risk: { score: i, band: 'low' },
});

async function seed(count, opts = {}) {
  const store = memoryStore();
  const log = new AuditLog({ store, ...opts });
  for (let i = 0; i < count; i += 1) await log.append(event(i));
  return { store, log };
}

test('records are sealed into a verifiable chain', async () => {
  const { log } = await seed(5);
  const result = await log.verify();
  assert.deepEqual(result, { ok: true, checked: 5, brokenAt: null, reason: null });
});

test('editing a record breaks verification at that record', async () => {
  const { store, log } = await seed(5);
  const chunk = store._raw[`${STORE.AUDIT_CHUNK_PREFIX}1`];
  chunk[2].url = 'https://tampered.example.com';
  const result = await log.verify();
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt, 3);
  assert.match(result.reason, /edited/);
});

test('deleting a record breaks the chain link', async () => {
  const { store, log } = await seed(5);
  const key = `${STORE.AUDIT_CHUNK_PREFIX}1`;
  store._raw[key].splice(2, 1);
  const result = await log.verify();
  assert.equal(result.ok, false);
  assert.match(result.reason, /removed or reordered/);
});

test('concurrent appends do not fork the chain', async () => {
  const store = memoryStore();
  const log = new AuditLog({ store });
  await Promise.all(Array.from({ length: 20 }, (_, i) => log.append(event(i))));
  const result = await log.verify();
  assert.equal(result.ok, true);
  const rows = await log.all();
  assert.deepEqual(rows.map((r) => r.seq), Array.from({ length: 20 }, (_, i) => i + 1));
});

test('queries filter and page, newest first', async () => {
  const { log } = await seed(10);
  const page = await log.query({ limit: 3 });
  assert.equal(page.rows.length, 3);
  assert.equal(page.rows[0].seq, 10);
  const blocked = await log.query({ decision: 'block' });
  assert.equal(blocked.rows.every((r) => r.decision === 'block'), true);
  const search = await log.query({ text: 'example.com/7' });
  assert.equal(search.total, 1);
  const second = await log.query({ limit: 3, offset: 3 });
  assert.equal(second.rows[0].seq, 7);
});

test('retention prunes whole chunks and remembers the truncation point', async () => {
  const store = memoryStore();
  const log = new AuditLog({ store, maxRecords: 100 });
  for (let i = 0; i < 260; i += 1) await log.append(event(i));
  const stats = await log.stats();
  assert.ok(stats.count <= 200, `expected pruning, got ${stats.count}`);
  assert.ok(stats.truncatedBefore > 0);
  assert.equal((await log.verify()).ok, true);
});

test('clearing the log is itself recorded and resets the chain', async () => {
  const { log } = await seed(3);
  const res = await log.clear('test');
  assert.equal(res.cleared, 3);
  const stats = await log.stats();
  assert.equal(stats.count, 0);
  await log.append(event(99));
  assert.equal((await log.verify()).ok, true);
});

test('exports carry the hash so an auditor can re-verify offline', async () => {
  const { log } = await seed(2);
  const ndjson = await log.export('ndjson');
  const lines = ndjson.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.ok(lines[0].hash && lines[1].prevHash === lines[0].hash);
  const csv = await log.export('csv');
  assert.match(csv.split('\n')[0], /^seq,ts,type,decision/);
});

test('csv escaping survives commas and quotes in reasons', () => {
  const csv = toCsv([{ seq: 1, ts: 0, type: 't', decision: 'block', reason: 'a, "b"', risk: {}, actor: {}, target: {} }]);
  assert.match(csv.split('\n')[1], /"a, ""b"""/);
});
