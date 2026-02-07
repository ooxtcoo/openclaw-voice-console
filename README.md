# OpenClaw Voice Console (Windows + Linux)

A local-first voice mode for OpenClaw:

- **STT (local):** `whisper.cpp` (optional, offline)
- **TTS (local):** Windows SAPI5 voices
- **TTS (no API key):** Microsoft Edge Neural voices via `edge-tts`
- **UI:** Sci-fi console + wireframe face + particles + kiosk/fullscreen + live tuning sliders

> Status: V1 (works, still evolving)

## Requirements

### Common
- Node.js 18+ (recommended: 20+)
- Python 3.10+ (recommended: 3.12)
- OpenClaw gateway running (local or reachable)
- OpenClaw token: set `OPENCLAW_TOKEN` env var

### Windows
- Windows 10/11

### Debian / Raspberry Pi OS (Linux)
- Debian-based Linux (including Raspberry Pi OS)

Notes:
- TTS on Linux uses **Edge Neural** via `edge-tts` (no API key).
- Local STT needs `whisper-cli` + a model; see below.

## Install

### Windows

```powershell
git clone https://github.com/ooxtcoo/openclaw-voice-console.git
cd openclaw-voice-console
python -m pip install --upgrade edge-tts
.\start_voice_console.ps1
```

Open:
- http://127.0.0.1:4888/

### Debian / Raspberry Pi OS (Linux)

```bash
git clone https://github.com/ooxtcoo/openclaw-voice-console.git
cd openclaw-voice-console

# deps
sudo apt update
sudo apt install -y nodejs npm python3 python3-pip

# edge tts (no api key)
python3 -m pip install --user --upgrade edge-tts

# run (token required)
export OPENCLAW_TOKEN="..."
./start_voice_console.sh
```

Open:
- http://127.0.0.1:4888/

Notes:
- On Linux, TTS defaults to **Edge Neural** (Windows SAPI voices are Windows-only).
- Local STT requires `whisper-cli` + a model; see below.

## Screenshots

![Screenshot 1](screenshots/screenshot_1.png)
![Screenshot 2](screenshots/screenshot_2.png)

## Usage

### Talk
- Tap/click **Tap to talk**
- In fullscreen, press **Space** to toggle push-to-talk

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

GitHub blocks files > **100MB** in normal git pushes. So we do **not** store models/executables in this repo.

### Windows

Recommended: download `whisper-cli` + a model from **GitHub Releases** (or build whisper.cpp yourself).

### Debian / Raspberry Pi OS (Linux)

Provide a Linux `whisper-cli` binary and a model, then point the server at them:

```bash
export WHISPER_CLI=/path/to/whisper-cli
export WHISPER_MODEL=/path/to/ggml-small.bin
```

(You can build whisper.cpp from source and copy the resulting `whisper-cli` into `./bin/`.)

## Security notes

Do **NOT** commit these files:
- `device.json` (contains private key)
- model binaries (`*.bin`), executables (`*.exe`/`*.dll`)

This repo's `.gitignore` excludes them.

## License

MIT (recommended). Add/adjust as needed.
