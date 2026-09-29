import useLatestCallback from '../hooks/useLatestCallback';
import { blobToWav16kMono } from '../utils/audioCapture';
import { useState, useEffect, useRef } from 'react';
import { authHeaders } from '../utils/authToken';
import { apiFetch } from '../apiConfig';

const VOICE_CHUNK_MS = 4000; // same cadence as ChatBox's wake-word polling chunks

// Standalone flashcard review UI. Fetches its own due-card queue from
// GET /api/anki/due-cards, grades each answer via POST /api/anki/grade —
// deliberately NOT routed through the normal chat loop (see routes/anki.js
// for why). Session-local requeue: a wrong answer goes to the BACK of
// THIS session's queue (not rescheduled by FSRS alone) so it comes back
// around before the session ends, but only after everything else.
//
// `onDiscussCard`, if provided, is called after each grade with
// (card, correct, userAnswer) — App.jsx wires this to
// chatBoxRef.triggerSystemNudge so the AI can react in chat. Purely
// additive; the review flow itself works fully without it.
export default function AnkiWindow({ onDiscussCard }) {
    const [queue, setQueue] = useState(null); // null = loading
    const [error, setError] = useState(null);
    const [typedAnswer, setTypedAnswer] = useState('');
    const [lastResult, setLastResult] = useState(null); // { correct, correctAnswer } | null
    const [grading, setGrading] = useState(false);
    const [voiceMode, setVoiceMode] = useState(false);
    const [aiDiscussion, setAiDiscussion] = useState(true);
    const [micStatus, setMicStatus] = useState('off'); // off | listening | transcribing

    const streamRef = useRef(null);
    const recorderRef = useRef(null);
    const voiceModeRef = useRef(false); // mirrors voiceMode, read synchronously inside the recording loop
    const gradingRef = useRef(false);   // mirrors grading, same reason

    const currentCard = queue && queue.length > 0 ? queue[0] : null;

    useEffect(() => {
        loadDueCards();
        return () => stopVoiceLoop();
    }, []);

    async function loadDueCards() {
        setError(null);
        try {
            const res = await apiFetch('/api/anki/due-cards', { headers: authHeaders() });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Could not load due cards.');
            setQueue(data.cards || []);
        } catch (err) {
            setError(err.message);
            setQueue([]);
        }
    }

    async function submitAnswer(answerText) {
        if (!currentCard || gradingRef.current) return;
        const trimmed = answerText.trim();
        if (!trimmed) return;

        gradingRef.current = true;
        setGrading(true);
        setLastResult(null);

        try {
            const res = await apiFetch('/api/anki/grade', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({ cardId: currentCard.id, answer: trimmed }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Grading failed.');

            setLastResult({ correct: data.correct, correctAnswer: data.correctAnswer });

            setQueue(prev => {
                const [done, ...rest] = prev;
                // Wrong: goes to the BACK of this session's queue, so it
                // comes around again before the session ends. Right: just
                // drops off.
                return data.correct ? rest : [...rest, done];
            });

            if (aiDiscussion && onDiscussCard) {
                onDiscussCard(currentCard, data.correct, trimmed);
            }
        } catch (err) {
            setError(err.message);
        } finally {
            gradingRef.current = false;
            setGrading(false);
            setTypedAnswer('');
        }
    }

    // ---- Voice mode: continuous rolling chunks while enabled, same
    // cadence as ChatBox's wake-word polling — but no wake word needed;
    // the FIRST non-empty transcript while a card is showing and nothing
    // is currently being graded is treated as that card's answer. ----
    const recordOneChunk = useLatestCallback(() => {
        const stream = streamRef.current;
        if (!voiceModeRef.current || !stream) return;

        const chunks = [];
        const recorder = new MediaRecorder(stream);
        recorderRef.current = recorder;
        recorder.ondataavailable = (e) => chunks.push(e.data);
        recorder.onstop = async () => {
            if (!voiceModeRef.current) return;

            // Keep listening for the NEXT chunk immediately, same reasoning
            // as ChatBox's wake-word loop — no dead air waiting on
            // transcription/grading round trips.
            recordOneChunk();

            if (chunks.length === 0 || gradingRef.current) return;

            setMicStatus('transcribing');
            try {
                const wavBlob = await blobToWav16kMono(new Blob(chunks));
                const formData = new FormData();
                formData.append('audio', wavBlob, 'clip.wav');

                const res = await apiFetch('/api/transcribe', {
                    method: 'POST',
                    headers: authHeaders(),
                    body: formData,
                });
                const data = await res.json();
                if (res.ok && data.text && data.text.trim() && !gradingRef.current) {
                    await submitAnswer(data.text.trim());
                }
            } catch (err) {
                console.error('Review voice transcription failed:', err);
            } finally {
                if (voiceModeRef.current) setMicStatus('listening');
            }
        };

        recorder.start();
        setMicStatus('listening');
        setTimeout(() => {
            if (recorder.state === 'recording') recorder.stop();
        }, VOICE_CHUNK_MS);
    });

    async function startVoiceLoop() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            streamRef.current = stream;
            voiceModeRef.current = true;
            setVoiceMode(true);
            recordOneChunk();
        } catch (err) {
            console.error('Microphone access denied or unavailable:', err);
            alert('⚠️ Could not access microphone for voice review.');
        }
    }

    function stopVoiceLoop() {
        voiceModeRef.current = false;
        setVoiceMode(false);
        setMicStatus('off');
        if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
        streamRef.current?.getTracks().forEach(t => t.stop());
        streamRef.current = null;
    }

    function toggleVoiceMode() {
        if (voiceMode) stopVoiceLoop();
        else startVoiceLoop();
    }

    function handleTypedSubmit(e) {
        e.preventDefault();
        submitAnswer(typedAnswer);
    }

    if (queue === null) {
        return <div className="anki-window-status">Loading due cards…</div>;
    }

    if (error && queue.length === 0) {
        return <div className="anki-window-status anki-window-error">⚠️ {error}</div>;
    }

    if (!currentCard) {
        return (
            <div className="anki-window-status">
                🎉 All caught up — nothing due right now.
            </div>
        );
    }

    return (
        <div className="anki-window">
            <div className="anki-window-progress">{queue.length} card{queue.length === 1 ? '' : 's'} left this session</div>

            <div className="anki-card-front">{currentCard.front}</div>
            {currentCard.deck && <div className="anki-card-deck">{currentCard.deck}</div>}

            {lastResult && (
                <div className={`anki-result ${lastResult.correct ? 'anki-result-correct' : 'anki-result-incorrect'}`}>
                    {lastResult.correct ? '✅ Correct!' : `❌ Correct answer: ${lastResult.correctAnswer}`}
                </div>
            )}

            <form onSubmit={handleTypedSubmit} className="anki-answer-row">
                <input
                    type="text"
                    value={typedAnswer}
                    onChange={(e) => setTypedAnswer(e.target.value)}
                    placeholder="Type your answer…"
                    disabled={grading}
                    autoFocus
                />
                <button type="submit" disabled={grading || !typedAnswer.trim()}>Answer</button>
            </form>

            <div className="anki-controls-row">
                <label className="settings-checkbox-row">
                    <input type="checkbox" checked={voiceMode} onChange={toggleVoiceMode} />
                    Voice mode {voiceMode && `(${micStatus === 'listening' ? '🎤 listening' : micStatus === 'transcribing' ? '…' : ''})`}
                </label>
                <label className="settings-checkbox-row">
                    <input type="checkbox" checked={aiDiscussion} onChange={(e) => setAiDiscussion(e.target.checked)} />
                    AI discusses each card
                </label>
            </div>

            {error && <div className="anki-window-error">⚠️ {error}</div>}
        </div>
    );
}