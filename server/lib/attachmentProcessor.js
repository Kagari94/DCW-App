// ============================================
// server/lib/attachmentProcessor.js — expands stored attachment metadata
// into the OpenAI-style multimodal `content` the model actually needs
// ============================================
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');
const mammoth = require('mammoth');
const sharp = require('sharp');

const IMAGE_MIME_TYPES = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
};

const TEXT_EXTENSIONS = new Set([
    '.txt', '.md', '.js', '.jsx', '.ts', '.tsx', '.py',
    '.json', '.css', '.html', '.csv', '.log',
]);

// Converts one attachment's metadata (path/filename on disk) into either an
// image_url content part or a text content part. Reads the file fresh every
// call — nothing is cached, since conversation history only stores the path.
async function attachmentToContentPart(attachment) {
    const ext = path.extname(attachment.filename).toLowerCase();

    if (IMAGE_MIME_TYPES[ext]) {
        // Downscale before sending — a full camera-resolution photo can produce
        // far more vision-model patch tokens than LM Studio's configured
        // n_ubatch can handle, crashing the model entirely rather than just
        // failing gracefully. 1024px on the long edge is plenty for the model
        // to describe/classify content accurately.
        const resized = await sharp(attachment.path)
            .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer();

        const base64 = resized.toString('base64');
        console.log(`🖼️  Encoded image attachment: ${attachment.filename} (resized -> ${base64.length} base64 chars)`);
        return {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${base64}` },
        };
    }

    if (ext === '.pdf') {
        const data = fs.readFileSync(attachment.path);
        const parser = new PDFParse({ data });
        const result = await parser.getText();
        return {
            type: 'text',
            text: `\n\n[Attached PDF: ${attachment.filename}]\n${result.text.trim()}`,
        };
    }

    if (ext === '.docx') {
        const result = await mammoth.extractRawText({ path: attachment.path });
        return {
            type: 'text',
            text: `\n\n[Attached Word document: ${attachment.filename}]\n${result.value.trim()}`,
        };
    }
    if (TEXT_EXTENSIONS.has(ext)) {
        const text = fs.readFileSync(attachment.path, 'utf8');
        return {
            type: 'text',
            text: `\n\n[Attached file: ${attachment.filename}]\n${text}`,
        };
    }

    // Unknown/unsupported type — note it rather than silently dropping it,
    // so it's obvious in the transcript why the model didn't react to it.
    return {
        type: 'text',
        text: `\n\n[Attached file: ${attachment.filename} — unsupported type, contents not included]`,
    };
}

// Expands a single message's `attachments` metadata into a multimodal
// `content` array. Text-like attachments (pdf/txt/code) are merged into one
// text block alongside the user's typed message; images become separate
// image_url blocks alongside it. Messages without attachments pass through
// by reference, unchanged.
async function expandMessageWithAttachments(message) {
    if (!message.attachments || message.attachments.length === 0) return message;

    const textParts = [message.content || ''];
    const imageParts = [];

    for (const attachment of message.attachments) {
        const part = await attachmentToContentPart(attachment);
        if (part.type === 'text') {
            textParts.push(part.text);
        } else {
            imageParts.push(part);
        }
    }

    return {
        role: message.role,
        content: [
            { type: 'text', text: textParts.join('') },
            ...imageParts,
        ],
    };
}

// Builds a parallel messages array for the model call: any message carrying
// attachments gets expanded to full multimodal content; everything else is
// untouched. The caller's original array (and its lean, path-only persisted
// form) is never mutated.
async function buildExpandedMessages(messages) {
    const expanded = [];
    for (const message of messages) {
        expanded.push(await expandMessageWithAttachments(message));
    }
    return expanded;
}

module.exports = { buildExpandedMessages };