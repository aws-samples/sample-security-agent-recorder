// Storage adapter for the Domain Recorder Extension.
//
// All reads from and writes to `storage.local` go through this module so
// that error handling, default values, and bootstrap normalization are
// applied in one place. The exported functions never throw; failures are
// surfaced as `{ ok: false, error }` (for the save/clear paths) or absorbed
// into safe defaults (for the load path), and every failure is logged with
// the prefix `[domain-recorder]` and an identification of the failed key.
//
// Validates / Implements Requirements: 3.4, 3.5, 4.4, 4.5, 4.6, 5.1, 5.2,
// 5.3, 5.4, 5.5, 5.6, 5.7, 8.1, 8.2, 8.3.

import { browser } from '../shared/browser.js';
import {
    STORAGE_KEYS,
    SCHEMA_VERSION,
    DOMAIN_LIST_CAP,
    compareCi
} from '../shared/constants.js';

/** The valid Recording_State values per the design. */
const VALID_STATES = Object.freeze(['idle', 'recording', 'stopped']);

/**
 * Log a storage failure with the standard prefix that other modules grep on.
 *
 * @param {string} op - The storage operation that failed ("get" / "set" / "remove").
 * @param {string} key - The storage key that the operation targeted.
 * @param {unknown} err - The error reported by the underlying API.
 */
function logStorageFailure(op, key, err) {
    // eslint-disable-next-line no-console
    console.warn(
        `[domain-recorder] storage ${op} failed for key ${key}`,
        err
    );
}

/**
 * Normalize a single Domain_List entry using the same rules `extractDomain`
 * applies (lowercase + strip a single trailing dot + length check). Trims
 * surrounding ASCII whitespace so a previously persisted entry that picked
 * up whitespace through manual edits or migration is recovered rather than
 * dropped. Returns `null` for entries that cannot be recovered.
 *
 * @param {unknown} entry
 * @returns {string | null}
 */
function normalizeDomainEntry(entry) {
    if (typeof entry !== 'string') {
        return null;
    }
    let normalized = entry.trim().toLowerCase();
    if (normalized.endsWith('.')) {
        normalized = normalized.slice(0, -1);
    }
    // Bare-hostname entries are 1..253 chars. Origin-shaped entries
    // ("https://" + hostname) add at most 8 chars, so 1..270 covers both.
    if (normalized.length < 1 || normalized.length > 270) {
        return null;
    }
    return normalized;
}

/**
 * Normalize an arbitrary persisted value into a valid Domain_List:
 * deduplicated, sorted in case-insensitive ascending order, and capped at
 * `DOMAIN_LIST_CAP`. Non-array inputs collapse to an empty list.
 *
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeDomainList(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }
    const seen = new Set();
    const result = [];
    for (const entry of raw) {
        const normalized = normalizeDomainEntry(entry);
        if (normalized === null) {
            continue;
        }
        if (seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        result.push(normalized);
    }
    result.sort(compareCi);
    if (result.length > DOMAIN_LIST_CAP) {
        result.length = DOMAIN_LIST_CAP;
    }
    return result;
}

/**
 * Compare two arrays of strings for byte-equal element-wise equality.
 *
 * @param {unknown} a
 * @param {string[]} b
 * @returns {boolean}
 */
function listsByteEqual(a, b) {
    if (!Array.isArray(a) || a.length !== b.length) {
        return false;
    }
    for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) {
            return false;
        }
    }
    return true;
}

/**
 * Load the persisted Recording_State and Domain_List from `storage.local`,
 * apply defaults for missing keys, normalize a malformed Domain_List, and
 * apply the `recording → stopped` recovery rule. Any normalization or
 * recovery is persisted back to storage.
 *
 * Behavior summary (Requirements 5.3 – 5.7, 8.1 – 8.3):
 *   - If the read throws or rejects, both keys default in memory (`idle`,
 *     `[]`) and a diagnostic is logged for each key.
 *   - If a key is missing, the default is loaded into memory and persisted.
 *   - If `recordingState` is `recording`, the in-memory value becomes
 *     `stopped` and `stopped` is persisted. If that write fails, the
 *     in-memory value reverts to `recording` and the failure is logged.
 *   - If `recordingState` is an unrecognized value, it is treated as
 *     missing: defaults to `idle` and rewritten.
 *   - If `domainList` is malformed (non-array, non-string entries,
 *     mixed-case, duplicates, oversized), it is normalized in memory and
 *     the normalized value is persisted back.
 *
 * @returns {Promise<{ state: 'idle' | 'recording' | 'stopped', list: string[] }>}
 */
export async function loadState() {
    let rawState;
    let rawList;
    let stateAvailable = false;
    let listAvailable = false;
    let readFailed = false;

    try {
        const stored = await browser.storage.local.get([
            STORAGE_KEYS.recordingState,
            STORAGE_KEYS.domainList,
            STORAGE_KEYS.schemaVersion
        ]);
        if (
            Object.prototype.hasOwnProperty.call(
                stored,
                STORAGE_KEYS.recordingState
            )
        ) {
            stateAvailable = true;
            rawState = stored[STORAGE_KEYS.recordingState];
        }
        if (
            Object.prototype.hasOwnProperty.call(
                stored,
                STORAGE_KEYS.domainList
            )
        ) {
            listAvailable = true;
            rawList = stored[STORAGE_KEYS.domainList];
        }
    } catch (err) {
        readFailed = true;
        // Per Req 5.5, log per-key when the read fails so the diagnostic
        // identifies which keys were affected.
        logStorageFailure('get', STORAGE_KEYS.recordingState, err);
        logStorageFailure('get', STORAGE_KEYS.domainList, err);
    }

    // ---- Resolve in-memory state ----
    let state = 'idle';
    let needStateWrite = false;
    let isRecoveryWrite = false;
    if (!readFailed && stateAvailable) {
        if (rawState === 'recording') {
            // Recording → stopped recovery (Req 5.6).
            state = 'stopped';
            needStateWrite = true;
            isRecoveryWrite = true;
        } else if (VALID_STATES.includes(rawState)) {
            state = rawState;
        } else {
            // Unrecognized persisted value: treat as missing.
            state = 'idle';
            needStateWrite = true;
        }
    } else if (!readFailed) {
        // Key was missing from storage but the read itself succeeded.
        state = 'idle';
        needStateWrite = true;
    } else {
        // Read failed: in-memory default, no rewrite (storage is broken).
        state = 'idle';
    }

    // ---- Resolve in-memory list ----
    let list = [];
    let needListWrite = false;
    if (!readFailed && listAvailable) {
        list = normalizeDomainList(rawList);
        // Persist back when the persisted value did not already match the
        // normalized form (covers non-array, malformed, mixed-case,
        // duplicate, and oversized cases).
        needListWrite = !listsByteEqual(rawList, list);
    } else if (!readFailed) {
        list = [];
        needListWrite = true;
    } else {
        list = [];
    }

    // ---- Perform any required writes ----
    if (needStateWrite) {
        const result = await saveState(state);
        if (!result.ok && isRecoveryWrite) {
            // Per Req 5.7, when the recovery write fails, retain the
            // in-memory state as `recording`. saveState already logged the
            // failure with the failing key.
            state = 'recording';
        }
    }

    if (needListWrite) {
        // saveList logs and returns { ok: false } on failure; the in-memory
        // normalized list is the best we can return either way.
        await saveList(list);
    }

    // Best-effort write of the schema version when the read succeeded but
    // the key is missing. Reserved for future migrations; failures are
    // logged through saveState/saveList-style logging but do not change
    // any caller-visible state.
    if (!readFailed) {
        try {
            const stored = await browser.storage.local.get(
                STORAGE_KEYS.schemaVersion
            );
            if (
                !Object.prototype.hasOwnProperty.call(
                    stored,
                    STORAGE_KEYS.schemaVersion
                )
            ) {
                await browser.storage.local.set({
                    [STORAGE_KEYS.schemaVersion]: SCHEMA_VERSION
                });
            }
        } catch (err) {
            logStorageFailure('set', STORAGE_KEYS.schemaVersion, err);
        }
    }

    return { state, list };
}

/**
 * Persist the Recording_State to `storage.local`. Never throws; returns
 * `{ ok: true }` on success and `{ ok: false, error }` on failure with a
 * diagnostic written to the extension console.
 *
 * @param {'idle' | 'recording' | 'stopped'} state
 * @returns {Promise<{ ok: boolean, error?: unknown }>}
 */
export async function saveState(state) {
    try {
        await browser.storage.local.set({
            [STORAGE_KEYS.recordingState]: state
        });
        return { ok: true };
    } catch (error) {
        logStorageFailure('set', STORAGE_KEYS.recordingState, error);
        return { ok: false, error };
    }
}

/**
 * Persist the Domain_List to `storage.local`. Never throws; returns
 * `{ ok: true }` on success and `{ ok: false, error }` on failure with a
 * diagnostic written to the extension console.
 *
 * @param {string[]} list
 * @returns {Promise<{ ok: boolean, error?: unknown }>}
 */
export async function saveList(list) {
    try {
        await browser.storage.local.set({
            [STORAGE_KEYS.domainList]: list
        });
        return { ok: true };
    } catch (error) {
        logStorageFailure('set', STORAGE_KEYS.domainList, error);
        return { ok: false, error };
    }
}

/**
 * Remove the Domain_List from `storage.local`. Never throws; returns
 * `{ ok: true }` on success and `{ ok: false, error }` on failure with a
 * diagnostic written to the extension console.
 *
 * @returns {Promise<{ ok: boolean, error?: unknown }>}
 */
export async function clearList() {
    try {
        await browser.storage.local.remove(STORAGE_KEYS.domainList);
        return { ok: true };
    } catch (error) {
        logStorageFailure('remove', STORAGE_KEYS.domainList, error);
        return { ok: false, error };
    }
}

/**
 * Persist the active recording session's tab id, or `null` when no
 * session is active.
 *
 * @param {number | null} tabId
 * @returns {Promise<{ ok: boolean, error?: unknown }>}
 */
export async function saveSessionTabId(tabId) {
    try {
        if (tabId === null || tabId === undefined) {
            await browser.storage.local.remove(STORAGE_KEYS.sessionTabId);
        } else {
            await browser.storage.local.set({
                [STORAGE_KEYS.sessionTabId]: tabId
            });
        }
        return { ok: true };
    } catch (error) {
        logStorageFailure('set', STORAGE_KEYS.sessionTabId, error);
        return { ok: false, error };
    }
}

/**
 * Persist the target domain captured at session start, or `null` to clear.
 *
 * @param {string | null} domain
 * @returns {Promise<{ ok: boolean, error?: unknown }>}
 */
export async function saveTargetDomain(domain) {
    try {
        if (domain === null || domain === undefined) {
            await browser.storage.local.remove(STORAGE_KEYS.targetDomain);
        } else {
            await browser.storage.local.set({
                [STORAGE_KEYS.targetDomain]: domain
            });
        }
        return { ok: true };
    } catch (error) {
        logStorageFailure('set', STORAGE_KEYS.targetDomain, error);
        return { ok: false, error };
    }
}

/**
 * Read the persisted session tab id and target domain. Used by callers
 * that want the full session context alongside `loadState`.
 *
 * @returns {Promise<{ sessionTabId: number | null, targetDomain: string | null }>}
 */
export async function loadSession() {
    try {
        const stored = await browser.storage.local.get([
            STORAGE_KEYS.sessionTabId,
            STORAGE_KEYS.targetDomain
        ]);
        const rawTab = stored[STORAGE_KEYS.sessionTabId];
        const rawDomain = stored[STORAGE_KEYS.targetDomain];
        return {
            sessionTabId:
                typeof rawTab === 'number' && Number.isInteger(rawTab)
                    ? rawTab
                    : null,
            targetDomain: typeof rawDomain === 'string' ? rawDomain : null
        };
    } catch (error) {
        logStorageFailure('get', STORAGE_KEYS.sessionTabId, error);
        return { sessionTabId: null, targetDomain: null };
    }
}

/**
 * Read the set of URLs the user has accepted into the AWS Security Agent
 * configuration form via the autofill content script. Returns a deduped
 * array (sorted client-side as needed).
 *
 * @returns {Promise<string[]>}
 */
export async function loadFilledUrls() {
    try {
        const stored = await browser.storage.local.get(STORAGE_KEYS.filledUrls);
        const raw = stored[STORAGE_KEYS.filledUrls];
        if (!Array.isArray(raw)) return [];
        const seen = new Set();
        const out = [];
        for (const entry of raw) {
            if (typeof entry === 'string' && !seen.has(entry)) {
                seen.add(entry);
                out.push(entry);
            }
        }
        return out;
    } catch (error) {
        logStorageFailure('get', STORAGE_KEYS.filledUrls, error);
        return [];
    }
}

/**
 * Persist the filled-URL set. Pass an empty array (or null) to clear.
 *
 * @param {string[] | null} list
 * @returns {Promise<{ ok: boolean, error?: unknown }>}
 */
export async function saveFilledUrls(list) {
    try {
        if (list === null || list === undefined) {
            await browser.storage.local.remove(STORAGE_KEYS.filledUrls);
        } else {
            await browser.storage.local.set({
                [STORAGE_KEYS.filledUrls]: list
            });
        }
        return { ok: true };
    } catch (error) {
        logStorageFailure('set', STORAGE_KEYS.filledUrls, error);
        return { ok: false, error };
    }
}

/**
 * Read the set of URLs the user has accepted into the AWS Security Agent
 * out-of-scope (exclude) list via the autofill content script.
 *
 * @returns {Promise<string[]>}
 */
export async function loadExcludedUrls() {
    try {
        const stored = await browser.storage.local.get(
            STORAGE_KEYS.excludedUrls
        );
        const raw = stored[STORAGE_KEYS.excludedUrls];
        if (!Array.isArray(raw)) return [];
        const seen = new Set();
        const out = [];
        for (const entry of raw) {
            if (typeof entry === 'string' && !seen.has(entry)) {
                seen.add(entry);
                out.push(entry);
            }
        }
        return out;
    } catch (error) {
        logStorageFailure('get', STORAGE_KEYS.excludedUrls, error);
        return [];
    }
}

/**
 * Persist the excluded-URL set. Pass an empty array (or null) to clear.
 *
 * @param {string[] | null} list
 * @returns {Promise<{ ok: boolean, error?: unknown }>}
 */
export async function saveExcludedUrls(list) {
    try {
        if (list === null || list === undefined) {
            await browser.storage.local.remove(STORAGE_KEYS.excludedUrls);
        } else {
            await browser.storage.local.set({
                [STORAGE_KEYS.excludedUrls]: list
            });
        }
        return { ok: true };
    } catch (error) {
        logStorageFailure('set', STORAGE_KEYS.excludedUrls, error);
        return { ok: false, error };
    }
}
