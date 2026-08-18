/**
 * Model-provider egress watch.
 *
 * Sensors in the page see what an agent does to the DOM. This sees what leaves
 * the browser: which model APIs are called, from which tab or extension, and —
 * when the body is readable — whether the prompt carries secrets.
 *
 * Observation only. Blocking is done with declarativeNetRequest from
 * policy-service, because MV3 removed blocking webRequest.
 */

import { ACTION, ACTOR, SIGNAL } from '../core/constants.js';
import { AI_API_HOSTS, isModelApiUrl } from '../core/agent-signals.js';
import { providerFor } from '../core/sites.js';
import { hostOf, sample } from '../core/util.js';

const MAX_BODY_BYTES = 64 * 1024;
let installed = false;
let onEgress = () => {};

/** Build the URL filter from the built-in catalogue plus admin additions. */
function filterUrls(policy) {
  const extra = (policy?.siteClasses?.aiProviders || [])
    .map((p) => String(p).replace(/^https?:\/\//, '').split('/')[0])
    .filter(Boolean);
  return [...new Set([...AI_API_HOSTS, ...extra])].map((h) => `*://${h}/*`);
}

/**
 * @param {object} policy
 * @param {(egress:object)=>void} handler called with a normalised AI_EGRESS action
 */
export function install(policy, handler) {
  onEgress = handler;
  if (!chrome.webRequest?.onBeforeRequest) return;
  if (installed) uninstall();

  const urls = filterUrls(policy);
  if (urls.length === 0) return;

  chrome.webRequest.onBeforeRequest.addListener(handleRequest, { urls }, ['requestBody']);
  chrome.webRequest.onCompleted.addListener(handleCompleted, { urls });
  installed = true;
}

export function uninstall() {
  if (!installed) return;
  try {
    chrome.webRequest.onBeforeRequest.removeListener(handleRequest);
    chrome.webRequest.onCompleted.removeListener(handleCompleted);
  } catch {
    // listener may already be gone after a service-worker restart
  }
  installed = false;
}

const inFlight = new Map();

function handleRequest(details) {
  if (!isModelApiUrl(details.url)) return;
  const initiator = details.initiator || details.documentUrl || '';
  const extensionId = initiator.startsWith('chrome-extension://')
    ? initiator.slice('chrome-extension://'.length).split('/')[0]
    : null;
  if (extensionId === chrome.runtime.id) return; // never audit our own forwarding

  const body = decodeBody(details.requestBody);
  const signals = [{ type: SIGNAL.AI_SDK_TRAFFIC, at: Date.now(), detail: hostOf(details.url) }];
  if (extensionId) signals.push({ type: SIGNAL.EXTENSION_INITIATOR, at: Date.now(), detail: extensionId });

  const egress = {
    type: ACTION.AI_EGRESS,
    url: details.url,
    origin: initiator,
    tabId: details.tabId >= 0 ? details.tabId : null,
    method: details.method,
    provider: providerFor(hostOf(details.url)),
    actor: {
      kind: extensionId ? ACTOR.AGENT : ACTOR.UNKNOWN,
      confidence: extensionId ? 0.7 : 0.5,
      attribution: extensionId ? { extensionId } : {},
    },
    signals,
    body,
    requestId: details.requestId,
  };
  inFlight.set(details.requestId, { url: details.url, at: Date.now() });
  onEgress(egress);
}

function handleCompleted(details) {
  inFlight.delete(details.requestId);
}

/**
 * Best-effort body decode. Chrome hands us raw bytes for JSON payloads and a
 * parsed map for form posts; both are capped so a large upload cannot stall the
 * worker.
 */
export function decodeBody(requestBody) {
  if (!requestBody) return { text: '', truncated: false, kind: 'none' };
  try {
    if (requestBody.formData) {
      const text = Object.entries(requestBody.formData)
        .map(([k, v]) => `${k}=${[].concat(v).join(',')}`)
        .join('&');
      return { text: text.slice(0, MAX_BODY_BYTES), truncated: text.length > MAX_BODY_BYTES, kind: 'formdata' };
    }
    if (requestBody.raw?.length) {
      const decoder = new TextDecoder('utf-8', { fatal: false });
      let out = '';
      let bytes = 0;
      for (const part of requestBody.raw) {
        if (!part.bytes) continue;
        bytes += part.bytes.byteLength;
        out += decoder.decode(part.bytes, { stream: true });
        if (out.length >= MAX_BODY_BYTES) break;
      }
      return { text: out.slice(0, MAX_BODY_BYTES), truncated: bytes > MAX_BODY_BYTES, kind: 'raw' };
    }
  } catch {
    return { text: '', truncated: false, kind: 'undecodable' };
  }
  return { text: '', truncated: false, kind: 'empty' };
}

/**
 * Pull the human-meaningful text out of a model API payload so DLP scans the
 * prompt rather than the JSON scaffolding around it.
 */
export function extractPromptText(bodyText) {
  if (!bodyText) return '';
  try {
    const json = JSON.parse(bodyText);
    const parts = [];
    const walk = (node, depth = 0) => {
      if (depth > 6 || parts.length > 50) return;
      if (typeof node === 'string') {
        parts.push(node);
      } else if (Array.isArray(node)) {
        node.forEach((n) => walk(n, depth + 1));
      } else if (node && typeof node === 'object') {
        for (const key of ['system', 'prompt', 'input', 'content', 'text', 'messages', 'contents', 'parts', 'query']) {
          if (key in node) walk(node[key], depth + 1);
        }
      }
    };
    walk(json);
    return parts.join('\n');
  } catch {
    return sample(bodyText, 4000);
  }
}
