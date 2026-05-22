// Shared fast-check arbitraries for the Domain Recorder Extension.
//
// These generators produce data that respects the invariants documented in
// the design and the Domain_List requirements (Requirements 7.x and 8.x):
//   - hostnames are lowercase ASCII
//   - hostnames contain no whitespace
//   - hostname total length is between 1 and 253 characters
//   - hostnames have no trailing dot
//
// All arbitraries are stateless and safe to share across tests.

import fc from 'fast-check';
import { compareCi, DOMAIN_LIST_CAP } from '../../src/shared/constants.js';

// ---------------------------------------------------------------------------
// Hostnames
// ---------------------------------------------------------------------------

// A single ASCII label per the relaxed RFC 1123 grammar that the WHATWG URL
// parser accepts: 1..63 chars, lowercase letters / digits / hyphen, must
// neither start nor end with a hyphen.
const hostLabelArb = fc
    .tuple(
        fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
        fc.stringOf(
            fc.constantFrom(
                ...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')
            ),
            { minLength: 0, maxLength: 61 }
        ),
        fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split(''))
    )
    .map(([first, middle, last]) => first + middle + last)
    // Single-character labels are also legal — collapse to a single char half
    // the time so the generator covers short labels.
    .filter((label) => label.length >= 1 && label.length <= 63);

const shortHostLabelArb = fc.stringOf(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
    { minLength: 1, maxLength: 1 }
);

/**
 * `httpHostArb` produces an ASCII hostname (lowercase, 1..253 chars) suitable
 * for use in an http or https URL. The generator may optionally produce a
 * single-label host (e.g. `localhost`) or multi-label hosts (e.g.
 * `api.example.com`).
 */
export const httpHostArb = fc
    .array(fc.oneof({ weight: 5, arbitrary: hostLabelArb }, { weight: 1, arbitrary: shortHostLabelArb }), {
        minLength: 1,
        maxLength: 6
    })
    .map((labels) => labels.join('.'))
    .filter((host) => host.length >= 1 && host.length <= 253);

/**
 * `idnHostArb` produces hostnames that include at least one Unicode label
 * drawn from a small fixed pool. Tests that consume this arbitrary should
 * pass it through `new URL(...).hostname` (or `extractDomain`) to obtain
 * the punycode form expected by the design.
 */
const idnSampleLabels = [
    'münchen',
    'bücher',
    'café',
    '日本',
    '中国',
    'россия',
    'مصر',
    'ελλάδα'
];

export const idnHostArb = fc
    .tuple(
        fc.constantFrom(...idnSampleLabels),
        fc.array(hostLabelArb, { minLength: 1, maxLength: 3 })
    )
    .map(([idn, ascii]) => [idn, ...ascii].join('.'));

// ---------------------------------------------------------------------------
// URL components
// ---------------------------------------------------------------------------

const schemeArb = fc.constantFrom('http', 'https');

const portArb = fc.option(fc.integer({ min: 1, max: 65535 }), { nil: null });

// Percent-encoding-friendly path segment: avoid characters that would be
// interpreted as URL delimiters so the assembled URL parses cleanly.
const pathSegmentArb = fc.stringOf(
    fc.constantFrom(
        ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_~.'.split(
            ''
        )
    ),
    { minLength: 0, maxLength: 12 }
);

const pathArb = fc
    .array(pathSegmentArb, { minLength: 0, maxLength: 5 })
    .map((segments) =>
        segments.length === 0 ? '' : '/' + segments.join('/')
    );

const queryPairArb = fc.tuple(
    fc.stringOf(
        fc.constantFrom(
            ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split(
                ''
            )
        ),
        { minLength: 1, maxLength: 8 }
    ),
    fc.stringOf(
        fc.constantFrom(
            ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split(
                ''
            )
        ),
        { minLength: 0, maxLength: 8 }
    )
);

const queryArb = fc
    .array(queryPairArb, { minLength: 0, maxLength: 4 })
    .map((pairs) =>
        pairs.length === 0
            ? ''
            : '?' + pairs.map(([k, v]) => `${k}=${v}`).join('&')
    );

const fragmentArb = fc
    .option(
        fc.stringOf(
            fc.constantFrom(
                ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_'.split(
                    ''
                )
            ),
            { minLength: 1, maxLength: 12 }
        ),
        { nil: null }
    )
    .map((frag) => (frag === null ? '' : '#' + frag));

const trailingDotArb = fc.boolean();

// Mixes case across each character of an ASCII hostname so the resulting
// URL stresses Property 1's lowercasing requirement.
function withRandomCase(host, mask) {
    let i = 0;
    return host
        .split('')
        .map((ch) => {
            const flag = mask[i % mask.length];
            i += 1;
            if (/[a-z]/.test(ch) && flag) {
                return ch.toUpperCase();
            }
            return ch;
        })
        .join('');
}

/**
 * `httpUrlArb` assembles a complete `http`/`https` URL from a generated
 * scheme, host, optional port, path, query, fragment, and an optional
 * trailing dot on the host. The host may be ASCII or include an IDN label.
 *
 * The arbitrary returns `{ url, expectedHostname }` so consumers can assert
 * against the canonical lowercased, punycode, trailing-dot-stripped form
 * computed by the WHATWG URL parser without re-deriving the rules in test
 * code.
 */
export const httpUrlArb = fc
    .record({
        scheme: schemeArb,
        host: fc.oneof(
            { weight: 4, arbitrary: httpHostArb },
            { weight: 1, arbitrary: idnHostArb }
        ),
        caseMask: fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
        trailingDot: trailingDotArb,
        port: portArb,
        path: pathArb,
        query: queryArb,
        fragment: fragmentArb
    })
    .map(({ scheme, host, caseMask, trailingDot, port, path, query, fragment }) => {
        // Apply random case only to ASCII hosts; Unicode labels are kept
        // as-is so the URL parser can punycode them deterministically.
        const isAscii = /^[\x00-\x7F]*$/.test(host);
        const cased = isAscii ? withRandomCase(host, caseMask) : host;
        const dotted = trailingDot ? cased + '.' : cased;
        const portPart = port === null || port === undefined ? '' : `:${port}`;
        const url = `${scheme}://${dotted}${portPart}${path}${query}${fragment}`;
        // Compute the canonical hostname using the same parser the
        // implementation will use, so tests can compare against this.
        let expectedHostname = '';
        try {
            const u = new URL(url);
            expectedHostname = u.hostname.replace(/\.$/, '');
        } catch {
            expectedHostname = '';
        }
        return { url, scheme, expectedHostname };
    })
    .filter(({ expectedHostname }) => expectedHostname.length > 0);

/**
 * `nonHttpUrlArb` produces parseable URLs whose scheme is NOT `http` or
 * `https`. These are guaranteed to be rejected by `extractDomain`.
 */
export const nonHttpUrlArb = fc.oneof(
    fc.constantFrom(
        'ftp://example.com/file.txt',
        'file:///etc/hosts',
        'ws://example.com/socket',
        'wss://example.com/socket',
        'mailto:user@example.com',
        'javascript:void(0)',
        'data:text/plain,hello',
        'about:blank',
        'chrome://extensions/',
        'tel:+15555550123',
        'sftp://example.com/path'
    ),
    fc
        .tuple(
            fc.constantFrom('ftp', 'ws', 'wss', 'gopher', 'sftp'),
            httpHostArb
        )
        .map(([scheme, host]) => `${scheme}://${host}/`)
);

/**
 * `malformedUrlArb` produces strings that the WHATWG URL constructor will
 * reject (or that yield an empty hostname). These are guaranteed to be
 * rejected by `extractDomain`.
 */
export const malformedUrlArb = fc.oneof(
    fc.constantFrom(
        '',
        ' ',
        '   ',
        'not a url',
        'http://',
        'https://',
        'http:///path',
        'https:// /path',
        '://example.com',
        'http//example.com',
        'http:example.com',
        '\u0000\u0001',
        'http://[::1', // unterminated IPv6 literal
        'http://exa mple.com'
    ),
    // Bare strings without a scheme separator
    fc.stringOf(
        fc.constantFrom(...'abcdef '.split('')),
        { minLength: 1, maxLength: 16 }
    )
);

// ---------------------------------------------------------------------------
// Domain list
// ---------------------------------------------------------------------------

// A single Domain_List entry: lowercase ASCII, 1..253 chars, no whitespace,
// no trailing dot, valid label structure. Reuse `httpHostArb` since it
// already enforces those rules.
const domainEntryArb = httpHostArb;

/**
 * `domainListArb` produces a Domain_List that satisfies the invariants
 * tested by Property 4: deduplicated under case-insensitive byte equality,
 * sorted in case-insensitive ascending order, and bounded by
 * `DOMAIN_LIST_CAP` (10000) entries.
 *
 * The generator uses an upper bound of 50 by default because generating
 * 10000-entry lists on every iteration is prohibitively slow; pass an
 * explicit `maxLength` if a test needs to push closer to the cap.
 */
export function domainListArb(options = {}) {
    const maxLength = Math.min(
        options.maxLength ?? 50,
        DOMAIN_LIST_CAP
    );
    return fc
        .array(domainEntryArb, { minLength: 0, maxLength })
        .map((entries) => {
            const seen = new Set();
            const deduped = [];
            for (const entry of entries) {
                if (!seen.has(entry)) {
                    seen.add(entry);
                    deduped.push(entry);
                }
            }
            deduped.sort(compareCi);
            return deduped;
        });
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/**
 * `transitionKindArb` yields a recording-session transition kind. Used by
 * the state-machine and session-scope properties.
 */
export const transitionKindArb = fc.constantFrom('start', 'stop');
