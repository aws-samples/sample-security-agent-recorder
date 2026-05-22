// Pure domain extraction for the Domain Recorder Extension.
//
// This module is intentionally pure: it has no I/O and no `browser.*` calls,
// so it is safe to import from any context (background service worker, popup,
// results page, and tests). It is one of the seams where property-based
// testing applies.

/**
 * Extract a normalized domain from a request URL.
 *
 * Algorithm (per design):
 *   1. Try `new URL(rawUrl)`; if it throws, return `null`.
 *   2. Reject any `protocol` not in {'http:', 'https:'} (return `null`).
 *   3. Read `url.hostname` (already lowercased ASCII / punycode by the
 *      WHATWG URL parser).
 *   4. Strip a single trailing '.' if present.
 *   5. If the result is empty, return `null`.
 *   6. Otherwise return the result.
 *
 * The WHATWG URL parser guarantees:
 *   - `url.hostname` excludes the scheme, port, path, query, and fragment.
 *   - ASCII alphabetic characters in the host are lowercased.
 *   - Internationalized domain names are returned in their punycode (ASCII)
 *     form.
 *
 * Validates Requirements: 3.1, 3.2, 3.6, 3.7, 7.1, 7.2, 7.3, 7.4, 7.7.
 *
 * @param {string} rawUrl - The URL string from an observed request.
 * @returns {string | null} The normalized domain, or `null` when the URL is
 *   unparseable, has a non-http(s) scheme, or yields an empty hostname.
 */
export function extractDomain(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        return null;
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return null;
    }

    let hostname = url.hostname;
    if (hostname.endsWith('.')) {
        hostname = hostname.slice(0, -1);
    }

    if (hostname.length === 0) {
        return null;
    }

    return hostname;
}

/**
 * Extract a normalized "origin" string from a URL: the scheme followed by
 * `://` followed by the normalized hostname. Returns `null` for any input
 * that `extractDomain` would reject.
 *
 * Examples:
 *   "https://Example.com:8080/path" -> "https://example.com"
 *   "http://api.foo.com."           -> "http://api.foo.com"
 *   "ftp://example.com/"            -> null
 *
 * Used by the service worker so the captured list distinguishes between
 * http and https accesses to the same hostname.
 *
 * @param {string} rawUrl
 * @returns {string | null}
 */
export function extractOrigin(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return null;
    }
    let hostname = url.hostname;
    if (hostname.endsWith('.')) hostname = hostname.slice(0, -1);
    if (hostname.length === 0) return null;
    // url.protocol already includes the trailing colon (e.g. "https:").
    return `${url.protocol}//${hostname}`;
}

export default extractDomain;
