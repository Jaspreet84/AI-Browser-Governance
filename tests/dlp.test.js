import test from 'node:test';
import assert from 'node:assert/strict';
import { scan, redactText, luhn, ibanChecksum, maxSeverity, atLeast, compileCustomDetectors } from '../src/core/dlp.js';

const ids = (findings) => findings.map((f) => f.detectorId).sort();

test('luhn separates real card numbers from digit strings', () => {
  assert.equal(luhn('4111111111111111'), true);
  assert.equal(luhn('4111111111111112'), false);
  assert.equal(luhn('1234'), false);
});

test('card detector requires a Luhn-valid number', () => {
  assert.deepEqual(ids(scan('order 1234567890123456')), []);
  assert.ok(ids(scan('card 4111 1111 1111 1111')).includes('credit_card'));
});

test('iban checksum rejects a corrupted iban', () => {
  assert.equal(ibanChecksum('GB82WEST12345698765432'), true);
  assert.equal(ibanChecksum('GB82WEST12345698765433'), false);
});

test('provider keys are attributed to the right detector', () => {
  assert.deepEqual(ids(scan('key sk-ant-api03-abcdefghijklmnopqrst')), ['anthropic_key']);
  assert.deepEqual(ids(scan('key sk-proj-abcdefghijklmnopqrstuvwx')), ['openai_key']);
  assert.deepEqual(ids(scan('token ghp_abcdefghijklmnopqrstuvwxyz0123')), ['github_token']);
});

test('findings never contain the raw secret', () => {
  const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123';
  const [finding] = scan(`token ${secret}`);
  assert.equal(JSON.stringify(finding).includes(secret), false);
  assert.ok(finding.preview.startsWith('ghp_'));
});

test('findings are ordered most severe first', () => {
  const findings = scan('mail a@b.co and key sk-ant-api03-abcdefghijklmnopqrst');
  assert.equal(findings[0].severity, 'critical');
});

test('redactText replaces every hit and leaves other text intact', () => {
  const out = redactText('ssn 123-45-6789 card 4111111111111111 hello');
  assert.equal(out.includes('123-45-6789'), false);
  assert.equal(out.includes('4111111111111111'), false);
  assert.ok(out.endsWith('hello'));
});

test('custom patterns are compiled and applied', () => {
  const custom = [{ id: 'emp', name: 'Employee id', severity: 'medium', regex: 'EMP-\\d{6}' }];
  const findings = scan('user EMP-123456', { custom });
  assert.equal(findings[0].detectorId, 'emp');
  assert.equal(findings[0].custom, true);
});

test('a malformed custom pattern is skipped, not fatal', () => {
  const compiled = compileCustomDetectors([{ id: 'bad', regex: '([' }, { id: 'good', regex: 'x' }]);
  assert.deepEqual(compiled.map((d) => d.id), ['good']);
  assert.doesNotThrow(() => scan('x', { custom: [{ id: 'bad', regex: '([' }] }));
});

test('detector allowlist limits which detectors run', () => {
  const findings = scan('mail a@b.co key ghp_abcdefghijklmnopqrstuvwxyz0123', { enabled: ['email'] });
  assert.deepEqual(ids(findings), ['email']);
});

test('severity helpers rank findings', () => {
  assert.equal(maxSeverity([{ severity: 'low' }, { severity: 'high' }]), 'high');
  assert.equal(maxSeverity([]), null);
  assert.equal(atLeast('high', 'medium'), true);
  assert.equal(atLeast('low', 'high'), false);
  assert.equal(atLeast(null, 'low'), false);
  assert.equal(atLeast('low', null), true);
});

test('scanning empty or non-string input is safe', () => {
  assert.deepEqual(scan(''), []);
  assert.deepEqual(scan(undefined), []);
  assert.deepEqual(scan(null), []);
});
