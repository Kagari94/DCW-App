const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
function check(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'data') continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) check(file);
        else if (entry.name.endsWith('.js')) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    }
}
check(path.join(__dirname, '../server'));
console.log('Server syntax checks passed.');
