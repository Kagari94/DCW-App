function formatTemp(value) {
    if (value == null || Number.isNaN(Number(value))) return '—';
    return `${Math.round(Number(value))}°`;
}

function formatDay(dateStr) {
    if (!dateStr) return '';
    const date = new Date(`${dateStr}T00:00:00`);
    if (Number.isNaN(date.getTime())) return dateStr;
    return date.toLocaleDateString(undefined, { weekday: 'short' });
}

function formatUpdated(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function WeatherPanel({ data }) {
    if (!data) return null;

    const current = data.current || {};
    const days = data.days || [];

    return (
        <div className="weather-panel">
            <div className="weather-location">{data.location}</div>
            <div className="weather-current-row">
                <span className="weather-temp">{formatTemp(current.temperatureC)}</span>
                <span className="weather-condition">{current.condition || '—'}</span>
            </div>
            {(current.humidity != null || current.windKmh != null) && (
                <div className="weather-meta">
                    {current.humidity != null && `Humidity ${Math.round(current.humidity)}%`}
                    {current.humidity != null && current.windKmh != null && ' · '}
                    {current.windKmh != null && `Wind ${Math.round(current.windKmh)} km/h`}
                </div>
            )}
            {days.length > 0 && (
                <div className="weather-days">
                    {days.map((day) => (
                        <div key={day.date} className="weather-day-row">
                            <span className="weather-day-name">{formatDay(day.date)}</span>
                            <span className="weather-day-condition">{day.condition}</span>
                            <span className="weather-day-temp">
                                {formatTemp(day.highC)} / {formatTemp(day.lowC)}
                            </span>
                        </div>
                    ))}
                </div>
            )}
            {data.updatedAt && (
                <div className="weather-updated">Updated {formatUpdated(data.updatedAt)}</div>
            )}
        </div>
    );
}

export default WeatherPanel;