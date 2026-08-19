# WhisperLive

A local, GPU-accelerated live transcription and translation desktop app for
Windows. French ↔ English. Nothing leaves the machine.

An Electron shell around a [WhisperLiveKit](https://github.com/QuentinFuxa/WhisperLiveKit)
sidecar: pick an audio source, a spoken language and a display language, and read
captions as people talk.

## Status

**Phase 0 — measurement.** No application code yet, and deliberately so: the
plan's sequencing principle is *prove the GPU and the latency before writing a
single line of Electron*. Phase 0 is a half-day spike whose only job is to
replace the plan's modelled estimates with measured numbers.

| Phase | What | State |
|---|---|---|
| **P0** | Bare-metal spike: measure latency and VRAM | tooling ready, awaiting a run |
| P1 | Sidecar contract (spawn, supervise, kill) | blocked on P0 |
| P2 | Audio path (device picker, AudioWorklet, PCM) | blocked on P0 |
| P3 | Interface | blocked on P0 |
| P4 | Language matrix | blocked on P0 |
| P5 | Packaging and first run | — |
| P6 | Optional extras | — |

## Getting started

Phase 0 runs on the **RTX 3070 machine**, not a 4 GB laptop GPU — `large-v3` on
the SimulStreaming path will not fit in 4 GB.

```powershell
cd spike
.\setup.ps1                                          # uv venv 3.12 + CUDA stack + cuDNN fix
.\.venv\Scripts\python.exe record_sample.py --out samples\fr_60s.wav --seconds 60
.\.venv\Scripts\python.exe record_sample.py --out samples\en_60s.wav --seconds 60
.\sweep.ps1                                          # measures everything
.\.venv\Scripts\python.exe report.py                 # renders RESULTS.md
```

See [spike/README.md](spike/README.md) for what each profile is asking and why.

## Layout

```
docs/
  plan.md            The implementation plan. Start here.
  audit-full.md      The original feasibility audit, including the Chinese
                     analysis that scoped this project down to FR/EN.
  websocket-api.md   Verified WhisperLiveKit wire protocol notes.
spike/
  setup.ps1          Environment, CUDA stack, the Windows cuDNN fix
  profiles.json      What the sweep measures, and what question each answers
  sweep.ps1          Runs every profile unattended
  serve.ps1          Drive one profile by hand
  measure_latency.py Streams a WAV at 1x and reports mouth-to-screen latency
  record_sample.py   Records a 16 kHz mono sample
  report.py          results.jsonl -> RESULTS.md
```

## Key decisions already taken

- **French ↔ English only.** Chinese was scoped out; see
  [docs/audit-full.md](docs/audit-full.md) for the analysis that led there.
  Dropping it removes the need for a second ASR backend entirely.
- **One sidecar, one model.** Language selection is a WebSocket query parameter,
  so changing either dropdown is a socket reconnect, not a model reload.
- **`--pcm-input`, always.** Sending raw 16 kHz mono s16le from an AudioWorklet
  sidesteps FFmpeg, which is the more brittle dependency on Windows.

## Open questions Phase 0 must answer

Tracked as checkboxes in `spike/RESULTS.md`. The two that shape the most
downstream work:

1. Can one server serve **both** the native FR→EN path and the NLLB EN→FR path,
   or does flipping direction force a sidecar relaunch?
2. Is `medium` good enough for French and English? If it is, the whole VRAM
   question mostly dissolves and the 3070 carries the project.

## Licence note

The default SimulStreaming backend is dual-licensed (PolyForm Noncommercial +
a separate commercial licence). WhisperLiveKit itself is Apache 2.0. If this
ever becomes commercial, either register for the commercial licence or switch to
`faster-whisper` with the LocalAgreement policy — the `large-fasterwhisper`
profile in the sweep exists to measure exactly what that costs.
