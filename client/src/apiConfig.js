import { authHeaders } from './utils/authToken';
import { createApiFetch } from './utils/apiTransport';

const hostname = window.location.hostname;
const origins = [`https://${hostname}:3443`];
// Browsers block HTTP requests from HTTPS pages; never promise that fallback.
if (window.location.protocol !== 'https:') origins.push(`http://${hostname}:3000`);
const transport = createApiFetch({ origins });

export function apiFetch(path, options = {}) {
    const headers = new Headers(authHeaders());
    new Headers(options.headers).forEach((value, key) => headers.set(key, value));
    return transport(path, { ...options, headers });
}

export async function requireOk(response) {
    if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || `Request failed (${response.status})`);
    }
    return response;
}

export async function apiJson(path, options = {}) {
    const headers = new Headers(options.headers);
    if (typeof options.body === 'string') headers.set('Content-Type', 'application/json');
    const response = await requireOk(await apiFetch(path, { ...options, headers }));
    return response.json();
}

// Stored as a setting, then fetched by the backend rather than the browser.
export const VOICES_BASE = `http://${hostname}:3000/voices`;
