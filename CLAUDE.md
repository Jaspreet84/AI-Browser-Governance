# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Manifest V3 Chrome extension that governs AI agents acting inside the browser: detects
agent-driven actions, enforces a declarative policy (block / require human approval / warn / log),
and seals every decision into a hash-chained audit log. **There is no build step** — the repository
root loads directly as an unpacked extension, and `manifest.json` references source files as-is.

This is a security tool. Changes are judged first by whether they preserve the security invariants
listed below, and second by everything else.

## Commands

```bash
npm test                    # 95 unit + structural tests (node:test, zero dependencies)
node --test tests/dlp.test.js                        # one test file
node --test --test-name-pattern="tamper" tests/*.test.js   # tests whose name matches a pattern
npm run lint                # project-convention checks (tools/lint.js) + module parse
npm run check               # lint + test — run this before every commit
npm run smoke               # end-to-end: loads the extension in Chromium, drives it like an agent
npm run icons               # regenerate assets/icons/*.png from tools/make-icons.js
npm run package             # build dist/ai-browser-governance-<version>.zip (needs the `zip` binary)
```

`--test-name-pattern` is a substring/regex filter and can match several tests — it is not a
one-test selector; combine with a single file argument to narrow it.

The smoke test needs Playwright and a display. Chrome only loads extensions in a headed context, so
run it as `ABG_HEADFUL=1 xvfb-run -a npm run smoke` on a headless machine. Playwright is installed
transiently (`npm install --no-save playwright@1.56` — match CI's pin; extension loading has
changed across Playwright/Chromium versions). **Never** add Playwright, or anything else, to
`package.json` dependencies; the zero-dependency property is deliberate and both the lint tool's
"no install step" and CI rely on it.

CI (`.github/workflows/`) runs on push to **`main`**, on every pull request, and on manual dispatch —
**not** on pushes to feature branches. `ci.yml` runs lint + test on Node 20 and 22 and then builds
and uploads the packaged zip as an artifact; `smoke.yml` runs the browser smoke test under Xvfb.
Everything CI does is reproducible locally with the commands above.

## Architecture: three worlds and one decision point

Understanding this requires knowing where each file *executes*, because Chrome gives each context
different powers and restrictions:

1. **`src/content/probe.js` — the page's MAIN world.** The only place that can see a script call
   `element.click()`, set `input.value` directly, read the clipboard, or `fetch()` a model API.
   It patches those APIs, observes, and reports to the sensor via a `CustomEvent` on the
   `abg:bridge:v1` channel (JSON-stringified detail). Its own synchronous enforcement: a field
   marked `data-abg-guard="deny"` has **both** its value writes **and** its clicks rejected (the
   patched setter and the patched `click()` return without calling through).

2. **`src/content/sensor.js` — the isolated content-script world.** It gates **untrusted
   (synthetic) events** — the ones an agent produces. A *trusted* click/submit is noted as human
   presence (`noteHuman`) and passes through untouched; only `!event.isTrusted` events reach the
   gating path, where a consequential one is cancelled synchronously, sent to the worker, and
   replayed only if the ruling allows (replays are marked via `markReplay` so they are not
   re-intercepted). The one place a *trusted* event is intercepted is the AI-provider composer
   guard (Enter / Send preflight). Non-consequential and observed-only actions are reported without
   touching the page. `overlay.js` (same world) renders the approval modal and toasts in a
   **closed** shadow root.

3. **`src/background/service-worker.js` — the decision point.** Action proposals, model-API egress,
   navigations and downloads all flow through `decide()`. (Environment-signal reports —
   `MSG.SIGNAL_REPORT` — do **not**; they only bump the tab badge and are folded into later actions
   by the sensor's `currentSignals()`.) Inside `decide()` the order is: fuse signals → classify site
   → DLP scan → **`sessions.record()` producing the budget counters** → **`evaluate(action, policy,
   {killSwitch, session: counters})`** (the counters are an *input*, and the budget limits are
   enforced *inside* `evaluate()`) → `sessions.settle()` folds the outcome back → approval
   round-trip if the decision is `require_approval` → sealed audit record → response to the sensor.
   The worker also watches what content scripts cannot see: egress via `webRequest` (attributed to
   the initiating tab *or extension*), downloads, navigations, and the extension inventory. Chrome
   kills and restarts this worker at will — state that matters lives in `chrome.storage`; sessions
   rehydrate from `chrome.storage.session`.

4. **`src/core/` — pure logic, no `chrome.*` anywhere.** Policy engine, signal fusion, DLP, risk
   scoring, audit chain, session tracking, policy layering. Everything here runs under plain Node,
   which is what makes the governance behaviour testable and reviewable. The lint tool **fails the
   build** if `chrome.` appears in core code (comments are fine).

Policy is layered: shipped defaults (`src/core/default-policy.js`) ← user's local edits ← managed
policy pushed via Chrome Enterprise (`managed-schema.json`). Managed wins; `locked: true` in the
managed layer discards local edits entirely. `src/background/policy-service.js` owns the merged
result and keeps declarativeNetRequest rules in sync with it.

## Invariants the tooling enforces (and why)

`tools/lint.js` and `tests/structure.test.js` are not style checks — each rule guards something
that breaks silently otherwise:

- **No `chrome.*` in `src/core/`.** Core must stay runnable under Node or the test suite becomes
  theatre. Note the lint rule covers *only* `src/core/`, but some `src/background/` modules
  (`inventory.js`, `network-watch.js`, and anything they import) are imported directly by
  `tests/inventory-network.test.js` and run under Node — so keep `chrome.*` out of their module
  top level and out of any exported function the tests call, or `npm test` throws a `ReferenceError`
  that looks unrelated to your change.
- **No `import`/`export` in `src/content/`.** The manifest injects content scripts as classic
  scripts; module syntax would throw at injection time in every tab. Consequence: values used by
  content scripts are **duplicated** into `sensor.js`/`probe.js` from `src/core/`.
- **`package.json` and `manifest.json` versions must match** (lint + structural test).
- **No `innerHTML` assignment outside `overlay.js` and `options.js`**; no `console.log` in shipped
  code (use `console.warn`/`error`).
- **The approval dialog must reject untrusted events** — the structural test greps `overlay.js`
  for the `isTrusted` gate. This is the load-bearing rule of the whole extension: if a synthetic
  click could press Approve, the governed agent could approve its own actions.
- **Every `manifest.permissions` entry appears in a backtick in the README** — the structural test
  greps for each name. (This does *not* cover `host_permissions`; `<all_urls>` is documented by
  convention, not enforcement.)

### Duplication that the tests do NOT fully guard — check these by hand

- The constant-drift test (`tests/structure.test.js`) only checks its listed MSG/ACTION/SIGNAL
  values, and **only in `sensor.js`** — `probe.js` is checked solely for the bridge channel. So a
  drifting copy in `probe.js` passes CI silently.
- `probe.js` also duplicates whole *catalogues* from `src/core/agent-signals.js` —
  `AUTOMATION_GLOBALS`, the CDP-artifact prefixes, and the AI-provider host list (`AI_HOST_RE` /
  `isAiHost`) — with **no** drift test at all. When you add a provider host or automation global to
  `agent-signals.js`, update the copy in `probe.js` too, or the MAIN-world probe never sees it.
  (This had already drifted once — the probe was missing Vertex AI / Bedrock / Azure OpenAI.)

## Security invariants not enforced by tooling — do not regress these

- **Secrets never enter the audit log.** DLP findings carry a redacted preview and a count, never
  the match. Stored text samples pass through `redactText()` before persisting (this was a real bug
  caught by the smoke test — see `storedSample` in `service-worker.js`).
- **DLP runs in the service worker, never in page context**, so page script cannot enumerate the
  detector set.
- **The synchronous credential guard depends on one default rule.** `probe.js`'s
  `data-abg-guard="deny"` refusal is the *only* synchronous protection for password/card fields
  (everything else is async and racy). It is switched on by `guardsCredentialFields()` in
  `service-worker.js`, which looks for an **enabled** rule whose `then.decision === 'block'` and
  whose `when.targetFlags` includes `isCredentialField`, with `mode !== monitor`. Disabling,
  renaming, or softening the default `agent-credential-entry` rule silently removes that protection,
  and only the smoke test's password check would notice.
- **Fail closed at the edges:** approval timeouts deny; if the worker doesn't answer, a gated action
  is held, not replayed (`gate()` in sensor.js). **Fail open in the middle:** a page with frozen
  prototypes or a broken `CustomEvent` keeps working un-instrumented — a governance tool that breaks
  pages gets uninstalled.
- **Posture (monitor/lockdown/kill-switch) is applied *after* rules** in `policy-engine.js#finish()`.
  Read the record fields precisely: `evaluate()` returns the already-posture-applied `decision`, and
  the pre-posture rule verdict survives only in **`wouldHaveBeen`** (non-null exactly when posture
  changed the decision — monitor downgrade, lockdown escalation, *and* kill-switch block, not only
  monitor mode). The worker writes `ruleDecision: result.decision`, so `ruleDecision` is the
  posture-applied value, and `decision` differs from it only through the **approval round-trip /
  remembered approvals**, not through posture. Do not "simplify" this two-stage shape away.
- **Audit appends are serialised** (`AuditLog.#serial`) — concurrent appends must not fork the hash
  chain. Records are hashed over `stableStringify` of their content plus the previous hash; adding
  fields to *new* records is fine, but any code that rewrites stored records breaks verification by
  design.
- **The extension makes no network requests** except audit forwarding to an admin-configured
  collector, and its own webRequest listener skips requests initiated by itself
  (`extensionId === chrome.runtime.id`) — keep it that way or forwarding becomes self-auditing
  feedback.

## Things that will bite you

- **Signal fusion is noisy-OR with per-signal time decay** (`agent-signals.js`): environment signals
  (webdriver, CDP artifacts, headless hints) have `halfLife: null` and never decay in a session.
  Behavioural signals decay, but the half-lives are **not uniform** — most sit at 20–60s, but
  `AI_SDK_TRAFFIC` is 120s and the negative `HUMAN_INPUT_RECENT` is 15s. Recent human input
  *discounts* agent evidence (a ×(1 − 0.6·humanEvidence) factor) but never zeroes it. Duplicate
  environment observations are deduped in the sensor (`pushSignal`) so rescans don't read as
  mounting evidence — preserve that when touching signal reporting.
- **The sensor's `localConfidence`** is a cheap gate deciding *whether to intercept*; the worker's
  `fuseSignals` verdict is authoritative. They use the same weights on purpose — change one, change
  the other.
- **`options.css` has `.view[hidden] { display: none; }`** because `display: grid` on `.view`
  outranks the UA `[hidden]` rule. Any new hidden-toggled element with an explicit `display` needs
  the same treatment.
- **File uploads cannot be replayed** (opening a picker needs a trusted gesture), so an unapproved
  upload is handled by clearing `input.value`, not by replay. The same applies to anything needing
  user activation — block, don't degrade silently.
- **Preflight prompts** (`proposal.preflight`) are look-ahead scans of composer text on AI-provider
  sites; they never open approval dialogs and only produce audit records when they find something.
- **Icons are generated code** (`tools/make-icons.js`, a dependency-free PNG encoder). Edit the
  generator and run `npm run icons`; never hand-edit the PNGs.
- **The smoke test asserts product specifics** that make otherwise-safe edits fail CI: it fails if
  the service worker logs *any* `console.error` during the run; it expects the options console to
  render more than 5 rows under `#rulesRows` (renaming that id or shrinking the default rule set
  below 6 breaks it); it hard-codes the `github_token` detector id; and it relies on approval
  `timeoutSeconds` auto-denying a held action to `block`. If you change any of those, update
  `tools/smoke-test.mjs` in the same commit.

## Docs worth reading before larger changes

- `docs/THREAT-MODEL.md` — what this defends against (T1–T12), what it explicitly does not, and the
  design decisions worth arguing with. Read it before changing detection or enforcement.
- `docs/POLICY.md` — the rule schema, evaluation order, and URL-pattern forms. The policy engine's
  behaviour is a documented contract; changes to `evaluate()` semantics need doc + test updates.
- `README.md` — permission justifications (test-enforced), the detection-weight table, and the
  honest "Known limits" section. If you fix a limitation, remove it from that list; if you add one,
  state it there.

## Working conventions

- Run `npm run check` before committing; run the smoke test when touching anything in
  `src/content/`, `src/background/`, or the approval flow — unit tests cannot see world-boundary
  bugs (the two worst bugs so far were only visible in the real browser).
- New governed action types need the full path: constant in `core/constants.js` + duplicate in
  `sensor.js`, sensor emission, base risk in `risk.js`, a default-policy rule if warranted, a label
  in `ui/shared.js#actionLabel` and `overlay.js#actionVerb`, and tests at each layer.
- Keep `src/core/` modules dependency-free and browser-free — new logic goes there first, with thin
  `chrome.*` adapters in `src/background/`.
- Bump the version in `package.json` **and** `manifest.json` together.
