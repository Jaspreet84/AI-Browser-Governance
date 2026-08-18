/**
 * Extension inventory.
 *
 * The most capable agent in a browser is usually another extension: one with
 * `debugger` can drive every tab through the DevTools protocol, and one with
 * `nativeMessaging` can hand the page to a local process. Content-script
 * sensors cannot see either, so we inventory what is installed, score how much
 * agentic capability it holds, and record changes to the audit log.
 */

import { ACTION, STORE } from '../core/constants.js';
import { getValue, setValue } from './storage.js';

/** Permission -> how much browser-driving power it confers. */
export const CAPABILITY_WEIGHTS = {
  debugger: 45,
  nativeMessaging: 25,
  scripting: 20,
  tabs: 10,
  webNavigation: 8,
  webRequest: 8,
  declarativeNetRequest: 5,
  cookies: 12,
  clipboardRead: 10,
  downloads: 8,
  history: 6,
  management: 10,
  desktopCapture: 15,
  tabCapture: 15,
  pageCapture: 12,
  proxy: 12,
  privacy: 5,
};

const AI_NAME_HINTS = /\b(ai|agent|assistant|copilot|gpt|llm|claude|gemini|autopilot|automation|browse[r]?[ -]?use|operator)\b/i;

/** Extensions that can act on every page without asking. */
function hostBreadth(hostPermissions = []) {
  if (hostPermissions.some((h) => h === '<all_urls>' || /^\*:\/\/\*\/\*/.test(h) || /^https?:\/\/\*\/\*/.test(h))) {
    return { score: 25, label: 'all sites' };
  }
  if (hostPermissions.length > 10) return { score: 12, label: `${hostPermissions.length} sites` };
  if (hostPermissions.length > 0) return { score: 5, label: `${hostPermissions.length} sites` };
  return { score: 0, label: 'no host access' };
}

/** @returns {{score:number, flags:string[], agentic:boolean}} */
export function scoreExtension(ext) {
  const flags = [];
  let score = 0;
  for (const p of ext.permissions || []) {
    if (CAPABILITY_WEIGHTS[p]) {
      score += CAPABILITY_WEIGHTS[p];
      if (CAPABILITY_WEIGHTS[p] >= 20) flags.push(`permission:${p}`);
    }
  }
  const breadth = hostBreadth(ext.hostPermissions);
  score += breadth.score;
  if (breadth.score >= 25) flags.push('host:all_urls');

  const text = `${ext.name || ''} ${ext.description || ''}`;
  if (AI_NAME_HINTS.test(text)) {
    score += 15;
    flags.push('name:ai_hint');
  }
  if (ext.installType === 'development') {
    score += 10;
    flags.push('install:unpacked');
  }
  if (ext.installType === 'sideload') {
    score += 15;
    flags.push('install:sideloaded');
  }

  return {
    score: Math.min(100, score),
    flags,
    agentic: score >= 45 || (ext.permissions || []).includes('debugger'),
    hostBreadth: breadth.label,
  };
}

/** Read the live inventory from chrome.management. */
export async function collect() {
  if (!chrome.management?.getAll) return [];
  const self = chrome.runtime.id;
  const all = await chrome.management.getAll();
  return all
    .filter((e) => e.type === 'extension' && e.id !== self)
    .map((e) => {
      const scored = scoreExtension(e);
      return {
        id: e.id,
        name: e.name,
        version: e.version,
        enabled: e.enabled,
        installType: e.installType,
        mayDisable: e.mayDisable,
        permissions: e.permissions || [],
        hostPermissions: e.hostPermissions || [],
        capabilityScore: scored.score,
        flags: scored.flags,
        agentic: scored.agentic,
        hostBreadth: scored.hostBreadth,
        seenAt: Date.now(),
      };
    })
    .sort((a, b) => b.capabilityScore - a.capabilityScore);
}

/**
 * Refresh the stored inventory and return what changed, so the caller can write
 * audit records for newly installed or newly empowered extensions.
 */
export async function refresh() {
  const current = await collect();
  const previous = (await getValue(STORE.INVENTORY, { items: [] })).items || [];
  const prevById = new Map(previous.map((e) => [e.id, e]));
  const changes = [];

  for (const ext of current) {
    const before = prevById.get(ext.id);
    if (!before) {
      changes.push({ change: 'installed', ext });
    } else {
      if (before.version !== ext.version) changes.push({ change: 'updated', ext, from: before.version });
      if (before.enabled !== ext.enabled) changes.push({ change: ext.enabled ? 'enabled' : 'disabled', ext });
      if (before.capabilityScore !== ext.capabilityScore) {
        changes.push({ change: 'permissions_changed', ext, from: before.capabilityScore });
      }
    }
    prevById.delete(ext.id);
  }
  for (const removed of prevById.values()) changes.push({ change: 'removed', ext: removed });

  await setValue(STORE.INVENTORY, { items: current, refreshedAt: Date.now() });
  return { items: current, changes };
}

export async function stored() {
  return getValue(STORE.INVENTORY, { items: [], refreshedAt: 0 });
}

/** Audit payloads for inventory changes. */
export function changeRecords(changes) {
  return changes.map(({ change, ext, from }) => ({
    type: ACTION.EXTENSION_SEEN,
    decision: ext.agentic && change === 'installed' ? 'warn' : 'log',
    reason: `Extension ${change}: ${ext.name}${from !== undefined ? ` (was ${from})` : ''}`,
    url: `chrome-extension://${ext.id}/`,
    actor: { kind: 'unknown', confidence: 0, attribution: { extensionId: ext.id, name: ext.name } },
    target: { label: ext.name },
    extension: {
      id: ext.id,
      name: ext.name,
      version: ext.version,
      capabilityScore: ext.capabilityScore,
      flags: ext.flags,
      agentic: ext.agentic,
      installType: ext.installType,
    },
    risk: { score: ext.capabilityScore, band: ext.capabilityScore >= 75 ? 'critical' : ext.capabilityScore >= 45 ? 'high' : 'low' },
  }));
}

/** Disable an extension that policy says must not run. Requires user consent. */
export async function disableExtension(id) {
  if (!chrome.management?.setEnabled) return { ok: false, error: 'management API unavailable' };
  try {
    await chrome.management.setEnabled(id, false);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}
