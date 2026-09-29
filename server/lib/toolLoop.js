// A screen pause can occur halfway through a batch. Resume only unanswered calls.
function pendingToolCalls(messages) {
    const index = messages.findLastIndex(message => message.role === 'assistant');
    if (index < 0) return [];
    const answered = new Set(messages.slice(index + 1)
        .filter(message => message.role === 'tool').map(message => message.tool_call_id));
    return (messages[index].tool_calls || []).filter(call => !answered.has(call.id));
}

async function runToolLoop(messages, config, onContentDelta, { callModel, toolHandlers, maxIterations = 8 }) {
    const uiEvents = [];

    for (let i = 0; i < maxIterations; i++) {
        let toolCalls = pendingToolCalls(messages);
        if (toolCalls.length === 0) {
            const message = await callModel(messages, config, onContentDelta);
            toolCalls = message.tool_calls;
            if (!toolCalls?.length) return { message, uiEvents };
            messages.push(message);
        }

        for (const call of toolCalls) {
            const handler = toolHandlers[call.function.name];
            let result;

            if (!handler) {
                result = { error: `Unknown tool: ${call.function.name}` };
            } else {
                try {
                    const args = JSON.parse(call.function.arguments || '{}');
                    result = await handler(args, config);
                } catch (err) {
                    console.error(`Tool "${call.function.name}" failed:`, err);
                    result = { error: err.message };
                }
            }

            if (result && result.ui) uiEvents.push(result.ui);

            if (result && result.__viewImage) {
                const img = result.__viewImage;
                messages.push({
                    role: 'tool',
                    tool_call_id: call.id,
                    content: JSON.stringify({ ok: true, note: `Image "${img.filename}" loaded — see below.` }),
                });
                messages.push({
                    role: 'user',
                    content: `[Viewing image: ${img.filename}]`,
                    attachments: [{
                        path: img.absolutePath,
                        filename: img.filename,
                        storedFilename: img.filename,
                        size: img.size,
                    }],
                });
                continue;
            }

            if (result && result.__needScreenFrame) {
                return { needsScreenFrame: { toolCallId: call.id }, uiEvents };
            }

            messages.push({
                role: 'tool',
                tool_call_id: call.id,
                content: JSON.stringify(result),
            });
        }
    }

    throw new Error(`Tool call loop exceeded ${maxIterations} iterations without a final reply`);
}

module.exports = { runToolLoop, pendingToolCalls };
