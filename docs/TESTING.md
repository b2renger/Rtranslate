# Testing Rtranslate by hand

`npm test` and `spike/profile.mjs` already cover what a machine can check. This
document is for the rest — the things that decide whether this app is any good,
and which no script can answer.

It covers **every engine branch** — `engine/whisperlivekit`, `engine/qvac` and
`engine/r2t2` — because the point of having several is to choose between them,
and a comparison run differently on each branch is not a comparison.

---

## The one rule that matters

> **Run every live test for at least four minutes of continuous speech.**

Not thirty seconds. A streaming engine carries context forward, resets it on
pauses or on a timer, and can fall behind the audio if it cannot keep up — all
of which only show over minutes. A short test shows you the first number and
hides the one you will actually live with.

Four minutes is also roughly the shortest stretch that tells you whether reading
the captions is tolerable, which is the real question.

**A correction, kept here on purpose.** This rule was first justified by a
measurement that QVAC's latency climbed from under a second to twenty-four
seconds within one run. That was wrong. It came from timing lines against
QVAC's own segment timestamps, which restart at every segment and had to be
reconstructed — and an accumulating error in that reconstruction produces
exactly a monotonic climb. Timed per word against when each word was actually
spoken (`spike/profile.mjs` now does this whenever the sample has a
`.words.json`), QVAC holds a flat ~3 s over three and a half minutes, and so
does every other engine measured so far. The rule stands on its own merits;
the lesson is to trust the ground-truth measurement over one built on an
engine's own timestamps. The profiler now reports drift — first third of the
run against the last — so this no longer depends on anyone's eyes.

---

## What only a human can answer

The profiler reports latency, throughput and VRAM. It cannot tell you:

| Question | Why a script can't |
|---|---|
| Are the captions **readable while someone talks**? | Latency is a number; legibility is a judgement about revisions, chunk size and rhythm. |
| Is the **absence of provisional text** tolerable? | QVAC emits nothing until a line is final - measured, a word lands ~3 s after it is said, ~5 s at p90. Whether that blank reads as "broken" or "thinking" is a human call. |
| Is the transcription **accurate enough for this room**? | Needs ears, and real speech, and the accents of the people who will actually use it. |
| Is the **translation good enough to trust**? | Fluent nonsense scores well on every automatic metric. |
| Does **Windows loopback audio** work here? | It is marked experimental and fails differently per machine. |
| Does the **phone display** work on a real phone? | Real network, real screen lock, real Wi-Fi drop. |
| Does the **installer** work on a clean machine? | The one path that cannot be tested from source. |

---

## Before you start

**Hardware.** The **RTX 3070 machine**, quiet. Do *not* use the RTX PRO 6000
box: it runs a live inference farm with ~92 of 96 GB of VRAM already committed
to other people's work, so every VRAM reading is meaningless and every timing is
contended. The QVAC numbers already recorded in `spike/RESULTS-qvac.md` were
taken there and carry that caveat.

**A person, a microphone, and a phone.** Plus, ideally, a second person, so you
can test a real two-way conversation rather than a monologue.

**Every engine branch, in one session, in the same room.** Room acoustics, microphone
placement and how tired your voice is all move the numbers more than you would
like. Testing WhisperLiveKit on Tuesday and QVAC on Friday produces two sets of
numbers that cannot be compared. Set up once, test both, then take the rig down.

**A fixed passage to read.** `spike/samples/*.txt` holds the text used by the
scripted runs. Read the same passage aloud on every engine. Improvising gives
each engine different input and makes the accuracy comparison worthless.

---

## Part 0 — Scripted checks first (5 minutes, any machine)

Never burn rig time on something the laptop could have caught.

```powershell
npm install
npm test              # unit tests
npm run smoke         # renderer: preload bridge, AudioContext, worklet, captions, socket
node spike\profile.mjs --engine mock --wav spike\samples\fr_60s.wav --no-gpu
```

The mock run should report roughly **1.2 s** commit latency, **2.5 s**
translation latency and **1.3 s** translation lag — the lags it injects. If it
does not, the harness is wrong and nothing it says about a real engine can be
trusted. Fix that before going further.

No samples yet? `.\spike\make-sample.ps1 -Language fr -Seconds 60` builds them
from the voices Windows already has, with the transcript written alongside.

---

## Part 1 — The shell, on `main` with the mock engine

`main` ships no real engine, which is exactly what makes it the right place to
test everything that is not one. No GPU, no models, no waiting.

```powershell
git checkout main
npm install
npm start
```

- [ ] **Window opens**, status reads Ready, no error banner.
- [ ] **Mock engine is selected** and named in the settings/health panel.
- [ ] **Start** produces captions within a few seconds.
- [ ] **Committed text is solid, provisional text is dimmed** — the mock emits
      both, so this proves the renderer distinguishes them. Remember what this
      looks like: on QVAC you will never see the dimmed half again.
- [ ] **Both display fields work.** Set spoken ≠ display and confirm the
      translation line is what you read; set them equal and confirm you get the
      source.
- [ ] **Changing a dropdown mid-session** reconnects without killing audio.
- [ ] **Stop** ends cleanly; **Start** again works.

### Audio input

- [ ] **Microphone**: the level meter moves when you speak, and settles when you
      stop.
- [ ] **Device switching**: unplug and replug a USB mic, pick another input.
- [ ] **System loopback** (experimental, Windows-only): play a video, pick the
      loopback source, confirm captions follow it. **If it fails, the failure
      message must name VB-Cable / VoiceMeeter** rather than a stack trace.
      This is open question 3 and it is answered here, on the mock, with no GPU
      involved.

### Phone display

- [ ] **Phone → turn on sharing.** Windows asks about the firewall: allow it on
      **private** networks.
- [ ] **Scan the QR code** with a real phone on the same Wi-Fi. Captions appear.
- [ ] If several addresses are listed, the one on the phone's own Wi-Fi works and
      the virtual adapters (WSL, Hyper-V, VPN) are ranked last.
- [ ] **Tap the captions** — toolbar hides. `A−`/`A+` resize. `⛶` fullscreen.
- [ ] **The source/translation chip** flips between the two.
- [ ] **Lock the phone for a minute, unlock it.** The page reconnects by itself
      and catches up; it does not sit blank.
- [ ] **Walk out of Wi-Fi range and back.** Same.
- [ ] **The screen does not sleep** while captions are running.
- [ ] **Open the URL with one character of the key changed** → 403, and a page
      that explains it rather than a blank error.
- [ ] **Stop and restart sharing** → the old link stops working.

### Data, settings and shutdown

- [ ] Settings survive a restart.
- [ ] **Quit with a session running.** Then check Task Manager: no orphaned
      child process, and `nvidia-smi` shows no VRAM still held. This is the
      failure mode the whole shutdown path exists to prevent — check it on every
      engine, not just here.
- [ ] Closing the window with the phone server on shuts that down too.

### Packaging (once per release, on a clean machine)

- [ ] `npm run dist` builds `release\Rtranslate-<version>-x64.exe`.
- [ ] Install it on a machine that has never had this app. SmartScreen warns —
      builds are unsigned; "More info" → "Run anyway" is the expected path.
- [ ] The installed app launches and reaches Ready.
- [ ] **Auto-update round trip**: publish a release one patch version up, launch
      the old build, confirm it notices, downloads quietly, and **asks before
      restarting while a session is running**. It must never interrupt a live
      session. Offline must be silent, not an error.

---

## Part 2 — Engine acceptance

Do these per branch, before the comparison. The goal is only "does this engine
work at all here" — judgement comes later.

### 2A — `engine/whisperlivekit`

```powershell
git checkout engine/whisperlivekit
npm install
npm start          # then press Set up
```

**First-run setup builds a private Python environment: ~4 GB, ~20 minutes.**
Watch it rather than walking away the first time.

- [ ] Setup shows step-by-step progress and a live log.
- [ ] **It verifies CUDA before downloading 2.5 GB.** The resolver check should
      take about three seconds and reject a CPU-only torch. If it silently
      installs and *then* reports "PyTorch cannot see a CUDA device", the check
      has regressed — that check is the reason this step exists.
- [ ] **Close the setup panel mid-install.** It keeps running.
- [ ] **Cancel** actually stops it and leaves no half-built environment that
      reports itself as ready.
- [ ] After setup, the health panel shows Python, torch (+ CUDA build),
      whisperlivekit, the GPU and its VRAM.
- [ ] **First Start is slower** — model weights download then. Later starts are
      not.
- [ ] `node spike\profile.mjs --engine whisperlivekit --wav spike\samples\fr_60s.wav`
      completes and reports numbers. **This has never been run. It is the single
      most valuable missing measurement in the project** — QVAC has numbers and
      the incumbent does not, so there is currently nothing to compare against.

Then the open questions this engine exists to answer:

- [ ] **VRAM for `large-v3`** (open question 2). ÚFAL say ≥10 GB for the
      SimulStreaming path. Watch `nvidia-smi` during a real session. If the app
      pre-selected a smaller model, override it in Settings and find out where it
      actually breaks.
- [ ] **Native English translation** (open question 1). Tick *Use Whisper's
      native English translation*, run FR→EN, confirm it is faster than the NLLB
      path and still correct. Then run **FR→FR on the same server**: if it comes
      back in English, the paths do not coexist and the setting must force a
      restart. If FR→FR stays French, tick *Native and NLLB coexist* and the
      model reload on direction change disappears.
- [ ] **Is `medium` enough?** (open question 4). Run the same passage on
      `medium` and `large-v3`. This one needs ears; see the scoring sheet.

### 2B — `engine/qvac`

```powershell
git checkout engine/qvac
npm install        # ~5 min, 4.8 GB of node_modules (~805 MB is this platform's)
```

> **Known blocker — read before you start.** QVAC's model downloader crashes the
> Bare worker (`WorkerCrashedError`, code 143) part-way through any weights it
> has to fetch, leaving 0-byte files in `%USERPROFILE%\.qvac\models\`. It is the
> registry's hyperswarm P2P path; plain HTTPS to huggingface.co works fine from
> the same shell.
>
> **Work around it by seeding the cache by hand**, then loads take ~9 s:
>
> ```powershell
> cd $env:USERPROFILE\.qvac\models
> curl.exe -L -o "349b783b1e1a0ebc_ggml-base-q8_0.bin" `
>   "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base-q8_0.bin"
> curl.exe -L -o "dd850e3b81539045_ggml-silero-v5.1.2.bin" `
>   "https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v5.1.2.bin"
> ```
>
> Sizes must be exactly **81,768,585** and **885,098** bytes. A short file is a
> failed download, and QVAC will delete it and try (and crash) again.
>
> **Check whether this still happens on your network** — it may be specific to
> the office LAN, and if it is, this stops being a blocker. Either way, record
> the answer: it lands on the one thing QVAC was meant to win, which is setup.

- [ ] `npm start` reaches Ready with no setup step at all — no Python, no 4 GB.
- [ ] The health panel reports **Backend: vulkan**. On an NVIDIA card this is
      expected and correct: QVAC ships no CUDA build for Windows, whatever the
      driver advertises. It is not a misconfiguration and it is not slow.
- [ ] `node spike\profile.mjs --engine qvac --wav spike\samples\fr_60s.wav`
      completes and reports numbers.
- [ ] **FR→EN works and produces English.** This is QVAC's strong suit —
      Whisper's own translate task, no second model, and measured no slower than
      plain transcription.
- [ ] **EN→FR refuses, clearly.** The route note should say QVAC ships no
      English→French model and point at Settings. **This is expected behaviour,
      not a bug** — but confirm it *says so* rather than quietly handing you an
      English transcript and letting you believe it is a translation.
- [ ] **Quit with a session running**, then confirm no orphaned `bare` process
      and no VRAM still held.

Two traps worth knowing while testing, because both fail *silently*:

- If captions are empty but everything reports healthy, suspect `audio_format`.
  16-bit PCM read as 32-bit floats produces no error and no text.
- If the iterator produces nothing at all, suspect `emitVadEvents`.

Both are handled in `src/main/engines/qvac.js`; they are listed here so that an
empty screen sends you to the right place instead of to the microphone.

### 2C — `engine/r2t2`

Confucius4-R2T2 streams through **vLLM on Linux**, so on Windows it runs inside
**WSL2**. That is fine for testing and not yet something to hand a user — the
setup below is a developer's, not an installer's.

One-time, inside the WSL distro (Ubuntu by default):

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh          # if uv is missing
git clone --depth 1 https://github.com/netease-youdao/Confucius4-R2T2 ~/r2t2
cd ~/r2t2 && uv venv -p 3.12 .venv
uv pip install --python .venv/bin/python -e . "huggingface_hub[cli]"
.venv/bin/hf download netease-youdao/Confucius4-R2T2 --local-dir ~/models/Confucius4-R2T2
.venv/bin/hf download FireRedTeam/FireRedVAD --include "Stream-VAD/*" --local-dir ~/models/vad
```

About 4 GB of weights plus the vLLM environment. Then, on Windows:

```powershell
git checkout engine/r2t2
node spike\profile.mjs --engine r2t2 --wav spike\samples\fr_60s.wav --source fr --target fr
```

- [ ] The health panel reports **Runtime: WSL2 (Ubuntu) · vLLM**.
- [ ] **First start is slow** — vLLM compiles the model (measured: ~2 min cold,
      ~50 s once its compile cache is warm). The server warms up *before* it
      reports ready, so the first chunk of real speech is not the one that pays.
- [ ] **Words appear dimmed and turn solid a fraction of a second later.** That
      is the unfixed tail arriving as provisional text — the thing QVAC cannot do.
- [ ] **Change the spoken language mid-session.** It should be a reconnect with
      the model warm, as on WhisperLiveKit — not QVAC's model reload.
- [ ] **Any translating pair shows the source and says why.** R2T2 transcribes;
      it does not translate.
- [ ] **Quit with a session running, and also kill `wsl.exe` from Task Manager
      mid-session.** Then, in WSL: `pgrep -af 'server.py|EngineCore'` must print
      nothing, and `nvidia-smi` must show the ~6 GiB returned. Killing `wsl.exe`
      does *not* by itself end Linux processes — the server exits because its
      stdin closes. This was verified once; verify it on your machine.

It shares its GPU politely: the budget is absolute (`r2t2VramGiB`, default 6)
rather than a fraction of the card, and it refuses to start if that much is
not free.

---

## Part 3 — The comparison session

This is the part that decides. Same room, same day, same passage, every engine,
switching back and forth.

Run **each engine for at least four minutes of continuous speech** (see the
rule at the top), then repeat for each language pair you care about:

| Pair | whisperlivekit | qvac | r2t2 |
|---|---|---|---|
| FR → FR | NLLB not involved | plain transcription | streaming, word by word |
| EN → EN | " | " | " |
| FR → EN | native task *or* NLLB, per settings | native task — its best case | **shows French, says why** |
| EN → FR | NLLB | **expected to refuse** | **shows English, says why** |

### Where the numbers already stand

Measured 24 Sep 2026 with `spike/profile.mjs`, same SAPI samples, per word
against when each word was spoken. On the farm box, **not** the quiet 3070, so
treat the absolute numbers as provisional; the ratios are the finding.

| | r2t2 | qvac `base` | qvac `large-v3-turbo` | whisperlivekit |
|---|---|---|---|---|
| FR word latency, median / p90 | **0.49 / 0.73 s** | 3.05 / 5.07 s | 3.48 / 5.43 s | *not measured* |
| EN word latency, median / p90 | **0.46 / 0.71 s** | 2.68 / 4.99 s | 2.72 / 5.01 s | |
| 3.5 min FR, median | **0.48 s** | 2.97 s | 3.00 s | |
| FR WER, 60 s / 3.5 min | 1.3% / 1.2% | 8.7% / 6.4% | 1.3% / 1.2% | |
| EN WER | 2.5% | 2.5% | **0.0%** | |
| provisional text | **yes** | no | no | yes, per its design |
| drift, first → last third | none | none | none | |

Given its largest model QVAC is as accurate as R2T2 on this audio. The gap is
latency, about sixfold, and a bigger QVAC model does not close it — it is the
VAD-segment policy, not compute. **Synthetic speech is clean speech**: what these
numbers cannot tell you is how any of this holds up on real voices, which is
what Part 3 is for.

### While each run is going, watch for these specifically

**Time to first word.** Start talking; count until anything appears. Then keep
talking and see whether that number holds. So far it has held on every engine
measured — but that was on synthetic speech, which pauses tidily.

**The dimmed line.** On WhisperLiveKit and R2T2 you should see provisional text
appear and then firm up. On QVAC that line stays empty all session. Decide, while
watching, whether that feels like a system thinking or a system broken. **Write
down the answer before you look at any latency numbers**, because it is a
different kind of question and the numbers will bias you.

**Revisions.** Does committed text get rewritten after you have read it? A
little is fine; text that churns is unreadable no matter how fast it is. R2T2
is built never to revise committed words — check that it keeps that promise.

**Chunk size and rhythm.** Do captions arrive as a steady trickle you can read
along with, or in paragraph-sized lumps after a silence? This is where QVAC's
VAD segmentation shows up, and where R2T2's word-by-word commits should feel
most different.

**Language switching.** Change the spoken language mid-session with a stopwatch.
On WhisperLiveKit and R2T2 it is a socket reconnect and the model stays warm. On
QVAC the language is a model-load argument, so it is a full reload — time it,
and decide whether it is acceptable that a dropdown costs that.

**Accuracy, read back.** Compare against `spike/samples/*.txt`. Count the errors
that would actually confuse a reader, not every dropped accent. R2T2 was tuned
for Chinese and English: **French on real voices is its biggest open question.**

**VRAM and thermals.** `nvidia-smi` throughout. Note the peak, and whether a
long run drifts.

### Scoring sheet

Copy this into your notes and fill it in during the session, not after.

```
date ............................  room ...........................
machine ........................  speaker(s) .....................
passage ........................  minutes per run ................

                                   whisperlivekit    qvac            r2t2
model / settings ................  ..............  ..............  ..............
time to first word (start) ......  ..............  ..............  ..............
time to first word (4 min in) ...  ..............  ..............  ..............
provisional text present? .......  ..............  ..............  ..............
revisions after reading .........  ..............  ..............  ..............
arrival rhythm ..................  ..............  ..............  ..............
language switch cost ............  ..............  ..............  ..............
errors that confused a reader ...  ..............  ..............  ..............
translation trustworthy? ........  ..............  ..............  ..............
peak VRAM .......................  ..............  ..............  ..............
setup time, from nothing ........  ..............  ..............  ..............

Readable while someone talks?  (1-5)   ....            ....            ....
Would you run a workshop on it?  y/n   ....            ....            ....

What broke, and what surprised you:
```

The last two lines are the verdict. Everything above is evidence for them.

### Recording the result

Write the session up next to the numbers it belongs with:

- QVAC → `spike/RESULTS-qvac.md` on `engine/qvac`
- R2T2 → `spike/RESULTS-r2t2.md` on `engine/r2t2`
- WhisperLiveKit → `spike/RESULTS-whisperlivekit.md` on `engine/whisperlivekit`
- The verdict and why → the **Which engine** section of `README.md` on `main`

State the machine and the conditions. A number without them is not reusable, and
in six months you will not remember whether the farm was running.

---

## Known open questions this should close

| # | Question | Answered by |
|---|---|---|
| 1 | Can one WhisperLiveKit server serve both translation paths? | Part 2A |
| 2 | How much VRAM does `large-v3` really need? | Part 2A |
| 3 | Does Windows loopback audio work? | Part 1 (mock engine, no GPU needed) |
| 4 | Is `medium` good enough? | Part 3, scoring sheet |
| 5 | Is QVAC's lack of provisional text acceptable? | Part 3 |
| 6 | Does QVAC's downloader crash outside the office LAN? | Part 2B |
| 7 | Is R2T2's French good on **real** voices, not SAPI? | Part 3 — the biggest open question on R2T2 |
| 8 | Can R2T2 run on Windows without WSL? | **not yet buildable** — its llama.cpp extension ships Linux-only |
| 9 | Does Parakeet stream incrementally where whisper.cpp does not? | **not yet buildable** |

**Question 7 now matters most.** On synthetic speech R2T2 is as accurate as the
best QVAC model and six times faster to the screen. If that survives real French
voices, the remaining work is engineering (question 8, and translation), not
research. If it does not, QVAC `large-v3-turbo` is the accuracy fallback and the
open question becomes whether ~3 s is readable.
