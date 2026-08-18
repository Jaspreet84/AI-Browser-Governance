/**
 * In-page governance UI: the approval modal, decision toasts, and the agent
 * activity banner. Lives in the content script's isolated world and renders
 * into a closed shadow root so page CSS cannot restyle a security prompt and
 * page script cannot read or click it.
 *
 * The load-bearing rule in this file: **only trusted events can approve**.
 * If the approval button could be clicked by `button.click()`, the agent being
 * governed could approve its own action, and the whole extension would be
 * theatre.
 */

(() => {
  if (globalThis.ABGOverlay) return;

  const STYLE = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  .wrap { position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
  .scrim { position: absolute; inset: 0; background: rgba(15,23,42,.55); backdrop-filter: blur(2px); pointer-events: auto; }
  .modal {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%);
    width: min(560px, calc(100vw - 32px)); max-height: calc(100vh - 32px); overflow: auto;
    background: #fff; color: #0f172a; border-radius: 14px; pointer-events: auto;
    box-shadow: 0 24px 60px rgba(2,6,23,.45); border: 1px solid #cbd5e1;
  }
  .head { display: flex; gap: 12px; align-items: flex-start; padding: 18px 20px 12px; border-bottom: 1px solid #e2e8f0; }
  .mark { width: 34px; height: 34px; border-radius: 9px; background: #b45309; color: #fff; display: grid; place-items: center; font-weight: 700; font-size: 15px; flex: none; }
  .mark.block { background: #b91c1c; }
  h1 { margin: 0; font-size: 15px; font-weight: 650; line-height: 1.3; }
  .sub { margin: 3px 0 0; font-size: 12px; color: #64748b; }
  .body { padding: 14px 20px; display: grid; gap: 12px; }
  .row { display: grid; grid-template-columns: 116px 1fr; gap: 10px; font-size: 12.5px; align-items: start; }
  .k { color: #64748b; }
  .v { color: #0f172a; word-break: break-word; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; background: #f1f5f9; padding: 1px 5px; border-radius: 4px; }
  .risk { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; font-size: 12px; padding: 2px 9px; border-radius: 999px; }
  .risk.low { background: #dcfce7; color: #166534; }
  .risk.medium { background: #fef9c3; color: #854d0e; }
  .risk.high { background: #ffedd5; color: #9a3412; }
  .risk.critical { background: #fee2e2; color: #991b1b; }
  .findings { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { font-size: 11px; background: #fee2e2; color: #991b1b; border-radius: 999px; padding: 2px 8px; }
  .chip.rule { background: #e0e7ff; color: #3730a3; }
  textarea { width: 100%; min-height: 62px; resize: vertical; border: 1px solid #cbd5e1; border-radius: 8px; padding: 8px; font-size: 12.5px; }
  .foot { display: flex; gap: 10px; align-items: center; padding: 14px 20px; border-top: 1px solid #e2e8f0; }
  .spacer { flex: 1; }
  button { font: inherit; font-size: 13px; font-weight: 600; border-radius: 9px; padding: 9px 16px; cursor: pointer; border: 1px solid transparent; }
  .deny { background: #fff; color: #0f172a; border-color: #cbd5e1; }
  .deny:hover { background: #f8fafc; }
  .approve { background: #b45309; color: #fff; }
  .approve:hover { background: #92400e; }
  .approve[disabled] { opacity: .5; cursor: not-allowed; }
  label.remember { display: flex; gap: 7px; align-items: center; font-size: 12px; color: #475569; }
  .countdown { font-size: 11.5px; color: #64748b; }
  .warnbar { margin: 0 20px 12px; padding: 8px 10px; border-radius: 8px; background: #fef2f2; color: #991b1b; font-size: 12px; display: none; }
  .warnbar.show { display: block; }

  .toasts { position: absolute; right: 16px; bottom: 16px; display: grid; gap: 8px; justify-items: end; }
  .toast {
    pointer-events: auto; background: #0f172a; color: #f8fafc; border-radius: 10px; padding: 10px 13px;
    font-size: 12.5px; max-width: 360px; box-shadow: 0 10px 30px rgba(2,6,23,.4); border-left: 3px solid #f59e0b;
  }
  .toast.block { border-left-color: #ef4444; }
  .toast.allow { border-left-color: #22c55e; }
  .toast b { display: block; font-size: 12.5px; margin-bottom: 2px; }
  .toast .why { color: #cbd5e1; }

  .banner {
    position: absolute; left: 50%; transform: translateX(-50%); top: 10px; pointer-events: auto;
    background: rgba(15,23,42,.92); color: #e2e8f0; border-radius: 999px; padding: 6px 14px; font-size: 12px;
    display: flex; align-items: center; gap: 8px; box-shadow: 0 8px 24px rgba(2,6,23,.35);
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #38bdf8; }
  .dot.lockdown { background: #f87171; }
  .dot.monitor { background: #94a3b8; }
  @media (prefers-color-scheme: dark) {
    .modal { background: #0f172a; color: #e2e8f0; border-color: #334155; }
    .head, .foot { border-color: #1e293b; }
    .v { color: #e2e8f0; }
    code { background: #1e293b; color: #e2e8f0; }
    textarea { background: #1e293b; color: #e2e8f0; border-color: #334155; }
    .deny { background: #1e293b; color: #e2e8f0; border-color: #334155; }
  }`;

  let host = null;
  let root = null;
  const state = { modal: null, banner: null };

  function ensureRoot() {
    if (root && host?.isConnected) return root;
    host = document.createElement('div');
    host.setAttribute('data-abg-ui', '');
    host.style.cssText = 'all:initial;position:fixed;inset:0;width:0;height:0;z-index:2147483647';
    root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    const toasts = document.createElement('div');
    toasts.className = 'toasts';
    wrap.appendChild(toasts);
    root.append(style, wrap);
    (document.documentElement || document).appendChild(host);
    root._wrap = wrap;
    root._toasts = toasts;
    return root;
  }

  const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

  function riskClass(band) {
    return ['low', 'medium', 'high', 'critical'].includes(band) ? band : 'low';
  }

  /**
   * Show the approval modal.
   * @returns {Promise<{approved:boolean, justification:string, remember:boolean}>}
   */
  function approval(req) {
    const r = ensureRoot();
    dismissModal();

    const el = document.createElement('div');
    el.innerHTML = `
      <div class="scrim"></div>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="abg-title">
        <div class="head">
          <div class="mark">AI</div>
          <div>
            <h1 id="abg-title">An AI agent wants to ${esc(actionVerb(req.action?.type))}</h1>
            <p class="sub">${esc(req.reason || 'This action matched your governance policy.')}</p>
          </div>
        </div>
        <div class="body">
          <div class="row"><div class="k">Target</div><div class="v">${esc(req.action?.target?.label || req.action?.target?.selector || '(unnamed element)')}</div></div>
          <div class="row"><div class="k">Page</div><div class="v"><code>${esc(shortUrl(req.action?.url))}</code></div></div>
          <div class="row"><div class="k">Risk</div><div class="v"><span class="risk ${riskClass(req.risk?.band)}">${esc(req.risk?.band || 'low')} · ${esc(req.risk?.score ?? 0)}</span></div></div>
          <div class="row"><div class="k">Agent confidence</div><div class="v">${Math.round((req.action?.actor?.confidence ?? 0) * 100)}% — ${esc((req.action?.actor?.reasons || []).slice(0, 2).join('; ') || 'behavioural signals')}</div></div>
          ${findingsRow(req)}
          ${rulesRow(req)}
          ${req.requireJustification ? '<div class="row"><div class="k">Justification</div><div class="v"><textarea id="abg-just" placeholder="Why should this be allowed? (recorded in the audit log)"></textarea></div></div>' : ''}
        </div>
        <div class="warnbar" id="abg-warn">A synthetic click was ignored. Approval requires a real key press or mouse click.</div>
        <div class="foot">
          ${req.allowRemember ? '<label class="remember"><input type="checkbox" id="abg-remember"> Remember for this session</label>' : ''}
          <span class="spacer"></span>
          <span class="countdown" id="abg-count"></span>
          <button class="deny" id="abg-deny">Deny</button>
          <button class="approve" id="abg-approve">Approve once</button>
        </div>
      </div>`;
    r._wrap.appendChild(el);

    const $ = (id) => el.querySelector(`#${id}`);
    const approveBtn = $('abg-approve');
    const denyBtn = $('abg-deny');
    const warn = $('abg-warn');

    return new Promise((resolve) => {
      let settled = false;
      const finish = (approved) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        document.removeEventListener('keydown', onKey, true);
        const result = {
          approved,
          justification: $('abg-just')?.value?.slice(0, 500) || '',
          remember: Boolean($('abg-remember')?.checked),
        };
        el.remove();
        state.modal = null;
        resolve(result);
      };

      // Trusted-event gate. An untrusted click on Approve is itself evidence
      // and is surfaced to the human rather than silently dropped.
      const guard = (fn) => (event) => {
        if (!event.isTrusted) {
          warn.classList.add('show');
          globalThis.ABGOverlay?._onSyntheticApproval?.(req);
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
        fn();
      };

      approveBtn.addEventListener('click', guard(() => finish(true)), true);
      denyBtn.addEventListener('click', guard(() => finish(false)), true);

      const onKey = (event) => {
        if (!event.isTrusted) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          finish(false);
        }
      };
      document.addEventListener('keydown', onKey, true);

      let left = req.timeoutSeconds || 60;
      const count = $('abg-count');
      const tick = () => {
        left -= 1;
        if (count) count.textContent = `auto-denies in ${Math.max(left, 0)}s`;
        if (left <= 0) finish(false);
      };
      if (count) count.textContent = `auto-denies in ${left}s`;
      const timer = setInterval(tick, 1000);

      state.modal = { el, finish };
      setTimeout(() => denyBtn.focus(), 30);
    });
  }

  function findingsRow(req) {
    const findings = req.action?.data?.dlp || [];
    if (!findings.length) return '';
    const chips = findings
      .slice(0, 6)
      .map((f) => `<span class="chip">${esc(f.name)}${f.count > 1 ? ` ×${f.count}` : ''}</span>`)
      .join('');
    return `<div class="row"><div class="k">Sensitive data</div><div class="v findings">${chips}</div></div>`;
  }

  function rulesRow(req) {
    const rules = req.matchedRules || [];
    if (!rules.length) return '';
    return `<div class="row"><div class="k">Policy</div><div class="v findings">${rules
      .slice(0, 5)
      .map((r) => `<span class="chip rule">${esc(r)}</span>`)
      .join('')}</div></div>`;
  }

  function actionVerb(type) {
    return {
      'element.click': 'click a control',
      'input.fill': 'type into a field',
      'form.submit': 'submit a form',
      'file.upload': 'upload a file',
      'file.download': 'download a file',
      'clipboard.read': 'read your clipboard',
      'page.navigate': 'navigate this tab',
      'ai.prompt_submit': 'send a prompt to a model',
      'network.ai_egress': 'send data to a model provider',
    }[type] || 'act on this page';
  }

  function shortUrl(url) {
    try {
      const u = new URL(url);
      return `${u.hostname}${u.pathname.length > 32 ? `${u.pathname.slice(0, 32)}…` : u.pathname}`;
    } catch {
      return String(url || '').slice(0, 60);
    }
  }

  function dismissModal() {
    if (state.modal) {
      state.modal.el.remove();
      state.modal = null;
    }
  }

  function toast({ title, message, tone = 'warn', timeout = 6000 }) {
    const r = ensureRoot();
    const el = document.createElement('div');
    el.className = `toast ${tone}`;
    el.innerHTML = `<b>${esc(title)}</b><span class="why">${esc(message)}</span>`;
    r._toasts.appendChild(el);
    setTimeout(() => el.remove(), timeout);
  }

  /** Persistent indicator that an agent is driving this tab. */
  function banner(info) {
    const r = ensureRoot();
    if (!info) {
      state.banner?.remove();
      state.banner = null;
      return;
    }
    if (!state.banner) {
      state.banner = document.createElement('div');
      state.banner.className = 'banner';
      r._wrap.appendChild(state.banner);
    }
    state.banner.innerHTML = `<span class="dot ${esc(info.mode)}"></span><span>${esc(info.text)}</span>`;
  }

  globalThis.ABGOverlay = { approval, toast, banner, dismissModal, _onSyntheticApproval: null };
})();
