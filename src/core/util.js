/**
 * Small dependency-free helpers shared by the extension and the test suite.
 * Nothing in here may touch chrome.* so the logic stays testable under Node.
 */

/** Cheap, collision-resistant-enough id for actions and audit records. */
export function newId(prefix = 'a') {
  const rand = globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 16)
    : Math.random().toString(16).slice(2, 18).padEnd(16, '0');
  return `${prefix}_${rand}`;
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/**
 * Parse a URL without throwing. Returns null for opaque schemes we can't reason
 * about (about:, chrome:, data:) so callers can decide to skip them.
 */
export function safeUrl(input) {
  if (typeof input !== 'string' || input.length === 0) return null;
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

export function hostOf(url) {
  const u = typeof url === 'string' ? safeUrl(url) : url;
  return u ? u.hostname.toLowerCase() : '';
}

export function originOf(url) {
  const u = typeof url === 'string' ? safeUrl(url) : url;
  return u ? u.origin : '';
}

/** Registrable-ish suffix comparison: `a.b.example.com` matches `example.com`. */
export function hostMatches(host, pattern) {
  if (!host || !pattern) return false;
  const h = host.toLowerCase();
  const p = pattern.toLowerCase().replace(/^\*\./, '');
  return h === p || h.endsWith(`.${p}`);
}

/**
 * Match a URL against a pattern.
 *
 * Supported forms:
 *   example.com                  -> host and any subdomain, any path
 *   *.example.com/admin/*        -> host suffix + glob path
 *   https://example.com/x        -> exact-ish glob over the whole URL
 *   re:^https://foo\.com/(a|b)   -> raw regular expression over the whole URL
 */
export function urlMatches(url, pattern) {
  if (!url || !pattern) return false;
  const raw = String(pattern).trim();
  if (raw === '*' || raw === '<all_urls>') return true;

  if (raw.startsWith('re:')) {
    try {
      return new RegExp(raw.slice(3)).test(url);
    } catch {
      return false;
    }
  }

  const u = safeUrl(url);
  if (!u) return false;

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || raw.includes('/')) {
    // Pattern carries a scheme and/or a path: match the parts separately so a
    // `*.` host wildcard still covers the bare apex domain.
    const m = /^(?:([a-z][a-z0-9+.-]*|\*):\/\/)?([^/]*)(\/.*)?$/i.exec(raw);
    if (!m) return false;
    const [, scheme, hostPart, pathPart] = m;
    if (scheme && scheme !== '*' && `${scheme}:` !== u.protocol) return false;
    if (hostPart && hostPart !== '*' && !hostMatches(u.hostname, hostPart)) return false;
    if (pathPart && pathPart !== '/*') {
      return globToRegExp(pathPart).test(`${u.pathname}${u.search}`);
    }
    return true;
  }

  return hostMatches(u.hostname, raw);
}

/** Translate a `*` glob into an anchored RegExp. `*` never crosses nothing else. */
export function globToRegExp(glob) {
  const escaped = String(glob).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/** True when any pattern in the list matches the URL. */
export function matchesAny(url, patterns) {
  if (!Array.isArray(patterns)) return false;
  return patterns.some((p) => urlMatches(url, p));
}

/**
 * Redact a string for storage: keeps shape (length, leading chars) so an
 * investigator can correlate, without persisting the secret itself.
 */
export function redact(value, keep = 4) {
  const s = String(value ?? '');
  if (s.length <= keep) return '*'.repeat(s.length);
  return `${s.slice(0, keep)}${'*'.repeat(Math.min(s.length - keep, 24))}`;
}

/** Trim page text to a bounded, single-line sample for the audit record. */
export function sample(text, max = 240) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function nowIso(ts = Date.now()) {
  return new Date(ts).toISOString();
}

/** Structured deep clone that also works on old runtimes. */
export function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

/**
 * Recursive merge used to layer: defaults <- managed policy <- local overrides.
 * Arrays are replaced wholesale (a partial array of rules is never what an
 * admin means); plain objects merge key by key.
 */
export function deepMerge(base, override) {
  if (override === undefined || override === null) return clone(base);
  if (Array.isArray(base) || Array.isArray(override)) return clone(override);
  if (typeof base !== 'object' || typeof override !== 'object') return clone(override);
  const out = clone(base);
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in out ? deepMerge(out[k], v) : clone(v);
  }
  return out;
}

/** Stable stringify so hashes do not change when key order does. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  let pending = null;
  return (...args) => {
    pending = args;
    const gap = Date.now() - last;
    if (gap >= ms) {
      last = Date.now();
      fn(...pending);
      return;
    }
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn(...pending);
      }, ms - gap);
    }
  };
}
