// Only standalone social phrases qualify; short requests still get every tool.
const SOCIAL_PHRASES = new Set([
    'hello', 'hello there', 'hi', 'hi there', 'hey', 'hey there', 'good morning',
    'good afternoon', 'good evening', 'good night', 'thanks', 'thank you', 'bye',
    'goodbye', 'hei', 'moi', 'moikka', 'terve', 'huomenta', 'kiitos',
    'こんにちは', 'こんばんは', 'おはよう', 'ありがとう',
]);

function isSimpleSocialText(text) {
    if (typeof text !== 'string') return false;
    const phrase = text.normalize('NFKC').toLowerCase()
        .replace(/^[\p{P}\p{S}\s]+|[\p{P}\p{S}\s]+$/gu, '').replace(/\s+/gu, ' ');
    return SOCIAL_PHRASES.has(phrase);
}

function isSimpleSocialTurn(messages) {
    const latest = messages.at(-1);
    return latest?.role === 'user' && !latest.attachments?.length && isSimpleSocialText(latest.content);
}

function requestContextStats(body) {
    const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
    const messages = body.messages || [];
    return { messages: messages.length, tools: body.tools?.length || 0,
        messageBytes: bytes(messages), toolBytes: body.tools?.length ? bytes(body.tools) : 0,
        requestBytes: bytes(body) };
}

module.exports = { isSimpleSocialText, isSimpleSocialTurn, requestContextStats };
