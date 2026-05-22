# Implementation Plan: Domain Recorder Extension

Convert the feature design into a series of prompts for a code-generation LLM that will implement each step with incremental progress. Make sure that each prompt builds on the previous prompts, and ends with wiring things together. There should be no hanging or orphaned code that isn't integrated into a previous step. Focus ONLY on tasks that involve writing, modifying, or testing code.

## Overview

The implementation follows the module layout in the design: a Manifest V3 background service worker, a popup, a results page, shared pure modules (`shared/domain.js`, `background/recorder.js`), a thin storage adapter, and the `webextension-polyfill` shim for cross-browser API access. Implementation language is **JavaScript (ES modules)** as established by the design (file extensions, manifest `"type": "module"`, polyfill choice, Vitest + fast-check tooling). Tests use Vitest in Node and jsdom environments, with fast-check for property-based tests; each of the design's 10 correctness properties maps to its own optional sub-task.

The plan starts with project scaffolding, then builds the pure seams (`extractDomain`, `recordRequest`) that carry most of the property tests, then layers on the storage adapter, state machine, and service-worker glue, then the popup and results page, and finally the manifest, polyfill, smoke tests, and cross-browser load checks.

## Tasks

- [x] 1. Scaffold project structure, tooling, and shared constants
  - [x] 1.1 Initialize the JavaScript project and install dev dependencies
    - Create `package.json` at the repo root with scripts for `test`, `test:watch`, `lint`, and `build` (where `build` copies `src/` to `dist/` and inlines the polyfill).
    - Add devDependencies: `vitest`, `fast-check`, `@fast-check/vitest`, `jsdom`, `eslint`, and `webextension-polyfill`.
    - Add a `vitest.config.js` that sets `environment: 'node'` by default and allows per-file override to `jsdom` for popup/results tests.
    - Add an `.eslintrc.json` that forbids direct `chrome.` usage outside `src/shared/browser.js` (custom rule via `no-restricted-syntax`).
    - _Requirements: 1.1, 1.2_

  - [x] 1.2 Create the source directory layout and shared constants module
    - Create directories: `src/`, `src/background/`, `src/popup/`, `src/results/`, `src/shared/`, `src/vendor/`, `src/icons/`.
    - Create `src/shared/constants.js` exporting `STORAGE_KEYS = { recordingState: 'recordingState', domainList: 'domainList', schemaVersion: 'schemaVersion' }`, `DOMAIN_LIST_CAP = 10000`, `SCHEMA_VERSION = 1`, and `compareCi(a, b)` (case-insensitive ASCII comparator used for sorting).
    - Create `src/shared/browser.js` that imports `webextension-polyfill` and re-exports the `browser` global as the default and named export (single seam for all modules).
    - Create placeholder `src/icons/README.md` documenting required icon files (16/32/48/128 px); actual icon binaries are out of scope for this plan.
    - _Requirements: 1.3, 8.6_

  - [x] 1.3 Create the test directory layout and shared test helpers
    - Create directories: `tests/property/`, `tests/example/`, `tests/smoke/`, `tests/helpers/`.
    - Create `tests/helpers/mockBrowser.js` that returns a fresh in-memory `browser` mock per test exposing `storage.local` (with `get`/`set`/`remove`/`clear`), `storage.onChanged` (with a manual fire helper), `webRequest.onBeforeRequest` (with `addListener`/`removeListener`/`hasListener` and a manual fire helper), `tabs.create` (recording calls), `runtime.sendMessage`/`onMessage`, `runtime.onStartup`/`onInstalled`, and `action.setBadgeText`/`setBadgeBackgroundColor`/`setIcon` (recording calls).
    - Create `tests/helpers/arbitraries.js` exporting fast-check arbitraries: `httpHostArb`, `idnHostArb`, `httpUrlArb` (assembles scheme/host/port/path/query/fragment), `nonHttpUrlArb`, `malformedUrlArb`, `domainListArb` (returns sorted-deduped string[] up to 10000 entries with valid 1..253 char ASCII bodies), and `transitionKindArb` (`'start' | 'stop'`).
    - _Requirements: 1.1_

- [x] 2. Implement the pure domain extraction module
  - [x] 2.1 Implement `extractDomain` in `src/shared/domain.js`
    - Export `extractDomain(rawUrl)` returning `string | null`.
    - Algorithm per design: try `new URL(rawUrl)`; if it throws, return `null`. Reject any `protocol` not in `{'http:', 'https:'}` (return `null`). Read `url.hostname` (already lowercased ASCII / punycode by the WHATWG URL parser). Strip a single trailing `'.'`. If the result is empty, return `null`. Otherwise return the result.
    - _Requirements: 3.1, 3.2, 3.6, 3.7, 7.1, 7.2, 7.3, 7.4, 7.7_

  - [ ]* 2.2 Write property test for `extractDomain` correctness on http/https URLs
    - **Property 1: extractDomain correctness for http/https URLs**
    - **Validates: Requirements 3.1, 3.2, 7.1, 7.2, 7.3, 7.4**
    - File: `tests/property/domain.spec.js`. Generate URLs from scheme ∈ {http, https}, mixed-case ASCII hosts, IDN samples, optional trailing dot, optional port/path/query/fragment. Assert the returned domain equals the expected lowercased, punycode, trailing-dot-stripped hostname and contains none of the URL's port, path, query, or fragment characters.
    - Tag with comment `// Feature: domain-recorder-extension, Property 1: extractDomain correctness for http/https URLs`.

  - [ ]* 2.3 Write property test for `extractDomain` rejecting ineligible URLs
    - **Property 2: extractDomain rejects ineligible URLs**
    - **Validates: Requirements 3.6, 3.7, 7.6, 7.7**
    - File: `tests/property/domain.spec.js`. Generate (a) malformed URLs that throw in `new URL(...)`, (b) URLs with empty hostnames, and (c) URLs with non-http/https schemes (ftp, file, ws, mailto, javascript, data, about, chrome). Assert `extractDomain` returns `null` for every input.
    - Tag with `// Feature: domain-recorder-extension, Property 2: extractDomain rejects ineligible URLs`.

- [x] 3. Implement the recorder (dedupe, cap, sorted insertion)
  - [x] 3.1 Implement `recordRequest` in `src/background/recorder.js`
    - Import `extractDomain` from `src/shared/domain.js` and `DOMAIN_LIST_CAP`, `compareCi` from `src/shared/constants.js`.
    - Export `recordRequest(rawUrl, list)` returning `{ list, changed, rejected? }` per design.
    - Implement helpers `containsCi(list, domain)` (byte-equal lookup since list is pre-normalized) and `insertSortedCi(list, domain)` (binary-search insertion using `compareCi`).
    - On rejection because `|list| >= DOMAIN_LIST_CAP`, log a single `console.warn('[domain-recorder] domain list cap reached, dropping new entries')` per session via a module-level guard so logs are not flooded.
    - Never mutate the input list; always return a new array when `changed` is true.
    - _Requirements: 3.3, 8.3, 8.4, 8.5, 8.6_

  - [ ]* 3.2 Write property test for `recordRequest` size delta and uniqueness
    - **Property 3: recordRequest size delta and uniqueness**
    - **Validates: Requirements 3.3, 8.4, 8.5, 8.6**
    - File: `tests/property/recorder.spec.js`. Use `domainListArb` and an arbitrary URL. Assert the four cases in the design (null extract leaves list unchanged; duplicate leaves unchanged; cap reached leaves unchanged; otherwise size grows by exactly 1, the new domain is present, and the result remains deduped/sorted/bounded).
    - Tag with `// Feature: domain-recorder-extension, Property 3: recordRequest size delta and uniqueness`.

  - [ ]* 3.3 Write property test for Domain_List invariants under sequences of recordRequest
    - **Property 4: Domain list invariants are preserved**
    - **Validates: Requirements 7.5, 7.8, 8.1, 8.2, 8.3**
    - File: `tests/property/recorder.spec.js`. Generate a sequence of arbitrary URL strings (mix of valid/invalid/duplicate/cap-pressure). Fold `recordRequest` over the sequence starting from `[]`. Assert: every entry has length 1..253, every entry equals its own ASCII-trimmed lowercase form, no two entries are equal under byte equality or trim-and-case-fold, entries are sorted by `compareCi`, and length ≤ 10000.
    - Tag with `// Feature: domain-recorder-extension, Property 4: Domain list invariants are preserved`.

- [x] 4. Implement the storage adapter and state module
  - [x] 4.1 Implement `src/background/storage.js`
    - Import `browser` from `src/shared/browser.js` and `STORAGE_KEYS`, `SCHEMA_VERSION` from `src/shared/constants.js`.
    - Export `loadState()` returning `{ state, list }` with defaults applied for missing keys and the `recording → stopped` recovery rule (rewrite to storage when the rule fires; if the rewrite fails, leave in-memory state as `recording` and log).
    - Export `saveState(state)`, `saveList(list)`, `clearList()` returning `{ ok, error? }` (never throw).
    - Each function logs `console.warn('[domain-recorder] storage <op> failed for key <k>', err)` on failure and identifies the key.
    - _Requirements: 3.4, 3.5, 4.4, 4.5, 4.6, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_

  - [x] 4.2 Implement `src/background/state.js`
    - Export the `RecordingState` enum object `{ Idle: 'idle', Recording: 'recording', Stopped: 'stopped' }` and a `setState(next, { saveState })` helper that calls the injected `saveState` first and only advances an in-memory cache (returned from the helper) when `ok` is true.
    - Export pure transition predicates: `canStart(state)`, `canStop(state)`, `nextStateForStart(state)`, `nextStateForStop(state)` per Requirements 2.1, 2.2, 4.1, 4.2.
    - _Requirements: 2.1, 2.2, 4.1, 4.2, 4.6_

  - [ ]* 4.3 Write property test for storage round-trip
    - **Property 7: Storage round-trip**
    - **Validates: Requirements 3.4, 4.4, 5.2**
    - File: `tests/property/storage.spec.js`. Use the `mockBrowser` helper. Generate `(state, list)` pairs, write via `saveState` + `saveList`, then call `loadState` and assert returned values equal the inputs (under the documented case-insensitive comparator for the list).
    - Tag with `// Feature: domain-recorder-extension, Property 7: Storage round-trip`.

  - [ ]* 4.4 Write property test for bootstrap normalization
    - **Property 8: Bootstrap normalization**
    - **Validates: Requirements 5.3, 5.4, 5.6**
    - File: `tests/property/bootstrap.spec.js`. Generate persisted shapes including: missing `recordingState`, missing `domainList`, persisted `recording`, malformed list values (non-strings, mixed case, duplicates, oversized). Call `loadState` and assert the in-memory state is in `{idle, stopped}` (never `recording`), the list is a valid Domain_List, and storage is rewritten with the normalized values.
    - Tag with `// Feature: domain-recorder-extension, Property 8: Bootstrap normalization`.

  - [ ]* 4.5 Write example tests for storage and bootstrap error paths
    - File: `tests/example/bootstrap.spec.js`. Configure `mockBrowser.storage.local.get` to reject; assert defaults are loaded into memory and a diagnostic identifying the failed key is logged (Req 5.5). Configure the recovery write to fail; assert in-memory state stays `recording` and a diagnostic is logged (Req 5.7).
    - _Requirements: 5.5, 5.7_

- [x] 5. Checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. Implement the background service worker
  - [x] 6.1 Implement message and webRequest handling in `src/background/service-worker.js`
    - Import `browser`, `loadState`, `saveState`, `saveList`, `clearList`, `recordRequest`, `RecordingState`, `setState`.
    - At module top level: register `runtime.onStartup`, `runtime.onInstalled`, `runtime.onMessage`, and `webRequest.onBeforeRequest` with URL filter `{ urls: ['http://*/*', 'https://*/*'] }`.
    - Implement a `safeApiCall(apiName, fn)` helper per design that logs `[domain-recorder] Unsupported or failing API: <apiName> on <userAgent>. Continuing without this feature. Error: <err>` and returns `undefined`.
    - On bootstrap (called from `onStartup`/`onInstalled` and lazily at first event), call `loadState` and cache `state`/`list` in module locals.
    - Handle messages `GET_STATUS`, `START_RECORDING`, `STOP_RECORDING`, `CLEAR_DOMAINS`, `OPEN_RESULTS` per the design's message table; on `OPEN_RESULTS` call `browser.tabs.create({ url: browser.runtime.getURL('results/results.html') })`.
    - On `START_RECORDING`: if state can transition, attempt `webRequest.onBeforeRequest.addListener(...)` (already registered at top level — instead set an in-memory `isRecording` flag whose source of truth is `storage.local`), call `setState(Recording)`; on listener registration failure roll back via `setState(prior)` and log.
    - On `STOP_RECORDING`: call `setState(Stopped)`. The top-level listener short-circuits when `recordingState !== 'recording'`, so no removeListener call is required for correctness; do call `webRequest.onBeforeRequest.removeListener(handler)` once per stop transition for parity with Req 4.3 and re-register on next start.
    - In the `webRequest.onBeforeRequest` handler: read current `recordingState` from cache (refreshed on each storage change via `storage.onChanged`); if not `recording`, return immediately (Req 3.8). Otherwise call `recordRequest(details.url, currentList)`; if `changed`, call `saveList(newList)` and update the in-memory cache only on `ok`.
    - On every state transition, update the toolbar action: `recording` → badge `"REC"`, color `#c0392b`, recording icon variant; `idle`/`stopped` → empty badge, default icon (Reqs 2.9, 4.8).
    - _Requirements: 1.4, 1.5, 2.1, 2.2, 2.3, 2.5, 2.6, 2.9, 3.4, 3.5, 3.8, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.8, 5.6, 5.7, 6.1_

  - [ ]* 6.2 Write property test for capture scoped to recording session
    - **Property 5: Capture is scoped to the recording session**
    - **Validates: Requirements 3.8, 4.5**
    - File: `tests/property/session.spec.js`. Generate a sequence of events `{ kind: 'start' | 'stop' | 'request', payload }`. Drive the service worker via `mockBrowser` (fire `runtime.onMessage` for transitions, fire `webRequest.onBeforeRequest` for requests). After the sequence, assert the persisted Domain_List equals the deduped/sorted/capped set of `extractDomain(uᵢ)` values for which `uᵢ` arrived while state was `recording`, and contains no domain from a request that arrived while the state was `idle` or `stopped`.
    - Tag with `// Feature: domain-recorder-extension, Property 5: Capture is scoped to the recording session`.

  - [ ]* 6.3 Write property test for state transitions preserving the Domain_List
    - **Property 6: State transitions preserve the Domain_List**
    - **Validates: Requirements 2.1, 2.2, 2.3, 4.1, 4.2**
    - File: `tests/property/state.spec.js`. Generate a `(state, list)` pair and a transition kind. Drive `setState` via the message handlers; assert the persisted Domain_List equals the prior list, the new state is `recording` after `START` / `stopped` after `STOP`, and is unchanged when the prior state already matches.
    - Tag with `// Feature: domain-recorder-extension, Property 6: State transitions preserve the Domain_List`.

  - [ ]* 6.4 Write example tests for transition error paths and badge/icon
    - File: `tests/example/transitions.spec.js`. Force `webRequest.onBeforeRequest.addListener` to throw on `START`; assert state rolls back via `setState(prior)`, listener is not retained, and a diagnostic is logged (Req 2.6). On `STOP`, assert `removeListener` is called before any subsequent fire (Req 4.3). Force `saveState` to fail on stop; assert in-memory state stays `recording` and a diagnostic identifying the failed key is logged (Req 4.6).
    - File: `tests/example/badge.spec.js`. Drive transitions and assert `setBadgeText('REC')` + recording icon for `recording`, empty badge + default icon for `idle`/`stopped` (Reqs 2.9, 4.8).
    - File: `tests/example/api-shim.spec.js`. Force a wrapped API call to throw; assert `safeApiCall` logs the API name and `navigator.userAgent` and returns `undefined`, and unrelated features keep running (Reqs 1.4, 1.5).
    - _Requirements: 1.4, 1.5, 2.6, 2.9, 4.3, 4.6, 4.8_

- [x] 7. Implement the Popup_UI
  - [x] 7.1 Create `src/popup/popup.html`, `src/popup/popup.css`, and the popup renderer
    - `popup.html` defines containers for: title, status indicator, count display, guidance text region, and three action buttons (`Start`, `Stop`, `Open results`) plus a `Clear list` button. Includes `popup.css` and `popup.js` (as `<script type="module">`).
    - `popup.css` styles a recording indicator (red dot) and visually hides controls based on a state attribute on the root container.
    - In `src/popup/popup.js`: import `browser` from `../shared/browser.js`. On load, send `GET_STATUS`; on response, render the appropriate layout (idle/stopped-no-domains, recording, stopped-with-domains) per the design. Subscribe to `browser.storage.onChanged` to keep the count live while recording (Req 9.2).
    - Wire button clicks: `Start` → send `START_RECORDING`; `Stop` → send `STOP_RECORDING`; `Open results` → send `OPEN_RESULTS`; `Clear list` → confirm via `window.confirm`, then send `CLEAR_DOMAINS`.
    - Render guidance text exactly as in the design (three-step list) when state is `recording` (Reqs 9.1, 9.3). When state is `recording`, hide `Start` and show `Stop` (Reqs 2.7, 2.8).
    - On a storage read failure response from the background, show an error indication and render `state = 'idle'`, `count = 0` (Req 5.9).
    - _Requirements: 2.7, 2.8, 4.7, 5.8, 5.9, 6.1, 9.1, 9.2, 9.3_

  - [ ]* 7.2 Write property test for Popup_UI count reflecting storage
    - **Property 10: Popup_UI count reflects storage**
    - **Validates: Requirements 5.8, 9.2**
    - File: `tests/property/popup.spec.js` (Vitest with `// @vitest-environment jsdom`). Render the popup into jsdom against a `mockBrowser`. Generate `(state, list)` pairs and storage update sequences; after each update, assert the displayed count equals `|L|` and the visible affordances map to `s` (start visible vs stop visible vs open-results visible).
    - Tag with `// Feature: domain-recorder-extension, Property 10: Popup_UI count reflects storage`.

  - [ ]* 7.3 Write example tests for Popup_UI affordances and storage error
    - File: `tests/example/popup.spec.js`. Assert the guidance text and the start/stop visibility rules under each state (Reqs 2.7, 2.8, 9.1, 9.3). Assert clicking `Open results` triggers a `runtime.sendMessage({ type: 'OPEN_RESULTS' })` and that the background's resulting `tabs.create` call uses `runtime.getURL('results/results.html')` (Req 6.1). Force `GET_STATUS` to return a storage-read-failure shape; assert the popup shows an error indication and renders `idle` + count 0 (Req 5.9).
    - _Requirements: 2.7, 2.8, 5.9, 6.1, 9.1, 9.3_

- [x] 8. Implement the Results_Page
  - [x] 8.1 Create `src/results/results.html`, `src/results/results.css`, and the results renderer
    - `results.html` defines the header (title, count), toolbar (`Copy all`, `Clear list`), main scrollable list region, and a status banner area. Includes `results.css` and `results.js` (as `<script type="module">`).
    - In `src/results/results.js`: import `browser` and `compareCi`. On load, read `domainList` from `storage.local`; sort with `compareCi` and render the list and the count (Reqs 6.2, 6.3, 6.4).
    - Subscribe to `browser.storage.onChanged` and re-render within 2 s on any `domainList` change (Req 6.7).
    - `Copy all`: if `list.length === 0`, show "No domains to copy" and do not call the clipboard (Req 6.9). Otherwise call `navigator.clipboard.writeText(sorted.join('\n'))`; on resolve show "Copied N domains" (Req 6.5); on reject show "Could not copy domains to clipboard" and leave storage unchanged (Req 6.10).
    - `Clear list`: confirm via `window.confirm`; on confirm, call `browser.storage.local.remove('domainList')` and re-render with empty list and count 0 (Req 6.6).
    - On read failure, show an error indication and render an empty list with count 0 (Req 6.8).
    - _Requirements: 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10_

  - [ ]* 8.2 Write property test for Results_Page rendering matching storage
    - **Property 9: Results_Page rendering matches storage**
    - **Validates: Requirements 6.2, 6.3, 6.4, 6.5, 6.7**
    - File: `tests/property/results-page.spec.js` (jsdom env). Generate persisted Domain_Lists `L`. Mount the page against `mockBrowser`. Assert the rendered list equals `sortCi(L)`, the count equals `|L|`, and on user-initiated `Copy all` the clipboard payload equals `sortCi(L).join('\n')`. Then fire a `storage.onChanged` event with a new list and assert the rendered list, count, and next-copy payload all reflect the new persisted list.
    - Tag with `// Feature: domain-recorder-extension, Property 9: Results_Page rendering matches storage`.

  - [ ]* 8.3 Write example tests for Results_Page error paths
    - File: `tests/example/results-page.spec.js`. Force the initial `storage.local.get` to reject; assert the page shows an error indication and renders empty list + count 0 (Req 6.8). Click `Copy all` with a zero-length list; assert no clipboard write and the "No domains to copy" indication (Req 6.9). Force `navigator.clipboard.writeText` to reject; assert the error indication and that storage is unchanged (Req 6.10).
    - _Requirements: 6.8, 6.9, 6.10_

- [x] 9. Wire the manifest, polyfill, and build
  - [x] 9.1 Author `src/manifest.json` per the design
    - `manifest_version: 3`, `name`, `version`, `description`, `permissions: ['webRequest', 'storage', 'tabs']`, `host_permissions: ['http://*/*', 'https://*/*']`, `background.service_worker: 'background/service-worker.js'`, `background.type: 'module'`, `action.default_popup: 'popup/popup.html'` and icons, `browser_specific_settings.gecko.id` and `strict_min_version: '115.0'`, `minimum_chrome_version: '120'`.
    - Declare exactly the listed permissions and host permissions; declare nothing else (Req 10.1).
    - _Requirements: 1.1, 1.2, 10.1, 10.2_

  - [x] 9.2 Vendor and integrate `webextension-polyfill`
    - Place the MV3-friendly built file at `src/vendor/browser-polyfill.min.js` (or import from `node_modules` via the build step) and ensure `src/shared/browser.js` is the only module that touches the polyfill so all calling modules import `browser` from a single seam (Req 1.3).
    - In the `build` script, copy `src/` → `dist/` (preserving structure) and inline the polyfill so the loaded extension does not require a bundler at runtime.
    - _Requirements: 1.3_

- [x] 10. Smoke and integration tests
  - [x] 10.1 Manifest contract test
    - File: `tests/smoke/manifest.spec.js`. Parse `src/manifest.json`. Assert `permissions` array equals `['webRequest', 'storage', 'tabs']` exactly and `host_permissions` equals `['http://*/*', 'https://*/*']` exactly. Assert `manifest_version === 3`, `background.type === 'module'`, `browser_specific_settings.gecko.strict_min_version === '115.0'`, `minimum_chrome_version === '120'`.
    - _Requirements: 10.1, 10.2_

  - [x] 10.2 Static contracts test (no banned APIs, no third-party scripts)
    - File: `tests/smoke/static-contracts.spec.js`. Walk `src/` and assert: no `chrome.` references outside `src/shared/browser.js` (Req 1.3); no `storage.sync`, `storage.session`, or `storage.managed` references (Reqs 5.1, 10.2); no `fetch(`, `XMLHttpRequest`, `navigator.sendBeacon`, or `new WebSocket(` references in any `src/` file (Req 10.3); no `<script src="http`-prefixed tags in `popup.html` or `results.html` and no third-party SDK imports anywhere in `src/` (Req 10.4).
    - _Requirements: 1.3, 5.1, 10.2, 10.3, 10.4_

  - [ ]* 10.3 Cross-browser load smoke test
    - File: `tests/smoke/cross-browser.spec.js`. Using `web-ext` to launch Firefox 115 and `puppeteer` to launch Chrome 120 with the unpacked `dist/`, assert the manifest parses without errors and the background reports `ready` (a `runtime.sendMessage({ type: 'GET_STATUS' })` resolves) within 5 s on each browser (Req 1.2).
    - _Requirements: 1.1, 1.2_

  - [ ]* 10.4 Egress test
    - File: `tests/smoke/egress.spec.js`. With a recording session active in a browser launched as in 10.3, fail any outbound request originating from the extension's origin via a network mock; assert no such request is observed during a scripted recording session (Req 10.3).
    - _Requirements: 10.3_

- [x] 11. Final checkpoint - Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP. Property tests, example error-path tests, and cross-browser/egress smoke tests are all optional sub-tasks; the implementation tasks they cover (the pure modules, storage adapter, service worker, popup, results page, and manifest) are mandatory.
- Each property sub-task references exactly one of the design's 10 correctness properties and the requirements clauses it validates; tests are placed close to the implementation they exercise so failures surface early.
- The plan deliberately keeps the toolbar badge/icon updates inside the service-worker task (6.1) so the cross-cutting behavior is integrated rather than left as orphaned code.
- Implementation language is JavaScript (ES modules) with Vitest + fast-check; no language-selection question is required because the design specifies the language and tooling concretely.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["2.1", "4.1", "4.2", "9.1", "9.2"] },
    { "id": 3, "tasks": ["2.2", "3.1", "4.3", "4.4", "4.5", "10.1"] },
    { "id": 4, "tasks": ["2.3", "3.2", "6.1"] },
    { "id": 5, "tasks": ["3.3", "6.2", "6.3", "6.4", "7.1", "8.1"] },
    { "id": 6, "tasks": ["7.2", "7.3", "8.2", "8.3", "10.2", "10.3", "10.4"] }
  ]
}
```
