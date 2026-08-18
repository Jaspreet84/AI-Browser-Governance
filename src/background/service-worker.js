/**
 * Service worker: the decision point.
 *
 * Sensors propose actions, this evaluates them against policy, seals the
 * outcome into the audit log, and answers the sensor with what to do. It also
 * watches the surfaces a content script cannot see — model API egress,
 * downloads, navigations, and the installed extension inventory.
 *
 * The worker is killed and restarted by Chrome at will, so every piece of state
 * that matters is either in storage or cheap to rebuild on demand.
 */

import {
  ACTION,
  ACTOR,
  DECISION,
  MODE,
  MSG,
  SEVERITY,
  SIGNAL,
  STORE,
} from '../core/constants.js';
import { fuseSignals } from '../core/agent-signals.js';
import { scan, maxSeverity, redactText } from '../core/dlp.js';
import { evaluate, isEnforcing } from '../core/policy-engine.js';
import { classifySite } from '../core/sites.js';
import { SessionTracker } from '../core/session.js';
import { newId, sample, hostOf } from '../core/util.js';

import { getPolicy, reload, saveLocalPolicy, resetLocalPolicy, getLocalPolicy, getManagedPolicy, onPolicyChange, watchManagedChanges } from './policy-service.js';
import { getLog, record, flushForward, pendingForwardCount } from './audit-service.js';
import * as approvals from './approvals.js';
import * as inventory from './inventory.js';
import * as netwatch from './network-watch.js';
import * as ui from './ui-feedback.js';
import { getValue, setValue, session as sessionStore } from './storage.js';

const sessions = new SessionTracker();
let killSwitch = false;
let ready = null;

/* ------------------------------------------------------------------ startup */

async function init() {
  const policy = await getPolicy();
  killSwitch = Boolean(await getValue(STORE.KILL_SWITCH, false));
  sessions.hydrate((await sessionStore.get([STORE.SESSIONS]))[STORE.SESSIONS] || []);
  if (policy.agentDetection?.networkWatch) netwatch.install(policy, onEgress);
  watchManagedChanges();
  await ensureAlarms();
  if (policy.agentDetection?.extensionInventory) refreshInventory();
  return policy;
}

function boot() {
  if (!ready) ready = init().catch((e) => {
    console.error('[abg] init failed', e);
    ready = null;
  });
  return ready;
}

onPolicyChange((policy) => {
  if (policy.agentDetection?.networkWatch) netwatch.install(policy, onEgress);
  else netwatch.uninstall();
});

async function ensureAlarms() {
  await chrome.alarms.create('abg:maintenance', { periodInMinutes: 1 });
  await chrome.alarms.create('abg:inventory', { periodInMinutes: 60 });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await boot();
  await record({
    type: 'extension.lifecycle',
    decision: DECISION.LOG,
    reason: `AI Browser Governance ${details.reason}`,
    url: '',
    actor: { kind: ACTOR.HUMAN, confidence: 0 },
    version: chrome.runtime.getManifest().version,
  });
  if (details.reason === 'install') chrome.runtime.openOptionsPage?.();
});

chrome.runtime.onStartup.addListener(boot);
boot();

/* --------------------------------------------------------------- evaluation */

/**
 * The decision pipeline every sensor observation flows through.
 *
 * @param {object} proposal raw observation from a sensor
 * @param {object} sender   chrome.runtime.MessageSender (may be empty)
 * @returns {Promise<object>} decision payload for the sensor
 */
export async function decide(proposal, sender = {}) {
  await boot();
  const policy = await getPolicy();
  const now = Date.now();
  const tabId = sender.tab?.id ?? proposal.tabId ?? -1;
  const url = proposal.url || sender.tab?.url || sender.url || '';

  const actor = fuseSignals(proposal.signals || [], {
    now,
    threshold: policy.agentDetection?.minConfidence ?? 0.6,
  });
  if (proposal.actor?.attribution) actor.attribution = proposal.actor.attribution;

  const site = classifySite(url, policy);

  // DLP runs here, in the worker, so page scripts never see the detector set
  // and cannot tune their payloads against it.
  let dlp = [];
  let scanned = '';
  if (policy.dlp?.enabled && proposal.text) {
    scanned = String(proposal.text).slice(0, policy.dlp.maxScanChars ?? 20000);
    dlp = scan(scanned, {
      enabled: policy.dlp.enabledDetectors || undefined,
      custom: policy.dlp.customPatterns || [],
    });
  }

  // The stored sample exists to give an investigator context, so it is redacted
  // with the same detectors that produced the findings. An audit log that
  // accumulates secrets is a new liability, not a control.
  const storedSample = policy.dlp?.storeSamples && scanned
    ? sample(redactText(scanned.slice(0, 600), {
        enabled: policy.dlp.enabledDetectors || undefined,
        custom: policy.dlp.customPatterns || [],
      }), 200)
    : undefined;

  const action = {
    id: proposal.id || newId('act'),
    ts: now,
    type: proposal.type,
    url,
    origin: proposal.origin || (url ? new URL(url).origin : ''),
    tabId,
    frameId: sender.frameId ?? 0,
    actor: {
      kind: actor.kind,
      confidence: actor.confidence,
      reasons: actor.reasons,
      attribution: actor.attribution || proposal.actor?.attribution || {},
    },
    target: proposal.target || {},
    site,
    data: {
      dlp,
      sample: storedSample,
      dlpSeverity: maxSeverity(dlp) || undefined,
    },
  };

  const { session, started, counters } = sessions.record(tabId, action, now);
  const result = evaluate(action, policy, { killSwitch, session: counters });
  sessions.settle(tabId, result);

  if (started) {
    ui.bump(tabId, 'agent');
    await record({
      type: ACTION.SESSION_START,
      decision: DECISION.LOG,
      reason: `Agent session opened on ${hostOf(url) || 'unknown host'}`,
      url,
      tabId,
      sessionId: session?.id,
      actor: action.actor,
      risk: { score: 0, band: 'low' },
    });
    if (policy.notifications?.onAgentSessionStart) {
      ui.notify({ title: 'Agent activity detected', message: `An AI agent started acting on ${hostOf(url)}` });
    }
  }

  let final = result.decision;
  let approval = null;

  // A human who already approved this shape of action this session is not asked
  // again — repeated prompts train people to click through them.
  if (final === DECISION.REQUIRE_APPROVAL && policy.approvals?.allowRememberForSession && session && approvals.isRemembered(session.id, action)) {
    final = DECISION.ALLOW;
    result.reason = `${result.reason} (approved earlier this session)`;
  }

  if (final === DECISION.REQUIRE_APPROVAL && !proposal.preflight) {
    approval = await requestApproval({ action, result, tabId, frameId: sender.frameId ?? 0, policy, session });
    final = approval.approved ? DECISION.ALLOW : DECISION.BLOCK;
    if (approval.approved) sessions.approved(tabId);
    else sessions.denied(tabId);
  }

  if (final === DECISION.BLOCK) ui.bump(tabId, 'blocked');
  else if (final === DECISION.WARN) ui.bump(tabId, 'warnings');

  // A preflight is a look-ahead scan of text that has not been sent yet. It
  // only earns an audit record when it finds something worth stopping.
  const quiet = proposal.preflight && (final === DECISION.ALLOW || final === DECISION.LOG);
  const auditPayload = {
    id: action.id,
    ts: action.ts,
    type: action.type,
    url: action.url,
    origin: action.origin,
    tabId,
    sessionId: session?.id || null,
    decision: final,
    ruleDecision: result.decision,
    wouldHaveBeen: result.wouldHaveBeen,
    reason: result.reason,
    mode: policy.mode,
    preflight: proposal.preflight || undefined,
    matchedRules: result.matchedRules,
    risk: result.risk,
    actor: action.actor,
    target: action.target,
    site: { primary: site.primary, classes: site.classes, provider: site.provider },
    data: { dlp: action.data.dlp, sample: action.data.sample },
    approval: approval
      ? { id: approval.id, approved: approval.approved, timedOut: approval.timedOut, justification: approval.justification || '' }
      : undefined,
    obligations: result.obligations,
  };
  const sealed = quiet ? { seq: null } : await record(auditPayload);

  if (!quiet && final === DECISION.BLOCK && policy.notifications?.onBlock) {
    ui.notify({
      title: 'Agent action blocked',
      message: `${result.reason} — ${hostOf(url)}`,
      id: `abg-block-${sealed.seq ?? action.id}`,
    });
  }

  await persistSessions();

  return {
    decision: final,
    reason: result.reason,
    risk: result.risk,
    matchedRules: result.matchedRules,
    obligations: result.obligations,
    mode: policy.mode,
    enforcing: isEnforcing(final) && policy.mode !== MODE.MONITOR,
    dlp: action.data.dlp,
    recordSeq: sealed.seq,
    actionId: action.id,
  };
}

/** Ask the human. Renders the prompt in the originating frame when we can. */
async function requestApproval({ action, result, tabId, frameId, policy, session }) {
  const { id, promise } = approvals.create({
    action,
    decisionResult: result,
    tabId,
    frameId,
    sessionId: session?.id || '',
    timeoutSeconds: policy.approvals?.timeoutSeconds ?? 60,
    onTimeout: policy.approvals?.onTimeout ?? DECISION.BLOCK,
  });

  ui.bump(tabId, 'approvals');
  const payload = {
    type: MSG.APPROVAL_REQUEST,
    approvalId: id,
    action: {
      type: action.type,
      url: action.url,
      target: action.target,
      site: action.site,
      actor: action.actor,
      data: { dlp: action.data.dlp },
    },
    reason: result.reason,
    risk: result.risk,
    matchedRules: result.matchedRules,
    requireJustification: Boolean(result.obligations?.justification),
    allowRemember: Boolean(policy.approvals?.allowRememberForSession),
    timeoutSeconds: policy.approvals?.timeoutSeconds ?? 60,
  };

  let delivered = false;
  if (tabId >= 0) {
    try {
      await chrome.tabs.sendMessage(tabId, payload, { frameId });
      delivered = true;
    } catch {
      delivered = false;
    }
  }
  if (!delivered) {
    // No page to prompt in (an extension's own request, a closed tab). Fall back
    // to a notification and let the timeout decide, which fails closed.
    if (policy.notifications?.onApprovalRequest) {
      ui.notify({ title: 'Agent action needs approval', message: result.reason, id: `abg-approval-${id}` });
    }
  }
  return promise;
}

/* ------------------------------------------------------------ egress + tabs */

async function onEgress(egress) {
  const policy = await getPolicy();
  const promptText = policy.network?.scanEgressBodies ? extractText(egress) : '';
  await decide(
    {
      type: ACTION.AI_EGRESS,
      url: egress.url,
      origin: egress.origin,
      tabId: egress.tabId ?? -1,
      signals: egress.signals,
      actor: egress.actor,
      target: { label: `${egress.method} ${hostOf(egress.url)}`, provider: egress.provider },
      text: promptText,
    },
    { tab: egress.tabId != null ? { id: egress.tabId } : undefined },
  );
}

function extractText(egress) {
  return netwatch.extractPromptText(egress.body?.text || '');
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  approvals.cancelForTab(tabId);
  const ended = sessions.end(tabId);
  ui.reset(tabId);
  if (ended) {
    approvals.forgetSession(ended.id);
    await record(sessionEndRecord(ended, 'tab closed'));
    await persistSessions();
  }
});

chrome.webNavigation?.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const s = sessions.get(details.tabId);
  if (!s) return;
  // Agent-driven navigation: the session follows the tab, but the origin change
  // is worth a record of its own.
  await decide(
    {
      type: ACTION.NAVIGATE,
      url: details.url,
      tabId: details.tabId,
      signals: [{ type: SIGNAL.UNTRUSTED_EVENT, at: Date.now(), weight: 0.4 }],
      target: { label: details.transitionType },
    },
    { tab: { id: details.tabId } },
  );
});

chrome.downloads?.onCreated.addListener(async (item) => {
  const tabId = -1;
  const active = sessions.list().find((s) => Date.now() - s.lastActionAt < 10_000);
  if (!active) return; // no agent in flight: an ordinary human download
  await decide(
    {
      type: ACTION.DOWNLOAD,
      url: item.finalUrl || item.url,
      tabId: active.tabId ?? tabId,
      signals: [{ type: SIGNAL.UNTRUSTED_EVENT, at: Date.now(), weight: 0.5 }],
      target: { label: item.filename || 'download', mime: item.mime },
    },
    { tab: { id: active.tabId } },
  );
});

/* ------------------------------------------------------------------ alarms */

chrome.alarms.onAlarm.addListener(async (alarm) => {
  await boot();
  if (alarm.name === 'abg:maintenance') {
    const ended = sessions.reap();
    for (const s of ended) {
      approvals.forgetSession(s.id);
      await record(sessionEndRecord(s, 'idle timeout'));
    }
    if (ended.length) await persistSessions();
    await flushForward();
  }
  if (alarm.name === 'abg:inventory') {
    const policy = await getPolicy();
    if (policy.agentDetection?.extensionInventory) await refreshInventory();
  }
});

function sessionEndRecord(s, reason) {
  return {
    type: ACTION.SESSION_END,
    decision: DECISION.LOG,
    reason: `Agent session ended (${reason})`,
    url: s.origin || '',
    tabId: s.tabId,
    sessionId: s.id,
    actor: { kind: ACTOR.AGENT, confidence: s.peakConfidence },
    summary: {
      actions: s.actions,
      blocked: s.blocked,
      approvals: s.approvals,
      denials: s.denials,
      navigations: s.navigations,
      riskSpent: s.riskSpent,
      durationMs: s.lastActionAt - s.startedAt,
      topRules: s.topRules,
    },
    risk: { score: Math.min(100, Math.round(s.riskSpent / 10)), band: 'low' },
  };
}

async function persistSessions() {
  await sessionStore.set({ [STORE.SESSIONS]: sessions.list() });
}

async function refreshInventory() {
  try {
    const { changes } = await inventory.refresh();
    for (const payload of inventory.changeRecords(changes)) await record(payload);
  } catch (e) {
    console.warn('[abg] inventory refresh failed', e);
  }
}

/* ----------------------------------------------------------------- messages */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender)
    .then(sendResponse)
    .catch((e) => {
      console.error('[abg] message handler failed', msg?.type, e);
      sendResponse({ error: String(e?.message || e) });
    });
  return true; // async response
});

async function handleMessage(msg, sender) {
  await boot();
  const policy = await getPolicy();

  switch (msg?.type) {
    case MSG.ACTION_PROPOSED:
      return decide(msg.action || msg, sender);

    case MSG.SIGNAL_REPORT: {
      // Environment signals (webdriver, automation globals) arrive once per
      // frame and only matter as context for later actions.
      const tabId = sender.tab?.id ?? -1;
      if (msg.signals?.length && tabId >= 0) ui.bump(tabId, 'agent');
      return { ok: true };
    }

    case MSG.APPROVAL_RESULT:
      return {
        ok: approvals.resolveRequest(msg.approvalId, {
          approved: Boolean(msg.approved),
          justification: msg.justification || '',
          remember: Boolean(msg.remember),
          sessionId: sessions.get(sender.tab?.id ?? -1)?.id || '',
        }),
      };

    case MSG.APPROVAL_LIST:
      return { pending: approvals.list() };

    case MSG.SNAPSHOT: {
      // Sent to content scripts so they know what is worth intercepting.
      return {
        mode: policy.mode,
        killSwitch,
        minConfidence: policy.agentDetection?.minConfidence ?? 0.6,
        deepInstrumentation: policy.agentDetection?.deepInstrumentation !== false,
        enforce: policy.mode !== MODE.MONITOR,
        interceptTypes: [ACTION.CLICK, ACTION.INPUT, ACTION.FORM_SUBMIT, ACTION.UPLOAD, ACTION.CLIPBOARD_READ],
        guardCredentialFields: guardsCredentialFields(policy),
        siteClasses: classifySite(sender.tab?.url || sender.url || '', policy),
      };
    }

    case MSG.STATE_QUERY: {
      const tabId = msg.tabId ?? sender.tab?.id ?? (await activeTabId());
      const auditLog = await getLog();
      return {
        mode: policy.mode,
        killSwitch,
        locked: Boolean(policy.__meta?.locked),
        layers: policy.__meta?.layers || [],
        tab: {
          id: tabId,
          counts: ui.tabCounts(tabId),
          session: sessions.get(tabId),
          site: { ...classifySite((await tabUrl(tabId)) || '', policy), url: (await tabUrl(tabId)) || '' },
        },
        sessions: sessions.list().length,
        pendingApprovals: approvals.countPending(),
        audit: await auditLog.stats(),
        forwardQueue: pendingForwardCount(),
        recent: (await auditLog.query({ limit: msg.recentLimit ?? 8 })).rows,
      };
    }

    case MSG.POLICY_GET:
      return {
        effective: policy,
        local: await getLocalPolicy(),
        managed: getManagedPolicy(),
        meta: policy.__meta,
      };

    case MSG.POLICY_SET: {
      const res = await saveLocalPolicy(msg.policy);
      if (res.ok) {
        await record({
          type: 'policy.changed',
          decision: DECISION.LOG,
          reason: 'Local policy updated',
          url: '',
          actor: { kind: ACTOR.HUMAN, confidence: 0 },
          policySummary: { mode: res.policy.mode, rules: res.policy.rules?.length },
        });
      }
      return res;
    }

    case MSG.POLICY_RESET: {
      const p = await resetLocalPolicy();
      await record({
        type: 'policy.changed',
        decision: DECISION.LOG,
        reason: 'Local policy reset to defaults',
        url: '',
        actor: { kind: ACTOR.HUMAN, confidence: 0 },
      });
      return { ok: true, policy: p };
    }

    case MSG.AUDIT_QUERY:
      return (await getLog()).query(msg.query || {});

    case MSG.AUDIT_EXPORT:
      return { format: msg.format || 'ndjson', content: await (await getLog()).export(msg.format) };

    case MSG.AUDIT_VERIFY:
      return (await getLog()).verify();

    case MSG.AUDIT_CLEAR: {
      const auditLog = await getLog();
      const before = await auditLog.stats();
      const res = await auditLog.clear(msg.reason || 'operator request');
      await record({
        type: 'audit.cleared',
        decision: DECISION.WARN,
        reason: `Audit log cleared (${res.cleared} records destroyed)`,
        url: '',
        actor: { kind: ACTOR.HUMAN, confidence: 0 },
        priorHead: before.headHash,
      });
      return res;
    }

    case MSG.KILL_SWITCH: {
      killSwitch = Boolean(msg.enabled);
      await setValue(STORE.KILL_SWITCH, killSwitch);
      await record({
        type: 'control.kill_switch',
        decision: killSwitch ? DECISION.BLOCK : DECISION.LOG,
        reason: killSwitch ? 'Kill switch engaged: agent actions blocked' : 'Kill switch released',
        url: '',
        actor: { kind: ACTOR.HUMAN, confidence: 0 },
      });
      await broadcastSnapshot();
      return { ok: true, killSwitch };
    }

    case MSG.INVENTORY_GET:
      return inventory.stored();

    case MSG.INVENTORY_REFRESH:
      await refreshInventory();
      return inventory.stored();

    case MSG.SESSION_END_REQUEST: {
      const ended = sessions.end(msg.tabId);
      if (ended) {
        await record(sessionEndRecord(ended, 'ended by operator'));
        await persistSessions();
      }
      ui.reset(msg.tabId);
      return { ok: Boolean(ended) };
    }

    default:
      return { error: `Unknown message type: ${msg?.type}` };
  }
}

/**
 * Does the active policy hard-block agent writes to credential fields? The
 * sensor uses this to mark those fields for synchronous refusal, so a password
 * cannot be typed while an async ruling is still in flight.
 */
export function guardsCredentialFields(policy) {
  if (policy.mode === MODE.MONITOR) return false;
  return (policy.rules || []).some(
    (r) =>
      r.enabled !== false &&
      r.then?.decision === DECISION.BLOCK &&
      (r.when?.targetFlags || []).includes('isCredentialField'),
  );
}

async function broadcastSnapshot() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id) continue;
    chrome.tabs.sendMessage(tab.id, { type: MSG.STATE_PUSH, killSwitch }).catch(() => {});
  }
}

async function activeTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? -1;
}

async function tabUrl(tabId) {
  if (typeof tabId !== 'number' || tabId < 0) return '';
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab?.url || '';
  } catch {
    return '';
  }
}
