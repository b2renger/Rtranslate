# Feasibility audit — local live transcription on Windows

**Original scope: French, English, Chinese.** *Superseded by
[plan.md](plan.md), which narrows to French ↔ English.* Kept because the
Chinese analysis is what justified the narrowing, and because the hardware,
Windows and packaging sections apply to any scope.

**Date:** 19 August 2026 · **Target:** Windows 11, NVIDIA CUDA

---

## Verdict — viable, with three caveats that shape the whole design

WhisperLiveKit is the right base: an actively developed Python package with a
FastAPI + WebSocket server, a real simultaneous-decoding policy (AlignAtt),
built-in NLLB translation across 200 languages, and per-session language
switching via WebSocket query parameters — exactly the hook an Electron UI
needs. Nothing about it is Linux-only. But its most-documented paths assume
Linux, and three specific things bite on Windows.

| | |
|---|---|
| **~1.0–1.5 s** | Realistic mouth-to-screen latency for transcription in the same language, `large-v3` on a 16 GB Ada card |
| **~2–4 s** | For *translated* output. Translation is sentence-gated, not streaming — this is the surprise |
| **16 GB** | VRAM target. 12 GB is the floor; below that you drop model size or drop translation |
| **3–4 GB** | Installed size of the CUDA PyTorch stack alone. The installer strategy is a real design decision |

---

## 1. What WhisperLiveKit actually gives you

Not a thin wrapper around Whisper. Whisper is built for complete utterances;
feeding it small chunks cuts words mid-syllable and loses context.
WhisperLiveKit implements published simultaneous-speech policies on top.
**AlignAtt** — from ÚFAL's SimulStreaming, state of the art at IWSLT 2025 — reads
the encoder–decoder attention to decide, at each decoding step, whether the model
is leaning too close to the end of the audio buffer. If so, decoding stops and
waits for more audio. That deliberate wait is where most of the latency budget
goes, and it is tunable.

| Backend | What it is | Windows + CUDA | Use it? |
|---|---|---|---|
| `simulstreaming` | Default policy; AlignAtt on vanilla PyTorch Whisper | Yes — pure PyTorch | **Primary**, lowest latency, but see licence |
| `faster-whisper` | CTranslate2 Whisper, INT8/FP16 | Yes, cuDNN 9 DLL friction | **Fallback**, permissive licence, lower VRAM |
| `funasr` | SenseVoiceSmall, non-autoregressive | Yes | **For Chinese** — see §3 |
| `qwen3-vllm` | Qwen3-ASR served by vLLM | **No** — no real Windows support | Exclude |
| `canary` / `sortformer` | NVIDIA NeMo models | Painful on Windows | Exclude v1 |
| `voxtral` | Mistral 4B multilingual speech model | Yes (HF path), heavy | Later |
| `mlx-whisper` | Apple Silicon only | N/A | N/A |

### Licence

SimulStreaming is **dual-licensed**: PolyForm Noncommercial 1.0.0 free, separate
commercial licence otherwise (ÚFAL intend it to be free or a symbolic fee for
individuals and SMEs, with registration). WhisperLiveKit itself is Apache 2.0.
For commercial use, either register or run `--backend-policy localagreement` with
`faster-whisper`.

---

## 2. Where the seconds go

Published GPU numbers are usually *batch* real-time factors — an RTX 3090
transcribing an hour in four minutes (RTF ≈ 0.07). True, and almost irrelevant.
Streaming pays a policy wait, a segmentation wait and a re-encode every step.

Modelled for `large-v3` on a 16 GB Ada card:

**Transcription — FR→FR — ≈ 1 080 ms**

| Stage | ms |
|---|---:|
| Capture & chunk | 180 |
| VAD / segmentation | 120 |
| **AlignAtt policy wait** | **500** |
| Whisper encode + decode | 250 |
| Transport + render | 30 |

**Transcription + translation — ≈ 2 230 ms**

| Stage | ms |
|---|---:|
| Capture & chunk | 180 |
| VAD / segmentation | 120 |
| AlignAtt policy wait | 500 |
| Whisper encode + decode | 250 |
| **Wait for sentence end** | **900** |
| NLLB + transport + render | 280 |

The AlignAtt figure is exact by construction: `--frame-threshold 25` at 0.02 s
per frame for `large-v3` is a 500 ms lookahead. The rest are estimates.

### Three levers

- `--frame-threshold` — lower it (say 15) and text commits sooner, at the cost of
  more revisions. The biggest latency dial.
- **Model size** — `large-v3` → `medium` roughly halves the compute segment.
- `--pause-segmentation-seconds` — defaults to 5.0; governs transcript boundaries,
  shapes how chunky the display feels.

**Honest headline:** same-language captions feel live. Translated captions
visibly trail, because NLLB translates completed sentences. The experimental
`--translation-backend alignatt` streams from an LLM sidecar with append-only
output — lower latency, but it wants a second large model in VRAM.

---

## 3. Chinese — the analysis that scoped this project down

> **This section is why the project is now French ↔ English only.**

Two things people assume and shouldn't.

**First: Whisper's own translation only goes to English.** Its `translate` task
is X→English, full stop. There is no Whisper path from French to Chinese. That is
what `--target-language` and the NLLB backend exist for — a separate translation
model, a separate download, a separate latency cost. Your UI has two independent
selectors backed by two different models.

**Second: Whisper is comparatively weak on Mandarin.** Reported character error
rates put `large-v3` around 20% CER on Chinese benchmarks where SenseVoiceSmall
lands near 8% — and SenseVoice is non-autoregressive, so it is roughly an order
of magnitude faster too. WhisperLiveKit ships it as the `funasr` backend
(Mandarin, Cantonese, English, Japanese, Korean).

Those numbers come partly from [FunASR's own benchmarking](https://www.funasr.com/en/blog/funasr-vs-whisper-benchmark.html),
so they warrant independent verification — but the direction is consistent across
sources and the architecture explains it. See also the
[FunAudioLLM paper](https://arxiv.org/pdf/2407.04051).

| Pair | ASR | Translation | Expected feel |
|---|---|---|---|
| FR → FR | Whisper large-v3 / medium | none | ~1 s, Whisper's French is strong |
| EN → EN | Whisper large-v3 / medium | none | ~1 s, best-case quality |
| ZH → ZH | SenseVoice (funasr) | none | <1 s, faster and more accurate than Whisper |
| FR → EN | Whisper | NLLB, or Whisper `translate` | ~2 s, only pair Whisper does natively |
| FR → ZH | Whisper | NLLB-200 `zho_Hans` | ~2–3 s, sentence-gated |
| ZH → FR/EN | SenseVoice or Whisper | NLLB-200 | ~2–3 s, verify punctuation feeds the sentence splitter |

**Practical consequence:** if the user picks Chinese as the *source*, you likely
want to switch backend, not just pass a language code — and backend switching
means restarting the Python sidecar, whereas language switching does not. Either
design the state machine for that from the start, or accept Whisper-for-everything
in v1 and add the SenseVoice path later.

**A sharp edge:** Chinese language codes are inconsistent across the ecosystem
(`zh`, `zh-CN`, `zh-Hans` for Whisper; `zho_Hans` / `zho_Hant` for NLLB).
WhisperLiveKit added normalisation for the Whisper side in a recent release, but
an app should hold its own canonical mapping table rather than forwarding the OS
locale. Simplified vs Traditional must be decided explicitly — NLLB treats them
as different targets.

### Why this justified narrowing scope

Supporting Chinese well means a second ASR backend, backend-switching state in
the UI, sidecar restarts on source-language change, a Simplified/Traditional
decision, and a language-code mapping layer with three ecosystems in it. Dropping
it collapses all of that into a single model loaded once — and, because Whisper
translates natively to English, turns FR→EN from a two-model problem into a
zero-extra-cost one.

---

## 4. Hardware (original, general recommendation)

Two VRAM stories. Under `faster-whisper`/CTranslate2, `large-v3` loads in roughly
3 GB. Under SimulStreaming — vanilla PyTorch Whisper, which the low-latency path
uses — ÚFAL recommend **at least 10 GB**. Add NLLB-600M (~1.5–3 GB) if
translating, plus Windows' compositor tax, and 12 GB is tight while 16 GB is
comfortable.

| GPU | VRAM | Verdict | Notes |
|---|---|---|---|
| GTX 10-series | 8–11 GB | Avoid | Pascal: no usable FP16 tensor path, needs legacy cu126 wheels |
| RTX 2070 / 2080 Ti | 8–11 GB | Marginal | Works with faster-whisper; too tight for SimulStreaming + NLLB |
| RTX 3060 12 GB | 12 GB | Floor | Budget pick purely for its 12 GB. Batch RTF ≈ 0.15 |
| RTX 3090 | 24 GB | Great value | Batch RTF ≈ 0.07; used-market sweet spot |
| RTX 4070 / 4070 Super | 12 GB | Good | Fast; 12 GB caps stacking translation + diarization |
| **RTX 4070 Ti Super / 4080** | 16 GB | **Recommended** | Everything resident with headroom |
| RTX 5070 Ti / 5080 | 16 GB | Verify | Blackwell (sm_120) needs CUDA 12.8+; confirm CTranslate2 support |
| RTX 4090 / 5090 | 24–32 GB | Overkill | Only for the LLM translation sidecar or Voxtral |

> Superseded by [plan.md §5](plan.md#5-hardware), which evaluates the three cards
> actually on hand (3070 8 GB, 4070 Ti 12 GB, 4080 16 GB) and recommends
> starting on the 3070.

---

## 5. Windows — the five landmines

| Issue | Symptom | Mitigation |
|---|---|---|
| cuDNN 9 DLLs | `Could not locate cudnn_ops64_9.dll` — filed against WhisperLiveKit ([#286](https://github.com/QuentinFuxa/WhisperLiveKit/issues/286)), faster-whisper ([#1080](https://github.com/SYSTRAN/faster-whisper/issues/1080)) and CTranslate2 | Pin `torch >= 2.4`, pip-install `nvidia-cudnn-cu12`, have the launcher prepend its `bin` to `PATH` before import. In spawn code, not docs |
| FFmpeg | Server decodes WebM via FFmpeg; torchaudio's Windows DLL discovery is brittle | **Sidestep it.** Run `--pcm-input`, send raw 16 kHz mono Int16 PCM from an AudioWorklet |
| NeMo / vLLM extras | Sortformer, Canary, Qwen3-vLLM assume Linux | Exclude from v1. `diart` is the Windows-friendlier diarization path, pinned to Python 3.11–3.12 |
| Install size | CUDA PyTorch wheels are 3–4 GB installed | Small installer; download runtime, wheels and models on first run |
| System-audio capture | `desktopCapturer` loopback on Windows has a long history of `NotSupportedError` and renderer crashes | Mic capture as the reliable path; loopback best-effort with a VB-Cable / VoiceMeeter fallback |

**Pin Python 3.12** — inside every relevant dependency's supported range,
including `diart`'s, and avoids bleeding-edge wheel gaps on 3.13+.

---

## 6. Prior art

Nobody has shipped exactly this — Electron + WhisperLiveKit + live translation on
Windows. Every piece has precedent:

- **[TranscriptionSuite](https://github.com/homelab-00/TranscriptionSuite)** — the
  closest analogue: Electron dashboard + Python backend, Windows installers, CUDA
  via Docker/WSL2, a native `whisper-server.exe` for the non-CUDA path, hardware
  auto-detection, and a Live Mode for sentence-by-sentence realtime.
- **[Collabora/WhisperLive](https://github.com/collabora/WhisperLive)** — the other
  mature realtime server, TensorRT-capable.
- **[EasyWhisperUI](https://github.com/mehtabmahir/easy-whisper-ui)**,
  **WhisperScript** — Electron GUIs over whisper.cpp with CUDA/Vulkan/CPU builds.
- **[electron-speech-to-speech](https://github.com/Kutalia/electron-speech-to-speech)**
  — whisper.cpp as a Node native addon, live captions in-process.

**The architectural fork:** Python sidecar (full features, 3–4 GB of dependencies)
versus whisper.cpp Node addon (small, self-contained, no Python — but no AlignAtt,
no NLLB, no SenseVoice). With three languages and cross-translation, the sidecar
wins. If latency and install size ever matter more than translation quality, the
other fork exists.

---

## 7. Architecture

```
Renderer:   source picker, language selectors, caption view
            AudioWorklet 48k→16k mono Int16, WebSocket client
                            │  raw PCM frames
Electron main: spawns + supervises sidecar, health checks, first-run download
                            │  child_process, 127.0.0.1 only
whisperlivekit-server --pcm-input
  AlignAtt policy → Whisper / SenseVoice (CUDA) → NLLB-200 (if target ≠ source)
                            ▲  JSON: committed lines + grey buffer
```

Language selection is a WebSocket query parameter, not a server flag, so changing
either dropdown is one socket reconnect — no process restart, no model reload.
Only three things force a sidecar restart: switching model size, switching
backend (Whisper ↔ SenseVoice), and turning translation on if launched without
NLLB weights.

---

## 8. Original phased plan

Sequencing principle: **prove the GPU and the latency before writing a single line
of Electron.**

- **P0 — Bare-metal spike** (half a day, blocking). Confirm CUDA; hit and fix the
  cuDNN error; measure real latency for `large-v3` and `medium` at
  `--frame-threshold` 25 and 15; test FR→EN and FR→ZH; compare `funasr` against
  Whisper on Chinese.
- **P1 — Sidecar contract** (1–2 days). PATH fix, free-port selection, health
  polling, crash restart, guaranteed kill on quit, localhost binding.
- **P2 — Audio path** (2–3 days). Device enumeration, AudioWorklet resampler,
  loopback as experimental, level meter.
- **P3 — UI** (2–3 days). Three controls, committed-vs-provisional rendering,
  reconnect on language change, transcript export.
- **P4 — Language matrix** (1–2 days). Canonical code map, Simplified/Traditional
  decision, SenseVoice routing, all nine source×target combinations.
- **P5 — Packaging and first run** (3–5 days, the real risk). Small installer,
  first-run download with progress, VRAM detection, pinned versions, clean-VM test.
- **P6 — Optional.** diarization via `diart`, streaming translation via
  `alignatt`, OBS/NDI output or an overlay window.

---

## 9. Original open questions

- **Commercial or not?** Picks the default backend, because of the SimulStreaming licence.
- **Whose machine does this run on?** Yours only → skip the first-run installer problem.
  Other people's → P5 becomes the largest phase.
- **Is system audio required, or is a microphone enough?** Loopback on Windows is the
  flakiest item in this audit.
- **Simplified or Traditional Chinese** — and is Cantonese in scope? *(Resolved by
  dropping Chinese.)*

---

## Sources

- [QuentinFuxa/WhisperLiveKit](https://github.com/QuentinFuxa/WhisperLiveKit)
- [ufal/SimulStreaming](https://github.com/ufal/SimulStreaming)
- [AlignAtt paper](https://arxiv.org/pdf/2305.11408)
- [WhisperLiveKit #286](https://github.com/QuentinFuxa/WhisperLiveKit/issues/286) — cuDNN on Windows
- [faster-whisper #1080](https://github.com/SYSTRAN/faster-whisper/issues/1080)
- [TranscriptionSuite](https://github.com/homelab-00/TranscriptionSuite)
- [Collabora/WhisperLive](https://github.com/collabora/WhisperLive)
- [EasyWhisperUI](https://github.com/mehtabmahir/easy-whisper-ui)
- [electron-speech-to-speech](https://github.com/Kutalia/electron-speech-to-speech)
- [FunAudioLLM](https://arxiv.org/pdf/2407.04051) — SenseVoice architecture and CJK benchmarks
- [FunASR vs Whisper Chinese benchmark](https://www.funasr.com/en/blog/funasr-vs-whisper-benchmark.html) — vendor-published, verify independently
- [Whisper RTF and VRAM by GPU](https://gigagpu.com/best-gpu-for-whisper/)
- [Electron desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer)

---

*Latency figures marked as modelled are estimates derived from published policy
parameters and batch RTF data, not measurements. Phase 0 exists to replace them.*
