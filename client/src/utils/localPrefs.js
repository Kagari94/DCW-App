// ============================================
// client/src/utils/localPrefs.js — tiny localStorage JSON helper
// ============================================
// Purely cosmetic/UI state (header icon order, window positions) — never
// anything from the server, never anything sensitive. Wrapped in try/catch
// since localStorage can throw (private browsing, storage disabled/full)
// and none of this is worth crashing the app over if it does.
const PREFIX = 'companion:';

export function getPref(key, fallback) {
    try {
        const raw = localStorage.getItem(PREFIX + key);
        if (raw == null) return fallback;
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

export function setPref(key, value) {
    try {
        localStorage.setItem(PREFIX + key, JSON.stringify(value));
    } catch {
        // ignore — non-critical UI state
    }
}