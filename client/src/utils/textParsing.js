// ============================================
// utils/textParsing.js — tag extraction and text cleanup
// ============================================

export function extractTag(text, tagName) {
    const regex = new RegExp(`<${tagName}>(.*?)</${tagName}>`, 'i');
    const match = text.match(regex);
    return match ? match[1].trim().toLowerCase() : null;
}

function stripAllTags(text) {
    if (!text) return '';
    return text
        .replace(/<([a-zA-Z_]+)>[\s\S]*?<\/\1>/g, '')
        .replace(/<\/?[a-zA-Z_]+\s*\/?>/g, '');
}

// Real Markdown now gets rendered (headers, lists, bold, italics) via
// ReactMarkdown in ChatBox — so this only strips our own custom tags and
// tidies whitespace, WITHOUT collapsing newlines, since Markdown structure
// depends on them (a bullet list with no line breaks is just plain text).
export function cleanTextForDisplay(text) {
    return stripAllTags(text)
        .replace(/[ \t]+(?=\n)/g, '')   // trailing spaces before a line break
        .replace(/\n{3,}/g, '\n\n')     // cap runs of blank lines at one
        .trim();
}

const SPOKEN_DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const NUMBER_PATTERN = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;
const SIGN_PATTERN = String.raw`([+\-−]\s*)?`;
const CURRENCY_NAMES = { '$': 'dollar', '€': 'euro', '£': 'pound' };
export const VOICE_CHUNK_LIMIT = 400;

// Replace excluded content with equal-length spaces so streaming offsets remain
// valid. Detect rows as they arrive, before punctuation inside a table can speak.
function maskVoiceBlocks(text, done = true) {
    const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
    let fence = null;
    let contents = false;
    let contentsEntries = false;
    let table = false;
    return lines.map((line, index) => {
        const trimmed = line.trim();
        const heading = trimmed.replace(/^#{1,6}\s+/, '').replace(/\*\*/g, '').replace(/:$/, '').trim();
        const marker = trimmed.match(/^(`{3,}|~{3,})/);
        let skip = false;
        if (fence) {
            skip = true;
            if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
        } else if (marker) {
            fence = marker[1];
            skip = true;
        } else if (/^(?:table of contents|contents)$/i.test(heading)) {
            contents = true;
            contentsEntries = false;
            skip = true;
        } else if (/^(?:(?:summary|comparison|pricing)\s+)?table$/i.test(heading)) {
            skip = true;
        } else {
            if (contents) {
                if (!trimmed && contentsEntries) contents = false;
                else if (!trimmed) skip = true;
                else if (/^(?:[-*+]\s+|\d+[.)]\s+|\[[^\]]+\]\(#)/.test(trimmed)) {
                    contentsEntries = true;
                    skip = true;
                } else contents = false;
            }
            const pipeCount = (line.match(/(?<!\\)\|/g) || []).length;
            const nextIsSeparator = /^\s*\|?\s*:?-{3,}:?\s*\|/.test(lines[index + 1] || '');
            const pendingPipeRow = !done && pipeCount > 0 && (!lines[index + 1] || !lines[index + 1].endsWith('\n'));
            const pipeRow = /^\s*\|/.test(line) || pipeCount >= 2 || (pipeCount > 0 && (table || nextIsSeparator || pendingPipeRow));
            const tabRow = (line.match(/\t/g) || []).length >= 2 || (table && /\t/.test(line));
            if (pipeRow || tabRow) {
                table = true;
                skip = true;
            } else table = false;
        }
        return skip ? line.replace(/[^\r\n]/g, ' ') : line;
    }).join('');
}

function speakNumber(value, sign = '') {
    const [integer, fraction] = value.replaceAll(',', '').split('.');
    const prefix = sign.trim() === '+' ? 'plus ' : sign.trim() ? 'minus ' : '';
    return prefix + integer + (fraction ? ` point ${[...fraction].map(digit => SPOKEN_DIGITS[Number(digit)]).join(' ')}` : '');
}

function speakNumbers(text) {
    return text
        .replace(new RegExp(String.raw`([$€£])\s*(${NUMBER_PATTERN})\s*[-–—]\s*([$€£])?\s*(${NUMBER_PATTERN})(?![\p{L}\d]|\.\d)`, 'gu'),
            (_match, symbol, from, toSymbol, to) => `${symbol}${from} to ${toSymbol || symbol}${to}`)
        .replace(/\b((?:19|20)\d{2})\s*[-–—]\s*((?:19|20)\d{2})\b/g, '$1 to $2')
        .replace(/\b(\d+(?:\.\d+)?\s*(?:GB|MB|TB|KB))\s*[-–—]\s*(?=\d)/gi, '$1 to ')
        .replace(/\b(\d+(?:\.\d+)?)\s*(GB|MB|TB|KB)\b/gi,
            (_match, value, unit) => `${value} ${{ GB: 'gigabytes', MB: 'megabytes', TB: 'terabytes', KB: 'kilobytes' }[unit.toUpperCase()]}`)
        .replace(new RegExp(String.raw`(?<![\p{L}\d])${SIGN_PATTERN}([$€£])\s*${SIGN_PATTERN}(${NUMBER_PATTERN})(?![\p{L}\d]|\.\d|,\d)(?:\s+(thousand|million|billion|trillion)\b)?`, 'gu'),
            (_match, beforeSign, symbol, afterSign, value, scale) => {
                const unit = CURRENCY_NAMES[symbol] + (Number(value.replaceAll(',', '')) === 1 && !scale ? '' : 's');
                return `${speakNumber(value, beforeSign || afterSign)}${scale ? ` ${scale}` : ''} ${unit}`;
            })
        .replace(new RegExp(String.raw`(?<![\p{L}\d.])${SIGN_PATTERN}(${NUMBER_PATTERN})\s*%`, 'gu'),
            (_match, sign, value) => `${speakNumber(value, sign)} percent`)
        .replace(/(?<![\p{L}\d.])([+\-−]?)(\d+(?:,\d{3})*\.\d+)(?![\p{L}\d]|\.\d)/gu,
            (_match, sign, value) => speakNumber(value, sign));
}

export function cleanTextForVoice(text) {
    const cleaned = stripAllTags(maskVoiceBlocks(text || ''))
        .replace(/^#{1,6}\s+/gm, '')                        // headers -> just the words
        .replace(/^\s*[-*+]\s+/gm, '')                       // bullet markers
        .replace(/^\s*\d+[.)]\s+/gm, '')                     // numbered list markers
        .replace(/\*\*(.+?)\*\*/g, '$1')                      // bold
        .replace(/\*([^*]+)\*/g, '$1')                        // italics (safe now — bold already removed above)
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')             // link label, not its URL
        .replace(/(?<=\w)\.(jpe?g|png|gif|webp|pdf|docx?|txt|md|csv|json|mp3|wav|mp4)\b/gi, '')
        // Remove a company's ticker in stock references, retaining other acronyms.
        .replace(/\b(\p{Lu}[\p{L}\d&.'’−-]*(?:\s+\p{Lu}[\p{L}\d&.'’−-]*)*)\s*\((?:[A-Z]+:\s*)?[A-Z][A-Z0-9]{0,5}(?:[.-][A-Z])?\)(?=\s+(?:stocks?\b|shares?\b|closed\b|closing\b|opened\b|trades?\b|trading\b|rose\b|fell\b|gained\b|dropped\b))/gu, '$1')
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
    return /[\p{L}\p{N}]/u.test(cleaned) ? speakNumbers(cleaned) : '';
}

// Keep long prose bounded and never send a bare fragment of a list or table.
// Final punctuation also helps Pocket TTS terminate an utterance reliably.
export function splitVoiceText(text, limit = VOICE_CHUNK_LIMIT) {
    let remaining = text.trim();
    const chunks = [];
    while (remaining) {
        let end = remaining.length;
        if (end > limit - 1) {
            const prefix = remaining.slice(0, limit);
            const clauses = [...prefix.matchAll(/[,;:]\s+/g)];
            const clause = clauses.at(-1);
            end = clause && clause.index >= limit / 2 ? clause.index + 1 : prefix.lastIndexOf(' ');
            if (end <= 0) end = remaining.indexOf(' ', limit);
            if (end < 0) end = remaining.length;
        }
        const chunk = remaining.slice(0, end).trim();
        if (/[\p{L}\p{N}]/u.test(chunk)) {
            chunks.push(/[.!?]["'”’)\]}]*$/.test(chunk) ? chunk : chunk.replace(/[,;:]$/, '') + '.');
        }
        remaining = remaining.slice(end).trim();
    }
    return chunks;
}

// Use original-text offsets: speech cleanup changes string lengths. Hold a
// final dot until more text arrives, so streamed "228." can become "228.52".
export function getVoiceSentences(text, { start = 0, done = false } = {}) {
    const safeText = done ? text : getSafeDisplayPrefix(text);
    const voiceText = maskVoiceBlocks(safeText, done);
    const boundaryText = voiceText
        .replace(/<([a-zA-Z_]+)>[\s\S]*?<\/\1>/g, tag => ' '.repeat(tag.length))
        .replace(/<\/?[a-zA-Z_]+\s*\/?>/g, tag => ' '.repeat(tag.length))
        .replace(/^[ \t]*(?:#{1,6}[ \t]+)?\d+[.)](?=[ \t]|$)/gm, marker => ' '.repeat(marker.length));
    const boundary = /[.!?]+["'”’)\]}*_]*(?=\s|$)/g;
    boundary.lastIndex = start;
    const sentences = [];
    let nextOffset = start;
    let match;
    while ((match = boundary.exec(boundaryText)) !== null) {
        const end = match.index + match[0].length;
        if (!done && end === safeText.length) break;
        if (/\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|e\.g|i\.e|Inc|Corp|Ltd|Co)\.$/i.test(voiceText.slice(nextOffset, end))) continue;
        const sentence = cleanTextForVoice(voiceText.slice(nextOffset, end));
        if (sentence) sentences.push(sentence);
        nextOffset = end;
    }
    if (done) {
        const remainder = cleanTextForVoice(voiceText.slice(nextOffset));
        if (remainder) sentences.push(remainder);
        nextOffset = safeText.length;
    }
    return { sentences, nextOffset };
}

// getSafeDisplayPrefix stays exactly as it already is — still guards
// against a half-typed <tag> flashing mid-stream, unrelated to this change.
export function getSafeDisplayPrefix(text) {
    let consumed = 0;
    let rest = text;

    while (true) {
        const leadingWs = rest.match(/^\s*/)[0];
        const afterWs = rest.slice(leadingWs.length);
        const match = afterWs.match(/^<([a-zA-Z_]+)>[\s\S]*?<\/\1>/);
        if (!match) break;
        consumed += leadingWs.length + match[0].length;
        rest = afterWs.slice(match[0].length);
    }

    if (rest.startsWith('<')) {
        return text.slice(0, consumed);
    }
    return text;
}
