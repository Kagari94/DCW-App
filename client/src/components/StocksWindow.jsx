import { useEffect, useRef, useState } from 'react';
import { apiJson } from '../apiConfig';
import DraggableWindow from './DraggableWindow';
import SettingsField from './settings/SettingsField';
import useLatestCallback from '../hooks/useLatestCallback';

const dateTime = value => value ? new Date(value).toLocaleString() : 'Unknown';
function amount(value, currency) {
    if (value == null || !Number.isFinite(value)) return '—';
    return `${value.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${currency || ''}`.trim();
}
function StockCard({ item, busy, onSave, onRemove }) {
    const [editing, setEditing] = useState(false);
    const quote = item.quote;
    function submit(event) {
        event.preventDefault();
        const form = new FormData(event.currentTarget), update = {};
        for (const key of ['quantity', 'averageCost', 'targetAbove', 'targetBelow', 'dailyMovePercent']) {
            const raw = form.get(key);update[key] = raw === '' ? null : Number(raw);
        }
        onSave(item.symbol, update).then(saved => { if (saved) setEditing(false); });
    }
    return <article className="stock-card">
        <div className="stock-card-heading"><strong>{item.name}</strong><button type="button" disabled={busy}
            aria-label={`Remove ${item.symbol}`} onClick={() => onRemove(item.symbol)}>Remove</button></div>
        <div className="stock-meta">{item.symbol} · {item.exchange} · {item.currency}</div>
        <div className="stock-price"><strong>{amount(quote?.price, quote?.currency)}</strong>
            {quote?.dayChangePercent != null && <span className={quote.dayChangePercent < 0 ? 'stock-down' : 'stock-up'}>
                {quote.dayChangePercent >= 0 ? '+' : ''}{quote.dayChangePercent.toFixed(2)}%</span>}</div>
        <div className="stock-meta">{quote?.marketState || 'Unknown market status'} · {item.quality}
            {quote?.delayMinutes == null ? ' · Delay unknown' : quote.delayMinutes > 0 ? ` · ${quote.delayMinutes} min delay` : ' · No delay reported'}</div>
        <div className="stock-meta">Quote: {dateTime(quote?.quotedAt)}</div>
        {item.verificationNeeded && <p role="status">Large change needs verification; alerts paused for this sample.</p>}
        {item.quantity != null && <div>Shares: {item.quantity} · Value: {amount(item.value, item.currency)}
            {item.gain != null && <div>Gain/loss: {amount(item.gain, item.currency)}</div>}</div>}
        <div className="stock-card-actions"><label><input type="checkbox" checked={item.enabled} disabled={busy}
            onChange={event => onSave(item.symbol, { enabled: event.target.checked })} /> Follow</label>
            <button type="button" onClick={() => setEditing(value => !value)}>{editing ? 'Cancel' : 'Holdings & alerts'}</button></div>
        {editing && <form className="stock-edit" onSubmit={submit}>
            <SettingsField label="Shares (optional)" name="quantity" type="number" min="0" step="any" defaultValue={item.quantity ?? ''} />
            <SettingsField label={`Average cost (${item.currency})`} name="averageCost" type="number" min="0" step="any" defaultValue={item.averageCost ?? ''} />
            <SettingsField label={`Above (${item.currency})`} name="targetAbove" type="number" min="0.000001" step="any" defaultValue={item.targetAbove ?? ''} />
            <SettingsField label={`Below (${item.currency})`} name="targetBelow" type="number" min="0.000001" step="any" defaultValue={item.targetBelow ?? ''} />
            <SettingsField label="Daily move (%)" name="dailyMovePercent" type="number" min="0.1" max="100" step="0.1" defaultValue={item.dailyMovePercent ?? ''} />
            <button type="submit" disabled={busy}>Save</button>
        </form>}
    </article>;
}
export default function StocksWindow({ onClose, onConfigChange, onAlertsRead, onPrepareVoice, updateSignal = 0 }) {
    const [data, setData] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
    const [tab, setTab] = useState('watchlist'), [results, setResults] = useState([]);
    const lifecycle = useRef(null), busyRef = useRef(false);
    const readCallback = useLatestCallback(onAlertsRead), configCallback = useLatestCallback(onConfigChange);
    const load = useLatestCallback(async () => {
        try { setData(await apiJson('/api/stocks', { signal: lifecycle.current?.signal }));setError(''); }
        catch (reason) {
            if (reason.name !== 'AbortError') setError(reason.status === 404
                ? 'Stock monitoring is unavailable in the running backend. Restart the companion backend, then retry.'
                : reason.message);
        }
    });
    useEffect(() => {
        lifecycle.current = new AbortController();load();
        const timer = setInterval(load, 30000);
        return () => { lifecycle.current.abort();clearInterval(timer); };
    }, [load]);
    useEffect(() => { if (updateSignal) load(); }, [updateSignal, load]);
    async function action(path, body, method = 'POST') {
        if (busyRef.current) return false;
        busyRef.current = true;setBusy(true);setError('');
        try {
            const next = await apiJson(path, { method, body: body === undefined ? undefined : JSON.stringify(body), signal: lifecycle.current?.signal });
            if (next.watchlist) { setData(next);configCallback(next.config); }
            else await load();
            return true;
        } catch (reason) { if (reason.name !== 'AbortError') setError(reason.message);return false; }
        finally { busyRef.current = false;setBusy(false); }
    }
    async function search(event) {
        event.preventDefault();if (busyRef.current) return;
        const query = new FormData(event.currentTarget).get('query');
        busyRef.current = true;setBusy(true);setError('');
        try { const next = await apiJson(`/api/stocks/search?q=${encodeURIComponent(query)}`, { signal: lifecycle.current?.signal });setResults(next.results); }
        catch (reason) { if (reason.name !== 'AbortError') setError(reason.message); }
        finally { busyRef.current = false;setBusy(false); }
    }
    function saveConfig(event) {
        event.preventDefault();const form = new FormData(event.currentTarget);
        action('/api/stocks/config', { intervalMinutes: Number(form.get('intervalMinutes')), newsIntervalMinutes: Number(form.get('newsIntervalMinutes')),
            dailyMovePercent: Number(form.get('dailyMovePercent')), cooldownMinutes: Number(form.get('cooldownMinutes')),
            quietHours: { enabled: form.get('quietEnabled') === 'on', start: form.get('quietStart'), end: form.get('quietEnd'), timeZone: form.get('timeZone') } }, 'PATCH');
    }
    return <DraggableWindow title="Stocks" persistKey="stocks" initialX={Math.max(50, window.innerWidth - 460)} initialY={80} width={420} onClose={onClose}>
        <div className="stocks-panel">
            {error && <p role="alert">{error}</p>}
            {!data ? error ? <button type="button" onClick={load}>Retry</button> : <p role="status">Loading stocks…</p> : <>
                <div className="stock-switches">
                    {[['enabled', 'Monitoring'], ['analysisEnabled', 'AI explanations'], ['voiceAlerts', 'Voice alerts']].map(([key, label]) =>
                        <label key={key}><input type="checkbox" checked={data.config[key]} disabled={busy}
                            onChange={event => {
                                if (key === 'voiceAlerts' && event.target.checked) onPrepareVoice?.();
                                action('/api/stocks/config', { [key]: event.target.checked }, 'PATCH');
                            }} /> {label}</label>)}
                </div>
                <div className="stock-meta">Yahoo Finance · {data.config.enabled ? `Every ${data.config.intervalMinutes} min` : 'Monitoring off'} · Quotes may be delayed</div>
                {data.status.error && <p role="status">{data.status.error}</p>}
                {data.status.newsError && <p role="status">{data.status.newsError}</p>}
                <details className="stock-settings"><summary>Schedule & alerts</summary>
                    <form key={JSON.stringify(data.config)} onSubmit={saveConfig}>
                        <SettingsField label="Prices (minutes)" name="intervalMinutes" type="number" min="1" max="1440" defaultValue={data.config.intervalMinutes} required />
                        <SettingsField label="News (minutes)" name="newsIntervalMinutes" type="number" min="5" max="1440" defaultValue={data.config.newsIntervalMinutes} required />
                        <SettingsField label="Daily move (%)" name="dailyMovePercent" type="number" min="0.1" max="100" step="0.1" defaultValue={data.config.dailyMovePercent} required />
                        <SettingsField label="Cooldown (minutes)" name="cooldownMinutes" type="number" min="1" max="1440" defaultValue={data.config.cooldownMinutes} required />
                        <label><input type="checkbox" name="quietEnabled" defaultChecked={data.config.quietHours.enabled} /> Quiet hours</label>
                        <SettingsField label="From" name="quietStart" type="time" defaultValue={data.config.quietHours.start} required />
                        <SettingsField label="Until" name="quietEnd" type="time" defaultValue={data.config.quietHours.end} required />
                        <SettingsField label="Timezone" name="timeZone" defaultValue={data.config.quietHours.timeZone} required />
                        <button type="submit" disabled={busy}>Save schedule</button>
                    </form>
                </details>
                <div className="companion-tabs" role="tablist" aria-label="Stocks">
                    {['watchlist', 'alerts'].map(name => <button type="button" key={name} role="tab" id={`stocks-${name}-tab`}
                        aria-selected={tab === name} aria-controls={`stocks-${name}-panel`} onClick={() => setTab(name)}>
                        {name === 'watchlist' ? 'Watchlist' : `Alerts (${data.unreadCount})`}</button>)}
                </div>
                <section role="tabpanel" id="stocks-watchlist-panel" aria-labelledby="stocks-watchlist-tab" hidden={tab !== 'watchlist'}>
                    <form className="stock-search" onSubmit={search}>
                        <input name="query" aria-label="Company or symbol" placeholder="Company or symbol" maxLength={100} required />
                        <button type="submit" disabled={busy}>Search</button>
                    </form>
                    {results.length > 0 && <div className="stock-search-results">{results.map(item => <button type="button" key={item.symbol} disabled={busy || data.watchlist.some(s => s.symbol === item.symbol)}
                        onClick={() => action('/api/stocks/watchlist', { symbol: item.symbol }).then(saved => { if (saved) setResults([]); })}>
                        <strong>{item.name}</strong><span>{item.symbol} · {item.exchange} · Add</span></button>)}</div>}
                    <div className="stock-card-actions"><button type="button" disabled={busy || !data.watchlist.length} onClick={() => action('/api/stocks/refresh')}>Refresh prices</button>
                        <span className="stock-meta">Checked: {data.status.lastQuoteCheck ? dateTime(data.status.lastQuoteCheck) : 'Not yet'}</span></div>
                    {!data.watchlist.length && <p>Add stocks you own or want to follow. Share quantities are optional.</p>}
                    {data.watchlist.map(item => <StockCard key={item.symbol} item={item} busy={busy}
                        onSave={(symbol, update) => action(`/api/stocks/watchlist/${encodeURIComponent(symbol)}`, update, 'PATCH')}
                        onRemove={symbol => action(`/api/stocks/watchlist/${encodeURIComponent(symbol)}`, undefined, 'DELETE')} />)}
                </section>
                <section role="tabpanel" id="stocks-alerts-panel" aria-labelledby="stocks-alerts-tab" hidden={tab !== 'alerts'}>
                    {data.alerts.some(alert => alert.status === 'failed') && <button type="button"
                        disabled={busy || !data.config.enabled || !data.config.analysisEnabled}
                        onClick={() => action('/api/stocks/alerts/retry')}>Retry explanations</button>}
                    {!!data.unreadCount && <button type="button" disabled={busy} onClick={() => action('/api/stocks/alerts/read',
                        { ids: data.alerts.filter(a => !a.read).map(a => a.id) }).then(saved => { if (saved) readCallback(); })}>Mark read</button>}
                    {!data.alerts.length && <p>No alerts yet. First quotes establish a baseline; later threshold crossings can notify you.</p>}
                    {data.alerts.map(alert => <article className={`stock-card${alert.read ? '' : ' stock-unread'}`} key={alert.id}>
                        <strong>{alert.title}</strong><div className="stock-meta">{dateTime(alert.created)}</div>
                        {alert.explanation ? <p className="stock-explanation">{alert.explanation}</p> :
                            ['pending', 'running'].includes(alert.status) ? <p className="stock-meta">Companion explanation pending…</p> :
                                alert.status === 'failed' ? <p className="stock-meta">Explanation unavailable; the price alert is saved.</p> : null}
                        {alert.sources?.map(source => <a className="stock-source" key={source.url} href={source.url} target="_blank" rel="noopener noreferrer">
                            {source.title} · {source.publisher} · {dateTime(source.publishedAt)}</a>)}
                    </article>)}
                </section>
            </>}
        </div>
    </DraggableWindow>;
}
