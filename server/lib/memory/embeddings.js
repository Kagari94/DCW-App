// ============================================
// server/lib/memory/embeddings.js — local embedding model
// ============================================
const { EMBEDDING_DIM } = require('./db.js');

let pipelinePromise = null;

// Lazy singleton — @huggingface/transformers is ESM-only, hence the dynamic
// import from this CommonJS file. The model (~90MB) downloads from Hugging
// Face to the local transformers.js cache on first use only; every call
// after that is fully local/offline, same machine, no LM Studio involved.
async function getEmbedder() {
    if (!pipelinePromise) {
        pipelinePromise = (async () => {
            const { pipeline } = await import('@huggingface/transformers');
            return pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
        })();
    }
    return pipelinePromise;
}

async function embedText(text) {
    const embedder = await getEmbedder();
    const output = await embedder(text, { pooling: 'mean', normalize: true });
    const vec = Array.from(output.data);
    if (vec.length !== EMBEDDING_DIM) {
        throw new Error(`Embedding dimension mismatch: got ${vec.length}, expected ${EMBEDDING_DIM}`);
    }
    return vec;
}

module.exports = { embedText };
