// ============================================
// server/lib/heartbeat/registry.js — generic periodic-check + push scheduler
// ============================================
// A "check" is a plain object: { id, eventType, intervalMs, cooldownMs, run }.
// run(ctx) returns either null (nothing worth reporting right now) or a
// plain JSON-serializable payload object. Adding a new heartbeat-driven
// reminder (a different MCP server, a different condition entirely) is
// just: write a new check module under checks/, list it in
// server/index.js's `checks` array. Nothing else — not this file, not
// routes/events.js, not the client — needs to change for a new check.

const activeIntervals = new Map(); // check.id -> interval handle
const lastNotified = new Map();    // check.id -> { at: number, resultJson: string }

function startHeartbeats(checks, ctx) {
    checks.forEach((check, index) => {
        if (activeIntervals.has(check.id)) return; // already running — idempotent

        async function tick() {
            let result;
            try {
                result = await check.run(ctx);
            } catch (err) {
                console.error(`⚠️ Heartbeat check "${check.id}" failed (non-fatal):`, err.message);
                return;
            }
            if (result == null) return;

            const resultJson = JSON.stringify(result);
            const prior = lastNotified.get(check.id);
            const now = Date.now();

            // Notify if this is genuinely new information (the result
            // changed since we last notified — e.g. due count went up) OR
            // the cooldown has fully elapsed since we last said the same
            // thing — so a persistent, unchanged condition still gets a
            // gentle re-nudge eventually, but not on every single tick.
            const isNewInfo = !prior || prior.resultJson !== resultJson;
            const cooledDown = !prior || (now - prior.at >= check.cooldownMs);
            if (!isNewInfo && !cooledDown) return;

            lastNotified.set(check.id, { at: now, resultJson });
            ctx.broadcast({ type: check.eventType, at: new Date(now).toISOString(), ...result });
        }

        const handle = setInterval(tick, check.intervalMs);
        activeIntervals.set(check.id, handle);

        // Run once shortly after startup too, so an existing condition
        // surfaces without waiting a full interval after every server
        // restart. Staggered per check (2s apart) so a bunch of checks
        // registered at once don't all hit their tools in the same instant.
        setTimeout(tick, 15_000 + index * 2_000);
    });
}

function stopHeartbeats() {
    for (const handle of activeIntervals.values()) clearInterval(handle);
    activeIntervals.clear();
}

module.exports = { startHeartbeats, stopHeartbeats };