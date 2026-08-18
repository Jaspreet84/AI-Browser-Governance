/**
 * Agent session tracking.
 *
 * A "session" is a continuous stretch of agent-attributed activity in one tab.
 * It exists so budgets mean something (60 actions per minute, a risk budget per
 * session) and so the popup can say "this tab has been agent-driven for 4
 * minutes and spent 320 points of risk" instead of showing a wall of events.
 */

import { ACTOR } from './constants.js';
import { newId } from './util.js';

const WINDOW_MS = 60_000;
/** Idle gap after which the next agent action starts a new session. */
export const SESSION_IDLE_MS = 5 * 60_000;

export class SessionTracker {
  constructor({ idleMs = SESSION_IDLE_MS } = {}) {
    this.idleMs = idleMs;
    /** @type {Map<number, object>} tabId -> session */
    this.sessions = new Map();
  }

  /** Snapshot for a tab, or null when the tab has no agent session. */
  get(tabId) {
    return this.sessions.get(tabId) || null;
  }

  list() {
    return [...this.sessions.values()];
  }

  /**
   * Record an action against a tab's session and return the counters the policy
   * engine needs. Human actions refresh "lastHumanAt" but never open a session.
   *
   * @returns {{session:object|null, started:boolean, counters:object}}
   */
  record(tabId, action, now = Date.now()) {
    const isAgent = action.actor?.kind === ACTOR.AGENT;
    let session = this.sessions.get(tabId) || null;
    let started = false;

    if (session && now - session.lastActionAt > this.idleMs) {
      this.sessions.delete(tabId);
      session = null;
    }

    if (!isAgent) {
      if (session) session.lastHumanAt = now;
      return { session, started: false, counters: counters(session, now) };
    }

    if (!session) {
      session = {
        id: newId('sess'),
        tabId,
        startedAt: now,
        lastActionAt: now,
        lastHumanAt: 0,
        origin: action.origin || '',
        actions: 0,
        navigations: 0,
        blocked: 0,
        approvals: 0,
        denials: 0,
        riskSpent: 0,
        recent: [],
        topRules: {},
        peakConfidence: 0,
      };
      this.sessions.set(tabId, session);
      started = true;
    }

    session.lastActionAt = now;
    session.actions += 1;
    session.peakConfidence = Math.max(session.peakConfidence, action.actor?.confidence ?? 0);
    if (action.type === 'page.navigate') session.navigations += 1;
    session.recent.push(now);
    if (session.recent.length > 500) session.recent = session.recent.slice(-500);

    return { session, started, counters: counters(session, now) };
  }

  /** Fold the decision back in so budgets reflect what was actually allowed. */
  settle(tabId, decisionResult) {
    const session = this.sessions.get(tabId);
    if (!session) return;
    session.riskSpent += decisionResult?.risk?.score || 0;
    if (decisionResult?.decision === 'block') session.blocked += 1;
    for (const id of decisionResult?.matchedRules || []) {
      session.topRules[id] = (session.topRules[id] || 0) + 1;
    }
  }

  approved(tabId) {
    const s = this.sessions.get(tabId);
    if (s) s.approvals += 1;
  }

  denied(tabId) {
    const s = this.sessions.get(tabId);
    if (s) s.denials += 1;
  }

  end(tabId) {
    const s = this.sessions.get(tabId);
    this.sessions.delete(tabId);
    return s || null;
  }

  /** Drop sessions that have gone quiet; called from the SW's alarm. */
  reap(now = Date.now()) {
    const ended = [];
    for (const [tabId, s] of this.sessions) {
      if (now - s.lastActionAt > this.idleMs) {
        ended.push(s);
        this.sessions.delete(tabId);
      }
    }
    return ended;
  }

  /** Rehydrate after the service worker is torn down and restarted. */
  hydrate(list = []) {
    for (const s of list) {
      if (s && typeof s.tabId === 'number') this.sessions.set(s.tabId, s);
    }
  }
}

function counters(session, now) {
  if (!session) return { actionsInWindow: 0, riskSpent: 0, navigations: 0, ageMs: 0 };
  const actionsInWindow = session.recent.filter((t) => now - t <= WINDOW_MS).length;
  return {
    actionsInWindow,
    riskSpent: session.riskSpent,
    navigations: session.navigations,
    ageMs: now - session.startedAt,
  };
}
