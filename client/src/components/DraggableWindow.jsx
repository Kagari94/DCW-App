import { useRef, useState, useCallback, useEffect } from 'react';

function DraggableWindow({ title, headerExtra, children, initialX = 40, initialY = 40, width = 380 }) {
    const containerRef = useRef(null);
    const [position, setPosition] = useState({ x: initialX, y: initialY });
    const [collapsed, setCollapsed] = useState(false);
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
        setPosition(prev => clampPosition(prev));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        function handleResize() {
            setPosition(prev => clampPosition(prev));
        }
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, [clampPosition]);

    const handleMouseDown = useCallback((e) => {
        if (e.target.closest('.window-toggle') || e.target.closest('.window-header-extra')) return;
        draggingRef.current = true;
        offsetRef.current = { x: e.clientX - position.x, y: e.clientY - position.y };
        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
    }, [position]);

    const handleMouseMove = useCallback((e) => {
        if (!draggingRef.current) return;
        const raw = { x: e.clientX - offsetRef.current.x, y: e.clientY - offsetRef.current.y };
        setPosition(clampPosition(raw));
    }, [clampPosition]);

    const handleMouseUp = useCallback(() => {
        draggingRef.current = false;
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
    }, [handleMouseMove]);

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