'use strict';

const fs = require('node:fs');
const path = require('node:path');
const envPath = path.join(__dirname, '.env');
const examplePath = path.join(__dirname, '.env.example');

function createEnvFile() {
    const template = fs.existsSync(examplePath)
        ? fs.readFileSync(examplePath, 'utf8')
        : 'PORT=3008\nHOST=0.0.0.0\nSESSION_DIR=/data/session\nRUNTIME_CONFIG_PATH=/data/bridge-config.json\nLOG_LEVEL=silent\nTZ=Europe/Berlin\n';

    fs.writeFileSync(envPath, template, { encoding: 'utf8', flag: 'wx' });

    console.log('Created .env for this installation.');
    console.log('Generate the one-time pairing code later in the web UI before connecting the ioBroker adapter.');
}

if (fs.existsSync(envPath)) {
    console.log('.env already exists. Nothing changed.');
    process.exit(0);
}

createEnvFile();
