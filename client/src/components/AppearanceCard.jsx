import UploadField from './settings/UploadField';

export default function AppearanceCard({ name, imageUrl, selected, disabled = false, onSelect, onUpload, onError }) {
    return <article className={`appearance-card${selected ? ' selected' : ''}`}>
        <UploadField label={`${name} image`} hideLabel accept=".png,.jpg,.jpeg,.webp" className="appearance-preview"
            disabled={disabled || !onUpload} onUpload={onUpload} onError={onError}>
            {imageUrl ? <img src={imageUrl} alt={name} loading="lazy" /> : <span className="appearance-placeholder">👤</span>}
            {onUpload && <span className="appearance-image-hint">{imageUrl ? 'Change image' : '+ Add image'}</span>}
        </UploadField>
        <button type="button" className="appearance-choice" disabled={disabled} aria-pressed={selected}
            onClick={onSelect} title={name}>
            <span>{name}</span>{selected && <span className="appearance-selected">Selected</span>}
        </button>
    </article>;
}
