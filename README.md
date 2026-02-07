# OpenClaw Voice Console (Windows)

A local-first voice mode for OpenClaw:

- **STT (local):** `whisper.cpp` (optional, offline)
- **TTS (local):** Windows SAPI5 voices
- **TTS (no API key):** Microsoft Edge Neural voices via `edge-tts`
- **UI:** Sci‑fi console + wireframe face + particles + kiosk/fullscreen + live tuning sliders

> Status: V1 (works, still evolving)

## Requirements

- Windows 10/11
- Node.js 18+ (recommended: 20+)
- Python 3.10+ (recommended: 3.12)
- OpenClaw gateway running locally

Optional (for local STT):
- `whisper-cli.exe` from whisper.cpp + a model file

## Install

### 1) Get the code

```powershell
git clone <THIS_REPO_URL>
cd openclaw-voice-console
```

### 2) Install Edge Neural TTS (no API key)

```powershell
python -m pip install --upgrade edge-tts
```

### 3) Start the Voice Console

The start script reads your OpenClaw token from `~/.openclaw/openclaw.json`.

```powershell
.\start_voice_console.ps1
```

Open:
- http://127.0.0.1:4888/

## Usage

### Talk
- Tap/click **Tap to talk**
- In fullscreen, press **Space** to toggle push‑to‑talk

### Fullscreen / Kiosk
- Button: **Vollbild**
- Hotkeys:
  - **F** toggle fullscreen layout
  - **S** / **F1** toggle Settings drawer overlay
  - **ESC** exit fullscreen

You can also force exit sticky fullscreen:
- `http://127.0.0.1:4888/?fullscreen=0`

### Settings drawer
Use sliders to tune the face (oval/scale/forward), eyes (gaze/pupils), mouth (smile/open), motion, etc.
Settings persist in browser `localStorage`.

## Local STT (whisper.cpp)

This repo contains helper scripts, but it does **not** ship large binaries/models.

You need:
- `bin/whisper-cli.exe`
- `models/<ggml-model>.bin`

Then the console will use `/api/stt` locally.

## Security notes

Do **NOT** commit these files:
- `device.json` (contains private key)
- model binaries (`*.bin`), executables (`*.exe`/`*.dll`)

This repo’s `.gitignore` excludes them.

## License

MIT (recommended). Add/adjust as needed.
