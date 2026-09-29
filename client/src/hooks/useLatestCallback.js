import { useCallback, useLayoutEffect, useRef } from 'react';

// Stable listener identity, updated only after React commits the latest render.
export default function useLatestCallback(callback) {
    const latest = useRef(callback);
    useLayoutEffect(() => { latest.current = callback; });
    return useCallback((...args) => latest.current?.(...args), []);
}
