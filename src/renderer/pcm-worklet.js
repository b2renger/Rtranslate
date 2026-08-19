/**
 * AudioWorklet: microphone/system audio -> 16 kHz mono signed 16-bit PCM.
 *
 * That is exactly the format whisperlivekit-server wants under --pcm-input, so
 * nothing downstream has to decode anything, and no FFmpeg binary ever has to
 * ship. On Windows that is the single most valuable dependency to not have.
 *
 * The AudioContext is created at 16 kHz where the browser allows it, in which
 * case `ratio` is 1 and this is a pure format conversion. Where it is not
 * allowed we resample here, with linear interpolation carried correctly across
 * the 128-frame quantum boundary - hence `prev` and `frac`.
 */

const DEFAULT_TARGET_RATE = 16000;
const DEFAULT_CHUNK_MS = 40; // 640 samples, 1280 bytes - one WebSocket frame

class PCMDownsampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = (options && options.processorOptions) || {};
    this.targetRate = opts.targetRate || DEFAULT_TARGET_RATE;
    this.ratio = sampleRate / this.targetRate;
    this.chunkSize = Math.round((this.targetRate * (opts.chunkMs || DEFAULT_CHUNK_MS)) / 1000);

    this.out = new Int16Array(this.chunkSize);
    this.outLen = 0;

    this.frac = 0;   // read position carried between quanta
    this.prev = 0;   // last input sample of the previous quantum

    this.levelSum = 0;
    this.levelCount = 0;
    this.lastMeterAt = 0;

    this.port.postMessage({ type: 'ready', inputRate: sampleRate, targetRate: this.targetRate, ratio: this.ratio });
  }

  emit(sample) {
    const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
    this.out[this.outLen++] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    if (this.outLen === this.chunkSize) {
      const copy = this.out.slice(0);
      this.port.postMessage({ type: 'pcm', buffer: copy.buffer }, [copy.buffer]);
      this.outLen = 0;
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0 || !input[0] || input[0].length === 0) return true;

    const frames = input[0].length;

    // Downmix to mono. A stereo system-audio capture is the common case here.
    let mono;
    if (input.length === 1) {
      mono = input[0];
    } else {
      mono = new Float32Array(frames);
      for (let c = 0; c < input.length; c++) {
        const channel = input[c];
        for (let i = 0; i < frames; i++) mono[i] += channel[i];
      }
      for (let i = 0; i < frames; i++) mono[i] /= input.length;
    }

    // Level meter, so a user can see audio arriving before blaming the ASR.
    let sum = 0;
    for (let i = 0; i < frames; i++) sum += mono[i] * mono[i];
    this.levelSum += sum;
    this.levelCount += frames;
    if (currentTime - this.lastMeterAt > 0.05) {
      this.port.postMessage({ type: 'level', rms: Math.sqrt(this.levelSum / Math.max(1, this.levelCount)) });
      this.levelSum = 0;
      this.levelCount = 0;
      this.lastMeterAt = currentTime;
    }

    let pos = this.frac;
    while (pos < frames - 1) {
      const i = Math.floor(pos);
      const t = pos - i;
      const a = i < 0 ? this.prev : mono[i];
      const b = mono[i + 1];
      this.emit(a + (b - a) * t);
      pos += this.ratio;
    }
    this.frac = pos - frames;
    this.prev = mono[frames - 1];

    return true;
  }
}

registerProcessor('pcm-downsampler', PCMDownsampler);
