"""
The R2T2 engine server: NetEase Youdao's Confucius4-R2T2 behind
docs/engine-contract.md.

Confucius4-R2T2 is a 1.7B streaming ASR model (Qwen3-ASR base) trained for a
"longest stable prefix": every 160 ms chunk it commits the words it will never
revise and holds back only the last token or so. That is the property this
engine is here for - the one the QVAC engine measurably lacks - so this server
exists mostly to keep it intact on the way to the shell.

Why this is our own server and not upstream's ws_server.py
----------------------------------------------------------
Upstream ships a WebSocket server. It is not used, for three reasons:

  1. It hardcodes gpu_memory_utilization=0.95. On a shared card that is a
     request for nearly the whole GPU; next to the live farm on the dev box it
     would either refuse to start or push other people's models out.
  2. It sends only append-only deltas and throws away the unfixed tail that
     streaming_transcribe() returns alongside the fixed text. That tail is
     exactly the contract's `buffer_transcription` - the dimmed "still in
     flight" text - and dropping it would recreate QVAC's blank-screen problem
     for no reason.
  3. Its protocol is not ours (a string EOS marker, a JSON header, delta
     messages), so it would need a shim on the Node side anyway.

The chunk schedule, adaptive max_new_tokens, VAD segmentation, hard reset and
hallucination guard below are adapted from upstream's ws_server.py, which is
Apache-2.0: https://github.com/netease-youdao/Confucius4-R2T2 . The model
weights are under the separate NetEase Youdao Model Use License Agreement.

Runs inside the model's own Python environment (Linux, vLLM). Usage:

    python server.py --model ~/models/Confucius4-R2T2 --vad ~/models/vad/Stream-VAD

Prints `READY <port>` on stdout once the model is warm, and nothing else on
stdout. Logs go to stderr. Exits when stdin closes, taking its vLLM children
with it - see watch_parent().
"""

import argparse
import asyncio
import concurrent.futures
import http
import json
import os
import re
import signal
import sys
import threading
import time
from urllib.parse import parse_qs, urlparse

import numpy as np

SR = 16000
CHUNK_SEC = 0.16
STEP = int(round(CHUNK_SEC * SR))          # 2560 samples
LOOKAHEAD = int(round(0.16 * SR))          # the first chunk carries this much extra
UNFIXED_TOKENS = 1                         # upstream's default: hold back one token
HARD_RESET_SEC = 90.0                      # bound the context when VAD never fires

# ISO 639-1, as the contract sends it, to the names Qwen3-ASR expects.
LANGUAGE_NAMES = {
    "en": "English", "fr": "French", "de": "German", "es": "Spanish",
    "it": "Italian", "pt": "Portuguese", "ru": "Russian", "ja": "Japanese",
    "ko": "Korean", "ar": "Arabic", "zh": "Chinese",
}


def log(msg):
    print(f"[r2t2] {msg}", file=sys.stderr, flush=True)


def timestamp(seconds):
    """The contract's format: str(timedelta), e.g. '0:00:04' or '0:00:03.250000'."""
    whole = int(seconds)
    frac = seconds - whole
    base = f"{whole // 3600}:{(whole % 3600) // 60:02d}:{whole % 60:02d}"
    return base if frac < 1e-6 else f"{base}.{int(round(frac * 1e6)):06d}"


# ---------------------------------------------------------------------------
# hallucination guard - adapted from upstream ws_server.py (Apache-2.0)
# ---------------------------------------------------------------------------

_PUNCT_CHARS = "，。！？、；：,.!?;:~…·\"'()（）《》—-"
_PUNCT_RE = re.compile(r"[%s\s]+" % re.escape(_PUNCT_CHARS))


def detect_hallucination(text, repeats=5, max_pattern_len=50, tail_len=256):
    """True when the tail of `text` is one pattern looping, e.g. 'okay. okay. okay.'"""
    if not text:
        return False
    for candidate in (text[-tail_len:], _PUNCT_RE.sub("", text[-tail_len:]).lower()):
        n = len(candidate)
        for k in range(3, max_pattern_len + 1):
            if n < k * repeats:
                break
            pattern = candidate[-k:]
            if not pattern.strip(_PUNCT_CHARS + " \t"):
                continue
            if all(candidate[-(r + 1) * k:-r * k] == pattern for r in range(1, repeats)):
                return True
    return False


# ---------------------------------------------------------------------------
# the model
# ---------------------------------------------------------------------------

class Model:
    """
    The loaded ASR model and VAD, and the only thing that touches the GPU.

    vLLM calls are synchronous and can take tens of milliseconds, so every one
    runs on a single dedicated thread. That keeps the event loop free to take
    audio frames while a chunk decodes, and serialises GPU work without a lock.
    """

    def __init__(self, args):
        import torch
        from fireredvad import FireRedStreamVad, FireRedStreamVadConfig
        from r2t2 import R2T2ASRModel

        free, total = (x / 2**30 for x in torch.cuda.mem_get_info())
        log(f"GPU: {free:.1f} of {total:.1f} GiB free")
        if args.vram_gib > free - 1:
            raise SystemExit(
                f"refusing to start: budget {args.vram_gib} GiB, only {free:.1f} GiB free on this GPU")

        self.gpu = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix="gpu")

        t0 = time.time()
        self.vad = FireRedStreamVad.from_pretrained(args.vad, FireRedStreamVadConfig(
            use_gpu=True, smooth_window_size=5, speech_threshold=0.4, pad_start_frame=5,
            min_speech_frame=8, max_speech_frame=2000, min_silence_frame=20,
            chunk_max_frame=30000))

        # kv_cache_memory_bytes, not just gpu_memory_utilization. With only a
        # utilisation fraction, vLLM sizes the KV cache by profiling free memory
        # during startup and ASSERTS that no other process changed its usage
        # meanwhile. On a card shared with the farm, an Ollama model unloading
        # mid-profile (measured: free memory went 51 -> 89 GiB) aborts the init.
        # An explicit KV size skips that profiler entirely, and is the better
        # control anyway: an absolute budget, not a share of whatever card this
        # happens to run on.
        self.asr = R2T2ASRModel.LLM(
            model=args.model,
            gpu_memory_utilization=args.vram_gib / total,
            kv_cache_memory_bytes=int(args.kv_gib * 2**30),
            max_model_len=args.max_model_len,
            max_new_tokens=1,
            enforce_eager=args.enforce_eager,
        )
        log(f"model loaded in {time.time() - t0:.1f}s")

        # Warm up before accepting audio. The first streaming chunk otherwise
        # pays vLLM's compile and graph capture - measured at 29 s on the dev
        # box - and a user would read that as the app being broken. Both chunk
        # shapes are warmed: the first chunk carries the lookahead, later ones
        # do not.
        t0 = time.time()
        for lang in dict.fromkeys([args.warm_language, "English", "French"]):
            state = self.new_state(lang)
            self.step(np.zeros(STEP + LOOKAHEAD, np.float32), state, 4, first=True)
            for _ in range(3):
                self.step(np.zeros(STEP, np.float32), state, 2)
            self.finish(state, 4)
        log(f"warm in {time.time() - t0:.1f}s")

    def new_state(self, language):
        return self.asr.init_streaming_state(
            language=language, unfixed_chunk_num=0,
            unfixed_token_num=UNFIXED_TOKENS, chunk_size_sec=CHUNK_SEC)

    def step(self, seg, state, max_new, first=False):
        size = STEP + LOOKAHEAD if first else STEP
        state.chunk_size_sec = size / SR
        state.chunk_size_samples = size
        text, fixed = self.asr.streaming_transcribe(seg, state, int(max_new))
        return text.split("|")[0], fixed.split("|")[0]

    def finish(self, state, max_new):
        return self.asr.finish_streaming_transcribe(state, int(max_new)).split("|")[0]

    def speech_ended(self, seg):
        results = self.vad.detect_chunk((seg * 32768).astype(np.int16))
        return any(r.is_speech_end for r in results)

    async def run(self, fn, *args, **kwargs):
        return await asyncio.get_running_loop().run_in_executor(
            self.gpu, lambda: fn(*args, **kwargs))


# ---------------------------------------------------------------------------
# one client session
# ---------------------------------------------------------------------------

class Session:
    """
    One contract session: PCM in, full-state transcription updates out.

    Each VAD speech segment becomes one contract line. Within a segment the
    model's fixed text is the line's committed `text`, and whatever it has
    decoded but not yet fixed is `buffer_transcription` - so the reader sees
    words land dimmed and turn solid a fraction of a second later.
    """

    def __init__(self, model, ws, language_iso):
        self.model = model
        self.ws = ws
        self.language_iso = language_iso
        self.language = LANGUAGE_NAMES.get(language_iso) if language_iso != "auto" else None

        self.pending = np.zeros(0, np.float32)
        self.received = 0                      # samples received
        self.processed = 0                     # samples decoded
        self.eos = False
        self.more = asyncio.Event()

        self.lines = []
        self.buffer = ""
        self.open_line = None                  # index of the line the current segment writes to
        self.segment_start = 0.0
        self.segment_fixed = ""
        self.last_sent = None

    # -- audio in -----------------------------------------------------------

    async def receive(self):
        async for message in self.ws:
            if isinstance(message, str):
                continue                       # the contract sends no text frames
            if len(message) == 0:              # the contract's end-of-audio
                self.eos = True
                self.more.set()
                return
            samples = np.frombuffer(message, dtype=np.int16).astype(np.float32) / 32768.0
            self.pending = np.concatenate((self.pending, samples))
            self.received += len(samples)
            self.more.set()
        self.eos = True                        # socket closed without end-of-audio
        self.more.set()

    # -- output -------------------------------------------------------------

    async def publish(self, force=False):
        committed = [(l["text"], l["end"]) for l in self.lines]
        shape = (committed, self.buffer)
        if shape == self.last_sent and not force:
            return
        self.last_sent = shape
        await self.ws.send(json.dumps({
            "status": "active_transcription",
            "lines": self.lines,
            "buffer_transcription": self.buffer,
            "buffer_translation": "",
            "buffer_diarization": "",
            # How far decoding trails the audio received. Not required by the
            # contract, but it is the honest answer to "is it keeping up", and
            # the renderer already has a slot for it.
            "remaining_time_transcription": round((self.received - self.processed) / SR, 3),
        }, ensure_ascii=False))

    def commit(self, fixed, text):
        """Fold one decode result into the contract's line state."""
        audio_now = self.processed / SR
        if len(fixed) > len(self.segment_fixed):
            self.segment_fixed = fixed
            if self.open_line is None:
                self.lines.append({
                    "speaker": 1, "text": "", "start": timestamp(self.segment_start),
                    "end": timestamp(audio_now), "detected_language": self.language_iso,
                })
                self.open_line = len(self.lines) - 1
            line = self.lines[self.open_line]
            line["text"] = fixed.strip()
            line["end"] = timestamp(audio_now)
        self.buffer = text[len(fixed):].strip() if text.startswith(fixed) else ""

    async def close_segment(self, state, max_new):
        final = await self.model.run(self.model.finish, state, max_new)
        if len(final) > len(self.segment_fixed):
            self.commit(final, final)
        self.buffer = ""
        self.open_line = None
        self.segment_fixed = ""
        self.segment_start = self.processed / SR
        return await self.model.run(self.model.new_state, self.language)

    # -- the decode loop, adapted from upstream ws_server.py -----------------

    async def process(self):
        m = self.model
        state = await m.run(m.new_state, self.language)
        first = True
        max_new = max(1, (STEP + LOOKAHEAD) // 1280)
        floor = min(32, max(4, 2 * (STEP // 1280)))
        since_reset = 0.0

        while True:
            need = STEP + LOOKAHEAD if first else STEP
            if len(self.pending) < need:
                if self.eos:
                    break
                self.more.clear()
                await self.more.wait()
                continue

            seg, self.pending = self.pending[:need], self.pending[need:]
            text, fixed = await m.run(m.step, seg, state, max_new, first=first)
            # The whole chunk, first one included: the VAD is stateful and
            # frame-based, so skipping audio would shift every later decision.
            ended = await m.run(m.speech_ended, seg)
            first = False
            self.processed += need
            since_reset += need / SR

            grew = len(fixed) > len(self.segment_fixed)
            self.commit(fixed, text)
            max_new = max(1, STEP // 1280) if grew else min(floor, max_new + 0.5)

            # A segment closes on a VAD speech end, on a looping hallucination,
            # or after HARD_RESET_SEC with no pause at all. Each one bounds the
            # decoder's context, which is what keeps chunk cost flat over a
            # long session rather than growing with it.
            if ended or detect_hallucination(self.segment_fixed) or since_reset >= HARD_RESET_SEC:
                state = await self.close_segment(state, max(1, (STEP + LOOKAHEAD) // 1280))
                since_reset = 0.0

            await self.publish()

        # End of audio. Decode what is left rather than dropping it - a final
        # word shorter than one chunk is still a word - padded with silence to
        # the chunk size the state expects.
        if len(self.pending):
            seg = np.concatenate((self.pending, np.zeros(STEP - len(self.pending) % STEP, np.float32)))
            for i in range(0, len(seg), STEP):
                text, fixed = await m.run(m.step, seg[i:i + STEP], state, max_new, first=False)
                self.processed = min(self.received, self.processed + STEP)
                self.commit(fixed, text)
            self.pending = np.zeros(0, np.float32)
        await self.close_segment(state, max(1, (STEP + LOOKAHEAD) // 1280))
        await self.publish(force=True)
        await self.ws.send(json.dumps({"type": "ready_to_stop"}))

    async def run(self):
        await self.ws.send(json.dumps({"type": "config", "useAudioWorklet": True, "mode": "full"}))
        receiver = asyncio.create_task(self.receive())
        try:
            await self.process()
        except Exception as err:  # noqa: BLE001 - every failure must reach the client
            # A failed session must never look like a quiet one: the shell would
            # say Ready and show a blank screen. Put it on the wire.
            log(f"session failed: {err!r}")
            try:
                await self.ws.send(json.dumps({"status": "error", "message": str(err),
                                               "lines": self.lines, "buffer_transcription": ""}))
                await self.ws.send(json.dumps({"type": "ready_to_stop"}))
            except Exception:  # noqa: BLE001
                pass
        finally:
            receiver.cancel()


# ---------------------------------------------------------------------------
# the server
# ---------------------------------------------------------------------------

def watch_parent():
    """
    Exit when stdin closes.

    The shell starts this through wsl.exe. Killing wsl.exe on the Windows side
    does not reliably kill the Linux process behind it, and an orphaned server
    holds its VRAM until someone finds it - the exact failure the whole
    shutdown path in the shell exists to prevent. The pipe does close, though,
    so stdin EOF is the signal that cannot be missed. Kill the process group,
    because vLLM runs its engine core as a separate child.
    """
    def wait():
        try:
            while sys.stdin.buffer.read(4096):
                pass
        finally:
            log("stdin closed: shutting down")
            os.killpg(os.getpgid(0), signal.SIGKILL)
    threading.Thread(target=wait, daemon=True, name="parent-watch").start()


async def serve(model, args):
    from websockets.asyncio.server import serve as ws_serve

    active = {"task": None}

    def route(connection, request):
        path = urlparse(request.path).path
        if path == "/health":
            return connection.respond(http.HTTPStatus.OK, "ok\n")
        if path != "/asr":
            return connection.respond(http.HTTPStatus.NOT_FOUND, "not the contract endpoint\n")
        return None

    async def handler(ws):
        query = parse_qs(urlparse(ws.request.path).query)
        language = (query.get("language") or ["auto"])[0]
        if language != "auto" and language not in LANGUAGE_NAMES:
            await ws.close(code=1008, reason=f"unsupported language {language}")
            return

        # One session at a time, and the newest wins: the shell reconnects on
        # every language change, and a client that vanished without closing
        # must not block the one that replaced it.
        if active["task"] and not active["task"].done():
            active["task"].cancel()
        log(f"session: language={language}")
        active["task"] = asyncio.current_task()
        await Session(model, ws, language).run()

    async with ws_serve(handler, args.host, args.port, process_request=route,
                        compression=None, ping_interval=None, max_size=None) as server:
        port = server.sockets[0].getsockname()[1]
        print(f"READY {port}", flush=True)
        log(f"listening on ws://{args.host}:{port}/asr")
        await asyncio.Future()


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--model", required=True, help="Confucius4-R2T2 weights directory")
    parser.add_argument("--vad", required=True, help="FireRedVAD Stream-VAD directory")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0, help="0 picks a free port; read READY")
    parser.add_argument("--vram-gib", type=float, default=6.0,
                        help="total GPU budget: weights (~3.9 GiB) + activations + KV")
    parser.add_argument("--kv-gib", type=float, default=1.5,
                        help="KV cache, exact. ~0.9 GiB holds one 8k-token stream")
    parser.add_argument("--max-model-len", type=int, default=8192)
    parser.add_argument("--enforce-eager", action="store_true",
                        help="skip compilation and CUDA graphs: faster start, slower chunks")
    parser.add_argument("--warm-language", default="French")
    args = parser.parse_args()

    # Lead our own process group, so watch_parent can kill the vLLM engine
    # core along with us. Launched through wsl.exe with `exec`, this process is
    # already a SESSION leader - and a session leader may not change group
    # (EPERM), but it already leads its own. Either way killpg below works.
    try:
        os.setpgrp()
    except PermissionError:
        assert os.getpgid(0) == os.getpid(), "not a group leader and cannot become one"
    watch_parent()
    model = Model(args)
    asyncio.run(serve(model, args))


# vLLM starts its engine core with the "spawn" method, which re-imports this
# file - so nothing may run at import time.
if __name__ == "__main__":
    main()
