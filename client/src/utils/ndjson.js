export async function* readNdjson(response) {
    if (!response.body) throw new Error('Response has no stream.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (const line of lines) if (line.trim()) yield JSON.parse(line);
            if (done) {
                if (buffer.trim()) yield JSON.parse(buffer);
                return;
            }
        }
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}
