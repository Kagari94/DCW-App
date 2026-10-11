// One cancellable timer per check; an async run finishes before its next timer.
function createHeartbeatRegistry({ setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now } = {}) {
    const active = new Map(), lastNotified = new Map();
    function startHeartbeats(checks, ctx) {
        checks.forEach((check, index) => {
            if (active.has(check.id)) return;
            const state = { check, controller: null, timer: null, running: false, refresh: false };
            active.set(check.id, state);
            const interval = () => Math.max(1000, Number(typeof check.intervalMs === 'function' ? check.intervalMs(ctx) : check.intervalMs) || 60000);
            function schedule(delay) { state.timer = setTimer(tick, delay); state.timer.unref?.(); }
            async function tick() {
                state.timer = null;
                if (active.get(check.id) !== state || state.running) return;
                state.running = true;
                state.controller = new AbortController();
                try {
                    const result = await check.run({ ...ctx, signal: state.controller.signal });
                    if (result == null || state.controller.signal.aborted || active.get(check.id) !== state) return;
                    const key = JSON.stringify(result), prior = lastNotified.get(check.id), time = now();
                    if (prior?.key === key && time - prior.at < check.cooldownMs) return;
                    lastNotified.set(check.id, { at: time, key });
                    ctx.broadcast({ type: check.eventType, at: new Date(time).toISOString(), ...result });
                } catch (error) {
                    if (!state.controller.signal.aborted) console.error(`Heartbeat ${check.id} failed:`, error.message);
                } finally {
                    state.running = false;
                    if (active.get(check.id) === state) { schedule(state.refresh ? 1000 : interval()); state.refresh = false; }
                }
            }
            state.schedule = schedule;
            schedule(15000 + index * 2000);
        });
    }
    function refreshHeartbeat(id) {
        const state = active.get(id);
        if (!state) return;
        if (state.running) { state.refresh = true; state.controller.abort(); }
        else { clearTimer(state.timer); state.schedule(1000); }
    }
    function stopHeartbeats() {
        for (const state of active.values()) { clearTimer(state.timer); state.controller?.abort(); }
        active.clear();lastNotified.clear();
    }
    return { startHeartbeats, stopHeartbeats, refreshHeartbeat };
}
module.exports = { createHeartbeatRegistry };
