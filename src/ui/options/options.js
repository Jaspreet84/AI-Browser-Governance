/**
 * Admin console.
 *
 * Every view reads the *effective* policy (default <- local <- managed) but
 * writes only the local layer, so a user edit can never silently drop an
 * administrator's rule.
 */

import { MSG, send, $, $$, el, timeAgo, shortUrl, decisionBadge, actionLabel, download } from '../shared.js';

const state = {
  effective: null,
  local: null,
  managed: null,
  meta: null,
  audit: { rows: [], total: 0, offset: 0, limit: 50 },
  editingRuleIndex: null,
};

const DETECTOR_CATALOGUE = [
  ['aws_access_key', 'AWS access key id'], ['aws_secret_key', 'AWS secret access key'],
  ['gcp_service_account', 'GCP service account key'], ['private_key_block', 'PEM private key'],
  ['github_token', 'GitHub token'], ['anthropic_key', 'Anthropic API key'], ['openai_key', 'OpenAI API key'],
  ['slack_token', 'Slack token'], ['jwt', 'JSON web token'], ['bearer_header', 'Authorization header'],
  ['password_assignment', 'Password in text'], ['credit_card', 'Payment card number'], ['us_ssn', 'US SSN'],
  ['iban', 'IBAN'], ['email', 'Email address'], ['phone', 'Phone number'],
  ['ip_private', 'Internal IP address'], ['internal_host', 'Internal hostname'],
];

/* ------------------------------------------------------------- navigation */

function showView(name) {
  for (const section of $$('.view')) section.hidden = section.id !== `view-${name}`;
  for (const link of $$('nav a')) link.classList.toggle('active', link.dataset.view === name);
  if (name === 'audit') loadAudit(true);
  if (name === 'extensions') loadInventory();
}

window.addEventListener('hashchange', () => showView(location.hash.slice(1) || 'overview'));

/* ------------------------------------------------------------------ policy */

/** The local layer we mutate, seeded from whatever the user has saved. */
function draft() {
  return structuredClone(state.local || {});
}

async function loadPolicy() {
  const res = await send({ type: MSG.POLICY_GET });
  state.effective = res.effective;
  state.local = res.local;
  state.managed = res.managed;
  state.meta = res.meta;

  const note = $('#managedNote');
  if (state.managed) {
    note.hidden = false;
    note.textContent = state.meta?.locked
      ? 'Policy is locked by your administrator. Local edits are ignored.'
      : `Administrator policy is active for: ${(state.meta?.lockedSections || []).join(', ') || 'some settings'}.`;
  } else {
    note.hidden = true;
  }

  renderPolicyForm();
  renderRules();
  renderDlp();
  renderAdvanced();
  $('#effectivePolicy').value = JSON.stringify(withoutMeta(state.effective), null, 2);
}

function withoutMeta(policy) {
  const copy = structuredClone(policy || {});
  delete copy.__meta;
  return copy;
}

async function savePolicy(patch, statusEl) {
  const next = { ...draft(), ...patch };
  const res = await send({ type: MSG.POLICY_SET, policy: next });
  if (statusEl) {
    statusEl.textContent = res?.ok ? 'Saved.' : `Not saved: ${(res?.errors || ['unknown error']).join('; ')}`;
    setTimeout(() => { statusEl.textContent = ''; }, 4000);
  }
  await loadPolicy();
  await loadOverview();
  return res;
}

function renderPolicyForm() {
  const p = state.effective;
  $('#mode').value = p.mode;
  $('#defaultDecision').value = p.defaultDecision;
  $('#minConfidence').value = p.agentDetection?.minConfidence ?? 0.6;
  $('#minConfidenceValue').textContent = `${Math.round((p.agentDetection?.minConfidence ?? 0.6) * 100)}%`;
  $('#deepInstrumentation').checked = p.agentDetection?.deepInstrumentation !== false;
  $('#networkWatch').checked = p.agentDetection?.networkWatch !== false;
  $('#extensionInventory').checked = p.agentDetection?.extensionInventory !== false;
  $('#timeoutSeconds').value = p.approvals?.timeoutSeconds ?? 60;
  $('#onTimeout').value = p.approvals?.onTimeout ?? 'block';
  $('#allowRememberForSession').checked = Boolean(p.approvals?.allowRememberForSession);
  $('#maxActionsPerMinute').value = p.budgets?.maxActionsPerMinute ?? 60;
  $('#maxNavigationsPerSession').value = p.budgets?.maxNavigationsPerSession ?? 100;
  $('#maxRiskScorePerSession').value = p.budgets?.maxRiskScorePerSession ?? 1500;
  $('#aiProviders').value = (p.siteClasses?.aiProviders || []).join('\n');
  $('#sensitive').value = (p.siteClasses?.sensitive || []).join('\n');
  $('#allowlist').value = (p.siteClasses?.allowlist || []).join('\n');
  $('#denylist').value = (p.siteClasses?.denylist || []).join('\n');

  const locked = Boolean(state.meta?.locked);
  for (const control of $$('#policyForm input, #policyForm select, #policyForm textarea, #policyForm button')) {
    control.disabled = locked;
  }
}

$('#minConfidence').addEventListener('input', (event) => {
  $('#minConfidenceValue').textContent = `${Math.round(Number(event.target.value) * 100)}%`;
});

$('#policyForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const lines = (id) => $(`#${id}`).value.split('\n').map((s) => s.trim()).filter(Boolean);
  await savePolicy({
    mode: $('#mode').value,
    defaultDecision: $('#defaultDecision').value,
    agentDetection: {
      ...(draft().agentDetection || {}),
      minConfidence: Number($('#minConfidence').value),
      deepInstrumentation: $('#deepInstrumentation').checked,
      networkWatch: $('#networkWatch').checked,
      extensionInventory: $('#extensionInventory').checked,
    },
    approvals: {
      ...(draft().approvals || {}),
      timeoutSeconds: Number($('#timeoutSeconds').value),
      onTimeout: $('#onTimeout').value,
      allowRememberForSession: $('#allowRememberForSession').checked,
    },
    budgets: {
      maxActionsPerMinute: Number($('#maxActionsPerMinute').value),
      maxNavigationsPerSession: Number($('#maxNavigationsPerSession').value),
      maxRiskScorePerSession: Number($('#maxRiskScorePerSession').value),
    },
    siteClasses: {
      ...(draft().siteClasses || {}),
      aiProviders: lines('aiProviders'),
      sensitive: lines('sensitive'),
      allowlist: lines('allowlist'),
      denylist: lines('denylist'),
    },
  }, $('#policyStatus'));
});

$('#resetPolicy').addEventListener('click', async () => {
  if (!confirm('Reset the local policy to the shipped defaults?')) return;
  await send({ type: MSG.POLICY_RESET });
  await loadPolicy();
});

/* ------------------------------------------------------------------- rules */

function renderRules() {
  const rules = state.effective.rules || [];
  const body = $('#rulesRows');
  body.replaceChildren(...rules.map((rule, index) => {
    const toggle = el('input', {
      type: 'checkbox',
      title: 'Enable or disable this rule',
      onchange: () => toggleRule(index, toggle.checked),
    });
    toggle.checked = rule.enabled !== false;
    toggle.disabled = Boolean(state.meta?.locked);
    return el('tr', {},
      el('td', {}, toggle),
      el('td', {},
        el('div', { class: 'mono', text: rule.id }),
        el('div', { class: 'muted', text: rule.description || '' })),
      el('td', { class: 'why', text: describeWhen(rule.when) }),
      el('td', {}, decisionBadge(rule.then?.decision), rule.override ? el('span', { class: 'badge', text: 'override' }) : null),
      el('td', {},
        el('button', { class: 'ghost', text: 'Edit', onclick: () => editRule(index) }),
        el('button', { class: 'ghost', text: 'Delete', onclick: () => deleteRule(index) })),
    );
  }));
  $('#rulesStatus').textContent = `${rules.length} rules · most restrictive match wins`;
}

function describeWhen(when = {}) {
  const parts = [];
  if (when.actorKinds?.length) parts.push(`actor ${when.actorKinds.join('/')}`);
  if (when.minConfidence) parts.push(`confidence ≥ ${Math.round(when.minConfidence * 100)}%`);
  if (when.actionTypes?.length) parts.push(when.actionTypes.map(actionLabel).join(', '));
  if (when.siteClasses?.length) parts.push(`site ${when.siteClasses.join('/')}`);
  if (when.targetFlags?.length) parts.push(`target ${when.targetFlags.join('/')}`);
  if (when.dlpAtLeast) parts.push(`data ≥ ${when.dlpAtLeast}`);
  if (when.riskAtLeast) parts.push(`risk ≥ ${when.riskAtLeast}`);
  if (when.urlPatterns?.length) parts.push(`url ${when.urlPatterns.slice(0, 2).join(', ')}`);
  if (when.hasExtensionAttribution) parts.push('from an extension');
  return parts.join(' · ') || 'any action';
}

async function toggleRule(index, enabled) {
  const rules = structuredClone(state.effective.rules || []);
  rules[index] = { ...rules[index], enabled };
  await savePolicy({ rules }, $('#rulesStatus'));
}

function editRule(index) {
  state.editingRuleIndex = index;
  const rule = index === null ? newRuleTemplate() : state.effective.rules[index];
  $('#ruleJson').value = JSON.stringify(rule, null, 2);
  $('#ruleEditor').hidden = false;
  $('#ruleError').textContent = '';
  $('#ruleJson').focus();
}

function newRuleTemplate() {
  return {
    id: 'custom-rule',
    description: 'Describe what this rule protects',
    enabled: true,
    when: { actorKinds: ['agent'], actionTypes: ['element.click'], urlPatterns: ['example.com'] },
    then: { decision: 'require_approval', reason: 'Explain what the human is being asked about' },
  };
}

$('#addRule').addEventListener('click', () => editRule(null));
$('#cancelRule').addEventListener('click', () => { $('#ruleEditor').hidden = true; });

$('#saveRule').addEventListener('click', async () => {
  let rule;
  try {
    rule = JSON.parse($('#ruleJson').value);
  } catch (e) {
    $('#ruleError').textContent = `Invalid JSON: ${e.message}`;
    return;
  }
  const rules = structuredClone(state.effective.rules || []);
  if (state.editingRuleIndex === null) rules.push(rule);
  else rules[state.editingRuleIndex] = rule;
  const res = await savePolicy({ rules }, $('#rulesStatus'));
  if (res?.ok) $('#ruleEditor').hidden = true;
  else $('#ruleError').textContent = (res?.errors || []).join('; ');
});

async function deleteRule(index) {
  const rule = state.effective.rules[index];
  if (!confirm(`Delete rule "${rule.id}"?`)) return;
  const rules = structuredClone(state.effective.rules);
  rules.splice(index, 1);
  await savePolicy({ rules }, $('#rulesStatus'));
}

/* --------------------------------------------------------------------- DLP */

function renderDlp() {
  const dlp = state.effective.dlp || {};
  $('#dlpEnabled').checked = dlp.enabled !== false;
  $('#storeSamples').checked = dlp.storeSamples !== false;
  $('#maxScanChars').value = dlp.maxScanChars ?? 20000;
  $('#customPatterns').value = JSON.stringify(dlp.customPatterns || [], null, 2);

  const enabled = dlp.enabledDetectors;
  $('#detectors').replaceChildren(...DETECTOR_CATALOGUE.map(([id, name]) => {
    const box = el('input', { type: 'checkbox', 'data-detector': id });
    box.checked = !enabled || enabled.includes(id);
    return el('label', { class: 'check' }, box, name);
  }));
}

$('#saveDlp').addEventListener('click', async () => {
  let custom = [];
  try {
    custom = JSON.parse($('#customPatterns').value || '[]');
    if (!Array.isArray(custom)) throw new Error('expected an array');
  } catch (e) {
    $('#dlpStatus').textContent = `Custom patterns: ${e.message}`;
    return;
  }
  const boxes = $$('#detectors input[data-detector]');
  const selected = boxes.filter((b) => b.checked).map((b) => b.dataset.detector);
  await savePolicy({
    dlp: {
      ...(draft().dlp || {}),
      enabled: $('#dlpEnabled').checked,
      storeSamples: $('#storeSamples').checked,
      maxScanChars: Number($('#maxScanChars').value),
      enabledDetectors: selected.length === boxes.length ? null : selected,
      customPatterns: custom,
    },
  }, $('#dlpStatus'));
});

$('#dlpTest').addEventListener('click', async () => {
  const text = $('#dlpTestInput').value;
  const { scan } = await import('../../core/dlp.js');
  const findings = scan(text, {
    enabled: state.effective.dlp?.enabledDetectors || undefined,
    custom: state.effective.dlp?.customPatterns || [],
  });
  const box = $('#dlpTestResult');
  if (findings.length === 0) {
    box.replaceChildren(el('span', { class: 'finding', text: 'No sensitive data detected.' }));
    return;
  }
  box.replaceChildren(...findings.map((f) =>
    el('span', { class: `finding ${f.severity}`, text: `${f.name} ×${f.count} — ${f.preview}` })));
});

/* ------------------------------------------------------------------- audit */

async function loadAudit(reset = false) {
  if (reset) state.audit.offset = 0;
  const res = await send({
    type: MSG.AUDIT_QUERY,
    query: {
      limit: state.audit.limit,
      offset: state.audit.offset,
      text: $('#auditSearch').value || undefined,
      decision: $('#auditDecision').value || undefined,
      actor: $('#auditActor').value || undefined,
    },
  });
  state.audit.rows = reset ? res.rows : [...state.audit.rows, ...res.rows];
  state.audit.total = res.total;
  renderAudit();
}

function renderAudit() {
  const body = $('#auditRows');
  if (state.audit.rows.length === 0) {
    body.replaceChildren(el('tr', {}, el('td', { colspan: 8, class: 'empty', text: 'No records match.' })));
  } else {
    body.replaceChildren(...state.audit.rows.map((r) => el('tr', { class: r.decision === 'block' ? 'blocked' : '' },
      el('td', { class: 'num', text: r.seq ?? '—' }),
      el('td', { class: 'num', text: timeAgo(r.ts), title: new Date(r.ts).toISOString() }),
      el('td', {}, el('div', { text: actionLabel(r.type) }), el('div', { class: 'muted', text: r.target?.label ? String(r.target.label).slice(0, 48) : '' })),
      el('td', { class: 'why', text: shortUrl(r.url, 36) }),
      el('td', {}, el('span', { class: `badge ${r.actor?.kind === 'agent' ? 'agent' : ''}`, text: r.actor?.kind || 'unknown' }),
        r.actor?.confidence ? el('div', { class: 'muted', text: `${Math.round(r.actor.confidence * 100)}%` }) : null),
      el('td', { class: `score ${r.risk?.score >= 75 ? 'hot' : r.risk?.score >= 50 ? 'warm' : ''}`, text: r.risk?.score ?? '—' }),
      el('td', {}, decisionBadge(r.decision), r.wouldHaveBeen ? el('div', { class: 'muted', text: `would ${r.wouldHaveBeen}` }) : null),
      el('td', { class: 'why', text: [r.reason, (r.data?.dlp || []).map((f) => f.name).join(', ')].filter(Boolean).join(' · ') }),
    )));
  }
  $('#auditCount').textContent = `${state.audit.rows.length} of ${state.audit.total} shown`;
  $('#auditMore').disabled = state.audit.rows.length >= state.audit.total;
}

$('#auditSearch').addEventListener('input', debounce(() => loadAudit(true), 300));
$('#auditDecision').addEventListener('change', () => loadAudit(true));
$('#auditActor').addEventListener('change', () => loadAudit(true));
$('#auditMore').addEventListener('click', () => {
  state.audit.offset += state.audit.limit;
  loadAudit(false);
});

$('#verifyChain').addEventListener('click', async () => {
  $('#verifyResult').textContent = 'Verifying…';
  const res = await send({ type: MSG.AUDIT_VERIFY });
  $('#verifyResult').textContent = res.ok
    ? `Chain intact — ${res.checked} records verified.`
    : `Chain broken at record ${res.brokenAt}: ${res.reason}`;
  $('#verifyResult').style.color = res.ok ? 'var(--ok)' : 'var(--bad)';
});

$('#exportNdjson').addEventListener('click', async () => {
  const res = await send({ type: MSG.AUDIT_EXPORT, format: 'ndjson' });
  download(`ai-governance-audit-${stamp()}.ndjson`, res.content, 'application/x-ndjson');
});

$('#exportCsv').addEventListener('click', async () => {
  const res = await send({ type: MSG.AUDIT_EXPORT, format: 'csv' });
  download(`ai-governance-audit-${stamp()}.csv`, res.content, 'text/csv');
});

$('#clearAudit').addEventListener('click', async () => {
  if (!confirm('Clearing destroys the existing chain. The clear itself is recorded. Continue?')) return;
  await send({ type: MSG.AUDIT_CLEAR, reason: 'cleared from console' });
  loadAudit(true);
});

/* --------------------------------------------------------------- inventory */

async function loadInventory(refresh = false) {
  const res = await send({ type: refresh ? MSG.INVENTORY_REFRESH : MSG.INVENTORY_GET });
  const items = res?.items || [];
  $('#inventoryMeta').textContent = res?.refreshedAt ? `Last refreshed ${timeAgo(res.refreshedAt)}` : 'Never refreshed';
  const body = $('#inventoryRows');
  if (items.length === 0) {
    body.replaceChildren(el('tr', {}, el('td', { colspan: 6, class: 'empty', text: 'No other extensions installed.' })));
    return;
  }
  body.replaceChildren(...items.map((ext) => el('tr', {},
    el('td', {}, el('div', { text: ext.name }), el('div', { class: 'mono muted', text: `${ext.id.slice(0, 12)}… v${ext.version}` })),
    el('td', { class: `score ${ext.capabilityScore >= 75 ? 'hot' : ext.capabilityScore >= 45 ? 'warm' : ''}`, text: ext.capabilityScore },
      ext.agentic ? el('div', {}, el('span', { class: 'badge agent', text: 'agentic' })) : null),
    el('td', { class: 'why', text: (ext.flags || []).join(', ') || '—' }),
    el('td', { class: 'why', text: ext.hostBreadth }),
    el('td', { class: 'why', text: `${ext.installType}${ext.enabled ? '' : ' (disabled)'}` }),
    el('td', {}, ext.enabled && ext.mayDisable
      ? el('button', { class: 'ghost', text: 'Disable', onclick: () => disableExtension(ext) })
      : null),
  )));
}

async function disableExtension(ext) {
  if (!confirm(`Disable "${ext.name}"?`)) return;
  try {
    await chrome.management.setEnabled(ext.id, false);
  } catch (e) {
    alert(`Could not disable: ${e.message}`);
  }
  loadInventory(true);
}

$('#refreshInventory').addEventListener('click', () => loadInventory(true));

/* ---------------------------------------------------------------- advanced */

function renderAdvanced() {
  const audit = state.effective.audit || {};
  $('#retentionDays').value = audit.retentionDays ?? 30;
  $('#maxRecords').value = audit.maxRecords ?? 5000;
  $('#forwardEnabled').checked = Boolean(audit.forward?.enabled);
  $('#forwardUrl').value = audit.forward?.url || '';
  $('#forwardHeaderName').value = audit.forward?.headerName || 'Authorization';
  $('#forwardHeaderValue').value = audit.forward?.headerValue || '';
}

$('#saveAdvanced').addEventListener('click', async () => {
  await savePolicy({
    audit: {
      ...(draft().audit || {}),
      retentionDays: Number($('#retentionDays').value),
      maxRecords: Number($('#maxRecords').value),
      forward: {
        ...(draft().audit?.forward || {}),
        enabled: $('#forwardEnabled').checked,
        url: $('#forwardUrl').value.trim(),
        headerName: $('#forwardHeaderName').value.trim(),
        headerValue: $('#forwardHeaderValue').value,
      },
    },
  }, $('#advancedStatus'));
});

$('#exportPolicy').addEventListener('click', () => {
  download(`ai-governance-policy-${stamp()}.json`, JSON.stringify(state.local || withoutMeta(state.effective), null, 2));
});

$('#importPolicy').addEventListener('click', () => $('#policyFile').click());
$('#policyFile').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const policy = JSON.parse(await file.text());
    const res = await send({ type: MSG.POLICY_SET, policy });
    if (!res?.ok) alert(`Policy rejected:\n${(res?.errors || []).join('\n')}`);
    await loadPolicy();
  } catch (e) {
    alert(`Could not read policy file: ${e.message}`);
  }
  event.target.value = '';
});

/* ---------------------------------------------------------------- overview */

async function loadOverview() {
  const s = await send({ type: MSG.STATE_QUERY, recentLimit: 12 });
  $('#overviewCards').replaceChildren(
    card(s.audit?.count ?? 0, 'audited events'),
    card(s.sessions ?? 0, 'active agent sessions'),
    card(s.tab?.counts?.blocked ?? 0, 'blocked in this tab'),
    card(s.pendingApprovals ?? 0, 'awaiting approval'),
    card(s.forwardQueue ?? 0, 'queued for collector'),
  );
  $('#postureBadge').textContent = s.killSwitch ? 'kill switch engaged' : s.mode;
  $('#postureBadge').className = `badge ${s.killSwitch ? 'block' : s.mode === 'lockdown' ? 'require_approval' : s.mode === 'monitor' ? '' : 'allow'}`;

  $('#modePicker').replaceChildren(...[
    ['monitor', 'Monitor', 'Record everything, change nothing.'],
    ['guardrail', 'Guardrail', 'Enforce the rule set with human checkpoints.'],
    ['lockdown', 'Lockdown', 'Every agent action needs approval.'],
  ].map(([value, title, blurb]) => {
    const button = el('button', {
      class: `panel mode ${s.mode === value ? 'active' : ''}`,
      onclick: () => savePolicy({ mode: value }, null).then(loadOverview),
    }, el('strong', { text: title }), el('span', { text: blurb }));
    button.disabled = Boolean(state.meta?.locked);
    return button;
  }));

  $('#overviewRows').replaceChildren(...(s.recent || []).map((r) => el('tr', {},
    el('td', { class: 'num', text: timeAgo(r.ts) }),
    el('td', { text: actionLabel(r.type) }),
    el('td', { class: 'why', text: shortUrl(r.url, 30) }),
    el('td', { text: r.actor?.kind || '—' }),
    el('td', {}, decisionBadge(r.decision)),
    el('td', { class: 'why', text: r.reason || '' }),
  )));
}

function card(value, label) {
  return el('div', { class: 'card' }, el('b', { text: String(value) }), el('span', { text: label }));
}

/* ------------------------------------------------------------------- utils */

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function stamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

$('#version').textContent = `v${chrome.runtime.getManifest().version}`;
showView(location.hash.slice(1) || 'overview');
loadPolicy().then(loadOverview);
setInterval(loadOverview, 10_000);
