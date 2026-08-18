/**
 * Shared vocabulary for the governance pipeline.
 *
 * Every module (content sensors, service worker, policy engine, audit log, UI)
 * speaks in these constants so that a decision recorded today can still be
 * interpreted by an auditor reading the log a year from now.
 */

/** What the extension does when a rule fires. Ordered least -> most restrictive. */
export const DECISION = {
  ALLOW: 'allow',
  LOG: 'log',
  WARN: 'warn',
  REQUIRE_APPROVAL: 'require_approval',
  BLOCK: 'block',
};

/** Severity ladder used to resolve competing rule matches. */
export const DECISION_RANK = {
  [DECISION.ALLOW]: 0,
  [DECISION.LOG]: 1,
  [DECISION.WARN]: 2,
  [DECISION.REQUIRE_APPROVAL]: 3,
  [DECISION.BLOCK]: 4,
};

/** Posture of the whole extension, set by admins or by the local operator. */
export const MODE = {
  /** Observe and record only. No page behaviour is altered. */
  MONITOR: 'monitor',
  /** Enforce the rule set: warn, ask for human approval, block. */
  GUARDRAIL: 'guardrail',
  /** Every agentic action needs a human approval, regardless of rules. */
  LOCKDOWN: 'lockdown',
};

/** Who the extension believes performed an action. */
export const ACTOR = {
  HUMAN: 'human',
  AGENT: 'agent',
  UNKNOWN: 'unknown',
};

/** Canonical action taxonomy. Sensors emit these; rules match on them. */
export const ACTION = {
  CLICK: 'element.click',
  INPUT: 'input.fill',
  FORM_SUBMIT: 'form.submit',
  NAVIGATE: 'page.navigate',
  DOWNLOAD: 'file.download',
  UPLOAD: 'file.upload',
  CLIPBOARD_READ: 'clipboard.read',
  CLIPBOARD_WRITE: 'clipboard.write',
  AI_EGRESS: 'network.ai_egress',
  PROMPT_SUBMIT: 'ai.prompt_submit',
  EXTENSION_SEEN: 'extension.inventory',
  SESSION_START: 'agent.session_start',
  SESSION_END: 'agent.session_end',
};

/** Signals that raise (or lower) our confidence that an agent is driving. */
export const SIGNAL = {
  UNTRUSTED_EVENT: 'untrusted_event',
  WEBDRIVER_FLAG: 'webdriver_flag',
  AUTOMATION_GLOBAL: 'automation_global',
  PROGRAMMATIC_CLICK: 'programmatic_click',
  PROGRAMMATIC_SUBMIT: 'programmatic_submit',
  SYNTHETIC_VALUE_SET: 'synthetic_value_set',
  INHUMAN_CADENCE: 'inhuman_cadence',
  NO_POINTER_PATH: 'no_pointer_path',
  HEADLESS_HINT: 'headless_hint',
  EXTENSION_INITIATOR: 'extension_initiator',
  AI_SDK_TRAFFIC: 'ai_sdk_traffic',
  CDP_ARTIFACT: 'cdp_artifact',
  HUMAN_INPUT_RECENT: 'human_input_recent',
};

/** DLP finding severities. */
export const SEVERITY = { LOW: 'low', MEDIUM: 'medium', HIGH: 'high', CRITICAL: 'critical' };

export const SEVERITY_RANK = {
  [SEVERITY.LOW]: 1,
  [SEVERITY.MEDIUM]: 2,
  [SEVERITY.HIGH]: 3,
  [SEVERITY.CRITICAL]: 4,
};

/** Site classes a URL can belong to. Rules match on these instead of raw hosts. */
export const SITE_CLASS = {
  AI_PROVIDER: 'ai_provider',
  SENSITIVE: 'sensitive',
  ALLOWLISTED: 'allowlisted',
  DENYLISTED: 'denylisted',
  UNCLASSIFIED: 'unclassified',
};

/** Message types on the runtime bus (content <-> service worker <-> UI). */
export const MSG = {
  ACTION_PROPOSED: 'action:proposed',
  ACTION_DECIDED: 'action:decided',
  SIGNAL_REPORT: 'signal:report',
  APPROVAL_REQUEST: 'approval:request',
  APPROVAL_RESULT: 'approval:result',
  APPROVAL_LIST: 'approval:list',
  STATE_QUERY: 'state:query',
  STATE_PUSH: 'state:push',
  POLICY_GET: 'policy:get',
  POLICY_SET: 'policy:set',
  POLICY_RESET: 'policy:reset',
  AUDIT_QUERY: 'audit:query',
  AUDIT_EXPORT: 'audit:export',
  AUDIT_VERIFY: 'audit:verify',
  AUDIT_CLEAR: 'audit:clear',
  KILL_SWITCH: 'control:kill_switch',
  INVENTORY_GET: 'inventory:get',
  INVENTORY_REFRESH: 'inventory:refresh',
  TAB_STATE: 'tab:state',
  SNAPSHOT: 'snapshot:get',
  SESSION_END_REQUEST: 'session:end',
};

/** Storage keys. Kept in one place so migrations stay honest. */
export const STORE = {
  POLICY: 'abg.policy',
  AUDIT_CHUNK_PREFIX: 'abg.audit.chunk.',
  AUDIT_INDEX: 'abg.audit.index',
  AUDIT_HEAD: 'abg.audit.head',
  SESSIONS: 'abg.sessions',
  INVENTORY: 'abg.inventory',
  KILL_SWITCH: 'abg.killSwitch',
  STATS: 'abg.stats',
};

/** Bridge channel between the MAIN-world probe and the isolated content script. */
export const BRIDGE_CHANNEL = 'abg:bridge:v1';
