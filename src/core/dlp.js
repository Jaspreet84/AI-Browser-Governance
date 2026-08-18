/**
 * Data-loss detectors.
 *
 * These run over text an agent is about to type, submit, paste, or send to a
 * model provider. Findings never carry the matched secret itself — only its
 * position, a redacted preview, and a severity — because the audit log is a
 * long-lived artifact and must not become the place your API keys leak from.
 */

import { SEVERITY, SEVERITY_RANK } from './constants.js';
import { redact } from './util.js';

/**
 * Built-in detectors. `validate` is an optional second gate that kills the
 * regex's false positives (e.g. Luhn for card numbers).
 */
export const BUILTIN_DETECTORS = [
  {
    id: 'aws_access_key',
    name: 'AWS access key id',
    severity: SEVERITY.CRITICAL,
    regex: /\b((?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16})\b/g,
  },
  {
    id: 'aws_secret_key',
    name: 'AWS secret access key',
    severity: SEVERITY.CRITICAL,
    regex: /\baws_secret_access_key\s*[=:]\s*["']?([A-Za-z0-9/+=]{40})["']?/gi,
  },
  {
    id: 'gcp_service_account',
    name: 'GCP service account key',
    severity: SEVERITY.CRITICAL,
    regex: /"type"\s*:\s*"(service_account)"/g,
  },
  {
    id: 'private_key_block',
    name: 'PEM private key',
    severity: SEVERITY.CRITICAL,
    regex: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/g,
  },
  {
    id: 'github_token',
    name: 'GitHub token',
    severity: SEVERITY.CRITICAL,
    regex: /\b((?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,255})\b/g,
  },
  {
    id: 'anthropic_key',
    name: 'Anthropic API key',
    severity: SEVERITY.CRITICAL,
    regex: /\b(sk-ant-[A-Za-z0-9_-]{20,})\b/g,
  },
  {
    id: 'openai_key',
    name: 'OpenAI API key',
    severity: SEVERITY.CRITICAL,
    regex: /\b(sk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,})\b/g,
  },
  {
    id: 'slack_token',
    name: 'Slack token',
    severity: SEVERITY.HIGH,
    regex: /\b(xox[baprs]-[A-Za-z0-9-]{10,})\b/g,
  },
  {
    id: 'jwt',
    name: 'JSON web token',
    severity: SEVERITY.HIGH,
    regex: /\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g,
  },
  {
    id: 'bearer_header',
    name: 'Authorization bearer header',
    severity: SEVERITY.HIGH,
    regex: /\bauthorization\s*[:=]\s*["']?bearer\s+([A-Za-z0-9._~+/=-]{16,})/gi,
  },
  {
    id: 'password_assignment',
    name: 'Password in text',
    severity: SEVERITY.HIGH,
    regex: /\b(?:password|passwd|pwd|secret)\s*[=:]\s*["']?([^\s"',;]{6,})/gi,
  },
  {
    id: 'credit_card',
    name: 'Payment card number',
    severity: SEVERITY.CRITICAL,
    regex: /\b(?:\d[ -]?){12,18}\d\b/g,
    validate: (match) => luhn(match.replace(/[ -]/g, '')),
  },
  {
    id: 'us_ssn',
    name: 'US social security number',
    severity: SEVERITY.CRITICAL,
    regex: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
  },
  {
    id: 'iban',
    name: 'IBAN',
    severity: SEVERITY.HIGH,
    regex: /\b([A-Z]{2}\d{2}[A-Z0-9]{11,30})\b/g,
    validate: (match) => ibanChecksum(match),
  },
  {
    id: 'email',
    name: 'Email address',
    severity: SEVERITY.LOW,
    regex: /\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g,
  },
  {
    id: 'phone',
    name: 'Phone number',
    severity: SEVERITY.LOW,
    regex: /(?:\+\d{1,3}[ -]?)?\(?\d{3}\)?[ -]\d{3}[ -]\d{4}\b/g,
  },
  {
    id: 'ip_private',
    name: 'Internal IP address',
    severity: SEVERITY.MEDIUM,
    regex: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
  },
  {
    id: 'internal_host',
    name: 'Internal hostname',
    severity: SEVERITY.MEDIUM,
    regex: /\b([a-z0-9-]+\.(?:internal|corp|intra|lan|local))\b/gi,
  },
];

/** Luhn check — the difference between "16 digits" and "a card number". */
export function luhn(digits) {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** ISO 13616 mod-97 check for IBANs. */
export function ibanChecksum(iban) {
  const s = iban.replace(/\s+/g, '').toUpperCase();
  if (s.length < 15 || s.length > 34) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const code = /[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const digit of code) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

/** Compile admin-authored patterns, skipping any that fail to parse. */
export function compileCustomDetectors(custom = []) {
  const out = [];
  for (const c of custom) {
    if (!c || !c.regex) continue;
    try {
      out.push({
        id: c.id || `custom_${out.length}`,
        name: c.name || c.id || 'Custom pattern',
        severity: c.severity && SEVERITY_RANK[c.severity] ? c.severity : SEVERITY.MEDIUM,
        regex: new RegExp(c.regex, c.flags || 'g'),
        custom: true,
      });
    } catch {
      // A malformed admin regex must not take the whole scanner down.
    }
  }
  return out;
}

/** Detector list for a given options bag: built-ins (optionally filtered) + custom. */
function detectorsFor(options = {}) {
  const { enabled, custom = [] } = options;
  return [
    ...BUILTIN_DETECTORS.filter((d) => !enabled || enabled.includes(d.id)),
    ...compileCustomDetectors(custom),
  ];
}

/**
 * Locate every validated hit for one detector.
 * Returns ranges into the original string so both scanning and redaction work
 * from the same ground truth instead of two slightly different regex walks.
 */
function matchRanges(text, det) {
  const flags = det.regex.flags.includes('g') ? det.regex.flags : `${det.regex.flags}g`;
  const re = new RegExp(det.regex.source, flags);
  const ranges = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    const whole = m[0];
    // Only trust a capture group when the pattern defines exactly one; multi-group
    // patterns describe a shape whose whole match is the sensitive value.
    const captured = m.length === 2 && typeof m[1] === 'string' ? m[1] : null;
    const hit = captured ?? whole;
    const offsetInMatch = captured ? whole.indexOf(captured) : 0;
    if (m.index === re.lastIndex) re.lastIndex += 1;
    if (det.validate && !det.validate(hit)) continue;
    const start = m.index + (offsetInMatch < 0 ? 0 : offsetInMatch);
    ranges.push({ start, end: start + hit.length, hit, detector: det });
    if (ranges.length >= 100) break;
  }
  return ranges;
}

/**
 * Scan text and return findings.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {string[]} [options.enabled] detector ids to run; omit for all built-ins
 * @param {Array}   [options.custom]   admin-defined patterns
 * @param {number}  [options.maxFindings]
 * @returns {Array<{detectorId,name,severity,count,preview,index,custom}>}
 */
export function scan(text, options = {}) {
  const value = typeof text === 'string' ? text : '';
  if (!value) return [];
  const { maxFindings = 50 } = options;
  const findings = [];
  for (const det of detectorsFor(options)) {
    const ranges = matchRanges(value, det);
    if (ranges.length === 0) continue;
    findings.push({
      detectorId: det.id,
      name: det.name,
      severity: det.severity,
      count: ranges.length,
      preview: redact(ranges[0].hit),
      index: ranges[0].start,
      custom: Boolean(det.custom),
    });
    if (findings.length >= maxFindings) break;
  }
  return findings.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
}

/** Highest severity in a finding list, or null when clean. */
export function maxSeverity(findings) {
  if (!findings || findings.length === 0) return null;
  return findings.reduce(
    (acc, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[acc] ? f.severity : acc),
    SEVERITY.LOW,
  );
}

export function atLeast(severity, threshold) {
  if (!threshold) return true;
  if (!severity) return false;
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[threshold];
}

/**
 * Replace every detected secret with a placeholder. Used by the `redact`
 * remediation so an agent can keep working on sanitised text instead of being
 * blocked outright. Overlapping hits are resolved by severity, then by span.
 */
export function redactText(text, options = {}) {
  const value = typeof text === 'string' ? text : '';
  if (!value) return value;
  const ranges = [];
  for (const det of detectorsFor(options)) ranges.push(...matchRanges(value, det));
  ranges.sort(
    (a, b) =>
      a.start - b.start ||
      SEVERITY_RANK[b.detector.severity] - SEVERITY_RANK[a.detector.severity] ||
      b.end - a.end,
  );

  let out = '';
  let cursor = 0;
  for (const r of ranges) {
    if (r.start < cursor) continue; // already covered by a stronger overlapping hit
    out += value.slice(cursor, r.start) + `[REDACTED:${r.detector.id}]`;
    cursor = r.end;
  }
  return out + value.slice(cursor);
}
