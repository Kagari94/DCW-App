const express = require('express');
function makeRouter({ service = require('../lib/stocks/service').getStockService(),
    getSettings = require('../settings').getSettings, updateSettings = require('../settings').updateSettings,
    refreshHeartbeat = require('../lib/heartbeat/registry').refreshHeartbeat } = {}) {
    const router = express.Router();
    const handle = fn => async (req, res) => {
        try { await fn(req, res); }
        catch (error) { res.status(error.status || 503).json({ error: error.status ? error.message : 'Stock data is unavailable. Try again later.' }); }
    };
    router.get('/stocks', handle((_req, res) => res.json(service.snapshot())));
    router.get('/stocks/search', handle(async (req, res) => res.json({ results: await service.search(req.query.q) })));
    router.post('/stocks/watchlist', handle(async (req, res) => { await service.add(req.body);refreshHeartbeat('stock-monitor');res.status(201).json(service.snapshot()); }));
    router.patch('/stocks/watchlist/:symbol', handle((req, res) => { service.update(req.params.symbol, req.body);refreshHeartbeat('stock-monitor');res.json(service.snapshot()); }));
    router.delete('/stocks/watchlist/:symbol', handle((req, res) => { service.remove(req.params.symbol);res.json(service.snapshot()); }));
    router.patch('/stocks/config', handle((req, res) => {
        updateSettings({ stockMonitor: req.body });service.changed();refreshHeartbeat('stock-monitor');res.json(service.snapshot());
    }));
    router.post('/stocks/refresh', handle(async (_req, res) => { await service.collect({ manual: true });res.json(service.snapshot()); }));
    router.get('/stocks/unread', handle((_req, res) => {
        const config = require('../lib/stocks/config').validateMonitor(getSettings().stockMonitor);
        res.json({ alerts: service.unread(), config, quiet: require('../lib/stocks/config').inQuietHours(config) });
    }));
    router.post('/stocks/alerts/read', handle((req, res) => { service.readAlerts(req.body.ids);res.json({ read: true }); }));
    router.post('/stocks/alerts/retry', handle((_req, res) => { service.retryFailed();res.json(service.snapshot()); }));
    router.post('/stocks/alerts/:id/voice', handle((req, res) => res.json({ alert: service.claimVoice(req.params.id) })));
    router.get('/stocks/:symbol/news', handle(async (req, res) => res.json({ articles: await service.news(req.params.symbol, { enrich: true }) })));
    router.get('/stocks/:symbol/fundamentals', handle(async (req, res) => res.json(await service.fundamentals(req.params.symbol))));
    return router;
}
module.exports = { makeRouter };
