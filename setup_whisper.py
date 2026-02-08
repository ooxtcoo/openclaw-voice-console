import io
import os
import sys
import zipfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
BIN_DIR = ROOT / "bin"
MODEL_DIR = ROOT / "models"

# NOTE: whisper.cpp release assets move around over time. We resolve the latest
# Windows x64 binary zip via the GitHub Releases API to avoid hardcoding a dead URL.
WHISPER_CPP_LATEST_API = "https://api.github.com/repos/ggml-org/whisper.cpp/releases/latest"
WHISPER_CPP_ASSET_NAME = "whisper-bin-x64.zip"

MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"


def download(url: str) -> bytes:
    print(f"Downloading: {url}")
    req = urllib.request.Request(url, headers={"User-Agent": "openclaw-voice-console"})
    with urllib.request.urlopen(req) as resp:
        return resp.read()


def resolve_whisper_zip_url() -> str:
    # Fetch latest release JSON and pick the desired asset.
    try:
        raw = download(WHISPER_CPP_LATEST_API)
    except Exception as e:
        raise RuntimeError(f"failed to fetch whisper.cpp latest release metadata: {e}")

    try:
        import json

        j = json.loads(raw.decode("utf-8"))
        assets = j.get("assets") or []
        for a in assets:
            if a.get("name") == WHISPER_CPP_ASSET_NAME and a.get("browser_download_url"):
                return str(a["browser_download_url"])

        # Helpful error message with available asset names
        names = [a.get("name") for a in assets if isinstance(a, dict) and a.get("name")]
        raise RuntimeError(
            f"asset '{WHISPER_CPP_ASSET_NAME}' not found in latest release. Available: {names}"
        )
    except Exception as e:
        raise RuntimeError(f"failed to parse whisper.cpp release metadata: {e}")


def main() -> int:
    BIN_DIR.mkdir(parents=True, exist_ok=True)
    MODEL_DIR.mkdir(parents=True, exist_ok=True)

    whisper_cli = BIN_DIR / "whisper-cli.exe"
    if not whisper_cli.exists():
        try:
            zip_url = resolve_whisper_zip_url()
            data = download(zip_url)
        except Exception as e:
            print("ERROR: failed to download whisper.cpp binaries:", e)
            print("You can manually place whisper-cli.exe into:", BIN_DIR)
            print("Or download the asset:", WHISPER_CPP_ASSET_NAME)
            print("From:", "https://github.com/ggml-org/whisper.cpp/releases/latest")
            return 2

        try:
            with zipfile.ZipFile(io.BytesIO(data)) as z:
                # Extract whisper-cli.exe (and needed DLLs)
                members = [
                    m for m in z.namelist()
                    if m.lower().endswith("whisper-cli.exe") or m.lower().endswith(".dll")
                ]
                if not members:
                    print("ERROR: zip did not contain whisper-cli.exe")
                    return 3
                z.extractall(BIN_DIR, members)
        except Exception as e:
            print("ERROR: failed to unzip whisper.cpp:", e)
            return 4

        # Some zips have nested folders. Find whisper-cli.exe.
        found = None
        for p in BIN_DIR.rglob("whisper-cli.exe"):
            found = p
            break
        if found and found != whisper_cli:
            whisper_cli.parent.mkdir(parents=True, exist_ok=True)
            found.replace(whisper_cli)
        if not whisper_cli.exists():
            print("ERROR: whisper-cli.exe not found after extraction")
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
    print("whisper-cli.exe:", whisper_cli)
    print("model:", model_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
