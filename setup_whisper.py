import io
import os
import sys
import zipfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BIN_DIR = ROOT / "bin"
MODEL_DIR = ROOT / "models"

WHISPER_CPP_ZIP_URL = "https://github.com/ggml-org/whisper.cpp/releases/download/v1.7.5/whisper-bin-x64.zip"
MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"


def download(url: str) -> bytes:
    print(f"Downloading: {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "openclaw-voice-console"})
    with urllib.request.urlopen(req) as resp:
        return resp.read()


def main() -> int:
    BIN_DIR.mkdir(parents=True, exist_ok=True)
    MODEL_DIR.mkdir(parents=True, exist_ok=True)

    whisper_exe = BIN_DIR / "main.exe"
    if not whisper_exe.exists():
        try:
            data = download(WHISPER_CPP_ZIP_URL)
        except Exception as e:
            print("ERROR: failed to download whisper.cpp binaries:", e)
            print("You can manually place whisper.cpp main.exe into:", BIN_DIR)
            return 2

        try:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                # Extract only main.exe (and optionally needed DLLs)
                members = [m for m in z.namelist() if m.lower().endswith("main.exe") or m.lower().endswith(".dll")]
                if not members:
                    print("ERROR: zip did not contain main.exe")
                    return 3
                z.extractall(BIN_DIR, members)
        except Exception as e:
            print("ERROR: failed to unzip whisper.cpp:", e)
            return 4

        # Some zips have nested folders. Find main.exe.
        found = None
        for p in BIN_DIR.rglob("main.exe"):
            found = p
            break
        if found and found != whisper_exe:
            whisper_exe.parent.mkdir(parents=True, exist_ok=True)
            found.replace(whisper_exe)
        if not whisper_exe.exists():
            print("ERROR: main.exe not found after extraction")
            return 5

    model_path = MODEL_DIR / "ggml-small.bin"
    if not model_path.exists() or model_path.stat().st_size < 10_000_000:
        try:
            data = download(MODEL_URL)
        except Exception as e:
            print("ERROR: failed to download model:", e)
            print("You can manually download ggml-small.bin and place it into:", MODEL_DIR)
            return 6
        model_path.write_bytes(data)

    print("OK")
    print("main.exe:", whisper_exe)
    print("model:", model_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
