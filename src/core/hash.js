/** SHA-256 helpers that work identically in the service worker and under Node. */

export async function sha256Hex(input) {
  const data = new TextEncoder().encode(String(input));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Short display form for a hash in the UI. */
export function shortHash(hex, len = 12) {
  return typeof hex === 'string' ? hex.slice(0, len) : '';
}
