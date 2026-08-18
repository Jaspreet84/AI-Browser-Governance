import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreAction, labelFlags, band } from '../src/core/risk.js';
import { classifySite, providerFor } from '../src/core/sites.js';
import { ACTION, ACTOR, SITE_CLASS } from '../src/core/constants.js';

test('risk rises with consequence, not just with action type', () => {
  const plain = scoreAction({ type: ACTION.CLICK, actor: { kind: ACTOR.AGENT, confidence: 0.8 } });
  const costly = scoreAction({
    type: ACTION.FORM_SUBMIT,
    actor: { kind: ACTOR.AGENT, confidence: 0.9 },
    target: { isPaymentField: true, crossOrigin: true },
    site: { classes: [SITE_CLASS.SENSITIVE] },
    data: { dlp: [{ severity: 'critical' }] },
  });
  assert.ok(costly.score > plain.score);
  assert.equal(costly.band, 'critical');
});

test('an allowlisted site and a human actor pull the score down', () => {
  const res = scoreAction({
    type: ACTION.CLICK,
    actor: { kind: ACTOR.HUMAN },
    site: { classes: [SITE_CLASS.ALLOWLISTED] },
  });
  assert.equal(res.score, 0);
  assert.equal(res.band, 'low');
});

test('scores stay inside 0..100 and report their factors', () => {
  const res = scoreAction({
    type: ACTION.UPLOAD,
    actor: { kind: ACTOR.AGENT, confidence: 1 },
    target: { isCredentialField: true, isPaymentField: true, destructiveLabel: true, crossOrigin: true, hiddenElement: true },
    site: { classes: [SITE_CLASS.SENSITIVE, SITE_CLASS.DENYLISTED] },
    data: { dlp: [{ severity: 'critical' }] },
  });
  assert.equal(res.score, 100);
  assert.ok(res.factors.length > 5);
});

test('label heuristics read the button, not the markup', () => {
  assert.equal(labelFlags('Delete everything').destructiveLabel, true);
  assert.equal(labelFlags('Send money now').financialLabel, true);
  assert.equal(labelFlags('Share with anyone').externalShare, true);
  assert.equal(labelFlags('Read more').destructiveLabel, false);
});

test('band thresholds', () => {
  assert.equal(band(10), 'low');
  assert.equal(band(30), 'medium');
  assert.equal(band(60), 'high');
  assert.equal(band(90), 'critical');
});

test('sites are classified against admin lists first, then the catalogue', () => {
  assert.equal(classifySite('https://claude.ai/chat').primary, SITE_CLASS.AI_PROVIDER);
  assert.equal(classifySite('https://console.aws.amazon.com/iam').primary, SITE_CLASS.SENSITIVE);
  assert.equal(classifySite('https://example.com').primary, SITE_CLASS.UNCLASSIFIED);
  const policy = { siteClasses: { denylist: ['claude.ai'], allowlist: ['claude.ai'] } };
  assert.equal(classifySite('https://claude.ai/chat', policy).primary, SITE_CLASS.DENYLISTED);
});

test('an internal assistant can be declared an AI provider', () => {
  const policy = { siteClasses: { aiProviders: ['llm.internal.example.com'] } };
  const site = classifySite('https://llm.internal.example.com/chat', policy);
  assert.ok(site.classes.includes(SITE_CLASS.AI_PROVIDER));
});

test('provider attribution covers hosted deployments', () => {
  assert.equal(providerFor('api.anthropic.com'), 'Anthropic');
  assert.equal(providerFor('contoso.openai.azure.com'), 'OpenAI');
  assert.equal(providerFor('bedrock-runtime.us-east-1.amazonaws.com'), 'AWS Bedrock');
  assert.equal(providerFor('example.com'), null);
});

test('classifying a non-URL does not throw', () => {
  assert.equal(classifySite('about:blank').primary, SITE_CLASS.UNCLASSIFIED);
  assert.equal(classifySite('').primary, SITE_CLASS.UNCLASSIFIED);
});
