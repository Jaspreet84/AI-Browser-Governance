/**
 * MAIN-world probe.
 *
 * Runs in the page's own JavaScript context (not the isolated content-script
 * world) because that is the only place you can see a script call
 * `element.click()`, set `input.value` directly, or read the clipboard. It
 * observes and reports; the isolated sensor decides what to do about it.
 *
 * Two deliberate choices:
 *  - The patches are not hidden. A tool that lies to the page it governs cannot
 *    be reasoned about, and an agent determined to evade detection has better
 *    options anyway. Detection here raises the cost of *accidental* ungoverned
 *    automation, which is the realistic threat.
 *  - One synchronous enforcement path exists: fields the sensor marks with
 *    `data-abg-guard="deny"` reject writes immediately, so credentials cannot
 *    be typed while an async decision is still in flight.
 */

(() => {
  const CHANNEL = 'abg:bridge:v1';
  if (window.__abgProbeInstalled) return;
  window.__abgProbeInstalled = true;

  const AUTOMATION_GLOBALS = [
    '__playwright', '__pw_manual', '__PW_inspect', 'playwright',
    '__puppeteer_evaluation_script__', '__puppeteer', 'puppeteer',
    '_selenium', 'callSelenium', '_Selenium_IDE_Recorder', '__selenium_unwrapped',
    '__webdriver_evaluate', '__driver_evaluate', '__webdriver_script_fn', '__fxdriver_evaluate',
    '__nightmare', 'domAutomation', 'domAutomationController',
    '__stagehand', '__browser_use', 'browserUse', '__agentDriver',
  ];
  const CDP_PREFIXES = ['$cdc_', 'cdc_adoQpoasnfa76pfcZLmcfl_', '$chrome_asyncScriptInfo'];

  // Kept in step with AI_API_HOSTS in src/core/agent-signals.js — the two are
  // duplicated across the module boundary (content scripts cannot import), so a
  // provider added there must be added here too. Regional forms (Bedrock, Azure
  // OpenAI) are matched as suffix patterns rather than fixed hosts.
  const AI_HOST_RE = /(^|\.)(api\.anthropic\.com|api\.openai\.com|api\.mistral\.ai|api\.cohere\.ai|api\.perplexity\.ai|api\.together\.xyz|api\.groq\.com|api\.deepseek\.com|api\.x\.ai|generativelanguage\.googleapis\.com|aiplatform\.googleapis\.com|openrouter\.ai|api-inference\.huggingface\.co)$/i;
  const isAiHost = (host) => AI_HOST_RE.test(host) || /(^|\.)openai\.azure\.com$/i.test(host) || /^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/i.test(host);

  const report = (kind, payload) => {
    try {
      document.dispatchEvent(
        new CustomEvent(CHANNEL, { detail: JSON.stringify({ kind, payload, t: Date.now() }) }),
      );
    } catch {
      // A page that has frozen CustomEvent gets observation-free operation
      // rather than a broken probe.
    }
  };

  /** First stack frame outside this probe — who actually called us. */
  function callerFrame() {
    const stack = new Error().stack || '';
    const lines = stack.split('\n').slice(2, 12).map((l) => l.trim());
    const ext = lines.find((l) => l.includes('chrome-extension://'));
    if (ext) {
      const id = /chrome-extension:\/\/([a-p]{32})/.exec(ext)?.[1] || null;
      return { frame: ext.slice(0, 200), extensionId: id };
    }
    const first = lines.find((l) => l && !l.includes('probe.js')) || '';
    return { frame: first.slice(0, 200), extensionId: null };
  }

  function describe(el) {
    if (!el || !el.tagName) return {};
    const attr = (n) => (el.getAttribute ? el.getAttribute(n) : null) || undefined;
    const type = (el.type || '').toLowerCase();
    const autocomplete = (attr('autocomplete') || '').toLowerCase();
    const name = `${el.name || ''} ${attr('id') || ''} ${attr('data-testid') || ''}`.toLowerCase();
    return {
      tag: el.tagName.toLowerCase(),
      type: type || undefined,
      role: attr('role'),
      name: el.name || undefined,
      id: el.id || undefined,
      label: (el.innerText || el.value || attr('aria-label') || attr('placeholder') || '').slice(0, 120),
      selector: cssPath(el),
      isCredentialField: type === 'password' || /password|passcode|otp|mfa|2fa|totp/.test(name) || /current-password|new-password|one-time-code/.test(autocomplete),
      isPaymentField: /^cc-|^card|cardnumber|cvc|cvv|expiry/.test(autocomplete) || /card.?number|cvv|cvc|iban|routing|account.?number/.test(name),
      isFileInput: type === 'file',
      hiddenElement: isHidden(el),
      guard: attr('data-abg-guard'),
    };
  }

  function isHidden(el) {
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return true;
      const rect = el.getBoundingClientRect();
      return rect.width < 2 || rect.height < 2;
    } catch {
      return false;
    }
  }

  function cssPath(el, max = 5) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < max) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(`#${node.id}`);
        break;
      }
      const cls = (node.className && typeof node.className === 'string' ? node.className.trim().split(/\s+/)[0] : '');
      if (cls) part += `.${cls}`;
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join('>').slice(0, 200);
  }

  /* ------------------------------------------------------- environment scan */

  function scanEnvironment() {
    const found = [];
    for (const g of AUTOMATION_GLOBALS) {
      try {
        if (g in window && window[g] !== undefined) found.push(g);
      } catch {
        /* cross-origin or throwing getter */
      }
    }
    const cdp = [];
    try {
      for (const key of Object.keys(window)) {
        if (CDP_PREFIXES.some((p) => key.startsWith(p))) cdp.push(key);
      }
      for (const key of Object.keys(document)) {
        if (CDP_PREFIXES.some((p) => key.startsWith(p))) cdp.push(`document.${key}`);
      }
    } catch {
      /* ignore */
    }

    const headlessHints = [];
    try {
      if (/HeadlessChrome/i.test(navigator.userAgent)) headlessHints.push('ua');
      if (navigator.plugins && navigator.plugins.length === 0) headlessHints.push('no_plugins');
      if (!navigator.languages || navigator.languages.length === 0) headlessHints.push('no_languages');
      if (navigator.webdriver === true) headlessHints.push('webdriver');
    } catch {
      /* ignore */
    }

    report('environment', {
      webdriver: navigator.webdriver === true,
      automationGlobals: found,
      cdpArtifacts: cdp.slice(0, 5),
      headlessHints,
      href: location.href,
    });
  }

  /* ---------------------------------------------------------------- patches */

  function patch(object, key, wrapper) {
    try {
      const original = object[key];
      if (typeof original !== 'function' || original.__abgPatched) return;
      const patched = wrapper(original);
      patched.__abgPatched = true;
      object[key] = patched;
    } catch {
      /* a frozen prototype simply goes unobserved */
    }
  }

  // element.click() — the classic way an agent presses a button.
  patch(HTMLElement.prototype, 'click', (original) =>
    function abgClick(...args) {
      const caller = callerFrame();
      const target = describe(this);
      if (target.guard === 'deny') {
        report('blocked', { kind: 'click', target, caller });
        return undefined;
      }
      report('programmatic_click', { target, caller });
      return original.apply(this, args);
    });

  // form.submit() bypasses submit listeners, so it needs its own hook.
  patch(HTMLFormElement.prototype, 'submit', (original) =>
    function abgSubmit(...args) {
      const caller = callerFrame();
      report('programmatic_submit', { target: describe(this), action: this.action, caller });
      return original.apply(this, args);
    });

  patch(HTMLFormElement.prototype, 'requestSubmit', (original) =>
    function abgRequestSubmit(...args) {
      const caller = callerFrame();
      report('programmatic_submit', { target: describe(this), action: this.action, caller, requestSubmit: true });
      return original.apply(this, args);
    });

  // Direct value assignment: no keystrokes, no input event, no trace otherwise.
  for (const [proto, name] of [
    [HTMLInputElement.prototype, 'value'],
    [HTMLTextAreaElement.prototype, 'value'],
    [HTMLSelectElement.prototype, 'value'],
  ]) {
    try {
      const desc = Object.getOwnPropertyDescriptor(proto, name);
      if (!desc?.set || desc.set.__abgPatched) continue;
      const setter = function abgValueSet(v) {
        const caller = callerFrame();
        const target = describe(this);
        if (target.guard === 'deny') {
          report('blocked', { kind: 'value_set', target, caller });
          return;
        }
        // A value set from the page's own event handlers during real typing is
        // normal; the sensor correlates with trusted keystrokes and discards it.
        report('synthetic_value_set', {
          target,
          length: String(v ?? '').length,
          value: target.isCredentialField ? undefined : String(v ?? '').slice(0, 4000),
          caller,
        });
        return desc.set.call(this, v);
      };
      setter.__abgPatched = true;
      Object.defineProperty(proto, name, { ...desc, set: setter });
    } catch {
      /* leave the property alone if the page has locked it down */
    }
  }

  // Clipboard reads expose whatever the human last copied.
  try {
    if (navigator.clipboard) {
      patch(navigator.clipboard, 'readText', (original) =>
        async function abgReadText(...args) {
          report('clipboard_read', { caller: callerFrame() });
          return original.apply(this, args);
        });
      patch(navigator.clipboard, 'writeText', (original) =>
        async function abgWriteText(text, ...rest) {
          report('clipboard_write', { caller: callerFrame(), length: String(text ?? '').length });
          return original.apply(this, [text, ...rest]);
        });
    }
  } catch {
    /* ignore */
  }

  // Model API calls made by page-resident agent code.
  patch(window, 'fetch', (original) =>
    function abgFetch(input, init, ...rest) {
      try {
        const url = typeof input === 'string' ? input : input?.url || '';
        const host = url ? new URL(url, location.href).hostname : '';
        if (isAiHost(host)) {
          report('ai_fetch', { url: String(url).slice(0, 300), method: init?.method || 'GET', caller: callerFrame() });
        }
      } catch {
        /* never break the page's own fetch */
      }
      return original.call(this, input, init, ...rest);
    });

  patch(XMLHttpRequest.prototype, 'open', (original) =>
    function abgXhrOpen(method, url, ...rest) {
      try {
        const host = url ? new URL(url, location.href).hostname : '';
        if (isAiHost(host)) {
          report('ai_fetch', { url: String(url).slice(0, 300), method, caller: callerFrame(), via: 'xhr' });
        }
      } catch {
        /* ignore */
      }
      return original.call(this, method, url, ...rest);
    });

  scanEnvironment();
  // Automation frameworks often inject their globals after first paint.
  setTimeout(scanEnvironment, 1500);
  setTimeout(scanEnvironment, 6000);
})();
