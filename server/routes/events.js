// ============================================
// server/routes/events.js — one-way server -> client push (NDJSON over a
// long-lived HTTP response). Currently only carries the Anki due-cards
// heartbeat, but shaped so any future background reminder could reuse it.
// ============================================
// Deliberately NOT the browser's native EventSource/text-event-stream —
// EventSource can't send custom headers, and this app's auth (x-app-token,
// see server/auth.js) is header-based. This instead reuses the exact
// pattern the chat NDJSON stream already uses client-side (fetch() + a
// ReadableStream reader) — one JSON object per line, connection kept open
// indefinitely, and it sits behind the same requireAuth middleware as
// every other /api route (mounted the same way in index.js) — no new
// unauthenticated surface.
const express = require('express');
const router = express.Router();

// Every currently-open /api/events response, so broadcast() can write to
// all of them. A plain Set is plenty at this scale (one person, a handful
// of tabs/devices at most) — no need for anything fancier.
const clients = new Set();

router.get('/events', (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
    });
    res.write('\n'); // nudges some proxies/browsers to treat the connection as open immediately

    clients.add(res);

    req.on('close', () => {
        clients.delete(res);
    });
});

// Called by ankiHeartbeat.js (and, later, any other background check) to
// push one event to every open tab/device at once. Silently drops a write
// to any response that's already gone stale — req.on('close') should
// catch most of these first, but a write to a half-dead socket can still
// throw, and this is a best-effort push channel, not something worth
// crashing the heartbeat over.
function broadcast(event) {
    const line = JSON.stringify(event) + '\n';
    for (const res of clients) {
        try {
            res.write(line);
        } catch {
            clients.delete(res);
        }
    }
}

module.exports = { router, broadcast };