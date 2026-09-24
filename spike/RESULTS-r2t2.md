# Confucius4-R2T2 — measured, 24 Sep 2026

NetEase Youdao's streaming ASR model, suggested as a candidate because it is
built for exactly what measurably failed on QVAC: text that appears while the
speaker is still talking. Measured against QVAC on the same samples, the same
day, with the same harness.

## What was measured on

| | |
|---|---|
| Model | `netease-youdao/Confucius4-R2T2`, 1.7B (Qwen3-ASR base), bf16, 4.08 GB |
| Runtime | vLLM 0.14.0, torch 2.9.1+cu128, in WSL2 (Ubuntu 26.04) |
| Server | `src/main/engines/r2t2/server.py` — ours, not upstream's; see its header |
| Budget | 6 GiB total, KV cache 1.5 GiB exact |
| Box | NVIDIA RTX PRO 6000 Blackwell, 96 GB, driver 596.36 |
| Audio | `spike/make-sample.ps1` — SAPI speech, 16 kHz mono, with per-word timings |
| Metric | every word, from the end of its utterance to the moment it became committed text |

**Caveats, first.** The GPU was shared with the live LlmOnLan farm (up to 89%
utilisation from other people's work during the session), so absolute numbers
are provisional and VRAM readings are meaningless — re-run on the quiet 3070.
And synthetic speech is clean: no room, no accent, no overlap, no hesitation.
The ratios between engines are the finding; real voices are the open question.

## The numbers

| | **R2T2** | QVAC `base` | QVAC `large-v3-turbo` |
|---|---|---|---|
| FR 54 s — word latency median / p90 / max | **0.49 / 0.73 / 0.91 s** | 3.05 / 5.07 / 5.90 s | 3.48 / 5.43 / 6.70 s |
| EN 60 s — word latency median / p90 / max | **0.46 / 0.71 / 0.96 s** | 2.68 / 4.99 / 5.96 s | 2.72 / 5.01 / 6.28 s |
| FR 3.5 min — word latency median | **0.48 s** | 2.97 s | 3.00 s |
| drift, first third → last third (FR 3.5 min) | 0.48 → 0.48 s | 3.07 → 2.86 s | 3.07 → 2.93 s |
| WER, FR 54 s / FR 3.5 min / EN 60 s | 1.3% / 1.2% / 2.5% | 8.7% / 6.4% / 2.5% | 1.3% / 1.2% / **0.0%** |
| time to first provisional text (3 samples) | **0.5–0.8 s** | never | never |
| time to first committed text (3 samples) | **0.8–1.1 s** | 4.6–5.3 s | 4.6–7.3 s |

Reading it:

- **Latency is where R2T2 wins, and by a lot** — about six times, at median and
  at p90. Its worst word in 3.5 minutes (0.90 s) is faster than QVAC's median.
- **Accuracy is a draw once QVAC gets its largest model.** Turbo matches R2T2's
  French exactly and beats its English (0.0% against 2.5%: two substitutions and
  two deletions over 162 words). `base` is not competitive on French.
- **A bigger QVAC model does not buy latency.** `base` and `turbo` land words at
  the same ~3 s, which pins QVAC's delay on its VAD-segment streaming policy
  rather than on compute.
- **Nobody drifts.** All three hold flat over three and a half minutes.

## How the engine behaves

- **Word by word.** 180 commits in 54 s on the first raw test — text trickles
  rather than lands in lumps.
- **Provisional text for free.** The model returns its unfixed tail alongside
  the fixed text; the server sends it as `buffer_transcription`, so the next
  word shows dimmed ~0.3 s before it turns solid. Upstream's own server drops it.
- **Compute is not the constraint.** Per 160 ms chunk: 34 ms median, 50 ms p90
  (first raw run). Roughly 4.7× headroom over real time.
- **Language changes are cheap.** Language is set per connection, so switching
  is a reconnect with the model warm — as on WhisperLiveKit, unlike QVAC.
- **Startup is not.** ~2 min cold while vLLM compiles, ~50 s once its compile
  cache is warm, plus ~2 s of warm-up so the first real chunk is not the one
  that pays for compilation (it cost 29 s when not warmed).

## What it took, and what is not solved

1. **It runs on Linux.** Streaming is vLLM-only in the Python path (the
   transformers backend raises on it), and the llama.cpp route ships Linux
   prebuilts. On Windows it runs in WSL2. A shippable Windows build needs either
   that llama.cpp extension rebuilt for Windows or a bundled WSL distro. Neither
   is done; this is the biggest engineering gap.
2. **It does not translate.** Its companion SiMT model, Confucius4-T3PO, is 14B
   and documented for Chinese↔English only. EN→FR and FR→EN are both open on
   this engine; translating pairs show the source and say why.
3. **French is not what it was tuned for.** Upstream optimises for Chinese and
   English and publishes no French numbers. 1.2–1.3% WER on SAPI French is
   encouraging and proves nothing about real voices.
4. **vLLM and a shared GPU do not mix by default.** vLLM profiles free memory at
   startup and asserts nobody else changed theirs; an Ollama unload on the farm
   mid-startup (51 → 89 GiB free) aborted the init. `kv_cache_memory_bytes`
   skips that profiler and gives an absolute budget instead of a fraction.
5. **Killing `wsl.exe` does not kill the server.** Verified: a server fed stdin
   by another WSL process survived `taskkill /F` on its `wsl.exe`, still holding
   its VRAM, and its vLLM engine core then ignored SIGTERM. The engine exists
   around that: Python's stdin *is* `wsl.exe`'s relay, and the server kills its
   own process group on stdin EOF. Verified clean after both `stop()` and a bare
   `taskkill /F`.

## Licence

Upstream code is Apache-2.0, and `server.py` adapts parts of it with
attribution — allowed inside this (unlicensed) app, but shipping it means
carrying Apache-2.0's licence text and notices. Weights: NetEase Youdao Model Use License
Agreement — royalty-free, commercial use allowed below 100M MAU and RMB 1B
annual revenue, notice and a copy of the agreement retained in every copy,
may not be used to improve other (commercial) models, PRC law with CIETAC
arbitration, Chinese text prevails. More permissive than the incumbent's
SimulStreaming backend, which is noncommercial.

## Next

1. **Real French voices** (docs/TESTING.md, Part 3). Everything else is
   engineering; this is the one result that could still sink it.
2. The quiet 3070, for numbers without a farm underneath.
3. If French holds: the Windows build (rebuild the llama.cpp extension, and
   measure its `stream_llama` route against vLLM), and translation — most
   likely NLLB-200 on the same server, as the incumbent does.
