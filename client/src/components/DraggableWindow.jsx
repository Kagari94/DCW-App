import { useRef, useState, useCallback, useEffect } from 'react';
import { getPref, setPref } from '../utils/localPrefs';

// `persistKey` (falls back to `title`) is the localStorage key this
// window's position + collapsed state is remembered under — restored on
// mount, saved on every change. Each window's titles here ("Chat",
// "Weather", "Flashcard Review", "Settings") are already stable strings,
// so the default is normally enough; pass persistKey explicitly only if
// two windows might ever share a title.
function DraggableWindow({ title, persistKey, headerExtra, children, initialX = 40, initialY = 40, width = 380 }) {
    const storageKey = `window:${persistKey || title}`;
    const [saved] = useState(() => getPref(storageKey, null));

    const containerRef = useRef(null);
    const [position, setPosition] = useState(() => ({
        x: saved?.x ?? initialX,
        y: saved?.y ?? initialY,
    }));
    const [collapsed, setCollapsed] = useState(saved?.collapsed ?? false);
    const draggingRef = useRef(false);
    const offsetRef = useRef({ x: 0, y: 0 });

    const clampPosition = useCallback((pos) => {
        const el = containerRef.current;
        const w = el?.offsetWidth ?? width;
        const h = el?.offsetHeight ?? 200;
        const maxX = Math.max(0, window.innerWidth - w);
        const maxY = Math.max(0, window.innerHeight - h);
        return {
            x: Math.min(Math.max(0, pos.x), maxX),
            y: Math.min(Math.max(0, pos.y), maxY),
        };
    }, [width]);

    useEffect(() => {
        function handleMouseMove(e) {
            if (!draggingRef.current) return;
            setPosition(clampPosition({
                x: e.clientX - offsetRef.current.x,
                y: e.clientY - offsetRef.current.y,
            }));
        }
        function handleMouseUp() {
            draggingRef.current = false;
        }
        function handleResize() {
            setPosition(prev => clampPosition(prev));
        }
        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
        window.addEventListener('resize', handleResize);
        const frame = window.requestAnimationFrame(handleResize);
        return () => {
            window.cancelAnimationFrame(frame);
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
            window.removeEventListener('resize', handleResize);
        };
    }, [clampPosition]);

    // Persist position + collapsed state on every change.
    useEffect(() => {
        setPref(storageKey, { x: position.x, y: position.y, collapsed });
    }, [storageKey, position.x, position.y, collapsed]);

    const handleMouseDown = useCallback((e) => {
        if (e.target.closest('.window-toggle') || e.target.closest('.window-header-extra')) return;
        draggingRef.current = true;
        offsetRef.current = { x: e.clientX - position.x, y: e.clientY - position.y };
    }, [position]);

    return (
        <div
            ref={containerRef}
            className="draggable-window"
            style={{
                left: position.x,
                top: position.y,
                width: collapsed ? 'auto' : width,
            }}
        >
            <div className="draggable-window-header" onMouseDown={handleMouseDown}>
                <span className="draggable-window-title">{title}</span>
                {!collapsed && headerExtra && (
                    <div className="window-header-extra draggable-window-header-extra">
                        {headerExtra}
                    </div>
                )}
                <button
                    className="window-toggle draggable-window-toggle"
                    onClick={() => setCollapsed(prev => !prev)}
                >
                    {collapsed ? '+' : '−'}
                </button>
            </div>
            {!collapsed && (
                <div
                    className="draggable-window-body"
                    style={{ maxHeight: `calc(100vh - ${position.y}px - 60px)` }}
                >
                    {children}
                </div>
            )}
        </div>
    );
}

export default DraggableWindow;
