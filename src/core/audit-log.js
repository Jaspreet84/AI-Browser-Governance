/**
 * Tamper-evident audit log.
 *
 * Every record is sealed with SHA-256 over its own content plus the previous
 * record's hash. Deleting or editing a record in the middle of the chain breaks
 * verification at that point, which is the property that makes this log usable
 * as evidence rather than as a debug console.
 *
 * Storage is abstracted so the same code runs against chrome.storage.local in
 * the extension and against a plain object in tests.
 */

import { STORE } from './constants.js';
import { sha256Hex } from './hash.js';
import { newId, stableStringify } from './util.js';

const CHUNK_SIZE = 100;
const GENESIS = '0'.repeat(64);

/** Shape of the adapter callers must provide. Mirrors chrome.storage.local. */
export function memoryStore(initial = {}) {
  const data = { ...initial };
  return {
    async get(keys) {
      if (keys === null || keys === undefined) return { ...data };
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (k in data) out[k] = data[k];
      return out;
    },
    async set(obj) {
      Object.assign(data, obj);
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k];
    },
    _raw: data,
  };
}

export class AuditLog {
  /**
   * @param {object} opts
   * @param {{get,set,remove}} opts.store
   * @param {number} [opts.maxRecords]
   * @param {number} [opts.retentionDays]
   */
  constructor({ store, maxRecords = 5000, retentionDays = 30 } = {}) {
    this.store = store;
    this.maxRecords = maxRecords;
    this.retentionDays = retentionDays;
    this.queue = Promise.resolve();
  }

  /** Serialise writes: two concurrent appends must not fork the hash chain. */
  #serial(fn) {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async #index() {
    const got = await this.store.get([STORE.AUDIT_INDEX]);
    return got[STORE.AUDIT_INDEX] || { chunks: [], count: 0, seq: 0, headHash: GENESIS };
  }

  async #chunk(id) {
    const got = await this.store.get([STORE.AUDIT_CHUNK_PREFIX + id]);
    return got[STORE.AUDIT_CHUNK_PREFIX + id] || [];
  }

  /**
   * Seal and append a record.
   * @param {object} payload anything JSON-serialisable
   * @returns {Promise<object>} the sealed record
   */
  append(payload) {
    return this.#serial(async () => {
      const index = await this.#index();
      const seq = index.seq + 1;
      const record = {
        id: payload.id || newId('ev'),
        seq,
        ts: payload.ts ?? Date.now(),
        prevHash: index.headHash,
        ...payload,
      };
      delete record.hash;
      record.hash = await sha256Hex(stableStringify(record));

      let chunkId = index.chunks[index.chunks.length - 1];
      let chunk = chunkId ? await this.#chunk(chunkId) : [];
      if (!chunkId || chunk.length >= CHUNK_SIZE) {
        chunkId = String((Number(chunkId) || 0) + 1);
        chunk = [];
        index.chunks.push(chunkId);
      }
      chunk.push(record);

      await this.store.set({
        [STORE.AUDIT_CHUNK_PREFIX + chunkId]: chunk,
        [STORE.AUDIT_INDEX]: {
          ...index, // keep truncatedBefore and any future bookkeeping
          chunks: index.chunks,
          count: index.count + 1,
          seq,
          headHash: record.hash,
        },
      });
      await this.#prune();
      return record;
    });
  }

  /**
   * Drop whole chunks that fall outside retention. Chunks are removed from the
   * front only, so the remaining chain stays continuous and verifiable; the
   * index remembers where the surviving window starts.
   */
  async #prune() {
    const index = await this.#index();
    const cutoff = Date.now() - this.retentionDays * 86_400_000;
    let changed = false;

    while (index.chunks.length > 1) {
      const oldestId = index.chunks[0];
      const oldest = await this.#chunk(oldestId);
      const tooOld = oldest.length > 0 && oldest[oldest.length - 1].ts < cutoff;
      const tooMany = index.count - oldest.length >= this.maxRecords;
      if (!tooOld && !tooMany) break;
      await this.store.remove(STORE.AUDIT_CHUNK_PREFIX + oldestId);
      index.chunks.shift();
      index.count -= oldest.length;
      index.truncatedBefore = oldest[oldest.length - 1]?.seq ?? index.truncatedBefore;
      changed = true;
    }
    if (changed) await this.store.set({ [STORE.AUDIT_INDEX]: index });
  }

  /** All retained records, oldest first. */
  async all() {
    const index = await this.#index();
    const out = [];
    for (const id of index.chunks) out.push(...(await this.#chunk(id)));
    return out;
  }

  /**
   * Query the log.
   * @param {object} [q]
   * @param {number} [q.limit]
   * @param {number} [q.offset]
   * @param {string} [q.decision]
   * @param {string} [q.actor]
   * @param {string} [q.text] substring over url/reason/type
   * @param {number} [q.since] epoch ms
   */
  async query(q = {}) {
    const { limit = 100, offset = 0 } = q;
    let rows = await this.all();
    if (q.since) rows = rows.filter((r) => r.ts >= q.since);
    if (q.decision) rows = rows.filter((r) => r.decision === q.decision);
    if (q.actor) rows = rows.filter((r) => r.actor?.kind === q.actor);
    if (q.type) rows = rows.filter((r) => r.type === q.type);
    if (q.text) {
      const needle = q.text.toLowerCase();
      rows = rows.filter((r) =>
        [r.url, r.reason, r.type, r.target?.label, r.site?.primary]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(needle)),
      );
    }
    rows.reverse(); // newest first for the UI
    return { total: rows.length, rows: rows.slice(offset, offset + limit) };
  }

  /**
   * Recompute the chain.
   * @returns {Promise<{ok:boolean, checked:number, brokenAt:number|null, reason:string|null}>}
   */
  async verify() {
    const rows = await this.all();
    if (rows.length === 0) return { ok: true, checked: 0, brokenAt: null, reason: null };
    let prev = rows[0].prevHash;
    for (const row of rows) {
      if (row.prevHash !== prev) {
        return { ok: false, checked: row.seq, brokenAt: row.seq, reason: 'Chain link mismatch (a record was removed or reordered)' };
      }
      const copy = { ...row };
      delete copy.hash;
      const expected = await sha256Hex(stableStringify(copy));
      if (expected !== row.hash) {
        return { ok: false, checked: row.seq, brokenAt: row.seq, reason: 'Record hash mismatch (a record was edited)' };
      }
      prev = row.hash;
    }
    return { ok: true, checked: rows.length, brokenAt: null, reason: null };
  }

  /** NDJSON is the friendliest thing to hand a SIEM; CSV is for spreadsheets. */
  async export(format = 'ndjson') {
    const rows = await this.all();
    if (format === 'json') return JSON.stringify(rows, null, 2);
    if (format === 'csv') return toCsv(rows);
    return rows.map((r) => JSON.stringify(r)).join('\n');
  }

  /**
   * Clear the log. This is itself an auditable event: the new chain starts with
   * a record saying who cleared it and how many records were destroyed.
   */
  clear(reason = 'operator request') {
    return this.#serial(async () => {
      const index = await this.#index();
      for (const id of index.chunks) await this.store.remove(STORE.AUDIT_CHUNK_PREFIX + id);
      await this.store.set({
        [STORE.AUDIT_INDEX]: { chunks: [], count: 0, seq: index.seq, headHash: GENESIS, clearedAt: Date.now() },
      });
      return { cleared: index.count, reason };
    });
  }

  async stats() {
    const index = await this.#index();
    return {
      count: index.count,
      seq: index.seq,
      headHash: index.headHash,
      truncatedBefore: index.truncatedBefore ?? null,
      chunks: index.chunks.length,
    };
  }
}

const CSV_COLUMNS = ['seq', 'ts', 'type', 'decision', 'reason', 'actorKind', 'actorConfidence', 'risk', 'url', 'targetLabel', 'dlp', 'matchedRules', 'hash'];

export function toCsv(rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const line = (r) =>
    [
      r.seq,
      new Date(r.ts).toISOString(),
      r.type,
      r.decision,
      r.reason,
      r.actor?.kind,
      r.actor?.confidence,
      r.risk?.score,
      r.url,
      r.target?.label,
      (r.data?.dlp || []).map((f) => f.detectorId).join('|'),
      (r.matchedRules || []).join('|'),
      r.hash,
    ]
      .map(esc)
      .join(',');
  return [CSV_COLUMNS.join(','), ...rows.map(line)].join('\n');
}
