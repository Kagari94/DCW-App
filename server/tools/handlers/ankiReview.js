// ============================================
// server/tools/handlers/ankiReview.js — lets the AI open/close the Anki
// review window, same pattern as weather.js's get_weather/close_weather_window
// ============================================
// Deliberately doesn't fetch due cards itself — AnkiWindow.jsx fetches its
// own data from GET /api/anki/due-cards once it's opened (see routes/anki.js).
// This handler's only job is the `ui` event that tells the client to show
// or hide the window, exactly like weather's does.

const definitions = [
    {
        type: 'function',
        function: {
            name: 'open_anki_review',
            description:
                "Opens the flashcard review window on the desktop companion, so the user can start " +
                "reviewing due Anki-style flashcards. Use when the user asks to review, study, or " +
                "practice their flashcards (e.g. \"let's review\", \"quiz me\").",
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'close_anki_review',
            description: 'Closes the flashcard review window on the desktop companion if it is open.',
            parameters: { type: 'object', properties: {} },
        },
    },
];

const handlers = {
    open_anki_review() {
        return { opened: true, ui: { window: 'anki', action: 'show' } };
    },
    close_anki_review() {
        return { closed: true, ui: { window: 'anki', action: 'hide' } };
    },
};

module.exports = { definitions, handlers, source: 'Anki' };