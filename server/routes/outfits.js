const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function makeRouter({ characters = require('../lib/characters') } = {}) {
    const router = express.Router();
    function profile(id) {
        const character = characters.readCharacter(id);
        if (!character || character.legacy) throw Object.assign(new Error('Create a saved companion before adding outfits.'), { status: 400 });
        return character;
    }
    router.get('/characters/:id/outfits', (req, res) => res.json({ character: profile(req.params.id) }));
    router.post('/characters/:id/outfits/:outfitId/select', (req, res) => {
        res.json({ character: characters.selectOutfit(req.params.id, req.params.outfitId) });
    });
    router.patch('/characters/:id/outfits/:outfitId', (req, res) => {
        res.json({ character: characters.updateOutfit(req.params.id, req.params.outfitId, { name: req.body?.name }) });
    });

    const modelUpload = multer({
        storage: multer.diskStorage({
            destination(req, _file, cb) {
                try {
                    profile(req.params.id);
                    req.outfitId = randomUUID();
                    const directory = characters.outfitDirectoryFor(req.params.id, req.outfitId);
                    fs.mkdirSync(directory, { recursive: true });
                    cb(null, directory);
                } catch (error) { cb(error); }
            },
            filename: (_req, _file, cb) => cb(null, 'model.vrm'),
        }),
        limits: { fileSize: 500 * 1024 * 1024 },
        fileFilter: (_req, file, cb) => cb(/\.vrm$/i.test(file.originalname) ? null : Object.assign(new Error('Select a .vrm model.'), { status: 400 }), /\.vrm$/i.test(file.originalname)),
    });
    router.post('/characters/:id/outfits/upload', modelUpload.single('vrm'), (req, res, next) => {
        try {
            if (!req.file) return res.status(400).json({ error: 'Select a .vrm model.' });
            if (req.body.name !== undefined && typeof req.body.name !== 'string') {
                throw Object.assign(new Error('Outfit name must be text.'), { status: 400 });
            }
            const originalName = path.basename(req.file.originalname);
            const character = characters.addOutfit(req.params.id, { outfitId: req.outfitId,
                name: req.body.name?.trim() || path.parse(originalName).name, originalName });
            res.status(201).json({ character });
        } catch (error) {
            if (req.file) fs.rmSync(req.file.path, { force: true });
            next(error);
        }
    });

    const imageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
    function imageHandler(getDirectory, update) { return async (req, res) => {
        const directory = getDirectory(req.params);
        if (!req.file) return res.status(400).json({ error: 'Select an image.' });
        let image;
        try {
            const source = sharp(req.file.buffer, { limitInputPixels: 16000000 });
            if (!['png', 'jpeg', 'webp'].includes((await source.metadata()).format)) throw new Error('Unsupported image format');
            image = await source.rotate()
                .resize(384, 384, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
        } catch { return res.status(400).json({ error: 'Select a valid PNG, JPEG, or WebP image.' }); }
        fs.mkdirSync(directory, { recursive: true });
        const temporary = path.join(directory, `${randomUUID()}.tmp`);
        try {
            fs.writeFileSync(temporary, image, { flag: 'wx' });
            fs.renameSync(temporary, path.join(directory, 'preview.webp'));
            res.json({ character: update(req.params, randomUUID()) });
        } finally { fs.rmSync(temporary, { force: true }); }
    }; }
    router.post('/characters/:id/outfits/:outfitId/image', imageUpload.single('image'), imageHandler(params => {
        characters.getOutfit(params.id, params.outfitId);
        return characters.outfitDirectoryFor(params.id, params.outfitId);
    }, (params, revision) => characters.updateOutfit(params.id, params.outfitId, { image: 'preview.webp', imageRevision: revision })));
    router.post('/characters/:id/image', imageUpload.single('image'), imageHandler(params => {
        profile(params.id);
        return characters.directoryFor(params.id);
    }, (params, revision) => characters.updateCharacterImage(params.id, revision)));
    router.use((error, _req, res, _next) => {
        const status = error.code === 'LIMIT_FILE_SIZE' ? 413 : error.code === 'ENOENT' ? 404 : error.status || (error instanceof multer.MulterError ? 400 : 500);
        res.status(status).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'File is too large.' : error.code === 'ENOENT' ? 'Companion not found.' : error.message });
    });
    return router;
}
module.exports = makeRouter();
module.exports.makeRouter = makeRouter;
