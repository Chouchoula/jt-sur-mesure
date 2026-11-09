#!/usr/bin/env node
/**
 * Télécharge FFmpeg.wasm dans ./vendor pour un fonctionnement hors-ligne.
 * Usage : node prepare-vendor.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, 'vendor', 'ffmpeg');

const FFMPEG_VERSION = '0.12.10';
const UTIL_VERSION = '0.12.1';
const CORE_VERSION = '0.12.6';

const packages = [
    { scope: '@ffmpeg/ffmpeg', version: FFMPEG_VERSION, target: 'ffmpeg' },
    { scope: '@ffmpeg/util', version: UTIL_VERSION, target: 'util' }
];

const FALLBACK_FILES = {
    '@ffmpeg/ffmpeg': ['/dist/esm/classes.js', '/dist/esm/const.js', '/dist/esm/errors.js', '/dist/esm/index.js', '/dist/esm/types.js', '/dist/esm/worker.js'],
    '@ffmpeg/util': ['/dist/esm/const.js', '/dist/esm/errors.js', '/dist/esm/index.js']
};

const CORE_FILES = [
    { file: 'ffmpeg-core.js', mime: 'text/javascript' },
    { file: 'ffmpeg-core.wasm', mime: 'application/wasm' }
];

const CORE_DIST = 'esm';
const HOSTS = [
    'https://cdn.jsdelivr.net/npm',
    'https://unpkg.com'
];

async function fetchWithRetry(url, attempts = 3) {
    let lastError = null;
    for (let i = 0; i < attempts; i++) {
        try {
            const res = await fetch(url, { redirect: 'follow' });
            if (res.ok) return res;
            lastError = new Error('HTTP ' + res.status + ' sur ' + url);
        } catch (e) {
            lastError = e;
        }
        await new Promise(r => setTimeout(r, 800 * (i + 1)));
    }
    throw lastError || new Error('Téléchargement impossible : ' + url);
}

async function download(url, destination) {
    const res = await fetchWithRetry(url);
    const data = Buffer.from(await res.arrayBuffer());
    if (!data.length) throw new Error('Fichier vide : ' + url);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, data);
    return data.length;
}

async function listEsmFiles(scope, version) {
    try {
        const res = await fetchWithRetry('https://data.jsdelivr.com/v1/package/npm/' + scope + '@' + version + '/flat', 2);
        const json = await res.json();
        const files = (json.files || [])
            .map(f => f.name)
            .filter(name => name.startsWith('/dist/esm/') && /\.(js|mjs)$/.test(name) && !name.endsWith('.map'));
        if (files.length) return files;
    } catch (e) {
        console.warn('  Liste jsDelivr indisponible, utilisation de la liste connue.');
    }
    return FALLBACK_FILES[scope] || [];
}

async function downloadWithHosts(relativeUrl, destination) {
    let lastError = null;
    for (const host of HOSTS) {
        try {
            return await download(host + relativeUrl, destination);
        } catch (e) {
            lastError = e;
            console.warn('  Échec ' + host + ' — ' + e.message);
        }
    }
    throw lastError;
}

async function main() {
    console.log('Préparation de FFmpeg hors-ligne dans ' + root);
    let total = 0;

    for (const pkg of packages) {
        console.log('\n' + pkg.scope + '@' + pkg.version);
        const files = await listEsmFiles(pkg.scope, pkg.version);
        if (!files.length) throw new Error('Aucun fichier ESM trouvé pour ' + pkg.scope);
        for (const file of files) {
            const destination = path.join(root, pkg.target, file.replace('/dist/esm/', ''));
            const relative = '/' + pkg.scope + '@' + pkg.version + file;
            const size = await downloadWithHosts(relative, destination);
            total += size;
            console.log('  ✓ ' + path.relative(root, destination) + ' (' + Math.round(size / 1024) + ' Ko)');
        }
    }

    console.log('\n@ffmpeg/core@' + CORE_VERSION);
    for (const entry of CORE_FILES) {
        const destination = path.join(root, 'core', entry.file);
        const relative = '/@ffmpeg/core@' + CORE_VERSION + '/dist/' + CORE_DIST + '/' + entry.file;
        const size = await downloadWithHosts(relative, destination);
        total += size;
        console.log('  ✓ ' + path.relative(root, destination) + ' (' + Math.round(size / 1024 / 1024 * 10) / 10 + ' Mo)');
    }

    console.log('\nTerminé — ' + Math.round(total / 1024 / 1024 * 10) / 10 + ' Mo dans ' + root);
    console.log('L\'application utilisera ces fichiers en priorité, sans CDN.');
}

main().catch(error => {
    console.error('\nÉchec : ' + error.message);
    process.exitCode = 1;
});
