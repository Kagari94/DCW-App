module.exports = {
    AI_API_URL: "http://localhost:1234/v1/chat/completions", // adjust to your LM Studio endpoint
    MODEL_NAME: "google/gemma-3-4b", // set to whatever model you have loaded in LM Studio
    API_KEY: "", // usually empty for local LM Studio
    PI_BASE_URL: '',   // e.g. http://100.x.x.x:4000 — your Pi's Tailscale/LAN address
    PI_APP_TOKEN: '',  // must match APP_TOKEN in the Pi service's own .env
    MAX_REQUEST_LENGTH: 2000,
    DEBUG: true,
    KOKORO_VOICES_DIR: require('path').join(__dirname, 'node_modules', 'kokoro-js', 'voices'),
};
