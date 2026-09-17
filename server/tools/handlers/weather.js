// ============================================
// server/tools/handlers/weather.js — Open-Meteo current + daily forecast
// ============================================
const axios = require('axios');

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

const WMO_LABELS = {
    0: 'Clear',
    1: 'Mostly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Fog',
    48: 'Rime fog',
    51: 'Light drizzle',
    53: 'Drizzle',
    55: 'Heavy drizzle',
    56: 'Freezing drizzle',
    57: 'Freezing drizzle',
    61: 'Light rain',
    63: 'Rain',
    65: 'Heavy rain',
    66: 'Freezing rain',
    67: 'Freezing rain',
    71: 'Light snow',
    73: 'Snow',
    75: 'Heavy snow',
    77: 'Snow grains',
    80: 'Light showers',
    81: 'Showers',
    82: 'Heavy showers',
    85: 'Snow showers',
    86: 'Heavy snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with hail',
    99: 'Thunderstorm with hail',
};

function conditionFromCode(code) {
    return WMO_LABELS[code] || 'Unknown';
}

function clampDays(days) {
    const n = Number.isFinite(days) ? Math.round(days) : 3;
    return Math.min(7, Math.max(1, n));
}

function placeLabel(hit) {
    return [hit.name, hit.admin1, hit.country].filter(Boolean).join(', ');
}

async function geocode(location) {
    const res = await axios.get(GEOCODE_URL, {
        params: { name: location, count: 1, language: 'en' },
        timeout: 10000,
    });
    const hit = res.data?.results?.[0];
    if (!hit) {
        throw new Error(`No location found for "${location}"`);
    }
    return hit;
}

async function fetchForecast(hit, days) {
    const res = await axios.get(FORECAST_URL, {
        params: {
            latitude: hit.latitude,
            longitude: hit.longitude,
            current: 'temperature_2m,weather_code,relative_humidity_2m,wind_speed_10m',
            daily: 'weather_code,temperature_2m_max,temperature_2m_min',
            forecast_days: days,
            timezone: 'auto',
        },
        timeout: 10000,
    });
    return res.data;
}

function buildSnapshot(hit, forecast, days) {
    const current = forecast.current || {};
    const daily = forecast.daily || {};
    const dates = daily.time || [];

    return {
        location: placeLabel(hit),
        latitude: hit.latitude,
        longitude: hit.longitude,
        timezone: forecast.timezone || null,
        updatedAt: current.time || new Date().toISOString(),
        current: {
            temperatureC: current.temperature_2m,
            humidity: current.relative_humidity_2m,
            windKmh: current.wind_speed_10m,
            weatherCode: current.weather_code,
            condition: conditionFromCode(current.weather_code),
        },
        days: dates.slice(0, days).map((date, i) => ({
            date,
            highC: daily.temperature_2m_max?.[i],
            lowC: daily.temperature_2m_min?.[i],
            weatherCode: daily.weather_code?.[i],
            condition: conditionFromCode(daily.weather_code?.[i]),
        })),
    };
}

const definitions = [
    {
        type: 'function',
        function: {
            name: 'get_weather',
            description:
                'Looks up current weather and a short daily forecast for a place, and opens the ' +
                'weather window on the desktop companion. Use whenever the user asks about weather, ' +
                'temperature, or the forecast. Keep your spoken reply brief — the window shows the details.',
            parameters: {
                type: 'object',
                properties: {
                    location: {
                        type: 'string',
                        description: 'City or place name, e.g. "Helsinki" or "Tokyo, JP".',
                    },
                    days: {
                        type: 'number',
                        description: 'How many daily forecast days to include, 1–7. Defaults to 3.',
                    },
                },
                required: ['location'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'close_weather_window',
            description: 'Closes the weather window on the desktop companion if it is open.',
            parameters: { type: 'object', properties: {} },
        },
    },
];

const handlers = {
    async get_weather({ location, days }, _config) {
        const query = typeof location === 'string' ? location.trim() : '';
        if (!query) {
            return { error: 'location is required' };
        }

        const forecastDays = clampDays(days);
        const hit = await geocode(query);
        const forecast = await fetchForecast(hit, forecastDays);
        const data = buildSnapshot(hit, forecast, forecastDays);

        return {
            location: data.location,
            current: data.current,
            days: data.days,
            ui: { window: 'weather', action: 'show', data },
        };
    },

    close_weather_window() {
        return {
            closed: true,
            ui: { window: 'weather', action: 'hide' },
        };
    },
};

module.exports = { definitions, handlers, source: 'Weather' };
