# The Rtranslate engine contract

Rtranslate is a shell — audio capture, caption rendering, the phone display,
settings, packaging, auto-update — around a **transcription engine** that is
deliberately replaceable. This document is the boundary between the two.

An engine is anything that can be started on demand and then speaks the
protocol below over a localhost WebSocket. That is the whole contract. The
renderer never learns which engine is running.

Two engines exist, on two branches:

| Branch | Engine | Stack |
|---|---|---|
| `engine/whisperlivekit` | `whisperlivekit` | Python 3.12, CUDA PyTorch, SimulStreaming/AlignAtt + NLLB-200 |
| `engine/qvac` | `qvac` | Tether QVAC SDK on the Bare runtime, whisper.cpp/Parakeet + nmtcpp, Vulkan |

`main` carries the shell, this contract, the registry that finds engines, the
`mock` engine, and the measurement harness — and nothing that knows how either
real engine works.

---

## Why a WebSocket and not a function call

The obvious seam for a second engine is a JavaScript interface in the main
process: `engine.write(pcm)`, `engine.on('text', …)`. It is the wrong one here,
for a reason worth writing down.

The existing engine is a Python process that already speaks a WebSocket. The
candidate engine is a **Bare** worker — `@qvac/sdk` depends on `bare-runtime`,
not Node, so it does not load into Electron's main process either. *Both*
engines are out-of-process. A JS interface would therefore be a fiction wrapped
around a socket in one case and an RPC channel in the other, and each engine
would pay a different, unmeasured serialisation cost on the audio path.

Putting the socket in the contract instead means:

- The renderer, the AudioWorklet, `transcript.js` and the phone display are
  **byte-identical** across branches. A latency difference between engines is a
  difference in the engine, not in the shell around it.
- `spike/profile.mjs` measures an endpoint, so it measures both engines with one
  code path and no per-engine harness to keep honest.
- The `mock` engine is a real engine, not a test double, so `main` runs and is
  testable with no GPU and no Python.

The cost is one localhost WebSocket hop per audio frame. At 16 kHz mono s16le
that is 32 kB/s, and the hop is tens of microseconds against an ASR budget
measured in hundreds of milliseconds. It is below the noise floor of what we are
comparing.

---

## The protocol

Inherited verbatim from WhisperLiveKit so that the incumbent engine satisfies it
without a shim. [`websocket-api.md`](websocket-api.md) is the source-of-truth
description; what follows is the subset an engine **must** implement.

**Endpoint:** `ws://127.0.0.1:<port>/asr`

### Query parameters

| Param | Values | Required |
|---|---|---|
| `language` | ISO 639-1 (`fr`, `en`) or `auto` | yes |
| `target_language` | NLLB code (`fra_Latn`, `eng_Latn`) — absent means transcribe only | no |
| `mode` | `full` (default) or `diff` | no |

Changing either language is a **reconnect**, never a restart. An engine that
cannot honour a language change without reloading a model must still accept the
new socket and may take longer to produce its first line; it must not drop the
process out from under the shell.

### Client → engine

- **Audio:** binary frames, PCM signed 16-bit little-endian, 16 kHz, mono.
- **End of audio:** an empty binary frame.

The shell always sends this format. An engine must not require a container or
shell out to FFmpeg — avoiding that dependency on Windows is why the format is
fixed.

### Engine → client

**On connect**, immediately:

```json
{ "type": "config", "useAudioWorklet": true, "mode": "full" }
```

`useAudioWorklet: true` asserts the engine is in raw-PCM mode. The shell warns
if this is false while it is sending PCM, because everything downstream is then
garbage.

**Transcription updates**, as often as the engine has something to say:

```json
{
  "status": "active_transcription",
  "lines": [
    { "speaker": 1, "text": "Hello world", "start": "0:00:00", "end": "0:00:03",
      "translation": "Bonjour le monde", "detected_language": "en" }
  ],
  "buffer_transcription": "and then",
  "buffer_translation": "et puis",
  "remaining_time_transcription": 1.2
}
```

The parts that carry meaning for the shell:

- `lines` is **full state** in `full` mode, not a delta. The client diffs.
- `translation` sits on the line beside `text`. When the shell asked for a
  `target_language`, it renders `translation`; otherwise `text`. This is what
  lets the harness time transcription and translation separately.
- `buffer_transcription` / `buffer_translation` are the **provisional** text,
  rendered dimmed. An engine with no notion of provisional output may send `""`
  — it will simply look less live.
- `start` / `end` are **strings** (`str(timedelta)`: `"0:00:03"` or
  `"0:00:03.250000"`). Parse defensively.
- `speaker: -2` with `text: null` is a silence marker. Skip it.

**End of stream**, after flushing everything that followed the empty frame:

```json
{ "type": "ready_to_stop" }
```

### What an engine may add

Extra fields are ignored, not rejected — `buffer_diarization`,
`remaining_time_diarization` and QVAC's VAD/end-of-turn signals can ride along
without a contract change. An engine advertises optional abilities through its
descriptor (below), not by changing the wire format.

---

## The main-process descriptor

Engines live in `src/main/engines/`, one module each, and the registry
enumerates that directory. Adding an engine is adding a file; **no shared file
lists the engines**, which is exactly why the two branches never conflict here.

```js
module.exports = {
  id: 'mock',                    // stable, used in settings.engine
  label: 'Mock engine',          // shown in the UI
  description: '…',              // one line

  /** Can this engine run on this machine right now? */
  async inspect() {
    return { ok: true, problem: null, message: '', info: {} };
  },

  /** Language pair -> what will happen, without doing it. Pure. */
  plan(settings, sourceId, targetId) {
    return { profileKey, query, display: { primaryField, bufferField, note } };
  },

  /** Make an endpoint exist that matches `plan`. Same plan -> no-op. */
  async ensure(plan) {
    return { port: 8799, restarted: false };
  },

  async stop() {},
  state() { return 'ready'; },
  logs() { return []; },

  /** Optional abilities the shell can light up if present. */
  capabilities: { diarization: false, vad: false, nativeEnglish: false },
};
```

`plan()` is pure and unit-tested per engine: it is where "which model, which
translation route, does this force a restart" lives, and those answers are
engine-specific. `profileKey` is the identity of the underlying process — equal
keys mean `ensure()` is a no-op, different keys mean a restart the UI warns
about first.

---

## Measuring an engine

`spike/profile.mjs` speaks the client half of this protocol against any endpoint
and reports the numbers the comparison turns on:

- **time to first partial** — how quickly text appears at all
- **time to first commit** — how quickly text stops moving
- **commit latency** distribution against the audio timeline
- **translation lag** — commit of `translation` minus commit of `text`
- **real-time factor** and whether it holds under continuous input
- peak VRAM and GPU utilisation, sampled alongside

Because it targets the contract rather than an engine, the same invocation
profiles WhisperLiveKit, QVAC, or the mock. See
[`../spike/README.md`](../spike/README.md).
