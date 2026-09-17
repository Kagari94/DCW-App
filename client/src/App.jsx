import { useRef, useState, useEffect } from 'react';
import { authHeaders } from './utils/authToken';
import ChatBox from './components/ChatBox';
import CharacterCanvas from './components/CharacterCanvas';
import DraggableWindow from './components/DraggableWindow';
import SettingsPanel from './components/SettingsPanel';
import WeatherPanel from './components/WeatherPanel';
import ConversationList from './components/ConversationList';
import ToolsMenu from './components/ToolsMenu';
import LoginGate from './components/LoginGate';
import useVoice from './hooks/useVoice';
import useLipSync from './hooks/useLipSync';
import { extractTag, cleanTextForVoice, getSafeDisplayPrefix } from './utils/textParsing';
import './App.css';

function App() {
    const characterRef = useRef(null);
    const { playVoice, resetPlaybackSchedule, enqueueSentence, waitForPlaybackToFinish } = useVoice();
    const { startLipSync, stopLipSync } = useLipSync(characterRef);
    const [settings, setSettings] = useState(null);
    const [showSettings, setShowSettings] = useState(false);
    const [activeConversationId, setActiveConversationId] = useState(null);
    const [activeConversationTitle, setActiveConversationTitle] = useState(null);
    const [backgroundColor, setBackgroundColor] = useState('#1a1a1a');
    const [weatherPanel, setWeatherPanel] = useState(null);
    const initConversationRef = useRef(false);

    const tagsHandledRef = useRef(false);
    const spokenPointerRef = useRef(0);
    const replyInProgressRef = useRef(false);

    // Screen-capture session — lives here (not in ChatBox) since the toggle
    // button sits in the window header alongside ToolsMenu, outside
    // ChatBox's own render tree. The stream stays open across multiple
    // messages once started (see startScreenSession's comment) — ChatBox
    // just asks for a frame via grabScreenFrame() when it decides one is
    // needed, it never owns the capture itself.
    const [screenSessionActive, setScreenSessionActive] = useState(false);
    const screenStreamRef = useRef(null);
    const screenVideoRef = useRef(null);

    useEffect(() => {
        fetch(`http://${window.location.hostname}:3000/api/settings`, {
            headers: authHeaders(),
        })
            .then(r => r.json())
            .then((data) => {
                setSettings(data);
                if (data.backgroundColor) setBackgroundColor(data.backgroundColor);
            });
    }, []);

    useEffect(() => {
        if (activeConversationId || initConversationRef.current) return;
        initConversationRef.current = true;

        fetch(`http://${window.location.hostname}:3000/api/conversations`, {
            headers: authHeaders(),
        })
            .then(r => r.json())
            .then(({ conversations }) => {
                const reusable = conversations?.find(c => c.title === 'New conversation');
                if (reusable) {
                    setActiveConversationId(reusable.id);
                    return;
                }

                return fetch(`http://${window.location.hostname}:3000/api/conversations`, {
                    method: 'POST',
                    headers: authHeaders(),
                })
                    .then(r => r.json())
                    .then(c => setActiveConversationId(c.id));
            });
    }, []);

    // Stop sharing automatically whenever the active conversation changes,
    // or on unmount — a live screen-capture stream should never silently
    // outlive the conversation it was started under.
    useEffect(() => {
        return () => stopScreenSession();
    }, [activeConversationId]);

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

            // Fires if the person stops sharing via the browser's own native
            // indicator rather than our button — keeps our state honest
            // either way.
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

    // Grabs a frame from the already-open session stream — no permission
    // prompt, since the stream was authorized once at startScreenSession().
    // Returns null if no session is active.
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
            if (!event || event.window !== 'weather') continue;
            if (event.action === 'show') {
                setWeatherPanel(event.data || null);
            } else if (event.action === 'hide') {
                setWeatherPanel(null);
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

    return (
        <LoginGate>
            <div style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden', background: backgroundColor }}>
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
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
                            <ToolsMenu />
                        </div>
                    }
                >
                    <ChatBox
                        conversationId={activeConversationId}
                        settings={settings}
                        onReplyChunk={handleReplyChunk}
                        onUiEvents={handleUiEvents}
                        onConversationUpdated={handleConversationUpdated}
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
                                style={{
                                    background: 'none',
                                    border: '1px solid #555',
                                    borderRadius: 4,
                                    color: '#aaa',
                                    cursor: 'pointer',
                                    fontSize: 12,
                                    padding: '2px 8px',
                                }}
                            >
                                Close
                            </button>
                        }
                    >
                        <WeatherPanel data={weatherPanel} />
                    </DraggableWindow>
                )}

                <button
                    onClick={() => setShowSettings(s => !s)}
                    style={{
                        position: 'absolute', top: 12, right: 12, zIndex: 20,
                        background: 'rgba(20,20,20,0.85)', color: '#ddd',
                        border: '1px solid #444', borderRadius: 6,
                        padding: '6px 10px', cursor: 'pointer', fontSize: 13,
                    }}
                >
                    ⚙ Settings
                </button>

                {showSettings && (
                    <DraggableWindow title="Settings" initialX={window.innerWidth - 380} initialY={60} width={340}>
                        <SettingsPanel onSettingsChange={handleSettingsChange} />
                    </DraggableWindow>
                )}
            </div>
        </LoginGate>
    );
}

export default App;