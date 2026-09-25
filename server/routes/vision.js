// ============================================
// server/routes/vision.js — receives live-camera frames, runs the vision
// gatekeeper, broadcasts an escalation over /api/events if warranted
// ============================================
// Frames are held in MEMORY ONLY (multer memoryStorage) and discarded
// immediately after the gatekeeper call — never written to disk. This is
// a continuous, standing capability (unlike the one-shot view_screen tool),
// so keeping frames ephemeral by default is the more conservative choice
// for a webcam feed specifically.
const express = require('express');
const multer = require('multer');
const { getSettings } = require('../settings.js');
const { analyzeFrame } = require('../lib/visionGatekeeper.js');

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
});

// broadcast comes from routes/events.js — same channel the Anki heartbeat
// pushes over, just a different event type ('camera_notable').
function makeRouter({ broadcast }) {
    const router = express.Router();

    // Module-scoped (per server process, not per request) — a frame that
    // arrives while a PRIOR frame is still being analyzed is simply
    // dropped rather than queued, so a slow (CPU-bound) gatekeeper never
    // builds up a backlog of increasingly-stale frames. The client's own
    // capture loop (useLiveCamera.js) already re-paces itself around each
    // request's real round-trip time, so this should rarely actually fire
    // — it's a belt-and-suspenders guard for e.g. two devices with the
    // feature on at once.
    let processing = false;

    router.post('/vision/frame', upload.single('frame'), async (req, res) => {
        const settings = getSettings();
        const gk = settings.cameraGatekeeper || {};

        if (!gk.enabled) return res.status(409).json({ error: 'Camera gatekeeper is disabled.' });
        if (!gk.baseUrl || !gk.model) {
            return res.status(400).json({ error: 'Camera gatekeeper is not configured — set a base URL and model in Settings.' });
        }
        if (!req.file) return res.status(400).json({ error: 'No frame uploaded.' });

        if (processing) {
            return res.status(202).json({ skipped: true });
        }

        processing = true;
        try {
            const description = await analyzeFrame(req.file.buffer.toString('base64'), {
                AI_API_URL: gk.baseUrl,
                MODEL_NAME: gk.model,
                API_KEY: gk.apiKey || '',
                CA_CERT_PATH: gk.caCertPath || '',
            });

            if (description) {
                broadcast({ type: 'camera_notable', description, at: new Date().toISOString() });
            }

            res.json({ escalated: Boolean(description) });
        } catch (err) {
            console.error('⚠️ Camera gatekeeper analysis failed (non-fatal):', err.message);
            res.status(502).json({ error: 'Gatekeeper analysis failed.' });
        } finally {
            processing = false;
        }
    });

    return router;
}

module.exports = { makeRouter };