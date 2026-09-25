import { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { authHeaders } from '../utils/authToken';
import { apiFetch } from '../apiConfig';
import { cleanTextForDisplay, getSafeDisplayPrefix } from '../utils/textParsing';
import useVoiceInput from '../hooks/useVoiceInput';

const markdownComponents = {
    h1: (props) => <h4 className="md-heading md-heading-1" {...props} />,
    h2: (props) => <h4 className="md-heading md-heading-2" {...props} />,
    h3: (props) => <h4 className="md-heading md-heading-3" {...props} />,
    p: (props) => <p className="md-paragraph" {...props} />,
    ul: (props) => <ul className="md-list" {...props} />,
    ol: (props) => <ol className="md-list" {...props} />,
    li: (props) => <li className="md-list-item" {...props} />,
    strong: (props) => <strong className="md-strong" {...props} />,
    code: (props) => <code className="md-code" {...props} />,
    a: (props) => <a className="md-link" target="_blank" rel="noopener noreferrer" {...props} />,
};

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

function getExtension(filename) {
    const dot = filename.lastIndexOf('.');
    return dot === -1 ? '' : filename.slice(dot).toLowerCase();
}

function GeneratedFileChip({ conversationId, file }) {
    async function handleDownload() {
        try {
            const res = await apiFetch(
                `/api/conversations/${conversationId}/documents/${file.storedFilename}`,
                { headers: authHeaders() },
            );
            if (!res.ok) throw new Error('Download failed');
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = file.filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error('Document download failed:', err);
            alert(`⚠️ Could not download ${file.filename}`);
        }
    }

    const icon = file.format === 'docx' ? '📝' : '📄';
    return (
        <button type="button" className="attachment-chip generated-file-chip" onClick={handleDownload}>
            {icon} {file.filename} ⬇
        </button>
    );
}

function AttachmentPreview({ conversationId, attachment }) {
    const [blobUrl, setBlobUrl] = useState(null);
    const isImage = IMAGE_EXTENSIONS.has(getExtension(attachment.filename));

    useEffect(() => {
        if (!isImage) return;
        let objectUrl;
        let cancelled = false;

        apiFetch(`/api/conversations/${conversationId}/attachments/${attachment.storedFilename}`, {
            headers: authHeaders(),
        })
            .then(res => res.blob())
            .then(blob => {
                if (cancelled) return;
                objectUrl = URL.createObjectURL(blob);
                setBlobUrl(objectUrl);
            })
            .catch(err => console.error('Failed to load attachment preview:', err));

        return () => {
            cancelled = true;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [conversationId, attachment.storedFilename, isImage]);

    if (isImage) {
        return blobUrl
            ? <img src={blobUrl} alt={attachment.filename} className="attachment-thumb" />
            : <div className="attachment-chip">🖼️ {attachment.filename}</div>;
    }

    return <div className="attachment-chip">📄 {attachment.filename}</div>;
}

// Reads one NDJSON response stream and dispatches each event as it arrives.
// Returns/stops as soon as the stream reaches a terminal event ('done',
// 'need_screen_frame', or 'error') — 'need_screen_frame' isn't actually
// terminal for the overall exchange, just for THIS stream: the caller's
// onNeedScreenFrame is expected to capture a frame, hit /chat/continue,
// and call this function again on the new response to keep going. That
// recursion lives in sendMessage, not here — this function only knows how
// to drain one stream.
async function consumeNdjsonStream(res, { onDelta, onDone, onNeedScreenFrame }) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
            if (!line.trim()) continue;
            const event = JSON.parse(line);

            if (event.type === 'delta') {
                onDelta(event.content);
            } else if (event.type === 'done') {
                onDone(event);
                return;
            } else if (event.type === 'need_screen_frame') {
                await onNeedScreenFrame(event);
                return;
            } else if (event.type === 'error') {
                throw new Error(event.error);
            }
        }
    }

    throw new Error('Stream ended without a final response.');
}

const ChatBox = forwardRef(function ChatBox({
    conversationId, settings, onReplyChunk, onUiEvents, onConversationUpdated,
    screenSessionActive, onGrabScreenFrame, onStopScreenSession, onUserActivity }, ref) {
    const [messages, setMessages] = useState([]);
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [pendingAttachments, setPendingAttachments] = useState([]);
    const [uploading, setUploading] = useState(false);
    const chatLogRef = useRef(null);
    const fileInputRef = useRef(null);

    const handleVoiceCommandRef = useRef();
    handleVoiceCommandRef.current = function handleVoiceCommand(text, source) {
        if (source === 'wake-word') {
            sendMessage(text);
        } else {
            setInput(prev => (prev ? `${prev} ${text}` : text));
        }
    };
    const stableOnCommand = useCallback((text, source) => {
        handleVoiceCommandRef.current(text, source);
    }, []);

    const {
        isListening: isVoiceListening,
        isTranscribing: isVoiceTranscribing,
        awaitingCommand,
        startPushToTalk,
        stopPushToTalk,
        pushToTalkAvailable,
    } = useVoiceInput(settings, stableOnCommand);

    const voiceConfig = settings?.voiceInput;
    const wakeWordModeActive = Boolean(voiceConfig?.enabled && voiceConfig.mode === 'wake-word');

    useEffect(() => {
        if (conversationId) loadConversation();
    }, [conversationId]);

    useEffect(() => {
        if (chatLogRef.current) {
            chatLogRef.current.scrollTop = chatLogRef.current.scrollHeight;
        }
    }, [messages]);

    async function loadConversation() {
        const res = await apiFetch(`/api/conversations/${conversationId}`, { headers: authHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        const displayMessages = data.messages
            .filter(m => m.role !== 'system' && m.role !== 'tool' && m.content !== null)
            .map(m => ({
                sender: m.role === 'user' ? 'You' : 'AI',
                text: m.role === 'assistant' ? cleanTextForDisplay(m.content) : m.content,
                attachments: m.attachments || [],
                generatedFiles: m.generatedFiles || [],
            }));
        setMessages(displayMessages);
    }

    async function uploadAttachment(file) {
        if (!file || !conversationId) return null;

        const formData = new FormData();
        formData.append('file', file);

        const res = await apiFetch(
            `/api/conversations/${conversationId}/attachments`,
            {
                method: 'POST',
                headers: authHeaders(),
                body: formData,
            }
        );

        const data = await res.json();

        if (!res.ok) {
            throw new Error(data.error || 'Upload failed');
        }

        return data;
    }

    async function handleFileSelect(e) {
        const files = Array.from(e.target.files || []);
        e.target.value = '';
        if (files.length === 0 || !conversationId) return;

        setUploading(true);
        try {
            for (const file of files) {
                const data = await uploadAttachment(file);
                setPendingAttachments(prev => [...prev, data]);
            }
        } catch (err) {
            console.error('Attachment upload error:', err);
            alert(`⚠️ Attachment upload failed: ${err.message}`);
        } finally {
            setUploading(false);
        }
    }

    function removePendingAttachment(storedFilename) {
        setPendingAttachments(prev => prev.filter(a => a.storedFilename !== storedFilename));
    }

    function updateLastAiMessage(displayText) {
        setMessages(prev => {
            const next = [...prev];
            next[next.length - 1] = { sender: 'AI', text: displayText };
            return next;
        });
    }

    function finalizeLastAiMessage(displayText, generatedFiles) {
        setMessages(prev => {
            const next = [...prev];
            next[next.length - 1] = { sender: 'AI', text: displayText, generatedFiles: generatedFiles || [] };
            return next;
        });
    }

    // `silent`: used by the Anki heartbeat's proactive nudge (see App.jsx's
    // triggerSystemNudge via the imperative handle below) — the prompt
    // still gets sent to the backend as a real user-role turn (the model
    // needs something to respond to), it's just not rendered as a "You:"
    // bubble live. NOTE: if this conversation is reopened later,
    // loadConversation has no way to know that turn was synthetic, so it
    // WILL show up as a "You:" line on reload — a known, accepted gap
    // rather than something silently hidden forever.
    async function sendMessage(overrideText, { silent = false } = {}) {
        const trimmed = (typeof overrideText === 'string' ? overrideText : input).trim();

        if ((!trimmed && pendingAttachments.length === 0) || loading || !conversationId) return;

        if (!silent && onUserActivity) onUserActivity();

        const attachmentsToSend = [...pendingAttachments];

        setMessages(prev => [
            ...prev,
            ...(silent ? [] : [{ sender: 'You', text: trimmed, attachments: attachmentsToSend }]),
            { sender: 'AI', text: '' },
        ]);

        setInput('');
        setPendingAttachments([]);
        setLoading(true);

        let rawBuffer = '';
        let finalPayload = null;

        function onDelta(content) {
            rawBuffer += content;
            updateLastAiMessage(cleanTextForDisplay(getSafeDisplayPrefix(rawBuffer)));
            if (onReplyChunk) onReplyChunk(rawBuffer, { done: false });
        }

        function onDone(event) {
            finalPayload = event;
        }

        // The model decided (via the view_screen tool, from context — no
        // keyword matching anymore) that it needs to see the screen.
        // Capture a frame from the already-open session stream, upload it
        // through the normal attachments endpoint, then hit /chat/continue
        // to resume the SAME reply with that frame injected. Loops back
        // into consumeNdjsonStream, so a second/third view_screen call in
        // the same reply (unlikely, but possible) just repeats this.
        async function onNeedScreenFrame(event) {
            if (!onGrabScreenFrame) {
                throw new Error('Screen capture requested but not available.');
            }
            const frameFile = await onGrabScreenFrame();
            if (!frameFile) {
                throw new Error('Could not capture a screen frame — is sharing still active?');
            }
            const uploadedFrame = await uploadAttachment(frameFile);

            const continueRes = await apiFetch('/api/chat/continue', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({
                    conversationId,
                    toolCallId: event.toolCallId,
                    attachment: uploadedFrame,
                    screenSessionActive,
                }),
            });

            if (!continueRes.ok || !continueRes.body) {
                const data = await continueRes.json().catch(() => ({}));
                throw new Error(data.error || `Continue request failed (${continueRes.status})`);
            }

            await consumeNdjsonStream(continueRes, { onDelta, onDone, onNeedScreenFrame });
        }

        try {
            const res = await apiFetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...authHeaders() },
                body: JSON.stringify({
                    message: trimmed,
                    conversationId,
                    attachments: attachmentsToSend.length > 0 ? attachmentsToSend : undefined,
                    screenSessionActive,
                }),
            });

            if (!res.ok || !res.body) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || `Request failed (${res.status})`);
            }

            await consumeNdjsonStream(res, { onDelta, onDone, onNeedScreenFrame });

            if (!finalPayload) throw new Error('Stream ended without a final response.');

            finalizeLastAiMessage(cleanTextForDisplay(finalPayload.reply), finalPayload.generatedFiles);
            if (onReplyChunk) onReplyChunk(finalPayload.reply, { done: true });
            if (onUiEvents && Array.isArray(finalPayload.uiEvents) && finalPayload.uiEvents.length > 0) {
                onUiEvents(finalPayload.uiEvents);
            }
            if (onConversationUpdated) onConversationUpdated(finalPayload.title);

        } catch (err) {
            console.error('Chat error:', err);
            updateLastAiMessage('⚠️ Error connecting to AI. Please check settings and server status.');
        } finally {
            setLoading(false);
        }
    }

    useImperativeHandle(ref, () => ({
        // Sends a hidden system-style prompt for the AI to react to,
        // without a "You:" bubble appearing live. See the Anki heartbeat
        // note above sendMessage for the one known caveat (reappears on
        // reload).
        triggerSystemNudge: (text) => sendMessage(text, { silent: true }),
    }));

    function handleKeyPress(e) {
        if (e.key === 'Enter') sendMessage();
    }

    const voiceStatusClass = awaitingCommand
        ? 'voice-status-active'
        : isVoiceListening
            ? 'voice-status-listening'
            : 'voice-status-off';

    return (
        <div className="chat-container">
            <div className="chat-log" ref={chatLogRef}>
                {messages.map((msg, i) => (
                    <div key={i} className="chat-message">
                        <strong className="chat-message-sender">{msg.sender}:</strong>
                        <div className="chat-message-content">
                            <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>
                                {msg.text}
                            </ReactMarkdown>
                        </div>
                        {msg.attachments && msg.attachments.length > 0 && (
                            <div className="attachment-row">
                                {msg.attachments.map((att, j) => (
                                    <AttachmentPreview key={j} conversationId={conversationId} attachment={att} />
                                ))}
                            </div>
                        )}
                        {msg.generatedFiles && msg.generatedFiles.length > 0 && (
                            <div className="attachment-row">
                                {msg.generatedFiles.map((file, j) => (
                                    <GeneratedFileChip key={j} conversationId={conversationId} file={file} />
                                ))}
                            </div>
                        )}
                    </div>
                ))}

                {loading && (
                    <div className="chat-loading">
                        ⚡ Thinking<span className="dots"><span>.</span><span>.</span><span>.</span></span>
                    </div>
                )}
            </div>

            {pendingAttachments.length > 0 && (
                <div className="pending-attachments-row">
                    {pendingAttachments.map(att => (
                        <div key={att.storedFilename} className="attachment-chip pending">
                            📎 {att.filename}
                            <button
                                type="button"
                                className="remove-attachment-btn"
                                onClick={() => removePendingAttachment(att.storedFilename)}
                            >
                                ✕
                            </button>
                        </div>
                    ))}
                </div>
            )}

            {wakeWordModeActive && (
                <div className="voice-status-row">
                    <span className={voiceStatusClass}>
                        {awaitingCommand
                            ? '🎤 yes? go ahead'
                            : isVoiceListening
                                ? '🎤 listening for wake word'
                                : '🎤 mic unavailable'}
                    </span>
                </div>
            )}

            <div className="chat-input-row">
                <input
                    type="file"
                    ref={fileInputRef}
                    className="hidden-input"
                    multiple
                    accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.docx,.txt,.md,.js,.jsx,.ts,.tsx,.py,.json,.css,.html,.csv,.log"
                    onChange={handleFileSelect}
                />
                <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={loading || !conversationId || uploading}
                    title="Attach files"
                >
                    📎
                </button>

                {pushToTalkAvailable && (
                    <button
                        type="button"
                        onMouseDown={startPushToTalk}
                        onMouseUp={stopPushToTalk}
                        onMouseLeave={() => isVoiceListening && stopPushToTalk()}
                        onTouchStart={(e) => { e.preventDefault(); startPushToTalk(); }}
                        onTouchEnd={(e) => { e.preventDefault(); stopPushToTalk(); }}
                        disabled={loading || !conversationId || isVoiceTranscribing}
                        title="Hold to record"
                        className={isVoiceListening ? 'mic-active' : ''}
                    >
                        {isVoiceTranscribing ? '…' : '🎤'}
                    </button>
                )}

                <input
                    type="text"
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyPress={handleKeyPress}
                    placeholder={!conversationId ? 'Loading...' : loading ? '...' : 'Type a message...'}
                    disabled={loading || !conversationId}
                />
                <button onClick={() => sendMessage()} disabled={loading || !conversationId || uploading}>Send</button>
            </div>
        </div>
    );
});

export default ChatBox;