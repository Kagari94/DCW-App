// Only health probes may fail over. A lost response must never replay a mutation.
export function createApiFetch({ origins, fetchImpl = globalThis.fetch, probeTimeout = 4000 }) {
    let workingOrigin;

    async function resolveOrigin(signal) {
        for (const origin of origins) {
            signal?.throwIfAborted();
            const controller = new AbortController();
            const abort = () => controller.abort(signal.reason);
            signal?.addEventListener('abort', abort, { once: true });
            const timer = setTimeout(() => controller.abort(), probeTimeout);
            try {
                const response = await fetchImpl(`${origin}/health`, { signal: controller.signal });
                if (response.ok) return origin;
            } catch (error) {
                signal?.throwIfAborted();
                if (error.name === 'AbortError' && !controller.signal.aborted) throw error;
            } finally {
                clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
            }
        }
        throw new Error('Backend unreachable. Check the server and HTTPS proxy.');
    }

    return async function apiFetch(path, options = {}) {
        options.signal?.throwIfAborted();
        const origin = workingOrigin || await resolveOrigin(options.signal);
        options.signal?.throwIfAborted();
        workingOrigin = origin;
        try {
            return await fetchImpl(`${origin}${path}`, options);
        } catch (error) {
            if (!options.signal?.aborted) workingOrigin = undefined;
            throw error;
        }
    };
}
