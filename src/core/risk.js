/**
 * Risk scoring (0-100).
 *
 * The score is advisory: policy decides, risk explains. It exists so a reviewer
 * staring at 4,000 audit rows can sort them, and so the popup can show a tab's
 * exposure without the user reading every rule.
 */

import { ACTION, ACTOR, SEVERITY_RANK, SITE_CLASS } from './constants.js';
import { clamp } from './util.js';

/** Inherent cost of the action if it turns out to be wrong. */
export const ACTION_BASE_RISK = {
  [ACTION.CLICK]: 10,
  [ACTION.INPUT]: 12,
  [ACTION.FORM_SUBMIT]: 30,
  [ACTION.NAVIGATE]: 8,
  [ACTION.DOWNLOAD]: 25,
  [ACTION.UPLOAD]: 40,
  [ACTION.CLIPBOARD_READ]: 20,
  [ACTION.CLIPBOARD_WRITE]: 10,
  [ACTION.AI_EGRESS]: 25,
  [ACTION.PROMPT_SUBMIT]: 20,
  [ACTION.EXTENSION_SEEN]: 5,
};

/** Additive modifiers keyed on facts the sensors report about the target. */
export const TARGET_MODIFIERS = {
  isCredentialField: 30,
  isPaymentField: 30,
  isFileInput: 15,
  crossOrigin: 12,
  destructiveLabel: 22,
  financialLabel: 22,
  externalShare: 18,
  hiddenElement: 14,
  iframeThirdParty: 10,
  newTab: 4,
};

/** Words that mean "this click is hard to undo" in most product UIs. */
export const DESTRUCTIVE_PATTERNS = [
  /\b(delete|remove|destroy|erase|wipe|purge|revoke|terminate|deactivate|close account|drop table)\b/i,
  /\b(uninstall|reset|factory reset|clear all)\b/i,
];

export const FINANCIAL_PATTERNS = [
  /\b(pay|payment|purchase|buy now|checkout|order|subscribe|transfer|wire|send money|withdraw|invoice|refund)\b/i,
  /\b(approve|authorize|sign|confirm transaction)\b/i,
];

export const SHARE_PATTERNS = [
  /\b(share|publish|make public|invite|send to|export|grant access|add member)\b/i,
];

/** Classify a button/link label so a click can be judged by what it says. */
export function labelFlags(text) {
  const t = String(text || '');
  return {
    destructiveLabel: DESTRUCTIVE_PATTERNS.some((r) => r.test(t)),
    financialLabel: FINANCIAL_PATTERNS.some((r) => r.test(t)),
    externalShare: SHARE_PATTERNS.some((r) => r.test(t)),
  };
}

/**
 * @param {object} action normalised action record
 * @returns {{score:number, band:string, factors:Array<{name:string,points:number}>}}
 */
export function scoreAction(action = {}) {
  const factors = [];
  const add = (name, points) => {
    if (points) factors.push({ name, points });
  };

  const base = ACTION_BASE_RISK[action.type] ?? 10;
  add(`action:${action.type || 'unknown'}`, base);

  const target = action.target || {};
  for (const [flag, points] of Object.entries(TARGET_MODIFIERS)) {
    if (target[flag]) add(flag, points);
  }

  const classes = action.site?.classes || [];
  if (classes.includes(SITE_CLASS.SENSITIVE)) add('site:sensitive', 20);
  if (classes.includes(SITE_CLASS.DENYLISTED)) add('site:denylisted', 25);
  if (classes.includes(SITE_CLASS.AI_PROVIDER)) add('site:ai_provider', 8);
  if (classes.includes(SITE_CLASS.ALLOWLISTED)) add('site:allowlisted', -15);

  const dlp = action.data?.dlp || [];
  if (dlp.length) {
    const worst = dlp.reduce((acc, f) => Math.max(acc, SEVERITY_RANK[f.severity] || 0), 0);
    add('dlp', [0, 8, 16, 26, 34][worst] ?? 0);
  }

  const actor = action.actor || {};
  if (actor.kind === ACTOR.AGENT) add('actor:agent', Math.round(15 * (actor.confidence ?? 1)));
  else if (actor.kind === ACTOR.UNKNOWN) add('actor:unknown', 5);
  else add('actor:human', -10);

  if (action.session?.actionsInWindow > 30) add('burst', 10);

  const score = clamp(Math.round(factors.reduce((sum, f) => sum + f.points, 0)), 0, 100);
  return { score, band: band(score), factors };
}

export function band(score) {
  if (score >= 75) return 'critical';
  if (score >= 50) return 'high';
  if (score >= 25) return 'medium';
  return 'low';
}
