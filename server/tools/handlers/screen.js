// ============================================
// server/tools/handlers/screen.js — screen-viewing tool
// ============================================
// Unlike every other local tool, this one can't actually produce its
// result here — a screen frame only exists in the BROWSER, captured from
// a live getDisplayMedia stream the server has no access to. The handler
// can only check whether a session is active and, if so, signal that a
// frame is needed; toolCallLoop.js and chat.js own the actual pause/resume
// round-trip. See toolCallLoop.js's handling of __needScreenFrame for why.
const definitions = [
    {
        type: 'function',
        function: {
            name: 'view_screen',
            description:
                "Capture and view what's currently on the user's shared screen. Call this whenever " +
                "answering would benefit from seeing what's currently visible there — the user is " +
                "referencing something on screen, asking about text/an image they're looking at, " +
                "or the context otherwise implies they mean 'what I'm looking at right now'. Don't " +
                "wait for an exact trigger phrase — use judgment the way a person glancing at a " +
                "shared screen would. Only works if a screen-sharing session is currently active; " +
                "if not, this returns an error explaining that.",
            parameters: { type: 'object', properties: {} },
        },
    },
];

const handlers = {
    view_screen: (args, config) => {
        if (!config.screenSessionActive) {
            return { error: 'No active screen-sharing session — ask the user to start one first.' };
        }
        return { __needScreenFrame: true };
    },
};

module.exports = { definitions, handlers };