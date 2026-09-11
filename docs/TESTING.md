# Testing Rtranslate by hand

`npm test` and `spike/profile.mjs` already cover what a machine can check. This
document is for the rest — the things that decide whether this app is any good,
and which no script can answer.

It covers **both engine branches**, because the point of having two is to choose
between them, and a comparison run differently on each branch is not a
comparison.

---

## The one rule that matters

> **Run every live test for at least four minutes of continuous speech.**

Not thirty seconds. On the QVAC engine, measured commit latency climbs from
under a second to twenty-four seconds *over the course of a single run* as
unclosed audio backs up. A short test shows you the first number and hides the
one you will actually live with.

Four minutes is also roughly the shortest stretch that tells you whether reading
the captions is tolerable, which is the real question.

Everything else in this document is detail. This is the finding that a careless
test session would miss entirely.

---

## What only a human can answer

The profiler reports latency, throughput and VRAM. It cannot tell you:

| Question | Why a script can't |
|---|---|
| Are the captions **readable while someone talks**? | Latency is a number; legibility is a judgement about revisions, chunk size and rhythm. |
| Is the **absence of provisional text** tolerable? | QVAC emits nothing until a line is final. Whether a nine-second blank screen reads as "broken" or "thinking" is a human call. |
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

**Both branches, in one session, in the same room.** Room acoustics, microphone
placement and how tired your voice is all move the numbers more than you would
like. Testing WhisperLiveKit on Tuesday and QVAC on Friday produces two sets of
numbers that cannot be compared. Set up once, test both, then take the rig down.

**A fixed passage to read.** `spike/samples/*.txt` holds the text used by the
scripted runs. Read the same passage aloud on both engines. Improvising gives
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

---

## Part 3 — The comparison session

This is the part that decides. Same room, same day, same passage, both engines,
switching back and forth.

Run **each engine for at least four minutes of continuous speech** (see the
rule at the top), then repeat for each language pair you care about:

| Pair | whisperlivekit | qvac |
|---|---|---|
| FR → FR | NLLB not involved | plain transcription |
| EN → EN | " | " |
| FR → EN | native task *or* NLLB, per settings | native task — its best case |
| EN → FR | NLLB | **expected to refuse** |

### While each run is going, watch for these specifically

**Time to first word.** Start talking; count until anything appears. Then keep
talking and see whether that number holds. On QVAC it will not.

**The dimmed line.** On WhisperLiveKit you should see provisional text appear
and then firm up. On QVAC that line stays empty all session. Decide, while
watching, whether that feels like a system thinking or a system broken. **Write
down the answer before you look at any latency numbers**, because it is a
different kind of question and the numbers will bias you.

**Revisions.** Does committed text get rewritten after you have read it? A
little is fine; text that churns is unreadable no matter how fast it is.

**Chunk size and rhythm.** Do captions arrive as a steady trickle you can read
along with, or in paragraph-sized lumps after a silence? This is where QVAC's
VAD segmentation shows up in a way no metric captures.

**Language switching.** Change the spoken language mid-session with a stopwatch.
On WhisperLiveKit it is a socket reconnect and the model stays warm. On QVAC the
language is a model-load argument, so it is a full reload — time it, and decide
whether it is acceptable that a dropdown costs that.

**Accuracy, read back.** Compare against `spike/samples/*.txt`. Count the errors
that would actually confuse a reader, not every dropped accent.

**VRAM and thermals.** `nvidia-smi` throughout. Note the peak, and whether a
long run drifts.

### Scoring sheet

Copy this into your notes and fill it in during the session, not after.

```
date ............................  room ...........................
machine ........................  speaker(s) .....................
passage ........................  minutes per run ................

                                    whisperlivekit        qvac
model / settings ................  ..................  ..................
time to first word (start) ......  ..................  ..................
time to first word (4 min in) ...  ..................  ..................
provisional text present? .......  ..................  ..................
revisions after reading .........  ..................  ..................
arrival rhythm ..................  ..................  ..................
language switch cost ............  ..................  ..................
errors that confused a reader ...  ..................  ..................
translation trustworthy? ........  ..................  ..................
peak VRAM .......................  ..................  ..................
setup time, from nothing ........  ..................  ..................

Readable while someone talks?  (1-5)   ....            ....
Would you run a workshop on it?  y/n   ....            ....

What broke, and what surprised you:
```

The last two lines are the verdict. Everything above is evidence for them.

### Recording the result

Write the session up next to the numbers it belongs with:

- QVAC → `spike/RESULTS-qvac.md` on `engine/qvac`
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
| 7 | Does Parakeet stream incrementally where whisper.cpp does not? | **not yet buildable** — see below |

**Question 7 is the highest-value experiment left on the QVAC side.** Parakeet
CTC/Unified are streaming-native, unlike whisper.cpp's VAD chunking, and would
address the one thing measurably wrong with QVAC. The engine does not wire them
up yet, so this needs code before it needs a tester.
