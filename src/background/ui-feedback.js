/** Badge, title and notification surface for decisions the user should notice. */

import { DECISION } from '../core/constants.js';

const COLORS = {
  [DECISION.BLOCK]: '#b91c1c',
  [DECISION.REQUIRE_APPROVAL]: '#b45309',
  [DECISION.WARN]: '#a16207',
  agent: '#1d4ed8',
  idle: '#64748b',
};

const counts = new Map(); // tabId -> {blocked, approvals, warnings, agent}

export function bump(tabId, field) {
  if (typeof tabId !== 'number' || tabId < 0) return;
  const c = counts.get(tabId) || { blocked: 0, approvals: 0, warnings: 0, agent: false };
  if (field === 'agent') c.agent = true;
  else c[field] = (c[field] || 0) + 1;
  counts.set(tabId, c);
  paint(tabId);
}

export function tabCounts(tabId) {
  return counts.get(tabId) || { blocked: 0, approvals: 0, warnings: 0, agent: false };
}

export function reset(tabId) {
  counts.delete(tabId);
  paint(tabId);
}

function paint(tabId) {
  const c = counts.get(tabId);
  if (!chrome.action?.setBadgeText) return;
  if (!c) {
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
    return;
  }
  const enforced = c.blocked + c.approvals;
  const text = enforced > 0 ? String(Math.min(enforced, 99)) : c.warnings > 0 ? '!' : c.agent ? '•' : '';
  const color = c.blocked > 0 ? COLORS[DECISION.BLOCK] : c.approvals > 0 ? COLORS[DECISION.REQUIRE_APPROVAL] : c.warnings > 0 ? COLORS[DECISION.WARN] : COLORS.agent;
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {});
}

/** Desktop notification for the events a user must not miss. */
export function notify({ title, message, id }) {
  if (!chrome.notifications?.create) return;
  chrome.notifications.create(id || undefined, {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('assets/icons/icon128.png'),
    title,
    message,
    priority: 2,
  }, () => void chrome.runtime.lastError);
}
