const DEFAULTS = Object.freeze({ enabled: false, intervalMinutes: 15, newsIntervalMinutes: 30,
    dailyMovePercent: 3, cooldownMinutes: 60, voiceAlerts: false, analysisEnabled: true,
    quietHours: { enabled: false, start: '22:00', end: '08:00', timeZone: 'Europe/Helsinki' } });
function invalid(message) { return Object.assign(new Error(message), { status: 400 }); }
function validateMonitor(current = {}, partial = {}) {
    if (!partial || typeof partial !== 'object' || Array.isArray(partial)) throw invalid('Invalid stock monitor settings.');
    for (const key of Object.keys(partial)) if (!(key in DEFAULTS)) throw invalid(`Unknown stock setting: ${key}`);
    const value = { ...DEFAULTS, ...current, ...partial,
        quietHours: { ...DEFAULTS.quietHours, ...current.quietHours, ...partial.quietHours } };
    for (const key of ['enabled', 'voiceAlerts', 'analysisEnabled']) if (typeof value[key] !== 'boolean') throw invalid(`${key} must be on or off.`);
    for (const [key, min, max] of [['intervalMinutes', 1, 1440], ['newsIntervalMinutes', 5, 1440],
        ['dailyMovePercent', 0.1, 100], ['cooldownMinutes', 1, 1440]]) {
        if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] < min || value[key] > max) {
            throw invalid(`${key} must be between ${min} and ${max}.`);
        }
    }
    const quiet = value.quietHours;
    if (typeof quiet.enabled !== 'boolean' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(quiet.start) ||
        !/^([01]\d|2[0-3]):[0-5]\d$/.test(quiet.end)) throw invalid('Use valid quiet hours (HH:MM).');
    try { new Intl.DateTimeFormat('en', { timeZone: quiet.timeZone }).format(); }
    catch { throw invalid('Invalid quiet-hours timezone.'); }
    return value;
}
function inQuietHours(config, at = Date.now()) {
    const quiet = config.quietHours;
    if (!quiet?.enabled || quiet.start === quiet.end) return false;
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: quiet.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
    return quiet.start < quiet.end ? time >= quiet.start && time < quiet.end : time >= quiet.start || time < quiet.end;
}
module.exports = { DEFAULTS, validateMonitor, invalid, inQuietHours };
