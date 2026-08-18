/**
 * The policy engine.
 *
 * Pure function of (action, policy, context) -> decision. It never touches
 * storage, the network, or the DOM, which is what makes the governance
 * behaviour of this extension testable and reviewable by people who do not
 * read Chrome extension code.
 */

import {
  ACTOR,
  DECISION,
  DECISION_RANK,
  MODE,
  SEVERITY_RANK,
} from './constants.js';
import { atLeast, maxSeverity } from './dlp.js';
import { scoreAction } from './risk.js';
import { classifySite } from './sites.js';
import { matchesAny } from './util.js';

/** Pick the more restrictive of two decisions. */
export function strongest(a, b) {
  return (DECISION_RANK[a] ?? 0) >= (DECISION_RANK[b] ?? 0) ? a : b;
}

function whenMatches(rule, ctx) {
  const w = rule.when || {};
  const { action, site, dlpSeverity, risk } = ctx;

  if (w.actorKinds?.length && !w.actorKinds.includes(action.actor?.kind)) return false;
  if (typeof w.minConfidence === 'number' && (action.actor?.confidence ?? 0) < w.minConfidence) return false;
  if (w.actionTypes?.length && !w.actionTypes.includes(action.type)) return false;
  if (w.siteClasses?.length && !w.siteClasses.some((c) => site.classes.includes(c))) return false;
  if (w.urlPatterns?.length && !matchesAny(action.url, w.urlPatterns)) return false;
  if (w.excludeUrlPatterns?.length && matchesAny(action.url, w.excludeUrlPatterns)) return false;

  const target = action.target || {};
  if (w.targetFlags?.length && !w.targetFlags.some((f) => target[f])) return false;
  if (w.allTargetFlags?.length && !w.allTargetFlags.every((f) => target[f])) return false;

  if (w.dlpAtLeast && !atLeast(dlpSeverity, w.dlpAtLeast)) return false;
  if (w.dlpDetectors?.length) {
    const ids = (action.data?.dlp || []).map((f) => f.detectorId);
    if (!w.dlpDetectors.some((d) => ids.includes(d))) return false;
  }

  if (typeof w.riskAtLeast === 'number' && risk.score < w.riskAtLeast) return false;

  const extId = action.actor?.attribution?.extensionId;
  if (w.extensionIdIn?.length && !w.extensionIdIn.includes(extId)) return false;
  if (w.extensionIdNotIn?.length && extId && w.extensionIdNotIn.includes(extId)) return false;
  if (w.hasExtensionAttribution === true && !extId) return false;
  if (w.hasExtensionAttribution === false && extId) return false;

  return true;
}

/**
 * Evaluate one proposed action.
 *
 * @param {object} action  normalised action record from a sensor
 * @param {object} policy  effective policy (defaults <- managed <- local)
 * @param {object} [context]
 * @param {boolean} [context.killSwitch]
 * @param {object}  [context.session] running counters for the tab/session
 * @returns {{decision, reason, matchedRules, risk, obligations, mode, trace, site, wouldHaveBeen}}
 */
export function evaluate(action = {}, policy = {}, context = {}) {
  const mode = policy.mode || MODE.GUARDRAIL;
  const site = action.site?.classes ? action.site : classifySite(action.url, policy);
  const dlpSeverity = maxSeverity(action.data?.dlp || []);
  const enriched = { ...action, site };
  const risk = scoreAction(enriched);

  const trace = [];
  const obligations = { redact: false, justification: false, notify: false };
  let decision = policy.defaultDecision || DECISION.LOG;
  let reason = 'Default posture';
  const matchedRules = [];

  const ctx = { action: enriched, site, dlpSeverity, risk };

  // 1. Rule pass. An `override` rule short-circuits the ladder entirely, which
  //    is how allowlists stay meaningful.
  for (const rule of policy.rules || []) {
    if (rule.enabled === false) continue;
    const hit = whenMatches(rule, ctx);
    trace.push({ id: rule.id, matched: hit });
    if (!hit) continue;
    matchedRules.push(rule.id);
    const then = rule.then || {};
    if (then.remediation === 'redact') obligations.redact = true;
    if (then.requireJustification) obligations.justification = true;
    if (then.notify) obligations.notify = true;

    if (rule.override) {
      decision = then.decision || DECISION.ALLOW;
      reason = then.reason || rule.description || rule.id;
      return finish({ decision, reason, matchedRules, risk, obligations, mode, trace, site, overridden: true, context, policy, action: enriched });
    }
    const next = strongest(decision, then.decision || DECISION.LOG);
    if (next !== decision) {
      decision = next;
      reason = then.reason || rule.description || rule.id;
    }
  }

  // 2. Budgets: sustained agent activity is its own risk, independent of what
  //    any single action does.
  const budgets = policy.budgets || {};
  const session = context.session || {};
  if (action.actor?.kind === ACTOR.AGENT) {
    if (budgets.maxActionsPerMinute && session.actionsInWindow > budgets.maxActionsPerMinute) {
      decision = strongest(decision, DECISION.REQUIRE_APPROVAL);
      reason = `Agent exceeded ${budgets.maxActionsPerMinute} actions/minute`;
      matchedRules.push('budget:actions_per_minute');
    }
    if (budgets.maxRiskScorePerSession && session.riskSpent > budgets.maxRiskScorePerSession) {
      decision = strongest(decision, DECISION.REQUIRE_APPROVAL);
      reason = `Session risk budget (${budgets.maxRiskScorePerSession}) exhausted`;
      matchedRules.push('budget:session_risk');
    }
    if (budgets.maxNavigationsPerSession && session.navigations > budgets.maxNavigationsPerSession) {
      decision = strongest(decision, DECISION.WARN);
      matchedRules.push('budget:navigations');
    }
  }

  return finish({ decision, reason, matchedRules, risk, obligations, mode, trace, site, context, policy, action: enriched });
}

/**
 * Apply posture: the kill switch, monitor-mode downgrades and lockdown-mode
 * escalations are deliberately applied *after* the rules so the audit record
 * can show both what the rules said and what the posture did to it.
 */
function finish(state) {
  const { context = {}, policy = {}, action = {} } = state;
  const mode = state.mode;
  let decision = state.decision;
  let reason = state.reason;
  const rulesSaid = decision;

  const isAgentish = action.actor?.kind === ACTOR.AGENT
    || (action.actor?.kind === ACTOR.UNKNOWN && (action.actor?.confidence ?? 0) >= (policy.agentDetection?.minConfidence ?? 0.6));

  if (context.killSwitch && isAgentish) {
    decision = DECISION.BLOCK;
    reason = 'Kill switch engaged: all agent actions are blocked';
  } else if (mode === MODE.LOCKDOWN && isAgentish) {
    decision = strongest(decision, DECISION.REQUIRE_APPROVAL);
    if (decision !== rulesSaid) reason = 'Lockdown mode: every agent action needs human approval';
  } else if (mode === MODE.MONITOR) {
    // Observe-only: never alter the page, but keep the counterfactual.
    if (DECISION_RANK[decision] > DECISION_RANK[DECISION.WARN]) {
      decision = DECISION.LOG;
    }
  }

  return {
    decision,
    reason,
    matchedRules: state.matchedRules,
    risk: state.risk,
    obligations: state.obligations,
    mode,
    site: state.site,
    trace: state.trace,
    overridden: Boolean(state.overridden),
    wouldHaveBeen: rulesSaid === decision ? null : rulesSaid,
  };
}

/** True when the decision requires the content script to stop the action. */
export function isEnforcing(decision) {
  return decision === DECISION.BLOCK || decision === DECISION.REQUIRE_APPROVAL;
}

/**
 * Validate a policy object before it is stored. Returns a list of problems;
 * an empty list means the policy is safe to install.
 */
export function validatePolicy(policy) {
  const errors = [];
  if (!policy || typeof policy !== 'object') return ['Policy must be an object'];
  if (policy.mode && !Object.values(MODE).includes(policy.mode)) {
    errors.push(`Unknown mode: ${policy.mode}`);
  }
  if (policy.defaultDecision && !(policy.defaultDecision in DECISION_RANK)) {
    errors.push(`Unknown defaultDecision: ${policy.defaultDecision}`);
  }
  if (policy.rules && !Array.isArray(policy.rules)) errors.push('rules must be an array');
  for (const [i, rule] of (policy.rules || []).entries()) {
    if (!rule || typeof rule !== 'object') {
      errors.push(`rules[${i}] must be an object`);
      continue;
    }
    if (!rule.id) errors.push(`rules[${i}] is missing an id`);
    const d = rule.then?.decision;
    if (d && !(d in DECISION_RANK)) errors.push(`rules[${i}] (${rule.id}) has unknown decision: ${d}`);
    const sev = rule.when?.dlpAtLeast;
    if (sev && !(sev in SEVERITY_RANK)) errors.push(`rules[${i}] (${rule.id}) has unknown severity: ${sev}`);
    for (const key of ['urlPatterns', 'excludeUrlPatterns']) {
      for (const p of rule.when?.[key] || []) {
        if (typeof p === 'string' && p.startsWith('re:')) {
          try {
            new RegExp(p.slice(3));
          } catch (e) {
            errors.push(`rules[${i}] (${rule.id}) has an invalid regex in ${key}: ${p}`);
          }
        }
      }
    }
  }
  for (const p of policy.dlp?.customPatterns || []) {
    try {
      new RegExp(p.regex, p.flags || 'g');
    } catch {
      errors.push(`Custom DLP pattern ${p.id || p.name || '?'} has an invalid regex`);
    }
  }
  return errors;
}
