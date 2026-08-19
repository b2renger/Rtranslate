#!/usr/bin/env python3
"""
Record a speech sample for the latency sweep.

Writes 16 kHz mono 16-bit WAV, which is exactly what the harness and the server
want, so nothing has to be converted later.

Say something with natural sentence boundaries - the NLLB path is sentence-gated,
so a minute of unbroken monologue will measure differently from a minute of
normal speech. Read a paragraph aloud rather than improvising.

Usage
-----
    python record_sample.py --list
    python record_sample.py --out samples/fr_60s.wav --seconds 60
    python record_sample.py --out samples/en_60s.wav --seconds 60 --device 2
"""

from __future__ import annotations

import argparse
import sys
import time
import wave
from pathlib import Path

try:
    import numpy as np
    import sounddevice as sd
except ImportError:
    sys.exit("Missing deps. Run: uv pip install --python .venv\\Scripts\\python.exe sounddevice numpy")

RATE = 16_000


def list_devices() -> None:
    print()
    for idx, dev in enumerate(sd.query_devices()):
        if dev["max_input_channels"] > 0:
            default = " (default)" if idx == sd.default.device[0] else ""
            print(f"  [{idx:2}] {dev['name']}{default}")
    print()


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--out", help="output WAV path")
    p.add_argument("--seconds", type=float, default=60.0)
    p.add_argument("--device", type=int, default=None, help="input device index (see --list)")
    p.add_argument("--list", action="store_true", help="list input devices and exit")
    args = p.parse_args()

    if args.list:
        list_devices()
        return

    if not args.out:
        p.error("--out is required (or use --list)")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)

    n_frames = int(args.seconds * RATE)
    print(f"\nRecording {args.seconds:.0f} s at {RATE} Hz mono -> {out}")
    for count in (3, 2, 1):
        print(f"  {count}...", end="", flush=True)
        time.sleep(1)
    print("  speak.\n")

    buf = sd.rec(n_frames, samplerate=RATE, channels=1, dtype="int16", device=args.device)

    start = time.monotonic()
    while True:
        elapsed = time.monotonic() - start
        if elapsed >= args.seconds:
            break
        bar = int(40 * elapsed / args.seconds)
        print(f"\r  [{'#' * bar}{'.' * (40 - bar)}] {elapsed:5.1f}s", end="", flush=True)
        time.sleep(0.2)
    sd.wait()
    print(f"\r  [{'#' * 40}] {args.seconds:5.1f}s")

    audio = buf.reshape(-1)
    peak = int(np.abs(audio).max())
    with wave.open(str(out), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(audio.tobytes())

    print(f"\n  wrote {out}  ({len(audio) / RATE:.1f} s, peak {peak}/32767)")
    if peak < 3000:
        print("  !! Very quiet. Check the input device and re-record, or the ASR will struggle.")
    elif peak > 32000:
        print("  !! Clipping. Lower the input gain and re-record.")
    print()


if __name__ == "__main__":
    main()
