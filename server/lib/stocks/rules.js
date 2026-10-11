const { createHash } = require('node:crypto');
function sessionOf(quote) {
    if (!quote.quotedAt || !quote.timeZone) return null;
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: quote.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(quote.quotedAt)); }
    catch { return null; }
}
function quoteStatus(quote, at = Date.now(), intervalMinutes = 15) {
    if (!quote?.price || !quote.currency || !quote.quotedAt) return 'unavailable';
    const age = at - Date.parse(quote.quotedAt);
    if (age < -300000) return 'unavailable';
    const maximumAge = Math.max(30, intervalMinutes * 2 + (quote.delayMinutes || 0)) * 60000;
    if (quote.marketState === 'REGULAR' && age > maximumAge) return 'stale';
    return quote.marketState === 'UNKNOWN' ? 'unknown' : 'ok';
}
// Session times are approximate; Yahoo's reported market state handles holidays.
// Refresh outside these windows at most once per hour to learn calendar changes.
function expectedSession(item, at) {
    const timeZone = item.timeZone;
    if (!timeZone) return null;
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
    const values = Object.fromEntries(parts.map(p => [p.type, p.value]));
    if (['Sat', 'Sun'].includes(values.weekday)) return false;
    const minute = Number(values.hour) * 60 + Number(values.minute);
    let start = 9 * 60, end = 18 * 60;
    if (timeZone === 'America/New_York') { start = 9 * 60 + 30; end = 16 * 60; }
    else if (timeZone === 'Europe/Helsinki') { start = 10 * 60; end = 18 * 60 + 30; }
    else if (timeZone === 'Europe/London') { start = 8 * 60; end = 16 * 60 + 30; }
    else if (timeZone === 'Europe/Stockholm') { start = 9 * 60; end = 17 * 60 + 30; }
    else if (timeZone.startsWith('Europe/')) { start = 9 * 60; end = 17 * 60 + 30; }
    return minute >= start && minute <= end + 30; // allow the final delayed close
}
function evaluateQuote(item, quote, previous = {}, config, at) {
    const session = sessionOf(quote);
    if (!session || quoteStatus(quote, at, config.intervalMinutes) !== 'ok') return { state: previous, events: [] };
    const reset = !previous.quote || previous.session !== session || previous.quote.currency !== quote.currency;
    const state = { ...previous, session, quote, rules: reset ? {} : { ...previous.rules } };
    const events = [];
    const move = quote.dayChangePercent, priorPrice = previous.quote?.price;
    const extreme = priorPrice && Math.abs(quote.price / priorPrice - 1) > 0.4;
    if (extreme) { state.rules = {}; state.verificationNeeded = true; return { state, events }; }
    state.verificationNeeded = false;
    const threshold = item.dailyMovePercent ?? config.dailyMovePercent;
    const hysteresis = Math.min(0.5, threshold / 4);
    const rules = [
        { key: 'day-up', hit: move != null && move >= threshold, reset: move == null || move < threshold - hysteresis,
            title: `${item.symbol} rose ${move?.toFixed(2)}% from its previous close.`, direction: 'up' },
        { key: 'day-down', hit: move != null && move <= -threshold, reset: move == null || move > -threshold + hysteresis,
            title: `${item.symbol} fell ${Math.abs(move || 0).toFixed(2)}% from its previous close.`, direction: 'down' },
    ];
    if (item.targetAbove != null) rules.push({ key: 'target-above', hit: quote.price >= item.targetAbove,
        reset: quote.price < item.targetAbove * 0.995, title: `${item.symbol} reached your upper price target (${item.targetAbove} ${quote.currency}).`, direction: 'up' });
    if (item.targetBelow != null) rules.push({ key: 'target-below', hit: quote.price <= item.targetBelow,
        reset: quote.price > item.targetBelow * 1.005, title: `${item.symbol} reached your lower price target (${item.targetBelow} ${quote.currency}).`, direction: 'down' });
    for (const rule of rules) {
        const fingerprint = `${threshold}:${item.targetAbove}:${item.targetBelow}`;
        const prior = state.rules[rule.key];
        const fresh = reset || !prior || prior.fingerprint !== fingerprint;
        const value = fresh ? { active: rule.hit, cycle: 0, lastAlert: 0, fingerprint } : { ...prior };
        if (!fresh && rule.reset) value.active = false;
        if (!fresh && rule.hit && !value.active && (!value.lastAlert || at - value.lastAlert >= config.cooldownMinutes * 60000)) {
            value.active = true; value.lastAlert = at; value.cycle++;
            const id = createHash('sha256').update(`${item.symbol}:${session}:${rule.key}:${value.cycle}:${fingerprint}`).digest('hex');
            events.push({ id, symbol: item.symbol, kind: 'price', created: at, title: rule.title, quote,
                direction: rule.direction, visible: true, status: config.analysisEnabled ? 'pending' : 'done', read: false, sources: [], attempts: 0 });
        }
        state.rules[rule.key] = value;
    }
    return { state, events };
}
module.exports = { sessionOf, quoteStatus, expectedSession, evaluateQuote };
