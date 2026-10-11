import { useRef, useState, useEffect } from 'react';
import { authHeaders } from './utils/authToken';
import { apiFetch, apiJson } from './apiConfig';
import ChatBox from './components/ChatBox';
import OverflowIconBar from './components/OverflowIconBar';
import HeaderToggle from './components/HeaderToggle';
import CharacterCanvas from './components/CharacterCanvas';
import DraggableWindow from './components/DraggableWindow';
import SettingsPanel from './components/SettingsPanel';
import CompanionWindow from './components/CompanionWindow';
import StocksWindow from './components/StocksWindow';
import WeatherPanel from './components/WeatherPanel';
import AnkiWindow from './components/AnkiWindow';
import ConversationList from './components/ConversationList';
import ToolsMenu from './components/ToolsMenu';
import LoginGate from './components/LoginGate';
import useVoice from './hooks/useVoice';
import useLipSync from './hooks/useLipSync';
import useReminderStream from './hooks/useReminderStream';
import useStockAlerts from './hooks/useStockAlerts';
import useLiveCamera from './hooks/useLiveCamera';
import { extractTag, cleanTextForVoice, getVoiceSentences } from './utils/textParsing';
import { normalizeCharacterSettings, applyCharacterUpdate } from './utils/characters';
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
    const { playVoice, resetPlaybackSchedule, enqueueSentence, waitForPlaybackToFinish, stopVoice, prepareVoice, isPlaying } = useVoice();
    const { startLipSync, stopLipSync } = useLipSync(characterRef);
    const liveCamera = useLiveCamera();
    const [settings, setSettings] = useState(null);
    const [showSettings, setShowSettings] = useState(false);
    const [showCompanion, setShowCompanion] = useState(false);
    const [showStocks, setShowStocks] = useState(false);
    const [stockUpdate, setStockUpdate] = useState(0);
    const [activeConversationId, setActiveConversationId] = useState(null);
    const [activeConversationTitle, setActiveConversationTitle] = useState(null);
    const [backgroundColor, setBackgroundColor] = useState('#1a1a1a');
    const [weatherPanel, setWeatherPanel] = useState(null);
    const [ankiWindowOpen, setAnkiWindowOpen] = useState(false);
    const [cameraStarting, setCameraStarting] = useState(false);
    const [toast, setToast] = useState(null);
    const initConversationRef = useRef(false);
    const lastActivityRef = useRef(Date.now());

    const tagsHandledRef = useRef(false);
    const spokenPointerRef = useRef(0);
    const replyInProgressRef = useRef(false);
    const voiceReplyRef = useRef(0);

    useEffect(() => {
        stopVoice();
        stopLipSync();
        voiceReplyRef.current++;
        spokenPointerRef.current = 0;
        replyInProgressRef.current = false;
    }, [activeConversationId, stopVoice, stopLipSync]);

    const [screenSessionActive, setScreenSessionActive] = useState(false);
    const screenStreamRef = useRef(null);
    const screenVideoRef = useRef(null);

    useEffect(() => {
        apiFetch('/api/settings', { headers: authHeaders() })
            .then(r => r.json())
            .then(async (data) => {
                // Camera access is session-only. Clear a saved "on" flag from
                // older versions before the user can start it explicitly.
                if (data.cameraGatekeeper?.enabled) {
                    try {
                        const response = await apiFetch('/api/settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', ...authHeaders() },
                            body: JSON.stringify({ cameraGatekeeper: { enabled: false } }),
                        });
                        if (!response.ok) throw new Error(`HTTP ${response.status}`);
                        data = await response.json();
                    } catch (error) {
                        console.error('Could not reset camera setting:', error);
                        data = { ...data, cameraGatekeeper: { ...data.cameraGatekeeper, enabled: false } };
                    }
                }
                setSettings(normalizeCharacterSettings(data));
                if (data.backgroundColor) setBackgroundColor(data.backgroundColor);
            });
    }, []);

    const selectedCharacterId = settings?.currentCharacter;
    const settingsLoaded = Boolean(settings);
    useEffect(() => {
        if (!settingsLoaded || activeConversationId || initConversationRef.current) return;
        initConversationRef.current = true;

        const controller = new AbortController();

        apiFetch('/api/conversations', { headers: authHeaders(), signal: controller.signal })
            .then(r => r.json())
            .then(({ conversations }) => {
                if (controller.signal.aborted) return;
                const reusable = conversations?.find(c => c.title === 'New conversation');
                if (reusable) {
                    setActiveConversationId(reusable.id);
                    return;
                }

                return apiFetch('/api/conversations', {
                    method: 'POST',
                    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
                    body: JSON.stringify({ characterId: selectedCharacterId || null }),
                    signal: controller.signal,
                })
                    .then(r => r.json())
                    .then(c => { if (!controller.signal.aborted) setActiveConversationId(c.id); });
            }).catch(error => { if (!controller.signal.aborted) console.error('Could not open conversation:', error); });
        return () => { controller.abort(); initConversationRef.current = false; };
    }, [activeConversationId, settingsLoaded, selectedCharacterId]);

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
    const stockAlerts = useStockAlerts({ characterId: settings?.currentCharacter,
        onNotify: message => setToast({ message: `📈 ${message}` }),
        isBusy: () => Boolean(chatBoxRef.current?.isBusy?.() || replyInProgressRef.current || isPlaying() || Date.now() - lastActivityRef.current < 15000),
        onSpeak: async text => {
            const replyId = ++voiceReplyRef.current;
            const clean = cleanTextForVoice(text);
            try {
                if (settings?.ttsBackend === 'pocket-tts' && settings?.pocketTts?.streaming) {
                    resetPlaybackSchedule({ onAnalyser: startLipSync });
                    getVoiceSentences(clean, { done: true }).sentences.forEach(enqueueSentence);
                    await waitForPlaybackToFinish();
                } else await playVoice(clean, { voice: settings?.voice || 'af_bella', onAnalyser: startLipSync });
            }
            finally { if (replyId === voiceReplyRef.current) stopLipSync(); }
        },
    });
    useReminderStream((event) => {
        if (event.type?.startsWith('stock_alert')) { stockAlerts.receive(event);setStockUpdate(value => value + 1);return; }
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
    }, { onConnected: stockAlerts.refresh });

    async function toggleCameraGatekeeper() {
        if (cameraStarting) return;
        const next = !liveCamera.active;
        if (next) setCameraStarting(true);
        else liveCamera.stop();

        try {
            // The server must be enabled before the first frame is sent.
            if (next) {
                const started = await liveCamera.start();
                if (!started) return;
            }
            const response = await apiFetch('/api/settings', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({ cameraGatekeeper: { enabled: next } }),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            setSettings(normalizeCharacterSettings(await response.json()));
        } catch (err) {
            if (next) liveCamera.stop();
            console.error('Failed to save camera gatekeeper setting:', err);
        } finally {
            setCameraStarting(false);
        }
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

    function handleReplyChunk(rawTextSoFar, { done, interrupted = false }) {
        lastActivityRef.current = Date.now();

        if (interrupted) {
            if (replyInProgressRef.current) {
                const replyId = voiceReplyRef.current;
                const finish = () => { if (replyId === voiceReplyRef.current) stopLipSync(); };
                waitForPlaybackToFinish().then(finish, finish);
            }
            spokenPointerRef.current = 0;
            replyInProgressRef.current = false;
            tagsHandledRef.current = false;
            return;
        }

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
                voiceReplyRef.current++;
                resetPlaybackSchedule({
                    onAnalyser: (analyser) => startLipSync(analyser),
                    onError: error => setToast({ message: `Voice playback failed: ${error.message}` }),
                });
            }

            const { sentences, nextOffset } = getVoiceSentences(rawTextSoFar, {
                start: spokenPointerRef.current, done,
            });
            sentences.forEach(enqueueSentence);
            spokenPointerRef.current = nextOffset;

            if (done) {
                const replyId = voiceReplyRef.current;
                const finishLipSync = () => {
                    if (replyId === voiceReplyRef.current) stopLipSync();
                };
                waitForPlaybackToFinish().then(finishLipSync, finishLipSync);

                spokenPointerRef.current = 0;
                replyInProgressRef.current = false;
            }
        } else if (done) {
            const replyId = ++voiceReplyRef.current;
            const cleanText = cleanTextForVoice(rawTextSoFar);
            playVoice(cleanText, {
                voice: settings?.voice || 'af_bella',
                onAnalyser: (analyser) => startLipSync(analyser),
            }).then(() => {
                if (replyId === voiceReplyRef.current) stopLipSync();
            }).catch((err) => {
                if (replyId !== voiceReplyRef.current || err.name === 'AbortError') return;
                setToast({ message: `Voice playback failed: ${err.message}` });
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
            } else if (event.window === 'outfits' && event.action === 'change') {
                apiJson(`/api/characters/${encodeURIComponent(event.characterId)}/outfits`)
                    .then(({ character }) => handleCharacterChange(character))
                    .catch(error => setToast({ message: `Could not refresh outfit: ${error.message}` }));
            }
        }
    }

    function handleConversationUpdated(newTitle) {
        setActiveConversationTitle(newTitle);
    }

    function handleSettingsChange(updated) {
        if (updated.backgroundColor) setBackgroundColor(updated.backgroundColor);
        if (settings?.currentCharacter !== updated.currentCharacter) {
            initConversationRef.current = false;
            setActiveConversationId(null);
            setActiveConversationTitle(null);
        }
        setSettings(normalizeCharacterSettings(updated));
    }

    function handleCharacterChange(character) {
        setSettings(current => applyCharacterUpdate(current, character));
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
                    character={settings?.character}
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
                                characterId={settings?.currentCharacter}
                                onSelect={handleSelectConversation}
                                onNew={(id) => {
                                    setActiveConversationId(id);
                                    setActiveConversationTitle(null);
                                }}
                            />
                            <OverflowIconBar
                                storageKey="header-icons"
                                items={[
                                    {
                                        id: 'screen',
                                        title: 'Screen',
                                        content: <HeaderToggle icon="🖥️" label="Screen" active={screenSessionActive}
                                            onClick={screenSessionActive ? stopScreenSession : startScreenSession} />,
                                        menuContent: <HeaderToggle icon="🖥️" label="Screen" active={screenSessionActive} inMenu
                                            onClick={screenSessionActive ? stopScreenSession : startScreenSession} />,
                                    },
                                    {
                                        id: 'camera',
                                        title: 'Camera',
                                        content: <HeaderToggle icon="📷" label="Camera" active={liveCamera.active}
                                            disabled={!settings || cameraStarting} onClick={toggleCameraGatekeeper} />,
                                        menuContent: <HeaderToggle icon="📷" label="Camera" active={liveCamera.active} inMenu
                                            disabled={!settings || cameraStarting} onClick={toggleCameraGatekeeper} />,
                                    },
                                    {
                                        id: 'anki',
                                        title: 'Review',
                                        content: <HeaderToggle icon="📇" label="Review" active={ankiWindowOpen}
                                            onClick={() => setAnkiWindowOpen(o => !o)} />,
                                        menuContent: <HeaderToggle icon="📇" label="Review" active={ankiWindowOpen} inMenu
                                            onClick={() => setAnkiWindowOpen(o => !o)} />,
                                    },
                                    { id: 'tools', title: 'Tools', content: <ToolsMenu />, menuContent: <ToolsMenu embedded /> },
                                    {
                                        id: 'companion', title: 'Companion', closeOnSelect: true,
                                        content: <HeaderToggle icon="👕" label="Companion" active={showCompanion}
                                            onClick={() => setShowCompanion(open => !open)} />,
                                        menuContent: <HeaderToggle icon="👕" label="Companion" active={showCompanion} inMenu
                                            onClick={() => setShowCompanion(open => !open)} />,
                                    },
                                    {
                                        id: 'stocks', title: 'Stocks', closeOnSelect: true,
                                        content: <HeaderToggle icon="📈" label="Stocks" active={showStocks}
                                            onClick={() => setShowStocks(open => !open)} />,
                                        menuContent: <HeaderToggle icon="📈" label="Stocks" active={showStocks} inMenu
                                            onClick={() => setShowStocks(open => !open)} />,
                                    },
                                    {
                                        id: 'settings', title: 'Settings', closeOnSelect: true,
                                        content: <HeaderToggle icon="⚙" label="Settings" active={showSettings}
                                            onClick={() => setShowSettings(open => !open)} />,
                                        menuContent: <HeaderToggle icon="⚙" label="Settings" active={showSettings} inMenu
                                            onClick={() => setShowSettings(open => !open)} />,
                                    },
                                ]}
                            />
                        </div>
                    }
                >
                    <ChatBox
                        key={activeConversationId}
                        ref={chatBoxRef}
                        conversationId={activeConversationId}
                        settings={settings}
                        onReplyChunk={handleReplyChunk}
                        onUiEvents={handleUiEvents}
                        onConversationUpdated={handleConversationUpdated}
                        onUserActivity={() => {
                            lastActivityRef.current = Date.now();
                            // Resume in the user gesture, before waiting for the LLM.
                            prepareVoice().catch(error => setToast({ message: `Voice playback failed: ${error.message}` }));
                        }}
                        screenSessionActive={screenSessionActive}
                        onGrabScreenFrame={grabScreenFrame}
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

                {showSettings && (
                    <DraggableWindow title="Settings" initialX={window.innerWidth - 380} initialY={60} width={340}
                        onClose={() => setShowSettings(false)}>
                        <SettingsPanel key={settings?.currentCharacter} onSettingsChange={handleSettingsChange} onOpenCompanion={() => setShowCompanion(true)} />
                    </DraggableWindow>
                )}

                {showCompanion && <CompanionWindow character={settings?.character}
                    onSettingsChange={handleSettingsChange} onCharacterChange={handleCharacterChange} onClose={() => setShowCompanion(false)} />}

                {showStocks && <StocksWindow updateSignal={stockUpdate} onClose={() => setShowStocks(false)}
                    onPrepareVoice={() => prepareVoice().catch(error => setToast({ message: `Voice playback failed: ${error.message}` }))}
                    onAlertsRead={stockAlerts.refresh} onConfigChange={config => {
                        setSettings(current => current ? { ...current, stockMonitor: config } : current);
                        stockAlerts.refresh();
                    }} />}

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
