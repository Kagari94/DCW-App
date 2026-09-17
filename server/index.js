// ============================================
// server/index.js — Express backend entrypoint
// ============================================
const path = require('path');
const express = require('express');
const cors = require('cors');
const { initTools } = require('./tools');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const { requireAuth } = require('./auth');
app.use('/api', requireAuth);

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});
const chatRoutes = require('./routes/chat');
app.use('/api', chatRoutes);

app.use('/api', require('./routes/tools.js'));//C0nvert the other to this format too?

app.use('/api', require('./routes/attachments'));

app.use('/api', require('./routes/documents'));

app.use('/voices', express.static(path.join(__dirname, 'data/voices')));
const voiceRoutes = require('./routes/voice');
app.use('/api', voiceRoutes);

const settingsRoutes = require('./routes/settings');
app.use('/api', settingsRoutes);

const { watchForChanges } = require('./scripts/syncExpressions');
watchForChanges();

(async () => {
    await initTools();

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`Server listening on 0.0.0.0:${PORT}`);
    });
})();

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running at http://localhost:${PORT}`);
});
