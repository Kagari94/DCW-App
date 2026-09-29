import { useState } from 'react';
import useHeaderIconOverflow from '../hooks/useHeaderIconOverflow';

// Renders `items` (each { id, title, content, menuContent? }) inline, in a
// user-draggable order, collapsing whatever doesn't currently fit into a
// dropdown behind a chevron — reuses ToolsMenu's own dropdown look
// (.tools-menu-dropdown) so it doesn't introduce a third visual style.
// `menuContent`, if given, is what renders instead of `content` when an
// item is inside the overflow dropdown rather than sitting inline —
// needed for any item (like ToolsMenu) that has its own floating dropdown,
// since that dropdown's position math assumes it lives directly in the
// header, not nested inside another already-floating panel.
// Drag a chip (inline OR from inside the dropdown) onto another one to
// move it to that position in the order — since fit is order-driven,
// dragging something earlier can pull it out of the dropdown, and
// dragging something later can push it in.
function OverflowIconBar({ items, storageKey }) {
    const {
        containerRef, itemRefs, chevronRef,
        visibleIds, overflowIds, moveItem,
    } = useHeaderIconOverflow(items, storageKey);

    const [open, setOpen] = useState(false);
    const [dragId, setDragId] = useState(null);
    const byId = Object.fromEntries(items.map(i => [i.id, i]));
    const orderedAll = [...visibleIds, ...overflowIds];

    function dragHandlers(id) {
        return {
            draggable: true,
            onDragStart: () => setDragId(id),
            onDragOver: (e) => e.preventDefault(),
            onDrop: (e) => {
                e.preventDefault();
                if (dragId && dragId !== id) {
                    moveItem(dragId, orderedAll.indexOf(id));
                }
                setDragId(null);
            },
            onDragEnd: () => setDragId(null),
        };
    }

    const stopDrag = (e) => e.stopPropagation(); // don't let DraggableWindow start dragging the whole window

    return (
        <div className="overflow-bar" ref={containerRef} onMouseDown={stopDrag} onPointerDown={stopDrag}>
            {visibleIds.map(id => (
                <span key={id} className="overflow-bar-item" {...dragHandlers(id)}>
                    {byId[id]?.content}
                </span>
            ))}

            {overflowIds.length > 0 && (
                <div className="overflow-bar-menu">
                    <button
                        type="button"
                        className="tools-menu-toggle overflow-bar-chevron"
                        onClick={() => setOpen(o => !o)}
                        title="More"
                    >
                        ▾
                    </button>
                    {open && (
                        <div className="tools-menu-dropdown overflow-bar-dropdown" onWheel={stopDrag}>
                            {overflowIds.map(id => (
                                <div key={id} className="overflow-bar-dropdown-item" {...dragHandlers(id)}>
                                    <span className="overflow-bar-dropdown-icon">
                                        {byId[id]?.menuContent ?? byId[id]?.content}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}

            {/* Hidden measurement row — every item rendered off-screen in
                its inline "chip" form, purely so its true width is known
                even while it's currently living in the overflow dropdown.
                Always uses `content` (the inline form) since fit is about
                how wide the item would be if shown in the bar, regardless
                of where it actually ends up rendering. */}
            <div className="overflow-bar-measure" aria-hidden="true">
                {items.map(i => (
                    <span key={i.id} ref={(el) => { itemRefs.current[i.id] = el; }}>{i.content}</span>
                ))}
                <span ref={chevronRef} className="tools-menu-toggle overflow-bar-chevron">▾</span>
            </div>
        </div>
    );
}

export default OverflowIconBar;