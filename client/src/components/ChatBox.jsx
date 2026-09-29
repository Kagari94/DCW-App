import { useState, useRef, useEffect, forwardRef, useImperativeHandle } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { authHeaders } from '../utils/authToken';
import { apiFetch } from '../apiConfig';
import useChatSession from '../hooks/useChatSession';
import useLatestCallback from '../hooks/useLatestCallback';
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

const ChatBox = forwardRef(function ChatBox({
    conversationId, settings, onReplyChunk, onUiEvents, onConversationUpdated,
    screenSessionActive, onGrabScreenFrame, onUserActivity }, ref) {
    const { messages, input, setInput, loading, pendingAttachments, uploading, sendMessage,
        handleFileSelect, removePendingAttachment, loadError, loadingConversation, screenFrame, retryScreenFrame } = useChatSession({
        conversationId, onReplyChunk, onUiEvents, onConversationUpdated,
        screenSessionActive, onGrabScreenFrame, onUserActivity,
    });
    const chatLogRef = useRef(null);
    const fileInputRef = useRef(null);
    const handleVoiceCommand = useLatestCallback((text, source) => {
        if (source === 'wake-word') sendMessage(text);
        else setInput(previous => previous ? `${previous} ${text}` : text);
    });
    const { isListening: isVoiceListening, isTranscribing: isVoiceTranscribing, awaitingCommand,
        startPushToTalk, stopPushToTalk, pushToTalkAvailable } = useVoiceInput(settings, handleVoiceCommand);
    const voiceConfig = settings?.voiceInput;
    const wakeWordModeActive = Boolean(voiceConfig?.enabled && voiceConfig.mode === 'wake-word');
    useEffect(() => {
        if (chatLogRef.current) chatLogRef.current.scrollTop = chatLogRef.current.scrollHeight;
    }, [messages]);

    useImperativeHandle(ref, () => ({
        // Persist nudges as user turns, but hide their live chat bubble.
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
            {loadError && <p role="alert">{loadError}</p>}
            {screenFrame && !loading && <button type="button" onClick={retryScreenFrame}>Retry screen capture</button>}
            {loadingConversation && <p>Loading conversation...</p>}
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
                    disabled={Boolean(screenFrame) || loadingConversation || Boolean(loadError) || loading || !conversationId || uploading}
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
                        disabled={Boolean(screenFrame) || loadingConversation || Boolean(loadError) || loading || !conversationId || isVoiceTranscribing}
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
                    disabled={Boolean(screenFrame) || loadingConversation || Boolean(loadError) || loading || !conversationId}
                />
                <button onClick={() => sendMessage()} disabled={Boolean(screenFrame) || loadingConversation || Boolean(loadError) || loading || !conversationId || uploading}>Send</button>
            </div>
        </div>
    );
});

export default ChatBox;