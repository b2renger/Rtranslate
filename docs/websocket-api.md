# WhisperLiveKit wire protocol — verified notes

Extracted from the project's `docs/API.md` and used to implement
`spike/measure_latency.py`. This is what Phase 2's AudioWorklet client and
Phase 3's caption renderer will target, so it is worth having written down in
our own words.

**Endpoint:** `ws://<host>:<port>/asr`

## Query parameters

| Param | Values | Notes |
|---|---|---|
| `language` | ISO 639-1 (`fr`, `en`) or `auto` | Per-session. This is what makes the UI cheap — no server restart |
| `target_language` | NLLB code, e.g. `fra_Latn`, `eng_Latn` | Per-session. Routes through NLLB |
| `mode` | `full` (default) or `diff` | `diff` sends incremental updates instead of full state snapshots |
| `token` | API key | Only if the server was started with auth |

Note the asymmetry that Phase 0 has to resolve: `--direct-english-translation`
is a **server flag**, not a query parameter. Whether one server can serve both
that path and the NLLB path is undocumented.

## Client → server

**Audio frames:** binary WebSocket frames.

With `--pcm-input` (what we use), the format is **PCM signed 16-bit
little-endian, 16 kHz, mono** (`s16le`). Without it, the server accepts any
container FFmpeg can decode — which is exactly the dependency we are avoiding on
Windows.

**End of audio:** send an empty binary frame (`b""`).

## Server → client

### On connect

```json
{
  "type": "config",
  "useAudioWorklet": true,
  "mode": "full"
}
```

`useAudioWorklet: true` means the server is in PCM mode. **If this comes back
`false` while we are sending raw PCM, everything downstream is garbage** — the
server will try to FFmpeg-decode our samples. The harness checks this and warns;
the Electron client should too.

### Transcription update (full mode)

```json
{
  "status": "active_transcription",
  "lines": [
    {
      "speaker": 1,
      "text": "Hello world",
      "start": "0:00:00",
      "end": "0:00:03",
      "translation": "...",
      "detected_language": "en"
    }
  ],
  "buffer_transcription": "...",
  "buffer_diarization": "",
  "buffer_translation": "",
  "remaining_time_transcription": 1.2,
  "remaining_time_diarization": 0.5
}
```

Points that matter for us:

- **`start` / `end` are strings**, not numbers — `str(timedelta)` format, so
  `"0:00:03"` or `"0:00:03.250000"` depending on whether there is a fractional
  part. Parse defensively; `measure_latency.py` has a tolerant parser.
- **`translation` sits on the line**, alongside `text`. That is what lets the
  harness measure transcript and translation latency separately, which is how we
  confirm or refute the NLLB sentence gate.
- **`buffer_transcription` / `buffer_translation`** carry the provisional,
  not-yet-committed text. Phase 3 renders these grey — readers handle revisions
  correctly when they can see what is still in flight.
- **`speaker: -2` with `text: null`** marks a silence segment. Skip it.
- `lines` is the **full state** in `full` mode, so the client must diff against
  what it already displayed rather than appending blindly.

### Diff mode

`?mode=diff` sends a `snapshot` first, then `diff` messages:

```json
{ "type": "snapshot", "seq": 1, "status": "...", "lines": [...], ... }
{ "type": "diff", "seq": 4, "status": "...", "n_lines": 5, "lines_pruned": 1,
  "new_lines": [...], "buffer_transcription": "...", ... }
```

Worth evaluating in Phase 3 if full-state snapshots turn out to cause visible
re-render churn. Not needed for the spike.

### End of stream

```json
{ "type": "ready_to_stop" }
```

Sent after the server has flushed everything following our empty binary frame.
The harness waits for this before computing final statistics, and treats commits
arriving after end-of-audio separately — they are real latency, but distorted by
flush semantics rather than representative of live use.

## Source

[`docs/API.md`](https://github.com/QuentinFuxa/WhisperLiveKit/blob/main/docs/API.md)
in the WhisperLiveKit repository. Re-check it when bumping the pinned version —
this is exactly the kind of thing that changes silently.
