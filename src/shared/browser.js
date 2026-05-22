// Single seam for the cross-browser WebExtensions API.
//
// All other modules in this extension import `browser` from this file rather
// than referencing `chrome.*` or `browser.*` directly. The webextension-polyfill
// package exposes the promise-based `browser.*` API on Chrome by wrapping the
// callback-based `chrome.*` namespace; on Firefox the native `browser.*` is
// returned unchanged.
//
// Centralizing the import here satisfies Requirement 1.3 ("compatibility shim
// that returns the native API implementation of the active browser at runtime
// without requiring code branches in calling modules") and is enforced by the
// ESLint rule that forbids `chrome.*` outside this file.

import browser from 'webextension-polyfill';

export { browser };
export default browser;
