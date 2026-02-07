import json
import os
import subprocess
import tempfile
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
BIN_DIR = ROOT / "bin"
MODEL_DIR = ROOT / "models"
PUBLIC_DIR = ROOT / "public"

OPENCLAW_URL = os.environ.get("OPENCLAW_URL", "ws://127.0.0.1:18789")
OPENCLAW_TOKEN = os.environ.get("OPENCLAW_TOKEN", "")
SESSION_KEY = os.environ.get("OPENCLAW_SESSION", "main")


def run_whisper(wav_path: Path) -> str:
    # whisper.cpp renamed binaries: main -> whisper-cli
    exe = BIN_DIR / "whisper-cli.exe"
    if not exe.exists():
        # fallback for older builds
        exe = BIN_DIR / "main.exe"
    model = MODEL_DIR / "ggml-small.bin"
    if not exe.exists() or not model.exists():
        raise RuntimeError("whisper.cpp not installed. Run setup_whisper.py")

    # whisper.cpp writes output files; use a temp prefix
    with tempfile.TemporaryDirectory(prefix="openclaw-voice-stt-") as td:
        td = Path(td)
        out_prefix = td / "out"
        cmd = [
            str(exe),
            "-m", str(model),
            "-l", "de",
            "-nt",  # no timestamps
            "-of", str(out_prefix),
            str(wav_path),
        ]
        p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
        if p.returncode != 0:
            raise RuntimeError(f"whisper.cpp failed ({p.returncode}): {p.stderr.strip() or p.stdout.strip()}")

        txt = (out_prefix.with_suffix(".txt"))
        if not txt.exists():
            # Fallback: sometimes whisper.cpp prints text to stdout
            out = (p.stdout or "").strip()
            if out:
                return out
            raise RuntimeError("No transcript produced.")
        return txt.read_text(encoding="utf-8", errors="replace").strip()


def run_tts_de(text: str) -> Path:
    ps1 = ROOT / "tts_de.ps1"
    if not ps1.exists():
        raise RuntimeError("tts_de.ps1 missing")
    out = Path(tempfile.gettempdir()) / f"openclaw-tts-{int(time.time()*1000)}.wav"
    cmd = [
        "powershell",
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", str(ps1),
        "-Text", text,
        "-OutFile", str(out),
    ]
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if p.returncode != 0:
        raise RuntimeError(f"TTS failed ({p.returncode}): {p.stderr.strip() or p.stdout.strip()}")
    return out


class Handler(SimpleHTTPRequestHandler):
    def _json(self, status: int, payload: dict):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/stt":
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0:
                return self._json(400, {"error": "empty body"})
            body = self.rfile.read(length)
            with tempfile.NamedTemporaryFile(prefix="openclaw-voice-", suffix=".wav", delete=False) as f:
                f.write(body)
                tmp = Path(f.name)
            try:
                text = run_whisper(tmp)
                return self._json(200, {"text": text})
            except Exception as e:
                return self._json(500, {"error": str(e)})
            finally:
                try:
                    tmp.unlink(missing_ok=True)
                except Exception:
                    pass

        if parsed.path == "/api/tts":
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length)
            try:
                req = json.loads(body.decode("utf-8"))
                text = str(req.get("text", "")).strip()
                if not text:
                    return self._json(400, {"error": "text required"})
                out = run_tts_de(text)
                return self._json(200, {"path": str(out)})
            except Exception as e:
                return self._json(500, {"error": str(e)})

        return self._json(404, {"error": "not found"})

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/config":
            return self._json(200, {
                "openclawUrl": OPENCLAW_URL,
                "sessionKey": SESSION_KEY,
                "hasToken": bool(OPENCLAW_TOKEN.strip()),
            })

        # serve generated wav from temp directory via /tmp?file=
        if parsed.path == "/tmp":
            from urllib.parse import parse_qs
            qs = parse_qs(parsed.query)
            p = qs.get("file", [""])[0]
            if not p:
                return self._json(400, {"error": "file required"})
            fp = Path(p)
            if not fp.exists() or fp.suffix.lower() not in (".wav", ".mp3"):
                return self._json(404, {"error": "not found"})
            data = fp.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav" if fp.suffix.lower()==".wav" else "audio/mpeg")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        return super().do_GET()

    def translate_path(self, path):
        # Serve from PUBLIC_DIR
        path = urlparse(path).path
        if path == "/":
            path = "/index.html"
        rel = path.lstrip("/")
        return str(PUBLIC_DIR / rel)


def main():
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
    host = "127.0.0.1"
    port = int(os.environ.get("VOICE_PORT", "4888"))
    httpd = ThreadingHTTPServer((host, port), Handler)
    print(f"Voice Console: http://{host}:{port}/")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
