/**
 * Isolated-world sensor.
 *
 * Watches the page for actions, decides which are worth stopping, asks the
 * service worker for a ruling, and either lets the action through or replays it
 * after a human approves. Everything it observes is reported for the audit log,
 * whether or not it is enforced.
 *
 * Interception model
 * ------------------
 * DOM events are synchronous and policy evaluation is not, so a consequential
 * agent action is cancelled first and replayed after the ruling comes back.
 * Replays are marked, so the sensor does not re-intercept its own replay.
 * Actions that are not consequential are reported without ever touching the
 * page, which keeps ordinary browsing exactly as fast as it was.
 */

(() => {
  if (window.__abgSensorInstalled) return;
  window.__abgSensorInstalled = true;

  /* Mirrors src/core/constants.js — content scripts cannot import ES modules.
     tests/content-constants.test.js fails if these drift apart. */
  const CHANNEL = 'abg:bridge:v1';
  const MSG = {
    ACTION_PROPOSED: 'action:proposed',
    SIGNAL_REPORT: 'signal:report',
    APPROVAL_REQUEST: 'approval:request',
    APPROVAL_RESULT: 'approval:result',
    SNAPSHOT: 'snapshot:get',
    STATE_PUSH: 'state:push',
  };
  const ACTION = {
    CLICK: 'element.click',
    INPUT: 'input.fill',
    FORM_SUBMIT: 'form.submit',
    UPLOAD: 'file.upload',
    CLIPBOARD_READ: 'clipboard.read',
    CLIPBOARD_WRITE: 'clipboard.write',
    PROMPT_SUBMIT: 'ai.prompt_submit',
  };
  const SIGNAL = {
    UNTRUSTED_EVENT: 'untrusted_event',
    WEBDRIVER_FLAG: 'webdriver_flag',
    AUTOMATION_GLOBAL: 'automation_global',
    PROGRAMMATIC_CLICK: 'programmatic_click',
    PROGRAMMATIC_SUBMIT: 'programmatic_submit',
    SYNTHETIC_VALUE_SET: 'synthetic_value_set',
    INHUMAN_CADENCE: 'inhuman_cadence',
    NO_POINTER_PATH: 'no_pointer_path',
    HEADLESS_HINT: 'headless_hint',
    AI_SDK_TRAFFIC: 'ai_sdk_traffic',
    CDP_ARTIFACT: 'cdp_artifact',
    HUMAN_INPUT_RECENT: 'human_input_recent',
  };

  const HUMAN_WINDOW_MS = 12_000;
  const GUARD_PASS_MS = 1500;
  const REPLAY_WINDOW_MS = 2000;

  const state = {
    snapshot: {
      mode: 'guardrail',
      enforce: false, // stays false until the worker answers: never enforce blind
      killSwitch: false,
      minConfidence: 0.6,
      guardCredentialFields: false,
      site: { classes: [], primary: 'unclassified' },
      ready: false,
    },
    envSignals: [],
    recentProbe: [],
    lastTrustedInputAt: 0,
    lastTrustedInputEl: null,
    lastPointerAt: 0,
    keyIntervals: [],
    lastKeyAt: 0,
    replay: { el: null, at: 0 },
    fieldValues: new WeakMap(),
    composerVerdict: new WeakMap(),
    agentActive: false,
  };

  /* ------------------------------------------------------------- messaging */

  function send(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          void chrome.runtime.lastError; // context invalidated on reload: ignore
          resolve(response || null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  async function loadSnapshot() {
    const snap = await send({ type: MSG.SNAPSHOT });
    if (!snap || snap.error) return;
    state.snapshot = { ...state.snapshot, ...snap, site: snap.siteClasses || snap.site, ready: true };
    applyFieldGuards();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === MSG.APPROVAL_REQUEST) {
      globalThis.ABGOverlay._onSyntheticApproval = onSyntheticApproval;
      globalThis.ABGOverlay.approval(msg).then((result) => {
        send({ type: MSG.APPROVAL_RESULT, approvalId: msg.approvalId, ...result });
      });
      sendResponse({ shown: true });
      return true;
    }
    if (msg?.type === MSG.STATE_PUSH) {
      state.snapshot = { ...state.snapshot, ...msg };
      applyFieldGuards();
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });

  /** An agent clicking its own approval button is a finding in its own right. */
  function onSyntheticApproval(req) {
    pushSignal(SIGNAL.UNTRUSTED_EVENT, { where: 'approval_dialog' }, 0.95);
    send({
      type: MSG.ACTION_PROPOSED,
      action: {
        type: ACTION.CLICK,
        url: location.href,
        origin: location.origin,
        signals: [{ type: SIGNAL.UNTRUSTED_EVENT, at: Date.now(), weight: 0.95, detail: 'synthetic approval click' }],
        target: { label: 'Approve (governance dialog)', selfApproval: true, destructiveLabel: true },
      },
    });
  }

  /* --------------------------------------------------------------- signals */

  function pushSignal(type, detail, weight) {
    const now = Date.now();
    // The environment is rescanned a few times per page; the same fact observed
    // three times is still one fact, and must not read as mounting evidence.
    const existing = state.envSignals.find((s) => s.type === type && s.detail === detail);
    if (existing) {
      existing.at = now;
      return;
    }
    state.envSignals.push({ type, at: now, detail, weight });
    if (state.envSignals.length > 40) state.envSignals = state.envSignals.slice(-40);
  }

  /** Signals that apply to an action happening right now. */
  function currentSignals(extra = []) {
    const now = Date.now();
    const list = [...state.envSignals.filter((s) => now - s.at < 5 * 60_000), ...extra];
    if (now - state.lastTrustedInputAt < HUMAN_WINDOW_MS) {
      list.push({ type: SIGNAL.HUMAN_INPUT_RECENT, at: state.lastTrustedInputAt });
    }
    return list;
  }

  /**
   * Cheap local estimate, used only to decide whether an action is worth
   * stopping. The authoritative score is computed in the service worker.
   */
  function localConfidence(signals) {
    let complement = 1;
    const weights = {
      [SIGNAL.UNTRUSTED_EVENT]: 0.75,
      [SIGNAL.WEBDRIVER_FLAG]: 0.9,
      [SIGNAL.CDP_ARTIFACT]: 0.85,
      [SIGNAL.AUTOMATION_GLOBAL]: 0.8,
      [SIGNAL.PROGRAMMATIC_CLICK]: 0.6,
      [SIGNAL.PROGRAMMATIC_SUBMIT]: 0.6,
      [SIGNAL.SYNTHETIC_VALUE_SET]: 0.55,
      [SIGNAL.INHUMAN_CADENCE]: 0.5,
      [SIGNAL.AI_SDK_TRAFFIC]: 0.5,
      [SIGNAL.HEADLESS_HINT]: 0.4,
      [SIGNAL.NO_POINTER_PATH]: 0.35,
    };
    let human = 0;
    for (const s of signals) {
      if (s.type === SIGNAL.HUMAN_INPUT_RECENT) {
        human = 0.55;
        continue;
      }
      const w = s.weight ?? weights[s.type] ?? 0;
      complement *= 1 - w;
    }
    return (1 - complement) * (1 - 0.6 * human);
  }

  /* -------------------------------------------------------- probe bridge */

  document.addEventListener(CHANNEL, (event) => {
    let msg;
    try {
      msg = JSON.parse(event.detail);
    } catch {
      return;
    }
    handleProbe(msg.kind, msg.payload || {});
  });

  function handleProbe(kind, payload) {
    switch (kind) {
      case 'environment': {
        if (payload.webdriver) pushSignal(SIGNAL.WEBDRIVER_FLAG, 'navigator.webdriver');
        for (const g of payload.automationGlobals || []) pushSignal(SIGNAL.AUTOMATION_GLOBAL, g);
        for (const c of payload.cdpArtifacts || []) pushSignal(SIGNAL.CDP_ARTIFACT, c);
        if ((payload.headlessHints || []).length >= 2) pushSignal(SIGNAL.HEADLESS_HINT, payload.headlessHints.join(','));
        if (state.envSignals.length) send({ type: MSG.SIGNAL_REPORT, signals: state.envSignals, url: location.href });
        break;
      }
      case 'programmatic_click':
        pushSignal(SIGNAL.PROGRAMMATIC_CLICK, payload.caller?.frame);
        noteAttribution(payload.caller);
        break;
      case 'programmatic_submit':
        pushSignal(SIGNAL.PROGRAMMATIC_SUBMIT, payload.caller?.frame);
        noteAttribution(payload.caller);
        break;
      case 'synthetic_value_set':
        onSyntheticValueSet(payload);
        break;
      case 'clipboard_read':
        propose({
          type: ACTION.CLIPBOARD_READ,
          target: { label: 'navigator.clipboard.readText()' },
          signals: currentSignals([{ type: SIGNAL.UNTRUSTED_EVENT, at: Date.now(), weight: 0.6 }]),
        });
        break;
      case 'clipboard_write':
        propose({
          type: ACTION.CLIPBOARD_WRITE,
          target: { label: `clipboard write (${payload.length || 0} chars)` },
          signals: currentSignals(),
        });
        break;
      case 'ai_fetch':
        pushSignal(SIGNAL.AI_SDK_TRAFFIC, payload.url);
        noteAttribution(payload.caller);
        break;
      case 'blocked':
        globalThis.ABGOverlay.toast({
          title: 'Blocked by policy',
          message: `An automated ${payload.kind === 'click' ? 'click' : 'write'} to a protected field was refused.`,
          tone: 'block',
        });
        propose({
          type: payload.kind === 'click' ? ACTION.CLICK : ACTION.INPUT,
          target: payload.target || {},
          signals: currentSignals([{ type: SIGNAL.UNTRUSTED_EVENT, at: Date.now(), weight: 0.9 }]),
          preBlocked: true,
        });
        break;
      default:
        break;
    }
  }

  let attribution = {};
  function noteAttribution(caller) {
    if (caller?.extensionId) attribution = { extensionId: caller.extensionId, frame: caller.frame };
  }

  /* ------------------------------------------------------ target inspection */

  const DESTRUCTIVE = /\b(delete|remove|destroy|erase|wipe|purge|revoke|terminate|deactivate|uninstall|reset)\b/i;
  const FINANCIAL = /\b(pay|payment|purchase|buy|checkout|order|subscribe|transfer|wire|send money|withdraw|refund|approve|authori[sz]e)\b/i;
  const SHARE = /\b(share|publish|make public|invite|export|grant access|add member)\b/i;

  function describe(el) {
    if (!el || el.nodeType !== 1) return { label: '' };
    const attr = (n) => el.getAttribute?.(n) || '';
    const type = (el.type || '').toLowerCase();
    const autocomplete = attr('autocomplete').toLowerCase();
    const idish = `${el.name || ''} ${el.id || ''} ${attr('data-testid')}`.toLowerCase();
    const label = (el.innerText || el.value || attr('aria-label') || attr('placeholder') || attr('title') || '').trim().slice(0, 120);
    const href = el.closest?.('a')?.href || '';
    let crossOrigin = false;
    try {
      crossOrigin = Boolean(href) && new URL(href, location.href).origin !== location.origin;
    } catch {
      crossOrigin = false;
    }
    return {
      tag: el.tagName?.toLowerCase(),
      type: type || undefined,
      label,
      selector: cssPath(el),
      href: href ? href.slice(0, 300) : undefined,
      isCredentialField: type === 'password' || /password|passcode|otp|mfa|2fa|totp/.test(idish) || /current-password|new-password|one-time-code/.test(autocomplete),
      isPaymentField: /^cc-|^card/.test(autocomplete) || /card.?number|cvv|cvc|iban|routing|account.?number/.test(idish),
      isFileInput: type === 'file',
      destructiveLabel: DESTRUCTIVE.test(label),
      financialLabel: FINANCIAL.test(label),
      externalShare: SHARE.test(label),
      crossOrigin,
      hiddenElement: isHidden(el),
      newTab: el.target === '_blank',
    };
  }

  function isHidden(el) {
    try {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return true;
      const style = getComputedStyle(el);
      return style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0;
    } catch {
      return false;
    }
  }

  function cssPath(el, max = 5) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < max) {
      if (node.id) {
        parts.unshift(`#${node.id}`);
        break;
      }
      let part = node.tagName.toLowerCase();
      const cls = typeof node.className === 'string' ? node.className.trim().split(/\s+/)[0] : '';
      if (cls) part += `.${cls}`;
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join('>').slice(0, 200);
  }

  /** Is stopping this action worth the cost of cancelling and replaying it? */
  function isConsequential(target, type) {
    if (state.snapshot.mode === 'lockdown') return true;
    const classes = state.snapshot.site?.classes || [];
    if (classes.includes('sensitive') || classes.includes('denylisted')) return true;
    if (target.isCredentialField || target.isPaymentField || target.isFileInput) return true;
    if (target.destructiveLabel || target.financialLabel || target.externalShare) return true;
    if (type === ACTION.FORM_SUBMIT || type === ACTION.UPLOAD) return true;
    if (type === ACTION.CLICK && target.crossOrigin) return true;
    return false;
  }

  /* ---------------------------------------------------------- action flow */

  /** Fire-and-forget report; the worker logs it and we never wait. */
  function propose(draft) {
    return send({
      type: MSG.ACTION_PROPOSED,
      action: {
        url: location.href,
        origin: location.origin,
        actor: Object.keys(attribution).length ? { attribution } : undefined,
        signals: draft.signals || currentSignals(),
        ...draft,
      },
    });
  }

  /** Cancel now, ask, and replay if allowed. */
  async function gate(event, draft, replay) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const decision = await propose(draft);
    if (!decision || decision.error) {
      // The worker could not answer. Fail closed for consequential actions:
      // silence must not become permission.
      globalThis.ABGOverlay.toast({
        title: 'Action held',
        message: 'The governance service did not respond, so the action was not replayed.',
        tone: 'block',
      });
      return;
    }
    if (decision.decision === 'allow' || decision.decision === 'log' || decision.decision === 'warn') {
      if (decision.decision === 'warn') {
        globalThis.ABGOverlay.toast({ title: 'Allowed with a warning', message: decision.reason || '', tone: 'warn' });
      }
      doReplay(replay);
      return;
    }
    globalThis.ABGOverlay.toast({
      title: decision.decision === 'block' ? 'Agent action blocked' : 'Action not approved',
      message: decision.reason || 'Blocked by AI governance policy.',
      tone: 'block',
    });
  }

  function doReplay(replay) {
    if (typeof replay !== 'function') return;
    try {
      replay();
    } catch (e) {
      console.warn('[abg] replay failed', e);
    }
  }

  function markReplay(el) {
    state.replay = { el, at: Date.now() };
  }

  function isReplaying(el) {
    if (!state.replay.el) return false;
    if (Date.now() - state.replay.at > REPLAY_WINDOW_MS) return false;
    return state.replay.el === el || (el && state.replay.el?.contains?.(el));
  }

  /* ------------------------------------------------------------- listeners */

  document.addEventListener('pointermove', () => {
    state.lastPointerAt = Date.now();
  }, { capture: true, passive: true });

  document.addEventListener('keydown', (event) => {
    if (!event.isTrusted) return;
    const now = Date.now();
    if (state.lastKeyAt) {
      const gap = now - state.lastKeyAt;
      state.keyIntervals.push(gap);
      if (state.keyIntervals.length > 12) state.keyIntervals.shift();
      // Perfectly uniform, sub-15ms keystrokes are a machine, not a person.
      if (state.keyIntervals.length >= 6) {
        const mean = state.keyIntervals.reduce((a, b) => a + b, 0) / state.keyIntervals.length;
        const variance = state.keyIntervals.reduce((a, b) => a + (b - mean) ** 2, 0) / state.keyIntervals.length;
        if (mean < 15 || (variance < 1 && mean < 60)) pushSignal(SIGNAL.INHUMAN_CADENCE, `mean=${Math.round(mean)}ms`);
      }
    }
    state.lastKeyAt = now;
    noteHuman(event.target);
    maybeGuardComposerSubmit(event);
  }, true);

  for (const type of ['input', 'change']) {
    document.addEventListener(type, (event) => {
      if (event.isTrusted) {
        noteHuman(event.target);
        if (event.target?.value !== undefined) state.fieldValues.set(event.target, event.target.value);
        if (isComposer(event.target)) schedulePreflight(event.target);
      }
      if (type === 'change' && event.target?.type === 'file' && event.target.files?.length) {
        onFileSelection(event);
      }
    }, true);
  }

  document.addEventListener('paste', (event) => {
    const text = event.clipboardData?.getData('text') || '';
    if (!text) return;
    propose({
      type: event.isTrusted ? ACTION.CLIPBOARD_WRITE : ACTION.INPUT,
      target: { ...describe(event.target), label: `paste (${text.length} chars)` },
      text,
      signals: currentSignals(event.isTrusted ? [] : [{ type: SIGNAL.UNTRUSTED_EVENT, at: Date.now() }]),
    });
  }, true);

  document.addEventListener('click', (event) => {
    if (isReplaying(event.target)) return;
    const target = describe(event.target);

    if (event.isTrusted) {
      noteHuman(event.target);
      if (isComposerSubmitButton(event.target)) maybeGuardComposerSubmit(event);
      return;
    }

    const signals = currentSignals([{ type: SIGNAL.UNTRUSTED_EVENT, at: Date.now() }]);
    if (Date.now() - state.lastPointerAt > 5000) signals.push({ type: SIGNAL.NO_POINTER_PATH, at: Date.now() });
    const draft = { type: ACTION.CLICK, target, signals };

    if (shouldGate(signals, target, ACTION.CLICK)) {
      const el = event.target;
      gate(event, draft, () => {
        markReplay(el);
        el.click();
      });
      return;
    }
    propose(draft);
  }, true);

  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (isReplaying(form)) return;
    const target = { ...describe(form), label: `form → ${formAction(form)}`, crossOrigin: isCrossOriginForm(form) };
    const signals = currentSignals(event.isTrusted ? [] : [{ type: SIGNAL.UNTRUSTED_EVENT, at: Date.now() }]);
    const draft = { type: ACTION.FORM_SUBMIT, target, text: formText(form), signals };

    if (!event.isTrusted && shouldGate(signals, target, ACTION.FORM_SUBMIT)) {
      gate(event, draft, () => {
        markReplay(form);
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
      });
      return;
    }
    propose(draft);
  }, true);

  function onFileSelection(event) {
    const input = event.target;
    const files = [...input.files].map((f) => ({ name: f.name, size: f.size, type: f.type }));
    const target = { ...describe(input), label: files.map((f) => f.name).join(', ').slice(0, 120), isFileInput: true };
    const signals = currentSignals(event.isTrusted ? [] : [{ type: SIGNAL.UNTRUSTED_EVENT, at: Date.now(), weight: 0.85 }]);
    if (!event.isTrusted && shouldGate(signals, target, ACTION.UPLOAD)) {
      // A file selection cannot be replayed (only a trusted gesture can open the
      // picker), so an unapproved upload is cleared from the input instead.
      const draft = { type: ACTION.UPLOAD, target, files, signals };
      event.preventDefault();
      event.stopImmediatePropagation();
      propose(draft).then((decision) => {
        if (decision && (decision.decision === 'allow' || decision.decision === 'log' || decision.decision === 'warn')) return;
        try {
          input.value = '';
        } catch {
          /* some inputs refuse programmatic clearing */
        }
        globalThis.ABGOverlay.toast({ title: 'Upload blocked', message: decision?.reason || 'Agent upload blocked by policy.', tone: 'block' });
      });
      return;
    }
    propose({ type: ACTION.UPLOAD, target, files, signals });
  }

  function shouldGate(signals, target, type) {
    if (!state.snapshot.ready || !state.snapshot.enforce) return false;
    if (state.snapshot.killSwitch) return true;
    if (localConfidence(signals) < (state.snapshot.minConfidence ?? 0.6)) return false;
    return isConsequential(target, type);
  }

  function noteHuman(el) {
    state.lastTrustedInputAt = Date.now();
    state.lastTrustedInputEl = el;
    state.agentActive = false;
    // Let the human type into a field the probe is guarding: frameworks write
    // to `.value` on every keystroke, and blocking that would break the page.
    if (el?.getAttribute?.('data-abg-guard') === 'deny') {
      el.setAttribute('data-abg-guard', 'pass');
      setTimeout(() => {
        if (el.getAttribute('data-abg-guard') === 'pass') el.setAttribute('data-abg-guard', 'deny');
      }, GUARD_PASS_MS);
    }
  }

  function onSyntheticValueSet(payload) {
    const target = payload.target || {};
    // React and friends set `.value` while a human types; that is not an agent.
    if (Date.now() - state.lastTrustedInputAt < 400) return;
    pushSignal(SIGNAL.SYNTHETIC_VALUE_SET, target.selector);
    propose({
      type: ACTION.INPUT,
      target,
      text: payload.value,
      signals: currentSignals([{ type: SIGNAL.SYNTHETIC_VALUE_SET, at: Date.now() }]),
    }).then((decision) => {
      if (decision?.decision === 'block' && target.selector) {
        const el = document.querySelector(target.selector);
        if (el) restoreField(el);
        globalThis.ABGOverlay.toast({ title: 'Field write reverted', message: decision.reason || '', tone: 'block' });
      }
    });
  }

  function restoreField(el) {
    try {
      const previous = state.fieldValues.get(el) ?? '';
      el.value = previous;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } catch {
      /* ignore */
    }
  }

  /* --------------------------------------------------- model prompt guard */

  function isComposer(el) {
    if (!el || !(state.snapshot.site?.classes || []).includes('ai_provider')) return false;
    const tag = el.tagName?.toLowerCase();
    return tag === 'textarea' || el.isContentEditable || (tag === 'input' && (el.type === 'text' || el.type === 'search'));
  }

  function isComposerSubmitButton(el) {
    if (!(state.snapshot.site?.classes || []).includes('ai_provider')) return false;
    const label = (el?.getAttribute?.('aria-label') || el?.innerText || '').toLowerCase();
    return /send|submit|ask|run/.test(label) || el?.getAttribute?.('data-testid')?.includes('send');
  }

  let preflightTimer = null;
  /** Scan what is in the composer *before* it is sent, so the block is instant. */
  function schedulePreflight(el) {
    clearTimeout(preflightTimer);
    preflightTimer = setTimeout(async () => {
      const text = composerText(el);
      if (!text || text.length < 8) return;
      const verdict = await propose({
        type: ACTION.PROMPT_SUBMIT,
        target: { ...describe(el), label: 'model prompt' },
        text,
        preflight: true,
        signals: currentSignals(),
      });
      if (verdict) state.composerVerdict.set(el, { ...verdict, at: Date.now(), length: text.length });
    }, 500);
  }

  function composerText(el) {
    if (!el) return '';
    return (el.isContentEditable ? el.innerText : el.value || '').slice(0, 20000);
  }

  /**
   * Synchronous gate on Enter (or a click on Send) in a model composer, using
   * the most recent preflight verdict. Without the preflight there is no way to
   * stop a prompt in the same tick the human presses Enter.
   */
  function maybeGuardComposerSubmit(event) {
    const composer = event.type === 'keydown' ? event.target : findComposer();
    if (!isComposer(composer)) return;
    if (event.type === 'keydown' && (event.key !== 'Enter' || event.shiftKey)) return;

    const verdict = state.composerVerdict.get(composer);
    if (!verdict) return;
    if (Date.now() - verdict.at > 30_000) return;
    if (verdict.decision !== 'block' && verdict.decision !== 'require_approval') return;

    event.preventDefault();
    event.stopImmediatePropagation();
    const text = composerText(composer);

    propose({
      type: ACTION.PROMPT_SUBMIT,
      target: { ...describe(composer), label: 'model prompt' },
      text,
      signals: currentSignals(),
    }).then((decision) => {
      if (decision?.decision === 'allow' || decision?.decision === 'warn' || decision?.decision === 'log') {
        markReplay(composer);
        resubmitComposer(composer);
        return;
      }
      const findings = (decision?.dlp || []).map((f) => f.name).join(', ');
      globalThis.ABGOverlay.toast({
        title: 'Prompt blocked',
        message: `${decision?.reason || 'Blocked by policy.'}${findings ? ` (${findings})` : ''}`,
        tone: 'block',
      });
      state.composerVerdict.delete(composer);
    });
  }

  function resubmitComposer(el) {
    try {
      el.focus();
      const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent('keydown', opts));
      el.dispatchEvent(new KeyboardEvent('keyup', opts));
      const form = el.closest?.('form');
      if (form && typeof form.requestSubmit === 'function') {
        markReplay(form);
        form.requestSubmit();
      }
    } catch {
      /* the composer may only respond to its own framework events */
    }
  }

  function findComposer() {
    const active = document.activeElement;
    if (isComposer(active)) return active;
    return document.querySelector('textarea, [contenteditable="true"]');
  }

  /* ----------------------------------------------------------- form helpers */

  function formAction(form) {
    try {
      return new URL(form.action || location.href, location.href).host;
    } catch {
      return location.host;
    }
  }

  function isCrossOriginForm(form) {
    try {
      return new URL(form.action || location.href, location.href).origin !== location.origin;
    } catch {
      return false;
    }
  }

  /** Form contents for DLP, with credential fields deliberately excluded. */
  function formText(form) {
    try {
      const parts = [];
      for (const el of form.elements || []) {
        if (!el.name || el.type === 'password' || el.type === 'hidden') continue;
        const value = el.type === 'checkbox' || el.type === 'radio' ? (el.checked ? 'on' : '') : el.value;
        if (value) parts.push(`${el.name}=${String(value).slice(0, 2000)}`);
      }
      return parts.join('\n').slice(0, 20000);
    } catch {
      return '';
    }
  }

  /* ------------------------------------------------------------ field guards */

  const GUARD_SELECTOR = 'input[type=password], input[autocomplete*=password], input[autocomplete^=cc-], input[name*=card], input[name*=cvv], input[name*=cvc]';

  function applyFieldGuards() {
    if (!state.snapshot.guardCredentialFields || !state.snapshot.enforce) {
      for (const el of document.querySelectorAll('[data-abg-guard]')) el.removeAttribute('data-abg-guard');
      return;
    }
    for (const el of document.querySelectorAll(GUARD_SELECTOR)) {
      if (!el.hasAttribute('data-abg-guard')) el.setAttribute('data-abg-guard', 'deny');
    }
  }

  let guardTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(guardTimer);
    guardTimer = setTimeout(applyFieldGuards, 250);
  });

  function startObserving() {
    if (document.documentElement) {
      observer.observe(document.documentElement, { childList: true, subtree: true });
      applyFieldGuards();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startObserving, { once: true });
  } else {
    startObserving();
  }

  loadSnapshot();
  // The worker may have been asleep at document_start; re-ask once the page settles.
  setTimeout(loadSnapshot, 2000);
})();
