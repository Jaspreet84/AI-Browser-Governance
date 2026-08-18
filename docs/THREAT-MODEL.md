# Threat model

## What this defends

A browser session is an authenticated bundle of everything the person can reach: email, source
control, cloud consoles, HR, payments. An AI agent operating in that session inherits all of it, with
none of the hesitation a human feels before clicking **Delete production database**. The failure modes
worth designing against are not exotic:

| # | Scenario | Control in this extension |
| --- | --- | --- |
| T1 | An agent is asked to "clean up old records" and deletes the wrong ones | Destructive-label detection → `require_approval` |
| T2 | An agent completes a purchase or transfer it was not asked to make | Payment-field and financial-label detection → `require_approval` with justification |
| T3 | An agent types the user's password into a phishing page or an unexpected form | Credential fields are hard-blocked, and marked for synchronous refusal so the write never lands |
| T4 | An agent pastes a secret or customer data into a model provider | DLP scan on prompt/form/egress content bound for AI providers → block + redact obligation |
| T5 | **Prompt injection** from page content redirects the agent to act against the user | Actions are judged on what they *do*, not on what the agent says it intends: the injected instruction still has to pass the rules for its site, target and data |
| T6 | An installed "AI assistant" extension quietly calls a model API with page content | `webRequest` egress watch attributes traffic to the initiating extension; inventory scores it |
| T7 | An agent uploads a local file to an external service | Upload gating (unapproved selections are cleared — a file picker cannot be replayed) |
| T8 | An agent reads the clipboard to harvest whatever was copied last | `navigator.clipboard.readText` is patched → `require_approval` |
| T9 | Runaway loop: an agent clicks hundreds of times per minute | Per-session budgets (actions/minute, navigations, cumulative risk) escalate to approval |
| T10 | **The agent approves its own action** | The approval dialog rejects untrusted events, tells the human, and records the attempt |
| T11 | Someone edits the audit log to hide an action | SHA-256 hash chain; verification names the exact broken record |
| T12 | A user quietly relaxes an enterprise control | Managed policy layer with `locked: true`; local edits are ignored and the console says so |

## What this does not defend

- **A hostile agent with native access.** A CDP client attached from outside the browser can
  synthesise events that look trusted and can bypass content scripts entirely. Detection here is
  evidential, not a sandbox.
- **A malicious extension with `debugger` or `nativeMessaging`.** It outranks a content script. The
  inventory surfaces it; blocking it is an admin decision, not something this extension can enforce
  against a peer.
- **A compromised browser or profile.** Storage is local; an attacker with the profile has the log.
  Forward records to a collector if you need off-device durability.
- **Model behaviour itself.** Nothing here inspects reasoning or intent. It governs *effects*.

## Design decisions worth arguing with

**Detection is public.** The MAIN-world probe does not hide its patches. A tool that lies to the page
it governs cannot be reasoned about by the people who have to trust it, and any agent motivated to
evade has better options than reading `Function.prototype.toString`. The realistic threat is
*accidental* ungoverned automation, and honest instrumentation covers that.

**Fail closed at the edges, fail open in the middle.** Approval timeouts deny. A worker that does not
answer holds the action. But a page whose CSS is frozen, whose prototypes are sealed, or whose
`CustomEvent` is broken keeps working un-instrumented rather than breaking — a governance tool that
breaks pages gets uninstalled, and an uninstalled tool governs nothing.

**Enforcement replays rather than pre-authorises.** Cancelling synchronously and replaying after a
ruling is the only way to get an asynchronous decision into a synchronous DOM event. The cost is that
actions requiring genuine user activation cannot be replayed; those are blocked rather than degraded
silently.

**Secrets never enter the evidence.** Findings carry a redacted preview and a count. An audit log that
becomes a secret store is a new liability, not a control.
