// Pure recorder for the Domain Recorder Extension.
//
// This module is intentionally pure: it has no I/O and no `browser.*` calls.
// Callers (the background service worker) are responsible for persisting the
// returned list to `storage.local` when `changed` is true.
//
// The recorder enforces the Domain_List invariants from the design:
//   - normalized via `extractDomain` (lowercase, trailing-dot stripped, ASCII
//     / punycode);
//   - deduplicated under byte equality (which suffices because every entry
//     has already been normalized);
//   - sorted in case-insensitive ascending order via `compareCi`;
//   - bounded by `DOMAIN_LIST_CAP`.
//
// The single console.warn diagnostic emitted when the cap is first reached
// during a session is gated by a module-level guard so logs are not flooded.

import { extractOrigin } from '../shared/domain.js';
import { DOMAIN_LIST_CAP, compareCi } from '../shared/constants.js';

/**
 * Module-level guard so the cap-reached diagnostic is logged at most once
 * per service-worker session, per design / Requirement 8.6.
 *
 * @type {boolean}
 */
let capWarningLogged = false;

/**
 * Reset the cap-warning guard. Intended for tests; the production code path
 * never calls this. Resetting allows test cases to assert that the warning
 * is emitted exactly once per session.
 *
 * @returns {void}
 */
export function _resetCapWarningForTests() {
    capWarningLogged = false;
}

/**
 * Case-insensitive membership check over a Domain_List.
 *
 * Because every entry in the list is already normalized by `extractDomain`
 * (lowercased, trailing-dot stripped, ASCII / punycode), this reduces to a
 * byte-equal lookup against the lowercased candidate. We lowercase the
 * candidate defensively in case a caller passes a not-yet-normalized value.
 *
 * @param {string[]} list - Pre-normalized, sorted, deduped Domain_List.
 * @param {string} domain - Candidate domain.
 * @returns {boolean} True when `domain` is present in `list` under byte
 *   equality on lowercased values.
 */
export function containsCi(list, domain) {
    const needle = String(domain).toLowerCase();
    for (let i = 0; i < list.length; i += 1) {
        if (list[i] === needle) {
            return true;
        }
    }
    return false;
}

/**
 * Return a new list with `domain` inserted at the position that preserves
 * case-insensitive ascending order under `compareCi`.
 *
 * Uses binary search to locate the insertion point in O(log n) and then
 * builds a new array (the input list is never mutated). Equal entries are
 * not added; callers should check membership with `containsCi` first.
 *
 * @param {string[]} list - Pre-normalized, sorted, deduped Domain_List.
 * @param {string} domain - Domain to insert (already normalized).
 * @returns {string[]} A new array with `domain` inserted in sorted order.
 */
export function insertSortedCi(list, domain) {
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (compareCi(list[mid], domain) < 0) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    const next = new Array(list.length + 1);
    for (let i = 0; i < lo; i += 1) {
        next[i] = list[i];
    }
    next[lo] = domain;
    for (let i = lo; i < list.length; i += 1) {
        next[i + 1] = list[i];
    }
    return next;
}

/**
 * Result returned by `recordRequest`.
 *
 * @typedef {Object} RecordResult
 * @property {string[]} list - The (possibly new) Domain_List. Equal by
 *   reference to the input list when `changed` is false; a new array when
 *   `changed` is true.
 * @property {boolean} changed - True when the list grew by exactly one
 *   entry; false otherwise.
 * @property {('invalid' | 'cap-reached' | 'duplicate')=} rejected - When
 *   `changed` is false, the reason the addition was rejected. Omitted when
 *   `changed` is true.
 */

/**
 * Process an Observed_Request URL against the current accessible-URL list.
 *
 * Each entry stored in the list is the request's normalized origin —
 * scheme + "://" + lowercased ASCII hostname (e.g. "https://api.example.com").
 * The scheme is preserved so callers can distinguish between http and
 * https accesses to the same host.
 *
 * Algorithm:
 *   1. origin = extractOrigin(rawUrl). If null, return
 *      { list, changed: false, rejected: 'invalid' }.
 *   2. If containsCi(list, origin), return
 *      { list, changed: false, rejected: 'duplicate' }.
 *   3. If list.length >= DOMAIN_LIST_CAP, log a single diagnostic per
 *      session and return
 *      { list, changed: false, rejected: 'cap-reached' }.
 *   4. Otherwise return
 *      { list: insertSortedCi(list, origin), changed: true }.
 *
 * @param {string} rawUrl
 * @param {string[]} list
 * @returns {RecordResult}
 */
export function recordRequest(rawUrl, list) {
    const origin = extractOrigin(rawUrl);
    if (origin === null) {
        return { list, changed: false, rejected: 'invalid' };
    }

    if (containsCi(list, origin)) {
        return { list, changed: false, rejected: 'duplicate' };
    }

    if (list.length >= DOMAIN_LIST_CAP) {
        if (!capWarningLogged) {
            capWarningLogged = true;
            console.warn(
                '[domain-recorder] domain list cap reached, dropping new entries'
            );
        }
        return { list, changed: false, rejected: 'cap-reached' };
    }

    return { list: insertSortedCi(list, origin), changed: true };
}

export default recordRequest;
