import { useEffect } from 'react';
import { authHeaders } from '../utils/authToken';
import { apiFetch } from '../apiConfig';
import useLatestCallback from './useLatestCallback';
import { readNdjson } from '../utils/ndjson';

// Opens ONE long-lived connection to /api/events and calls onEvent(event)
// for every JSON line the server pushes (currently just Anki due-card
// reminders, type: 'due_cards' — see server/lib/ankiHeartbeat.js). Reuses
// the same fetch()+ReadableStream pattern ChatBox.jsx's chat streaming
// already uses, rather than the browser's native EventSource — EventSource
// can't send the x-app-token auth header this app relies on.
//
// Reconnects automatically on drop (server restart, laptop sleep, Caddy
// hiccup) with a simple fixed delay — this is a low-stakes background
// channel, not worth anything fancier like exponential backoff.
const RECONNECT_DELAY_MS = 5000;

export default function useReminderStream(onEvent) {
    const handleEvent = useLatestCallback(onEvent);

    useEffect(() => {
        let cancelled = false;
        let abortController = null;

        async function connect() {
            while (!cancelled) {
                abortController = new AbortController();
                try {
                    const res = await apiFetch('/api/events', {
                        headers: authHeaders(),
                        signal: abortController.signal,
                    });
                    if (!res.ok || !res.body) throw new Error(`Events stream failed (${res.status})`);

                    for await (const event of readNdjson(res)) {
                        if (cancelled) break;
                        handleEvent(event);
                    }
                } catch (err) {
                    if (cancelled || err.name === 'AbortError') return;
                    console.error('Reminder stream dropped, reconnecting:', err.message);
                }

                if (!cancelled) {
                    await new Promise(resolve => setTimeout(resolve, RECONNECT_DELAY_MS));
                }
            }
        }

        connect();

        return () => {
            cancelled = true;
            abortController?.abort();
        };
    }, [handleEvent]);
}