import { useEffect, useState } from 'react';
import { authHeaders } from '../utils/authToken';

const API_BASE = `http://${window.location.hostname}:3000/api`;

export default function ToolsMenu() {
    const [tools, setTools] = useState([]);
    const [open, setOpen] = useState(false);
    const [error, setError] = useState(null);
    const [expandedGroups, setExpandedGroups] = useState(() => new Set());

    useEffect(() => {
        fetch(`${API_BASE}/tools`, { headers: authHeaders() })
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

    return (
        <div className="tools-menu" onMouseDown={stopDrag} onPointerDown={stopDrag}>
            <button
                className="tools-menu-toggle"
                onClick={() => setOpen(o => !o)}
                title="Tools available to the AI"
            >
                🔧 {Object.keys(grouped).length}
            </button>

            {open && (
                <div className="tools-menu-dropdown" onWheel={stopDrag}>
                    {error && <div className="tools-menu-error">Couldn't load tools: {error}</div>}
                    {!error && tools.length === 0 && <div>No tools loaded.</div>}
                    {Object.entries(grouped).map(([source, list]) => {
                        const isExpanded = expandedGroups.has(source);
                        return (
                            <div key={source} className="tools-menu-group">
                                <div className="tools-menu-group-header" onClick={() => toggleGroup(source)}>
                                    <span>{source}</span>
                                    <span className="tools-menu-group-count">
                                        {list.length} {isExpanded ? '▾' : '▸'}
                                    </span>
                                </div>
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
                </div>
            )}
        </div>
    );
}