const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const path = require('node:path'), os = require('node:os');
const express = require('express');
const { createStockStore } = require('../server/lib/stocks/store');
const { createStockService, cleanArticle } = require('../server/lib/stocks/service');
const { createYahooProvider, normalizeQuote } = require('../server/lib/stocks/yahoo');
const { validateMonitor, inQuietHours } = require('../server/lib/stocks/config');
const { evaluateQuote, expectedSession } = require('../server/lib/stocks/rules');
const { createSettingsStore } = require('../server/settings');
const { createHeartbeatRegistry } = require('../server/lib/heartbeat/registry');
const foreground = require('../server/lib/memory/foreground');

function fixture(t, overrides = {}) {
    let time = Date.parse('2026-10-09T14:00:00Z'), price = 100, modelCalls = 0, quoteCalls = 0, articles = [];
    const store = createStockStore(':memory:');t.after(() => store.close());
    let settings = { stockMonitor: validateMonitor(), currentCharacter: 'companion-a' };
    const events = [];
    const raw = symbol => ({ symbol, longName: symbol === 'NOKIA.HE' ? 'Nokia' : 'Apple',
        fullExchangeName: symbol.endsWith('.HE') ? 'Helsinki' : 'NasdaqGS', currency: symbol.endsWith('.HE') ? 'EUR' : 'USD',
        exchangeTimezoneName: symbol.endsWith('.HE') ? 'Europe/Helsinki' : 'America/New_York',
        regularMarketPrice: price, regularMarketPreviousClose: 100, regularMarketTime: new Date(time), marketState: 'REGULAR', exchangeDataDelayedBy: 15 });
    const provider = { quotes: async symbols => { quoteCalls++;return symbols.map(symbol => normalizeQuote(raw(symbol), time)); },
        news: async () => articles, search: async () => [{ symbol: 'AAPL', name: 'Apple', exchange: 'NasdaqGS' }],
        fundamentals: async symbol => ({ symbol, reportingDate: '2026-06-30' }), ...overrides.provider };
    const service = createStockService({ store, provider, now: () => time, getSettings: () => settings, broadcast: event => events.push(event),
        readCharacter: () => ({ name: 'Hsin', personality: 'Curious.' }), webHandlers: { web_search: async () => ({ results: [] }) },
        callModel: async () => { modelCalls++;return '{"notify":true,"explanation":"The price moved. No confirmed cause is available."}'; }, ...overrides.service });
    return { store, service, events, provider, raw, advance: ms => { time += ms; }, price: value => { price = value; },
        articles: value => { articles = value; }, now: () => time, config: partial => { settings = { ...settings, stockMonitor: validateMonitor(settings.stockMonitor, partial) };service.changed(); },
        settings: () => settings, modelCalls: () => modelCalls, quoteCalls: () => quoteCalls, switchCharacter: () => { settings.currentCharacter = 'companion-b'; } };
}

test('US/EU watchlist persists quantities, currencies and targets, while disabling makes no automatic requests', async t => {
    const f = fixture(t);
    await f.service.add({ symbol: 'aapl', quantity: 2, averageCost: 90 });
    await f.service.add({ symbol: 'NOKIA.HE', quantity: 4 });
    assert.deepEqual(f.service.snapshot().watchlist.map(i => i.currency), ['USD', 'EUR']);
    assert.equal(f.service.snapshot().watchlist[0].gain, 20);
    const calls = f.quoteCalls();await f.service.collect();await f.service.analyse();assert.equal(f.quoteCalls(), calls);assert.equal(f.modelCalls(), 0);
    f.service.update('AAPL', { targetAbove: 110 });assert.equal(f.store.get('AAPL').quantity, 2);
    assert.throws(() => f.service.update('AAPL', { quantity: -1 }), { status: 400 });
    assert.throws(() => validateMonitor({}, { enabled: 'true' }), { status: 400 });
    assert.throws(() => validateMonitor({}, { intervalMinutes: 0 }), { status: 400 });
    f.service.remove('NOKIA.HE');assert.equal(f.store.list().length, 1);
    const root = mkdtempSync(path.join(os.tmpdir(), 'companion-stock-test-'));
    const filename = path.join(root, 'stocks.db');
    const saved = createStockStore(filename);saved.save(f.store.get('AAPL'));saved.saveAlert({ id: 'restart', created: f.now(), status: 'running', visible: true });saved.close();
    const reopened = createStockStore(filename);assert.equal(reopened.get('AAPL').targetAbove, 110);assert.equal(reopened.alert('restart').status, 'pending');
    reopened.close();rmSync(root, { recursive: true, force: true });
});

test('quotes establish a baseline, notify once on crossings, ignore timestamps and survive rearming/cooldown', async t => {
    const f = fixture(t);await f.service.add({ symbol: 'AAPL' });f.config({ enabled: true });
    f.advance(16 * 60000);await f.service.collect();assert.equal(f.events.length, 0);assert.equal(f.modelCalls(), 0);
    f.price(104);f.advance(16 * 60000);await f.service.collect();assert.equal(f.events.length, 1);
    f.advance(16 * 60000);await f.service.collect();assert.equal(f.events.length, 1);assert.equal(f.modelCalls(), 0);
    await f.service.analyse();assert.equal(f.modelCalls(), 1);assert.equal(f.events.at(-1).type, 'stock_alert_updated');
    assert.match(f.store.alert(f.events[0].alert.id).explanation, /price moved/);
    f.price(101);f.advance(16 * 60000);await f.service.collect();
    f.price(104);f.advance(16 * 60000);await f.service.collect();assert.equal(f.store.alerts().length, 1);
    f.advance(16 * 60000);await f.service.collect();assert.equal(f.store.alerts().length, 2);
    f.config({ voiceAlerts: true });await f.service.analyse();const id = f.events.at(-1).alert.id;
    assert.ok(f.service.claimVoice(id));assert.equal(f.service.claimVoice(id), null);
    assert.equal(f.service.unread().length, 2);f.service.readAlerts([id]);assert.equal(f.service.unread().length, 1);
});

test('daily/price targets ignore stale data, split-like discontinuities and new sessions; exchange clocks honor DST', () => {
    const config = validateMonitor({ enabled: true });const at = Date.parse('2026-10-09T14:00:00Z');
    const item = { symbol: 'AAPL', targetAbove: 110 };
    const quote = normalizeQuote({ symbol: 'AAPL', currency: 'USD', exchangeTimezoneName: 'America/New_York',
        regularMarketPrice: 100, regularMarketPreviousClose: 100, regularMarketTime: new Date(at), marketState: 'REGULAR' }, at);
    const baseline = evaluateQuote(item, quote, {}, config, at).state;
    assert.equal(evaluateQuote(item, { ...quote, price: 120, dayChangePercent: 20 }, baseline, config, at).events.length, 2);
    assert.equal(evaluateQuote(item, { ...quote, price: 120, quotedAt: '2026-10-08T14:00:00Z' }, baseline, config, at).events.length, 0);
    const split = evaluateQuote(item, { ...quote, price: 50, dayChangePercent: -50 }, baseline, config, at);
    assert.equal(split.events.length, 0);assert.equal(split.state.verificationNeeded, true);
    assert.equal(expectedSession({ timeZone: 'America/New_York' }, Date.parse('2026-03-09T13:40:00Z')), true);
    assert.equal(expectedSession({ timeZone: 'America/New_York' }, Date.parse('2026-01-09T13:40:00Z')), false);
    assert.equal(expectedSession({ timeZone: 'Europe/Helsinki' }, Date.parse('2026-10-10T10:00:00Z')), false);
});

test('new symbol-specific news is deduplicated, assessed for materiality and never saved as user chat', async t => {
    const f = fixture(t);await f.service.add({ symbol: 'AAPL' });f.config({ enabled: true });
    f.advance(31 * 60000);f.articles([{ title: 'Apple updates earnings guidance', url: 'https://example.com/guidance?utm_source=x',
        publishedAt: new Date(f.now() - 60000).toISOString(), symbol: 'AAPL' }]);
    await f.service.collect();assert.equal(f.service.snapshot().alerts.length, 0);
    await f.service.analyse();assert.equal(f.modelCalls(), 1);assert.equal(f.events.length, 1);assert.equal(f.events[0].alert.kind, 'news');
    f.advance(31 * 60000);await f.service.collect();await f.service.analyse();assert.equal(f.modelCalls(), 1);
    assert.equal(cleanArticle({ title: 'Undated', url: 'https://example.com' }, 'AAPL', f.now()), null);
    assert.equal(cleanArticle({ title: 'Future', url: 'https://example.com', publishedAt: '2027-01-01' }, 'AAPL', f.now()), null);
});

test('foreground inference cancels stock analysis, shares the background lease and retries without personal facts', async t => {
    let entered, releaseModel;const started = new Promise(resolve => { entered = resolve; });
    const f = fixture(t, { service: { callModel: async (_messages, _config, options) => {
        entered();await new Promise(resolve => { releaseModel = resolve;options.signal.addEventListener('abort', resolve, { once: true }); });
        options.signal.throwIfAborted();return '{"notify":true,"explanation":"A move."}';
    } } });
    await f.service.add({ symbol: 'AAPL' });f.config({ enabled: true });f.price(105);f.advance(16 * 60000);await f.service.collect();
    const work = f.service.analyse();await started;assert.equal(foreground.tryBeginBackground(), null);
    const finish = foreground.beginForeground();await work;assert.equal(f.store.alerts({ includeHidden: true })[0].attempts, 0);
    assert.equal(f.store.alerts()[0].status, 'pending');finish();releaseModel();
    const lease = foreground.tryBeginBackground();assert.ok(lease);lease.release();
});

test('related price rules share one explanation; late-published and routine news are handled without noisy alerts', async t => {
    let calls = 0;
    const f = fixture(t, { service: { callModel: async () => { calls++;return '{"notify":false,"explanation":"Routine commentary, no new material development."}'; } } });
    await f.service.add({ symbol: 'AAPL', targetAbove: 103 });f.config({ enabled: true });
    f.price(104);f.advance(16 * 60000);await f.service.collect();
    assert.equal(f.store.alerts().length, 1);assert.match(f.store.alerts()[0].title, /rose.*upper price target/);
    await f.service.analyse();assert.equal(calls, 1);
    f.advance(31 * 60000);await f.service.collect();const published = new Date(f.now() - 20 * 60000).toISOString();
    f.advance(31 * 60000);f.articles([{ title: 'Routine analyst commentary', url: 'https://example.com/late', publishedAt: published }]);
    await f.service.collect();await f.service.analyse();assert.equal(calls, 2);
    assert.equal(f.store.alerts().length, 1);assert.equal(f.store.alerts({ includeHidden: true }).length, 2);
});

test('partial Yahoo failures keep cached data, respect backoff, and a disable during collection discards late alerts', async t => {
    const f = fixture(t);await f.service.add({ symbol: 'AAPL' });f.config({ enabled: true });
    f.provider.quotes = async () => { throw new Error('429'); };f.advance(16 * 60000);
    await f.service.collect();assert.match(f.service.snapshot().status.error, /temporarily unavailable/);
    const retry = f.service.snapshot().status.retryAt;await f.service.collect();assert.equal(f.service.snapshot().status.retryAt, retry);
    let resolve;f.provider.quotes = () => new Promise(done => { resolve = done; });f.advance(10 * 60000);
    const request = f.service.collect();await new Promise(done => setImmediate(done));f.config({ enabled: false });
    resolve([normalizeQuote({ ...f.raw('AAPL'), regularMarketPrice: 105 }, f.now())]);await request;
    assert.equal(f.events.length, 0);assert.equal(f.store.state('AAPL').quote.price, 100);
});

test('recent failed explanations can recover without replaying facts or interrupting a pending job', async t => {
    const f = fixture(t);await f.service.add({ symbol: 'AAPL' });
    f.store.saveAlert({ id: 'failed', symbol: 'AAPL', created: f.now(), status: 'failed', visible: true, attempts: 3 });
    f.store.saveAlert({ id: 'healthy', symbol: 'AAPL', created: f.now(), status: 'pending', visible: true, attempts: 0 });
    assert.equal(f.service.retryFailed(), 0);f.config({ enabled: true });
    assert.equal(f.service.retryFailed(), 1);assert.equal(f.store.alert('failed').attempts, 0);
    assert.equal(f.store.alert('healthy').status, 'pending');assert.equal(f.service.retryFailed(), 0);
});

test('heartbeat startup and cadence are cancellable, async checks never overlap, and Anki unchanged cooldown remains', async () => {
    const timers = new Map();let id = 0, time = 0, delay = 60000, runs = 0, resolve;
    const scheduler = createHeartbeatRegistry({ now: () => time,
        setTimer: (run, ms) => { const handle = ++id;timers.set(handle, { run, ms });return handle; }, clearTimer: handle => timers.delete(handle) });
    const events = [], ctx = { broadcast: event => events.push(event) };
    scheduler.startHeartbeats([{ id: 'test', eventType: 'due_cards', intervalMs: () => delay, cooldownMs: 100000,
        run: () => { runs++;return new Promise(done => { resolve = done; }); } }], ctx);
    const first = [...timers.values()][0];timers.clear();const running = first.run();assert.equal(runs, 1);assert.equal(timers.size, 0);
    delay = 30000;resolve({ dueCount: 4 });await running;assert.equal([...timers.values()][0].ms, 30000);assert.equal(events.length, 1);
    time = 30000;const next = [...timers.values()][0];timers.clear();const second = next.run();resolve({ dueCount: 4 });await second;assert.equal(events.length, 1);
    scheduler.stopHeartbeats();assert.equal(timers.size, 0);
    scheduler.startHeartbeats([{ id: 'cancel', intervalMs: 60000, run: () => { throw new Error('Startup ran after stop'); } }], ctx);
    scheduler.stopHeartbeats();assert.equal(timers.size, 0);
});

test('stock settings deep merge and authenticated route integration preserve sibling fields and holdings', async t => {
    const f = fixture(t);const root = mkdtempSync(path.join(os.tmpdir(), 'companion-stock-settings-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const settings = createSettingsStore({ settingsPath: path.join(root, 'settings.json') });
    settings.updateSettings({ stockMonitor: { intervalMinutes: 45, quietHours: { enabled: true } } });
    settings.updateSettings({ stockMonitor: { enabled: true } });assert.equal(settings.getSettings().stockMonitor.intervalMinutes, 45);
    assert.equal(settings.getSettings().stockMonitor.quietHours.start, '22:00');
    assert.equal(inQuietHours(settings.getSettings().stockMonitor, Date.parse('2026-10-09T20:30:00Z')), true);
    const app = express();app.use(express.json());app.use('/api', (req, res, next) => req.headers['x-test-token'] === 'yes' ? next() : res.sendStatus(401));
    app.use('/api', require('../server/routes/stocks').makeRouter({ service: f.service, getSettings: f.settings,
        updateSettings: partial => f.config(partial.stockMonitor), refreshHeartbeat: () => {} }));
    const server = app.listen(0, '127.0.0.1');await new Promise(resolve => server.once('listening', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve);server.closeAllConnections(); }));
    const url = `http://127.0.0.1:${server.address().port}/api/stocks`;
    assert.equal((await fetch(url)).status, 401);
    const headers = { 'x-test-token': 'yes', 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${url}/watchlist`, { method: 'POST', headers, body: JSON.stringify({ symbol: 'AAPL', quantity: 2 }) })).status, 201);
    assert.equal((await fetch(`${url}/watchlist/AAPL`, { method: 'PATCH', headers, body: '{"quantity":-1}' })).status, 400);
    const tools = require('../server/tools/handlers/stocks').createStockTools(() => f.service);
    assert.equal(tools.handlers.get_watchlist().watchlist[0].quantity, 2);
    assert.equal((await tools.handlers.get_stock_snapshot({ symbol: 'AAPL' })).currency, 'USD');
    assert.equal(tools.definitions.length, 5);assert.ok(!Object.keys(tools.handlers).some(name => /buy|sell|trade/.test(name)));
});

test('Yahoo normalization preserves decimal currency and dated instrument-specific news while unsupported data stays unknown', async () => {
    const client = { search: async () => ({ quotes: [{ symbol: 'NOKIA.HE', shortname: 'Nokia', quoteType: 'EQUITY', exchDisp: 'Helsinki' }],
        news: [{ title: 'Nokia news', link: 'https://example.com/nokia', providerPublishTime: new Date('2026-10-09T14:00:00Z'), relatedTickers: ['NOKIA.HE'] },
            { title: 'Unrelated', link: 'https://example.com/apple', providerPublishTime: new Date(), relatedTickers: ['AAPL'] }] }) };
    const provider = createYahooProvider({ client });assert.equal((await provider.search('Nokia'))[0].exchange, 'Helsinki');
    assert.equal((await provider.news({ symbol: 'NOKIA.HE' })).length, 1);
    const quote = normalizeQuote({ symbol: 'VOD.L', currency: 'GBp', regularMarketPrice: 92.15 });
    assert.equal(quote.currency, 'GBp');assert.equal(quote.price, 92.15);assert.equal(quote.quotedAt, null);
});
