// ============================================
// server/index.js — Express backend entrypoint
// ============================================
const path = require('path');
const express = require('express');
const { initializeMemoryDatabase } = require('./lib/memory/db.js');
const cors = require('cors');
const { initTools, getToolHandlers } = require('./tools');
const { startHeartbeats } = require('./lib/heartbeat/registry.js');
const ankiDueCardsCheck = require('./lib/heartbeat/checks/ankiDueCards.js');
const { router: eventsRouter, broadcast } = require('./routes/events.js');
const { makeRouter: makeAnkiRouter } = require('./routes/anki.js');
const { makeRouter: makeVisionRouter } = require('./routes/vision.js');

// Every registered heartbeat check — add a new one here (and its module
// under lib/heartbeat/checks/) to wire in another periodic reminder.
const heartbeatChecks = [ankiDueCardsCheck];

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const { requireAuth } = require('./auth');
app.use('/api', requireAuth);

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});
const chatRoutes = require('./routes/chat').makeRouter();
app.use('/api', chatRoutes);
app.use('/api', require('./routes/memory.js'));

app.use('/api', require('./routes/tools.js'));

app.use('/api', require('./routes/attachments'));

app.use('/api', require('./routes/documents'));

app.use('/api', eventsRouter);

app.use('/voices', express.static(path.join(__dirname, 'data/voices')));
const voiceRoutes = require('./routes/voice');
app.use('/api', voiceRoutes);

const settingsRoutes = require('./routes/settings');
app.use('/api', settingsRoutes);

const { watchForChanges } = require('./scripts/syncExpressions');
watchForChanges();

(async () => {
    await initializeMemoryDatabase();
    require('./lib/memory').startMemoryWorker();
    await initTools();
    startHeartbeats(heartbeatChecks, { getToolHandlers, broadcast });

    // Both factories need `broadcast` (vision) / `getToolHandlers` (anki),
    // neither of which is meaningfully ready before this point — built
    // here rather than required as ready-made routers.
    app.use('/api', makeAnkiRouter({ getToolHandlers }));
    app.use('/api', makeVisionRouter({ broadcast }));

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`✅ Server running at http://localhost:${PORT}`);
    });
})();
