const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const AUTH_PATH = path.join(__dirname, 'data', 'auth.json');

function ensureToken() {
    const dir = path.dirname(AUTH_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (!fs.existsSync(AUTH_PATH)) {
        const token = crypto.randomBytes(24).toString('hex');
        fs.writeFileSync(AUTH_PATH, JSON.stringify({ token }, null, 2));
        console.log('\n🔑 Generated new access token — enter this on each device:');
        console.log(`   ${token}\n`);
        return token;
    }

    const { token } = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8'));
    console.log('\n🔑 Access token (unchanged):', token, '\n');
    return token;
}

const currentToken = ensureToken();

function requireAuth(req, res, next) {
    const provided = req.headers['x-app-token'];
    if (provided !== currentToken) {
        return res.status(401).json({ error: 'Unauthorized — missing or incorrect access token.' });
    }
    next();
}

module.exports = { requireAuth, getToken: () => currentToken };