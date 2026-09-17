// ============================================
// server/tools/handlers/music.js — Pi-calling play/stop/volume tools
// ============================================
const axios = require('axios');

// Every handler in this file goes through this one function — config always
// comes from the `config` argument (which traces back to getSettings() via
// toolCallLoop.js), never from process.env directly. Keeping this as the
// single call site is what prevents handlers drifting out of sync with each
// other on which PI_BASE_URL/PI_APP_TOKEN they actually use.
async function callPi(config, endpoint, body) {
    const res = await axios.post(`${config.PI_BASE_URL}${endpoint}`, body ?? {}, {
        headers: { 'x-app-token': config.PI_APP_TOKEN, 'Content-Type': 'application/json' },
    });
    return res.data;
}

const definitions = [
    {
        type: 'function',
        function: {
            name: 'play_music',
            description:
                'Plays music through the home stereo, via the Raspberry Pi speaker. Can play the ' +
                "user's Liked Songs, one of the user's own playlists by name, or search Spotify's " +
                'public catalog for a playlist.',
            parameters: {
                type: 'object',
                properties: {
                    liked_songs: {
                        type: 'boolean',
                        description:
                            'Set true to play the user\'s Spotify Liked/Saved Songs. If true, ' +
                            'playlist and scope are ignored. Use this whenever the user says things ' +
                            'like "play my liked songs" or "play my favorites".',
                    },
                    playlist: {
                        type: 'string',
                        description:
                            'Playlist name to look up, or an exact spotify:playlist:... URI. ' +
                            'Ignored if liked_songs is true.',
                    },
                    scope: {
                        type: 'string',
                        enum: ['mine', 'public'],
                        description:
                            '"mine" (default) matches playlist by name against the user\'s own library ' +
                            '(owned or followed) — use this whenever the user refers to "my" playlist. ' +
                            '"public" searches Spotify\'s public catalog instead — use this for playlists ' +
                            'the user doesn\'t own, e.g. "play some lofi beats".',
                    },
                },
                required: [],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'stop_music',
            description: 'Stops whatever is currently playing on the home stereo.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'set_volume',
            description: 'Sets the home stereo volume.',
            parameters: {
                type: 'object',
                properties: {
                    percent: { type: 'number', description: 'Volume from 0 to 100' },
                },
                required: ['percent'],
            },
        },
    },
];

const handlers = {
    play_music: ({ playlist, scope, liked_songs }, config) =>
        callPi(config, '/play', { playlist, scope, liked_songs }),
    stop_music: (args, config) => callPi(config, '/stop'),
    set_volume: ({ percent }, config) => callPi(config, '/volume', { percent }),
};

module.exports = { definitions, handlers };