export default function HeaderToggle({ icon, label, active, onClick, inMenu = false, disabled = false }) {
    return <button type="button" className={`tools-menu-toggle header-toggle${inMenu ? ' header-toggle-menu' : ''}`}
        onClick={onClick} disabled={disabled} aria-label={label} aria-pressed={active} title={label}>
        <span className="header-toggle-icon" aria-hidden="true">{icon}</span>
        {inMenu && <span className="header-toggle-label">{label}</span>}
        <span className="header-toggle-switch" aria-hidden="true"><span /></span>
    </button>;
}
