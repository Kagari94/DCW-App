// ============================================
// server/routes/attachments.js — upload + serve attachments, per-conversation
// Files live on the SERVER machine (server/data/attachments/<conversationId>/),
// never on whatever device the browser is running on — same as chat/TTS/VRM.
// Conversation history only ever stores the returned path/filename metadata.
// ============================================
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const router = express.Router();

const ATTACHMENTS_ROOT = path.join(__dirname, '../data/attachments');

const ALLOWED_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.webp', '.gif',
    '.pdf', '.docx',
    '.txt', '.md', '.js', '.jsx', '.ts', '.tsx', '.py', '.json', '.css', '.html', '.csv', '.log',
]);

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const conversationId = req.params.conversationId;
        const dir = path.join(ATTACHMENTS_ROOT, conversationId);
        fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        // Prefix with a uuid so two uploads of "photo.png" in the same
        // conversation never collide.
        cb(null, `${crypto.randomUUID()}-${file.originalname}`);
    },
});

const upload = multer({
    storage,
    limits: { fileSize: 20 * 1024 * 1024 }, // 20MB per file — bump if needed
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        if (!ALLOWED_EXTENSIONS.has(ext)) {
            return cb(new Error(`Unsupported file type: ${ext}`));
        }
        cb(null, true);
    },
});

router.post('/conversations/:conversationId/attachments', (req, res) => {
    upload.single('file')(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

        res.json({
            filename: req.file.originalname,
            storedFilename: req.file.filename,
            path: req.file.path,
            size: req.file.size,
        });
    });
});

router.get('/conversations/:conversationId/attachments/:storedFilename', (req, res) => {
    const conversationDir = path.resolve(path.join(ATTACHMENTS_ROOT, req.params.conversationId));
    const filePath = path.resolve(path.join(conversationDir, req.params.storedFilename));

    // Reject anything that resolves outside this conversation's own folder
    // (path traversal guard against a crafted storedFilename like "../../x").
    if (!filePath.startsWith(conversationDir)) {
        return res.status(400).json({ error: 'Invalid path.' });
    }

    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Attachment not found.' });
    res.sendFile(filePath);
});

module.exports = router;