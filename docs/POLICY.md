# Writing policy

A policy is one JSON object. The engine (`src/core/policy-engine.js`) is a pure function of
`(action, policy, context) → decision`, so a rule can be reasoned about — and unit tested — without a
browser.

## Evaluation order

1. Every enabled rule is tested against the action.
2. Matching rules contribute a decision; **the most restrictive match wins**
   (`allow < log < warn < require_approval < block`).
3. A rule with `"override": true` short-circuits everything and returns its decision immediately.
   This is what makes an allowlist meaningful.
4. Budgets are applied to agent actions (rate, navigations, cumulative risk).
5. Posture is applied last: the kill switch blocks, `lockdown` escalates agent actions to approval,
   and `monitor` downgrades enforcement to a log entry while recording `wouldHaveBeen`.

Because posture is applied last, an audit record always shows both what the rules said
(`ruleDecision`) and what actually happened (`decision`).

## Rule shape

```jsonc
{
  "id": "no-agent-payments",                  // required, stable, appears in the audit log
  "description": "Money movement needs a human",
  "enabled": true,                            // omit or true to run
  "override": false,                          // true = terminal match
  "when": {
    "actorKinds": ["agent", "unknown"],       // human | agent | unknown
    "minConfidence": 0.5,                     // actor confidence floor
    "actionTypes": ["element.click", "form.submit"],
    "siteClasses": ["sensitive"],             // ai_provider | sensitive | allowlisted | denylisted | unclassified
    "urlPatterns": ["*.example.com/admin/*"],
    "excludeUrlPatterns": ["docs.example.com"],
    "targetFlags": ["isPaymentField", "financialLabel"],   // any of
    "allTargetFlags": ["crossOrigin", "isFileInput"],      // all of
    "dlpAtLeast": "high",                     // low | medium | high | critical
    "dlpDetectors": ["credit_card"],          // any of these detectors fired
    "riskAtLeast": 80,
    "hasExtensionAttribution": true,          // the action came from another extension
    "extensionIdIn": ["abc…"],
    "extensionIdNotIn": ["def…"]
  },
  "then": {
    "decision": "require_approval",           // allow | log | warn | require_approval | block
    "reason": "Money-movement action proposed by an agent",  // shown to the human, stored in the log
    "requireJustification": true,             // approver must type why
    "remediation": "redact",                  // mark the content for redaction
    "notify": true                            // desktop notification
  }
}
```

Every `when` clause is ANDed. An omitted clause matches anything.

### URL patterns

| Form | Matches |
| --- | --- |
| `example.com` | that host and every subdomain, any path |
| `*.example.com/admin/*` | the apex and subdomains, paths under `/admin/` |
| `https://example.com/x*` | scheme-specific, glob over path and query |
| `re:^https://x\.com/(a\|b)$` | raw regular expression over the whole URL |
| `*` | everything |

### Target flags

`isCredentialField`, `isPaymentField`, `isFileInput`, `crossOrigin`, `destructiveLabel`,
`financialLabel`, `externalShare`, `hiddenElement`, `newTab`, `selfApproval`.

Label flags come from the visible text of the control, which is what a human would have read before
clicking.

## Worked examples

**Never let an agent touch the payroll system**

```json
{
  "id": "no-agent-on-payroll",
  "when": { "urlPatterns": ["payroll.example.com"], "actorKinds": ["agent", "unknown"], "minConfidence": 0.4 },
  "then": { "decision": "block", "reason": "Payroll is off limits to automated agents", "notify": true }
}
```

**Let agents work freely in the sandbox**

```json
{
  "id": "sandbox-exempt",
  "override": true,
  "when": { "urlPatterns": ["sandbox.example.com"] },
  "then": { "decision": "allow", "reason": "Sandbox is exempt from agent rules" }
}
```

**Stop customer identifiers reaching any model provider**

```json
{
  "id": "customer-ids-stay-inside",
  "when": {
    "siteClasses": ["ai_provider"],
    "actionTypes": ["ai.prompt_submit", "input.fill", "form.submit", "network.ai_egress"],
    "dlpDetectors": ["customer_account"]
  },
  "then": { "decision": "block", "reason": "Customer account numbers may not be sent to a model provider", "notify": true }
}
```

paired with a custom detector:

```json
{ "id": "customer_account", "name": "Customer account number", "severity": "high", "regex": "\\bACCT-[0-9]{4}-[0-9]{4}\\b" }
```

**Require a written justification for anything critical**

```json
{
  "id": "justify-critical",
  "when": { "actorKinds": ["agent"], "riskAtLeast": 80 },
  "then": { "decision": "require_approval", "reason": "Critical-risk action", "requireJustification": true }
}
```

## Testing a policy

Policies are plain data, so they can be tested directly:

```js
import { evaluate } from './src/core/policy-engine.js';
import myPolicy from './my-policy.json' with { type: 'json' };

const result = evaluate(
  { type: 'form.submit', url: 'https://payroll.example.com/run',
    actor: { kind: 'agent', confidence: 0.9 }, target: { financialLabel: true } },
  myPolicy,
);
console.log(result.decision, result.matchedRules, result.risk.score);
```

`validatePolicy(policy)` returns the list of problems the console would have refused to save —
unknown modes and decisions, missing rule ids, unparseable regexes, unknown severities.

## Rolling out safely

1. Start in **monitor** for a week. Every record carries `wouldHaveBeen`, so you can count exactly
   how much friction a rule set would have caused before anyone feels it.
2. Export NDJSON and group by `matchedRules` to find the noisy rule.
3. Move to **guardrail**. Keep `allowRememberForSession` on at first; repeated prompts train people
   to click through them, which is worse than a slightly broader allow.
4. Reserve **lockdown** and the kill switch for incidents.
