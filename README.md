# Rtranslate

A local, GPU-accelerated live transcription and translation desktop app for
Windows. French ↔ English. Nothing leaves the machine.

An Electron shell around a transcription engine: pick an audio source, a spoken
language and a display language, and read captions as people talk.

---

> **You are on `engine/qvac`** — Tether QVAC, one of the candidates. `main` is
> the shell without an engine; see the table below for the other branches.

## Which engine

The shell is finished and the engine is not decided. Three candidates are being
measured against each other, and they live on branches:

| Branch | Engine | Stack | Setup cost |
|---|---|---|---|
| `engine/whisperlivekit` | [WhisperLiveKit](https://github.com/QuentinFuxa/WhisperLiveKit) | Python 3.12, CUDA PyTorch, SimulStreaming/AlignAtt + NLLB-200 | ~4 GB, ~20 min |
| `engine/qvac` | [Tether QVAC](https://qvac.tether.io/) | Bare runtime, whisper.cpp/Parakeet + nmtcpp, **Vulkan** | ~800 MB, no Python |
| `engine/r2t2` | [Confucius4-R2T2](https://huggingface.co/netease-youdao/Confucius4-R2T2) | 1.7B streaming ASR on vLLM — **Linux, so WSL2 on Windows** | ~4 GB weights + vLLM |

`main` carries everything that is not an engine — audio capture, captions, the
phone display, settings, packaging, auto-update — plus the contract between
them, the registry that finds engines, a `mock` engine, and the harness that
measures them. It does not know how any real engine works.

The seam is a localhost WebSocket, described in
[docs/engine-contract.md](docs/engine-contract.md). Every engine is
out-of-process anyway — a Python server, a Bare worker, a vLLM server in WSL,
and none loads into Electron — so a socket is what the boundary honestly is. The
renderer is byte-identical across branches, which is what makes a measured
difference a difference in the engine rather than in the shell around it.

**Two of three are measured** (24 Sep 2026, same SAPI samples, every word timed
from when it was spoken — see [docs/TESTING.md](docs/TESTING.md#where-the-numbers-already-stand)).
WhisperLiveKit is not, because it needs its 4 GB Python environment first.

| | R2T2 | QVAC `base` | QVAC `large-v3-turbo` |
|---|---|---|---|
| word latency, FR / EN median | **0.49 / 0.46 s** | 3.05 / 2.68 s | 3.48 / 2.72 s |
| word latency, FR p90 | **0.73 s** | 5.07 s | 5.43 s |
| WER, FR / EN | 1.3% / 2.5% | 8.7% / 2.5% | 1.3% / **0.0%** |
| provisional text | **yes** | no | no |
| drift over 3.5 min | none | none | none |

What that says, and what it does not:

- **Given its largest model, QVAC is as accurate as R2T2** on this audio. The
  difference is latency — about sixfold — and a bigger QVAC model does not close
  it. QVAC's throughput is superb (60 s transcribed in 0.9–1.8 s); it is its
  streaming *policy* that waits: text is emitted only when a VAD closes a speech
  segment. R2T2 commits word by word, ~0.5 s behind the speaker, with the next
  word already showing dimmed.
- **QVAC's latency does not climb through a run.** An earlier write-up said it
  climbed from ~1 s to 24 s; that came from timing lines against QVAC's own
  segment timestamps, which had to be reconstructed, and the reconstruction was
  wrong. Timed against ground truth it is a flat ~3 s. Corrected everywhere it
  had spread.
- **R2T2 runs on Linux.** Streaming needs vLLM; its llama.cpp route ships
  Linux-only binaries. On Windows it works through WSL2 — for testing, not yet
  for shipping.
- **Neither translates EN→FR.** QVAC has FR→EN for free (Whisper's own translate
  task) and nothing for EN→FR; R2T2 transcribes only.
- **Synthetic speech is clean speech.** French on real voices is R2T2's biggest
  open question: upstream tuned it for Chinese and English and publishes no
  French numbers.
- On Windows QVAC runs **Vulkan, not CUDA** — its own source says so. It was
  never the bottleneck. And QVAC's model downloader crashes on this network;
  seeding its cache by hand works.

---

## First run

Install `Rtranslate-<version>-x64.exe`, launch it, and press **Set up**. The app
builds its own Python environment — private Python 3.12, CUDA PyTorch,
WhisperLiveKit, NLLB and the cuDNN libraries — into its own folder. About 4 GB,
once. Your system Python, if you have one, is never touched.

The first **Start** after that is also slower than later ones: WhisperLiveKit
fetches the model weights then.

### From source

```powershell
npm install
npm start              # then press Set up, exactly as above
```

`npm run bootstrap` does the same thing from PowerShell if you would rather watch
it in a terminal. And if you have already run the Phase 0 spike on that machine,
neither is needed — the app falls back to `spike\.venv` rather than downloading a
second copy of PyTorch.

### Why the CUDA install is not a one-liner

On Windows the plain PyPI `torch` wheel is **CPU-only**; CUDA builds live on
`download.pytorch.org` and carry a `+cuXXX` local version. Point a resolver at
both indexes and it picks by version number — so a CUDA index whose newest torch
trails PyPI's simply loses. Measured on 19 Aug 2026:

| index | resolved torch | verdict |
|---|---|---|
| `cu129` | `2.13.0` | CPU wheel — rejected |
| `cu128` | `2.13.0` + `torchaudio 2.11.0+cu128` | CPU torch, CUDA torchaudio — rejected |
| `cu126` | `2.13.0+cu126` | accepted |

Installing either of the first two costs 2.5 GB and twenty minutes to arrive at
an environment whose only symptom is *"PyTorch cannot see a CUDA device"*. So
setup resolves each candidate first with `uv pip compile` — about three seconds,
no download — checks that **both** torch and torchaudio carry the expected tag,
and only then installs. What it installs is that exact pinned resolution, saved
alongside the environment as `requirements-<tag>.txt` and `freeze.txt`.

### Captions on phones

Press **Phone** in the status bar and turn on sharing. The app serves the live
captions to any phone or tablet on the same network — scan the QR code, or type
the address into a browser. Nothing leaves your network.

On the phone: tap the captions to hide the toolbar, `A−`/`A+` to size the text,
`⛶` for fullscreen, and — when a translation is running — a chip to flip between
the translation and what was actually spoken. The screen is kept awake, and the
page reconnects itself through screen locks and Wi-Fi drops.

Two things worth knowing:

- **Windows will ask about the firewall** the first time, because sharing binds
  to `0.0.0.0`. Allow it on **private** networks or phones cannot connect.
- **Access is gated by a six-character key** in the URL, regenerated every time
  sharing starts. A device on the network that has not scanned the code gets a
  403, not the conversation. Stopping and restarting sharing invalidates open links.

If several addresses are listed, pick the one on the same Wi-Fi as the phone.
Virtual adapters (WSL, Hyper-V, VPNs) are ranked last and will not work.

### Without a GPU

The `mock` engine is a real engine — it registers like the others and serves the
same contract — that emits fixed captions with deliberate, known lags and never
loads a model. So the whole UI runs on any machine, with no GPU, no Python and
no models:

```powershell
npm start                       # then pick "Mock engine" in settings
node spike\profile.mjs --engine mock --wav spike\samples\fr_60s.wav
```

Its known lags are also how the measurement harness is kept honest: inject a
1.2 s transcript lag and a 2.5 s translation lag, and check the harness reports
them back before believing anything it says about a real engine.

The older `spike\mock_server.py` does the same job but needs Python and a
`websockets` install, so it cannot be used to profile the candidate engine.

### Tests

```powershell
npm test        # the engine seam and WebSocket framing, profiler statistics,
                # ports, phone server - plus whatever tests the engine on this
                # branch brings, so the count differs per branch. Here, the
                # engine's planning is pure and tested; everything past plan()
                # needs the SDK, the weights and a GPU.
npm run smoke   # renderer: preload bridge, AudioContext, AudioWorklet, captions
```

Add `--smoke-phone` to also start the LAN server, load the phone page in a real
browser window, push captions into it and read back what a phone would show.

Those cover what a machine can check. **[docs/TESTING.md](docs/TESTING.md) is
the human protocol** — the shell on the mock engine, per-branch engine
acceptance, and the side-by-side session that decides which engine ships. Read
its first rule before running anything live: four minutes of continuous speech
minimum. Context, resets and falling behind all only show over minutes; the
profiler now reports drift, first third against last, so it is measured rather
than eyeballed.

### Building

```powershell
npm run dist      # release\Rtranslate-<version>-x64.exe  (~100 MB)
npm run release   # same, plus a draft GitHub Release for auto-update
```

---

## Status

**Written in one pass, not yet run against a real GPU.** Phases 1–5 are
implemented; Phase 0's measurements are not.

| Phase | What | State |
|---|---|---|
| P0 | Measure latency and VRAM | tooling ready in `spike/`, **not yet run** |
| P1 | Sidecar contract | done |
| P2 | Audio path | done |
| P3 | Interface | done |
| P4 | Language matrix | done |
| P5 | Packaging: installer, first-run setup, auto-update | done |
| — | Phone display | done |
| P6 | Other extras (diarization, OBS out) | not started |

### What has actually been verified

Everything that can be checked without a GPU has been — and the same suite
passes against the **packaged** build, not just from source:

- 32 unit tests on `main`, 71 on `engine/whisperlivekit`: the engine registry and
  WebSocket framing, the profiler's statistics, session planning, the four
  language pairs, profile-key stability, failure diagnosis, port handling, the
  phone server's access control, SSE delivery, backlog replay and transcript
  cap, and the CUDA resolution verifier against real resolver output
- A renderer smoke test proving the preload bridge, ES module wiring, a 16 kHz
  `AudioContext` (native — no resampling needed), `AudioWorklet.addModule` under
  the page CSP, and the worklet instantiating
- An end-to-end run against the in-process `mock` engine: real binary PCM frames
  in, rendered captions out, over a real WebSocket — now part of `npm run smoke`
  rather than needing a Python server started by hand
- An end-to-end run of the phone display: LAN server up, page loaded in a real
  browser window, SSE connected, captions rendered, the source/translation
  toggle working, and a wrong key refused

### What has not

**The whole of [docs/TESTING.md](docs/TESTING.md)** — nobody has yet sat in a
room and read a passage at either engine. In particular: WhisperLiveKit has no
measurements at all (QVAC has some, on a contended box), nothing has been run on
the quiet RTX 3070, and whether Windows loopback audio works here is still
unknown.

Setup steps 1-3 (uv, Python 3.12, venv) have been run for real and verified, and
the resolution logic is tested against real resolver output for all three CUDA
indexes — but the 4 GB download itself has not been run end to end on a machine
with a suitable GPU. Auto-update is wired and the metadata builds correctly, but
no update has round-tripped through a real GitHub Release yet.

---

## The four open questions

These are handled as **settings with safe defaults**, not assumptions, so a
wrong guess costs a checkbox rather than a rewrite.

**1. Can one server serve both translation paths?**
`--direct-english-translation` is a server flag; `language` and `target_language`
are per-session query parameters. If turning the flag on made *every* session
emit English, FR→FR transcription would silently break.

*Default:* off. Everything routes through NLLB, all four pairs are correct, one
server profile covers them, and the sidecar never restarts during normal use.
FR→EN pays the sentence gate it need not pay.

*After Phase 0:* if `native-en` works, tick **Use Whisper's native English
translation** in Settings for a fast FR→EN. If the `mixed-paths` profile shows
both paths coexist, also tick **Native and NLLB coexist** and the model reload on
direction change disappears entirely. `test/profiles.test.js` already asserts
both behaviours.

**2. How much VRAM does large-v3 really need?**
ÚFAL say ≥10 GB for the SimulStreaming path. The app reads VRAM at launch and
pre-selects a model that will load, rather than letting you meet an
out-of-memory error mid-sentence. Override it in Settings.

**3. Does Windows loopback audio work?**
Implemented with the modern `setDisplayMediaRequestHandler` + `audio: 'loopback'`
route rather than the old constraint hack, but it is marked experimental in the
picker and fails to a clear message pointing at VB-Cable / VoiceMeeter.

**4. Is `medium` good enough?**
For French and English, plausibly. That judgement needs ears, not a script.

---

## How it fits together

```
Renderer          three selectors, caption surface, level meter
                  AudioWorklet: 48 kHz Float32 -> 16 kHz mono Int16
                       | binary PCM frames over a localhost WebSocket
Main process      spawns and supervises the sidecar, owns the profile key,
                  kills the process tree on quit
                       | child process, bound to 127.0.0.1 only
Sidecar           whisperlivekit-server --pcm-input
                  AlignAtt -> Whisper (CUDA) -> NLLB-200 (translation)
```

Two decisions carry most of the design:

- **Language is a query parameter, not a server flag.** Changing either dropdown
  closes and reopens one socket while the microphone keeps running. Only a change
  to the *server profile* — model size, policy, or the native-English flag —
  restarts anything, and the UI says so before you touch it.
- **`--pcm-input`, always.** Sending raw 16 kHz mono s16le sidesteps FFmpeg
  entirely, which is the more brittle dependency on Windows. Chromium gives us a
  native 16 kHz `AudioContext`, so the worklet is a pure format conversion.

---

## Auto-update

Wired with `electron-updater`, and shaped by one rule: **it must never interrupt
a live session.** Updates download quietly in the background; installing is
always your click, and if a session is running the app says so and asks again
before restarting.

Offline is treated as normal, not as an error — this is an app whose whole point
is working without a network, so a failed update check stays silent.

To turn it on you need a repo for releases to live in:

```powershell
gh repo create b2renger/Rtranslate --private --source=. --remote=origin
git push -u origin main

$env:GH_TOKEN = "ghp_..."      # a token with repo scope
# bump "version" in package.json, then:
npm run release                # builds, tags, uploads a DRAFT release
```

Publish the draft and every installed copy picks it up on next launch, or within
six hours.

**One gotcha, hit on the first run:** electron-builder publishes the installer and
its `.blockmap` through separate publisher instances. If the release does not
exist yet, both can decide to create it, and you end up with **two draft
releases** splitting the assets between them — which auto-update cannot use,
since it needs `latest.yml`, the `.exe` and the `.blockmap` in one place. Create
the release first and the publishers find it instead of racing:

```powershell
gh release create v0.1.1 --draft --title "0.1.1" --notes "..."
npm run release
```

Afterwards, check there is exactly one release and it holds all three files. To self-host instead of using GitHub, swap the `publish:` block in
`electron-builder.yml` for `provider: generic` and a URL, then copy the
installer, `latest.yml` and the `.blockmap` there.

Builds are unsigned, so Windows SmartScreen warns on first run. A code-signing
certificate is the only thing missing; updates themselves work regardless.

## Layout

Everything below is on `main` unless marked with the branch that adds it.

```
src/
  main/
    main.js         windows, IPC, shutdown, the --smoke harness
    engines/
      index.js      the registry: engines are FOUND by reading this directory,
                    never listed in a shared file - which is why the two engine
                    branches never conflict
      mock.js       fixed captions, known lags, no inference
      whisperlivekit.js   [engine/whisperlivekit] Python sidecar + CUDA PyTorch
      qvac.js             [engine/qvac]           Bare worker + Vulkan
      r2t2.js + r2t2/     [engine/r2t2]           vLLM server in WSL2, our contract
    miniws.js       the WebSocket server engines serve the contract with
    phoneServer.js  LAN caption server: SSE, access key, adapter ranking
    updater.js      auto-update, refusing to interrupt a live session
    settings.js     persisted config
  preload/preload.js
  renderer/
    app.js          orchestration, session lifecycle, socket handling
    audio.js        device enumeration, mic + loopback capture, worklet loading
    pcm-worklet.js  resampler and Int16 conversion
    transcript.js   caption state; committed solid, provisional dimmed
  phone/            the page phones load: no build step, no dependencies
  shared/languages.cjs   the one canonical language-code table
docs/
  TESTING.md          the human protocol: what a script cannot check, every branch
  engine-contract.md  the boundary: what an engine must do, and why it is a socket
  websocket-api.md    the wire protocol, as verified against WhisperLiveKit
  plan.md             the implementation plan
  audit-full.md       the original audit, including the Chinese analysis
spike/
  profile.mjs       the engine profiler - plain node, targets the contract, so
                    one code path measures every candidate; times each word
                    against when it was spoken and scores WER
  make-sample.ps1   SAPI speech with a transcript and per-word timings
  README.md         how to run a comparison
test/               unit tests
```

---

## Licence note

The default SimulStreaming backend is dual-licensed (PolyForm Noncommercial +
a separate commercial licence). WhisperLiveKit itself is Apache 2.0. If this ever
becomes commercial, switch the policy to **LocalAgreement** with the
`faster-whisper` backend in Settings — both are already wired up, and the
`large-fasterwhisper` spike profile measures what that costs in latency.
