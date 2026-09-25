// ============================================
// client/src/apiConfig.js — resilient access to the backend
// ============================================
// HTTPS (via Caddy, :3443) is preferred once it's running, but Caddy is a
// separate process from Express itself — if it's down, misconfigured, or
// just hasn't been started, the app must still be reachable enough to fix
// that from Settings. Express always listens on plain :3000 regardless of
// whether Caddy is fronting it, so every backend call goes through
// apiFetch(), which tries HTTPS first and falls back to that plain port on
// any network-level failure. Never a full lockout.
const HTTPS_ORIGIN = `https://${window.location.hostname}:3443`;
const HTTP_ORIGIN = `http://${window.location.hostname}:3000`;

// Remembered for the rest of the session once resolved, so we're not
// re-attempting (and re-eating the connection-failure delay) on every call.
let workingOrigin = null;

function tryFetch(origin, path, options) {
    return fetch(`${origin}${path}`, options);
}

// Drop-in replacement for fetch(), but takes a PATH (e.g. '/api/settings')
// rather than a full URL — the origin is resolved internally, with the
// HTTPS-then-HTTP fallback described above. Use this for every request to
// the backend instead of building a URL with a hardcoded origin.
export async function apiFetch(path, options) {
    if (workingOrigin) {
        try {
            return await tryFetch(workingOrigin, path, options);
        } catch {
            // The previously-working origin just failed (Caddy went down
            // mid-session, laptop slept, etc) — re-probe below instead of
            // staying stuck retrying a dead origin forever.
            workingOrigin = null;
        }
    }

    try {
        const res = await tryFetch(HTTPS_ORIGIN, path, options);
        workingOrigin = HTTPS_ORIGIN;
        return res;
    } catch {
        console.warn(
            '⚠️ HTTPS backend (Caddy, :3443) unreachable — falling back to plain HTTP on :3000. ' +
            'Everything still works; only this machine-local hop is unencrypted until Caddy is fixed.'
        );
        workingOrigin = HTTP_ORIGIN;
        return tryFetch(HTTP_ORIGIN, path, options);
    }
}

// Plain HTTP by design — this only builds a URL string that gets STORED as
// a setting and later fetched server-side (Node talking to pocket-tts on
// localhost), never fetched directly by the browser. The apiFetch fallback
// logic above doesn't apply here; there's nothing for the browser to
// connect to at this URL.
export const VOICES_BASE = `http://${window.location.hostname}:3000/voices`;