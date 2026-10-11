// Reject broken generation, rather than saving control-token strings as replies.
const RESERVED_PREFIXES = ['<unused', '<tool_call|>', '<tool_response|>', '<|tool_call>', '[multimodal]', '<|"|>'];

class InvalidModelOutputError extends Error {
    constructor() {
        super('The AI model returned invalid special tokens instead of a reply.');
        this.name = 'InvalidModelOutputError';
        this.code = 'INVALID_MODEL_OUTPUT';
    }
}

function modelOutputState(text) {
    const prefix = text.trimStart().replace(/^<expression>[^<]*<\/expression>\s*/i, '');
    if (RESERVED_PREFIXES.some(token => prefix.startsWith(token))) return 'invalid';
    if (!prefix || RESERVED_PREFIXES.some(token => token.startsWith(prefix))) return 'pending';
    return 'valid';
}

function assertValidModelOutput(text) {
    if (modelOutputState(text) === 'invalid') throw new InvalidModelOutputError();
}

module.exports = { InvalidModelOutputError, modelOutputState, assertValidModelOutput };
