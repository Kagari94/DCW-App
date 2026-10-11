const { invalid } = require('./config');
function symbolOf(value) {
    if (typeof value !== 'string' || !/^[A-Z0-9^][A-Z0-9.^=_-]{0,39}$/.test(value.trim().toUpperCase())) throw invalid('Invalid stock symbol.');
    return value.trim().toUpperCase();
}
function timestamp(value) {
    if (value == null) return null;
    const time = value instanceof Date ? value.getTime() : typeof value === 'number' ? value * 1000 : Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : null;
}
function normalizeQuote(raw, at = Date.now()) {
    const positive = value => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
    const price = positive(raw.regularMarketPrice), previousClose = positive(raw.regularMarketPreviousClose);
    return { symbol: symbolOf(raw.symbol), name: raw.longName || raw.shortName || raw.symbol,
        exchange: raw.fullExchangeName || raw.exchange || 'Unknown', exchangeCode: raw.exchange || null,
        currency: raw.currency || null, timeZone: raw.exchangeTimezoneName || null,
        price, previousClose, dayChangePercent: price && previousClose ? (price / previousClose - 1) * 100 : null,
        quotedAt: timestamp(raw.regularMarketTime), fetchedAt: new Date(at).toISOString(),
        marketState: raw.marketState || 'UNKNOWN', delayMinutes: Number.isFinite(raw.exchangeDataDelayedBy) ? raw.exchangeDataDelayedBy : null,
        source: 'Yahoo Finance', indicative: true, volume: Number.isFinite(raw.regularMarketVolume) ? raw.regularMarketVolume : null,
        marketCap: Number.isFinite(raw.marketCap) ? raw.marketCap : null,
        trailingPE: Number.isFinite(raw.trailingPE) ? raw.trailingPE : null,
        forwardPE: Number.isFinite(raw.forwardPE) ? raw.forwardPE : null,
        fiftyTwoWeekLow: positive(raw.fiftyTwoWeekLow), fiftyTwoWeekHigh: positive(raw.fiftyTwoWeekHigh) };
}
function safeUrl(value) {
    try { const url = new URL(value); return url.protocol === 'https:' ? url.href : null; } catch { return null; }
}
function createYahooProvider({ client, now = Date.now } = {}) {
    if (!client) {
        const YahooFinance = require('yahoo-finance2').default;
        client = new YahooFinance({ suppressNotices: ['yahooSurvey'], versionCheck: false,
            queue: { concurrency: 2 },
            fetch: (url, options = {}) => fetch(url, { ...options,
                signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000) }) });
    }
    const options = signal => ({ validateResult: false, fetchOptions: { signal: signal || AbortSignal.timeout(25000) } });
    return {
        async search(query, { signal } = {}) {
            if (typeof query !== 'string' || !query.trim() || query.length > 100) throw invalid('Enter a company or symbol (up to 100 characters).');
            const result = await client.search(query.trim(), { quotesCount: 12, newsCount: 0 }, options(signal));
            return (result.quotes || []).filter(q => q.symbol && ['EQUITY', 'ETF'].includes(q.quoteType)).map(q => ({
                symbol: symbolOf(q.symbol), name: q.longname || q.shortname || q.symbol,
                exchange: q.exchDisp || q.exchange || 'Unknown', type: q.quoteType }));
        },
        async quotes(symbols, { signal } = {}) {
            if (!symbols.length) return [];
            const result = await client.quote(symbols.map(symbolOf), {}, options(signal));
            return (Array.isArray(result) ? result : [result]).filter(Boolean).map(raw => normalizeQuote(raw, now()));
        },
        async news(item, { signal } = {}) {
            const result = await client.search(item.symbol, { quotesCount: 0, newsCount: 8 }, options(signal));
            return (result.news || []).flatMap(article => {
                const url = safeUrl(article.link), publishedAt = timestamp(article.providerPublishTime);
                if (!url || !publishedAt || !article.title || !(article.relatedTickers || []).includes(item.symbol)) return [];
                return [{ title: article.title.slice(0, 250), url, publishedAt, publisher: article.publisher || 'Yahoo Finance',
                    symbol: item.symbol, summary: article.summary?.slice(0, 700) || '' }];
            });
        },
        async fundamentals(symbol, { signal } = {}) {
            const result = await client.quoteSummary(symbolOf(symbol),
                { modules: ['summaryProfile', 'summaryDetail', 'financialData', 'defaultKeyStatistics'] }, options(signal));
            const data = result.financialData || {}, stats = result.defaultKeyStatistics || {}, detail = result.summaryDetail || {};
            return { symbol: symbolOf(symbol), fetchedAt: new Date(now()).toISOString(), reportingDate: timestamp(stats.mostRecentQuarter),
                source: 'Yahoo Finance', currency: data.financialCurrency || null,
                business: result.summaryProfile?.longBusinessSummary?.slice(0, 2200) || null,
                sector: result.summaryProfile?.sector || null, industry: result.summaryProfile?.industry || null,
                revenue: data.totalRevenue ?? null, revenueGrowth: data.revenueGrowth ?? null,
                earningsGrowth: data.earningsGrowth ?? null, profitMargin: data.profitMargins ?? null,
                cash: data.totalCash ?? null, debt: data.totalDebt ?? null, freeCashFlow: data.freeCashflow ?? null,
                trailingPE: detail.trailingPE ?? null, forwardPE: detail.forwardPE ?? null, priceToBook: stats.priceToBook ?? null,
                note: 'Growth and margins are ratios, not percentages. These are vendor aggregates; reporting dates can differ by metric. Missing values are unknown.' };
        },
    };
}
module.exports = { createYahooProvider, normalizeQuote, symbolOf, safeUrl };
