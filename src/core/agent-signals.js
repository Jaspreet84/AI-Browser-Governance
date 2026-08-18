/**
 * Actor attribution.
 *
 * No single browser signal proves "an AI agent did this" — `isTrusted:false`
 * also describes a jQuery plugin, and `navigator.webdriver` also describes a QA
 * suite. So we fuse weighted, decaying evidence into a confidence score and let
 * policy decide what confidence is worth acting on.
 */

import { ACTOR, SIGNAL } from './constants.js';
import { clamp } from './util.js';

/**
 * weight  - how much this observation moves confidence on its own (0..1)
 * halfLife- ms after which the observation counts half as much; null = the
 *           signal describes the environment and does not decay in a session
 * negative- evidence *against* agent control
 */
export const SIGNAL_WEIGHTS = {
  [SIGNAL.WEBDRIVER_FLAG]: { weight: 0.9, halfLife: null, label: 'navigator.webdriver is set' },
  [SIGNAL.CDP_ARTIFACT]: { weight: 0.85, halfLife: null, label: 'DevTools-protocol automation artifact' },
  [SIGNAL.AUTOMATION_GLOBAL]: { weight: 0.8, halfLife: null, label: 'Automation framework global present' },
  [SIGNAL.UNTRUSTED_EVENT]: { weight: 0.75, halfLife: 30_000, label: 'Synthetic (untrusted) UI event' },
  [SIGNAL.EXTENSION_INITIATOR]: { weight: 0.7, halfLife: 60_000, label: 'Request initiated by an extension' },
  [SIGNAL.PROGRAMMATIC_CLICK]: { weight: 0.6, halfLife: 30_000, label: 'element.click() called from script' },
  [SIGNAL.PROGRAMMATIC_SUBMIT]: { weight: 0.6, halfLife: 30_000, label: 'form.submit() called from script' },
  [SIGNAL.SYNTHETIC_VALUE_SET]: { weight: 0.55, halfLife: 30_000, label: 'Field value set without keystrokes' },
  [SIGNAL.AI_SDK_TRAFFIC]: { weight: 0.5, halfLife: 120_000, label: 'Model-provider API traffic from the page' },
  [SIGNAL.INHUMAN_CADENCE]: { weight: 0.5, halfLife: 20_000, label: 'Input cadence outside human range' },
  [SIGNAL.HEADLESS_HINT]: { weight: 0.4, halfLife: null, label: 'Headless browser fingerprint' },
  [SIGNAL.NO_POINTER_PATH]: { weight: 0.35, halfLife: 20_000, label: 'Click with no preceding pointer movement' },
  [SIGNAL.HUMAN_INPUT_RECENT]: { weight: 0.55, halfLife: 15_000, label: 'Trusted human input just before', negative: true },
};

/** Decay multiplier for an observation of age `ageMs`. */
export function decayFactor(ageMs, halfLife) {
  if (halfLife === null || halfLife === undefined) return 1;
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1;
  return Math.pow(0.5, ageMs / halfLife);
}

/**
 * Fuse observations into a verdict.
 *
 * @param {Array<{type:string, at?:number, weight?:number, detail?:any}>} signals
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {number} [opts.threshold] confidence at or above which we call it an agent
 * @returns {{kind:string, confidence:number, contributions:Array, reasons:string[]}}
 */
export function fuseSignals(signals = [], opts = {}) {
  const now = opts.now ?? Date.now();
  const threshold = opts.threshold ?? 0.6;

  let agentComplement = 1; // Π(1 - w) — noisy-OR accumulator for agent evidence
  let humanComplement = 1;
  const contributions = [];

  for (const s of signals) {
    const spec = SIGNAL_WEIGHTS[s?.type];
    if (!spec) continue;
    const base = typeof s.weight === 'number' ? clamp(s.weight, 0, 1) : spec.weight;
    const factor = decayFactor(now - (s.at ?? now), spec.halfLife);
    const effective = clamp(base * factor, 0, 0.99);
    if (effective <= 0.001) continue;
    if (spec.negative) humanComplement *= 1 - effective;
    else agentComplement *= 1 - effective;
    contributions.push({ type: s.type, label: spec.label, effective: Number(effective.toFixed(3)), detail: s.detail });
  }

  const agentEvidence = 1 - agentComplement;
  const humanEvidence = 1 - humanComplement;
  // Human evidence discounts rather than cancels: an agent can act in a tab a
  // human was just using, so recent typing lowers — never zeroes — suspicion.
  const confidence = clamp(agentEvidence * (1 - 0.6 * humanEvidence), 0, 1);

  let kind = ACTOR.UNKNOWN;
  if (confidence >= threshold) kind = ACTOR.AGENT;
  else if (humanEvidence > 0.3 && confidence < threshold * 0.5) kind = ACTOR.HUMAN;

  contributions.sort((a, b) => b.effective - a.effective);
  return {
    kind,
    confidence: Number(confidence.toFixed(3)),
    agentEvidence: Number(agentEvidence.toFixed(3)),
    humanEvidence: Number(humanEvidence.toFixed(3)),
    contributions,
    reasons: [...new Set(contributions.map((c) => c.label))].slice(0, 5),
  };
}

/**
 * Known automation / agent globals, checked in the page's MAIN world.
 * Presence is evidence of a driver, not of malice.
 */
export const AUTOMATION_GLOBALS = [
  '__playwright',
  '__pw_manual',
  '__PW_inspect',
  'playwright',
  '__puppeteer_evaluation_script__',
  '__puppeteer',
  'puppeteer',
  '_selenium',
  'callSelenium',
  '_Selenium_IDE_Recorder',
  '__selenium_unwrapped',
  '__webdriver_evaluate',
  '__driver_evaluate',
  '__webdriver_script_fn',
  '__fxdriver_evaluate',
  '__nightmare',
  'domAutomation',
  'domAutomationController',
  '__stagehand',
  '__browser_use',
  'browserUse',
  '__agentDriver',
];

/** Document-level artifacts left behind by ChromeDriver / CDP tooling. */
export const CDP_ARTIFACT_PREFIXES = ['$cdc_', '$chrome_asyncScriptInfo', 'cdc_adoQpoasnfa76pfcZLmcfl_'];

/**
 * Hosts whose traffic means "a model is being called". Used both to classify
 * pages and to attribute network egress to a provider.
 */
export const AI_API_HOSTS = [
  'api.anthropic.com',
  'api.openai.com',
  'api.mistral.ai',
  'api.cohere.ai',
  'api.perplexity.ai',
  'api.together.xyz',
  'api.groq.com',
  'api.deepseek.com',
  'api.x.ai',
  'generativelanguage.googleapis.com',
  'aiplatform.googleapis.com',
  'bedrock-runtime.us-east-1.amazonaws.com',
  'openai.azure.com',
  'api-inference.huggingface.co',
  'openrouter.ai',
];

/** Interactive assistant surfaces a human (or an agent) drives through the UI. */
export const AI_UI_HOSTS = [
  'claude.ai',
  'chatgpt.com',
  'chat.openai.com',
  'gemini.google.com',
  'copilot.microsoft.com',
  'www.bing.com',
  'perplexity.ai',
  'poe.com',
  'chat.mistral.ai',
  'grok.com',
  'x.ai',
  'huggingface.co',
  'notebooklm.google.com',
];

/** True when a URL looks like a call into a model provider's API. */
export function isModelApiUrl(url) {
  if (typeof url !== 'string') return false;
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return AI_API_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
    || /\.openai\.azure\.com$/.test(host)
    || /^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/.test(host);
}
