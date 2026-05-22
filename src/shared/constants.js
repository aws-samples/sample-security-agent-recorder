// Shared constants for the Domain Recorder Extension.
//
// This module is intentionally pure: it has no I/O and no `browser.*` calls,
// so it is safe to import from any context (background service worker, popup,
// results page, and tests).

/**
 * Storage keys used in `storage.local`. Centralized here so every module
 * agrees on the exact strings written to and read from the browser's
 * extension storage area.
 *
 * @type {{ recordingState: 'recordingState', domainList: 'domainList', schemaVersion: 'schemaVersion' }}
 */
export const STORAGE_KEYS = Object.freeze({
    recordingState: 'recordingState',
    domainList: 'domainList',
    schemaVersion: 'schemaVersion',
    sessionTabId: 'sessionTabId',
    targetDomain: 'targetDomain',
    filledUrls: 'filledUrls',
    excludedUrls: 'excludedUrls',
});

/**
 * Maximum number of entries allowed in the Domain_List. Additions beyond
 * this cap are rejected by the recorder per Requirement 8.6.
 *
 * @type {number}
 */
export const DOMAIN_LIST_CAP = 10000;

/**
 * Current schema version for the persisted shape in `storage.local`.
 * Reserved for future migrations; bump when the persisted shape changes.
 *
 * @type {number}
 */
export const SCHEMA_VERSION = 1;

/**
 * Case-insensitive ASCII comparator used for sorting and ordering the
 * Domain_List in case-insensitive ascending order.
 *
 * Domains stored in the Domain_List are already normalized (lowercased,
 * trailing-dot stripped, ASCII / punycode) by `extractDomain`, so this
 * comparator reduces to byte comparison on lowercased input. It also
 * tolerates mixed-case inputs by lowercasing both sides before comparing,
 * which is useful when sorting raw inputs in tests.
 *
 * Returns a negative number when `a` should sort before `b`, a positive
 * number when `a` should sort after `b`, and 0 when they are equal under
 * ASCII case folding.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareCi(a, b) {
    const lowerA = String(a).toLowerCase();
    const lowerB = String(b).toLowerCase();
    if (lowerA < lowerB) {
        return -1;
    }
    if (lowerA > lowerB) {
        return 1;
    }
    return 0;
}
