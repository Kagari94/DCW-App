// ============================================
// server/lib/mcpResult.js — shared MCP tool-result unwrapping
// ============================================
// MCP-sourced tool handlers (see tools/mcpClients.js) return the MCP
// envelope shape ({ content: [{ type: 'text', text: '...' }] }) rather
// than a plain object — anything that calls an MCP handler directly
// (outside the normal chat tool-loop, which just passes this straight
// through to the model) needs to unwrap it first. Used by the Anki
// heartbeat check and the Anki review REST routes; any future
// direct-from-server MCP call should use this too rather than
// reimplementing it.
function unwrapMcpResult(result) {
    if (result && typeof result === 'object' && Array.isArray(result.content)) {
        const text = result.content[0]?.text;
        if (typeof text === 'string') {
            try {
                return JSON.parse(text);
            } catch {
                return null;
            }
        }
    }
    return null;
}

module.exports = { unwrapMcpResult };