import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import child_process from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const BIN_DIR = path.join(ROOT, 'bin');
const MODEL_DIR = path.join(ROOT, 'models');

const VOICE_PORT = parseInt(process.env.VOICE_PORT || '4888', 10);
const OPENCLAW_WS = process.env.OPENCLAW_URL || 'ws://127.0.0.1:18789';
const SESSION_KEY = process.env.OPENCLAW_SESSION || 'main';

const OPENCLAW_TOKEN = process.env.OPENCLAW_TOKEN || '';
if (!OPENCLAW_TOKEN) {
  console.error('OPENCLAW_TOKEN is required');
  process.exit(2);
}

// ----- utility -----
function sendJson(res, status, obj) {
  const data = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function base64url(buf) {
  return buf.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function fromBase64url(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replaceAll('-', '+').replaceAll('_', '/');
  return Buffer.from(b64, 'base64');
}

// ----- Local STT (whisper-cli) -----
function resolveWhisper(){
  const isWin = process.platform === 'win32';
  const exeDefault = path.join(BIN_DIR, isWin ? 'whisper-cli.exe' : 'whisper-cli');
  const exe = process.env.WHISPER_CLI || exeDefault;
  const modelDefault = path.join(MODEL_DIR, 'ggml-small.bin');
  const model = process.env.WHISPER_MODEL || modelDefault;
  return { exe, model };
}

function runWhisperCli(wavBuf) {
  const { exe, model } = resolveWhisper();
  if (!fs.existsSync(exe)) throw new Error(`whisper-cli not found: ${exe}`);
  if (!fs.existsSync(model)) throw new Error(`whisper model not found: ${model}`);

  const tmpRoot = process.env.TEMP || process.env.TMP || (process.platform === 'win32' ? '.' : '/tmp');
  const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'openclaw-voice-'));
  const wavPath = path.join(tmpDir, 'in.wav');
  const outPrefix = path.join(tmpDir, 'out');
  fs.writeFileSync(wavPath, wavBuf);

  // Reduce hallucinations like [MUSIC] by suppressing non-speech tokens and requiring clearer speech.
  const args = [
    '-m', model,
    '-l', 'de',
    '-nt',
    '-sns',
    '--no-speech-thold', '0.80',
    '--entropy-thold', '2.20',
    '-of', outPrefix,
    '-otxt',
    wavPath,
  ];
  const p = child_process.spawnSync(exe, args, { encoding: 'utf-8' });
  try {
    if (p.status !== 0) {
      throw new Error((p.stderr || p.stdout || '').trim() || `whisper-cli failed (${p.status})`);
    }
    const txtPath = outPrefix + '.txt';
    const text = fs.existsSync(txtPath) ? fs.readFileSync(txtPath, 'utf-8').trim() : (p.stdout || '').trim();
    return text;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

function sanitizeForTts(input){
  let t = String(input || '');
  // Remove common markdown noise that TTS reads as "stern"
  t = t.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1'); // *italic* or **bold**
  t = t.replace(/`{1,3}([^`]+)`{1,3}/g, '$1');
  t = t.replace(/[_~#>]/g, '');
  // Drop leftover standalone asterisks/bullets
  t = t.replace(/^\s*\*\s+/gm, '');
  t = t.replace(/\*+/g, '');
  // Normalize list markers a bit
  t = t.replace(/^\s*\d+\)\s+/gm, '');
  t = t.replace(/^\s*[-•]\s+/gm, '');
  // Collapse whitespace
  t = t.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

// ----- Local TTS (Windows SAPI5) -----
function runTtsLocal(text, voiceName) {
  if (process.platform !== 'win32') throw new Error('Local Windows TTS is only available on Windows');
  text = sanitizeForTts(text);
  const ps1 = path.join(ROOT, 'tts_de.ps1');
  if (!fs.existsSync(ps1)) throw new Error('tts_de.ps1 missing');
  const tmpRoot = process.env.TEMP || process.env.TMP || '.';
  const outPath = path.join(tmpRoot, `openclaw-tts-local-${Date.now()}.wav`);
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-Text', text, '-OutFile', outPath];
  if (voiceName && String(voiceName).trim()) {
    args.push('-VoiceName', String(voiceName));
  }
  const p = child_process.spawnSync('powershell', args, { encoding: 'utf-8' });
  if (p.status !== 0) throw new Error((p.stderr || p.stdout || '').trim() || `Local TTS failed (${p.status})`);
  return { outPath, contentType: 'audio/wav' };
}

// ----- Cloud TTS (Edge Neural via edge-tts python, no API key) -----
function runTtsEdge(text, voiceId) {
  text = sanitizeForTts(text);
  const py = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const script = path.join(ROOT, 'edge_tts_say.py');
  if (!fs.existsSync(script)) throw new Error('edge_tts_say.py missing');

  const tmpRoot = process.env.TEMP || process.env.TMP || (process.platform === 'win32' ? '.' : '/tmp');
  const outPath = path.join(tmpRoot, `openclaw-tts-edge-${Date.now()}.mp3`);
  const voice = voiceId && String(voiceId).trim() ? String(voiceId).trim() : 'de-DE-KatjaNeural';

  // Run python directly (cross-platform)
  const p = child_process.spawnSync(py, [script, '--voice', voice, '--out', outPath, '--text', text], {
    encoding: 'utf-8',
    maxBuffer: 20 * 1024 * 1024,
  });
  if (p.status !== 0) throw new Error((p.stderr || p.stdout || '').trim() || `Edge TTS failed (${p.status})`);
  return { outPath, contentType: 'audio/mpeg' };
}

// ----- Gateway WS client with device signing -----
const DEVICE_FILE = path.join(ROOT, 'device.json');
function loadOrCreateDevice() {
  if (fs.existsSync(DEVICE_FILE)) {
    const d = JSON.parse(fs.readFileSync(DEVICE_FILE, 'utf-8'));
    // New format stores raw Ed25519 key material as base64url (like Control UI)
    if (d && d.version === 1 && typeof d.deviceId === 'string' && typeof d.publicKey === 'string' && typeof d.privateKey === 'string') {
      return d;
    }
  }

  // Generate Ed25519 keys and export as JWK so we can get raw key bytes.
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubJwk = publicKey.export({ format: 'jwk' });
  const privJwk = privateKey.export({ format: 'jwk' });
  // For OKP Ed25519 JWK: x = raw public key (32 bytes), d = raw private key (32 bytes)
  const x = pubJwk.x;
  const d = privJwk.d;
  if (!x || !d) throw new Error('Failed to export Ed25519 JWK');

  const pubRaw = fromBase64url(x);
  const deviceId = crypto.createHash('sha256').update(pubRaw).digest('hex');

  const device = {
    version: 1,
    deviceId,
    publicKey: x,
    privateKey: d,
    createdAtMs: Date.now(),
  };
  fs.writeFileSync(DEVICE_FILE, JSON.stringify(device, null, 2));
  return device;
}

const device = loadOrCreateDevice();

function signConnect({ nonce, role, scopes, clientId, clientMode, signedAtMs, token }) {
  const version = nonce ? 'v2' : 'v1';
  const scopesCsv = scopes.join(',');
  const parts = [
    version,
    device.deviceId,
    clientId,
    clientMode,
    role,
    scopesCsv,
    String(signedAtMs),
    token || '',
  ];
  if (nonce) parts.push(nonce);
  const msg = parts.join('|');

  const privKeyObj = crypto.createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      x: device.publicKey,
      d: device.privateKey,
    },
  });

  const sig = crypto.sign(null, Buffer.from(msg, 'utf-8'), privKeyObj);
  return base64url(sig);
}

class GatewayClient {
  constructor() {
    this.ws = null;
    this.pending = new Map();
    this.connected = false;
    this.nonce = null;
    this.connectSent = false;
    // Use a non-UI client id/mode to avoid Control-UI Origin restrictions
    this.clientId = 'gateway-client';
    this.clientMode = 'backend';
    this.role = 'operator';
    this.scopes = ['operator.admin', 'operator.approvals', 'operator.pairing'];
    this.runWaiters = new Map(); // runId -> {resolve,reject,buf}
  }

  start() {
    console.log('[gw] connecting ->', OPENCLAW_WS);
    this.ws = new WebSocket(OPENCLAW_WS);
    this.ws.addEventListener('open', () => {
      console.log('[gw] ws open');
      this.connected = false;
      this.connectSent = false;
      // If no challenge arrives, attempt connect after a short delay.
      setTimeout(() => {
        if (!this.connectSent && !this.connected) this.sendConnect();
      }, 750);
    });
    this.ws.addEventListener('message', (ev) => this.onMessage(String(ev.data || '')));
    this.ws.addEventListener('close', (ev) => {
      console.log('[gw] ws closed', ev.code, ev.reason || '');
      this.connected = false;
      this.connectSent = false;
      for (const [, p] of this.pending) p.reject(new Error(`ws closed ${ev.code}`));
      this.pending.clear();
      for (const [, w] of this.runWaiters) w.reject(new Error('ws closed'));
      this.runWaiters.clear();
      setTimeout(() => this.start(), 1200);
    });
    this.ws.addEventListener('error', () => {
      console.log('[gw] ws error');
    });
  }

  onMessage(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.type === 'event') {
      if (msg.event === 'connect.challenge') {
        this.nonce = msg.payload?.nonce || null;
        console.log('[gw] challenge nonce', this.nonce ? String(this.nonce).slice(0, 8) + '…' : 'null');
        if (!this.connectSent && !this.connected) this.sendConnect();
        return;
      }
      if (msg.event === 'chat') {
        const p = msg.payload;
        if (!p) return;
        if (p.sessionKey && p.sessionKey !== SESSION_KEY) return;
        const runId = p.runId;
        if (!runId) return;
        const w = this.runWaiters.get(runId);
        if (!w) return;
        if (p.state === 'delta') {
          const t = extractText(p.message);
          if (typeof t === 'string') w.buf = t;
        }
        if (p.state === 'final') {
          const t = extractText(p.message);
          const finalText = typeof t === 'string' ? t : (w.buf || '');
          this.runWaiters.delete(runId);
          w.resolve(finalText);
        }
        if (p.state === 'error') {
          this.runWaiters.delete(runId);
          w.reject(new Error(p.errorMessage || 'chat error'));
        }
      }
      return;
    }

    if (msg.type === 'res') {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.payload);
      else p.reject(new Error(msg.error?.message || 'request failed'));
    }
  }

  request(method, params) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('ws not open'));
    const id = crypto.randomUUID();
    const payload = { type: 'req', id, method, params };
    const prom = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.ws.send(JSON.stringify(payload));
    return prom;
  }

  async sendConnect() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.connectSent || this.connected) return;
    this.connectSent = true;
    const signedAt = Date.now();
    const signature = signConnect({
      nonce: this.nonce,
      role: this.role,
      scopes: this.scopes,
      clientId: this.clientId,
      clientMode: this.clientMode,
      signedAtMs: signedAt,
      token: OPENCLAW_TOKEN,
    });

    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: { id: this.clientId, version: 'dev', platform: process.platform, mode: this.clientMode, instanceId: crypto.randomUUID() },
      role: this.role,
      scopes: this.scopes,
      device: {
        id: device.deviceId,
        publicKey: device.publicKey,
        signature,
        signedAt,
        nonce: this.nonce || undefined,
      },
      caps: [],
      auth: { token: OPENCLAW_TOKEN },
      userAgent: 'voice-console',
      locale: 'de-DE',
    };

    try {
      await this.request('connect', params);
      this.connected = true;
      console.log('[gw] connected');
    } catch (e) {
      console.log('[gw] connect failed:', String(e?.message || e));
      // close to trigger reconnect
      try { this.ws?.close(1008, 'connect failed'); } catch {}
    }
  }

  async chatSend(text) {
    if (!this.connected) throw new Error('not connected');
    const runId = crypto.randomUUID();
    const waiter = {};
    const p = new Promise((resolve, reject) => {
      this.runWaiters.set(runId, { resolve, reject, buf: '' });
    });
    await this.request('chat.send', { sessionKey: SESSION_KEY, message: text, deliver: false, idempotencyKey: runId });
    return { runId, promise: p };
  }
}

function extractText(message) {
  if (!message) return null;
  if (typeof message.text === 'string') return message.text;
  if (Array.isArray(message.content)) {
    const parts = message.content.map(p => (p && p.type === 'text' ? p.text : null)).filter(Boolean);
    if (parts.length) return parts.join('\n');
  }
  if (typeof message.content === 'string') return message.content;
  return null;
}

const gw = new GatewayClient();
gw.start();

// ----- HTTP server -----

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && u.pathname === '/api/config') {
      return sendJson(res, 200, { openclawUrl: OPENCLAW_WS, sessionKey: SESSION_KEY, connected: gw.connected });
    }

    if (req.method === 'POST' && u.pathname === '/api/stt') {
      const body = await readBody(req);
      const text = runWhisperCli(body);
      return sendJson(res, 200, { text });
    }

    if (req.method === 'POST' && u.pathname === '/api/chat') {
      const body = await readBody(req);
      const j = JSON.parse(body.toString('utf-8'));
      const text = String(j.text || '').trim();
      if (!text) return sendJson(res, 400, { error: 'text required' });

      // Voice-mode guardrail: prevent the agent from continuing old context.
      const voicePrompt = [
        'VOICE MODE:',
        '- Answer ONLY the latest user input below.',
        '- Ignore earlier topics unless the user explicitly brings them back up.',
        '- Keep it short and direct.',
        '- MAX: 2–3 sentences. No lists. No markdown formatting.',
        '- If something essential is missing: ask exactly ONE clarification question.',
        '',
        'User input:',
        text,
      ].join('\n');

      const { promise } = await gw.chatSend(voicePrompt);
      const reply = await Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 120000)),
      ]);
      return sendJson(res, 200, { text: reply });
    }

    if (req.method === 'GET' && u.pathname === '/api/voices') {
      const ps1 = path.join(ROOT, 'list_voices.ps1');
      if (!fs.existsSync(ps1)) return sendJson(res, 200, { voices: [] });
      const p = child_process.spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1], { encoding: 'utf-8' });
      if (p.status !== 0) return sendJson(res, 500, { error: (p.stderr || p.stdout || '').trim() || 'voice list failed' });
      let voices = [];
      try { voices = JSON.parse(p.stdout || '[]'); } catch { voices = []; }
      if (!Array.isArray(voices)) voices = [];
      return sendJson(res, 200, { voices });
    }

    if (req.method === 'GET' && u.pathname === '/api/tts/providers') {
      const isWin = process.platform === 'win32';
      const providers = [
        ...(isWin ? [{ id: 'local', name: 'Local (Windows/SAPI5)' }] : []),
        { id: 'edge', name: 'Cloud (Edge Neural, no API key)' },
      ];
      return sendJson(res, 200, {
        providers,
        defaultProvider: isWin ? 'local' : 'edge',
        defaultEdgeVoice: 'de-DE-KatjaNeural',
      });
    }

    if (req.method === 'POST' && u.pathname === '/api/tts') {
      const body = await readBody(req);
      const j = JSON.parse(body.toString('utf-8'));
      const text = String(j.text || '').trim();
      const provider = String(j.provider || 'local');
      if (!text) return sendJson(res, 400, { error: 'text required' });

      if (provider === 'edge') {
        const voiceId = String(j.edgeVoiceId || '').trim();
        const { outPath, contentType } = runTtsEdge(text, voiceId);
        return sendJson(res, 200, { path: outPath, contentType, provider: 'edge', voiceId: voiceId || 'de-DE-KatjaNeural' });
      }

      const voiceName = String(j.voiceName || '').trim();
      const { outPath, contentType } = runTtsLocal(text, voiceName);
      return sendJson(res, 200, { path: outPath, contentType, provider: 'local', voiceName: voiceName || '' });
    }

    if (req.method === 'GET' && u.pathname === '/tmp') {
      const file = u.searchParams.get('file') || '';
      if (!file) return sendJson(res, 400, { error: 'file required' });
      if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'not found' });
      const ext = path.extname(file).toLowerCase();
      const data = fs.readFileSync(file);
      res.writeHead(200, {
        'Content-Type': ext === '.mp3' ? 'audio/mpeg' : 'audio/wav',
        'Content-Length': data.length,
        'Cache-Control': 'no-store',
      });
      res.end(data);
      return;
    }

    // static
    let p = u.pathname === '/' ? '/index.html' : u.pathname;
    p = path.normalize(p).replace(/^\.+/, '');
    const fp = path.join(PUBLIC_DIR, p);
    if (!fp.startsWith(PUBLIC_DIR) || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(fp).toLowerCase();
    const data = fs.readFileSync(fp);
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream', 'Content-Length': data.length });
    res.end(data);

  } catch (e) {
    sendJson(res, 500, { error: String(e?.message || e) });
  }
});

server.listen(VOICE_PORT, '127.0.0.1', () => {
  console.log(`Voice Console: http://127.0.0.1:${VOICE_PORT}/`);
});
