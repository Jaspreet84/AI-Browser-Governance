import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, strongest, validatePolicy, isEnforcing } from '../src/core/policy-engine.js';
import { defaultPolicy } from '../src/core/default-policy.js';
import { ACTION, ACTOR, DECISION, MODE, SEVERITY } from '../src/core/constants.js';

const agent = { kind: ACTOR.AGENT, confidence: 0.9 };
const human = { kind: ACTOR.HUMAN, confidence: 0.05 };

test('the shipped policy validates', () => {
  assert.deepEqual(validatePolicy(defaultPolicy()), []);
});

test('strongest picks the more restrictive decision', () => {
  assert.equal(strongest(DECISION.WARN, DECISION.BLOCK), DECISION.BLOCK);
  assert.equal(strongest(DECISION.BLOCK, DECISION.ALLOW), DECISION.BLOCK);
});

test('an agent typing into a credential field is blocked', () => {
  const res = evaluate(
    { type: ACTION.INPUT, url: 'https://intranet.example.com/login', actor: agent, target: { isCredentialField: true } },
    defaultPolicy(),
  );
  assert.equal(res.decision, DECISION.BLOCK);
  assert.ok(res.matchedRules.includes('agent-credential-entry'));
});

test('a human typing into a credential field is not blocked', () => {
  const res = evaluate(
    { type: ACTION.INPUT, url: 'https://intranet.example.com/login', actor: human, target: { isCredentialField: true } },
    defaultPolicy(),
  );
  assert.notEqual(res.decision, DECISION.BLOCK);
});

test('destructive agent clicks need a human', () => {
  const res = evaluate(
    { type: ACTION.CLICK, url: 'https://app.example.com/settings', actor: agent, target: { destructiveLabel: true } },
    defaultPolicy(),
  );
  assert.equal(res.decision, DECISION.REQUIRE_APPROVAL);
});

test('secrets bound for a model provider are blocked and marked for redaction', () => {
  const res = evaluate(
    {
      type: ACTION.PROMPT_SUBMIT,
      url: 'https://claude.ai/new',
      actor: human,
      data: { dlp: [{ severity: SEVERITY.CRITICAL, detectorId: 'aws_access_key' }] },
    },
    defaultPolicy(),
  );
  assert.equal(res.decision, DECISION.BLOCK);
  assert.equal(res.obligations.redact, true);
});

test('low-severity personal data to a model provider only warns', () => {
  const res = evaluate(
    {
      type: ACTION.PROMPT_SUBMIT,
      url: 'https://chatgpt.com/',
      actor: human,
      data: { dlp: [{ severity: SEVERITY.LOW, detectorId: 'email' }] },
    },
    defaultPolicy(),
  );
  assert.equal(res.decision, DECISION.WARN);
});

test('an allowlisted site overrides the rest of the ladder', () => {
  const policy = defaultPolicy();
  policy.siteClasses.allowlist = ['sandbox.example.com'];
  const res = evaluate(
    { type: ACTION.INPUT, url: 'https://sandbox.example.com/login', actor: agent, target: { isCredentialField: true } },
    policy,
  );
  assert.equal(res.decision, DECISION.ALLOW);
  assert.equal(res.overridden, true);
});

test('monitor mode records what it would have done without enforcing', () => {
  const policy = defaultPolicy();
  policy.mode = MODE.MONITOR;
  const res = evaluate(
    { type: ACTION.INPUT, url: 'https://x.example.com', actor: agent, target: { isCredentialField: true } },
    policy,
  );
  assert.equal(res.decision, DECISION.LOG);
  assert.equal(res.wouldHaveBeen, DECISION.BLOCK);
});

test('lockdown escalates ordinary agent actions to approval', () => {
  const policy = defaultPolicy();
  policy.mode = MODE.LOCKDOWN;
  const res = evaluate({ type: ACTION.CLICK, url: 'https://news.example.com', actor: agent, target: {} }, policy);
  assert.equal(res.decision, DECISION.REQUIRE_APPROVAL);
});

test('lockdown does not gate human actions', () => {
  const policy = defaultPolicy();
  policy.mode = MODE.LOCKDOWN;
  const res = evaluate({ type: ACTION.CLICK, url: 'https://news.example.com', actor: human, target: {} }, policy);
  assert.equal(res.decision, DECISION.LOG);
});

test('the kill switch blocks agent actions outright', () => {
  const res = evaluate(
    { type: ACTION.CLICK, url: 'https://news.example.com', actor: agent, target: {} },
    defaultPolicy(),
    { killSwitch: true },
  );
  assert.equal(res.decision, DECISION.BLOCK);
  assert.match(res.reason, /Kill switch/);
});

test('the kill switch leaves human browsing alone', () => {
  const res = evaluate(
    { type: ACTION.CLICK, url: 'https://news.example.com', actor: human, target: {} },
    defaultPolicy(),
    { killSwitch: true },
  );
  assert.notEqual(res.decision, DECISION.BLOCK);
});

test('exceeding the action budget forces a human checkpoint', () => {
  const res = evaluate(
    { type: ACTION.CLICK, url: 'https://news.example.com', actor: agent, target: {} },
    defaultPolicy(),
    { session: { actionsInWindow: 500 } },
  );
  assert.equal(res.decision, DECISION.REQUIRE_APPROVAL);
  assert.ok(res.matchedRules.includes('budget:actions_per_minute'));
});

test('a disabled rule does not fire', () => {
  const policy = defaultPolicy();
  policy.rules = policy.rules.map((r) => (r.id === 'agent-credential-entry' ? { ...r, enabled: false } : r));
  const res = evaluate(
    { type: ACTION.INPUT, url: 'https://x.example.com', actor: agent, target: { isCredentialField: true } },
    policy,
  );
  assert.equal(res.matchedRules.includes('agent-credential-entry'), false);
});

test('url patterns scope a rule to one site', () => {
  const policy = defaultPolicy();
  policy.rules = [{
    id: 'only-there',
    when: { urlPatterns: ['secret.example.com'] },
    then: { decision: DECISION.BLOCK, reason: 'nope' },
  }];
  assert.equal(evaluate({ type: ACTION.CLICK, url: 'https://secret.example.com/a', actor: agent }, policy).decision, DECISION.BLOCK);
  assert.equal(evaluate({ type: ACTION.CLICK, url: 'https://other.example.com/a', actor: agent }, policy).decision, DECISION.LOG);
});

test('excludeUrlPatterns carves an exception out of a rule', () => {
  const policy = defaultPolicy();
  policy.rules = [{
    id: 'broad',
    when: { urlPatterns: ['*'], excludeUrlPatterns: ['ok.example.com'] },
    then: { decision: DECISION.BLOCK, reason: 'nope' },
  }];
  assert.equal(evaluate({ type: ACTION.CLICK, url: 'https://ok.example.com/a', actor: agent }, policy).decision, DECISION.LOG);
  assert.equal(evaluate({ type: ACTION.CLICK, url: 'https://no.example.com/a', actor: agent }, policy).decision, DECISION.BLOCK);
});

test('extension attribution can be required by a rule', () => {
  const policy = defaultPolicy();
  const fromExtension = {
    type: ACTION.AI_EGRESS,
    url: 'https://api.openai.com/v1/chat',
    actor: { ...agent, attribution: { extensionId: 'abc' } },
  };
  const fromPage = { type: ACTION.AI_EGRESS, url: 'https://api.openai.com/v1/chat', actor: agent };
  assert.ok(evaluate(fromExtension, policy).matchedRules.includes('unattributed-extension-model-traffic'));
  assert.equal(evaluate(fromPage, policy).matchedRules.includes('unattributed-extension-model-traffic'), false);
});

test('validatePolicy catches the mistakes an admin actually makes', () => {
  const errors = validatePolicy({
    mode: 'paranoid',
    defaultDecision: 'destroy',
    rules: [
      { description: 'no id' },
      { id: 'bad-decision', then: { decision: 'nuke' } },
      { id: 'bad-regex', when: { urlPatterns: ['re:([unclosed'] } },
      { id: 'bad-severity', when: { dlpAtLeast: 'spicy' } },
    ],
    dlp: { customPatterns: [{ id: 'x', regex: '([' }] },
  });
  assert.equal(errors.length, 7, errors.join('\n'));
});

test('isEnforcing marks the decisions the page must act on', () => {
  assert.equal(isEnforcing(DECISION.BLOCK), true);
  assert.equal(isEnforcing(DECISION.REQUIRE_APPROVAL), true);
  assert.equal(isEnforcing(DECISION.WARN), false);
});
