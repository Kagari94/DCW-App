// ============================================
// server/lib/memory/embeddings.js — local embedding model
// ============================================
const MODEL_ID = process.env.COMPANION_MEMORY_EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2';

let pipelinePromise = null;
let ready = false;

// Lazy singleton — @huggingface/transformers is ESM-only, hence the dynamic
// import from this CommonJS file. The model (~90MB) downloads from Hugging
// Face to the local transformers.js cache on first use only; every call
// after that is fully local/offline, same machine, no LM Studio involved.
async function getEmbedder() {
    if (!pipelinePromise) {
        pipelinePromise = (async () => {
            const { pipeline } = await import('@huggingface/transformers');
            const embedder = await pipeline('feature-extraction', MODEL_ID);
            ready = true;
            return embedder;
        })().catch(error => { pipelinePromise = null; ready = false; throw error; });
    }
    return pipelinePromise;
}

async function embedText(text) {
    const embedder = await getEmbedder();
    const output = await embedder(text, { pooling: 'mean', normalize: true });
    const vec = Array.from(output.data);
    if (!vec.length || vec.some(value => !Number.isFinite(value))) throw new Error('Invalid embedding');
    return vec;
}

module.exports = { embedText, getEmbedder, isEmbedderReady: () => ready,
    MODEL_ID: `${MODEL_ID}:mean:normalized:v1` };
