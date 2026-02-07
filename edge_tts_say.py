import argparse
import asyncio
from pathlib import Path

import edge_tts

async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--text", required=True)
    ap.add_argument("--voice", default="de-DE-KatjaNeural")
    ap.add_argument("--rate", default="+0%")
    ap.add_argument("--pitch", default="+0Hz")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    communicate = edge_tts.Communicate(args.text, voice=args.voice, rate=args.rate, pitch=args.pitch)
    await communicate.save(str(out))

if __name__ == "__main__":
    asyncio.run(main())
