// ============================================
// server/tools/handlers/documents.js — AI-generated PDF/Word documents
// ============================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const { Document, Packer, Paragraph, HeadingLevel } = require('docx');

const GENERATED_ROOT = path.join(__dirname, '../../data/generated');
const MAX_CONTENT_LENGTH = 50000; // keeps a generated file from ballooning past anything reasonable

function slugify(title) {
    return title.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60) || 'document';
}

function conversationDir(conversationId) {
    // conversationId is always our own crypto.randomUUID() from conversations.js,
    // but this is a filesystem path built from model-adjacent data — defensively
    // reject anything that isn't UUID-shaped rather than trusting that upstream.
    const safeId = /^[a-zA-Z0-9-]+$/.test(conversationId || '') ? conversationId : null;
    if (!safeId) throw new Error('Invalid conversation context.');
    const dir = path.join(GENERATED_ROOT, safeId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

async function generatePdf(title, content, filePath) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50 });
        const stream = fs.createWriteStream(filePath);
        doc.pipe(stream);
        doc.fontSize(18).text(title, { underline: true });
        doc.moveDown();
        doc.fontSize(12).text(content);
        doc.end();
        stream.on('finish', () => resolve());
        stream.on('error', reject);
    });
}

async function generateDocx(title, content, filePath) {
    const paragraphs = [
        new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }),
        ...content.split(/\n+/).filter(Boolean).map(line => new Paragraph({ text: line })),
    ];
    const doc = new Document({ sections: [{ children: paragraphs }] });
    const buffer = await Packer.toBuffer(doc);
    fs.writeFileSync(filePath, buffer);
}

async function createDocument({ title, content, format }, config) {
    if (!title || typeof title !== 'string') throw new Error('A title is required.');
    if (!content || typeof content !== 'string') throw new Error('Content is required.');
    if (content.length > MAX_CONTENT_LENGTH) {
        throw new Error(`Content too long (${content.length} chars, max ${MAX_CONTENT_LENGTH}).`);
    }

    const fmt = format === 'docx' ? 'docx' : 'pdf';
    const dir = conversationDir(config.conversationId);
    const ext = fmt === 'docx' ? '.docx' : '.pdf';
    const storedFilename = `${crypto.randomUUID()}-${slugify(title)}${ext}`;
    const filePath = path.join(dir, storedFilename);

    if (fmt === 'docx') {
        await generateDocx(title, content, filePath);
    } else {
        await generatePdf(title, content, filePath);
    }

    const { size } = fs.statSync(filePath);

    return {
        ok: true,
        generatedFile: { filename: `${title}${ext}`, storedFilename, format: fmt, size },
    };
}

const definitions = [
    {
        type: 'function',
        function: {
            name: 'create_document',
            description:
                'Generates a downloadable PDF or Word (.docx) document from the given content and ' +
                'attaches it to your reply. Only use this when the user explicitly asks for a document, ' +
                'report, or file — e.g. "write this up as a PDF", "make me a document with...", ' +
                '"can you export/save this as a file". Do NOT use this for normal conversational replies, ' +
                'explanations, or anything that reads fine as a regular chat message, even if it is long — ' +
                'only use it when the user has actually asked for a file.',
            parameters: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: 'Document title, also used as the filename' },
                    content: { type: 'string', description: 'Full plain-text content of the document (no markdown syntax)' },
                    format: { type: 'string', enum: ['pdf', 'docx'], description: 'Output format — defaults to pdf if omitted' },
                },
                required: ['title', 'content'],
            },
        },
    },
];

module.exports = { definitions, handlers: { create_document: createDocument }, source: 'Documents' };