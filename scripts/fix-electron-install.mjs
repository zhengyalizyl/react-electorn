import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { downloadArtifact } from '@electron/get';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electronDir = path.join(rootDir, 'apps/desktop/node_modules/electron');
const electronPackagePath = path.join(electronDir, 'package.json');
const electronPackage = JSON.parse(fs.readFileSync(electronPackagePath, 'utf8'));
const platform = process.env.npm_config_platform || process.platform;
const arch = process.env.npm_config_arch || process.arch;
const mirror =
    process.env.ELECTRON_MIRROR ||
    process.env.npm_config_electron_mirror ||
    'https://npmmirror.com/mirrors/electron/';

const platformPathByName = {
    darwin: 'Electron.app/Contents/MacOS/Electron',
    freebsd: 'electron',
    linux: 'electron',
    openbsd: 'electron',
    win32: 'electron.exe'
};

const platformPath = platformPathByName[platform];

if (!platformPath) {
    throw new Error(`Electron builds are not available on platform: ${platform}`);
}

const zipPath = await downloadArtifact({
    version: electronPackage.version,
    artifactName: 'electron',
    platform,
    arch,
    force: true,
    mirrorOptions: {
        mirror
    }
});

const distDir = path.join(electronDir, 'dist');
fs.mkdirSync(distDir, { recursive: true });

execFileSync('unzip', ['-o', '-q', zipPath, '-d', distDir], {
    stdio: 'inherit'
});

fs.writeFileSync(path.join(electronDir, 'path.txt'), platformPath);

const electronExecutable = path.join(distDir, platformPath);

if (!fs.existsSync(electronExecutable)) {
    throw new Error(`Electron executable was not found: ${electronExecutable}`);
}

if (os.platform() !== 'win32') {
    fs.chmodSync(electronExecutable, 0o755);
}

console.log(`Electron ${electronPackage.version} installed at ${electronExecutable}`);
