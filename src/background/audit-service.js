/**
 * Audit plumbing: keeps one AuditLog instance over chrome.storage.local, and
 * optionally forwards sealed records to a SIEM endpoint in small batches.
 * Forwarding never blocks a decision — governance must not add latency to the
 * page, and a dead collector must not stop enforcement.
 */

import { AuditLog } from '../core/audit-log.js';
import { local } from './storage.js';
import { getPolicy } from './policy-service.js';

let log = null;
let forwardQueue = [];
let flushing = false;

export async function getLog() {
  const policy = await getPolicy();
  if (!log) {
    log = new AuditLog({
      store: local,
      maxRecords: policy.audit?.maxRecords ?? 5000,
      retentionDays: policy.audit?.retentionDays ?? 30,
    });
  } else {
    log.maxRecords = policy.audit?.maxRecords ?? log.maxRecords;
    log.retentionDays = policy.audit?.retentionDays ?? log.retentionDays;
  }
  return log;
}

export async function record(payload) {
  const auditLog = await getLog();
  const sealed = await auditLog.append(payload);
  queueForward(sealed);
  return sealed;
}

async function queueForward(record) {
  const policy = await getPolicy();
  const cfg = policy.audit?.forward;
  if (!cfg?.enabled || !cfg.url) return;
  forwardQueue.push(record);
  if (forwardQueue.length >= (cfg.batchSize || 25)) flushForward();
}

export async function flushForward() {
  if (flushing || forwardQueue.length === 0) return;
  const policy = await getPolicy();
  const cfg = policy.audit?.forward;
  if (!cfg?.enabled || !cfg.url) {
    forwardQueue = [];
    return;
  }
  flushing = true;
  const batch = forwardQueue.splice(0, cfg.batchSize || 25);
  try {
    const headers = { 'Content-Type': 'application/x-ndjson' };
    if (cfg.headerName && cfg.headerValue) headers[cfg.headerName] = cfg.headerValue;
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers,
      body: batch.map((r) => JSON.stringify(r)).join('\n'),
    });
    if (!res.ok) throw new Error(`collector responded ${res.status}`);
  } catch (e) {
    // Put the batch back, bounded, so a flaky collector does not eat evidence
    // and a permanently dead one does not eat memory either.
    forwardQueue = [...batch, ...forwardQueue].slice(0, 500);
    console.warn('[abg] audit forward failed', e);
  } finally {
    flushing = false;
  }
}

export function pendingForwardCount() {
  return forwardQueue.length;
}
