/**
 * The policy the extension ships with.
 *
 * It is deliberately opinionated but not paralysing: an agent can browse, read
 * and click ordinary things without friction, and hits a human checkpoint at
 * the places where a wrong action costs money, data, or access.
 *
 * Admins override this wholesale or piecemeal through Chrome's managed storage
 * (see enterprise/managed-policy-template.json); users override it locally
 * unless `locked` is set by the admin layer.
 */

import { ACTION, ACTOR, DECISION, MODE, SEVERITY, SITE_CLASS } from './constants.js';
import { DEFAULT_SENSITIVE_PATTERNS } from './sites.js';

export const POLICY_VERSION = 1;

export const DEFAULT_POLICY = {
  version: POLICY_VERSION,
  mode: MODE.GUARDRAIL,
  defaultDecision: DECISION.LOG,
  locked: false,

  agentDetection: {
    /** Confidence at which an actor is treated as an agent. */
    minConfidence: 0.6,
    /** Patch DOM APIs in the page's MAIN world to attribute scripted actions. */
    deepInstrumentation: true,
    /** Watch network egress to model providers. */
    networkWatch: true,
    /** Inventory installed extensions and flag agentic capability. */
    extensionInventory: true,
  },

  siteClasses: {
    /** Extra AI surfaces beyond the built-in catalogue (e.g. an internal LLM). */
    aiProviders: [],
    sensitive: DEFAULT_SENSITIVE_PATTERNS,
    /** Agents may act freely here. Matches short-circuit the rule ladder. */
    allowlist: [],
    /** Agents may not act here at all. */
    denylist: [],
  },

  dlp: {
    enabled: true,
    /** Detector ids to run; null means every built-in detector. */
    enabledDetectors: null,
    customPatterns: [],
    /** Max characters of a single field/prompt scanned per action. */
    maxScanChars: 20000,
    /** Keep a redacted sample of scanned text on the audit record. */
    storeSamples: true,
  },

  budgets: {
    maxActionsPerMinute: 60,
    maxNavigationsPerSession: 100,
    maxRiskScorePerSession: 1500,
  },

  network: {
    /** In lockdown, also block model APIs at the network layer (catches other
     *  extensions' traffic, which content scripts cannot see). */
    blockModelApisInLockdown: false,
    /** Watch and DLP-scan request bodies bound for model providers. */
    scanEgressBodies: true,
  },

  audit: {
    retentionDays: 30,
    maxRecords: 5000,
    /** Optional SIEM/webhook forwarding. */
    forward: { enabled: false, url: '', headerName: 'Authorization', headerValue: '', batchSize: 25 },
  },

  notifications: {
    onBlock: true,
    onApprovalRequest: true,
    onAgentSessionStart: false,
  },

  approvals: {
    /** Seconds an approval prompt waits before it auto-denies. */
    timeoutSeconds: 60,
    /** Decision applied when the prompt times out. */
    onTimeout: DECISION.BLOCK,
    /** Let a human approve the same action shape for the rest of the session. */
    allowRememberForSession: true,
  },

  rules: [
    {
      id: 'allowlisted-sites',
      description: 'Sites explicitly allowlisted by the admin are exempt from agent rules',
      override: true,
      when: { siteClasses: [SITE_CLASS.ALLOWLISTED] },
      then: { decision: DECISION.ALLOW, reason: 'Site is on the agent allowlist' },
    },
    {
      id: 'denylisted-sites',
      description: 'Agents may not act on denylisted sites',
      when: { siteClasses: [SITE_CLASS.DENYLISTED], actorKinds: [ACTOR.AGENT, ACTOR.UNKNOWN], minConfidence: 0.5 },
      then: { decision: DECISION.BLOCK, reason: 'Site is on the agent denylist', notify: true },
    },
    {
      id: 'agent-credential-entry',
      description: 'An agent must never type into a password or credential field',
      when: {
        actorKinds: [ACTOR.AGENT, ACTOR.UNKNOWN],
        minConfidence: 0.5,
        actionTypes: [ACTION.INPUT, ACTION.FORM_SUBMIT],
        targetFlags: ['isCredentialField'],
      },
      then: { decision: DECISION.BLOCK, reason: 'Agents are not permitted to enter credentials', notify: true },
    },
    {
      id: 'agent-payment-action',
      description: 'Payment and money-movement actions need a human',
      when: {
        actorKinds: [ACTOR.AGENT, ACTOR.UNKNOWN],
        minConfidence: 0.5,
        targetFlags: ['isPaymentField', 'financialLabel'],
      },
      then: {
        decision: DECISION.REQUIRE_APPROVAL,
        reason: 'Money-movement action proposed by an agent',
        requireJustification: true,
        notify: true,
      },
    },
    {
      id: 'agent-destructive-click',
      description: 'Destructive controls (delete, revoke, terminate) need a human',
      when: {
        actorKinds: [ACTOR.AGENT, ACTOR.UNKNOWN],
        minConfidence: 0.5,
        actionTypes: [ACTION.CLICK, ACTION.FORM_SUBMIT],
        targetFlags: ['destructiveLabel'],
      },
      then: { decision: DECISION.REQUIRE_APPROVAL, reason: 'Destructive action proposed by an agent' },
    },
    {
      id: 'agent-on-sensitive-site',
      description: 'Any agent action on a sensitive site is checkpointed',
      when: {
        actorKinds: [ACTOR.AGENT],
        siteClasses: [SITE_CLASS.SENSITIVE],
        actionTypes: [ACTION.CLICK, ACTION.INPUT, ACTION.FORM_SUBMIT, ACTION.UPLOAD, ACTION.DOWNLOAD],
      },
      then: { decision: DECISION.REQUIRE_APPROVAL, reason: 'Agent action on a sensitive site' },
    },
    {
      id: 'secrets-to-model-provider',
      description: 'Credentials and keys must not be sent to a model provider',
      when: {
        siteClasses: [SITE_CLASS.AI_PROVIDER],
        actionTypes: [ACTION.INPUT, ACTION.FORM_SUBMIT, ACTION.PROMPT_SUBMIT, ACTION.AI_EGRESS, ACTION.UPLOAD],
        dlpAtLeast: SEVERITY.HIGH,
      },
      then: {
        decision: DECISION.BLOCK,
        reason: 'High-severity secret detected in content bound for a model provider',
        remediation: 'redact',
        notify: true,
      },
    },
    {
      id: 'pii-to-model-provider',
      description: 'Personal data bound for a model provider is flagged',
      when: {
        siteClasses: [SITE_CLASS.AI_PROVIDER],
        actionTypes: [ACTION.INPUT, ACTION.FORM_SUBMIT, ACTION.PROMPT_SUBMIT, ACTION.AI_EGRESS],
        dlpAtLeast: SEVERITY.LOW,
      },
      then: { decision: DECISION.WARN, reason: 'Personal data detected in content bound for a model provider' },
    },
    {
      id: 'agent-file-upload',
      description: 'Agent-initiated uploads need a human',
      when: { actorKinds: [ACTOR.AGENT, ACTOR.UNKNOWN], minConfidence: 0.5, actionTypes: [ACTION.UPLOAD] },
      then: { decision: DECISION.REQUIRE_APPROVAL, reason: 'Agent proposed a file upload' },
    },
    {
      id: 'agent-download',
      description: 'Agent-initiated downloads are recorded and surfaced',
      when: { actorKinds: [ACTOR.AGENT], actionTypes: [ACTION.DOWNLOAD] },
      then: { decision: DECISION.WARN, reason: 'Agent initiated a download' },
    },
    {
      id: 'agent-clipboard-read',
      description: 'Reading the clipboard exposes whatever the human copied last',
      when: { actorKinds: [ACTOR.AGENT, ACTOR.UNKNOWN], minConfidence: 0.5, actionTypes: [ACTION.CLIPBOARD_READ] },
      then: { decision: DECISION.REQUIRE_APPROVAL, reason: 'Agent tried to read the clipboard' },
    },
    {
      id: 'cross-origin-agent-submit',
      description: 'Form data leaving the current origin under agent control',
      when: {
        actorKinds: [ACTOR.AGENT],
        actionTypes: [ACTION.FORM_SUBMIT],
        targetFlags: ['crossOrigin'],
      },
      then: { decision: DECISION.WARN, reason: 'Agent submitted data to a third-party origin' },
    },
    {
      id: 'unattributed-extension-model-traffic',
      description: 'Model API traffic from an extension that is not on the approved list',
      when: {
        actionTypes: [ACTION.AI_EGRESS],
        hasExtensionAttribution: true,
      },
      then: { decision: DECISION.WARN, reason: 'An installed extension is calling a model provider' },
    },
    {
      id: 'high-risk-catchall',
      description: 'Anything the risk model scores as critical gets a human look',
      when: { actorKinds: [ACTOR.AGENT], riskAtLeast: 80 },
      then: { decision: DECISION.REQUIRE_APPROVAL, reason: 'Action scored as critical risk' },
    },
  ],
};

/** Fresh copy, so callers can mutate without corrupting the shipped default. */
export function defaultPolicy() {
  return structuredClone(DEFAULT_POLICY);
}
