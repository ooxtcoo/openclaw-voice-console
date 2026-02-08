// OpenClaw Voice Console (2D HUD Face)
// Intentionally no external deps (no Three.js). Keep UI minimal; communicate state through visuals.

const logEl = document.getElementById('log');
const statusPill = document.getElementById('statusPill');
const btnFs = document.getElementById('btnFs');
const btnSettings = document.getElementById('btnSettings');
const btnSettingsClose = document.getElementById('btnSettingsClose');
const btnReset = document.getElementById('btnReset');
const btnExitKiosk = document.getElementById('btnExitKiosk');
const btnPtt = document.getElementById('btnPtt');
const btnAuto = document.getElementById('btnAuto');
const btnStop = document.getElementById('btnStop');
const micSel = document.getElementById('mic');

const voiceSel = document.getElementById('voice');
const captionsSel = document.getElementById('captions');
const sessionKeyEl = document.getElementById('sessionKey');

const ttsProviderSel = document.getElementById('ttsProvider');
const edgeVoiceSel = document.getElementById('edgeVoice');
const voiceLocalWrap = document.getElementById('voiceLocalWrap');
const voiceEdgeWrap = document.getElementById('voiceEdgeWrap');

const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');

let audioCtx;
let micAnalyser;
let ttsAnalyser;
let stream;

let mode = 'idle'; // idle | listening | thinking | speaking
let autoMode = false;
let stopFlashUntil = 0;

function log(...args){
  const s = args.map(a => typeof a === 'string' ? a : JSON.stringify(a, null, 2)).join(' ');
  logEl.textContent = (logEl.textContent + (logEl.textContent ? '\n' : '') + s).slice(-8000);
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(text, kind='neutral'){
  statusPill.textContent = text;
  statusPill.style.borderColor = kind==='ok' ? 'rgba(96,165,250,0.6)' : kind==='err' ? 'rgba(239,68,68,0.6)' : 'rgba(255,255,255,0.12)';
}

function setMode(next){
  mode = next;
  try {
    document.body.dataset.mode = mode;
    document.body.dataset.auto = autoMode ? 'on' : 'off';
  } catch {}
}

function setAuto(on){
  autoMode = !!on;
  try { document.body.dataset.auto = autoMode ? 'on' : 'off'; } catch {}
}

// --- Settings ---
const DEFAULT_SETTINGS = {
  // Face layout
  faceScale: 1.0,
  faceOvalX: 0.88,
  faceOvalY: 1.10,
  faceForward: 1.00, // kept for compatibility; used as subtle glow intensity

  // Style
  wireOpacity: 0.30,

  // Mouth
  mouthWidth: 0.20,
  mouthStrength: 1.0,
  mouthSmile: 0.10,

  // Eyes
  eyeSize: 0.12,
  eyeGaze: 0.06,
  pupilSize: 0.020,

  // Motion
  headMotion: 1.0,
};

function loadSettings(){
  try {
    const raw = localStorage.getItem('faceSettings');
    if (!raw) return { ...DEFAULT_SETTINGS };
    const j = JSON.parse(raw);
    return { ...DEFAULT_SETTINGS, ...(j||{}) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(){
  try {
    localStorage.setItem('faceSettings', JSON.stringify(settings));
  } catch (e) {
    try {
      if (captionsSel?.value === 'on') log('settings save failed:', String(e?.message || e));
    } catch {}
  }
}

let settings = loadSettings();

// --- Canvas resize ---
function resize(){
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(2, Math.floor(rect.width));
  const h = Math.max(2, Math.floor(rect.height));
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
window.__oc_resize = resize;
setTimeout(resize, 0);
setInterval(resize, 1000);

function getAmplitude(an){
  if (!an) return 0;
  const arr = new Uint8Array(an.fftSize);
  an.getByteTimeDomainData(arr);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = (arr[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / arr.length);
}

function palette(){
  const nowMs = performance.now();
  const stopFlash = nowMs < stopFlashUntil;

  // defaults
  let stroke = '#60a5fa';
  let glow = 'rgba(96,165,250,0.18)';
  let dim = 1.0;
  let scan = 0.0;

  if (stopFlash) {
    stroke = '#ef4444';
    glow = 'rgba(239,68,68,0.20)';
  } else if (mode === 'listening') {
    stroke = '#22d3ee';
    glow = 'rgba(34,211,238,0.18)';
    scan = 1.0;
  } else if (mode === 'thinking') {
    stroke = '#a78bfa';
    glow = 'rgba(167,139,250,0.18)';
    scan = 0.6;
  } else if (mode === 'speaking') {
    stroke = '#e0f2ff';
    glow = 'rgba(224,242,255,0.20)';
    scan = 0.2;
  } else {
    if (autoMode) {
      stroke = '#60a5fa';
      glow = 'rgba(96,165,250,0.15)';
      scan = 0.15;
    } else {
      stroke = '#334155';
      glow = 'rgba(51,65,85,0.10)';
      dim = 0.85;
    }
  }

  return { stroke, glow, dim, scan };
}

function drawHudFace({t, aMic, aTts}){
  const w = canvas.getBoundingClientRect().width;
  const h = canvas.getBoundingClientRect().height;

  // background clear
  ctx.clearRect(0, 0, w, h);

  const p = palette();

  // layout
  const cx = w * 0.5;
  const cy = h * 0.47;
  const s = Math.min(w, h) * 0.40 * settings.faceScale;

  const rx = s * settings.faceOvalX;
  const ry = s * settings.faceOvalY;

  // "armed" pulse when auto is on
  const pulse = autoMode && mode === 'idle' ? (0.5 + 0.5*Math.sin(t*2.2)) : 0;

  // subtle motion
  const mx = Math.sin(t*0.7) * 6 * settings.headMotion;
  const my = Math.cos(t*0.55) * 5 * settings.headMotion;

  // line style
  ctx.lineWidth = Math.max(1, 1.6 + settings.wireOpacity * 3.0);
  ctx.strokeStyle = p.stroke;
  ctx.globalAlpha = Math.max(0.08, Math.min(1.0, settings.wireOpacity * 1.35)) * p.dim;

  // glow halo
  ctx.save();
  ctx.globalAlpha = 1;
  const g = ctx.createRadialGradient(cx, cy, Math.max(10, rx*0.2), cx, cy, Math.max(20, rx*1.15));
  g.addColorStop(0, p.glow);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx*1.18, ry*1.18, 0, 0, Math.PI*2);
  ctx.fill();
  ctx.restore();

  // corner brackets (tracking frame)
  ctx.save();
  ctx.globalAlpha = 0.18 * p.dim;
  ctx.strokeStyle = p.stroke;
  ctx.lineWidth = 2;
  const bw = rx*1.35, bh = ry*1.35;
  const bx0 = cx - bw, bx1 = cx + bw;
  const by0 = cy - bh, by1 = cy + bh;
  const L = 16;
  const br = 10;
  const corners = [
    [bx0, by0, 1, 1], [bx1, by0, -1, 1], [bx0, by1, 1, -1], [bx1, by1, -1, -1],
  ];
  for (const [x,y,sx,sy] of corners){
    ctx.beginPath();
    ctx.moveTo(x + sx*br, y);
    ctx.lineTo(x + sx*L, y);
    ctx.lineTo(x + sx*L, y + sy*L);
    ctx.lineTo(x, y + sy*L);
    ctx.lineTo(x, y + sy*br);
    ctx.stroke();
  }
  ctx.restore();

  // head outline (two layers)
  const ox = cx + mx*0.25;
  const oy = cy + my*0.25;

  ctx.save();
  ctx.globalAlpha = (0.22 + pulse*0.06) * p.dim;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.ellipse(ox, oy, rx*1.02, ry*1.02, 0, 0, Math.PI*2);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.globalAlpha = (0.55 + pulse*0.10) * p.dim;
  ctx.lineWidth = Math.max(1.5, 1.8 + settings.wireOpacity*2.2);
  ctx.beginPath();
  ctx.ellipse(ox, oy, rx*0.92, ry*0.98, 0, 0, Math.PI*2);
  ctx.stroke();
  ctx.restore();

  // Inner wire "mesh" so it still reads like a 3D wireframe head (but in 2D)
  // Latitude rings
  ctx.save();
  ctx.strokeStyle = p.stroke;
  ctx.globalAlpha = (0.12 + settings.wireOpacity*0.25) * p.dim;
  ctx.lineWidth = 1;
  for (let i = -5; i <= 6; i++) {
    const u = i / 6; // -0.83..1
    const yy = oy + u * ry * 0.78;
    const k = Math.cos(u * Math.PI * 0.52);
    const rxx = rx * 0.88 * Math.max(0.08, k);
    const ryy = ry * 0.12 * Math.max(0.08, k);
    ctx.beginPath();
    ctx.ellipse(ox, yy, rxx, ryy, 0, 0, Math.PI*2);
    ctx.stroke();
  }

  // Meridian curves (fake 3D by rotating ellipses)
  for (let j = 0; j < 7; j++) {
    const ang = (-0.9 + (j/6)*1.8); // -0.9..0.9
    ctx.beginPath();
    ctx.ellipse(ox, oy, rx*0.62, ry*0.90, ang*0.65, 0, Math.PI*2);
    ctx.stroke();
  }
  ctx.restore();

  // feature points
  const eyeY = oy - ry*0.18;
  const eyeDx = rx*0.34;
  const eyeR = Math.max(4, s * settings.eyeSize * 0.22);
  const pupilR = Math.max(2.5, s * settings.pupilSize * 0.35);

  const gaze = settings.eyeGaze;
  const gx = Math.sin(t*0.75) * gaze * 18;
  const gy = Math.cos(t*0.55) * gaze * 10;

  function circle(x,y,r,alpha=1){
    ctx.save();
    ctx.globalAlpha = alpha * p.dim;
    ctx.beginPath();
    ctx.arc(x,y,r,0,Math.PI*2);
    ctx.stroke();
    ctx.restore();
  }

  // eyes
  ctx.save();
  ctx.strokeStyle = p.stroke;
  ctx.globalAlpha = (0.70 + pulse*0.10) * p.dim;
  circle(ox - eyeDx, eyeY, eyeR, ctx.globalAlpha);
  circle(ox + eyeDx, eyeY, eyeR, ctx.globalAlpha);

  // pupils
  ctx.globalAlpha = (0.85 + pulse*0.08) * p.dim;
  circle(ox - eyeDx + gx*0.5, eyeY + gy*0.5, pupilR, ctx.globalAlpha);
  circle(ox + eyeDx + gx*0.5, eyeY + gy*0.5, pupilR, ctx.globalAlpha);
  ctx.restore();

  // cheek nodes + connecting lines
  ctx.save();
  ctx.globalAlpha = (0.22 + pulse*0.05) * p.dim;
  ctx.lineWidth = 1;
  const nodes = [
    [ox - rx*0.48, oy + ry*0.08],
    [ox + rx*0.48, oy + ry*0.08],
    [ox - rx*0.30, oy + ry*0.34],
    [ox + rx*0.30, oy + ry*0.34],
    [ox, oy + ry*0.58],
  ];
  ctx.beginPath();
  ctx.moveTo(nodes[0][0], nodes[0][1]);
  ctx.lineTo(nodes[2][0], nodes[2][1]);
  ctx.lineTo(nodes[4][0], nodes[4][1]);
  ctx.lineTo(nodes[3][0], nodes[3][1]);
  ctx.lineTo(nodes[1][0], nodes[1][1]);
  ctx.stroke();
  for (const [nx,ny] of nodes) circle(nx, ny, 3.5, ctx.globalAlpha);
  ctx.restore();

  // mouth (AI speaking only)
  const mouthA = (mode === 'speaking') ? aTts : 0;
  const mouth = Math.max(0, Math.min(1, mouthA * 7.0));
  const mw = rx * (0.22 + settings.mouthWidth * 0.55);
  const smile = settings.mouthSmile;
  const open = mouth * (0.06 + 0.10*settings.mouthStrength);

  ctx.save();
  ctx.globalAlpha = (0.75 + pulse*0.10) * p.dim;
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  const my0 = oy + ry*0.26;
  ctx.moveTo(ox - mw, my0);
  ctx.quadraticCurveTo(ox, my0 + (smile*14) - (open*14), ox + mw, my0);
  ctx.stroke();
  if (open > 0.002) {
    ctx.globalAlpha *= 0.35;
    ctx.beginPath();
    ctx.moveTo(ox - mw*0.92, my0 + open*18);
    ctx.quadraticCurveTo(ox, my0 + open*18 + (smile*10), ox + mw*0.92, my0 + open*18);
    ctx.stroke();
  }
  ctx.restore();

  // scanline (subtle)
  if (p.scan > 0) {
    const y = (h * 0.18) + ((t * 40) % (h * 0.64));
    ctx.save();
    ctx.globalAlpha = (0.05 + 0.06 * p.scan) * p.dim;
    ctx.fillStyle = p.stroke;
    ctx.fillRect(0, y, w, 2);
    ctx.restore();
  }

  // mic feedback (particles/ring) while listening
  if (mode === 'listening') {
    const micBoost = Math.max(0, Math.min(1, aMic * 18));
    ctx.save();
    ctx.globalAlpha = (0.08 + micBoost*0.12) * p.dim;
    ctx.strokeStyle = p.stroke;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.ellipse(ox, oy, rx*(1.02 + micBoost*0.03), ry*(1.02 + micBoost*0.03), 0, 0, Math.PI*2);
    ctx.stroke();
    ctx.restore();
  }
}

function animate(){
  const t = performance.now() / 1000;
  const aMic = getAmplitude(micAnalyser);
  const aTts = getAmplitude(ttsAnalyser);
  drawHudFace({t, aMic, aTts});
  requestAnimationFrame(animate);
}

// --- Audio / Mic ---
let selectedMicId = localStorage.getItem('micId') || '';
let selectedVoiceName = localStorage.getItem('voiceName') || '';

let ttsProvider = localStorage.getItem('ttsProvider') || 'local';
let edgeVoiceId = localStorage.getItem('edgeVoiceId') || 'de-DE-KatjaNeural';

async function ensureMic(){
  if (stream && !selectedMicId) return stream;
  if (stream) {
    try { stream.getTracks().forEach(t => t.stop()); } catch {}
    stream = null;
  }

  const constraints = selectedMicId
    ? { audio: { deviceId: { exact: selectedMicId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true } }
    : { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };

  stream = await navigator.mediaDevices.getUserMedia(constraints);

  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  try { await audioCtx.resume(); } catch {}

  const src = audioCtx.createMediaStreamSource(stream);
  micAnalyser = audioCtx.createAnalyser();
  micAnalyser.fftSize = 2048;
  src.connect(micAnalyser);
  return stream;
}

async function refreshMicList(){
  try { await ensureMic(); } catch {}

  const devices = await navigator.mediaDevices.enumerateDevices();
  const mics = devices.filter(d => d.kind === 'audioinput');

  micSel.innerHTML = '';
  const optAuto = document.createElement('option');
  optAuto.value = '';
  optAuto.textContent = 'Default';
  micSel.appendChild(optAuto);

  for (const d of mics){
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `microphone (${d.deviceId.slice(0,6)}…)`;
    micSel.appendChild(opt);
  }

  micSel.value = selectedMicId;
}

// --- Recording (same approach as before) ---
let stopRequested = false;
let stopRecordingNow = null;

async function recordOnce({maxMs=15000, vad=true}={}){
  await ensureMic();
  await audioCtx.resume();

  const destRate = 16000;
  const sourceRate = audioCtx.sampleRate;

  const source = audioCtx.createMediaStreamSource(stream);
  const proc = audioCtx.createScriptProcessor(2048, 1, 1);

  let recorded = [];
  let rec = true;
  let startedAt = performance.now();
  stopRequested = false;

  const cleanup = () => {
    try { source.disconnect(proc); } catch {}
    try { proc.disconnect(); } catch {}
    stopRecordingNow = null;
  };

  stopRecordingNow = () => {
    stopRequested = true;
    rec = false;
    cleanup();
  };

  let speech = false;
  let speechStartedAt = 0;
  let lastVoiceAt = performance.now();

  proc.onaudioprocess = (e) => {
    if (!rec) return;

    const input = e.inputBuffer.getChannelData(0);

    // downsample to 16k
    const ratio = sourceRate / destRate;
    const outLen = Math.floor(input.length / ratio);
    const out = new Float32Array(outLen);
    for (let i=0;i<outLen;i++){
      const start = Math.floor(i * ratio);
      const end = Math.min(input.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      let n = 0;
      for (let j = start; j < end; j++) { sum += input[j]; n++; }
      out[i] = n ? (sum / n) : input[start] || 0;
    }
    recorded.push(out);

    // VAD
    let sum=0;
    for (let i=0;i<input.length;i++) sum += input[i]*input[i];
    const rms = Math.sqrt(sum/input.length);
    const now = performance.now();

    const SPEECH_RMS_START = 0.020;
    const SPEECH_RMS_CONTINUE = 0.010;
    const NO_SPEECH_ABORT_MS = 1100;
    const MIN_SPEECH_MS = 80;
    const END_SILENCE_MS = 1200;

    const gate = speech ? SPEECH_RMS_CONTINUE : SPEECH_RMS_START;
    if (rms > gate){
      if (!speechStartedAt) speechStartedAt = now;
      if ((now - speechStartedAt) >= MIN_SPEECH_MS) speech = true;
      lastVoiceAt = now;
    } else {
      if (!speech) speechStartedAt = 0;
    }

    if (stopRequested) {
      rec = false;
    } else if (vad && !speech && (now - startedAt) > NO_SPEECH_ABORT_MS) {
      rec = false;
    } else if (vad && speech && (now - lastVoiceAt) > END_SILENCE_MS){
      rec = false;
    } else if (now - startedAt > maxMs){
      rec = false;
    }

    if (!rec) cleanup();
  };

  source.connect(proc);
  proc.connect(audioCtx.destination);

  while (rec){
    await new Promise(r => setTimeout(r, 50));
    if (stopRequested) {
      rec = false;
      cleanup();
    }
  }

  if (vad && !speech) return null;

  // concat
  let total = 0;
  for (const c of recorded) total += c.length;
  const samples = new Float32Array(total);
  let off = 0;
  for (const c of recorded){ samples.set(c, off); off += c.length; }

  return wavEncode(samples, 16000);
}

function wavEncode(samples, sampleRate){
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (o, s) => { for (let i=0;i<s.length;i++) view.setUint8(o+i, s.charCodeAt(i)); };
  writeStr(0,'RIFF');
  view.setUint32(4, 36 + samples.length*2, true);
  writeStr(8,'WAVE');
  writeStr(12,'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate*2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36,'data');
  view.setUint32(40, samples.length*2, true);
  let o = 44;
  for (let i=0;i<samples.length;i++){
    let s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(o, s<0 ? s*0x8000 : s*0x7FFF, true);
    o += 2;
  }
  return new Blob([view], {type:'audio/wav'});
}

async function waitForVoice({threshold=0.020, minMs=80, pollMs=30}={}){
  const started = performance.now();
  let aboveSince = 0;
  while (autoMode){
    const a = getAmplitude(micAnalyser);
    const now = performance.now();
    if (a >= threshold){
      if (!aboveSince) aboveSince = now;
      if ((now - aboveSince) >= minMs) return true;
    } else {
      aboveSince = 0;
    }
    await new Promise(r=>setTimeout(r, pollMs));
    if (audioCtx && audioCtx.state === 'suspended' && (now - started) > 500) {
      try { await audioCtx.resume(); } catch {}
    }
  }
  return false;
}

// --- App logic ---
let lastTranscript = '';

async function boot(){
  setMode('idle');
  setStatus('loading config…');
  const cfg = await fetch('/api/config').then(r=>r.json());
  sessionKeyEl.textContent = cfg.sessionKey || 'main';

  setStatus(cfg.connected ? 'connected' : 'connecting…', cfg.connected ? 'ok' : 'neutral');

  async function speakAssistant(text){
    if (captionsSel.value === 'on') log('ASSISTANT:', text);
    setMode('speaking');
    try {
      const provider = localStorage.getItem('ttsProvider') || 'local';
      const payload = { text, provider };
      if (provider === 'edge') {
        payload.edgeVoiceId = localStorage.getItem('edgeVoiceId') || edgeVoiceSel.value || 'de-DE-KatjaNeural';
      } else {
        if (selectedVoiceName) payload.voiceName = selectedVoiceName;
      }
      const p = await fetch('/api/tts', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)}).then(r=>r.json());
      if (p.error) throw new Error(p.error);
      if (captionsSel.value === 'on') {
        log(`TTS provider: ${p.provider || provider}${p.voiceId ? ' ('+p.voiceId+')' : p.voiceName ? ' ('+p.voiceName+')' : ''}`);
      }
      await window.playAudio(`/tmp?file=${encodeURIComponent(p.path)}`);
    } catch (e){
      log('TTS error:', String(e));
    } finally {
      setMode('idle');
    }
  }

  async function askOpenClaw(text){
    const res = await fetch('/api/chat', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({text})}).then(r=>r.json());
    if (res.error) throw new Error(res.error);
    await speakAssistant(String(res.text || ''));
  }
  window.__askOpenClaw = askOpenClaw;

  setInterval(async () => {
    try {
      const c = await fetch('/api/config').then(r=>r.json());
      setStatus(c.connected ? 'connected' : 'connecting…', c.connected ? 'ok' : 'neutral');
    } catch {}
  }, 1500);

  // Provider UI
  ttsProviderSel.value = ttsProvider;
  edgeVoiceSel.value = edgeVoiceId;

  function syncProviderUi(){
    voiceLocalWrap.style.display = (ttsProviderSel.value === 'local') ? '' : 'none';
    voiceEdgeWrap.style.display = (ttsProviderSel.value === 'edge') ? '' : 'none';
  }
  syncProviderUi();

  ttsProviderSel.addEventListener('change', () => {
    ttsProvider = ttsProviderSel.value;
    localStorage.setItem('ttsProvider', ttsProvider);
    syncProviderUi();
  });

  edgeVoiceSel.addEventListener('change', () => {
    edgeVoiceId = edgeVoiceSel.value;
    localStorage.setItem('edgeVoiceId', edgeVoiceId);
  });

  // Settings drawer
  function setSettingsOpen(on){
    document.body.classList.toggle('settings-open', !!on);
  }
  btnSettings?.addEventListener('click', () => setSettingsOpen(!document.body.classList.contains('settings-open')));
  btnSettingsClose?.addEventListener('click', () => setSettingsOpen(false));

  function bindSlider(id, key, fmt=(v)=>String(v)){
    const el = document.getElementById(id);
    const valEl = document.getElementById('v_' + id);
    if (!el) return;
    el.value = String(settings[key]);
    if (valEl) valEl.textContent = fmt(settings[key]);
    el.addEventListener('input', () => {
      const v = parseFloat(el.value);
      settings[key] = v;
      if (valEl) valEl.textContent = fmt(v);
      saveSettings();
    });
  }

  bindSlider('faceScale', 'faceScale', v => v.toFixed(2));
  bindSlider('faceOvalX', 'faceOvalX', v => v.toFixed(2));
  bindSlider('faceOvalY', 'faceOvalY', v => v.toFixed(2));
  bindSlider('faceForward', 'faceForward', v => v.toFixed(2));
  bindSlider('wireOpacity', 'wireOpacity', v => v.toFixed(2));

  bindSlider('mouthWidth', 'mouthWidth', v => v.toFixed(2));
  bindSlider('mouthStrength', 'mouthStrength', v => v.toFixed(2));
  bindSlider('mouthSmile', 'mouthSmile', v => v.toFixed(2));

  bindSlider('eyeSize', 'eyeSize', v => v.toFixed(2));
  bindSlider('eyeGaze', 'eyeGaze', v => v.toFixed(2));
  bindSlider('pupilSize', 'pupilSize', v => v.toFixed(3));

  bindSlider('headMotion', 'headMotion', v => v.toFixed(2));

  btnReset?.addEventListener('click', () => {
    settings = { ...DEFAULT_SETTINGS };
    saveSettings();
    location.reload();
  });

  // Fullscreen helpers (existing CSS handles layout)
  function applyFullscreen(on){
    document.body.classList.toggle('fullscreen', !!on);
    try { window.__oc_resize?.(); } catch {}
  }

  const u = new URL(location.href);
  const startFs = u.searchParams.get('fullscreen') === '1';
  if (startFs) applyFullscreen(true);

  btnFs?.addEventListener('click', async () => {
    const want = !document.body.classList.contains('fullscreen');
    applyFullscreen(want);
    if (want && document.documentElement.requestFullscreen) {
      try { await document.documentElement.requestFullscreen(); } catch {}
    }
    if (!want && document.fullscreenElement) {
      try { await document.exitFullscreen(); } catch {}
    }
  });

  window.addEventListener('keydown', (e) => {
    const tag = String(e.target?.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'select' || tag === 'textarea';

    if (e.key === 'Escape') applyFullscreen(false);
    if (e.key.toLowerCase() === 'f') applyFullscreen(!document.body.classList.contains('fullscreen'));

    if (e.key.toLowerCase() === 's' || e.key === 'F1') {
      e.preventDefault();
      setSettingsOpen(!document.body.classList.contains('settings-open'));
      try { window.__oc_resize?.(); } catch {}
    }

    if (!typing && document.body.classList.contains('fullscreen') && (e.code === 'Space' || e.key === ' ')) {
      e.preventDefault();
      try { btnPtt?.click(); } catch {}
    }
  });

  btnExitKiosk?.addEventListener('click', async () => {
    applyFullscreen(false);
    if (document.fullscreenElement) {
      try { await document.exitFullscreen(); } catch {}
    }
  });

  // Auto toggle
  btnAuto.addEventListener('click', () => {
    setAuto(!autoMode);
    btnAuto.textContent = `Auto: ${autoMode ? 'ON' : 'OFF'}`;
    if (autoMode) loopAuto();
  });

  // Stop
  let currentAudio = null;
  btnStop.addEventListener('click', async () => {
    stopRequested = true;
    if (typeof stopRecordingNow === 'function') stopRecordingNow();

    if (currentAudio) {
      try { currentAudio.pause(); } catch {}
      currentAudio = null;
    }

    btnStop.disabled = true;
    stopFlashUntil = performance.now() + 900;
    setMode('idle');
    log('stopped');
  });

  // Push-to-talk
  let holding = false;
  btnPtt.textContent = 'Tap to talk';

  const doOneUtterance = async () => {
    btnPtt.textContent = 'Listening… (tap Stop)';
    btnStop.disabled = false;
    try {
      setMode('listening');
      const wav = await recordOnce({maxMs:14000, vad:true});
      if (!wav) { setMode('idle'); return; }
      setMode('thinking');
      const stt = await fetch('/api/stt', {method:'POST', body: await wav.arrayBuffer()}).then(r=>r.json());
      if (stt.error) throw new Error(stt.error);
      const text = (stt.text || '').trim();
      lastTranscript = text;
      if (captionsSel.value === 'on') log('YOU:', text);
      if (!text) { setMode('idle'); return; }
      await window.__askOpenClaw(text);
    } finally {
      btnPtt.textContent = 'Tap to talk';
      holding = false;
      btnStop.disabled = true;
      setMode('idle');
    }
  };

  btnPtt.addEventListener('click', async () => {
    if (holding) {
      stopRequested = true;
      if (typeof stopRecordingNow === 'function') stopRecordingNow();
      return;
    }
    holding = true;
    stopRequested = false;
    await doOneUtterance().catch(e => log('PTT error:', String(e)));
  });

  // Override playAudio: wire TTS analyser
  window.playAudio = async (url) => {
    return new Promise(async (resolve, reject) => {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      try { await audioCtx.resume(); } catch {}

      const a = new Audio(url);
      currentAudio = a;

      try {
        ttsAnalyser = audioCtx.createAnalyser();
        ttsAnalyser.fftSize = 2048;
        const src = audioCtx.createMediaElementSource(a);
        src.connect(ttsAnalyser);
        src.connect(audioCtx.destination);
      } catch {
        // fallback: audio still plays
      }

      a.addEventListener('ended', () => { if (currentAudio === a) currentAudio = null; resolve(); });
      a.addEventListener('error', () => { if (currentAudio === a) currentAudio = null; reject(new Error('audio error')); });
      a.play().catch(reject);
    });
  };
}

async function loopAuto(){
  await ensureMic().catch(()=>{});
  while (autoMode){
    try {
      setMode('idle');
      const heard = await waitForVoice({ threshold: 0.020, minMs: 80 });
      if (!heard) break;

      setMode('listening');
      const wav = await recordOnce({maxMs:14000, vad:true});
      if (!autoMode) break;
      if (!wav) { setMode('idle'); continue; }

      setMode('thinking');
      const stt = await fetch('/api/stt', {method:'POST', body: await wav.arrayBuffer()}).then(r=>r.json());
      if (stt.error) throw new Error(stt.error);
      const text = (stt.text || '').trim();
      if (!autoMode) break;
      if (captionsSel.value === 'on') log('YOU:', text);
      if (!text) { setMode('idle'); continue; }

      btnStop.disabled = false;
      await window.__askOpenClaw(text);

      while (mode !== 'idle' && autoMode){
        await new Promise(r=>setTimeout(r, 120));
      }
    } catch (e){
      setMode('idle');
      log('AUTO error:', String(e));
      await new Promise(r=>setTimeout(r, 500));
    }
  }
  setMode('idle');
}

boot().then(async () => {
  try {
    await refreshMicList();
    micSel.addEventListener('change', async () => {
      selectedMicId = micSel.value;
      try {
        if (selectedMicId) localStorage.setItem('micId', selectedMicId);
        else localStorage.removeItem('micId');
      } catch {}
      await ensureMic().catch(()=>{});
    });

    // voices
    try {
      const v = await fetch('/api/voices').then(r=>r.json());
      const voices = Array.isArray(v.voices) ? v.voices : [];
      voiceSel.innerHTML = '';
      const optEmpty = document.createElement('option');
      optEmpty.value = '';
      optEmpty.textContent = '(default)';
      voiceSel.appendChild(optEmpty);

      for (const name of voices){
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        voiceSel.appendChild(opt);
      }

      voiceSel.value = selectedVoiceName;
      voiceSel.addEventListener('change', () => {
        selectedVoiceName = voiceSel.value;
        try {
          if (selectedVoiceName) localStorage.setItem('voiceName', selectedVoiceName);
          else localStorage.removeItem('voiceName');
        } catch {}
      });
    } catch {}

    // start rendering
    resize();
    animate();

    setStatus('ready', 'ok');
  } catch (e) {
    setStatus('boot error', 'err');
    log('boot error:', String(e?.message || e));
  }
});
