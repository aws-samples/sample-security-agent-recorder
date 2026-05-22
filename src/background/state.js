// Recording_State enum and pure transition helpers for the Domain Recorder
// Extension background.
//
// This module is intentionally I/O-free with one exception: the `setState`
// helper accepts an injected `saveState` function so callers can persist a
// transition to `storage.local` (or any other backing store) without this
// module taking a direct dependency on `src/background/storage.js`. That
// keeps the transition predicates trivially testable and lets the storage
// adapter remain the single seam for `browser.storage.local` access.
//
// Requirements satisfied here:
//   - 2.1: START transitions idle/stopped to recording.
//   - 2.2: START while recording leaves state unchanged.
//   - 4.1: STOP transitions recording to stopped.
//   - 4.2: STOP while idle/stopped leaves state unchanged.
//   - 4.6: When persistence fails, the in-memory state is not advanced.

/**
 * The Recording_State enum.
 *
 * @typedef {'idle' | 'recording' | 'stopped'} RecordingStateValue
 *
 * @type {Readonly<{ Idle: 'idle', Recording: 'recording', Stopped: 'stopped' }>}
 */
export const RecordingState = Object.freeze({
    Idle: 'idle',
    Recording: 'recording',
    Stopped: 'stopped',
});

/**
 * Predicate: can a START transition advance from `state`?
 *
 * Per Requirements 2.1 and 2.2:
 *   - Returns `true` when `state` is `'idle'` or `'stopped'`.
 *   - Returns `false` when `state` is `'recording'` (or any other value).
 *
 * @param {RecordingStateValue} state
 * @returns {boolean}
 */
export function canStart(state) {
    return state === RecordingState.Idle || state === RecordingState.Stopped;
}

/**
 * Predicate: can a STOP transition advance from `state`?
 *
 * Per Requirements 4.1 and 4.2:
 *   - Returns `true` when `state` is `'recording'`.
 *   - Returns `false` when `state` is `'idle'` or `'stopped'` (or any other value).
 *
 * @param {RecordingStateValue} state
 * @returns {boolean}
 */
export function canStop(state) {
    return state === RecordingState.Recording;
}

/**
 * Pure transition function for START.
 *
 * If `canStart(state)` is true, returns `'recording'`; otherwise returns
 * `state` unchanged. This never throws and never reads/writes any storage.
 *
 * @param {RecordingStateValue} state
 * @returns {RecordingStateValue}
 */
export function nextStateForStart(state) {
    return canStart(state) ? RecordingState.Recording : state;
}

/**
 * Pure transition function for STOP.
 *
 * If `canStop(state)` is true, returns `'stopped'`; otherwise returns
 * `state` unchanged. This never throws and never reads/writes any storage.
 *
 * @param {RecordingStateValue} state
 * @returns {RecordingStateValue}
 */
export function nextStateForStop(state) {
    return canStop(state) ? RecordingState.Stopped : state;
}

/**
 * Persist a state transition through an injected `saveState` function and
 * report the outcome.
 *
 * Contract:
 *   - The caller computes the desired next state (typically via
 *     `nextStateForStart` or `nextStateForStop`) and passes it as `next`.
 *   - This helper awaits `saveState(next)`. The injected function MUST
 *     resolve to an object of the shape `{ ok: boolean, error?: unknown }`
 *     (mirroring the contract of `src/background/storage.js`).
 *   - On `{ ok: true }`, returns `{ ok: true, state: next }` and the caller
 *     SHOULD advance its in-memory cache to `next`.
 *   - On `{ ok: false }`, returns `{ ok: false, error }` (`error` may be
 *     `undefined` if the adapter did not provide one). The caller MUST NOT
 *     advance its in-memory cache; this helper does not know the prior
 *     state and therefore cannot include it in the failure result.
 *   - If `saveState` itself throws or rejects, the rejection is caught and
 *     surfaced as `{ ok: false, error }` so callers can branch on `ok`
 *     without try/catch.
 *
 * This helper does not maintain any module-level cache. The caller is
 * responsible for storing the new state in its own in-memory variable on
 * success and for leaving its in-memory variable untouched on failure.
 *
 * @param {RecordingStateValue} next
 *   The desired next state to persist.
 * @param {{ saveState: (state: RecordingStateValue) => Promise<{ ok: boolean, error?: unknown }> }} deps
 *   Dependency object containing the injected `saveState` function.
 * @returns {Promise<{ ok: true, state: RecordingStateValue } | { ok: false, error: unknown }>}
 */
export async function setState(next, { saveState }) {
    let result;
    try {
        result = await saveState(next);
    } catch (error) {
        return { ok: false, error };
    }

    if (result && result.ok === true) {
        return { ok: true, state: next };
    }

    const error = result && 'error' in result ? result.error : undefined;
    return { ok: false, error };
}
