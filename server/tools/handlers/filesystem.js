// ============================================
// server/tools/handlers/filesystem.js — whitelisted, recursive file
// management (list / rename / soft-delete) within one configured root
// ============================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ATTACHMENTS_ROOT = path.join(__dirname, '../../data/attachments');
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB — a folder of camera photos/screenshots can run much larger than typical chat uploads

function getRoot(config) {
    const root = config.fileAccess?.rootPath;
    if (!root) {
        throw new Error('No file access folder is configured. Set one in Settings first.');
    }
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
        throw new Error(`Configured file access folder "${root}" no longer exists.`);
    }
    return path.resolve(root);
}

// Resolves a model-given relative path against the configured root and
// rejects anything that would escape it (../ tricks, absolute paths on
// either OS, etc.) — the whole safety boundary of this tool lives here.
function resolveSafe(root, relativePath) {
    const cleaned = (relativePath || '').replace(/^[/\\]+/, ''); // strip any leading slash so it can't look absolute
    const resolved = path.resolve(root, cleaned);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new Error('That path is outside the allowed folder.');
    }
    return resolved;
}

function isHidden(name) {
    return name === '.trash' || name.startsWith('.');
}

async function listFiles({ subpath = '' }, config) {
    const root = getRoot(config);
    const targetDir = resolveSafe(root, subpath);

    if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
        throw new Error(`"${subpath || '(root)'}" is not a folder in the allowed directory.`);
    }

    const entries = fs.readdirSync(targetDir, { withFileTypes: true })
        .filter(e => !isHidden(e.name))
        .map(e => {
            const full = path.join(targetDir, e.name);
            const stat = fs.statSync(full);
            return {
                name: e.name,
                type: e.isDirectory() ? 'folder' : 'file',
                size: e.isDirectory() ? null : stat.size,
                modified: stat.mtime.toISOString(),
                path: path.join(subpath, e.name).replace(/\\/g, '/'),
            };
        });

    return { subpath: subpath || '(root)', entries };
}

async function renameFile({ path: relativePath, newName }, config) {
    if (!newName || /[/\\]/.test(newName)) {
        throw new Error('newName must be a plain filename, not a path.');
    }
    const root = getRoot(config);
    const source = resolveSafe(root, relativePath);
    if (!fs.existsSync(source)) throw new Error(`"${relativePath}" not found.`);

    // Preserve the original extension unless the model explicitly gave one
    // that matches a real file type — prevents e.g. a .jpg accidentally
    // being renamed to "sunset" or "sunset.png" and silently losing its
    // actual format identity.
    const originalExt = path.extname(source);
    const hasExt = path.extname(newName);
    const finalName = hasExt ? newName : `${newName}${originalExt}`;

    const dest = path.join(path.dirname(source), finalName);
    if (fs.existsSync(dest)) throw new Error(`"${finalName}" already exists in that folder.`);

    fs.renameSync(source, dest);
    return { ok: true, renamedTo: finalName };
}

async function deleteFile({ path: relativePath }, config) {
    const root = getRoot(config);
    const source = resolveSafe(root, relativePath);
    if (!fs.existsSync(source)) throw new Error(`"${relativePath}" not found.`);

    const trashDir = path.join(root, '.trash');
    fs.mkdirSync(trashDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(trashDir, `${stamp}__${path.basename(source)}`);
    fs.renameSync(source, dest);

    return { ok: true, movedToTrash: true, note: 'File moved to .trash inside the allowed folder, not permanently deleted.' };
}

async function viewImage({ path: relativePath }, config) {
    const root = getRoot(config);
    const target = resolveSafe(root, relativePath);

    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        throw new Error(`"${relativePath}" is not a file in the allowed folder.`);
    }

    const ext = path.extname(target).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) {
        throw new Error(`"${relativePath}" is not a supported image type (png/jpg/jpeg/webp/gif).`);
    }

    const { size } = fs.statSync(target);
    if (size > MAX_IMAGE_BYTES) {
        throw new Error(`"${relativePath}" is too large to view (${Math.round(size / 1024 / 1024)}MB, max 8MB).`);
    }

    if (!config.conversationId) {
        throw new Error('No active conversation to attach this image to.');
    }

    // Copy into this conversation's own attachments folder — same location
    // and naming convention real uploads use (see routes/attachments.js) —
    // rather than referencing the original file's live path directly. If
    // the model renames or deletes the original later in this same turn
    // (view, then rename based on what it saw — a completely natural
    // sequence), this snapshot is unaffected, and stays available for the
    // rest of this conversation's history exactly like any other attachment.
    const filename = path.basename(target);
    const storedFilename = `${crypto.randomUUID()}-${filename}`;
    const conversationDir = path.join(ATTACHMENTS_ROOT, config.conversationId);
    fs.mkdirSync(conversationDir, { recursive: true });
    const snapshotPath = path.join(conversationDir, storedFilename);
    fs.copyFileSync(target, snapshotPath);

    return {
        __viewImage: { absolutePath: snapshotPath, filename, storedFilename, size },
    };
}

const definitions = [
    {
        type: 'function',
        function: {
            name: 'list_files',
            description:
                'Lists files and folders inside the user\'s allowed file-access folder (or a subfolder ' +
                'of it). Use this first to find a file\'s exact path before renaming or deleting it.',
            parameters: {
                type: 'object',
                properties: {
                    subpath: { type: 'string', description: 'Relative subfolder to list, e.g. "Screenshots/2026". Omit to list the root.' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'rename_file',
            description: 'Renames a file or folder (found via list_files) within the allowed folder.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative path to the file/folder, as returned by list_files' },
                    newName: { type: 'string', description: 'New filename only (no path/slashes)' },
                },
                required: ['path', 'newName'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'delete_file',
            description:
                'Deletes a file or folder (found via list_files) within the allowed folder. This is a ' +
                'soft delete — the item is moved to a hidden .trash folder inside the allowed directory, ' +
                'not permanently erased.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative path to the file/folder, as returned by list_files' },
                },
                required: ['path'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'view_image',
            description:
                'Loads an image file (found via list_files) so you can actually see its contents — ' +
                'use this before renaming or organizing an image based on what it shows, since a ' +
                'filename alone does not tell you what is in the picture.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Relative path to the image, as returned by list_files' },
                },
                required: ['path'],
            },
        },
    },
];

const handlers = {
    list_files: listFiles,
    rename_file: renameFile,
    delete_file: deleteFile,
    view_image: viewImage,
};

module.exports = { definitions, handlers, source: 'Files' };