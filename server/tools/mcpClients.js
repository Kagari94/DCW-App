// ============================================
// server/tools/mcpClients.js — connects to configured external MCP servers
// ============================================
// NOTE: @modelcontextprotocol/sdk ships as an ESM-only package, but this
// file (like the rest of your server) is CommonJS. A top-level `require()`
// of an ESM-only package throws — so the SDK is loaded with a dynamic
// `import()` instead, which works fine from CommonJS since it just returns
// a promise regardless of which module system is calling it.
const { mcpServers } = require('./mcpServers.config.js');

// Connects to every server listed in mcpServers.config.js and returns
// { definitions, handlers, summaries }:
// - definitions/handlers are merged into tools/index.js the same as local tools
// - summaries is display-only metadata (name/description/source) for the
//   client's tools dropdown — kept separate from `definitions` so nothing
//   extra ever gets sent to the model in the `tools` field.
async function loadMcpTools() {
    const definitions = [];
    const handlers = {};
    const summaries = [];

    if (mcpServers.length === 0) {
        return { definitions, handlers, summaries };
    }

    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
    const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');

    for (const server of mcpServers) {
        try {
            const transport = server.url
                ? new SSEClientTransport(new URL(server.url), { requestInit: { headers: server.headers } })
                : new StdioClientTransport({ command: server.command, args: server.args ?? [] });

            const client = new Client({ name: 'companion-app', version: '1.0.0' });
            await client.connect(transport);

            const { tools } = await client.listTools();
            for (const tool of tools) {
                definitions.push({
                    type: 'function',
                    function: {
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.inputSchema,
                    },
                });
                // Handler just forwards the call to the MCP server and hands back its
                // result — the round-trip loop treats this identically to a local function
                handlers[tool.name] = (args) => client.callTool({ name: tool.name, arguments: args });
                summaries.push({ name: tool.name, description: tool.description, source: server.name });
            }

            console.log(`✅ Connected MCP server "${server.name}" — ${tools.length} tool(s)`);
        } catch (err) {
            console.error(`❌ Failed to connect MCP server "${server.name}":`, err.message);
            // Deliberately non-fatal — one broken/offline MCP server shouldn't take down
            // the rest of the tool registry (including your local Pi tools)
        }
    }

    return { definitions, handlers, summaries };
}

module.exports = { loadMcpTools };