/**
 * Owns the effective policy: loads the layers, caches the merged result, keeps
 * network-level blocking rules in sync with it, and tells every listener when
 * it changes.
 */

import { MODE, STORE } from '../core/constants.js';
import { resolveEffectivePolicy, lockedSections } from '../core/policy-resolve.js';
import { validatePolicy } from '../core/policy-engine.js';
import { AI_API_HOSTS } from '../core/agent-signals.js';
import { hostOf } from '../core/util.js';
import { local, readManaged, getValue } from './storage.js';

/** Dynamic declarativeNetRequest rules live in this id range. */
const DNR_RULE_BASE = 9000;

let cached = null;
let cachedManaged = null;
const listeners = new Set();

export function onPolicyChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Merged policy, loading it on first use. */
export async function getPolicy() {
  if (cached) return cached;
  return reload();
}

export function getPolicySync() {
  return cached;
}

export async function reload() {
  const localPolicy = await getValue(STORE.POLICY, null);
  cachedManaged = await readManaged();
  const resolved = resolveEffectivePolicy(localPolicy, cachedManaged);
  cached = resolved.policy;
  cached.__meta = {
    layers: resolved.layers,
    locked: resolved.locked,
    lockedSections: lockedSections(cachedManaged),
    errors: resolved.errors,
    loadedAt: Date.now(),
  };
  await syncNetworkRules(cached);
  for (const fn of listeners) {
    try {
      fn(cached);
    } catch (e) {
      console.warn('[abg] policy listener failed', e);
    }
  }
  return cached;
}

/** Persist the user-editable layer. Rejects a policy that will not validate. */
export async function saveLocalPolicy(policy) {
  const errors = validatePolicy(policy);
  if (errors.length) return { ok: false, errors };
  if (cachedManaged?.locked) {
    return { ok: false, errors: ['Policy is locked by your administrator'] };
  }
  await local.set({ [STORE.POLICY]: policy });
  const merged = await reload();
  return { ok: true, policy: merged };
}

export async function resetLocalPolicy() {
  await local.remove(STORE.POLICY);
  return reload();
}

export async function getLocalPolicy() {
  return getValue(STORE.POLICY, null);
}

export function getManagedPolicy() {
  return cachedManaged;
}

/**
 * Network-level enforcement.
 *
 * Content-script interception cannot see traffic an agent's *extension* sends
 * from its own context, so denylisted hosts and (in lockdown) model APIs are
 * additionally blocked with declarativeNetRequest. Requests this extension
 * itself makes are never matched, or forwarding would deadlock.
 */
export async function syncNetworkRules(policy) {
  if (!chrome.declarativeNetRequest?.updateDynamicRules) return;

  const blockHosts = new Set();
  for (const pattern of policy.siteClasses?.denylist || []) {
    const host = hostOf(`https://${String(pattern).replace(/^\*\.\/?/, '').replace(/^https?:\/\//, '')}`);
    if (host) blockHosts.add(host);
  }
  if (policy.mode === MODE.LOCKDOWN && policy.network?.blockModelApisInLockdown) {
    for (const h of AI_API_HOSTS) blockHosts.add(h);
  }

  const rules = [...blockHosts].slice(0, 100).map((host, i) => ({
    id: DNR_RULE_BASE + i,
    priority: 1,
    action: { type: 'block' },
    condition: {
      requestDomains: [host],
      excludedInitiatorDomains: [],
      resourceTypes: [
        'main_frame', 'sub_frame', 'xmlhttprequest', 'websocket', 'other', 'script', 'ping',
      ],
    },
  }));

  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existing.filter((r) => r.id >= DNR_RULE_BASE && r.id < DNR_RULE_BASE + 1000).map((r) => r.id);
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules: rules });
  } catch (e) {
    console.warn('[abg] could not sync network rules', e);
  }
}

/** Watch for an admin pushing a new managed policy mid-session. */
export function watchManagedChanges() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'managed') reload();
  });
}
