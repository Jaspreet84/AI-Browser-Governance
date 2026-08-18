/** Promise wrappers over chrome.storage, plus the adapter the audit log wants. */

export const local = {
  async get(keys) {
    return chrome.storage.local.get(keys ?? null);
  },
  async set(obj) {
    return chrome.storage.local.set(obj);
  },
  async remove(keys) {
    return chrome.storage.local.remove(keys);
  },
};

export const session = {
  async get(keys) {
    return chrome.storage.session ? chrome.storage.session.get(keys ?? null) : {};
  },
  async set(obj) {
    return chrome.storage.session ? chrome.storage.session.set(obj) : undefined;
  },
};

/** Managed storage is absent on unmanaged machines; that is not an error. */
export async function readManaged() {
  try {
    const all = await chrome.storage.managed.get(null);
    if (!all || Object.keys(all).length === 0) return null;
    return all.policy ?? all;
  } catch {
    return null;
  }
}

export async function getValue(key, fallback = null) {
  const got = await local.get([key]);
  return key in got ? got[key] : fallback;
}

export async function setValue(key, value) {
  await local.set({ [key]: value });
  return value;
}
