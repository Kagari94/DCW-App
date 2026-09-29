import { useEffect, useRef, useState } from 'react';
import { apiFetch, apiJson, requireOk } from '../apiConfig';
import { cleanTextForDisplay, getSafeDisplayPrefix } from '../utils/textParsing';
import { readNdjson } from '../utils/ndjson';
import useConversationMessages from './useConversationMessages';
import useLatestCallback from './useLatestCallback';

async function consumeNdjsonStream(res, { onDelta, onDone, onNeedScreenFrame }) {
    for await (const event of readNdjson(res)) {
        if (event.type === 'delta') onDelta(event.content);
        else if (event.type === 'done') { onDone(event); return; }
        else if (event.type === 'need_screen_frame') { await onNeedScreenFrame(event); return; }
        else if (event.type === 'error') throw new Error(event.error);
    }
    throw new Error('Stream ended without a final response.');
}

export default function useChatSession({ conversationId, onReplyChunk, onUiEvents,
    onConversationUpdated, screenSessionActive, onGrabScreenFrame, onUserActivity }) {
    const { messages, setMessages, loadError, loadingConversation, pendingFrame: loadedFrame } = useConversationMessages(conversationId);
    const [pendingFrame, setPendingFrame] = useState(undefined);
    const screenFrame = pendingFrame === undefined ? loadedFrame : pendingFrame;
    const [input, setInput] = useState('');
    const [loading, setLoading] = useState(false);
    const [pendingAttachments, setPendingAttachments] = useState([]);
    const [uploading, setUploading] = useState(false);
    const lifecycleRef = useRef(null);
    const inFlightRef = useRef(false);
    useEffect(() => {
        const controller = new AbortController();
        lifecycleRef.current = controller;
        return () => controller.abort();
    }, [conversationId]);

    async function uploadAttachment(file) {
        if (!file || !conversationId) return null;

        const formData = new FormData();
        formData.append('file', file);

        return apiJson(`/api/conversations/${conversationId}/attachments`, {
            method: 'POST', signal: lifecycleRef.current.signal, body: formData,
        });
    }

    async function handleFileSelect(e) {
        const files = Array.from(e.target.files || []);
        e.target.value = '';
        if (files.length === 0 || !conversationId) return;

        setUploading(true);
        try {
            for (const file of files) {
                const data = await uploadAttachment(file);
                if (!lifecycleRef.current.signal.aborted) setPendingAttachments(prev => [...prev, data]);
            }
        } catch (err) {
            if (lifecycleRef.current.signal.aborted) return;
            console.error('Attachment upload error:', err);
            alert(`⚠️ Attachment upload failed: ${err.message}`);
        } finally {
            setUploading(false);
        }
    }

    function removePendingAttachment(storedFilename) {
        setPendingAttachments(prev => prev.filter(a => a.storedFilename !== storedFilename));
    }

    function updateLastAiMessage(text, generatedFiles = []) {
        if (lifecycleRef.current.signal.aborted) return;
        setMessages(previous => [
            ...previous.slice(0, -1), { sender: 'AI', text, generatedFiles },
        ]);
    }

    // Silent nudges are hidden live, but remain user turns in saved history.
    const sendMessage = useLatestCallback(async (overrideText, { silent = false, resume = false } = {}) => {
        const trimmed = (typeof overrideText === 'string' ? overrideText : input).trim();

        if (inFlightRef.current || loadingConversation || loadError || !conversationId) return;
        if (resume ? !screenFrame : screenFrame || (!trimmed && pendingAttachments.length === 0)) return;

        inFlightRef.current = true;
        const signal = lifecycleRef.current.signal;
        if (!silent && onUserActivity) onUserActivity();

        const attachmentsToSend = [...pendingAttachments];

        setMessages(prev => [
            ...prev,
            ...(silent || resume ? [] : [{ sender: 'You', text: trimmed, attachments: attachmentsToSend }]),
            { sender: 'AI', text: '' },
        ]);

        setInput('');
        setPendingAttachments([]);
        setLoading(true);

        let rawBuffer = '';
        let finalPayload = null;

        function onDelta(content) {
            signal.throwIfAborted();
            rawBuffer += content;
            updateLastAiMessage(cleanTextForDisplay(getSafeDisplayPrefix(rawBuffer)));
            if (onReplyChunk) onReplyChunk(rawBuffer, { done: false });
        }

        function onDone(event) {
            finalPayload = event;
        }

        // Upload a frame and resume the same streamed reply.
        async function onNeedScreenFrame(event) {
            setPendingFrame({ id: event.toolCallId });
            if (!onGrabScreenFrame) {
                throw new Error('Screen capture requested but not available.');
            }
            const frameFile = await onGrabScreenFrame();
            if (!frameFile) {
                throw new Error('Could not capture a screen frame — is sharing still active?');
            }
            signal.throwIfAborted();
            const uploadedFrame = await uploadAttachment(frameFile);

            const continueRes = await apiFetch('/api/chat/continue', {
                method: 'POST',
                signal: lifecycleRef.current.signal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    conversationId,
                    toolCallId: event.toolCallId,
                    attachment: uploadedFrame,
                    screenSessionActive,
                }),
            });

            await requireOk(continueRes);
            await consumeNdjsonStream(continueRes, { onDelta, onDone, onNeedScreenFrame });
        }

        try {
            if (resume) {
                await onNeedScreenFrame({ toolCallId: screenFrame.id });
            } else {
                const res = await apiFetch('/api/chat', {
                    method: 'POST',
                    signal: lifecycleRef.current.signal,
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        message: trimmed || '[Attached files]',
                        conversationId,
                        attachments: attachmentsToSend.length > 0 ? attachmentsToSend : undefined,
                        screenSessionActive,
                    }),
                });

                await requireOk(res);
                await consumeNdjsonStream(res, { onDelta, onDone, onNeedScreenFrame });
            }

            signal.throwIfAborted();
            if (!finalPayload) throw new Error('Stream ended without a final response.');

            setPendingFrame(null);
            updateLastAiMessage(cleanTextForDisplay(finalPayload.reply), finalPayload.generatedFiles);
            if (onReplyChunk) onReplyChunk(finalPayload.reply, { done: true });
            if (onUiEvents && Array.isArray(finalPayload.uiEvents) && finalPayload.uiEvents.length > 0) {
                onUiEvents(finalPayload.uiEvents);
            }
            if (onConversationUpdated) onConversationUpdated(finalPayload.title);

        } catch (err) {
            if (!signal.aborted) updateLastAiMessage(`Error: ${err.message}`);
        } finally {
            inFlightRef.current = false;
            if (!signal.aborted) setLoading(false);
        }
    });

    return { messages, input, setInput, loading, pendingAttachments, uploading,
        sendMessage, handleFileSelect, removePendingAttachment, loadError, loadingConversation, screenFrame,
        retryScreenFrame: () => sendMessage('', { resume: true }) };
}
