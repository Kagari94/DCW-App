import { useRef, useState, useEffect } from 'react';
import { authHeaders } from './utils/authToken';
import { apiFetch } from './apiConfig';
import ChatBox from './components/ChatBox';
import CharacterCanvas from './components/CharacterCanvas';
import DraggableWindow from './components/DraggableWindow';
import SettingsPanel from './components/SettingsPanel';
import WeatherPanel from './components/WeatherPanel';
import AnkiWindow from './components/AnkiWindow';
import ConversationList from './components/ConversationList';
import ToolsMenu from './components/ToolsMenu';
import LoginGate from './components/LoginGate';
import useVoice from './hooks/useVoice';
import useLipSync from './hooks/useLipSync';
import useReminderStream from './hooks/useReminderStream';
import useLiveCamera from './hooks/useLiveCamera';
import { extractTag, cleanTextForVoice, getSafeDisplayPrefix } from './utils/textParsing';
import './App.css';

// If no chat activity (a real user send, or an assistant reply in
// progress) has happened in this long, the heartbeat's proactive nudge is
// allowed to speak up — otherwise it'd interrupt an ongoing exchange. NOT
// used for camera escalations, which are deliberately never idle-gated —
// see handleCameraNotable below.
const IDLE_THRESHOLD_MS = 5 * 60 * 1000;
const TOAST_DURATION_MS = 8000;

function App() {
    const characterRef = useRef(null);
    const chatBoxRef = useRef(null);
    const { playVoice, resetPlaybackSchedule, enqueueSentence, waitForPlaybackToFinish } = useVoice();
    const { startLipSync, stopLipSync } = useLipSync(characterRef);
    const liveCamera = useLiveCamera();
    const [settings, setSettings] = useState(null);
    const [showSettings, setShowSettings] = useState(false);
    const [activeConversationId, setActiveConversationId] = useState(null);
    const [activeConversationTitle, setActiveConversationTitle] = useState(null);
    const [backgroundColor, setBackgroundColor] = useState('#1a1a1a');
    const [weatherPanel, setWeatherPanel] = useState(null);
    const [ankiWindowOpen, setAnkiWindowOpen] = useState(false);
    const [toast, setToast] = useState(null);
    const initConversationRef = useRef(false);
    const cameraInitRef = useRef(false);
    const lastActivityRef = useRef(Date.now());

    const tagsHandledRef = useRef(false);
    const spokenPointerRef = useRef(0);
    const replyInProgressRef = useRef(false);

    const [screenSessionActive, setScreenSessionActive] = useState(false);
    const screenStreamRef = useRef(null);
    const screenVideoRef = useRef(null);

    useEffect(() => {
        apiFetch('/api/settings', { headers: authHeaders() })
            .then(r => r.json())
            .then((data) => {
                setSettings(data);
                if (data.backgroundColor) setBackgroundColor(data.backgroundColor);

                // Camera gatekeeper "remembers" being on across restarts —
                // start it automatically here if it was left enabled, but
                // only once (cameraInitRef), and only from this initial
                // settings load, not on every settings refresh afterward.
                if (data.cameraGatekeeper?.enabled && !cameraInitRef.current) {
                    cameraInitRef.current = true;
                    liveCamera.start();
                }
            });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (activeConversationId || initConversationRef.current) return;
        initConversationRef.current = true;

        apiFetch('/api/conversations', { headers: authHeaders() })
            .then(r => r.json())
            .then(({ conversations }) => {
                const reusable = conversations?.find(c => c.title === 'New conversation');
                if (reusable) {
                    setActiveConversationId(reusable.id);
                    return;
                }

                return apiFetch('/api/conversations', {
                    method: 'POST',
                    headers: authHeaders(),
                })
                    .then(r => r.json())
                    .then(c => setActiveConversationId(c.id));
            });
    }, []);

    useEffect(() => {
        return () => stopScreenSession();
    }, [activeConversationId]);

    // Auto-dismiss the toast after TOAST_DURATION_MS.
    useEffect(() => {
        if (!toast) return;
        const t = setTimeout(() => setToast(null), TOAST_DURATION_MS);
        return () => clearTimeout(t);
    }, [toast]);

    // Anki due-cards heartbeat (server/lib/heartbeat/checks/ankiDueCards.js)
    // pushes a 'due_cards' event over /api/events whenever there's a new or
    // grown backlog worth surfacing. Always shows the toast; ALSO has the
    // AI mention it in chat, but only if the user's been idle for a while —
    // never interrupts an active exchange.
    //
    // 'camera_notable' (server/routes/vision.js) is handled differently on
    // purpose: the gatekeeper model is explicitly instructed to be
    // conservative and only escalate for something genuinely worth
    // interrupting for, so an escalation always triggers the chat nudge
    // immediately, regardless of idle state — idle-gating it would defeat
    // the point of the feature.
    useReminderStream((event) => {
        if (event.type === 'due_cards') {
            const cardWord = event.dueCount === 1 ? 'card is' : 'cards are';
            setToast({ message: `📇 ${event.dueCount} Anki ${cardWord} due for review.` });

            const idleFor = Date.now() - lastActivityRef.current;
            if (idleFor >= IDLE_THRESHOLD_MS) {
                chatBoxRef.current?.triggerSystemNudge(
                    `[System note: ${event.dueCount} Anki flashcard${event.dueCount === 1 ? '' : 's'} ` +
                    `${event.dueCount === 1 ? 'is' : 'are'} due for review. Mention this casually, and offer ` +
                    `to start a review session if they'd like.]`
                );
            }
        } else if (event.type === 'camera_notable') {
            lastActivityRef.current = Date.now();
            setToast({ message: `📷 ${event.description}` });
            chatBoxRef.current?.triggerSystemNudge(
                `[System note: the background camera monitor noticed something worth mentioning: ` +
                `"${event.description}". Bring it up naturally.]`
            );
        }
    });

    function toggleCameraGatekeeper() {
        const next = !liveCamera.active;
        if (next) liveCamera.start();
        else liveCamera.stop();

        apiFetch('/api/settings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify({ cameraGatekeeper: { enabled: next } }),
        })
            .then(r => r.json())
            .then(setSettings)
            .catch(err => console.error('Failed to save camera gatekeeper setting:', err));
    }

    async function startScreenSession() {
        if (!navigator.mediaDevices?.getDisplayMedia) {
            alert("Screen capture isn't supported in this browser.");
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
            screenStreamRef.current = stream;

            const video = document.createElement('video');
            video.srcObject = stream;
            await video.play();
            screenVideoRef.current = video;

            stream.getVideoTracks()[0].addEventListener('ended', () => {
                stopScreenSession();
            });

            setScreenSessionActive(true);
        } catch (err) {
            if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') {
                console.error('Screen session failed to start:', err);
                alert(`⚠️ Screen capture failed: ${err.message}`);
            }
        }
    }

    function stopScreenSession() {
        screenStreamRef.current?.getTracks().forEach(t => t.stop());
        screenStreamRef.current = null;
        screenVideoRef.current = null;
        setScreenSessionActive(false);
    }

    async function grabScreenFrame() {
        const video = screenVideoRef.current;
        if (!video) return null;

        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);

        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!blob) return null;
        return new File([blob], `screen-${Date.now()}.png`, { type: 'image/png' });
    }

    function handleReplyChunk(rawTextSoFar, { done }) {
        lastActivityRef.current = Date.now();

        const character = characterRef.current;
        const streamingVoiceEnabled = settings?.ttsBackend === 'pocket-tts' && settings?.pocketTts?.streaming;

        if (!tagsHandledRef.current) {
            const expression = extractTag(rawTextSoFar, 'expression');
            const animation = extractTag(rawTextSoFar, 'animation');
            if (expression || animation) {
                tagsHandledRef.current = true;
                if (character) {
                    if (expression) {
                        character.resetExpressions(0.2);
                        setTimeout(() => {
                            character.setExpression(expression, 1.0, 0.3);
                            setTimeout(() => character.resetExpressions(0.5), 5000);
                        }, 200);
                    }
                    if (animation) character.playAnimation(animation);
                }
            }
        }

        if (streamingVoiceEnabled) {
            if (!replyInProgressRef.current) {
                replyInProgressRef.current = true;
                resetPlaybackSchedule({ onAnalyser: (analyser) => startLipSync(analyser) });
            }

            const safePrefix = getSafeDisplayPrefix(rawTextSoFar);
            const voiceText = cleanTextForVoice(safePrefix);
            const newPortion = voiceText.slice(spokenPointerRef.current);

            const sentenceRegex = /[^.!?]+[.!?]+(\s+|$)/g;
            let match;
            let consumedInNew = 0;
            while ((match = sentenceRegex.exec(newPortion)) !== null) {
                const sentence = match[0].trim();
                if (sentence) enqueueSentence(sentence);
                consumedInNew = match.index + match[0].length;
            }
            spokenPointerRef.current += consumedInNew;

            if (done) {
                const remainder = cleanTextForVoice(rawTextSoFar).slice(spokenPointerRef.current);
                if (remainder.trim()) enqueueSentence(remainder.trim());

                waitForPlaybackToFinish().then(stopLipSync).catch(() => stopLipSync());

                spokenPointerRef.current = 0;
                replyInProgressRef.current = false;
            }
        } else if (done) {
            const cleanText = cleanTextForVoice(rawTextSoFar);
            playVoice(cleanText, {
                voice: settings?.voice || 'af_bella',
                onAnalyser: (analyser) => startLipSync(analyser),
            }).then(stopLipSync).catch((err) => {
                console.error('Voice playback failed:', err);
                stopLipSync();
            });
        }

        if (done) tagsHandledRef.current = false;
    }

    function handleUiEvents(events) {
        for (const event of events) {
            if (!event) continue;
            if (event.window === 'weather') {
                if (event.action === 'show') setWeatherPanel(event.data || null);
                else if (event.action === 'hide') setWeatherPanel(null);
            } else if (event.window === 'anki') {
                if (event.action === 'show') setAnkiWindowOpen(true);
                else if (event.action === 'hide') setAnkiWindowOpen(false);
            }
        }
    }

    function handleConversationUpdated(newTitle) {
        setActiveConversationTitle(newTitle);
    }

    function handleSettingsChange(updated) {
        if (updated.backgroundColor) setBackgroundColor(updated.backgroundColor);
        setSettings(updated);
    }

    function handleSelectConversation(id) {
        setActiveConversationId(id);
        setActiveConversationTitle(null);
    }

    function handleDiscussCard(card, correct, userAnswer) {
        lastActivityRef.current = Date.now();
        chatBoxRef.current?.triggerSystemNudge(
            `[System note: reviewing an Anki flashcard. Front: "${card.front}". ` +
            `User answered: "${userAnswer}". This was ${correct ? 'CORRECT' : 'INCORRECT'}` +
            `${correct ? '' : ` (correct answer: "${card.back}")`}. ` +
            `Briefly and conversationally react — an example sentence, a tip, or encouragement fits well. Keep it short.]`
        );
    }

    return (
        <LoginGate>
            <div className="app-root" style={{ '--bg-color': backgroundColor }}>
                <CharacterCanvas
                    ref={characterRef}
                    characterFile={settings?.currentCharacter}
                    lighting={settings?.lighting}
                />

                <DraggableWindow
                    title="Chat"
                    initialX={40}
                    initialY={40}
                    width={410}
                    headerExtra={
                        <div className="window-header-extra">
                            <ConversationList
                                activeId={activeConversationId}
                                activeTitle={activeConversationTitle}
                                onSelect={handleSelectConversation}
                                onNew={(id) => {
                                    setActiveConversationId(id);
                                    setActiveConversationTitle(null);
                                }}
                            />
                            <button
                                type="button"
                                onClick={screenSessionActive ? stopScreenSession : startScreenSession}
                                title={screenSessionActive ? 'Stop screen sharing' : 'Start screen sharing session'}
                                className={`tools-menu-toggle${screenSessionActive ? ' screen-session-active' : ''}`}
                            >
                                🖥️
                            </button>
                            <button
                                type="button"
                                onClick={toggleCameraGatekeeper}
                                title={liveCamera.active ? 'Stop live camera monitoring' : 'Start live camera monitoring'}
                                className={`tools-menu-toggle${liveCamera.active ? ' screen-session-active' : ''}`}
                            >
                                📷
                            </button>
                            <button
                                type="button"
                                onClick={() => setAnkiWindowOpen(o => !o)}
                                title={ankiWindowOpen ? 'Close review' : 'Review flashcards'}
                                className={`tools-menu-toggle${ankiWindowOpen ? ' screen-session-active' : ''}`}
                            >
                                📇
                            </button>
                            <ToolsMenu />
                        </div>
                    }
                >
                    <ChatBox
                        ref={chatBoxRef}
                        conversationId={activeConversationId}
                        settings={settings}
                        onReplyChunk={handleReplyChunk}
                        onUiEvents={handleUiEvents}
                        onConversationUpdated={handleConversationUpdated}
                        onUserActivity={() => { lastActivityRef.current = Date.now(); }}
                        screenSessionActive={screenSessionActive}
                        onGrabScreenFrame={grabScreenFrame}
                        onStopScreenSession={stopScreenSession}
                    />
                </DraggableWindow>

                {weatherPanel && (
                    <DraggableWindow
                        title="Weather"
                        initialX={Math.max(window.innerWidth - 320, 280)}
                        initialY={Math.max(window.innerHeight - 320, 280)}
                        width={280}
                        headerExtra={
                            <button
                                onClick={() => setWeatherPanel(null)}
                                className="weather-panel-close-btn"
                            >
                                Close
                            </button>
                        }
                    >
                        <WeatherPanel data={weatherPanel} />
                    </DraggableWindow>
                )}

                {ankiWindowOpen && (
                    <DraggableWindow
                        title="Flashcard Review"
                        initialX={Math.max(window.innerWidth - 380, 280)}
                        initialY={80}
                        width={340}
                        headerExtra={
                            <button
                                onClick={() => setAnkiWindowOpen(false)}
                                className="weather-panel-close-btn"
                            >
                                Close
                            </button>
                        }
                    >
                        <AnkiWindow onDiscussCard={handleDiscussCard} />
                    </DraggableWindow>
                )}

                <button
                    onClick={() => setShowSettings(s => !s)}
                    className="settings-toggle-btn"
                >
                    ⚙ Settings
                </button>

                {showSettings && (
                    <DraggableWindow title="Settings" initialX={window.innerWidth - 380} initialY={60} width={340}>
                        <SettingsPanel onSettingsChange={handleSettingsChange} />
                    </DraggableWindow>
                )}

                {toast && (
                    <div className="reminder-toast" role="status">
                        <span>{toast.message}</span>
                        <button
                            type="button"
                            className="reminder-toast-dismiss"
                            onClick={() => setToast(null)}
                            aria-label="Dismiss"
                        >
                            ✕
                        </button>
                    </div>
                )}
            </div>
        </LoginGate>
    );
}

export default App;