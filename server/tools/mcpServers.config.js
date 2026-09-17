// ============================================
// server/tools/mcpServers.config.js — external MCP servers to connect to
// ============================================
// 'command' entries are spawned as local subprocesses (stdio transport) —
// most community MCP servers you'd `npx` are run this way, and so is the
// custom Anki server below.
// 'url' entries connect to a remote server (HTTP/SSE transport).
const path = require('path');

const mcpServers = [
    // Example — a local MCP server run as a subprocess:
    // { name: 'weather', command: 'npx', args: ['-y', '@some-org/weather-mcp-server'] },
    {
        name: 'blender',
        command: 'uvx',
        args: ['blender-mcp'],
    },
    {
        name: 'anki',
        command: 'node',
        args: [path.join(__dirname, '..', '..', 'anki-mcp-server', 'index.js')],
    },
];

module.exports = { mcpServers };
