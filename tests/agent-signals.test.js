import test from 'node:test';
import assert from 'node:assert/strict';
import { fuseSignals, decayFactor, isModelApiUrl } from '../src/core/agent-signals.js';
import { ACTOR, SIGNAL } from '../src/core/constants.js';

const now = 1_700_000_000_000;

test('a single synthetic event is suspicious but not conclusive alone', () => {
  const verdict = fuseSignals([{ type: SIGNAL.UNTRUSTED_EVENT, at: now }], { now, threshold: 0.8 });
  assert.equal(verdict.kind, ACTOR.UNKNOWN);
  assert.ok(verdict.confidence > 0.7 && verdict.confidence < 0.8);
});

test('independent signals compound toward agent attribution', () => {
  const verdict = fuseSignals(
    [
      { type: SIGNAL.UNTRUSTED_EVENT, at: now },
      { type: SIGNAL.PROGRAMMATIC_CLICK, at: now },
      { type: SIGNAL.WEBDRIVER_FLAG, at: now },
    ],
    { now },
  );
  assert.equal(verdict.kind, ACTOR.AGENT);
  assert.ok(verdict.confidence > 0.98);
});

test('behavioural signals decay but environment signals do not', () => {
  const old = fuseSignals([{ type: SIGNAL.UNTRUSTED_EVENT, at: now - 120_000 }], { now });
  assert.ok(old.confidence < 0.1, `expected decay, got ${old.confidence}`);
  const env = fuseSignals([{ type: SIGNAL.WEBDRIVER_FLAG, at: now - 3_600_000 }], { now });
  assert.equal(env.confidence, 0.9);
});

test('recent human input discounts but never erases agent evidence', () => {
  const withHuman = fuseSignals(
    [
      { type: SIGNAL.UNTRUSTED_EVENT, at: now },
      { type: SIGNAL.PROGRAMMATIC_CLICK, at: now },
      { type: SIGNAL.HUMAN_INPUT_RECENT, at: now },
    ],
    { now },
  );
  const withoutHuman = fuseSignals(
    [
      { type: SIGNAL.UNTRUSTED_EVENT, at: now },
      { type: SIGNAL.PROGRAMMATIC_CLICK, at: now },
    ],
    { now },
  );
  assert.ok(withHuman.confidence < withoutHuman.confidence);
  assert.ok(withHuman.confidence > 0);
});

test('only human evidence yields a human verdict', () => {
  const verdict = fuseSignals([{ type: SIGNAL.HUMAN_INPUT_RECENT, at: now }], { now });
  assert.equal(verdict.kind, ACTOR.HUMAN);
});

test('unknown signal types are ignored', () => {
  const verdict = fuseSignals([{ type: 'not_a_signal', at: now }], { now });
  assert.equal(verdict.confidence, 0);
  assert.deepEqual(verdict.contributions, []);
});

test('decayFactor halves at the half life', () => {
  assert.equal(decayFactor(30_000, 30_000), 0.5);
  assert.equal(decayFactor(0, 30_000), 1);
  assert.equal(decayFactor(999_999, null), 1);
});

test('model API hosts are recognised, including regional Bedrock', () => {
  assert.equal(isModelApiUrl('https://api.anthropic.com/v1/messages'), true);
  assert.equal(isModelApiUrl('https://bedrock-runtime.eu-west-1.amazonaws.com/model/x'), true);
  assert.equal(isModelApiUrl('https://contoso.openai.azure.com/openai/deployments/x'), true);
  assert.equal(isModelApiUrl('https://example.com/api.anthropic.com'), false);
  assert.equal(isModelApiUrl('not-a-url'), false);
});
