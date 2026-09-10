# Phase 0 — the spike

**Goal:** replace every modelled number in [`../docs/plan.md`](../docs/plan.md)
with a measured one, and answer the handful of questions that change what gets
built. Half a day. No application code.

**Run this on the RTX 3070 machine.** A 4 GB laptop GPU cannot hold `large-v3`
on the SimulStreaming path, and half the sweep will fail to load.

---

## Comparing two engines — `profile.mjs`

The original harness here (`measure_latency.py` + `sweep.ps1`) measures
WhisperLiveKit, and needs the sidecar's own Python venv to run — so it can never
measure the candidate engine. `profile.mjs` replaces it for that job: it speaks
the client half of [the engine contract](../docs/engine-contract.md), so **one
code path, one clock and one set of definitions** measure both candidates.

It needs only Node ≥ 22 (for a global `WebSocket`) and a WAV.

```powershell
# an engine this branch ships, started for you
node spike\profile.mjs --engine whisperlivekit --wav spike\samples\fr_60s.wav
node spike\profile.mjs --engine qvac          --wav spike\samples\fr_60s.wav

# transcription only, no translation
node spike\profile.mjs --engine qvac --wav samples\fr_60s.wav --source fr --target fr

# something already running, and keep every commit event for diffing
node spike\profile.mjs --endpoint ws://127.0.0.1:8799/asr --wav samples\fr_60s.wav --json runs\qvac-fr.json
```

`--set k=v` overrides an engine setting (`--set model=medium`), `--fast` sends
the file as quickly as possible to measure throughput rather than latency, and
`--no-gpu` skips `nvidia-smi` sampling.

### What it reports, and what the words mean

| Figure | Definition |
|---|---|
| time to first partial | wall seconds until *any* text appears, committed or not |
| time to first commit | wall seconds until text stops moving |
| commit latency | for each line, wall time of its commit minus the **audio timestamp it covers** — not arrival order |
| translation latency | the same, for the `translation` field |
| translation behind text | per line, when the translation landed minus when the text did — the sentence-gate cost |
| flush | seconds between end-of-audio and `ready_to_stop` |

Audio is fed **paced to the wall clock** by default, because a streaming
engine's latency is only meaningful against real-time input; firehosing the file
measures throughput, which is a different question and is what `--fast` is for.

Commits arriving after end-of-audio are real latency but distorted by flush
semantics, so they are counted and reported **apart from** the live statistics
and excluded from every median. That exclusion is not cosmetic: during a flush
each line's text and translation arrive in the same message, so a long tail of
flushed pairs would report a translation lag of zero for an engine that is
seconds behind.

### Trusting it

Validate the harness against known answers before trusting it on a real engine.
The `mock` engine commits at lags you choose:

```powershell
node spike\profile.mjs --engine mock --wav samples\fr_60s.wav --no-gpu
#   commit latency (median)      ~1.2s   <- the injected transcript lag
#   translation latency (median) ~2.5s   <- the injected translation lag
#   translation behind text      ~1.3s   <- the difference
```

Measured granularity is the mock's 200 ms tick, so expect roughly +0.1 s. If
those three numbers do not come back, fix the harness before measuring anything
else.

---

## Run it

```powershell
cd spike

# 1. Environment: uv venv on Python 3.12, CUDA stack, the Windows cuDNN fix.
#    Pulls 3-4 GB. Verifies torch actually sees the GPU before it finishes.
.\setup.ps1

# 2. Two ~60 s speech samples. Read a paragraph aloud rather than improvising -
#    the NLLB path is sentence-gated, so natural sentence boundaries matter.
.\.venv\Scripts\python.exe record_sample.py --list
.\.venv\Scripts\python.exe record_sample.py --out samples\fr_60s.wav --seconds 60
.\.venv\Scripts\python.exe record_sample.py --out samples\en_60s.wav --seconds 60

# 3. The sweep. Each profile loads its model (downloaded on first use), records
#    VRAM, streams every sample, then shuts the server down.
.\sweep.ps1

# 4. Render the table.
.\.venv\Scripts\python.exe report.py
```

Then open `RESULTS.md` and fill in the checkboxes at the bottom. Those are the
Phase 0 exit criteria.

### Driving one profile by hand

Useful for the judgement calls that a script cannot make — mainly *does this
sound good enough*.

```powershell
.\serve.ps1 -List
.\serve.ps1 -Profile large-simul
# then talk into http://127.0.0.1:8765 in a browser
```

### Running part of the sweep

```powershell
.\sweep.ps1 -Only medium-simul,large-simul
```

---

## How latency is measured

The harness streams a WAV over the WebSocket at **exactly 1×** and, for every
newly committed segment, records:

```
latency = wall_clock_since_stream_start − audio_end_time_of_that_segment
```

The segment covers audio up to `end` seconds into the file; we did not see it
until `wall_clock` seconds after the stream began. Because the file is streamed
in real time, those two clocks are directly comparable. That difference is the
honest mouth-to-screen number — the same thing you would get by clapping and
watching the screen, but with a hundred samples instead of one and no reaction
time in the measurement.

Transcript and translation are tracked **separately**. That is the point: it is
how you confirm or refute the claim that NLLB is sentence-gated while native
English translation is not. If the claim holds, the translation median sits well
above the transcript median *in the same run*, and `report.py` prints that gap in
its own table.

Commits arriving after end-of-audio are excluded from the headline statistics —
they are real latency but distorted by flush semantics rather than representative
of live use. They are counted and reported separately.

---

## What each profile is asking

| Profile | Question |
|---|---|
| `medium-simul` | Baseline the 3070 can definitely run. If this sounds good enough, the VRAM question mostly goes away |
| `medium-simul-ft15` | What does `--frame-threshold` actually buy? |
| `large-simul` | The flagship config. **Watch the VRAM figure** — this is the number that decides whether the 4070 Ti is needed |
| `large-simul-ft15` | Flagship model at the tighter threshold; the config most likely to ship |
| `large-fasterwhisper` | The licence-clean fallback. What does giving up AlignAtt cost in latency? |
| `native-en` | FR→EN through Whisper's own translate task. Expect transcript-like latency and **no** `translation` field |
| `nllb` | EN→FR through NLLB. The sentence gate should appear as a much higher translation median |
| `mixed-paths` | **The open question.** Can one server serve the native FR→EN path *and* the NLLB EN→FR path? If both runs produce sane output, the UI never has to reload a model |
| `auto-lid` | Does `?language=auto` hold, or flip mid-stream on short utterances? |

---

## Things that will go wrong, and what they mean

**`Could not locate cudnn_ops64_9.dll`** — the classic. `setup.ps1` installs the
cuDNN wheel and `_common.ps1` prepends its `bin` to `PATH` before launching, so
this should not happen here. If it does, check that
`.venv\Lib\site-packages\nvidia\cudnn\bin` exists. **Whatever fixes it, write it
down** — Phase 1 has to reproduce that fix in Electron's spawn code.

**Server is NOT in PCM mode** — the harness warns and the transcript comes back
as noise. Means `--pcm-input` did not reach the server; check the args echoed by
`sweep.ps1`.

**CUDA out of memory on `large-simul`** — expected on 8 GB. Not a failure; it is
the measurement. Record it and move on with `medium`.

**The sweep skips a profile** — a sample WAV is missing. It tells you which.

**torch cannot see the GPU** — `setup.ps1` fails loudly at the verification step
rather than letting you discover it forty minutes into a sweep. If the `cu129`
wheels do not resolve for your driver, try `.\setup.ps1 -CudaTag cu128`.

---

## Files

| File | |
|---|---|
| `setup.ps1` | Environment, CUDA stack, cuDNN fix, verification |
| `profiles.json` | What the sweep measures, and the question each profile answers |
| `sweep.ps1` | Runs every profile unattended, records VRAM, collects results |
| `serve.ps1` | Drive one profile by hand |
| `_common.ps1` | Shared helpers — including the cuDNN PATH fix Phase 1 must copy |
| `measure_latency.py` | Streams a WAV at 1× and measures mouth-to-screen latency |
| `record_sample.py` | Records a 16 kHz mono sample |
| `report.py` | `results.jsonl` → `RESULTS.md` |
| `RESULTS.md` | Generated. The exit criteria live at the bottom |
