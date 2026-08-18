import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveEffectivePolicy, lockedSections } from '../src/core/policy-resolve.js';
import { MODE } from '../src/core/constants.js';

test('with no overrides the effective policy is the shipped default', () => {
  const { policy, layers } = resolveEffectivePolicy(null, null);
  assert.deepEqual(layers, ['default']);
  assert.equal(policy.mode, MODE.GUARDRAIL);
});

test('local settings layer over the defaults', () => {
  const { policy, layers } = resolveEffectivePolicy({ mode: MODE.LOCKDOWN }, null);
  assert.equal(policy.mode, MODE.LOCKDOWN);
  assert.deepEqual(layers, ['default', 'local']);
  assert.ok(policy.rules.length > 0, 'untouched sections survive the merge');
});

test('managed settings win over local ones', () => {
  const { policy, layers } = resolveEffectivePolicy(
    { mode: MODE.MONITOR, budgets: { maxActionsPerMinute: 999 } },
    { mode: MODE.LOCKDOWN },
  );
  assert.equal(policy.mode, MODE.LOCKDOWN);
  assert.equal(policy.budgets.maxActionsPerMinute, 999);
  assert.deepEqual(layers, ['default', 'local', 'managed']);
});

test('a locked managed policy discards local settings entirely', () => {
  const { policy, layers, locked, errors } = resolveEffectivePolicy(
    { mode: MODE.MONITOR, budgets: { maxActionsPerMinute: 999 } },
    { locked: true, mode: MODE.GUARDRAIL },
  );
  assert.equal(locked, true);
  assert.equal(policy.mode, MODE.GUARDRAIL);
  assert.notEqual(policy.budgets.maxActionsPerMinute, 999);
  assert.deepEqual(layers, ['default', 'managed']);
  assert.match(errors[0], /locked/);
});

test('an invalid local policy is reported and ignored rather than applied', () => {
  const { policy, errors, layers } = resolveEffectivePolicy({ mode: 'nonsense' }, null);
  assert.equal(policy.mode, MODE.GUARDRAIL);
  assert.deepEqual(layers, ['default']);
  assert.match(errors[0], /^local:/);
});

test('lockedSections tells the UI what to grey out', () => {
  assert.deepEqual(lockedSections(null), []);
  assert.deepEqual(lockedSections({ locked: true }), ['*']);
  assert.deepEqual(lockedSections({ mode: 'guardrail', rules: [] }), ['mode', 'rules']);
});
