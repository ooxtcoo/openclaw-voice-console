import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

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

// Drawer duplicates (for fullscreen usability)
const btnPttDrawer = document.getElementById('btnPttDrawer');
const btnAutoDrawer = document.getElementById('btnAutoDrawer');
const btnStopDrawer = document.getElementById('btnStopDrawer');
const btnDebugDrawer = document.getElementById('btnDebugDrawer');
const micSel = document.getElementById('mic');
const micEchoSel = document.getElementById('micEcho');
const micNoiseSel = document.getElementById('micNoise');
const micAgcSel = document.getElementById('micAgc');

const voiceSel = document.getElementById('voice');
const captionsSel = document.getElementById('captions');
const sessionKeyEl = document.getElementById('sessionKey');

const ttsProviderSel = document.getElementById('ttsProvider');
const edgeVoiceSel = document.getElementById('edgeVoice');
const voiceLocalWrap = document.getElementById('voiceLocalWrap');
const voiceEdgeWrap = document.getElementById('voiceEdgeWrap');

const canvas = document.getElementById('c');
const facePresetSel = document.getElementById('facePreset');
const maskDetailEl = document.getElementById('maskDetail');
const maskDetailWrap = document.getElementById('maskDetailWrap');

let audioCtx;
let micAnalyser;
let ttsAnalyser;
let mode = 'idle'; // idle | listening | thinking | speaking
let autoMode = false;
let stream;

// Keep a continuous mic ring-buffer so Auto mode never misses the start of speech.
// Stored as 16kHz Float32 chunks.
let micRing = [];
let micRingSec = 0;
const MIC_RING_MAX_SEC = 8.0;
let micRingProc = null;

// --- Face mood (hybrid): deterministic base + optional assistant FACE: payload ---
// mood: -1..+1 (sad/angry .. happy)
let faceMood = 0.0;
let faceMoodTarget = 0.0;
let faceArousal = 0.2;        // 0..1
let faceArousalTarget = 0.2;
let winkL = 0.0;              // 0..1 (1 = closed)
let winkR = 0.0;
let winkUntilL = 0;
let winkUntilR = 0;
let nextBlinkAt = performance.now() + 2200 + Math.random()*2200;

function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }

function triggerWink(side='left', ms=180){
  const until = performance.now() + ms;
  if (side === 'right') winkUntilR = Math.max(winkUntilR, until);
  else if (side === 'both') { winkUntilL = Math.max(winkUntilL, until); winkUntilR = Math.max(winkUntilR, until); }
  else winkUntilL = Math.max(winkUntilL, until);
}

// Parse optional FACE payload from assistant text, and return cleaned text.
// Expected at end of message:  FACE: {"mood":0.2,"wink":"left"}
function extractFacePayload(text){
  if (typeof text !== 'string') return { text: String(text || '') };
  const lines = text.split(/\r?\n/);
  // find last non-empty line
  let i = lines.length - 1;
  while (i >= 0 && !String(lines[i]).trim()) i--;
  if (i < 0) return { text };

  const m = String(lines[i]).match(/^FACE\s*:\s*(\{[\s\S]*\})\s*$/);
  if (!m) return { text };

  let payload = null;
  try { payload = JSON.parse(m[1]); } catch { payload = null; }
  if (!payload || typeof payload !== 'object') return { text };

  lines.splice(i, 1);
  return { text: lines.join('\n').trim(), payload };
}

function applyFacePayload(payload){
  if (!payload || typeof payload !== 'object') return;

  if (typeof payload.mood === 'number' && Number.isFinite(payload.mood)) {
    faceMoodTarget = clamp(payload.mood, -1, 1);
  }
  if (typeof payload.arousal === 'number' && Number.isFinite(payload.arousal)) {
    faceArousalTarget = clamp(payload.arousal, 0, 1);
  }
  if (payload.wink) {
    const w = String(payload.wink).toLowerCase();
    if (w === 'left' || w === 'l') triggerWink('left');
    else if (w === 'right' || w === 'r') triggerWink('right');
    else if (w === 'both') triggerWink('both');
  }
}

// Visual state helpers (keep UI minimal: communicate state mostly via the face)
let stopFlashUntil = 0;
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

function log(...args){
  const s = args.map(a => typeof a === 'string' ? a : JSON.stringify(a, null, 2)).join(' ');
  logEl.textContent = (logEl.textContent + (logEl.textContent ? '\n' : '') + s).slice(-8000);
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(text, kind='neutral'){
  statusPill.textContent = text;
  statusPill.style.borderColor = kind==='ok' ? 'rgba(96,165,250,0.6)' : kind==='err' ? 'rgba(239,68,68,0.6)' : 'rgba(255,255,255,0.12)';
}

// --- Settings (persisted) ---
const DEFAULT_SETTINGS = {
  facePreset: 'classic',
  maskDetail: 3,
  faceScale: 1.0,
  faceOvalX: 0.88,
  faceOvalY: 1.10,
  faceForward: 1.04,
  wireOpacity: 0.30,
  mouthWidth: 0.20,
  mouthStrength: 1.0,
  mouthSmile: 0.10,
  eyeSize: 0.12,
  eyeGaze: 0.06,
  eyeY: 0.13,
  eyeSpacing: 0.30,
  pupilSize: 0.020,
  mouthY: -0.22,
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
    // Storage can fail in some privacy modes / quota issues
    try {
      if (captionsSel?.value === 'on') log('settings save failed:', String(e?.message || e));
    } catch {}
  }
}

let settings = loadSettings();
try {
  if (captionsSel?.value === 'on') log('settings loaded:', settings);
} catch {}

// --- Face renderer (Three.js wireframe head + particles) ---
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 100);
camera.position.set(0, 0.1, 2.6);

// --- Procedural wireframe face (Option A): looks like a face + animated mouth ---
const faceGroup = new THREE.Group();
scene.add(faceGroup);

function makeFaceGeometry(){
  const preset = String(settings.facePreset || 'classic');

  // Keep it low-poly by default (Raspberry Pi friendly). Mask presets use an icosa base.
  const maskDetail = Math.max(1, Math.min(6, Math.round(Number(settings.maskDetail || 3))));
  const maskSubdiv = (maskDetail <= 2) ? 0 : (maskDetail <= 4) ? 1 : (maskDetail === 5) ? 2 : 3;

  let geo;
  if (preset === 'maskFull' || preset === 'maskFront') {
    geo = new THREE.IcosahedronGeometry(0.92, maskSubdiv);
  } else {
    // classic/variants: sphere base reads nicely as head with minimal verts
    geo = new THREE.SphereGeometry(0.9, 12, 9);
  }

  const pos = geo.attributes.position;
  const v = new THREE.Vector3();

  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const x = v.x, y = v.y, z = v.z;

    // --- Overall head proportions (driven by settings) ---
    v.x *= settings.faceOvalX;
    v.y *= settings.faceOvalY;
    v.z *= settings.faceForward;

    // --- Head presets (shape language) ---
    // These are *relative* deformations applied after the main oval/forward settings.
    // Goal: avoid the "balloon" look while keeping sliders meaningful.

    if (preset === 'narrow') {
      v.x *= 0.90;
      v.z *= 1.03;
    }

    if (preset === 'squarejaw') {
      // Wider jaw + slightly flatter cheeks
      if (y < -0.05) {
        const t = Math.min(1, (0.05 - y) / 0.85);
        v.x *= 1 + 0.10 * t;
        v.z += 0.03 * t;
      }
      if (y > -0.25 && y < 0.20 && z > 0.0) {
        const t = 1 - Math.min(1, Math.abs(y) / 0.25);
        v.z -= 0.02 * t;
      }
    }

    if (preset === 'angular') {
      // Slightly sharper planes: pull in cheeks, emphasize brow + chin.
      if (y > 0.10 && z > 0.0) {
        const t = Math.min(1, (y - 0.10) / 0.65);
        v.z += 0.03 * t;
      }
      if (y > -0.25 && y < 0.18 && z > 0.0) {
        const t = 1 - Math.min(1, Math.abs(y) / 0.25);
        v.x *= 0.97;
        v.z -= 0.03 * t;
      }
      if (y < -0.20) {
        const t = Math.min(1, (-0.20 - y) / 0.75);
        v.z += 0.03 * t;
      }
    }

    if (preset === 'maskFull' || preset === 'maskFront') {
      // Mask feel: less roundness, stronger jaw/mouth plane.
      // Flatten back more aggressively so it reads like a helmet/mask, not a sphere.
      if (z < -0.02) v.z = z * 0.55 - 0.06;

      // Slightly flatter sides
      v.x *= 0.96;

      // Stronger jaw plane
      if (y < -0.08) {
        const t = Math.min(1, (-0.08 - y) / 0.85);
        v.z += 0.08 * t;
        v.x *= 1 - 0.10 * t;
      }

      // Mouth plane forward (human-like jaw)
      const mouthPlane = Math.exp(-((x * 4.2) ** 2)) * Math.exp(-(((y + 0.22) * 6.2) ** 2));
      v.z += 0.06 * mouthPlane;

      // Front-only mask: collapse everything behind a plane so it reads clearly "open at the back".
      // Cheap and very visible, even in wireframe.
      if (preset === 'maskFront') {
        const cutZ = 0.00;
        if (v.z < cutZ) {
          v.z = cutZ;
          // Slightly shrink vertices that get collapsed, to avoid a full "disk" look.
          v.x *= 0.86;
          v.y *= 0.96;
        }
      }
    }

    // Flatten back of head
    if (z < -0.10) v.z = z * 0.70 - 0.05;

    // Forehead / cranium
    if (y > 0.20) {
      const k = 1 + (y - 0.20) * 0.10;
      v.z *= 1 + (y - 0.20) * 0.06;
      v.x *= k;
    }

    // Jaw / chin: narrower + forward
    if (y < -0.20) {
      const t = Math.min(1, (-0.20 - y) / 0.75);
      v.z += 0.12 * t;
      v.x *= 1 - 0.26 * t;
    }

    // Cheeks: flatter + slightly pulled in so mouth reads better (less "ball")
    if (y > -0.30 && y < 0.22 && z > 0.0) {
      const yc = 1 - Math.abs(y) / 0.30;
      const t = Math.max(0, Math.min(1, yc));
      v.x *= 1 + 0.04 * t;
      v.z += 0.02 * t;
    }

    // From eyes down: more "jaw box" (top wider, bottom narrower)
    if (y < 0.10) {
      const t = Math.min(1, (0.10 - y) / 0.85); // 0..1
      // reduce side width towards the chin to get a more real head silhouette
      v.x *= 1 - 0.18 * t;
      // slight forward jaw
      v.z += 0.04 * t;
    }

    // Nose ridge
    const nose = Math.exp(-((x * 3.2) ** 2)) * Math.exp(-(((y - 0.02) * 3.1) ** 2));
    v.z += 0.18 * nose;

    // Eye sockets
    const eyeY = y - 0.12;
    const leftEye = Math.exp(-(((x + 0.28) * 6.0) ** 2)) * Math.exp(-((eyeY * 7.0) ** 2));
    const rightEye = Math.exp(-(((x - 0.28) * 6.0) ** 2)) * Math.exp(-((eyeY * 7.0) ** 2));
    v.z -= 0.08 * (leftEye + rightEye);

    // Mouth area slightly in
    const mouth = Math.exp(-((x * 4.8) ** 2)) * Math.exp(-(((y + 0.22) * 6.0) ** 2));
    v.z -= 0.05 * mouth;

    pos.setXYZ(i, v.x, v.y, v.z);
  }

  geo.computeVertexNormals();
  return geo;
}

const faceMat = new THREE.MeshBasicMaterial({
  color: 0x60a5fa,
  wireframe: true,
  transparent: true,
  opacity: settings.wireOpacity,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});

// Materials that follow state colors/opacity (updated by presets)
let faceMats = [faceMat];
const face = new THREE.Mesh(makeFaceGeometry(), faceMat);
faceGroup.add(face);

// Mask-style renderers (outer edges + inner wire + subtle fill)
const maskFillMat = new THREE.MeshBasicMaterial({
  color: 0x0b1220,
  transparent: true,
  opacity: 0.035,
  depthWrite: false,
});
const maskFill = new THREE.Mesh(new THREE.BufferGeometry(), maskFillMat);
maskFill.visible = false;
faceGroup.add(maskFill);

const maskInnerMat = new THREE.LineBasicMaterial({
  color: 0x60a5fa,
  transparent: true,
  opacity: Math.max(0.06, settings.wireOpacity * 0.55),
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const maskInner = new THREE.LineSegments(new THREE.BufferGeometry(), maskInnerMat);
maskInner.visible = false;
faceGroup.add(maskInner);

const maskOuterMat = new THREE.LineBasicMaterial({
  color: 0x60a5fa,
  transparent: true,
  opacity: Math.max(0.10, settings.wireOpacity * 0.85),
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});
const maskOuter = new THREE.LineSegments(new THREE.BufferGeometry(), maskOuterMat);
maskOuter.visible = false;
faceGroup.add(maskOuter);

// Center the head a bit higher in the stage (default was slightly low)
faceGroup.position.y = 0.18;

function applyPresetVisibility(){
  const preset = String(settings.facePreset || 'classic');
  const isMask = preset === 'maskFull' || preset === 'maskFront';
  face.visible = !isMask;
  maskFill.visible = isMask;
  maskInner.visible = isMask;
  maskOuter.visible = isMask;
  // materials that should follow state color/opacity
  faceMats = isMask ? [maskInnerMat, maskOuterMat] : [faceMat];
}

function rebuildFace(){
  const preset = String(settings.facePreset || 'classic');
  const isMask = preset === 'maskFull' || preset === 'maskFront';

  const g = makeFaceGeometry();

  face.geometry.dispose();
  face.geometry = g;

  if (isMask) {
    // Fill
    try { maskFill.geometry.dispose(); } catch {}
    maskFill.geometry = g.clone();

    // Inner wire
    try { maskInner.geometry.dispose(); } catch {}
    maskInner.geometry = new THREE.WireframeGeometry(g);

    // Outer edges
    try { maskOuter.geometry.dispose(); } catch {}
    const detail = Math.max(1, Math.min(6, Math.round(Number(settings.maskDetail || 3))));
    const threshold = detail <= 2 ? 22 : detail <= 4 ? 18 : 14; // degrees-ish
    maskOuter.geometry = new THREE.EdgesGeometry(g, threshold);

    // Make inner a bit quieter than outer
    maskInnerMat.opacity = Math.max(0.0, Math.min(0.70, settings.wireOpacity * 0.55));
    maskOuterMat.opacity = Math.max(0.0, Math.min(0.95, settings.wireOpacity * 0.85));
  }

  applyPresetVisibility();
}

// Ensure the selected preset is fully built on first load (important for mask presets,
// because their renderers start with empty geometries until rebuildFace runs).
rebuildFace();

// Mouth "lips" line (we animate it)
const mouthMat = new THREE.LineBasicMaterial({
  color: 0xe0f2ff,
  transparent: true,
  opacity: 0.95,
  blending: THREE.AdditiveBlending,
});
const mouthPts = [];
function buildMouthGeometry(){
  const pts = [];
  for (let i=0;i<=28;i++){
    const u = i/28;
    const t = u * Math.PI;
    const x = Math.cos(t) * settings.mouthWidth;

    // Base lip arc
    const arc = Math.sin(t) * 0.03;

    // Smile curve: lift corners up when positive, down when negative
    // Stronger near corners, weaker in the middle.
    const corner = Math.pow(Math.abs(Math.cos(t)), 1.25); // 1 at corners, 0 mid
    const smile = settings.mouthSmile * 0.22 * corner;

    const mouthY0 = Number(settings.mouthY ?? -0.22);
    const y = mouthY0 + arc + smile;
    const z = 0.70;
    pts.push(new THREE.Vector3(x, y, z));
  }
  return new THREE.BufferGeometry().setFromPoints(pts);
}
const mouthGeo = buildMouthGeometry();
const mouthLine = new THREE.Line(mouthGeo, mouthMat);
faceGroup.add(mouthLine);

// Eyes lines (simple)
const eyesGroup = new THREE.Group();
faceGroup.add(eyesGroup);

const eyeMat = new THREE.LineBasicMaterial({
  color: 0xe0f2ff,
  transparent: true,
  opacity: 0.85,
  blending: THREE.AdditiveBlending,
});
function eyeCurve(sign){
  const pts = [];
  const s = settings.eyeSize;
  const y0 = Number(settings.eyeY ?? 0.13);
  const x0 = Number(settings.eyeSpacing ?? 0.30);
  for (let i=0;i<=18;i++){
    const t = (i/18) * Math.PI;
    const x = sign * x0 + Math.cos(t) * s;
    const y = y0 + Math.sin(t) * (s * 0.33);
    const z = 0.73;
    pts.push(new THREE.Vector3(x,y,z));
  }
  return new THREE.BufferGeometry().setFromPoints(pts);
}
const eyeL = new THREE.Line(eyeCurve(-1), eyeMat);
const eyeR = new THREE.Line(eyeCurve(+1), eyeMat);
eyesGroup.add(eyeL);
eyesGroup.add(eyeR);

// Pupils (glowing dots)
const pupilMat = new THREE.MeshBasicMaterial({
  color: 0xe0f2ff,
  transparent: true,
  opacity: 0.95,
  blending: THREE.AdditiveBlending,
  depthWrite: false,
});

function makePupil(){
  const g = new THREE.SphereGeometry(settings.pupilSize, 8, 8);
  return new THREE.Mesh(g, pupilMat);
}

let pupilL = makePupil();
let pupilR = makePupil();
function applyEyePlacement(){
  const x0 = Number(settings.eyeSpacing ?? 0.30);
  const y0 = Number(settings.eyeY ?? 0.13);
  // centers
  pupilL.position.set(-x0, y0, 0.76);
  pupilR.position.set(+x0, y0, 0.76);
  eyeL.position.set(0, 0, 0);
  eyeR.position.set(0, 0, 0);
}
applyEyePlacement();

eyesGroup.add(pupilL);
eyesGroup.add(pupilR);

function rebuildPupils(){
  pupilL.geometry.dispose();
  pupilR.geometry.dispose();
  pupilL.geometry = new THREE.SphereGeometry(settings.pupilSize, 8, 8);
  pupilR.geometry = new THREE.SphereGeometry(settings.pupilSize, 8, 8);
  applyEyePlacement();
}

let headObject = faceGroup;

function applyFaceScale(){
  faceGroup.scale.set(settings.faceScale, settings.faceScale, settings.faceScale);
}
applyFaceScale();

// Particle field
const pCount = 900;
const pGeo = new THREE.BufferGeometry();
const pPos = new Float32Array(pCount * 3);
for (let i = 0; i < pCount; i++) {
  const r = 3.8 * Math.pow(Math.random(), 0.55);
  const th = Math.random() * Math.PI * 2;
  const ph = Math.acos(2 * Math.random() - 1);
  pPos[i * 3 + 0] = r * Math.sin(ph) * Math.cos(th);
  pPos[i * 3 + 1] = r * Math.cos(ph);
  pPos[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
}
pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
const pMat = new THREE.PointsMaterial({ size: 0.012, color: 0x60a5fa, transparent: true, opacity: 0.55, depthWrite: false });
const particles = new THREE.Points(pGeo, pMat);
scene.add(particles);

function resize(){
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(2, Math.floor(rect.width));
  const h = Math.max(2, Math.floor(rect.height));
  const dpr = Math.min(devicePixelRatio || 1, 2);
  renderer.setPixelRatio(dpr);
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();

  // Resize debug output is noisy; keep it off by default.
  const DEBUG_RESIZE = false;
  if (DEBUG_RESIZE) {
    log(`resize: css=${w}x${h} dpr=${dpr} canvas=${canvas.width}x${canvas.height}`);
  }

  // Hard fallback if something prevents three from resizing
  if ((canvas.width === 300 && canvas.height === 150) && w > 300) {
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(h * dpr);
  }
}
window.addEventListener('resize', resize);
window.__oc_resize = resize;
// brute-force: some environments keep the canvas at 300x150 unless we re-apply.
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

function animate(){
  const t = performance.now() / 1000;
  const aMic = getAmplitude(micAnalyser);
  const aTts = getAmplitude(ttsAnalyser);
  const a = (mode === 'speaking') ? aTts : aMic;

  // state-driven energy
  let energy = 0.05;
  if (mode === 'listening') energy = 0.55;
  if (mode === 'thinking') energy = 0.15;
  if (mode === 'speaking') energy = 0.75;

  // Minimal, human-ish head motion (no spinning)
  const nod = Math.sin(t * 0.9) * 0.04 * settings.headMotion;
  const sway = Math.sin(t * 0.55) * 0.06 * settings.headMotion;
  const speakBoost = (mode === 'speaking') ? 1 : 0.35;

  if (headObject) {
    headObject.rotation.y = sway + a * 0.10 * speakBoost;
    headObject.rotation.x = nod + a * 0.12 * speakBoost;
  } else {
    // fallback motion
    faceGroup.rotation.y = sway * 0.7;
    faceGroup.rotation.x = nod * 0.7;
  }

  // While listening, subtly boost particle energy with mic level (so you still "see" the mic working)
  if (mode === 'listening') {
    const micBoost = Math.max(0, Math.min(1, aMic * 12));
    pMat.opacity = Math.min(0.95, pMat.opacity + micBoost * 0.10);
    pMat.size = Math.min(0.020, pMat.size + micBoost * 0.002);
  }

  // Eye gaze: both eyes move together a little (subtle left/right + tiny up/down)
  if (typeof eyesGroup !== 'undefined' && eyesGroup) {
    const gx = Math.sin(t * 0.75) * settings.eyeGaze;
    const gy = Math.cos(t * 0.55) * (settings.eyeGaze * 0.33);
    eyesGroup.position.x = gx;
    eyesGroup.position.y = gy;

    // Pupils follow gaze a bit more than eyelids
    const px = gx * 1.4;
    const py = gy * 1.4;
    const x0 = Number(settings.eyeSpacing ?? 0.30);
    const y0 = Number(settings.eyeY ?? 0.13);
    if (typeof pupilL !== 'undefined' && pupilL) {
      pupilL.position.x = -x0 + px;
      pupilL.position.y = y0 + py;
    }
    if (typeof pupilR !== 'undefined' && pupilR) {
      pupilR.position.x = +x0 + px;
      pupilR.position.y = y0 + py;
    }
  }

  // --- Face mood dynamics ---
  // Base mood comes from mode; optional FACE: payload can override.
  let baseMood = 0.0;
  if (mode === 'speaking') baseMood = 0.25;
  else if (mode === 'listening') baseMood = 0.10;
  else if (mode === 'thinking') baseMood = -0.05;
  faceMoodTarget = clamp(faceMoodTarget, -1, 1);
  faceMoodTarget = clamp(faceMoodTarget * 0.92 + baseMood * 0.08, -1, 1);

  let baseArousal = 0.2;
  if (mode === 'speaking') baseArousal = 0.7;
  else if (mode === 'listening') baseArousal = 0.6;
  else if (mode === 'thinking') baseArousal = 0.25;
  faceArousalTarget = clamp(faceArousalTarget * 0.92 + baseArousal * 0.08, 0, 1);

  // Smooth
  faceMood = faceMood * 0.88 + faceMoodTarget * 0.12;
  faceArousal = faceArousal * 0.85 + faceArousalTarget * 0.15;

  // Idle blink + winks
  const nowMs2 = performance.now();
  if (nowMs2 > nextBlinkAt) {
    triggerWink('both', 140);
    nextBlinkAt = nowMs2 + 2600 + Math.random()*3400;
  }
  winkL = (nowMs2 < winkUntilL) ? 1.0 : winkL * 0.82;
  winkR = (nowMs2 < winkUntilR) ? 1.0 : winkR * 0.82;

  if (eyeL) eyeL.scale.y = 1.0 - 0.92 * clamp(winkL, 0, 1);
  if (eyeR) eyeR.scale.y = 1.0 - 0.92 * clamp(winkR, 0, 1);

  // Hide pupils when eyelids close enough to "touch" them (otherwise it looks wrong)
  try {
    // Hide pupils fairly early while closing, show again only when clearly open.
    if (pupilL) pupilL.visible = !eyeL || (eyeL.scale.y > 0.68);
    if (pupilR) pupilR.visible = !eyeR || (eyeR.scale.y > 0.68);
  } catch {}

  // Mouth animation (line-based)
  // Only animate mouth when the assistant is speaking (much clearer than animating on mic input).
  const mouthSrc = (mode === 'speaking') ? aTts : 0;
  const mouth = Math.max(0, Math.min(1, mouthSrc * 5.0));
  const open = mouth * 0.18 * settings.mouthStrength;

  // mood -> smile offset (keep user slider as baseline)
  const moodSmile = clamp(settings.mouthSmile + faceMood * 0.42, -1, 1);

  const pts = mouthGeo.getAttribute('position');
  const n = pts.count - 1;
  for (let i=0;i<pts.count;i++){
    const u = (n > 0) ? (i / n) : 0;
    const tArc = u * Math.PI;

    // Keep geometry consistent with current settings (incl. smile) even after reload.
    const x = Math.cos(tArc) * settings.mouthWidth;
    const arc = Math.sin(tArc) * 0.03;
    const corner = Math.pow(Math.abs(Math.cos(tArc)), 1.25);
    const smile = moodSmile * 0.22 * corner;

    const mouthY0 = Number(settings.mouthY ?? -0.22);
    const baseY = mouthY0 + arc + smile;
    const y = baseY - Math.sin(tArc) * open;

    pts.setX(i, x);
    pts.setY(i, y);
    pts.setZ(i, 0.70 + open*0.15);
  }
  pts.needsUpdate = true;

  particles.rotation.y = -t * 0.06;

  // Visual language (no extra controls):
  // - Auto ON + idle  : "armed" (soft pulse)
  // - listening       : cyan
  // - thinking        : violet
  // - speaking        : near-white
  // - stop pressed    : red flash
  // - Auto OFF + idle : dim/grey
  const nowMs = performance.now();
  const stopFlash = nowMs < stopFlashUntil;

  let c = 0x60a5fa;
  let wire = settings.wireOpacity;
  let pOpacity = 0.55;
  let pSize = 0.012;

  if (stopFlash) {
    c = 0xef4444;
    wire = Math.max(0.25, settings.wireOpacity);
    pOpacity = 0.75;
    pSize = 0.016;
  } else if (mode === 'listening') {
    c = 0x22d3ee; // cyan
    wire = Math.max(0.22, settings.wireOpacity);
    pOpacity = 0.75;
    pSize = 0.015;
  } else if (mode === 'thinking') {
    c = 0xa78bfa; // violet
    wire = Math.max(0.18, settings.wireOpacity);
    pOpacity = 0.45;
    pSize = 0.011;
  } else if (mode === 'speaking') {
    c = 0xe0f2ff; // near-white
    wire = Math.max(0.24, settings.wireOpacity);
    pOpacity = 0.85;
    pSize = 0.016;
  } else {
    // idle
    if (autoMode) {
      // "armed" pulse
      const pulse = 0.5 + 0.5 * Math.sin(t * 2.2);
      c = 0x60a5fa;
      wire = Math.max(0.14, settings.wireOpacity) + pulse * 0.05;
      pOpacity = 0.38 + pulse * 0.10;
    } else {
      c = 0x334155; // slate
      // In "Auto OFF" idle we still want wireOpacity to be adjustable.
      wire = Math.max(0.0, Math.min(0.95, settings.wireOpacity * 0.55));
      pOpacity = 0.20;
      pSize = 0.010;
    }
  }

  for (const m of faceMats) {
    m.color.setHex(c);
    m.opacity = Math.max(0.0, Math.min(0.95, wire));
  }

  // For mask presets, keep inner wire a bit quieter than the outer edges.
  try {
    if (typeof maskInner !== 'undefined' && maskInner?.visible) {
      maskInnerMat.opacity = Math.max(0.04, Math.min(0.65, wire * 0.55));
      maskOuterMat.opacity = Math.max(0.06, Math.min(0.95, wire * 0.85));
    }
  } catch {}

  pMat.opacity = pOpacity;
  pMat.size = pSize;

  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
animate();

let selectedMicId = localStorage.getItem('micId') || '';
let selectedVoiceName = localStorage.getItem('voiceName') || '';

// Mic processing toggles (persisted)
let micEcho = (localStorage.getItem('micEcho') ?? '1');
let micNoise = (localStorage.getItem('micNoise') ?? '0');
let micAgc = (localStorage.getItem('micAgc') ?? '0');

// TTS provider
let ttsProvider = localStorage.getItem('ttsProvider') || 'local';
let edgeVoiceId = localStorage.getItem('edgeVoiceId') || 'de-DE-KatjaNeural';

function _downsampleTo16k(input, sourceRate){
  const destRate = 16000;
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
  return out;
}

function _startMicRingBuffer(src){
  if (micRingProc) return;
  try {
    micRing = [];
    micRingSec = 0;

    // Continuous tap. Keeps a rolling buffer even when we're "idle".
    micRingProc = audioCtx.createScriptProcessor(2048, 1, 1);
    micRingProc.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const out = _downsampleTo16k(input, audioCtx.sampleRate);
      micRing.push(out);
      micRingSec += (out.length / 16000);

      while (micRingSec > MIC_RING_MAX_SEC && micRing.length) {
        const d = micRing.shift();
        micRingSec -= (d.length / 16000);
      }
    };

    src.connect(micRingProc);
    micRingProc.connect(audioCtx.destination);
  } catch {
    micRingProc = null;
  }
}

function _stopMicRingBuffer(){
  try {
    if (!micRingProc) return;
    try { micRingProc.disconnect(); } catch {}
  } catch {}
  micRingProc = null;
}

function _getMicPreRollChunks(targetSec){
  // Return the last targetSec from ring as array of Float32Array.
  const sec = Math.max(0, Number(targetSec || 0));
  if (!sec || !micRing.length) return [];
  let need = sec;
  const out = [];
  for (let i = micRing.length - 1; i >= 0 && need > 0; i--) {
    const c = micRing[i];
    out.push(c);
    need -= (c.length / 16000);
  }
  out.reverse();
  return out;
}

async function ensureMic(){
  // If we already have a stream but user changed device, reacquire.
  if (stream && !selectedMicId) return stream;

  if (stream) {
    try { stream.getTracks().forEach(t => t.stop()); } catch {}
    stream = null;
  }

  _stopMicRingBuffer();

  // Note: browser audio processing can clip word onsets (esp. noise suppression + AGC).
  // Provide toggles so we can tune per-microphone.
  const ec = (String(micEcho) !== '0');
  const ns = (String(micNoise) === '1');
  const agc = (String(micAgc) === '1');
  const constraints = selectedMicId
    ? { audio: { deviceId: { exact: selectedMicId }, echoCancellation: ec, noiseSuppression: ns, autoGainControl: agc } }
    : { audio: { echoCancellation: ec, noiseSuppression: ns, autoGainControl: agc } };

  stream = await navigator.mediaDevices.getUserMedia(constraints);

  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  const src = audioCtx.createMediaStreamSource(stream);
  micAnalyser = audioCtx.createAnalyser();
  micAnalyser.fftSize = 2048;
  src.connect(micAnalyser);

  // Start continuous ring-buffer capture.
  _startMicRingBuffer(src);

  return stream;
}

async function refreshMicList(){
  // Need permission once before labels show.
  try { await ensureMic(); } catch {}

  const devices = await navigator.mediaDevices.enumerateDevices();
  const mics = devices.filter(d => d.kind === 'audioinput');

  micSel.innerHTML = '';
  const optAuto = document.createElement('option');
  optAuto.value = '';
  optAuto.textContent = 'Auto';
  micSel.appendChild(optAuto);

  for (const d of mics) {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || `Microphone (${d.deviceId.slice(0,6)}…)`;
    micSel.appendChild(o);
  }

  // If the saved mic id isn't present anymore, fall back to Auto.
  if (!Array.from(micSel.options).some(o => o.value === selectedMicId)) {
    selectedMicId = '';
    try { localStorage.removeItem('micId'); } catch {}
  }
  micSel.value = selectedMicId;

  // apply mic processing UI
  try {
    if (micEchoSel) micEchoSel.value = String(micEcho);
    if (micNoiseSel) micNoiseSel.value = String(micNoise);
    if (micAgcSel) micAgcSel.value = String(micAgc);
  } catch {}
}


function wavEncode(samples, sampleRate){
  // 16-bit PCM mono
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

let stopRequested = false;
let stopRecordingNow = null;

async function recordOnce({maxMs=15000, vad=true}={}){
  await ensureMic();
  await audioCtx.resume();

  const destRate = 16000;
  const sourceRate = audioCtx.sampleRate;

  const source = audioCtx.createMediaStreamSource(stream);
  // Smaller buffer reduces end-of-speech latency.
  const proc = audioCtx.createScriptProcessor(2048, 1, 1);

  // Start with pre-roll from the continuous ring-buffer (so we also capture audio
  // that happened BEFORE recordOnce() started).
  const PRE_ROLL_TARGET_SEC = 1.10;
  let preRoll = _getMicPreRollChunks(PRE_ROLL_TARGET_SEC);
  let preRollSec = preRoll.reduce((a,c)=>a+(c.length/destRate), 0);

  let recorded = [];

  let rec = true;
  let startedAt = performance.now();
  stopRequested = false;

  const cleanup = () => {
    try { source.disconnect(proc); } catch {}
    try { proc.disconnect(); } catch {}
    stopRecordingNow = null;
  };

  // Expose a hard stop that works even if onaudioprocess stops firing
  stopRecordingNow = () => {
    stopRequested = true;
    rec = false;
    cleanup();
  };

  // simple VAD based on RMS (tuned to avoid keyboard noise)
  let speech = false;
  let speechPrev = false;
  let speechStartedAt = 0;
  let lastVoiceAt = performance.now();

  proc.onaudioprocess = (e) => {
    if (!rec) return;

    const input = e.inputBuffer.getChannelData(0);

    // downsample to 16k (cheap low-pass via averaging to improve STT quality)
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
    // Pre-roll + record:
    // - before we are sure it's speech, keep a rolling buffer
    // - once speech starts, prepend pre-roll so we keep initial consonants
    const chunkSec = out.length / destRate;

    // VAD
    let sum=0;
    for (let i=0;i<input.length;i++) sum += input[i]*input[i];
    const rms = Math.sqrt(sum/input.length);
    const now = performance.now();
    // VAD tuning: avoid cutting off between words.
    // Start requires a firmer threshold; once speaking, allow lower energy to keep the turn alive.
    const SPEECH_RMS_START = 0.010;
    const SPEECH_RMS_CONTINUE = 0.007;
    const NO_SPEECH_ABORT_MS = 1800;
    const MIN_SPEECH_MS = 25;
    const END_SILENCE_MS = 1900;

    const gate = speech ? SPEECH_RMS_CONTINUE : SPEECH_RMS_START;
    if (rms > gate){
      if (!speechStartedAt) speechStartedAt = now;
      if ((now - speechStartedAt) >= MIN_SPEECH_MS) speech = true;
      lastVoiceAt = now;
    } else {
      // reset start timer if we didn't reach min speech yet
      if (!speech) speechStartedAt = 0;
    }

    // manage pre-roll / recorded buffer
    if (!speech) {
      preRoll.push(out);
      preRollSec += chunkSec;
      while (preRollSec > PRE_ROLL_TARGET_SEC && preRoll.length) {
        const d = preRoll.shift();
        preRollSec -= (d.length / destRate);
      }
    } else {
      if (!speechPrev) {
        // speech just started
        recorded = preRoll.slice();
        preRoll = [];
        preRollSec = 0;
      }
      recorded.push(out);
    }
    speechPrev = speech;

    if (stopRequested) {
      rec = false;
    } else if (vad && !speech && (now - startedAt) > NO_SPEECH_ABORT_MS) {
      // nothing but noise; stop early and let caller ignore it
      rec = false;
    } else if (vad && speech && (now - lastVoiceAt) > END_SILENCE_MS){
      // end faster after you stop speaking
      rec = false;
    } else if (now - startedAt > maxMs){
      rec = false;
    }

    if (!rec) cleanup();
  };
  source.connect(proc);
  proc.connect(audioCtx.destination);

  // wait until recording stops (also stop if user requested)
  while (rec){
    await new Promise(r => setTimeout(r, 50));
    if (stopRequested) {
      rec = false;
      cleanup();
    }
  }

  // If we never detected actual speech, return null.
  if (vad && !speech) return null;

  // concat
  let total = 0;
  for (const c of recorded) total += c.length;
  const samples = new Float32Array(total);
  let off = 0;
  for (const c of recorded){ samples.set(c, off); off += c.length; }

  return wavEncode(samples, 16000);
}

// --- OpenClaw WebSocket client (minimal) ---

function uuid(){
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random()*16|0, v = c==='x'?r:(r&0x3|0x8);
    return v.toString(16);
  });
}

class GatewayClient{
  constructor({url, token, sessionKey}){
    this.url = url;
    this.token = token;
    this.sessionKey = sessionKey;
    this.ws = null;
    this.pending = new Map();
    this.runId = null;
    this.stream = '';
    this.onChatFinal = null;
    this.onChatDelta = null;
    this.onStatus = null;
    this.connectNonce = null; // unused
    this.connected = false;
  }

  start(){
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener('open', () => {
      this._sendConnectSoon();
      this.onStatus?.('ws open');
    });
    this.ws.addEventListener('message', (ev) => this._onMessage(String(ev.data||'')));
    this.ws.addEventListener('close', (ev) => {
      this.connected = false;
      this.onStatus?.(`ws closed ${ev.code}`);
      for (const [,p] of this.pending) p.reject(new Error('ws closed'));
      this.pending.clear();
      setTimeout(() => this.start(), 1200);
    });
  }

  _sendConnectSoon(){
    setTimeout(() => this._sendConnect(), 750);
  }

  async _sendConnect(){
    const params = {
      minProtocol: 3,
      maxProtocol: 3,
      client: { id: 'voice-console', version: 'dev', platform: navigator.platform || 'web', mode: 'webchat', instanceId: uuid() },
      role: 'operator',
      scopes: ['operator.admin','operator.approvals','operator.pairing'],
      device: null,
      caps: [],
      auth: this.token ? { token: this.token } : undefined,
      userAgent: navigator.userAgent,
      locale: navigator.language,
      // no device nonce / signing in this client

    };
    try {
      const hello = await this.request('connect', params);
      this.connected = true;
      this.onStatus?.('connected');
      // hello.snapshot.sessionDefaults.mainSessionKey exists, but we keep provided sessionKey
      return hello;
    } catch (e){
      this.onStatus?.('connect failed');
      try { this.ws?.close(4008, 'connect failed'); } catch {}
    }
  }

  _onMessage(text){
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.type === 'event'){
      if (msg.event === 'connect.challenge'){
        // Control UI uses a signed device flow. For this lightweight client we
        // just retry connect with token auth (no device signing).
        this._sendConnect();
        return;
      }
      if (msg.event === 'chat'){
        const p = msg.payload;
        if (!p) return;
        if (p.sessionKey && p.sessionKey !== this.sessionKey) return;
        if (p.runId && this.runId && p.runId !== this.runId) return;
        if (p.state === 'delta'){
          const t = extractText(p.message);
          if (typeof t === 'string'){
            this.stream = t;
            this.onChatDelta?.(t);
          }
        }
        if (p.state === 'final'){
          const t = extractText(p.message);
          const finalText = typeof t === 'string' ? t : (this.stream || '');
          this.runId = null;
          this.stream = '';
          this.onChatFinal?.(finalText);
        }
        if (p.state === 'error'){
          this.runId = null;
          this.stream = '';
          this.onChatFinal?.('Fehler: ' + (p.errorMessage || 'chat error'));
        }
        return;
      }
      return;
    }
    if (msg.type === 'res'){
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.payload);
      else p.reject(new Error(msg.error?.message || 'request failed'));
    }
  }

  request(method, params){
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('ws not open'));
    const id = uuid();
    const payload = { type: 'req', id, method, params };
    const prom = new Promise((resolve, reject) => this.pending.set(id, {resolve, reject}));
    this.ws.send(JSON.stringify(payload));
    return prom;
  }

  async chatSend(text){
    const rid = uuid();
    this.runId = rid;
    this.stream = '';
    await this.request('chat.send', { sessionKey: this.sessionKey, message: text, deliver: false, idempotencyKey: rid });
    return rid;
  }

  async chatAbort(){
    try {
      await this.request('chat.abort', this.runId ? { sessionKey: this.sessionKey, runId: this.runId } : { sessionKey: this.sessionKey });
    } catch {}
    this.runId = null;
    this.stream = '';
  }
}

function extractText(message){
  if (!message) return null;
  if (typeof message.text === 'string') return message.text;
  if (Array.isArray(message.content)){
    const parts = message.content.map(p => p && p.type==='text' ? p.text : null).filter(Boolean);
    if (parts.length) return parts.join('\n');
  }
  if (typeof message.content === 'string') return message.content;
  return null;
}

// --- App logic ---

let client;
let lastTranscript = '';

async function boot(){
  setMode('idle');
  setStatus('loading config…');
  const cfg = await fetch('/api/config').then(r=>r.json());
  sessionKeyEl.textContent = cfg.sessionKey || 'main';

  // Token is not exposed by /api/config. For local-only use, put token into URL once:
  // http://127.0.0.1:4888/?token=...
  const u = new URL(location.href);
  const token = u.searchParams.get('token') || '';

  // We do NOT connect to the OpenClaw gateway directly from the browser,
  // because the operator device-signing flow is non-trivial.
  // Instead, the local Node server proxies chat via a signed gateway connection.
  setStatus(cfg.connected ? 'connected' : 'connecting…', cfg.connected ? 'ok' : 'neutral');

  async function speakAssistant(text){
    // Optional FACE payload at the end of assistant message. Remove before TTS.
    const ex = extractFacePayload(String(text || ''));
    if (ex.payload) applyFacePayload(ex.payload);
    text = ex.text;

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

  let currentRunId = null;
  let currentChatAbort = null;

  async function abortCurrentRun(){
    const runId = currentRunId;
    currentRunId = null;

    // Abort the streaming fetch immediately (otherwise Auto can hang waiting for the stream)
    try { currentChatAbort?.abort(); } catch {}
    currentChatAbort = null;

    if (!runId) return;
    try {
      await fetch('/api/chat/abort', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ runId }) });
    } catch {}
  }

  async function askOpenClaw(text){
    setMode('thinking');

    // Streaming (SSE over fetch): show deltas immediately, speak on final.
    let r = null;
    try {
      currentChatAbort = new AbortController();
      r = await fetch('/api/chat/stream', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({text}), signal: currentChatAbort.signal });
    } catch (e) {
      r = null;
    }

    // Fallback to non-streaming if streaming endpoint is unavailable
    if (!r || !r.ok || !r.body) {
      const rr = await fetch('/api/chat', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({text})});
      const j = await rr.json().catch(()=>({}));
      if (!rr.ok || j.error) throw new Error(j.error || ('chat failed (' + rr.status + ')'));
      await speakAssistant(String(j.text || ''));
      return;
    }

    const reader = r.body.getReader();
    const dec = new TextDecoder('utf-8');
    let buf = '';
    let lastDeltaText = '';
    let spokeFinal = false;

    while (true){
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        // aborted / network error
        break;
      }
      const { value, done } = chunk;
      if (done) break;
      buf += dec.decode(value, { stream:true });

      // parse SSE frames
      while (true){
        const idx = buf.indexOf('\n\n');
        if (idx < 0) break;
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);

        const line = frame.split(/\r?\n/).find(l => l.startsWith('data:'));
        if (!line) continue;
        const data = line.slice(5).trim();
        if (!data) continue;

        let evt = null;
        try { evt = JSON.parse(data); } catch { evt = null; }
        if (!evt) continue;

        if (evt.type === 'run' && evt.runId) {
          currentRunId = String(evt.runId);
        } else if (evt.type === 'delta' && typeof evt.text === 'string') {
          lastDeltaText = evt.text;
          // Optional: show partial in captions
          if (captionsSel.value === 'on') {
            // keep it lightweight; don't spam log
            setStatus('thinking…', 'neutral');
          }
        } else if (evt.type === 'final' && typeof evt.text === 'string') {
          lastDeltaText = evt.text;
          currentRunId = null;
          currentChatAbort = null;
          spokeFinal = true;
          await speakAssistant(String(evt.text || ''));
        } else if (evt.type === 'error') {
          currentRunId = null;
          currentChatAbort = null;
          // small negative blip on errors
          faceMoodTarget = clamp(faceMoodTarget - 0.35, -1, 1);
          triggerWink('both', 120);
          throw new Error(evt.error || 'chat error');
        }
      }
    }

    // If for some reason we ended without a final, but we have text, speak it once.
    if (!spokeFinal && lastDeltaText && mode !== 'speaking') {
      await speakAssistant(String(lastDeltaText));
    }
  }

  // Expose abort for Stop / barge-in
  window.__abortRun = abortCurrentRun;

  // expose for handlers
  window.__askOpenClaw = askOpenClaw;

  // poll connection status
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
      // live apply
      if (key === 'wireOpacity') {
        faceMat.opacity = settings.wireOpacity;
        // If we're in a mask preset, apply immediately to mask materials too.
        try {
          const preset = String(settings.facePreset || 'classic');
          const isMask = (preset === 'maskFull' || preset === 'maskFront');
          if (isMask) {
            maskInnerMat.opacity = Math.max(0.0, Math.min(0.70, settings.wireOpacity * 0.55));
            maskOuterMat.opacity = Math.max(0.0, Math.min(0.95, settings.wireOpacity * 0.85));
            maskFillMat.opacity = Math.max(0.0, Math.min(0.10, settings.wireOpacity * 0.12));
          }
        } catch {}
      }
      if (key === 'faceScale') applyFaceScale();

      if (key === 'faceOvalX' || key === 'faceOvalY' || key === 'faceForward') {
        rebuildFace();
      }

      if (key === 'mouthWidth' || key === 'mouthSmile' || key === 'mouthY') {
        // rebuild mouth
        mouthLine.geometry.dispose();
        mouthLine.geometry = buildMouthGeometry();
      }
      if (key === 'eyeSize' || key === 'eyeY' || key === 'eyeSpacing') {
        // rebuild eyes
        eyeL.geometry.dispose();
        eyeR.geometry.dispose();
        eyeL.geometry = eyeCurve(-1);
        eyeR.geometry = eyeCurve(+1);
        applyEyePlacement();
      }
      if (key === 'pupilSize') {
        rebuildPupils();
      }
      saveSettings();
    });
  }

  btnReset?.addEventListener('click', () => {
    settings = { ...DEFAULT_SETTINGS };
    saveSettings();
    location.reload();
  });

  bindSlider('faceScale', 'faceScale', v => v.toFixed(2));
  bindSlider('faceOvalX', 'faceOvalX', v => v.toFixed(2));
  bindSlider('faceOvalY', 'faceOvalY', v => v.toFixed(2));
  bindSlider('faceForward', 'faceForward', v => v.toFixed(2));
  bindSlider('wireOpacity', 'wireOpacity', v => v.toFixed(2));
  bindSlider('mouthWidth', 'mouthWidth', v => v.toFixed(2));
  bindSlider('mouthStrength', 'mouthStrength', v => v.toFixed(2));
  bindSlider('mouthSmile', 'mouthSmile', v => v.toFixed(2));
  bindSlider('eyeSize', 'eyeSize', v => v.toFixed(2));
  bindSlider('eyeY', 'eyeY', v => v.toFixed(2));
  bindSlider('eyeSpacing', 'eyeSpacing', v => v.toFixed(2));
  bindSlider('eyeGaze', 'eyeGaze', v => v.toFixed(2));
  bindSlider('pupilSize', 'pupilSize', v => v.toFixed(3));
  bindSlider('mouthY', 'mouthY', v => v.toFixed(2));
  bindSlider('headMotion', 'headMotion', v => v.toFixed(2));

  function syncMaskDetailUi(){
    const preset = String(settings.facePreset || 'classic');
    const isMask = (preset === 'maskFull' || preset === 'maskFront');
    if (maskDetailWrap) maskDetailWrap.style.display = isMask ? '' : 'none';
  }

  // Head preset dropdown
  try {
    if (facePresetSel) {
      facePresetSel.value = String(settings.facePreset || 'classic');
      facePresetSel.addEventListener('change', () => {
        settings.facePreset = facePresetSel.value;
        syncMaskDetailUi();
        rebuildFace();
        saveSettings();
      });
    }
  } catch {}

  // Mask detail slider
  try {
    if (maskDetailEl) {
      maskDetailEl.value = String(Math.max(1, Math.min(6, Math.round(Number(settings.maskDetail || 3)))));
      const valEl = document.getElementById('v_maskDetail');
      if (valEl) valEl.textContent = String(maskDetailEl.value);
      maskDetailEl.addEventListener('input', () => {
        const v = Math.max(1, Math.min(6, Math.round(Number(maskDetailEl.value || 3))));
        maskDetailEl.value = String(v);
        settings.maskDetail = v;
        if (valEl) valEl.textContent = String(v);
        const preset = String(settings.facePreset || 'classic');
        if (preset === 'maskFull' || preset === 'maskFront') rebuildFace();
        saveSettings();
      });
    }
  } catch {}

  syncMaskDetailUi();

  // Move inline system controls into the drawer (so the main view stays clean)
  try {
    const drawerSystem = document.getElementById('drawerSystem');
    const inline = document.getElementById('rowSettingsInline');
    if (drawerSystem && inline) drawerSystem.appendChild(inline);
  } catch {}

  // Fullscreen / kiosk mode
  function applyFullscreen(on){
    document.body.classList.toggle('fullscreen', !!on);
    localStorage.setItem('fullscreen', on ? '1' : '0');
    // trigger resize so the canvas fills the stage
    try { window.__oc_resize?.(); } catch {}
  }

  const url = new URL(location.href);
  const fsParam = url.searchParams.get('fullscreen');
  // URL param has priority: fullscreen=0 always disables and clears sticky storage.
  if (fsParam === '0') {
    try { localStorage.setItem('fullscreen', '0'); } catch {}
  }
  const startFs = (fsParam === '1') || (fsParam !== '0' && localStorage.getItem('fullscreen') === '1');

  // Auto start via URL param: auto=1|0|true|false (persisted like fullscreen)
  const autoParam = url.searchParams.get('auto');
  if (autoParam === '0' || autoParam === 'false') {
    try { localStorage.setItem('auto', '0'); } catch {}
  } else if (autoParam === '1' || autoParam === 'true') {
    try { localStorage.setItem('auto', '1'); } catch {}
  }
  const startAuto = (localStorage.getItem('auto') === '1');

  if (btnFs) {
    btnFs.addEventListener('click', async () => {
      const want = !document.body.classList.contains('fullscreen');
      applyFullscreen(want);
      // Try native browser fullscreen (optional)
      if (want && document.documentElement.requestFullscreen) {
        try { await document.documentElement.requestFullscreen(); } catch {}
      }
      if (!want && document.fullscreenElement) {
        try { await document.exitFullscreen(); } catch {}
      }
    });
  }

  // Hotkeys
  window.addEventListener('keydown', (e) => {
    const tag = String(e.target?.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'select' || tag === 'textarea';

    if (e.key === 'Escape') applyFullscreen(false);
    if (e.key.toLowerCase() === 'f') applyFullscreen(!document.body.classList.contains('fullscreen'));

    // Toggle settings overlay even in fullscreen
    if (e.key.toLowerCase() === 's' || e.key === 'F1') {
      e.preventDefault();
      setSettingsOpen(!document.body.classList.contains('settings-open'));
      try { window.__oc_resize?.(); } catch {}
    }

    // Push-to-talk in fullscreen: Space toggles recording
    // (ignored while adjusting sliders / typing)
    // Space toggles AUTO (so you can enable/disable voice mode even in fullscreen/kiosk)
    if (!typing && (e.code === 'Space' || e.key === ' ')) {
      e.preventDefault();
      try { btnAuto?.click(); } catch {}
    }
  });

  // Always provide a clickable exit in fullscreen (for cases where keyboard focus is missing)
  btnExitKiosk?.addEventListener('click', async () => {
    applyFullscreen(false);
    if (document.fullscreenElement) {
      try { await document.exitFullscreen(); } catch {}
    }
  });

  applyFullscreen(startFs);

  function syncControlLabels(){
    try {
      btnAuto.textContent = `Auto: ${autoMode ? 'ON' : 'OFF'}`;
      if (btnAutoDrawer) btnAutoDrawer.textContent = btnAuto.textContent;

      // Stop button state mirrors
      if (btnStopDrawer) btnStopDrawer.disabled = btnStop.disabled;

      // Debug button mirrors captions
      const dbgOn = (captionsSel?.value === 'on');
      if (btnDebugDrawer) btnDebugDrawer.textContent = `Debug: ${dbgOn ? 'ON' : 'OFF'}`;
    } catch {}
  }

  btnAuto.addEventListener('click', () => {
    setAuto(!autoMode);
    try { localStorage.setItem('auto', autoMode ? '1' : '0'); } catch {}
    syncControlLabels();
    if (autoMode) loopAuto();
  });

  // Start auto immediately if requested (useful for fullscreen/kiosk)
  if (startAuto) {
    setAuto(true);
    syncControlLabels();
    loopAuto();
  } else {
    syncControlLabels();
  }

  // Stop: stop recording and stop any playback immediately
  let currentAudio = null;

  // Drawer mirrors: forward clicks to main buttons
  btnAutoDrawer?.addEventListener('click', () => { try { btnAuto.click(); } catch {} });
  btnDebugDrawer?.addEventListener('click', () => {
    try {
      captionsSel.value = (captionsSel.value === 'on') ? 'off' : 'on';
      try { localStorage.setItem('captions', captionsSel.value); } catch {}
      syncControlLabels();
    } catch {}
  });

  async function doStop(){
    stopRequested = true;
    if (typeof stopRecordingNow === 'function') stopRecordingNow();

    // Stop should NOT disable Auto mode; Auto is controlled by its own toggle.
    // (Otherwise one stop-click ends auto after the first reply.)

    // Abort any in-flight LLM run
    try { await window.__abortRun?.(); } catch {}

    if (currentAudio) {
      try { currentAudio.pause(); } catch {}
      currentAudio = null;
    }

    btnStop.disabled = true;
    stopFlashUntil = performance.now() + 900;
    setMode('idle');
    log('stopped');
    syncControlLabels();
  }

  btnStop.addEventListener('click', async () => {
    await doStop();
  });

  btnStopDrawer?.addEventListener('click', async () => {
    await doStop();
  });

  // Push-to-talk: CLICK to start, CLICK again to stop (works better on mobile)
  let holding = false;

  btnPtt.textContent = 'Tap to talk';

  const doOneUtterance = async () => {
    btnPtt.textContent = 'Listening… (tap Stop)';
    btnStop.disabled = false;
    try {
      setMode('listening');
      // use VAD so it ends automatically after you stop speaking
      const wav = await recordOnce({maxMs:14000, vad:true});
      if (!wav) { setMode('idle'); return; }
      setMode('thinking');
      const stt = await fetch('/api/stt', {method:'POST', body: await wav.arrayBuffer()}).then(r=>r.json());
      if (stt.error) throw new Error(stt.error);
      const text = (stt.text || '').trim();
      lastTranscript = text;
      if (captionsSel.value === 'on') log('YOU:', text);
      if (!text) { setMode('idle'); return; }

      // ask OpenClaw and speak back
      await window.__askOpenClaw(text);
    } finally {
      btnPtt.textContent = 'Tap to talk';
      holding = false;
      btnStop.disabled = true;
      setMode('idle');
    }
  };

  async function doPttToggle(){
    if (holding) {
      // second tap stops recording immediately
      stopRequested = true;
      if (typeof stopRecordingNow === 'function') stopRecordingNow();
      syncControlLabels();
      return;
    }
    holding = true;
    stopRequested = false;
    syncControlLabels();
    await doOneUtterance().catch(e => {
      log('PTT error:', String(e));
    });
    syncControlLabels();
  }

  btnPtt.addEventListener('click', async () => {
    await doPttToggle();
  });

  btnPttDrawer?.addEventListener('click', async () => {
    await doPttToggle();
  });

  // Override playAudio to allow Stop to interrupt playback
  const _playAudio = playAudio;
  window.playAudio = async (url) => {
    return new Promise(async (resolve, reject) => {
      // Make sure AudioContext exists so we can analyse TTS output
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      try { await audioCtx.resume(); } catch {}

      const a = new Audio(url);
      currentAudio = a;

      // Route TTS audio into an analyser so the mouth can move while the assistant speaks.
      try {
        ttsAnalyser = ttsAnalyser || audioCtx.createAnalyser();
        ttsAnalyser.fftSize = 2048;
        const src = audioCtx.createMediaElementSource(a);
        src.connect(ttsAnalyser);
        src.connect(audioCtx.destination);
      } catch {
        // If this fails (rare browser restrictions), we still play audio normally.
      }

      // --- Barge-in: if user starts talking while TTS is playing, stop immediately ---
      let bargeInt = null;
      try {
        await ensureMic();
        let aboveSince = 0;
        bargeInt = setInterval(async () => {
          if (currentAudio !== a) return;
          if (a.paused || a.ended) return;
          const amp = getAmplitude(micAnalyser);
          const now = performance.now();
          const TH = 0.020;
          if (amp >= TH) {
            if (!aboveSince) aboveSince = now;
            if ((now - aboveSince) >= 120) {
              // stop TTS
              try { a.pause(); } catch {}
              if (currentAudio === a) currentAudio = null;
              // abort generation too (so it doesn't keep streaming)
              try { await window.__abortRun?.(); } catch {}
              stopFlashUntil = performance.now() + 500;
              setMode('idle');
            }
          } else {
            aboveSince = 0;
          }
        }, 35);
      } catch {}

      const cleanup = () => { try { if (bargeInt) clearInterval(bargeInt); } catch {} };

      a.addEventListener('ended', () => { cleanup(); if (currentAudio === a) currentAudio = null; resolve(); });
      a.addEventListener('error', () => { cleanup(); if (currentAudio === a) currentAudio = null; reject(new Error('audio error')); });
      a.addEventListener('pause', () => { cleanup(); });

      a.play().catch((e) => { cleanup(); reject(e); });
    });
  };
}

async function waitForVoice({threshold=0.035, minMs=180, pollMs=30}={}){
  const started = performance.now();
  let aboveSince = 0;
  while (autoMode){
    // Auto VAD uses MIC only.
    const a = getAmplitude(micAnalyser);
    const now = performance.now();
    if (a >= threshold){
      if (!aboveSince) aboveSince = now;
      if ((now - aboveSince) >= minMs) return true;
    } else {
      aboveSince = 0;
    }
    // Don't spin CPU
    await new Promise(r=>setTimeout(r, pollMs));

    // Safety: if audio context is suspended, try to resume periodically
    if (audioCtx && audioCtx.state === 'suspended' && (now - started) > 500) {
      try { await audioCtx.resume(); } catch {}
    }
  }
  return false;
}

async function loopAuto(){
  // Auto mode: wait for something that looks like voice, then record one utterance.
  // This avoids constant STT attempts from keyboard noise.
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

      // wait until assistant finishes speaking
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

async function playAudio(url){
  return new Promise((resolve, reject) => {
    const a = new Audio(url);
    a.addEventListener('ended', () => resolve());
    a.addEventListener('error', () => reject(new Error('audio error')));
    a.play().catch(reject);
  });
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
      await refreshMicList();
    });

    // Mic processing toggles
    const onMicProcChange = async () => {
      micEcho = micEchoSel?.value ?? micEcho;
      micNoise = micNoiseSel?.value ?? micNoise;
      micAgc = micAgcSel?.value ?? micAgc;
      try {
        localStorage.setItem('micEcho', String(micEcho));
        localStorage.setItem('micNoise', String(micNoise));
        localStorage.setItem('micAgc', String(micAgc));
      } catch {}
      // re-acquire mic with new constraints
      try { await ensureMic(); } catch {}
    };
    micEchoSel?.addEventListener('change', onMicProcChange);
    micNoiseSel?.addEventListener('change', onMicProcChange);
    micAgcSel?.addEventListener('change', onMicProcChange);

    // Voices
    const v = await fetch('/api/voices').then(r=>r.json());
    const voices = Array.isArray(v.voices) ? v.voices : [];
    voiceSel.innerHTML = '';
    const def = document.createElement('option');
    def.value = '';
    def.textContent = 'Default (Hedda)';
    voiceSel.appendChild(def);
    for (const it of voices) {
      const name = it?.Name || it?.name;
      if (!name) continue;
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = `${name} ${it?.Culture ? '('+it.Culture+')' : ''}`;
      voiceSel.appendChild(opt);
    }
    voiceSel.value = selectedVoiceName;
    voiceSel.addEventListener('change', () => {
      selectedVoiceName = voiceSel.value;
      if (selectedVoiceName) localStorage.setItem('voiceName', selectedVoiceName);
      else localStorage.removeItem('voiceName');
    });

  } catch (e) {
    log('Init error:', String(e));
  }
}).catch(e => {
  setStatus('boot error', 'err');
  log(String(e));
});
