// ============================================
// server/tools/index.js — merges local (Pi) tools with MCP-sourced tools
// ============================================
const music = require('./handlers/music.js');
const alarms = require('./handlers/alarms.js');
const weather = require('./handlers/weather.js');
const web = require('./handlers/web.js');
const documents = require('./handlers/documents.js');
const filesystem = require('./handlers/filesystem.js');
const { loadMcpTools } = require('./mcpClients.js');



// Add new local (non-MCP) tool files here — one line, that's the only edit point.
const localToolModules = [music, alarms, weather, web, documents, filesystem];
let toolDefinitions = [];
let toolHandlers = {};
let toolSummaries = [];

// Call this once at server startup, before app.listen — connects to every
// configured MCP server and merges their tools with the local Pi-calling
// ones into a single registry that toolCallLoop.js reads from.
async function initTools() {
    const localDefinitions = localToolModules.flatMap(m => m.definitions);
    const localHandlers = Object.assign({}, ...localToolModules.map(m => m.handlers));
    const localSummaries = localToolModules.flatMap(m =>
        m.definitions.map(d => ({
            name: d.function.name,
            description: d.function.description,
            source: m.source || 'Local (Raspi)',
        }))
    );

    const { definitions: mcpDefinitions, handlers: mcpHandlers, summaries: mcpSummaries } = await loadMcpTools();

    toolDefinitions = [...localDefinitions, ...mcpDefinitions];
    toolHandlers = { ...localHandlers, ...mcpHandlers };
    toolSummaries = [...localSummaries, ...mcpSummaries];

    const names = toolDefinitions.map(d => d.function.name).join(', ') || '(none)';
    console.log(`🔧 Tool registry ready: ${names}`);
}

function getToolDefinitions() {
    return toolDefinitions;
}

function getToolHandlers() {
    return toolHandlers;
}

// Display-only metadata for the client's tools dropdown — never sent to the model.
function getToolSummaries() {
    return toolSummaries;
}

module.exports = { initTools, getToolDefinitions, getToolHandlers, getToolSummaries };