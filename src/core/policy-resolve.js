/**
 * Policy layering.
 *
 * Three sources, in increasing authority:
 *   1. the shipped default policy
 *   2. the local policy the user edits in the options page
 *   3. the managed policy pushed by Chrome Enterprise (chrome.storage.managed)
 *
 * Managed sits on top because an admin's rules must survive a user's edits.
 * When the managed layer sets `locked: true`, the local layer is ignored
 * entirely — that is the difference between "a default we suggest" and "a
 * control we enforce".
 */

import { defaultPolicy } from './default-policy.js';
import { deepMerge } from './util.js';
import { validatePolicy } from './policy-engine.js';

/**
 * @param {object|null} local   user-authored overrides
 * @param {object|null} managed enterprise-pushed overrides
 * @returns {{policy:object, layers:string[], locked:boolean, errors:string[]}}
 */
export function resolveEffectivePolicy(local, managed) {
  const layers = ['default'];
  const errors = [];
  let policy = defaultPolicy();

  const managedLocked = Boolean(managed && managed.locked);

  if (local && !managedLocked) {
    const localErrors = validatePolicy(local);
    if (localErrors.length) {
      errors.push(...localErrors.map((e) => `local: ${e}`));
    } else {
      policy = deepMerge(policy, local);
      layers.push('local');
    }
  } else if (local && managedLocked) {
    errors.push('local: ignored because the managed policy is locked');
  }

  if (managed) {
    const managedErrors = validatePolicy(managed);
    if (managedErrors.length) {
      errors.push(...managedErrors.map((e) => `managed: ${e}`));
    } else {
      policy = deepMerge(policy, managed);
      layers.push('managed');
    }
  }

  return { policy, layers, locked: managedLocked, errors };
}

/**
 * Which top-level sections an admin has frozen. The options UI greys these out
 * instead of letting a user make an edit that silently does nothing.
 */
export function lockedSections(managed) {
  if (!managed) return [];
  if (managed.locked) return ['*'];
  return Object.keys(managed).filter((k) => k !== 'version');
}
