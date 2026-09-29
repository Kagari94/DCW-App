import { useEffect, useState } from 'react';
import { authHeaders } from '../utils/authToken';
import { apiFetch } from '../apiConfig';

export default function ToolsMenu({ embedded = false }) {
    const [tools, setTools] = useState([]);
    const [open, setOpen] = useState(false);
    const [error, setError] = useState(null);
    const [expandedGroups, setExpandedGroups] = useState(() => new Set());

    useEffect(() => {
        apiFetch('/api/tools', { headers: authHeaders() })
            .then(res => res.json())
            .then(data => setTools(data.tools ?? []))
            .catch(err => setError(err.message));
    }, []);

    const grouped = tools.reduce((acc, tool) => {
        (acc[tool.source] ??= []).push(tool);
        return acc;
    }, {});

    function toggleGroup(source) {
        setExpandedGroups(prev => {
            const next = new Set(prev);
            if (next.has(source)) next.delete(source);
            else next.add(source);
            return next;
        });
    }

    const stopDrag = (e) => e.stopPropagation();

    const listContent = (
        <>
            {error && <div className="tools-menu-error">Couldn't load tools: {error}</div>}
            {!error && tools.length === 0 && <div>No tools loaded.</div>}
            {Object.entries(grouped).map(([source, list]) => {
                const isExpanded = expandedGroups.has(source);
                return (
                    <div key={source} className="tools-menu-group">
                        <button type="button" className="tools-menu-group-header"
                            aria-expanded={isExpanded} onClick={() => toggleGroup(source)}>
                            <span>{source}</span>
                            <span className="tools-menu-group-count">
                                {list.length} {isExpanded ? '▾' : '▸'}
                            </span>
                        </button>
                        {isExpanded && (
                            <div className="tools-menu-group-items">
                                {list.map(tool => (
                                    <div key={tool.name} className="tools-menu-item" title={tool.description}>
                                        {tool.name}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                );
            })}
        </>
    );

    return (
        <div className={embedded ? 'tools-menu tools-menu-embedded' : 'tools-menu'}
            onMouseDown={stopDrag} onPointerDown={stopDrag}>
            <button
                type="button"
                className="tools-menu-toggle"
                onClick={() => setOpen(o => !o)}
                aria-expanded={open}
                title="Tools available to the AI"
            >
                <span>🔧 {embedded && 'Tools menu · '}{Object.keys(grouped).length}</span>
                {embedded && <span>{open ? '▾' : '▸'}</span>}
            </button>

            {open && (
                // Embedded mode uses the overflow menu's existing panel and
                // scrolling; only the standalone menu needs a popup shell.
                <div className={embedded ? 'tools-menu-list' : 'tools-menu-dropdown'} onWheel={stopDrag}>
                    {listContent}
                </div>
            )}
        </div>
    );
}
