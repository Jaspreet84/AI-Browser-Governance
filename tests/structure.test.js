/**
 * Structural checks: the manifest, the files it points at, and the constants
 * the content scripts have to duplicate because they cannot import modules.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { MSG, ACTION, SIGNAL, BRIDGE_CHANNEL } from '../src/core/constants.js';

const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const exists = (p) => existsSync(new URL(`../${p}`, import.meta.url));

test('manifest is MV3 and every referenced file exists', () => {
  assert.equal(manifest.manifest_version, 3);
  const referenced = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_page,
    manifest.storage.managed_schema,
    ...Object.values(manifest.icons),
    ...manifest.content_scripts.flatMap((cs) => [...(cs.js || []), ...(cs.css || [])]),
  ];
  for (const path of referenced) assert.ok(exists(path), `missing file referenced by manifest: ${path}`);
});

test('the service worker is a module and the probe runs in the main world', () => {
  assert.equal(manifest.background.type, 'module');
  const probe = manifest.content_scripts.find((cs) => cs.world === 'MAIN');
  assert.ok(probe, 'a MAIN-world content script is required to see page-script actions');
  assert.equal(probe.run_at, 'document_start');
});

test('every requested permission is justified in the README', () => {
  const readme = read('README.md');
  for (const permission of manifest.permissions) {
    assert.match(readme, new RegExp(`\`${permission}\``), `README does not explain the ${permission} permission`);
  }
});

test('content-script constant copies match the shared module', () => {
  const sensor = read('src/content/sensor.js');
  const probe = read('src/content/probe.js');

  assert.ok(sensor.includes(`'${BRIDGE_CHANNEL}'`), 'sensor bridge channel drifted');
  assert.ok(probe.includes(`'${BRIDGE_CHANNEL}'`), 'probe bridge channel drifted');

  for (const value of [MSG.ACTION_PROPOSED, MSG.APPROVAL_REQUEST, MSG.APPROVAL_RESULT, MSG.SNAPSHOT, MSG.STATE_PUSH, MSG.SIGNAL_REPORT]) {
    assert.ok(sensor.includes(`'${value}'`), `sensor is missing message type ${value}`);
  }
  for (const value of [ACTION.CLICK, ACTION.INPUT, ACTION.FORM_SUBMIT, ACTION.UPLOAD, ACTION.CLIPBOARD_READ, ACTION.PROMPT_SUBMIT]) {
    assert.ok(sensor.includes(`'${value}'`), `sensor is missing action type ${value}`);
  }
  for (const value of [SIGNAL.UNTRUSTED_EVENT, SIGNAL.WEBDRIVER_FLAG, SIGNAL.SYNTHETIC_VALUE_SET, SIGNAL.HUMAN_INPUT_RECENT]) {
    assert.ok(sensor.includes(`'${value}'`), `sensor is missing signal ${value}`);
  }
});

test('the approval dialog only accepts trusted events', () => {
  const overlay = read('src/ui/../content/overlay.js');
  assert.match(overlay, /if \(!event\.isTrusted\)/, 'the approval gate must reject synthetic clicks');
});

test('the managed schema declares the settings an admin can push', () => {
  const schema = JSON.parse(read('managed-schema.json'));
  const props = schema.properties.policy.properties;
  for (const key of ['mode', 'locked', 'rules', 'dlp', 'siteClasses', 'budgets', 'audit', 'approvals']) {
    assert.ok(key in props, `managed schema is missing ${key}`);
  }
});

test('the enterprise template validates against the policy validator', async () => {
  const { validatePolicy } = await import('../src/core/policy-engine.js');
  const template = JSON.parse(read('enterprise/managed-policy-template.json'));
  assert.deepEqual(validatePolicy(template.policy), []);
});

test('extension version matches package.json', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(manifest.version, pkg.version);
});
