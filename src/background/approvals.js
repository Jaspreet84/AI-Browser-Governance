/**
 * Human-in-the-loop approvals.
 *
 * A request is created when policy says `require_approval`, and resolves when a
 * human answers in the page overlay — or when it times out, which counts as a
 * denial by default. Timeouts matter: an unattended machine must fail closed,
 * not sit forever with a paused agent and an unanswered prompt.
 */

import { newId } from '../core/util.js';

const pending = new Map();
/** Approvals a human chose to remember, keyed by session + action shape. */
const remembered = new Map();

export function actionShape(action) {
  const t = action.target || {};
  return [action.type, action.origin || '', t.selector || t.label || '', t.isPaymentField ? 'pay' : ''].join('|');
}

export function create({ action, decisionResult, tabId, frameId, timeoutSeconds = 60, onTimeout = 'block', sessionId = '' }) {
  const id = newId('apr');
  const request = {
    id,
    tabId,
    frameId,
    sessionId,
    createdAt: Date.now(),
    expiresAt: Date.now() + timeoutSeconds * 1000,
    action,
    decisionResult,
    status: 'pending',
  };

  const promise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ id, approved: false, timedOut: true, decision: onTimeout, reason: 'Approval timed out' });
      }
    }, timeoutSeconds * 1000);
    request._resolve = (result) => {
      clearTimeout(timer);
      pending.delete(id);
      resolve(result);
    };
  });

  pending.set(id, request);
  return { id, request, promise };
}

export function resolveRequest(id, { approved, justification = '', remember = false, sessionId = '' }) {
  const request = pending.get(id);
  if (!request) return false;
  if (remember && approved && sessionId) {
    remembered.set(`${sessionId}::${actionShape(request.action)}`, Date.now());
  }
  request.status = approved ? 'approved' : 'denied';
  request._resolve({ id, approved, justification, remember, timedOut: false, decision: approved ? 'allow' : 'block' });
  return true;
}

export function isRemembered(sessionId, action) {
  if (!sessionId) return false;
  return remembered.has(`${sessionId}::${actionShape(action)}`);
}

export function forgetSession(sessionId) {
  for (const key of remembered.keys()) {
    if (key.startsWith(`${sessionId}::`)) remembered.delete(key);
  }
}

export function list() {
  return [...pending.values()].map(({ _resolve, ...rest }) => rest);
}

export function countPending() {
  return pending.size;
}

/** Cancel everything for a tab that navigated away or closed. */
export function cancelForTab(tabId, reason = 'tab closed') {
  for (const [id, req] of pending) {
    if (req.tabId === tabId) {
      pending.delete(id);
      req._resolve({ id, approved: false, timedOut: false, decision: 'block', reason });
    }
  }
}
