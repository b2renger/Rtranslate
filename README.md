# WhisperLive

A local, GPU-accelerated live transcription and translation desktop app for
Windows. French ↔ English. Nothing leaves the machine.

An Electron shell around a [WhisperLiveKit](https://github.com/QuentinFuxa/WhisperLiveKit)
sidecar: pick an audio source, a spoken language and a display language, and read
captions as people talk.

---

## First run

Install `WhisperLive-<version>-x64.exe`, launch it, and press **Set up**. The app
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

The whole UI can be driven against a protocol-accurate stand-in:

```powershell
spike\.venv\Scripts\python.exe spike\mock_server.py 8799
npx electron . --smoke --smoke-phone --smoke-ws=ws://127.0.0.1:8799/asr
```

### Tests

```powershell
npm test        # 51 unit tests: session planning, diagnosis, ports, phone server, CUDA resolution
npm run smoke   # renderer: preload bridge, AudioContext, AudioWorklet, captions
```

Add `--smoke-phone` to also start the LAN server, load the phone page in a real
browser window, push captions into it and read back what a phone would show.

### Building

```powershell
npm run dist      # release\WhisperLive-<version>-x64.exe  (~100 MB)
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

- 51 unit tests covering session planning, the four language pairs, profile-key
  stability, failure diagnosis, port handling, the phone server's access control,
  SSE delivery, backlog replay and transcript cap, and the CUDA resolution
  verifier against real resolver output
- A renderer smoke test proving the preload bridge, ES module wiring, a 16 kHz
  `AudioContext` (native — no resampling needed), `AudioWorklet.addModule` under
  the page CSP, and the worklet instantiating
- An end-to-end run against `spike/mock_server.py`: real binary PCM frames in,
  rendered captions out, over a real WebSocket
- An end-to-end run of the phone display: LAN server up, page loaded in a real
  browser window, SSE connected, captions rendered, the source/translation
  toggle working, and a wrong key refused

### What has not

Everything that needs the card: model loading, real latency, real VRAM, whether
`--direct-english-translation` behaves as assumed, whether Windows loopback audio
works at all.

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
gh repo create b2renger/WhisperLive --private --source=. --remote=origin
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

```
src/
  main/
    main.js         windows, IPC, shutdown, the --smoke harness
    sidecar.js      spawn / health / crash / guaranteed kill, failure diagnosis
    pythonEnv.js    env discovery, the cuDNN PATH fix, GPU probe
    profiles.js     session planning - the module that absorbs question 1
    phoneServer.js  LAN caption server: SSE, access key, adapter ranking
    updater.js      auto-update, refusing to interrupt a live session
    envSetup.js     first-run Python environment: resolve, verify CUDA, install
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
  plan.md           the implementation plan
  audit-full.md     the original audit, including the Chinese analysis
  websocket-api.md  verified wire protocol
spike/              Phase 0 measurement harness + the mock server
test/               unit tests
```

---

## Licence note

The default SimulStreaming backend is dual-licensed (PolyForm Noncommercial +
a separate commercial licence). WhisperLiveKit itself is Apache 2.0. If this ever
becomes commercial, switch the policy to **LocalAgreement** with the
`faster-whisper` backend in Settings — both are already wired up, and the
`large-fasterwhisper` spike profile measures what that costs in latency.
