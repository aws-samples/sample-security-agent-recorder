// Test helper: in-memory `browser` mock that mirrors the shape of
// `webextension-polyfill` (promise-based, `browser.*` namespace).
//
// Each test should call `createMockBrowser()` to get a fresh, isolated
// instance. The mock exposes the API surface used by the Domain Recorder
// extension and provides `_fire*` helpers so tests can drive events
// deterministically.
//
// Coverage:
//   browser.storage.local       get / set / remove / clear (promise-based,
//                               dispatches `storage.onChanged` on mutation)
//   browser.storage.onChanged   addListener / removeListener / hasListener
//   browser.webRequest.onBeforeRequest
//                               addListener / removeListener / hasListener
//   browser.tabs.create         records calls
//   browser.runtime.sendMessage  records calls + invokes onMessage listeners
//   browser.runtime.onMessage    addListener / removeListener / hasListener
//   browser.runtime.onStartup    addListener / removeListener / hasListener
//   browser.runtime.onInstalled  addListener / removeListener / hasListener
//   browser.runtime.getURL       returns a deterministic chrome-extension URL
//   browser.action.setBadgeText
//   browser.action.setBadgeBackgroundColor
//   browser.action.setIcon       records calls
//
// All async methods return Promises so callers can `await` them like the
// real polyfill.

/**
 * Create a simple event hub with `addListener`/`removeListener`/`hasListener`
 * and an internal `_fire(...args)` helper. Listeners may return promises;
 * `_fire` resolves with an array of (resolved) listener results.
 *
 * @returns {{
 *   addListener(fn: Function): void,
 *   removeListener(fn: Function): void,
 *   hasListener(fn: Function): boolean,
 *   hasListeners(): boolean,
 *   _listeners(): Function[],
 *   _fire(...args: any[]): Promise<any[]>,
 * }}
 */
function createEvent() {
    const listeners = [];
    return {
        addListener(fn) {
            if (typeof fn !== 'function') {
                throw new TypeError('addListener requires a function');
            }
            if (!listeners.includes(fn)) {
                listeners.push(fn);
            }
        },
        removeListener(fn) {
            const idx = listeners.indexOf(fn);
            if (idx !== -1) {
                listeners.splice(idx, 1);
            }
        },
        hasListener(fn) {
            return listeners.includes(fn);
        },
        hasListeners() {
            return listeners.length > 0;
        },
        _listeners() {
            return listeners.slice();
        },
        async _fire(...args) {
            const results = [];
            for (const fn of listeners.slice()) {
                results.push(await fn(...args));
            }
            return results;
        }
    };
}

/**
 * Deeply clone a JSON-serializable value so callers cannot mutate the
 * mock's internal store by holding a reference to a returned object.
 */
function clone(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

/**
 * Build a `storage.local`-like area backed by an in-memory map. Mutations
 * dispatch `storage.onChanged` with `(changes, areaName)` matching the
 * real WebExtensions API.
 */
function createStorageArea(areaName, onChangedEvent, callLog) {
    let store = {};

    function diff(prev, next, keys) {
        const changes = {};
        for (const key of keys) {
            const oldValue = prev[key];
            const newValue = next[key];
            const had = Object.prototype.hasOwnProperty.call(prev, key);
            const has = Object.prototype.hasOwnProperty.call(next, key);
            if (!had && !has) continue;
            if (!had && has) {
                changes[key] = { newValue: clone(newValue) };
                continue;
            }
            if (had && !has) {
                changes[key] = { oldValue: clone(oldValue) };
                continue;
            }
            // both had and has: only emit if value actually changed
            if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
                changes[key] = {
                    oldValue: clone(oldValue),
                    newValue: clone(newValue)
                };
            }
        }
        return changes;
    }

    return {
        async get(keysArg) {
            callLog.push({ method: 'get', area: areaName, args: [keysArg] });
            // Mirror the polyfill: get() with no args returns all keys.
            if (keysArg === undefined || keysArg === null) {
                return clone(store);
            }
            const result = {};
            if (typeof keysArg === 'string') {
                if (Object.prototype.hasOwnProperty.call(store, keysArg)) {
                    result[keysArg] = clone(store[keysArg]);
                }
                return result;
            }
            if (Array.isArray(keysArg)) {
                for (const k of keysArg) {
                    if (Object.prototype.hasOwnProperty.call(store, k)) {
                        result[k] = clone(store[k]);
                    }
                }
                return result;
            }
            if (typeof keysArg === 'object') {
                // Object form: keys with default values. Returned object
                // contains the stored value when present, else the default.
                for (const k of Object.keys(keysArg)) {
                    if (Object.prototype.hasOwnProperty.call(store, k)) {
                        result[k] = clone(store[k]);
                    } else {
                        result[k] = clone(keysArg[k]);
                    }
                }
                return result;
            }
            throw new TypeError(
                `storage.${areaName}.get: unsupported key argument`
            );
        },
        async set(items) {
            callLog.push({ method: 'set', area: areaName, args: [clone(items)] });
            if (items === null || typeof items !== 'object') {
                throw new TypeError(
                    `storage.${areaName}.set requires an object`
                );
            }
            const prev = clone(store);
            const next = { ...store };
            for (const k of Object.keys(items)) {
                next[k] = clone(items[k]);
            }
            const changes = diff(prev, next, Object.keys(items));
            store = next;
            if (Object.keys(changes).length > 0) {
                await onChangedEvent._fire(changes, areaName);
            }
        },
        async remove(keysArg) {
            callLog.push({
                method: 'remove',
                area: areaName,
                args: [keysArg]
            });
            const keys = Array.isArray(keysArg) ? keysArg : [keysArg];
            const prev = clone(store);
            const next = { ...store };
            for (const k of keys) {
                delete next[k];
            }
            const changes = diff(prev, next, keys);
            store = next;
            if (Object.keys(changes).length > 0) {
                await onChangedEvent._fire(changes, areaName);
            }
        },
        async clear() {
            callLog.push({ method: 'clear', area: areaName, args: [] });
            const prev = clone(store);
            const next = {};
            const changes = diff(prev, next, Object.keys(prev));
            store = next;
            if (Object.keys(changes).length > 0) {
                await onChangedEvent._fire(changes, areaName);
            }
        },
        // Test-only inspection helpers (prefixed with `_` so they cannot be
        // confused with the real WebExtensions API surface).
        _snapshot() {
            return clone(store);
        },
        _seed(initial) {
            store = clone(initial ?? {});
        }
    };
}

/**
 * Create a fresh `browser`-shaped mock. Each call returns a brand-new,
 * isolated instance so tests do not share state.
 *
 * @returns {object} mock browser with `_fire*` helpers attached.
 */
export function createMockBrowser() {
    // Records of "fire-and-forget" recording-only methods. Each entry is the
    // list of argument arrays in call order.
    const callLog = {
        storage: [],
        tabs: { create: [] },
        action: {
            setBadgeText: [],
            setBadgeBackgroundColor: [],
            setIcon: []
        },
        runtime: { sendMessage: [], getURL: [] }
    };

    const onChanged = createEvent();
    const local = createStorageArea('local', onChanged, callLog.storage);

    const onBeforeRequest = createEvent();
    const onMessage = createEvent();
    const onStartup = createEvent();
    const onInstalled = createEvent();

    const browser = {
        storage: {
            local,
            onChanged: {
                addListener: onChanged.addListener,
                removeListener: onChanged.removeListener,
                hasListener: onChanged.hasListener
            }
        },
        webRequest: {
            onBeforeRequest: {
                addListener: onBeforeRequest.addListener,
                removeListener: onBeforeRequest.removeListener,
                hasListener: onBeforeRequest.hasListener
            }
        },
        tabs: {
            async create(createProperties) {
                callLog.tabs.create.push(clone(createProperties));
                // Mirror the real API: returns a Tab-shaped object.
                return {
                    id: callLog.tabs.create.length,
                    url: createProperties?.url
                };
            }
        },
        runtime: {
            async sendMessage(message) {
                callLog.runtime.sendMessage.push(clone(message));
                const results = await onMessage._fire(message, {
                    id: 'mock-extension'
                });
                // Real API resolves with the first non-undefined response.
                return results.find((r) => r !== undefined);
            },
            onMessage: {
                addListener: onMessage.addListener,
                removeListener: onMessage.removeListener,
                hasListener: onMessage.hasListener
            },
            onStartup: {
                addListener: onStartup.addListener,
                removeListener: onStartup.removeListener,
                hasListener: onStartup.hasListener
            },
            onInstalled: {
                addListener: onInstalled.addListener,
                removeListener: onInstalled.removeListener,
                hasListener: onInstalled.hasListener
            },
            getURL(path) {
                callLog.runtime.getURL.push(path);
                const clean = String(path ?? '').replace(/^\/+/, '');
                return `chrome-extension://mock-extension-id/${clean}`;
            }
        },
        action: {
            async setBadgeText(details) {
                callLog.action.setBadgeText.push(clone(details));
            },
            async setBadgeBackgroundColor(details) {
                callLog.action.setBadgeBackgroundColor.push(clone(details));
            },
            async setIcon(details) {
                callLog.action.setIcon.push(clone(details));
            }
        },

        // ------- Test driver helpers -------
        /** Fire `storage.onChanged` listeners with given changes/area. */
        async _fireStorageChange(changes, areaName = 'local') {
            return onChanged._fire(changes, areaName);
        },
        /** Fire `webRequest.onBeforeRequest` listeners with the given details. */
        async _fireWebRequest(details) {
            return onBeforeRequest._fire(details);
        },
        /** Fire `runtime.onMessage` listeners with `(msg, sender)`. */
        async _fireRuntimeMessage(msg, sender = { id: 'mock-extension' }) {
            return onMessage._fire(msg, sender);
        },
        /** Fire `runtime.onStartup` listeners. */
        async _fireRuntimeStartup() {
            return onStartup._fire();
        },
        /** Fire `runtime.onInstalled` listeners with optional details. */
        async _fireRuntimeInstalled(details = { reason: 'install' }) {
            return onInstalled._fire(details);
        },
        /** Inspect recorded calls to fire-and-forget methods. */
        _calls: callLog,
        /** Snapshot the current storage.local contents (deep-cloned). */
        _storageSnapshot() {
            return local._snapshot();
        },
        /** Seed storage.local without firing onChanged listeners. */
        _seedStorage(initial) {
            local._seed(initial);
        },
        /** Inspect registered listeners on each event hub. */
        _events: {
            storageOnChanged: onChanged,
            webRequestOnBeforeRequest: onBeforeRequest,
            runtimeOnMessage: onMessage,
            runtimeOnStartup: onStartup,
            runtimeOnInstalled: onInstalled
        }
    };

    return browser;
}

export default createMockBrowser;
