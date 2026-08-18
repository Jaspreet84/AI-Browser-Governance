# Control mapping

This extension is a technical control, not a compliance programme. The mapping below is offered so
security and GRC teams can point at the specific mechanism that satisfies an obligation, and so gaps
stay visible.

## NIST AI RMF 1.0

| Function | Obligation | Mechanism |
| --- | --- | --- |
| GOVERN 1.2 | Policies for AI use are documented and enforced | Layered policy (default → local → managed), locked by admin |
| MAP 3.4 | Operational context and permitted actions are defined | Action taxonomy + site classes + rules |
| MEASURE 2.7 | AI system behaviour is monitored in deployment | Per-action records with actor attribution and risk score |
| MANAGE 2.3 | Mechanisms exist to supersede or deactivate the system | Kill switch, lockdown, session end, DNR network blocking |
| MANAGE 4.1 | Post-deployment monitoring is logged and reviewable | Hash-chained audit log with export and verification |

## EU AI Act

| Article | Obligation | Mechanism |
| --- | --- | --- |
| Art. 14 — Human oversight | A natural person can intervene or interrupt | Approval prompt that only a trusted event can answer; kill switch; approval timeouts that deny |
| Art. 12 — Record-keeping | Automatic logging of events over the lifetime | Append-only sealed log, retention configurable, exportable |
| Art. 13 — Transparency | Users can interpret system output | In-page banner and toasts, explainable risk factors, matched rule ids on every record |
| Art. 26 — Deployer obligations | Monitor operation and keep logs | Audit forwarding to a collector; managed policy for fleet-wide settings |

## ISO/IEC 42001

| Clause | Mechanism |
| --- | --- |
| 8.2 — AI system impact assessment | Risk scoring with explicit, inspectable factors (`src/core/risk.js`) |
| 8.3 — Operational controls | Rule-based enforcement with three postures |
| 9.1 — Monitoring and measurement | Session summaries, budgets, per-rule hit counts |
| 10.2 — Nonconformity and corrective action | Blocked/denied records with reason, justification capture on approval |

## SOC 2 (common criteria)

| Criterion | Mechanism |
| --- | --- |
| CC6.1 — Logical access controls | Credential-entry blocking, denylists, network-layer blocking |
| CC6.7 — Restricting data transmission | DLP on content bound for model providers |
| CC7.2 — Detection of anomalies | Agent-session budgets, unattributed-extension model traffic rule |
| CC7.3 — Evaluation of security events | Audit console with filters, verification and export |

## What this does not give you

- **Non-repudiation against a local administrator.** The chain proves an edit happened, not who made
  it. Forward records off-device if that distinction matters.
- **Coverage of non-browser agents.** An agent driving a separate browser binary, or acting through an
  API rather than a session, is out of scope entirely.
- **Data residency guarantees.** Records stay on the device unless you configure forwarding; where
  they go after that is your collector's problem.
