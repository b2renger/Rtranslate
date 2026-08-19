# WhisperLive

A local, GPU-accelerated live transcription and translation desktop app for
Windows. French ↔ English. Nothing leaves the machine.

An Electron shell around a [WhisperLiveKit](https://github.com/QuentinFuxa/WhisperLiveKit)
sidecar: pick an audio source, a spoken language and a display language, and read
captions as people talk.

---

## Run it

On the machine with the NVIDIA GPU:

```powershell
npm install
npm run bootstrap      # Python 3.12 venv + CUDA stack + the cuDNN fix (3-4 GB)
npm start
```

If you have already run the Phase 0 spike on that machine, `npm run bootstrap`
is optional — the app falls back to `spike\.venv` rather than downloading a
second copy of PyTorch.

### Without a GPU

The whole UI can be driven against a protocol-accurate stand-in:

```powershell
spike\.venv\Scripts\python.exe spike\mock_server.py 8799
npx electron . --smoke --smoke-ws=ws://127.0.0.1:8799/asr
```

### Tests

```powershell
npm test     # 25 unit tests: session planning, failure diagnosis, port handling
npm run smoke   # renderer: preload bridge, AudioContext, AudioWorklet, captions
```

---

## Status

**Written in one pass, not yet run against a real GPU.** Phases 1–4 are
implemented; Phase 0's measurements and Phase 5's packaging are not done.

| Phase | What | State |
|---|---|---|
| P0 | Measure latency and VRAM | tooling ready in `spike/`, **not yet run** |
| P1 | Sidecar contract | done |
| P2 | Audio path | done |
| P3 | Interface | done |
| P4 | Language matrix | done |
| P5 | Packaging and first run | **not done** — see `electron-builder.yml` |
| P6 | Optional extras | not started |

### What has actually been verified

Everything that can be checked without a GPU has been:

- 25 unit tests covering session planning, the four language pairs, profile-key
  stability, failure diagnosis and port handling
- A renderer smoke test proving the preload bridge, ES module wiring, a 16 kHz
  `AudioContext` (native — no resampling needed), `AudioWorklet.addModule` under
  the page CSP, and the worklet instantiating
- An end-to-end run against `spike/mock_server.py`: real binary PCM frames in,
  rendered captions out, over a real WebSocket

### What has not

Everything that needs the card: model loading, real latency, real VRAM, whether
`--direct-english-translation` behaves as assumed, whether Windows loopback audio
works at all. The four open questions below are the ones that could still bite.

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

## Layout

```
src/
  main/
    main.js         windows, IPC, shutdown, the --smoke harness
    sidecar.js      spawn / health / crash / guaranteed kill, failure diagnosis
    pythonEnv.js    env discovery, the cuDNN PATH fix, GPU probe
    profiles.js     session planning - the module that absorbs question 1
    settings.js     persisted config
  preload/preload.js
  renderer/
    app.js          orchestration, session lifecycle, socket handling
    audio.js        device enumeration, mic + loopback capture, worklet loading
    pcm-worklet.js  resampler and Int16 conversion
    transcript.js   caption state; committed solid, provisional dimmed
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
