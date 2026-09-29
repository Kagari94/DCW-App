import { useRef, useState } from 'react';
export default function UploadField({ label, accept, onUpload, onError }) {
    const input = useRef(null);
    const busyRef = useRef(false);
    const [busy, setBusy] = useState(false);
    const [dragging, setDragging] = useState(false);
    async function upload(file) {
        if (!file || busyRef.current) return;
        if (!file.name.toLowerCase().endsWith(accept)) return onError(`Only ${accept} files are supported.`);
        busyRef.current = true;
        setBusy(true);
        try { await onUpload(file); }
        catch (error) { onError(error.message); }
        finally { busyRef.current = false; setBusy(false); }
    }
    return <div>
        <label className="settings-label">{label}</label>
        <button type="button" disabled={busy} className={`settings-dropzone${dragging ? ' dragging' : ''}`}
            onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
            onDrop={e => { e.preventDefault(); setDragging(false); upload(e.dataTransfer.files?.[0]); }}
            onClick={() => input.current?.click()}>
            {busy ? 'Uploading...' : `Drag & drop a ${accept} file here, or click to browse`}
        </button>
        <input ref={input} type="file" accept={accept} className="hidden-input"
            onChange={e => { upload(e.target.files?.[0]); e.target.value = ''; }} />
    </div>;
}
