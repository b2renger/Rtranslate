#!/usr/bin/env python3
"""
Clap-to-caption latency harness for WhisperLiveKit.

Streams a WAV file to a running whisperlivekit-server at exactly 1x speed over the
native WebSocket API, and reports how long after a word was *spoken* it appeared.

Latency definition
------------------
For every newly committed segment the server sends:

    latency = wall_clock_since_stream_start - audio_end_time_of_that_segment

The segment covers audio up to `end` seconds into the file; we did not see it
until `wall_clock` seconds after the stream started. Because the file is streamed
at exactly 1x, those two clocks are directly comparable. That difference is the
honest mouth-to-screen number.

Transcript and translation are measured separately, which is the point: it is how
you confirm (or refute) that NLLB is sentence-gated while native English
translation is not.

Usage
-----
    python measure_latency.py --wav samples/fr_60s.wav --language fr
    python measure_latency.py --wav samples/en_60s.wav --language en --target-language fra_Latn
    python measure_latency.py --wav samples/fr_60s.wav --language fr --json out.json

Requires: websockets, numpy  (installed by setup.ps1)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
import time
import wave
from dataclasses import dataclass, field, asdict
from pathlib import Path

try:
    import numpy as np
except ImportError:
    sys.exit("numpy is missing. Activate the venv, or run: uv pip install numpy")

try:
    import websockets
except ImportError:
    sys.exit("websockets is missing. Activate the venv, or run: uv pip install websockets")


TARGET_RATE = 16_000
CHUNK_MS = 40
SAMPLES_PER_CHUNK = TARGET_RATE * CHUNK_MS // 1000  # 640 samples = 1280 bytes


# --------------------------------------------------------------------------- #
# audio
# --------------------------------------------------------------------------- #

def load_wav_as_pcm16(path: Path) -> np.ndarray:
    """Read any PCM WAV, downmix to mono, resample to 16 kHz, return int16."""
    with wave.open(str(path), "rb") as w:
        n_channels = w.getnchannels()
        sampwidth = w.getsampwidth()
        rate = w.getframerate()
        frames = w.readframes(w.getnframes())

    if sampwidth == 2:
        data = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    elif sampwidth == 4:
        data = np.frombuffer(frames, dtype="<i4").astype(np.float32) / 2147483648.0
    elif sampwidth == 1:
        data = (np.frombuffer(frames, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    else:
        raise SystemExit(f"Unsupported WAV sample width: {sampwidth} bytes")

    if n_channels > 1:
        data = data.reshape(-1, n_channels).mean(axis=1)

    if rate != TARGET_RATE:
        duration = len(data) / rate
        n_out = int(round(duration * TARGET_RATE))
        src_t = np.arange(len(data), dtype=np.float64) / rate
        dst_t = np.arange(n_out, dtype=np.float64) / TARGET_RATE
        data = np.interp(dst_t, src_t, data).astype(np.float32)

    return np.clip(data * 32768.0, -32768, 32767).astype("<i2")


# --------------------------------------------------------------------------- #
# protocol helpers
# --------------------------------------------------------------------------- #

def parse_timestamp(value) -> float | None:
    """Server sends 'H:MM:SS' or 'H:MM:SS.ffffff' (str(timedelta)); tolerate floats."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip()
    if not text:
        return None
    try:
        parts = [float(p) for p in text.split(":")]
    except ValueError:
        return None
    seconds = 0.0
    for part in parts:
        seconds = seconds * 60.0 + part
    return seconds


@dataclass
class Event:
    kind: str          # "transcript" | "translation"
    wall: float        # seconds since stream start
    audio_end: float   # seconds into the audio the segment ends at
    latency: float
    after_eos: bool
    text: str


@dataclass
class Run:
    label: str
    language: str
    target_language: str | None
    wav: str
    audio_seconds: float
    events: list[Event] = field(default_factory=list)
    first_text_at: float | None = None
    final_transcript: str = ""
    final_translation: str = ""
    stream_seconds: float = 0.0
    total_seconds: float = 0.0


def line_key(line: dict) -> str:
    return f"{line.get('speaker')}|{line.get('start')}"


# --------------------------------------------------------------------------- #
# main measurement
# --------------------------------------------------------------------------- #

async def measure(args) -> Run:
    wav_path = Path(args.wav)
    if not wav_path.exists():
        raise SystemExit(f"WAV not found: {wav_path}")

    pcm = load_wav_as_pcm16(wav_path)
    audio_seconds = len(pcm) / TARGET_RATE

    params = [f"language={args.language}"]
    if args.target_language:
        params.append(f"target_language={args.target_language}")
    if args.token:
        params.append(f"token={args.token}")
    url = f"{args.url}?{'&'.join(params)}"

    run = Run(
        label=args.label,
        language=args.language,
        target_language=args.target_language,
        wav=str(wav_path),
        audio_seconds=audio_seconds,
    )

    print(f"  audio      {audio_seconds:6.1f} s  ({wav_path.name})")
    print(f"  connecting {url}")

    seen_transcript: dict[str, str] = {}
    seen_translation: dict[str, str] = {}
    eos = asyncio.Event()
    stopped = asyncio.Event()
    t0 = 0.0

    async with websockets.connect(url, max_size=None, ping_interval=None) as ws:

        async def receiver():
            nonlocal t0
            async for raw in ws:
                if isinstance(raw, bytes):
                    continue
                now = time.monotonic() - t0 if t0 else 0.0
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue

                if msg.get("type") == "config":
                    if msg.get("useAudioWorklet") is False:
                        print(
                            "\n  !! Server is NOT in PCM mode. Restart it with --pcm-input,\n"
                            "     otherwise it will try to FFmpeg-decode our raw samples.",
                            file=sys.stderr,
                        )
                    continue

                if msg.get("type") == "ready_to_stop":
                    stopped.set()
                    continue

                lines = msg.get("lines") or msg.get("new_lines") or []
                for line in lines:
                    if line.get("speaker") == -2:      # silence marker
                        continue
                    key = line_key(line)
                    audio_end = parse_timestamp(line.get("end"))
                    if audio_end is None:
                        continue

                    text = (line.get("text") or "").strip()
                    if text and text != seen_transcript.get(key, ""):
                        delta = text[len(seen_transcript.get(key, "")):].strip() or text
                        seen_transcript[key] = text
                        if run.first_text_at is None:
                            run.first_text_at = now
                        run.events.append(Event(
                            kind="transcript", wall=now, audio_end=audio_end,
                            latency=now - audio_end, after_eos=eos.is_set(), text=delta,
                        ))

                    trans = (line.get("translation") or "").strip()
                    if trans and trans != seen_translation.get(key, ""):
                        delta = trans[len(seen_translation.get(key, "")):].strip() or trans
                        seen_translation[key] = trans
                        run.events.append(Event(
                            kind="translation", wall=now, audio_end=audio_end,
                            latency=now - audio_end, after_eos=eos.is_set(), text=delta,
                        ))

        recv_task = asyncio.create_task(receiver())

        t0 = time.monotonic()
        n_chunks = (len(pcm) + SAMPLES_PER_CHUNK - 1) // SAMPLES_PER_CHUNK
        for i in range(n_chunks):
            target = t0 + (i + 1) * CHUNK_MS / 1000.0
            drift = target - time.monotonic()
            if drift > 0:
                await asyncio.sleep(drift)
            chunk = pcm[i * SAMPLES_PER_CHUNK:(i + 1) * SAMPLES_PER_CHUNK]
            await ws.send(chunk.tobytes())

        run.stream_seconds = time.monotonic() - t0
        eos.set()
        await ws.send(b"")                      # documented end-of-audio signal
        print(f"  streamed   {run.stream_seconds:6.1f} s, waiting for final commits...")

        try:
            await asyncio.wait_for(stopped.wait(), timeout=args.flush_timeout)
        except asyncio.TimeoutError:
            print(f"  (no ready_to_stop within {args.flush_timeout:.0f} s, moving on)")

        run.total_seconds = time.monotonic() - t0
        recv_task.cancel()

    run.final_transcript = " ".join(seen_transcript.values()).strip()
    run.final_translation = " ".join(seen_translation.values()).strip()
    return run


# --------------------------------------------------------------------------- #
# reporting
# --------------------------------------------------------------------------- #

def percentile(values: list[float], pct: float) -> float:
    if not values:
        return float("nan")
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, int(round((pct / 100.0) * (len(ordered) - 1)))))
    return ordered[idx]


def summarise(run: Run) -> dict:
    out = {}
    for kind in ("transcript", "translation"):
        live = [e.latency for e in run.events if e.kind == kind and not e.after_eos]
        tail = [e.latency for e in run.events if e.kind == kind and e.after_eos]
        out[kind] = {
            "n": len(live),
            "n_after_eos": len(tail),
            "median": statistics.median(live) if live else None,
            "mean": statistics.fmean(live) if live else None,
            "p90": percentile(live, 90) if live else None,
            "max": max(live) if live else None,
        }
    return out


def report(run: Run, stats: dict) -> None:
    print()
    print("  " + "-" * 64)
    print(f"  {'stream':<12} {'n':>5} {'median':>9} {'mean':>9} {'p90':>9} {'max':>9}")
    print("  " + "-" * 64)
    for kind in ("transcript", "translation"):
        s = stats[kind]
        if not s["n"]:
            print(f"  {kind:<12} {'-':>5} {'(none)':>9}")
            continue
        print(
            f"  {kind:<12} {s['n']:>5} {s['median']:>8.2f}s {s['mean']:>8.2f}s "
            f"{s['p90']:>8.2f}s {s['max']:>8.2f}s"
        )
    print("  " + "-" * 64)
    if run.first_text_at is not None:
        print(f"  first text on screen at {run.first_text_at:.2f} s")
    tail = stats["transcript"]["n_after_eos"] + stats["translation"]["n_after_eos"]
    if tail:
        print(f"  ({tail} further commits arrived after end-of-audio, excluded above)")
    print()
    if run.final_transcript:
        print("  transcript :", run.final_transcript[:400])
    if run.final_translation:
        print("  translation:", run.final_translation[:400])
    print()


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--wav", required=True, help="WAV file to stream (any rate/channels; converted in-process)")
    p.add_argument("--url", default="ws://127.0.0.1:8765/asr")
    p.add_argument("--language", default="fr", help="source language code, or 'auto'")
    p.add_argument("--target-language", default=None, help="e.g. fra_Latn to force the NLLB path")
    p.add_argument("--token", default=None, help="API token, if the server was started with one")
    p.add_argument("--label", default="run", help="label recorded in the JSON output")
    p.add_argument("--flush-timeout", type=float, default=45.0)
    p.add_argument("--json", default=None, help="append the result as a JSON line to this file")
    args = p.parse_args()

    print(f"\n[{args.label}] language={args.language} target={args.target_language or '-'}")
    run = asyncio.run(measure(args))
    stats = summarise(run)
    report(run, stats)

    if args.json:
        payload = {k: v for k, v in asdict(run).items() if k != "events"}
        payload["stats"] = stats
        payload["events"] = [asdict(e) for e in run.events]
        with open(args.json, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(payload, ensure_ascii=False) + "\n")
        print(f"  appended to {args.json}\n")


if __name__ == "__main__":
    main()
