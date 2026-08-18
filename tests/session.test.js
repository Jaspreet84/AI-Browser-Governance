import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionTracker } from '../src/core/session.js';
import { ACTION, ACTOR } from '../src/core/constants.js';

const agentClick = { type: ACTION.CLICK, actor: { kind: ACTOR.AGENT, confidence: 0.85 } };
const humanClick = { type: ACTION.CLICK, actor: { kind: ACTOR.HUMAN, confidence: 0.05 } };
const t0 = 1_700_000_000_000;

test('an agent action opens a session; a human action does not', () => {
  const tracker = new SessionTracker();
  assert.equal(tracker.record(1, humanClick, t0).session, null);
  const first = tracker.record(1, agentClick, t0);
  assert.equal(first.started, true);
  assert.equal(tracker.record(1, agentClick, t0 + 10).started, false);
});

test('counters drive the budget checks', () => {
  const tracker = new SessionTracker();
  for (let i = 0; i < 5; i += 1) tracker.record(1, agentClick, t0 + i);
  const nav = tracker.record(1, { ...agentClick, type: ACTION.NAVIGATE }, t0 + 6);
  assert.equal(nav.counters.actionsInWindow, 6);
  assert.equal(nav.counters.navigations, 1);
});

test('actions outside the one-minute window drop out of the rate counter', () => {
  const tracker = new SessionTracker();
  tracker.record(1, agentClick, t0);
  const later = tracker.record(1, agentClick, t0 + 90_000);
  assert.equal(later.counters.actionsInWindow, 1);
});

test('settle accumulates risk and rule hits', () => {
  const tracker = new SessionTracker();
  tracker.record(1, agentClick, t0);
  tracker.settle(1, { risk: { score: 30 }, decision: 'block', matchedRules: ['r1', 'r2'] });
  tracker.settle(1, { risk: { score: 10 }, decision: 'allow', matchedRules: ['r1'] });
  const s = tracker.get(1);
  assert.equal(s.riskSpent, 40);
  assert.equal(s.blocked, 1);
  assert.deepEqual(s.topRules, { r1: 2, r2: 1 });
});

test('an idle session is reaped and the next action starts a new one', () => {
  const tracker = new SessionTracker({ idleMs: 1000 });
  const first = tracker.record(1, agentClick, t0);
  const ended = tracker.reap(t0 + 5000);
  assert.equal(ended.length, 1);
  const second = tracker.record(1, agentClick, t0 + 6000);
  assert.notEqual(second.session.id, first.session.id);
});

test('sessions survive a service-worker restart via hydrate', () => {
  const tracker = new SessionTracker();
  tracker.record(7, agentClick, t0);
  const snapshot = tracker.list();
  const restarted = new SessionTracker();
  restarted.hydrate(snapshot);
  assert.equal(restarted.get(7).actions, 1);
});
