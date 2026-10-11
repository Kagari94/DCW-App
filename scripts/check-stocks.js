// Read-only live diagnostics. Does not add stocks or enable monitoring.
const { createYahooProvider } = require('../server/lib/stocks/yahoo');
async function checkAnalysis(settings) {
    const assert = require('node:assert/strict');
    const { createStockStore } = require('../server/lib/stocks/store');
    const { createStockService } = require('../server/lib/stocks/service');
    const { normalizeQuote } = require('../server/lib/stocks/yahoo');
    const { validateMonitor } = require('../server/lib/stocks/config');
    const { callLlm } = require('../server/lib/memory/llmClient');
    const scenarios = [
        { name: 'price-up', price: 104, notify: true },
        { name: 'price-down', price: 96, notify: true },
        { name: 'material-news', notify: true, article: {
            title: 'Synthetic diagnostic: Example Company cuts earnings guidance',
            summary: 'TEST DATA ONLY. Example Company announced a 40 percent reduction in its annual earnings guidance and closed its main factory after serious damage. These are new company announcements, not speculation.' } },
        { name: 'routine-news', notify: false, article: {
            title: 'Synthetic diagnostic: Routine weekly recap for Example Company',
            summary: 'TEST DATA ONLY. This article repeats previously published price history. There are no new announcements, earnings changes, forecasts, operational events or business risks. It is routine market commentary only.' } },
    ];
    let failures = 0;
    for (const scenario of scenarios) {
        const store = createStockStore(':memory:');
        let time = Date.parse('2026-10-09T14:00:00Z'), price = 100, articles = [], reply, modelCalls = 0, responseInfo;
        const axios = require('axios');
        const interceptor = axios.interceptors.response.use(response => {
            if (response.config.url === settings.AI_API_URL) responseInfo = {
                finishReason: response.data.choices?.[0]?.finish_reason, usage: response.data.usage,
                reasoningCharacters: response.data.choices?.[0]?.message?.reasoning_content?.length,
            };
            return response;
        });
        const events = [];
        const provider = {
            quotes: async symbols => symbols.map(symbol => normalizeQuote({ symbol,
                longName: 'Synthetic Example Company (diagnostic only)', currency: 'USD',
                fullExchangeName: 'NasdaqGS', exchangeTimezoneName: 'America/New_York',
                regularMarketPrice: price, regularMarketPreviousClose: 100,
                regularMarketTime: new Date(time), marketState: 'REGULAR', exchangeDataDelayedBy: 0 }, time)),
            news: async () => articles,
        };
        const service = createStockService({ store, provider, now: () => time,
            getSettings: () => ({ ...settings, DEBUG: false, stockMonitor: validateMonitor({ enabled: true }) }),
            broadcast: event => events.push(event), webHandlers: { web_search: async () => ({ results: [] }) },
            callModel: async (...args) => { modelCalls++;reply = await callLlm(...args);return reply; } });
        const started = performance.now();
        try {
            await service.add({ symbol: 'DEMO' });
            await service.collect();
            assert.equal(store.alerts({ includeHidden: true }).length, 0, 'First quotes should only establish a baseline.');
            time += 31 * 60000;price = scenario.price ?? 100;
            if (scenario.article) articles = [{ ...scenario.article, url: `https://example.com/stock-diagnostic/${scenario.name}`,
                publishedAt: new Date(time - 60000).toISOString(), publisher: 'Synthetic diagnostic' }];
            await service.collect();
            const [pending] = store.alerts({ includeHidden: true });
            assert.ok(pending, 'Collection should queue an explanation.');
            assert.equal(pending.kind, scenario.article ? 'news' : 'price');
            await service.analyse();
            const result = store.alert(pending.id);
            assert.equal(result.status, 'done', `Analysis did not complete (${result.lastError || 'no error code'}).`);
            assert.ok(result.explanation);
            assert.equal(result.visible, scenario.notify, 'News materiality decision differed from the expected result.');
            if (scenario.notify) assert.ok(events.some(event => event.alert.explanation === result.explanation), 'Explanation was not broadcast.');
            else assert.equal(events.length, 0, 'Routine news should stay silent.');
            assert.equal(result.sources.length, scenario.article ? 1 : 0);
            // Unchanged quotes and already-seen articles must not call the model again.
            time += 31 * 60000;await service.collect();await service.analyse();
            assert.equal(modelCalls, 1, 'Unchanged data caused repeated analysis.');
            console.log(JSON.stringify({ scenario: scenario.name, passed: true, notified: result.visible,
                explanationCharacters: result.explanation.length, seconds: Number(((performance.now() - started) / 1000).toFixed(1)),
                completionTokens: responseInfo?.usage?.completion_tokens, reasoningCharacters: responseInfo?.reasoningCharacters || 0, deduplicated: true }));
        } catch (error) {
            failures++;
            console.log(JSON.stringify({ scenario: scenario.name, passed: false, error: error.message,
                responseCharacters: reply?.length, responsePreview: reply?.slice(0, 1200), responseEnd: reply?.slice(-300), responseInfo }));
        } finally { axios.interceptors.response.eject(interceptor);store.close(); }
    }
    if (failures) throw new Error(`${failures} live stock analysis scenario(s) failed.`);
    console.log(JSON.stringify({ stockAnalysis: 'passed', scenarios: scenarios.length, factsOrChatWritten: false, savedWatchlistChanged: false }));
}
async function main() {
    const provider = createYahooProvider();
    const symbols = ['AAPL', 'NOKIA.HE'];
    if (!process.argv.includes('--analysis-only')) {
        const quotes = await provider.quotes(symbols);
        for (const quote of quotes) {
            if (!quote.price || !quote.currency || !quote.quotedAt || !quote.timeZone) throw new Error(`Incomplete quote: ${quote.symbol}`);
            console.log(JSON.stringify({ symbol: quote.symbol, currency: quote.currency, quotedAt: quote.quotedAt, marketState: quote.marketState, delayMinutes: quote.delayMinutes }));
        }
        for (const symbol of symbols) {
            const articles = await provider.news({ symbol });
            console.log(JSON.stringify({ symbol, articles: articles.length, datedLinks: articles.every(a => a.publishedAt && a.url) }));
        }
        const fundamentals = await provider.fundamentals('AAPL');
        console.log(JSON.stringify({ symbol: fundamentals.symbol, reportingDate: fundamentals.reportingDate, hasBusiness: Boolean(fundamentals.business), hasRevenue: fundamentals.revenue != null }));
    }
    if (process.argv.includes('--analysis') || process.argv.includes('--analysis-only')) {
        // Exercise the real model with explicitly synthetic data in a temporary
        // in-memory stock store. No settings, holdings, chat or memories change.
        const settings = require('../server/settings').getSettings();
        const models = await require('axios').get(settings.AI_API_URL.replace(/\/chat\/completions\/?$/, '/models'), {
            timeout: 5000, proxy: false, httpsAgent: require('../server/lib/httpAgents').getHttpsAgent(settings.CA_CERT_PATH),
            headers: settings.API_KEY ? { Authorization: `Bearer ${settings.API_KEY}` } : {},
        });
        console.log(JSON.stringify({ aiServerReachable: true, selectedModelListed: models.data.data?.some(model => model.id === settings.MODEL_NAME) || false,
            modelName: settings.MODEL_NAME.replace(/^.*[\\/]/, '') }));
        await checkAnalysis(settings);
    }
}
main().catch(error => { console.error(`Stock check failed: ${error.name}: ${error.message}`);process.exitCode = 1; });
