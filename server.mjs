#!/usr/bin/env node
/**
 * JT Chatons Studio — relais local sécurisé.
 *
 * - Sert l'application (index.html, vendor/, etc.).
 * - Relaie /api/agnes/* vers https://apihub.agnes-ai.com sans exposer la clé.
 * - Expose /api/tts : synthèse vocale locale (Windows SAPI, macOS say, Linux espeak).
 *
 * Démarrage :
 *   node server.mjs
 *   puis http://127.0.0.1:8787
 *
 * Variables d'environnement (ou fichier .env) :
 *   AGNES_API_KEY=sk-...            (obligatoire pour générer)
 *   AGNES_API_KEYS=sk-1,sk-2        (rotation optionnelle)
 *   PORT=8787
 *   HOST=127.0.0.1
 *   AGNES_UPSTREAM=https://apihub.agnes-ai.com
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '2.0';

/* ------------------------------------------------------------------ config */

function loadEnvFile() {
    const file = path.join(__dirname, '.env');
    if (!fs.existsSync(file)) return;
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (!match || line.trim().startsWith('#')) continue;
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (!(match[1] in process.env)) process.env[match[1]] = value;
    }
}

loadEnvFile();

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const UPSTREAM = (process.env.AGNES_UPSTREAM || 'https://apihub.agnes-ai.com').replace(/\/+$/, '');
const UPSTREAM_HOST = new URL(UPSTREAM).host;

const keys = String(process.env.AGNES_API_KEYS || process.env.AGNES_API_KEY || '')
    .split(/[\n,;]+/)
    .map(k => k.trim())
    .filter(Boolean);

let keyIndex = 0;

/* ---------------------------------------------------------------------- tts */

function commandExists(command) {
    const checker = process.platform === 'win32' ? 'where' : 'which';
    try {
        return spawnSync(checker, [command], { stdio: 'ignore', windowsHide: true }).status === 0;
    } catch (e) {
        return false;
    }
}

let ttsEngine = null;
if (process.platform === 'win32' && commandExists('powershell.exe')) ttsEngine = 'windows';
else if (process.platform === 'darwin' && commandExists('say')) ttsEngine = 'macos';
else if (commandExists('espeak-ng')) ttsEngine = 'espeak-ng';
else if (commandExists('espeak')) ttsEngine = 'espeak';

const TTS_DIR = path.join(os.tmpdir(), 'jt-chatons-tts');
fs.mkdirSync(TTS_DIR, { recursive: true });

const TTS_TYPES = { wav: 'audio/wav', aiff: 'audio/aiff', mp3: 'audio/mpeg' };

function findCachedTts(hash) {
    for (const ext of Object.keys(TTS_TYPES)) {
        const file = path.join(TTS_DIR, hash + '.' + ext);
        try {
            if (fs.statSync(file).size > 128) return { path: file, ext, type: TTS_TYPES[ext] };
        } catch (e) {}
    }
    return null;
}

function runProcess(command, args, timeoutMs = 45000) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { child.kill(); } catch (e) {}
            reject(new Error('délai TTS dépassé'));
        }, timeoutMs);

        child.stderr.on('data', chunk => {
            if (stderr.length < 4000) stderr += chunk.toString();
        });
        child.on('error', err => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', code => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error('code ' + code + (stderr ? ' — ' + stderr.trim().slice(0, 300) : '')));
        });
    });
}

function buildWindowsTtsScript(text, lang, outFile) {
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    const escapedOut = outFile.replace(/'/g, "''");
    const culture = lang === 'en' ? 'en' : 'fr';
    return [
        "$ErrorActionPreference = 'Stop'",
        'Add-Type -AssemblyName System.Speech',
        "$text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('" + b64 + "'))",
        '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
        "$wanted = '" + culture + "'",
        "$voice = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like ($wanted + '-*') } | Select-Object -First 1",
        'if ($voice) { $synth.SelectVoice($voice.VoiceInfo.Name) }',
        '$synth.Rate = 0',
        '$synth.Volume = 100',
        "$synth.SetOutputToWaveFile('" + escapedOut + "')",
        '$synth.Speak($text)',
        '$synth.Dispose()'
    ].join('\r\n');
}

async function synthesizeTts(text, lang) {
    if (!ttsEngine) throw new Error('aucun moteur TTS local disponible');
    const hash = crypto.createHash('sha256').update((lang || 'fr') + '\u0000' + text).digest('hex').slice(0, 40);
    const cached = findCachedTts(hash);
    if (cached) return cached;

    const base = path.join(TTS_DIR, hash);

    if (ttsEngine === 'windows') {
        const out = base + '.wav';
        const script = buildWindowsTtsScript(text, lang, out);
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded]);
        if (!fs.existsSync(out) || fs.statSync(out).size <= 128) throw new Error('fichier WAV vide');
        return { path: out, ext: 'wav', type: TTS_TYPES.wav };
    }

    if (ttsEngine === 'macos') {
        const out = base + '.aiff';
        const voice = lang === 'en' ? 'Samantha' : 'Amelie';
        try {
            await runProcess('say', ['-v', voice, '-o', out, '--data-format=LEI16@22050', text]);
        } catch (e) {
            await runProcess('say', ['-o', out, '--data-format=LEI16@22050', text]);
        }
        if (!fs.existsSync(out) || fs.statSync(out).size <= 128) throw new Error('fichier AIFF vide');
        return { path: out, ext: 'aiff', type: TTS_TYPES.aiff };
    }

    const out = base + '.wav';
    const voice = lang === 'en' ? 'en-us' : 'fr-fr';
    await runProcess(ttsEngine, ['-v', voice, '-s', '165', '-w', out, text]);
    if (!fs.existsSync(out) || fs.statSync(out).size <= 128) throw new Error('fichier WAV vide');
    return { path: out, ext: 'wav', type: TTS_TYPES.wav };
}

function cleanupTtsCache(maxAgeMs = 7 * 24 * 3600 * 1000) {
    const now = Date.now();
    try {
        for (const name of fs.readdirSync(TTS_DIR)) {
            const file = path.join(TTS_DIR, name);
            try {
                if (now - fs.statSync(file).mtimeMs > maxAgeMs) fs.unlinkSync(file);
            } catch (e) {}
        }
    } catch (e) {}
}
cleanupTtsCache();

/* ------------------------------------------------------------------- http */

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.wasm': 'application/wasm',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.aiff': 'audio/aiff',
    '.txt': 'text/plain; charset=utf-8',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2'
};

function sendJson(res, status, payload) {
    const body = Buffer.from(JSON.stringify(payload));
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store'
    });
    res.end(body);
}

function sameOriginAllowed(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    const expected = 'http://' + (req.headers.host || (HOST + ':' + PORT));
    return origin === expected;
}

function readBody(req, limit = 65536) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > limit) {
                reject(new Error('corps de requête trop volumineux'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

function serveStatic(req, res, pathname) {
    let rel = pathname.replace(/^\/+/, '');
    if (!rel) rel = 'index.html';
    let decoded;
    try { decoded = decodeURIComponent(rel); } catch (e) { sendJson(res, 400, { error: { message: 'URL invalide' } }); return; }

    const filePath = path.resolve(__dirname, decoded);
    const root = path.resolve(__dirname) + path.sep;
    if (!filePath.startsWith(root)) {
        sendJson(res, 403, { error: { message: 'Accès refusé' } });
        return;
    }

    fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) {
            sendJson(res, 404, { error: { message: 'Fichier introuvable' } });
            return;
        }
        const ext = path.extname(filePath).toLowerCase();
        const isVendor = decoded.replace(/\\/g, '/').startsWith('vendor/');
        res.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Content-Length': stat.size,
            'Cache-Control': isVendor ? 'public, max-age=31536000, immutable' : 'no-cache'
        });
        if (req.method === 'HEAD') {
            res.end();
            return;
        }
        const stream = fs.createReadStream(filePath);
        stream.on('error', () => { try { res.destroy(); } catch (e) {} });
        stream.pipe(res);
    });
}

function proxyToAgnes(req, res, url) {
    if (!sameOriginAllowed(req)) {
        sendJson(res, 403, { error: { message: 'Origine non autorisée' } });
        return;
    }
    if (keys.length === 0) {
        sendJson(res, 503, { error: { message: 'Aucune clé serveur. Ajoute AGNES_API_KEY=sk-… dans .env puis relance node server.mjs.' } });
        return;
    }

    const rest = url.pathname.replace(/^\/api\/agnes/, '') || '/';
    const targetPath = rest.startsWith('/') ? rest : '/' + rest;
    const targetUrl = UPSTREAM + targetPath + (url.search || '');
    const key = keys[keyIndex++ % keys.length];

    const headers = { ...req.headers };
    delete headers.host;
    delete headers.authorization;
    delete headers.cookie;
    delete headers.origin;
    delete headers.referer;
    headers.host = UPSTREAM_HOST;
    headers.authorization = 'Bearer ' + key;

    const upstreamReq = https.request(targetUrl, { method: req.method, headers }, upstreamRes => {
        const outHeaders = { ...upstreamRes.headers };
        delete outHeaders['access-control-allow-origin'];
        delete outHeaders['access-control-allow-headers'];
        delete outHeaders['access-control-allow-methods'];
        delete outHeaders['set-cookie'];
        res.writeHead(upstreamRes.statusCode || 502, outHeaders);
        upstreamRes.pipe(res);
        upstreamRes.on('error', () => { try { res.destroy(); } catch (e) {} });
    });

    upstreamReq.setTimeout(180000, () => {
        upstreamReq.destroy(new Error('délai upstream dépassé'));
    });
    upstreamReq.on('error', err => {
        if (res.headersSent) {
            try { res.destroy(); } catch (e) {}
            return;
        }
        sendJson(res, 502, { error: { message: 'Relais Agnes : ' + err.message } });
    });
    req.on('aborted', () => upstreamReq.destroy());
    req.pipe(upstreamReq);
}

async function handleTts(req, res) {
    if (!sameOriginAllowed(req)) {
        sendJson(res, 403, { error: { message: 'Origine non autorisée' } });
        return;
    }
    if (!ttsEngine) {
        sendJson(res, 501, { error: { message: 'Aucun moteur TTS local (Windows SAPI, macOS say ou espeak requis).' } });
        return;
    }
    if (req.method !== 'POST') {
        sendJson(res, 405, { error: { message: 'Utilise POST { text, lang }' } });
        return;
    }

    let payload;
    try {
        payload = JSON.parse(await readBody(req));
    } catch (e) {
        sendJson(res, 400, { error: { message: 'JSON invalide : ' + e.message } });
        return;
    }

    const text = String(payload && payload.text || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
    if (!text) {
        sendJson(res, 400, { error: { message: 'Texte vide' } });
        return;
    }
    const lang = payload && payload.lang === 'en' ? 'en' : 'fr';

    try {
        const audio = await synthesizeTts(text, lang);
        const stat = await fsp.stat(audio.path);
        res.writeHead(200, {
            'Content-Type': audio.type,
            'Content-Length': stat.size,
            'Cache-Control': 'public, max-age=86400'
        });
        fs.createReadStream(audio.path).pipe(res);
    } catch (e) {
        sendJson(res, 500, { error: { message: 'TTS : ' + e.message } });
    }
}

const server = http.createServer(async (req, res) => {
    let url;
    try {
        url = new URL(req.url, 'http://' + (req.headers.host || HOST + ':' + PORT));
    } catch (e) {
        sendJson(res, 400, { error: { message: 'Requête invalide' } });
        return;
    }

    if (url.pathname === '/api/health') {
        sendJson(res, 200, {
            ok: true,
            proxy: true,
            keys: keys.length,
            tts: !!ttsEngine,
            platform: process.platform,
            version: VERSION,
            upstream: UPSTREAM
        });
        return;
    }

    if (url.pathname === '/api/tts') {
        await handleTts(req, res);
        return;
    }

    if (url.pathname.startsWith('/api/agnes/')) {
        proxyToAgnes(req, res, url);
        return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { error: { message: 'Méthode non autorisée' } });
        return;
    }
    serveStatic(req, res, url.pathname);
});

server.on('clientError', (err, socket) => {
    try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (e) {}
});

server.listen(PORT, HOST, () => {
    const shownHost = HOST === '0.0.0.0' ? '127.0.0.1' : HOST;
    console.log('');
    console.log('  JT Chatons Studio — serveur local v' + VERSION);
    console.log('  URL          : http://' + shownHost + ':' + PORT);
    console.log('  Clés serveur : ' + (keys.length ? keys.length + ' (rotation active)' : 'AUCUNE — ajoute AGNES_API_KEY dans .env'));
    console.log('  TTS          : ' + (ttsEngine ? ttsEngine : 'indisponible'));
    console.log('  Upstream     : ' + UPSTREAM);
    console.log('');
    if (!keys.length) {
        console.log('  ⚠️  Sans clé serveur, la génération renverra HTTP 503.');
        console.log('      Crée .env à partir de .env.example puis relance ce serveur.');
        console.log('');
    }
    console.log('  Ctrl+C pour arrêter.');
    console.log('');
});

function shutdown() {
    console.log('\nArrêt du serveur…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
