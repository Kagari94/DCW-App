import { useEffect, useRef } from 'react';
import { authHeaders } from '../utils/authToken';
import { apiFetch } from '../apiConfig';

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
    // Wrapped in a ref so the effect below never needs onEvent as a
    // dependency — a new onEvent identity every render (common for an
    // inline arrow function passed from a parent) would otherwise tear
    // down and reopen this connection constantly.
    const onEventRef = useRef(onEvent);
    onEventRef.current = onEvent;

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

                    const reader = res.body.getReader();
                    const decoder = new TextDecoder();
                    let buffer = '';

                    while (!cancelled) {
                        const { done, value } = await reader.read();
                        if (done) break;

                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split('\n');
                        buffer = lines.pop();

                        for (const line of lines) {
                            if (!line.trim()) continue;
                            try {
                                onEventRef.current(JSON.parse(line));
                            } catch (err) {
                                console.error('Malformed event line:', err);
                            }
                        }
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
    }, []);
}