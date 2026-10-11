import { useEffect, useRef, useState } from 'react';
import { apiJson } from '../apiConfig';
import useLatestCallback from './useLatestCallback';

// Shares the existing event stream; alerts stay outside the chat transcript.
export default function useStockAlerts({ onNotify, onSpeak, isBusy, characterId }) {
    const [unreadCount, setUnreadCount] = useState(0);
    const seen = useRef(new Set());
    const pending = useRef(new Map());
    const lifecycle = useRef(null);
    const speaking = useRef(false);
    const notify = useLatestCallback(onNotify), speak = useLatestCallback(onSpeak), busy = useLatestCallback(isBusy);
    const refresh = useLatestCallback(async () => {
        try {
            const { alerts, config, quiet } = await apiJson('/api/stocks/unread', { signal: lifecycle.current?.signal });
            setUnreadCount(alerts.length);
            if (!config.enabled || quiet) return;
            if (alerts.length && alerts.some(a => !seen.current.has(a.id))) notify(`${alerts.length} unread stock alert${alerts.length === 1 ? '' : 's'}.`);
            for (const alert of alerts) {
                seen.current.add(alert.id);
                if (config.enabled && config.voiceAlerts && alert.explanation) pending.current.set(alert.id, alert);
            }
        } catch { /* Login/reconnect will retry; no notification noise. */ }
    });
    const receive = useLatestCallback(event => {
        if (!['stock_alert', 'stock_alert_updated'].includes(event.type) || !event.alert) return;
        const alert = event.alert;
        if (!seen.current.has(alert.id)) {
            seen.current.add(alert.id);setUnreadCount(count => count + 1);notify(alert.title);
        }
        if (seen.current.size > 500) seen.current.delete(seen.current.values().next().value);
        if (alert.explanation) pending.current.set(alert.id, alert);
    });
    const flushVoice = useLatestCallback(async () => {
        if (speaking.current || busy() || document.visibilityState === 'hidden') return;
        const alert = pending.current.values().next().value;
        if (!alert) return;
        pending.current.delete(alert.id);
        if (Date.now() - alert.created > 30 * 60000 || alert.characterId !== characterId) return;
        speaking.current = true;
        try {
            // An atomic server claim prevents two tabs speaking the same alert.
            const result = await apiJson(`/api/stocks/alerts/${encodeURIComponent(alert.id)}/voice`,
                { method: 'POST', signal: lifecycle.current?.signal });
            if (result.alert && !busy() && result.alert.characterId === characterId) await speak(result.alert.explanation);
        } catch { /* Text/history remain available if autoplay is unavailable. */ }
        finally { speaking.current = false; }
    });
    useEffect(() => {
        const controller = new AbortController();lifecycle.current = controller;
        const interval = setInterval(flushVoice, 5000);
        const historyInterval = setInterval(refresh, 60000);
        return () => { controller.abort();clearInterval(interval);clearInterval(historyInterval); };
    }, [flushVoice, refresh]);
    return { unreadCount, receive, refresh };
}
