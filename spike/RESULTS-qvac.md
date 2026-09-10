# QVAC — measured, 10 Sep 2026

First real numbers for the candidate engine. **Half a comparison**: the
incumbent has not been measured yet, because it needs its 4 GB Python
environment and a machine that is not this one. Everything below is QVAC alone.

Read the caveats before quoting any of it.

## What was measured on

| | |
|---|---|
| SDK | `@qvac/sdk` 0.19.0, `@qvac/inference` 0.19.0 |
| Model | `WHISPER_BASE_Q8_0` (whisper.cpp, 82 MB) + Silero VAD 5.1.2 |
| Box | NVIDIA RTX PRO 6000 Blackwell, 96 GB, driver 596.36 |
| Audio | `spike/make-sample.ps1` — SAPI speech, 16 kHz mono, known transcript |

**Two caveats that matter more than any number here.**

1. **The GPU was not idle.** This box runs a live inference farm: 92.5 of
   97.9 GB of VRAM was in use by other people's work throughout, and
   `nvidia-smi` sampling therefore reports the farm's VRAM, not QVAC's. The
   comparison has to be re-run on the quiet RTX 3070.
2. **`base` is a small model and SAPI speech is not real speech.** Accuracy
   numbers here would be meaningless; latency and throughput are the point.

---

## The headline: throughput is excellent, streaming latency is not

Batch transcription of the whole file, which is what the raw engine can do:

| | wall time | audio | **RTF** |
|---|---|---|---|
| French, `use_gpu: true` | 1.8 s | 62.9 s | **0.028** — 36× real time |
| French, `use_gpu: false` | 3.1 s | 62.9 s | 0.049 — 20× real time |
| English, `use_gpu: true` | 0.9 s | 59.6 s | **0.016** — 60× real time |

Streaming the same audio through the engine contract, paced to the wall clock:

| Run | first commit | commit latency (median) | p90 | commits |
|---|---|---|---|---|
| fr → fr | 5.26 s | **13.70 s** | 19.75 s | 9 |
| fr → en (native translate) | 5.27 s | **8.93 s** | 16.02 s | 9 |
| en → en | 4.64 s | **4.96 s** | 8.37 s | 11 |

**These two tables are the whole finding.** An engine that chews 60 s of audio
in under a second is not short of compute — so the 5–14 s streaming latency is
not a speed problem. It is a *policy* problem: QVAC's duplex session emits text
only when its VAD closes a speech segment, and continuous speech makes long
segments. On the French run, per-commit latency climbs monotonically —
0.97 → 24.4 s — as the backlog of unclosed audio grows.

This is precisely the risk that was flagged before any of this was built:
WhisperLiveKit's AlignAtt is a *simultaneous decoding policy* that emits inside
a sentence; whisper.cpp streaming is chunk-and-VAD. The measurement confirms it
rather than discovering it.

### And there is no provisional text at all

`time to first partial` is **—** in every run. QVAC has no notion of a
provisional hypothesis: a line does not exist, and then it is final. The app's
`transcript.js` renders committed text solid and provisional text dimmed; on
this engine the dimmed pane is always empty.

For a live-caption app that is a bigger deal than the median latency. It is the
difference between a reader watching words appear as someone speaks, and a
reader watching nothing for nine seconds and then a paragraph.

---

## Translation: one direction is free, the other does not exist

**FR → EN costs nothing.** 8.93 s median against 13.70 s for plain
transcription — i.e. translating was not slower than not translating. Whisper's
own `translate: true` task carries the English inside the ASR output: no second
model, no extra VRAM, no sentence gate. Verified to produce real English, not a
silent pass-through.

This is the fast path the incumbent's open question #1 was about, and QVAC has
it for free and without the coexistence problem — there is no NLLB to also keep
loaded, so nothing has to coexist.

**EN → FR has no path.** QVAC's registry ships Marian Indic (EN↔Hindi and Indic
languages) and one African translation LLM. There is no NLLB, no Opus-MT, no
multilingual NMT. For a French↔English app, half the product is missing unless
we supply a custom NMT GGUF or spend VRAM on an LLM. `plan()` says so out loud
rather than quietly transcribing.

---

## Four things that cost real debugging time

Recorded because each one produced a *silent* wrong result, and each is a
maintenance hazard on an SDK bump.

1. **`audio_format` defaults to something that is not `s16le`.** The contract
   sends 16-bit PCM. Leave `modelConfig.audio_format` unset and the addon reads
   those bytes as 32-bit floats. No error, no warning — an empty transcript,
   because what the model hears is noise.
2. **`emitVadEvents: true` silently kills the stream.** With it, the async
   iterator yields nothing at all: no events, no error, the loop simply never
   produces. The whole transcript disappears. Not passed.
3. **VAD is mandatory, not "recommended".** Without `vadModelSrc`, whisper
   duplex streaming refuses: *"VAD model name is required for Whisper
   transcription."* The docs call it optional.
4. **Timestamps reset at every VAD segment.** `startMs`, `endMs` and `id` all
   restart at 0 when a segment closes, so taken at face value every line claims
   to start at 0:00:00. The engine reconstructs a session timeline by
   accumulating segment durations; it is approximate, and QVAC's own values are
   occasionally non-monotonic within a segment. Per-line latency here is
   therefore ±1 segment. The aggregate trend is unaffected.

And one that is not silent but is worse:

5. **QVAC's model downloader crashes the Bare worker on this network.** Every
   `loadModel()` that has to fetch weights dies with `WorkerCrashedError`
   (`code=143`) part-way through "Downloading blob directly", leaving a 0-byte
   file in `~/.qvac/models/`. Plain HTTPS to huggingface.co works fine from the
   same shell, and pre-seeding the cache by hand makes the load succeed in
   8.6 s. The registry client uses hyperswarm P2P; something in that path does
   not survive this office LAN. **This is an install-path blocker**, and it
   lands directly on the one thing QVAC was supposed to win: setup.

---

## Install cost, measured rather than assumed

| | |
|---|---|
| `npm install @qvac/sdk` | **4.8 GB**, 205 packages, ~5 min |
| …of which this platform needs | **~805 MB** (prebuilds ship for 11 platforms) |
| Python / CUDA toolkit / cuDNN | none |
| Model weights | 82 MB (`base`) — but see the downloader crash above |

Against the incumbent's ~4 GB and ~20 minutes, with a resolver check that
exists because getting a CUDA wheel on Windows is genuinely hard. The packaged
app would ship the 805 MB slice, not the 4.8 GB working tree.

So the setup win is real but smaller than "no 4 GB download" — call it 800 MB
of binaries against 4 GB of Python, plus the deletion of `envSetup.js` and
`pythonEnv.js` entirely (about 660 lines whose only job is making a CUDA stack
install reliably).

---

## Vulkan, not CUDA — confirmed on hardware

The published docs say "NVIDIA CUDA via `use_gpu: true`". On win32-x64 the
shipped addons build **Vulkan only**: the calibration resources are
`win32-x64`, `win32-x64-vulkan` and `win32-x64-vulkan-shared`, with no CUDA
variant, and `@qvac/inference`'s own source comment reads *"the NVIDIA
calibration host advertises both CUDA and Vulkan, and every load on it reports
`ggml_vulkan`, never `ggml_cuda`."*

Confirmed here: `getSystemResources()` on this box reports `cuda: true` **and**
`vulkan: true`, and QVAC's `GPU_BACKENDS` order picks `vulkan`. The driver
having CUDA is irrelevant when the addon has no CUDA build.

It is worth being clear that this did **not** turn out to be a problem for
throughput — Vulkan delivered 36–60× real time, and beat CPU by 1.7×. The
Vulkan-vs-CUDA question mattered less than the streaming-policy question.

---

## What to do next

The comparison is not decidable yet. In order:

1. **Measure the incumbent.** `node spike/profile.mjs --engine whisperlivekit`
   on `engine/whisperlivekit`, same samples, same harness. Without it there is
   nothing to compare to — in particular, WhisperLiveKit's AlignAtt latency and
   whether *it* keeps up in real time.
2. **Re-run both on the RTX 3070**, quiet, so the VRAM figures mean something.
3. **Try Parakeet CTC/Unified.** They are streaming-native, unlike whisper.cpp's
   VAD chunking, and may fix the one thing that is actually wrong here. This is
   the highest-value experiment on the QVAC side by a distance.
4. **Try a shorter VAD silence threshold** (`qvacVadSilenceMs`) to force earlier
   segment closes, and see what it costs in accuracy.
5. Only then decide. If Parakeet streams incrementally, QVAC becomes strong:
   free FR→EN, no Python, good throughput. If it does not, the incumbent keeps
   the one thing this app is for — text that appears while someone is still
   talking.
