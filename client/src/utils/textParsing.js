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
        .replace(/<([a-zA-Z_]+)>.*?<\/\1>/g, '')
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

export function cleanTextForVoice(text) {
    return stripAllTags(text)
        .replace(/^#{1,6}\s+/gm, '')                        // headers -> just the words
        .replace(/^\s*[-*+]\s+/gm, '')                       // bullet markers
        .replace(/^\s*\d+\.\s+/gm, '')                       // numbered list markers
        .replace(/\*\*(.+?)\*\*/g, '$1')                      // bold
        .replace(/\*([^*]+)\*/g, '$1')                        // italics (safe now — bold already removed above)
        .replace(/(?<=\w)\.(jpe?g|png|gif|webp|pdf|docx?|txt|md|csv|json|mp3|wav|mp4)\b/gi, '')
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
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