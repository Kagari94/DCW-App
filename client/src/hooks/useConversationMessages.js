import { useEffect, useState } from 'react';
import { apiJson } from '../apiConfig';
import { cleanTextForDisplay } from '../utils/textParsing';

export default function useConversationMessages(conversationId) {
    const [state, setState] = useState({ id: null, messages: [], error: null });
    useEffect(() => {
        if (!conversationId) return;
        const controller = new AbortController();
        apiJson(`/api/conversations/${conversationId}`, { signal: controller.signal })
            .then(data => {
                if (controller.signal.aborted) return;
                const messages = data.messages
                    .filter(m => m.role !== 'system' && m.role !== 'tool' && m.content !== null)
                    .map(m => ({
                        sender: m.role === 'user' ? 'You' : 'AI',
                        text: m.role === 'assistant' ? cleanTextForDisplay(m.content) : m.content,
                        attachments: m.attachments || [], generatedFiles: m.generatedFiles || [],
                    }));
                const pendingFrame = data.pendingTurn?.toolCallId ? { id: data.pendingTurn.toolCallId } : null;
                setState({ id: conversationId, messages, error: null, pendingFrame });
            })
            .catch(error => {
                if (!controller.signal.aborted) setState({ id: conversationId, messages: [], error: error.message });
            });
        return () => controller.abort();
    }, [conversationId]);

    function setMessages(update) {
        setState(previous => previous.id === conversationId
            ? { ...previous, messages: update(previous.messages) } : previous);
    }
    const current = state.id === conversationId;
    return {
        messages: current ? state.messages : [], setMessages,
        pendingFrame: current ? state.pendingFrame : null,
        loadError: current ? state.error : null,
        loadingConversation: Boolean(conversationId) && !current,
    };
}
