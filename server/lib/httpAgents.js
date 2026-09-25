// ============================================
// server/lib/httpAgents.js — shared keep-alive-off HTTP/HTTPS agents,
// plus CA-pinned agents for LAN endpoints behind a self-signed TLS proxy
// ============================================
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// keepAlive:false deliberately, everywhere — see gotcha 19: Node 19+
// defaults keep-alive ON for the global agent, and a pooled socket the LLM
// server already decided to close will accept a write and then drop as
// ECONNRESET/"socket hang up". A fresh connection per request avoids the
// race; the extra handshake is negligible next to inference time.
const defaultHttpAgent = new http.Agent({ keepAlive: false });
const defaultHttpsAgent = new https.Agent({ keepAlive: false });

// server/ itself — httpAgents.js lives in server/lib/, so one level up.
// Used to resolve a caCertPath setting consistently regardless of the
// process's actual cwd (e.g. whether `node` was launched from server/ or
// the project root) — a relative path in settings.json should always mean
// "relative to server/", never "relative to wherever you happened to run
// this from".
const SERVER_ROOT = path.join(__dirname, '..');

// Agents pinned to a specific CA cert (e.g. Caddy's local CA root for the
// LAN reverse proxy) are cached by resolved file path — reading/parsing the
// cert on every request would be wasteful, and each distinct CA needs its
// own agent instance since `ca` is fixed at construction time.
const pinnedAgentCache = new Map();

// caCertPath is opt-in per provider (see settings.js). When absent, callers
// get the default agent, which uses Node's normal system trust store — this
// is what keeps OpenAI (and any other real public HTTPS endpoint) verifying
// normally. rejectUnauthorized stays at its default (true) even for the
// pinned agent — we're not disabling verification, we're adding one
// specific CA to what's trusted for that one connection.
function getHttpsAgent(caCertPath) {
    if (!caCertPath) return defaultHttpsAgent;

    // Absolute paths are used as-is; a relative path (the normal case —
    // e.g. "certs/lan-llm-ca.crt") is resolved against server/, not cwd.
    const resolvedPath = path.isAbsolute(caCertPath)
        ? caCertPath
        : path.join(SERVER_ROOT, caCertPath);

    if (!pinnedAgentCache.has(resolvedPath)) {
        const ca = fs.readFileSync(resolvedPath);
        pinnedAgentCache.set(resolvedPath, new https.Agent({ keepAlive: false, ca }));
    }
    return pinnedAgentCache.get(resolvedPath);
}

module.exports = { defaultHttpAgent, defaultHttpsAgent, getHttpsAgent };