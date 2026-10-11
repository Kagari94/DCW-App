module.exports = { id: 'stock-monitor',
    intervalMs: ({ getSettings }) => Math.min(getSettings().stockMonitor.intervalMinutes, getSettings().stockMonitor.newsIntervalMinutes) * 60000,
    async run({ stocks, signal }) { await stocks.collect({ signal });return null; } };
