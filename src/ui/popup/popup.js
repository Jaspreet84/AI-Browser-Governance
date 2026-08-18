/** Popup: what is happening in this tab, and the two controls you need fast. */

import { MSG, send, $, el, timeAgo, shortUrl, decisionBadge, actionLabel } from '../shared.js';

let state = null;

async function refresh() {
  try {
    state = await send({ type: MSG.STATE_QUERY, recentLimit: 8 });
  } catch (e) {
    $('#statusLine').textContent = `Governance service unavailable: ${e.message}`;
    return;
  }
  render();
}

function render() {
  const { mode, killSwitch, tab, sessions, pendingApprovals, audit, locked, recent } = state;

  $('#modeBadge').textContent = killSwitch ? 'agents blocked' : mode;
  $('#modeBadge').className = `badge ${killSwitch ? 'block' : mode === 'lockdown' ? 'require_approval' : mode === 'monitor' ? '' : 'allow'}`;
  $('#modeSelect').value = mode;
  $('#modeSelect').disabled = Boolean(locked);

  const dot = $('#statusDot');
  dot.className = `dot ${killSwitch ? 'hot' : tab?.session ? 'on' : ''}`;

  $('#statusLine').textContent = [
    `${sessions} active agent session${sessions === 1 ? '' : 's'}`,
    `${pendingApprovals} awaiting approval`,
    `${audit?.count ?? 0} audited events`,
    locked ? 'policy locked by admin' : null,
  ].filter(Boolean).join(' · ');

  $('#tabHost').textContent = shortUrl(tab?.site?.url || '') || 'This tab';
  const primary = tab?.site?.primary || 'unclassified';
  $('#siteClass').textContent = primary.replace('_', ' ');
  $('#siteClass').className = `badge ${primary === 'sensitive' || primary === 'denylisted' ? 'block' : primary === 'ai_provider' ? 'agent' : ''}`;

  const counts = tab?.counts || {};
  const session = tab?.session;
  $('#tabStats').replaceChildren(
    stat(session?.actions ?? 0, 'agent actions'),
    stat(counts.blocked ?? 0, 'blocked'),
    stat(counts.approvals ?? 0, 'approvals'),
    stat(Math.round(session?.riskSpent ?? 0), 'risk spent'),
  );

  $('#sessionLine').textContent = session
    ? `Agent session ${session.id.slice(-6)} — started ${timeAgo(session.startedAt)}, peak confidence ${(session.peakConfidence * 100).toFixed(0)}%.`
    : 'No agent activity seen in this tab.';
  $('#endSession').disabled = !session;

  $('#killSwitch').textContent = killSwitch ? 'Release kill switch' : 'Block all agents';
  $('#killSwitch').className = killSwitch ? 'primary' : 'danger';

  const list = $('#events');
  if (!recent || recent.length === 0) {
    list.replaceChildren(el('li', { class: 'empty', text: 'Nothing recorded yet.' }));
  } else {
    list.replaceChildren(...recent.map(eventRow));
  }
}

function stat(value, label) {
  return el('div', { class: 'stat' }, el('b', { text: String(value) }), el('span', { text: label }));
}

function eventRow(r) {
  return el(
    'li',
    {},
    el('span', { class: 'what', text: `${actionLabel(r.type)} · ${shortUrl(r.url, 26)}` }),
    decisionBadge(r.decision),
    el('span', { class: 'why', text: `${r.reason || ''} ${r.risk ? `(risk ${r.risk.score})` : ''} — ${timeAgo(r.ts)}` }),
  );
}

$('#killSwitch').addEventListener('click', async () => {
  await send({ type: MSG.KILL_SWITCH, enabled: !state.killSwitch });
  refresh();
});

$('#endSession').addEventListener('click', async () => {
  await send({ type: MSG.SESSION_END_REQUEST, tabId: state.tab.id });
  refresh();
});

$('#modeSelect').addEventListener('change', async (event) => {
  const { local } = await send({ type: MSG.POLICY_GET });
  const policy = { ...(local || {}), mode: event.target.value };
  const res = await send({ type: MSG.POLICY_SET, policy });
  if (!res?.ok) alert(`Could not change mode:\n${(res?.errors || []).join('\n')}`);
  refresh();
});

$('#openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('#openAudit').addEventListener('click', (event) => {
  event.preventDefault();
  chrome.tabs.create({ url: chrome.runtime.getURL('src/ui/options/options.html#audit') });
});

refresh();
setInterval(refresh, 3000);
