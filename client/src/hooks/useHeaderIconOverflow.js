import { useRef, useState, useLayoutEffect, useCallback, useEffect } from 'react';
import { getPref, setPref } from '../utils/localPrefs';

// Generic "priority+" overflow bar logic: given an ordered list of item
// ids, measures how many fit in the currently available inline width (in
// order) and reports the rest as overflow — same idea as a browser
// bookmarks bar collapsing extra bookmarks into a ">>" menu. Order is
// user-draggable (see moveItem) and persisted under `storageKey`, so
// reordering also changes which items are among the first few that fit.
// Widths are read from a HIDDEN, always-fully-rendered measurement row
// the caller renders alongside the visible one — this is the only
// reliable way to know an item's "inline chip" width even while it's
// currently sitting in the overflow dropdown instead.
export default function useHeaderIconOverflow(items, storageKey) {
    const allIds = items.map(i => i.id);
    const [order, setOrder] = useState(() => {
        const saved = getPref(storageKey, null);
        if (!Array.isArray(saved)) return allIds;
        // Merge saved order with the current item set — new ids (a
        // feature added later) append at the end; removed ids just drop
        // out — so this never needs manual migration.
        const known = saved.filter(id => allIds.includes(id));
        const missing = allIds.filter(id => !known.includes(id));
        return [...known, ...missing];
    });

    useEffect(() => {
        setPref(storageKey, order);
    }, [order, storageKey]);

    const containerRef = useRef(null);
    const itemRefs = useRef({});
    const chevronRef = useRef(null);
    const [visibleCount, setVisibleCount] = useState(allIds.length);

    const recompute = useCallback(() => {
        const container = containerRef.current;
        if (!container) return;
        const available = container.clientWidth;

        const widths = order.map(id => itemRefs.current[id]?.offsetWidth || 0);
        const chevronWidth = chevronRef.current?.offsetWidth || 0;

        let total = 0;
        let fit = 0;
        for (let i = 0; i < widths.length; i++) {
            total += widths[i];
            // Reserve room for the chevron unless this is the last item —
            // no point reserving space for a dropdown with nothing in it.
            const reserve = i < widths.length - 1 ? chevronWidth : 0;
            if (total + reserve > available) break;
            fit = i + 1;
        }
        setVisibleCount(Math.max(fit, 1)); // never fully empty
    }, [order]);

    useLayoutEffect(() => {
        recompute();
    }, [recompute]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container || typeof ResizeObserver === 'undefined') return;
        const ro = new ResizeObserver(() => recompute());
        ro.observe(container);
        return () => ro.disconnect();
    }, [recompute]);

    const visibleIds = order.slice(0, visibleCount);
    const overflowIds = order.slice(visibleCount);

    function moveItem(id, toIndex) {
        setOrder(prev => {
            const next = prev.filter(x => x !== id);
            next.splice(toIndex, 0, id);
            return next;
        });
    }

    return { containerRef, itemRefs, chevronRef, visibleIds, overflowIds, moveItem };
}