import { useRef, useState } from 'react';
export default function UploadField({ label, accept, onUpload, onError, children, disabled = false, className = '', hideLabel = false }) {
    const input = useRef(null);
    const busyRef = useRef(false);
    const [busy, setBusy] = useState(false);
    const [dragging, setDragging] = useState(false);
    async function upload(file) {
        if (!file || disabled || busyRef.current) return;
        if (!accept.split(',').some(ext => file.name.toLowerCase().endsWith(ext.trim()))) {
            return onError(`Only ${accept} files are supported.`);
        }
        busyRef.current = true;
        setBusy(true);
        try { await onUpload(file); }
        catch (error) { onError(error.message); }
        finally { busyRef.current = false; setBusy(false); }
    }
    return <div>
        {!hideLabel && <label className="settings-label">{label}</label>}
        <button type="button" disabled={busy || disabled} className={`settings-dropzone ${className}${dragging ? ' dragging' : ''}`}
            aria-label={label}
            onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
            onDrop={e => { e.preventDefault(); setDragging(false); upload(e.dataTransfer.files?.[0]); }}
            onClick={() => input.current?.click()}>
            {busy ? 'Uploading...' : children || `Drag & drop a ${accept} file here, or click to browse`}
        </button>
        <input ref={input} type="file" accept={accept} className="hidden-input"
            onChange={e => { upload(e.target.files?.[0]); e.target.value = ''; }} />
    </div>;
}
