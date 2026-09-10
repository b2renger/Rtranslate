/**
 * Audio capture: device enumeration, microphone or system loopback, and the
 * worklet that turns either into the PCM the server expects.
 */

const TARGET_RATE = 16000;

export class AudioPipe {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.source = null;
    this.running = false;
    this.info = null;
  }

  /**
   * Input devices, with labels. Labels are blank until permission has been
   * granted at least once, so the caller may want to start capture and
   * re-enumerate.
   */
  static async listDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((d) => d.kind === 'audioinput')
      .map((d, i) => ({
        deviceId: d.deviceId,
        label: d.label || `Input ${i + 1}`,
        isDefault: d.deviceId === 'default',
      }));
  }

  /** Ask once so enumerateDevices() returns real labels. */
  static async primePermissions() {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      return true;
    } catch {
      return false;
    }
  }

  async start({ deviceId = 'default', mode = 'mic', onPcm, onLevel, onInfo }) {
    if (this.running) await this.stop();

    this.stream = mode === 'system' ? await captureSystemAudio() : await captureMicrophone(deviceId);

    // Ask for a 16 kHz context so Chromium does the resampling with its own
    // (good) resampler. Where that is refused, the worklet resamples instead.
    try {
      this.ctx = new AudioContext({ sampleRate: TARGET_RATE, latencyHint: 'interactive' });
    } catch {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    await loadWorklet(this.ctx);

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pcm-downsampler', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { targetRate: TARGET_RATE, chunkMs: 40 },
    });

    this.node.port.onmessage = (event) => {
      const msg = event.data;
      if (msg.type === 'pcm') {
        onPcm?.(msg.buffer);
      } else if (msg.type === 'level') {
        onLevel?.(msg.rms);
      } else if (msg.type === 'ready') {
        this.info = msg;
        onInfo?.(msg);
      }
    };

    this.source.connect(this.node);
    // No connection to destination: we are capturing, not monitoring. Routing
    // this to the speakers would feed a live mic straight back into the room.

    this.running = true;
    return { sampleRate: this.ctx.sampleRate, mode };
  }

  async stop() {
    this.running = false;
    try {
      this.source?.disconnect();
    } catch { /* already gone */ }
    try {
      this.node?.port.close();
      this.node?.disconnect();
    } catch { /* already gone */ }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.ctx) {
      try {
        await this.ctx.close();
      } catch { /* already closed */ }
      this.ctx = null;
    }
    this.node = null;
    this.source = null;
  }
}

/**
 * Load the PCM worklet, with a fallback.
 *
 * `addModule` with a relative URL is the normal path and works from file://.
 * If a CSP or protocol quirk blocks it, fall back to fetching the source and
 * handing it over as a blob - which is why `blob:` is in the page's script-src.
 * Losing the worklet means losing all audio, so it is worth the second attempt.
 */
export async function loadWorklet(ctx) {
  const url = new URL('./pcm-worklet.js', import.meta.url);
  try {
    await ctx.audioWorklet.addModule(url);
    return 'direct';
  } catch (directErr) {
    try {
      const source = await (await fetch(url)).text();
      const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      try {
        await ctx.audioWorklet.addModule(blobUrl);
        return 'blob';
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
    } catch (blobErr) {
      throw new Error(
        `Could not load the audio worklet. Direct: ${directErr.message}. Blob: ${blobErr.message}`,
      );
    }
  }
}

async function captureMicrophone(deviceId) {
  // Every bit of built-in processing is off on purpose. AGC in particular
  // pumps the noise floor between phrases, which is exactly the signal the VAD
  // is trying to read.
  const constraints = {
    audio: {
      channelCount: { ideal: 1 },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      ...(deviceId && deviceId !== 'default' ? { deviceId: { exact: deviceId } } : {}),
    },
    video: false,
  };
  try {
    return await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    if (err.name === 'OverconstrainedError' && deviceId !== 'default') {
      // The device vanished between enumeration and capture - unplugged headset,
      // usually. Fall back rather than dead-ending the user.
      return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    }
    throw new Error(describeGumError(err));
  }
}

/**
 * System audio on Windows, via the main process's display-media handler asking
 * Chromium for loopback. Marked experimental in the UI for good reason: this
 * path has a long history of NotSupportedError and renderer crashes on Windows.
 */
async function captureSystemAudio() {
  const enabled = await window.rt.capture.enableLoopback();
  if (!enabled.ok) throw new Error(enabled.message || 'System audio capture is unavailable.');

  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
  } catch (err) {
    throw new Error(
      `System audio capture failed (${err.name}). Use a virtual cable such as VB-Cable or VoiceMeeter and pick it as an input device instead.`,
    );
  }

  const audio = stream.getAudioTracks();
  if (audio.length === 0) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error(
      'The capture returned no audio track. Windows loopback did not engage - use a virtual cable and pick it as an input device instead.',
    );
  }
  // We only ever wanted the audio; drop the screen capture immediately.
  stream.getVideoTracks().forEach((t) => {
    t.stop();
    stream.removeTrack(t);
  });
  return stream;
}

function describeGumError(err) {
  switch (err.name) {
    case 'NotAllowedError':
      return 'Microphone access was denied. Allow it in Windows privacy settings, then try again.';
    case 'NotFoundError':
      return 'No microphone was found.';
    case 'NotReadableError':
      return 'The microphone is in use by another application.';
    default:
      return `Could not open the microphone (${err.name}).`;
  }
}
