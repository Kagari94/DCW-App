// ============================================
// server/lib/memory/llmClient.js — shared LLM caller for background memory jobs
// ============================================
const axios = require('axios');
const http = require('http');
const https = require('https');

// keepAlive:false deliberately. Node reuses idle sockets by default, and
// these background calls fire immediately after a streaming chat reply
// finishes — so they tend to grab the very socket that just carried the
// stream. If the LLM server has already decided to close that connection,
// the write lands on a dying socket and surfaces as "socket hang up"
// (ECONNRESET). A fresh connection per request avoids the race entirely.
// The extra handshake cost is irrelevant here: these run once per turn in
// the background, not in a hot loop.
const noKeepAliveHttp = new http.Agent({ keepAlive: false });
const noKeepAliveHttps = new https.Agent({ keepAlive: false });

// Connection was dropped rather than answered — the server was reachable
// and accepted the socket, then closed it. Worth one retry. Deliberately
// NOT retried: HTTP error statuses (a 400 would just fail identically
// twice) or timeouts (already waited the full timeout once).
function isConnectionReset(err) {
    return err.code === 'ECONNRESET' || err.message === 'socket hang up';
}

async function callLlm(messages, config, { timeout = 30000 } = {}) {
    const requestConfig = {
        headers: {
            'Content-Type': 'application/json',
            ...(config.API_KEY && { Authorization: `Bearer ${config.API_KEY}` }),
        },
        timeout,
        httpAgent: noKeepAliveHttp,
        httpsAgent: noKeepAliveHttps,
        proxy: false, // else axios silently honors HTTP_PROXY/HTTPS_PROXY env
                      // vars and routes this somewhere unintended — same
                      // reasoning as tools/handlers/web.js
    };

    const body = {
        model: config.MODEL_NAME,
        messages,
        stream: false,
    };

    try {
        const response = await axios.post(config.AI_API_URL, body, requestConfig);
        return response.data.choices?.[0]?.message?.content?.trim() || '';
    } catch (err) {
        if (!isConnectionReset(err)) throw err;

        if (config.DEBUG) {
            console.log('🔁 Background LLM call dropped by server, retrying once...');
        }
        const response = await axios.post(config.AI_API_URL, body, requestConfig);
        return response.data.choices?.[0]?.message?.content?.trim() || '';
    }
}

module.exports = { callLlm };