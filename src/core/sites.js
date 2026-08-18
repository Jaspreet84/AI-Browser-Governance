/**
 * Site classification: turns a URL into the classes rules are written against.
 * Admin lists win over the built-in catalogue, so a company can declare its own
 * internal assistant an AI provider, or exempt its own admin console.
 */

import { SITE_CLASS } from './constants.js';
import { AI_API_HOSTS, AI_UI_HOSTS } from './agent-signals.js';
import { hostOf, matchesAny } from './util.js';

/** Categories of sites where an agent mistake is expensive to undo. */
export const DEFAULT_SENSITIVE_PATTERNS = [
  '*.bank',
  'chase.com',
  'wellsfargo.com',
  'paypal.com',
  'stripe.com/dashboard/*',
  'console.aws.amazon.com',
  'portal.azure.com',
  'console.cloud.google.com',
  'admin.google.com',
  'github.com/*/settings/*',
  'github.com/settings/*',
  'gitlab.com/*/-/settings/*',
  'app.okta.com',
  'login.microsoftonline.com',
  'accounts.google.com',
  'id.atlassian.com',
  'mail.google.com',
  'outlook.office.com',
  'workspace.google.com',
  '*.myshopify.com/admin/*',
  '*.salesforce.com',
  '*.workday.com',
];

/**
 * @returns {{classes:string[], primary:string, provider:string|null}}
 */
export function classifySite(url, policy = {}) {
  const classes = new Set();
  const lists = policy.siteClasses || {};
  const host = hostOf(url);
  if (!host) return { classes: [SITE_CLASS.UNCLASSIFIED], primary: SITE_CLASS.UNCLASSIFIED, provider: null };

  const aiPatterns = [...(lists.aiProviders || []), ...AI_UI_HOSTS, ...AI_API_HOSTS];
  if (matchesAny(url, aiPatterns)) classes.add(SITE_CLASS.AI_PROVIDER);

  const sensitive = lists.sensitive || DEFAULT_SENSITIVE_PATTERNS;
  if (matchesAny(url, sensitive)) classes.add(SITE_CLASS.SENSITIVE);

  if (matchesAny(url, lists.allowlist || [])) classes.add(SITE_CLASS.ALLOWLISTED);
  if (matchesAny(url, lists.denylist || [])) classes.add(SITE_CLASS.DENYLISTED);

  if (classes.size === 0) classes.add(SITE_CLASS.UNCLASSIFIED);

  // Precedence when a site lands in several buckets: an explicit deny beats an
  // explicit allow, and both beat inferred categories.
  const order = [
    SITE_CLASS.DENYLISTED,
    SITE_CLASS.SENSITIVE,
    SITE_CLASS.AI_PROVIDER,
    SITE_CLASS.ALLOWLISTED,
    SITE_CLASS.UNCLASSIFIED,
  ];
  const list = [...classes];
  const primary = order.find((c) => classes.has(c)) || SITE_CLASS.UNCLASSIFIED;
  return { classes: list, primary, provider: providerFor(host) };
}

/** Best-effort provider label for reporting ("who is the model behind this?"). */
export function providerFor(host) {
  const h = String(host || '').toLowerCase();
  const map = [
    [/(^|\.)anthropic\.com$|(^|\.)claude\.ai$/, 'Anthropic'],
    [/(^|\.)openai\.com$|(^|\.)chatgpt\.com$|openai\.azure\.com$/, 'OpenAI'],
    [/googleapis\.com$|(^|\.)gemini\.google\.com$|notebooklm\.google\.com$/, 'Google'],
    [/(^|\.)copilot\.microsoft\.com$|(^|\.)bing\.com$/, 'Microsoft'],
    [/(^|\.)perplexity\.ai$/, 'Perplexity'],
    [/(^|\.)mistral\.ai$/, 'Mistral'],
    [/(^|\.)cohere\.(ai|com)$/, 'Cohere'],
    [/amazonaws\.com$/, 'AWS Bedrock'],
    [/(^|\.)groq\.com$/, 'Groq'],
    [/(^|\.)x\.ai$|(^|\.)grok\.com$/, 'xAI'],
    [/(^|\.)deepseek\.com$/, 'DeepSeek'],
    [/(^|\.)openrouter\.ai$/, 'OpenRouter'],
    [/(^|\.)huggingface\.co$/, 'Hugging Face'],
    [/(^|\.)together\.xyz$/, 'Together'],
    [/(^|\.)poe\.com$/, 'Poe'],
  ];
  for (const [re, name] of map) if (re.test(h)) return name;
  return null;
}
