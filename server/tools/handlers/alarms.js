// ============================================
// server/tools/handlers/alarms.js — Pi-calling alarm tools
// ============================================
const axios = require('axios');

async function piRequest(config, method, endpoint, body) {
    const res = await axios({
        method,
        url: `${config.PI_BASE_URL}${endpoint}`,
        data: body,
        headers: { 'x-app-token': config.PI_APP_TOKEN, 'Content-Type': 'application/json' },
    });
    return res.data;
}

const definitions = [
    {
        type: 'function',
        function: {
            name: 'set_alarm',
            description:
                'Sets a daily alarm that plays music through the home stereo at a given time. Can ' +
                "target the user's Liked Songs, one of their own playlists by name, or a public " +
                'Spotify playlist.',
            parameters: {
                type: 'object',
                properties: {
                    time: { type: 'string', description: '24-hour time as HH:MM, e.g. "07:00"' },
                    liked_songs: {
                        type: 'boolean',
                        description: 'Set true to play Liked Songs when this alarm fires. If true, playlist/scope are ignored.',
                    },
                    playlist: {
                        type: 'string',
                        description: 'Playlist name or spotify:playlist:... URI. Ignored if liked_songs is true.',
                    },
                    scope: {
                        type: 'string',
                        enum: ['mine', 'public'],
                        description:
                            '"mine" (default) matches against the user\'s own playlists. "public" ' +
                            'searches Spotify\'s public catalog instead.',
                    },
                    id: {
                        type: 'string',
                        description: 'Optional — pass an existing alarm id to edit it instead of creating a new one',
                    },
                },
                required: ['time'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'cancel_alarm',
            description: 'Cancels a previously set alarm by its id. Use list_alarms first if the id is unknown.',
            parameters: {
                type: 'object',
                properties: { id: { type: 'string' } },
                required: ['id'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'list_alarms',
            description: 'Lists all currently scheduled alarms, with their ids, times, and what they play.',
            parameters: { type: 'object', properties: {} },
        },
    },
];

const handlers = {
    set_alarm: ({ time, playlist, scope, liked_songs, id }, config) =>
        piRequest(config, 'post', '/alarms', { time, playlist, scope, liked_songs, id }),
    cancel_alarm: ({ id }, config) => piRequest(config, 'delete', `/alarms/${id}`),
    list_alarms: (args, config) => piRequest(config, 'get', '/alarms'),
};

module.exports = { definitions, handlers };