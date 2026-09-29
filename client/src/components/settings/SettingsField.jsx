export default function SettingsField({ label, children, ...props }) {
    return <label className="settings-field">
        <span className="settings-label">{label}</span>
        {children ? <select className="settings-select" {...props}>{children}</select>
            : <input className="settings-select" {...props} />}
    </label>;
}
