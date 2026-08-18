/** Helpers shared by the popup and the admin console. */

export const MSG = {
  ACTION_PROPOSED: 'action:proposed',
  APPROVAL_LIST: 'approval:list',
  STATE_QUERY: 'state:query',
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
  SESSION_END_REQUEST: 'session:end',
};

export function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(response);
    });
  });
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function timeAgo(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function shortUrl(url, max = 42) {
  if (!url) return '—';
  try {
    const u = new URL(url);
    const s = `${u.hostname}${u.pathname === '/' ? '' : u.pathname}`;
    return s.length > max ? `${s.slice(0, max)}…` : s;
  } catch {
    return String(url).slice(0, max);
  }
}

export function decisionBadge(decision) {
  const label = {
    allow: 'allowed', log: 'logged', warn: 'warned',
    require_approval: 'approval', block: 'blocked',
  }[decision] || decision || '—';
  return el('span', { class: `badge ${decision}`, text: label });
}

/** Trigger a file download from an extension page. */
export function download(filename, content, mime = 'application/json') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function actionLabel(type) {
  return {
    'element.click': 'Click',
    'input.fill': 'Field write',
    'form.submit': 'Form submit',
    'page.navigate': 'Navigation',
    'file.download': 'Download',
    'file.upload': 'Upload',
    'clipboard.read': 'Clipboard read',
    'clipboard.write': 'Clipboard write',
    'network.ai_egress': 'Model API call',
    'ai.prompt_submit': 'Prompt',
    'extension.inventory': 'Extension',
    'agent.session_start': 'Session start',
    'agent.session_end': 'Session end',
    'policy.changed': 'Policy change',
    'audit.cleared': 'Audit cleared',
    'control.kill_switch': 'Kill switch',
    'extension.lifecycle': 'Extension lifecycle',
  }[type] || type;
}
