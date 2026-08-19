# WhisperLive — implementation plan

**Scope:** French ↔ English live transcription and translation, fully local, on
Windows 11 with an NVIDIA GPU, packaged as an Electron app.
**Date:** 19 August 2026
**Companion:** [audit-full.md](audit-full.md) — the original feasibility audit,
which also covers the Chinese analysis that scoped this project down.

---

## 1. Verdict

Viable. WhisperLiveKit is the right base: an actively developed Python package
with a FastAPI + WebSocket server, a real simultaneous-decoding policy (AlignAtt),
and per-session language switching via WebSocket query parameters — exactly the
hook an Electron UI needs. Nothing about it is Linux-only, though its
best-documented paths assume Linux.

Three of the four language pairs are cheap:

| | |
|---|---|
| **~1.0–1.5 s** | FR→FR, EN→EN **and** FR→EN. Whisper translates to English natively, in-model — no second model, no sentence gate. |
| **~2–3 s** | EN→FR only. The one direction that needs NLLB, and NLLB waits for complete sentences. |
| **4070 Ti** | The card to build on. The 3070 gets you started today; the 4080 buys headroom you probably won't spend. |
| **3–4 GB** | Installed size of the CUDA PyTorch stack alone, before weights. The installer strategy is a real design decision. |

> All latency figures in this document are **modelled, not measured**. Phase 0
> exists to replace them. See `spike/RESULTS.md`.

---

## 2. What WhisperLiveKit gives us

It is not a thin wrapper around Whisper. Whisper is built for complete
utterances; feeding it small chunks cuts words mid-syllable and loses context.
WhisperLiveKit implements published simultaneous-speech policies on top.
**AlignAtt** — from ÚFAL's SimulStreaming, state of the art at the IWSLT 2025
shared task — reads the encoder–decoder attention to decide, at each decoding
step, whether the model is leaning too close to the end of the audio buffer. If
it is, decoding stops and waits for more audio. That deliberate wait is where
most of the latency budget goes, and it is tunable.

### Backend matrix

| Backend | What it is | Windows + CUDA | Use it? |
|---|---|---|---|
| `simulstreaming` | Default policy: AlignAtt over vanilla PyTorch Whisper | Yes — pure PyTorch | **Primary.** Lowest latency, but see the licence note |
| `faster-whisper` | CTranslate2 Whisper, INT8/FP16 | Yes, with cuDNN 9 DLL friction | **Fallback.** Permissive licence, lower VRAM |
| `funasr` | SenseVoiceSmall — CJK-focused | Yes | Not needed; this only mattered for Chinese |
| `qwen3-vllm` | Qwen3-ASR served by vLLM | **No** — vLLM has no real Windows support | Exclude |
| `canary` / `sortformer` | NVIDIA NeMo models | Painful — NeMo on Windows is a known slog | Exclude v1 |
| `voxtral` | Mistral 4B multilingual speech model | Yes via HF path, heavy | Later |
| `mlx-whisper` | Apple Silicon MLX | N/A | N/A |

### Licence — settle this before building on the default

SimulStreaming is **dual-licensed**: PolyForm Noncommercial 1.0.0 for free use,
a separate commercial licence otherwise. ÚFAL state they intend commercial terms
to be free or a symbolic one-off fee for individuals and SMEs, with
registration. WhisperLiveKit itself is Apache 2.0.

If this app is ever sold or used commercially, either register for the
commercial licence or run `--backend-policy localagreement` with
`faster-whisper`, which carries no such restriction. **This choice determines
the default backend, so make it first.** The `large-fasterwhisper` sweep profile
measures what the fallback costs in latency.

---

## 3. Where the seconds go

Published GPU numbers for Whisper are almost always *batch* real-time factors —
an RTX 3090 chewing through an hour of audio in four minutes, RTF ≈ 0.07. Those
figures are true and nearly irrelevant here. Streaming pays a policy wait, a
segmentation wait, and a re-encode on every step.

Modelled for `large-v3` on a 16 GB Ada-class card:

**Transcription only — FR spoken, FR displayed — ≈ 1 080 ms**

| Stage | ms |
|---|---:|
| Capture & chunk | 180 |
| VAD / segmentation | 120 |
| **AlignAtt policy wait** | **500** |
| Whisper encode + decode | 250 |
| Transport + render | 30 |

**Native translation — FR spoken, EN displayed — ≈ 1 130 ms**

| Stage | ms |
|---|---:|
| Capture & chunk | 180 |
| VAD / segmentation | 120 |
| **AlignAtt policy wait** | **500** |
| Whisper encode + decode (translating) | 300 |
| Transport + render | 30 |

**NLLB translation — EN spoken, FR displayed — ≈ 2 230 ms**

| Stage | ms |
|---|---:|
| Capture & chunk | 180 |
| VAD / segmentation | 120 |
| AlignAtt policy wait | 500 |
| Whisper encode + decode | 250 |
| **Wait for sentence end** | **900** |
| NLLB + transport + render | 280 |

The AlignAtt figure is exact by construction: the default `--frame-threshold 25`,
at 0.02 s per frame for `large-v3`, is a 500 ms lookahead. Everything else is an
estimate.

### The three levers

- **`--frame-threshold`** — lower it (say to 15) and text commits sooner, at the
  cost of more visible revisions and slightly worse accuracy. The single biggest
  latency dial.
- **Model size** — dropping `large-v3` to `medium` roughly halves the compute
  segment. For French and English in a live-caption context the difference is
  often invisible to the reader.
- **`--pause-segmentation-seconds`** — defaults to 5.0. Governs transcript
  boundaries rather than word latency, but shapes how chunky the display feels.

**The honest headline:** three of four pairs feel live. Only EN→FR trails,
because it routes through NLLB, and NLLB translates completed sentences. The
experimental `--translation-backend alignatt` streams translation from an LLM
sidecar with append-only commits — lower latency, but it wants a second large
model resident in VRAM. On a 12 GB card that is not a realistic v1 option.

---

## 4. Languages — the two directions are not the same price

**Whisper's own translation only goes to English.** Its `translate` task is
X→English, full stop. For a French↔Chinese app that was a limitation. For a
French↔English app it is a gift: `--direct-english-translation` makes the ASR
model emit English directly, in-model, streaming through the same AlignAtt policy
as ordinary transcription. No second model, no second download, no sentence gate.
The docs are explicit that this is faster than NLLB — it is doing one job instead
of two.

EN→FR has no such shortcut. It goes through `--target-language fra_Latn` and
NLLB-200, a separate sentence-level MT model that cannot emit a partial sentence.
That is the ~900 ms sentence gate, and no flag removes it.

| Pair | How | Second model? | Expected feel |
|---|---|---|---|
| FR → FR | `?language=fr` | no | ~1.0–1.5 s |
| EN → EN | `?language=en` | no | ~1.0–1.5 s |
| FR → EN | `--direct-english-translation` | no — in-model | ~1.0–1.5 s — the free lunch |
| EN → FR | `?target_language=fra_Latn` | yes — NLLB-200 | ~2–3 s, sentence-gated |

### The catch, and it is a real one

`--direct-english-translation` makes the model output **English instead of
French**, not English *as well as* French. If the interface shows the source
transcript and its translation side by side, that mode cannot give you both — you
would route FR→EN through NLLB too, and then both directions inherit the sentence
gate.

So the design question is not "which languages" but: **does the user need to see
the original, or only the translation?**

- *Translation-only* keeps three pairs fast.
- *Dual-pane* costs the free lunch.

Decide before Phase 3 — it changes the caption component and the server flags
together.

### Auto language detection

Since both languages come from one Whisper model, `?language=auto` is available
as a source option for bilingual conversations. French and English are
acoustically and orthographically distant, so LID should hold. Phase 0 tests
whether it flips mid-stream on short utterances; if it does, keep it as an
explicit opt-in rather than the default.

---

## 5. Hardware

Two different VRAM stories, and quoting the wrong one is how people buy a card
that cannot run the configuration they wanted. Under `faster-whisper`/CTranslate2,
`large-v3` loads in roughly 3 GB. Under SimulStreaming — vanilla PyTorch Whisper,
which is what the low-latency AlignAtt path actually uses — ÚFAL recommend **at
least 10 GB**. That figure looks conservative for inference alone (1.5B
parameters at FP16 is 3 GB of weights), but it is the only published guidance,
and it is what a 12 GB card has to clear. Phase 0 measures the real number.

**The lever that resolves the squeeze: NLLB does not have to sit on the GPU.**
The docs describe the `nllb` translation backend as in-process and CPU-friendly,
and `--nllb-backend ctranslate2` makes CPU execution genuinely fast for a 600M
model translating one sentence at a time. Since EN→FR is already sentence-gated,
a few hundred milliseconds of CPU inference disappears into a wait you are paying
anyway. There is no documented flag for device placement, so Phase 0 verifies it
rather than assuming.

| Card | VRAM | Best config it runs | Verdict |
|---|---|---|---|
| RTX 3070 | 8 GB | SimulStreaming `medium`, or `faster-whisper` `large-v3` on LocalAgreement. NLLB on CPU | **Start here today.** Enough to run Phases 0–4 in full |
| RTX 4070 Ti | 12 GB | SimulStreaming `large-v3` — the low-latency path — with NLLB on CPU | **Build against this.** Clears the 10 GB guidance |
| RTX 4080 | 16 GB | All of the above, plus NLLB resident on GPU and room for diarization | **Don't buy it for this.** The headroom only pays off for Phase 6 |

**Recommendation: start on the 3070 tonight, build on the 4070 Ti, don't buy the
4080.** The 3070 will not run the flagship configuration, but it runs everything
needed to learn *whether the flagship configuration is worth it* — which is
exactly what Phase 0 is for. If `medium` on the 3070 already reads well for
French and English, the VRAM question gets much less interesting, and it
plausibly will: FR and EN are Whisper's two strongest languages and the gap
between `medium` and `large-v3` is narrowest exactly there.

The 4080's extra 4 GB only buys diarization, an LLM translation sidecar, or
Voxtral — three Phase 6 things you may never reach. Buy it later, on better
information.

Whichever card ships, the app should read available VRAM at launch and
pre-select the model size, rather than letting a user hit an out-of-memory error
two minutes into a session.

---

## 6. Windows landmines

| Issue | Symptom | Mitigation |
|---|---|---|
| **cuDNN 9 DLLs** | `Could not locate cudnn_ops64_9.dll` — filed against WhisperLiveKit (#286), faster-whisper (#1080) and CTranslate2 alike | Pin `torch >= 2.4`, pip-install `nvidia-cudnn-cu12`, and have the launcher prepend its `bin` to `PATH` before import. Do this in spawn code, not in a README. `spike/_common.ps1` already does it |
| **FFmpeg** | Server decodes WebM through FFmpeg; torchaudio's Windows DLL discovery is historically brittle | **Sidestep entirely.** Run `--pcm-input` and send raw 16 kHz mono Int16 PCM from an AudioWorklet. No FFmpeg binary to ship, lower latency as a bonus |
| **NeMo / vLLM extras** | Sortformer diarization, Canary and Qwen3-vLLM assume Linux | Exclude from v1. If diarization is wanted later, `diart` is the Windows-friendlier path — but it pins Python 3.11–3.12 |
| **Install size** | CUDA PyTorch wheels run 3–4 GB installed, before weights | Small Electron installer; download runtime, wheels and models on first run with visible resumable progress |
| **System-audio capture** | Electron's `desktopCapturer` loopback audio on Windows has a long history of `NotSupportedError` and renderer crashes | Ship microphone capture as the reliable path; offer loopback as best-effort with a documented VB-Cable / VoiceMeeter fallback. Do not let it block v1 |

**Pin Python 3.12.** It sits inside every relevant dependency's supported range,
including `diart`'s, and avoids the bleeding-edge wheel gaps on 3.13+. Note the
dev machine defaults to 3.13, so the venv must be created explicitly — `setup.ps1`
uses `uv python install 3.12`.

---

## 7. Prior art

Nobody has shipped exactly this. But every piece has precedent, and one project
reads as a reference implementation:

- **[TranscriptionSuite](https://github.com/homelab-00/TranscriptionSuite)** — the
  closest analogue: Electron dashboard driving a Python backend, Windows
  installers, CUDA support, a native `whisper-server.exe` for the non-CUDA path,
  hardware auto-detection, and a Live Mode doing sentence-by-sentence realtime.
  Read its dashboard↔server lifecycle code before writing ours. It chose Docker
  with WSL2 for the Windows CUDA path — a decision to consciously adopt or reject.
- **[WhisperLive](https://github.com/collabora/WhisperLive)** (Collabora) — the
  other mature realtime server, TensorRT-capable. The alternative if
  WhisperLiveKit's Windows story disappoints in Phase 0.
- **[EasyWhisperUI](https://github.com/mehtabmahir/easy-whisper-ui)**,
  **WhisperScript** — Electron GUIs over whisper.cpp with CUDA/Vulkan/CPU builds.
  Not streaming, but they solve "ship a GPU binary to a Windows consumer", which
  is the part that will actually consume our time.
- **[electron-speech-to-speech](https://github.com/Kutalia/electron-speech-to-speech)**
  — whisper.cpp as a Node native addon, in-process live captions.

### The architectural fork worth knowing about

Python sidecar (WhisperLiveKit — AlignAtt, NLLB, 3–4 GB of dependencies) versus a
whisper.cpp Node addon (small, self-contained, no Python at all).

Dropping Chinese makes the second fork noticeably more competitive: whisper.cpp
also implements Whisper's native `translate` task, so it could serve FR→FR, EN→EN
*and* FR→EN on its own — three of four pairs, no Python, no first-run download.
Only EN→FR would need something else.

That is **not** a recommendation to switch — you would give up AlignAtt, which is
where the low latency comes from. But if Phase 5 packaging turns painful, a
whisper.cpp build covering three pairs is a real fallback rather than a rewrite.

---

## 8. Architecture

```
┌─ Renderer ──────────────────────────────────────────────────────────┐
│  Source picker · FR/EN selectors · caption view                     │
│  AudioWorklet: 48 kHz Float32 → 16 kHz mono Int16                   │
│  WebSocket client, reconnects on language change                    │
└───────────────────────────┬─────────────────────────────────────────┘
                            │  raw PCM frames (s16le, 16 kHz, mono)
┌───────────────────────────▼─────────────────────────────────────────┐
│  Electron main process                                              │
│  spawns + supervises the sidecar · health checks · first-run download│
└───────────────────────────┬─────────────────────────────────────────┘
                            │  child process, bound to 127.0.0.1
┌───────────────────────────▼─────────────────────────────────────────┐
│  whisperlivekit-server --pcm-input                                  │
│  AlignAtt policy → Whisper large-v3 (CUDA; also FR→EN natively)      │
│  NLLB-200 → EN→FR only, and it can sit on the CPU                   │
└───────────────────────────┬─────────────────────────────────────────┘
                            │  JSON: committed lines + provisional buffer
                            ▲
```

### The detail that makes the UI cheap

Language selection is a **WebSocket query parameter**, not a server flag.
Changing either dropdown means closing and reopening one socket — no process
restart, no model reload:

```bash
# sidecar — launched once, at app start (4070 Ti profile)
whisperlivekit-server --model large-v3 --backend simulstreaming \
  --pcm-input --host 127.0.0.1 --port 8765 \
  --frame-threshold 20 --warmup-file assets/warmup.wav \
  --translation-backend nllb --nllb-backend ctranslate2 --nllb-size 600M
```

```js
// renderer — on every language change, EN spoken to FR displayed
ws = new WebSocket(
  "ws://127.0.0.1:8765/asr?language=en&target_language=fra_Latn"
)
```

With Chinese out of scope there is only one ASR backend, so ordinary use never
restarts the sidecar. Two things still might: switching model size, and — this is
the open question — moving between the native FR→EN path and the NLLB path.

> **Phase 0 must verify this.** `--direct-english-translation` is a *server flag*,
> while `language` and `target_language` are *per-session query parameters*. It is
> not documented whether one server can serve both paths, or whether flipping
> direction means relaunching the sidecar. If it needs a relaunch, every direction
> change costs a model reload — call it 5–15 s — and the UI has to show that
> honestly instead of appearing frozen. The `mixed-paths` sweep profile settles it.

See [websocket-api.md](websocket-api.md) for the verified wire protocol.

---

## 9. Phases

The sequencing principle: **prove the GPU and the latency before writing a single
line of Electron.** If Phase 0 comes back at four seconds instead of one, every
downstream decision changes — and you will have spent half a day, not two weeks.

### P0 — Bare-metal spike, on the 3070 · half a day · blocking

No app, no packaging, no new hardware. Tooling lives in [`spike/`](../spike/).

- [ ] Confirm CUDA is genuinely used — `nvidia-smi` shows the process, not merely the driver
- [ ] Hit and fix the cuDNN DLL error, and write down the exact fix
- [ ] Measure real latency for `medium` and `large-v3`, at `--frame-threshold` 25 and 15
- [ ] **Read the actual VRAM figure** for SimulStreaming `large-v3`. If it comes in
      well under ÚFAL's 10 GB, the 3070 may carry the whole project
- [ ] Judge `medium` against `large-v3` by ear, on French and English. The single
      decision with the most downstream leverage
- [ ] Time FR→EN native against FR→EN via NLLB — what the free lunch is worth
- [ ] Check whether one server serves both paths, or whether flipping needs a relaunch
- [ ] Confirm where NLLB loads — GPU or CPU — and whether it can be forced to CPU
- [ ] Try `?language=auto` on mixed speech and see whether it flips mid-stream

**Exit criteria:** measured latencies replacing the estimates in §3, a real VRAM
number, and decisions on model size, frame-threshold, and whether a second GPU is
needed at all.

### P1 — Sidecar contract · 1–2 days

Wrap the server so Electron can own it safely, before any UI exists.

- [ ] Launcher that fixes `PATH` for cuDNN, picks a free port, reports it to main
- [ ] Health polling, startup timeout, crash detection, restart with backoff
- [ ] Guaranteed kill on quit — including force-quit. Orphaned CUDA processes
      holding 8 GB of VRAM are the classic failure mode
- [ ] Bind to `127.0.0.1` only; consider the `?token=` auth parameter

### P2 — Audio path · 2–3 days

The part most likely to eat unplanned time.

- [ ] Device enumeration for the source picker; hot-plug and permission denial
- [ ] AudioWorklet resampler: 48 kHz Float32 → 16 kHz mono Int16, binary WS frames
- [ ] System-audio loopback via `desktopCapturer` as a clearly-marked experimental
      option, with the virtual-cable fallback documented in-app
- [ ] A level meter — users need to see audio arriving, or they blame the transcription

### P3 — Interface · 2–3 days

Three controls and a caption surface. The restraint is the point.

- [ ] Source · spoken language · display language. Disable impossible combinations
      rather than failing at runtime
- [ ] Render committed text solid and the in-flight buffer grey — readers handle
      revisions correctly when they can see what is provisional
- [ ] Language change reconnects the socket; model change shows a visible reload state
- [ ] Copy and export the transcript; optionally a large presentation caption mode

### P4 — Language matrix · half a day

Cheap now that it is four pairs from one model.

- [ ] Canonical map: UI label → Whisper code → NLLB code (`fra_Latn`, `eng_Latn`)
- [ ] Route FR→EN down the native path, EN→FR through NLLB, with the reload state
      wired up if P0 showed one is needed
- [ ] Test all four pairs end to end, including the two identity pairs
- [ ] Add `auto` as a source option if P0 showed LID is stable

### P5 — Packaging and first run · 3–5 days · the real risk

Budget generously. This phase, not the ML, is where projects like this stall.

- [ ] Small Electron installer; on first launch download an embedded Python (uv's
      standalone builds), wheels and weights, with real resumable progress
- [ ] Detect GPU and VRAM at first run, pre-select model size, and give a clear
      non-technical message when there is no CUDA device
- [ ] Pin every version. A silent CTranslate2 or torch bump breaks cuDNN loading
      on a machine you cannot inspect
- [ ] Test on a clean Windows 11 VM with no CUDA toolkit and no Python. **This is
      the only test that counts**

### P6 — Optional, afterwards

- [ ] Speaker diarization via `diart`, if Windows cooperates
- [ ] Streaming translation via `--translation-backend alignatt`, if the sentence
      gate proves unacceptable and there is VRAM to spare
- [ ] OBS or NDI caption output, or a transparent always-on-top overlay window

---

## 10. Open questions

1. **Source transcript, translation, or both on screen?** The biggest one.
   Translation-only keeps three of four pairs fast; showing both forces every
   pair through NLLB and its sentence gate.
2. **Commercial or not?** Picks the default backend, because of the SimulStreaming
   licence.
3. **Whose machine does this run on?** Yours only, and you can skip the entire
   first-run installer problem and ship a folder. Other people's, and P5 becomes
   the largest phase in the project.
4. **Is system audio required, or is a microphone enough?** Loopback on Windows
   is the flakiest item in this plan.

---

## Sources

- [QuentinFuxa/WhisperLiveKit](https://github.com/QuentinFuxa/WhisperLiveKit) — backends, CLI flags, translation, WebSocket parameters
- [ufal/SimulStreaming](https://github.com/ufal/SimulStreaming) — AlignAtt policy, 10 GB VRAM recommendation, dual licence
- [AlignAtt paper](https://arxiv.org/pdf/2305.11408) — attention-based alignments for simultaneous ST
- [WhisperLiveKit #286](https://github.com/QuentinFuxa/WhisperLiveKit/issues/286) — `cudnn_ops64_9.dll` on Windows
- [faster-whisper #1080](https://github.com/SYSTRAN/faster-whisper/issues/1080) — the same cuDNN problem upstream
- [WhisperLiveKit configuration reference](https://deepwiki.com/QuentinFuxa/WhisperLiveKit/7.3-configuration-options)
- [Electron desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer) — with issues #42765 and #46369 on Windows loopback
