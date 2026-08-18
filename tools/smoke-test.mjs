/**
 * End-to-end smoke test: load the unpacked extension in Chromium, drive a page
 * the way an agent would, and assert the governance pipeline actually fired.
 *
 *   NODE_PATH=/path/to/global/node_modules node tools/smoke-test.mjs
 *
 * This is a development tool, not part of `npm test` — it needs a browser.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = readFileSync(join(root, 'tools/fixtures/agent-playground.html'), 'utf8');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.error(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const context = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'abg-')), {
  headless: process.env.ABG_HEADFUL ? false : true,
  args: [
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    '--no-sandbox',
  ],
});

const workerErrors = [];
context.on('serviceworker', (worker) => {
  worker.on('console', (msg) => {
    if (msg.type() === 'error') workerErrors.push(msg.text());
  });
});

let worker = context.serviceWorkers()[0];
if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
const extensionId = new URL(worker.url()).host;
check('service worker started', Boolean(extensionId), extensionId);

const manifestName = await worker.evaluate(() => chrome.runtime.getManifest().name);
check('worker can read its manifest', manifestName === 'AI Browser Governance', manifestName);

// A service worker cannot message itself, so the console page is our client for
// the message bus — the same path the real UI uses.
const console_ = await context.newPage();
const consoleErrors = [];
console_.on('pageerror', (e) => consoleErrors.push(String(e)));
await console_.goto(`chrome-extension://${extensionId}/src/ui/options/options.html`, { waitUntil: 'domcontentloaded' });
const ask = (message) => console_.evaluate((m) => chrome.runtime.sendMessage(m), message);

// Guardrail mode with a low detection threshold, so the test does not depend on
// keystroke-cadence heuristics.
const policySet = await ask({
  type: 'policy:set',
  policy: { mode: 'guardrail', agentDetection: { minConfidence: 0.5 }, approvals: { timeoutSeconds: 3 } },
});
check('policy can be written through the message bus', policySet?.ok === true, JSON.stringify(policySet?.errors || ''));

const page = await context.newPage();
await page.route('**/*', (route) => {
  if (route.request().url().startsWith('http://governance.test/')) {
    return route.fulfill({ status: 200, contentType: 'text/html', body: fixture });
  }
  return route.fulfill({ status: 204, body: '' });
});

await page.goto('http://governance.test/', { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__pageReady === true);

const probeInstalled = await page.evaluate(() => window.__abgProbeInstalled === true);
check('MAIN-world probe installed', probeInstalled);

// Give the sensor time to fetch its policy snapshot before acting.
await page.waitForTimeout(1200);

// 1. A scripted click on a destructive control — the classic agent action.
await page.evaluate(() => document.querySelector('#danger').click());

// 2. A scripted write into a password field — must be refused outright.
const credentialWrite = await page.evaluate(() => {
  const input = document.querySelector('#pass');
  input.value = 'hunter2-should-not-land';
  return input.value;
});
check('scripted write to a password field is refused', credentialWrite === '', `field value: "${credentialWrite}"`);

// 3. A scripted value write carrying a secret into an ordinary field.
await page.evaluate(() => {
  document.querySelector('#notes').value = 'deploy key ghp_abcdefghijklmnopqrstuvwxyz0123 please';
});

// The destructive click lands in the approval queue; wait past the 3s timeout
// so the denial is sealed into the log before we read it.
await page.waitForTimeout(1000);
const promptShown = await page.evaluate(() => Boolean(document.querySelector('[data-abg-ui]')));
check('the approval prompt was rendered in the page', promptShown);
await page.waitForTimeout(4000);

const audit = await ask({ type: 'audit:query', query: { limit: 100 } });
const rows = audit?.rows || [];
check('actions reached the audit log', rows.length > 0, `${rows.length} records`);

const types = new Set(rows.map((r) => r.type));
check('the scripted click was recorded', types.has('element.click'), [...types].join(', '));
check('an agent session was opened', types.has('agent.session_start'));

const agentAttributed = rows.filter((r) => r.actor?.kind === 'agent');
check('actions were attributed to an agent', agentAttributed.length > 0, `${agentAttributed.length} agent-attributed`);

const dlpHit = rows.find((r) => (r.data?.dlp || []).some((f) => f.detectorId === 'github_token'));
check('the token in a field write was detected', Boolean(dlpHit), dlpHit ? dlpHit.decision : 'no finding');

const clickRecord = rows.find((r) => r.type === 'element.click');
check('the destructive click was held for a human', clickRecord?.decision === 'block',
  clickRecord ? `${clickRecord.decision}: ${clickRecord.reason}` : 'no click record');

const secretLeaked = JSON.stringify(rows).includes('ghp_abcdefghijklmnopqrstuvwxyz0123');
check('the raw secret never entered the audit log', !secretLeaked);

const verify = await ask({ type: 'audit:verify' });
check('the audit chain verifies', verify?.ok === true, verify?.reason || `${verify?.checked} records`);

const state = await ask({ type: 'state:query' });
check('state query answers the popup', typeof state?.mode === 'string', `mode=${state?.mode}`);

// The console must render the live policy without throwing.
await console_.reload({ waitUntil: 'domcontentloaded' });
await console_.waitForTimeout(1500);
const ruleRows = await console_.evaluate(() => document.querySelectorAll('#rulesRows tr').length);
check('console renders the rule set', ruleRows > 5, `${ruleRows} rules rendered`);
check('console raised no page errors', consoleErrors.length === 0, consoleErrors.join(' | '));

const popup = await context.newPage();
const popupErrors = [];
popup.on('pageerror', (e) => popupErrors.push(String(e)));
await popup.goto(`chrome-extension://${extensionId}/src/ui/popup/popup.html`, { waitUntil: 'domcontentloaded' });
await popup.waitForTimeout(1000);
check('popup raised no page errors', popupErrors.length === 0, popupErrors.join(' | '));

check('service worker logged no errors', workerErrors.length === 0, workerErrors.slice(0, 3).join(' | '));

await context.close();

const failed = results.filter((r) => !r.ok);
console.error(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
