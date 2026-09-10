#!/usr/bin/env python3
"""
A stand-in for whisperlivekit-server that speaks the documented protocol with
known, deliberate lags.

Two uses:

1. It validated `measure_latency.py` before that harness was ever pointed at a
   real GPU - inject a 1.20 s transcript lag and a 2.50 s translation lag, and
   check the harness reports them back.

2. It lets the Electron app be developed and smoke-tested on a machine with no
   NVIDIA GPU at all:

       python spike/mock_server.py 8799
       npx electron . --smoke --smoke-ws=ws://127.0.0.1:8799/asr

It is deliberately dumb: it counts the PCM samples it receives to know what
"now" is in audio time, and emits fixed segments once they fall far enough
behind that clock. No audio is ever decoded.

Requires: websockets
"""

from __future__ import annotations

import argparse
import asyncio
import json
from datetime import timedelta

import websockets

RATE = 16000
SEGMENT_SECONDS = 2.0


def timestamp(seconds: float) -> str:
    """Match the server's format: str(timedelta), e.g. '0:00:04'."""
    return str(timedelta(seconds=seconds))


async def handler(ws, *_args, args):
    await ws.send(json.dumps({'type': 'config', 'useAudioWorklet': True, 'mode': 'full'}))
    state = {'samples': 0, 'eos': False}

    async def emitter():
        while True:
            await asyncio.sleep(0.2)
            audio_t = state['samples'] / RATE
            if state['eos']:
                audio_t += 99  # flush everything once the client signals EOS

            n_commit = max(0, int((audio_t - args.lag) // SEGMENT_SECONDS))
            n_trans = max(0, int((audio_t - args.translation_lag) // SEGMENT_SECONDS))
            if n_commit == 0:
                continue

            lines = []
            for i in range(n_commit):
                line = {
                    'speaker': 1,
                    'text': f'segment {i} spoken words',
                    'start': timestamp(i * SEGMENT_SECONDS),
                    'end': timestamp((i + 1) * SEGMENT_SECONDS),
                    'detected_language': 'fr',
                }
                if i < n_trans:
                    line['translation'] = f'traduction du segment {i}'
                lines.append(line)

            await ws.send(json.dumps({
                'status': 'active_transcription',
                'lines': lines,
                'buffer_transcription': 'mots en cours...',
                'buffer_diarization': '',
                'buffer_translation': 'words in flight...',
                'remaining_time_transcription': 0.3,
                'remaining_time_diarization': 0.0,
            }))

            if state['eos']:
                await asyncio.sleep(0.3)
                await ws.send(json.dumps({'type': 'ready_to_stop'}))
                return

    task = asyncio.create_task(emitter())
    try:
        async for message in ws:
            if isinstance(message, bytes):
                if len(message) == 0:
                    state['eos'] = True          # documented end-of-audio signal
                else:
                    state['samples'] += len(message) // 2   # s16le
    except websockets.ConnectionClosed:
        pass
    await asyncio.sleep(1.5)
    task.cancel()


async def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('port', nargs='?', type=int, default=8799)
    parser.add_argument('--lag', type=float, default=1.20, help='injected transcript lag, seconds')
    parser.add_argument('--translation-lag', type=float, default=2.50, help='injected translation lag, seconds')
    args = parser.parse_args()

    async def bound(ws, *rest):
        await handler(ws, *rest, args=args)

    async with websockets.serve(bound, '127.0.0.1', args.port):
        print(f'mock whisperlivekit on ws://127.0.0.1:{args.port}/asr '
              f'(lag {args.lag}s / {args.translation_lag}s)', flush=True)
        await asyncio.Future()


if __name__ == '__main__':
    asyncio.run(main())
