/**
 * The profiler's summary maths.
 *
 * These stats are the entire basis for choosing an engine, and a wrong number
 * here does not crash anything - it just makes one engine look better than it
 * is. So the arithmetic is tested against hand-built records with known answers.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

let profile;
test.before(async () => {
  profile = await import('../spike/profile.mjs');
});

/** Build a record shaped exactly as the live client produces one. */
function record({ commits, audioSentAt = 30, audioSeconds = 30, readyToStopAt = null }) {
  return {
    audioSeconds,
    audioSentAt,
    commits,
    gpuSamples: [],
    events: [],
    warnings: [],
    firstPartialAt: null,
    firstCommitAt: null,
    readyToStopAt,
  };
}

const commit = (index, kind, wallAt, audioEnd) => ({
  index, kind, wallAt, audioEnd, latency: wallAt - audioEnd,
});

test('timestamps parse in both of the formats engines emit', () => {
  assert.equal(profile.parseTimestamp('0:00:03'), 3);
  assert.equal(profile.parseTimestamp('0:00:03.250000'), 3.25);
  assert.equal(profile.parseTimestamp('1:02:03'), 3723);
  assert.equal(profile.parseTimestamp(4.5), 4.5);
  assert.equal(profile.parseTimestamp(null), null);
});

test('percentiles are taken from sorted values', () => {
  const values = [5, 1, 4, 2, 3];
  assert.equal(profile.percentile(values, 50), 3);
  assert.equal(profile.percentile(values, 90), 5);
  assert.equal(profile.percentile([], 50), null);
});

test('commit latency is measured against the audio timeline, not arrival order', () => {
  const r = profile.summarise(record({
    commits: [
      commit(0, 'text', 3.2, 2),      // 1.2 s behind
      commit(1, 'text', 5.2, 4),      // 1.2 s
      commit(2, 'text', 7.4, 6),      // 1.4 s
    ],
  }));
  assert.equal(r.summary.textLatency.median, 1.2);
  assert.equal(r.summary.textLatency.max, 1.4);
  assert.equal(r.summary.commitsDuringAudio, 3);
});

test('the flush after end-of-audio is counted apart from live latency', () => {
  // Everything past audioSentAt arrives in one dump. Folding it into the
  // latency stats would report a number no listener ever experiences.
  const r = profile.summarise(record({
    audioSentAt: 10,
    commits: [
      commit(0, 'text', 3.2, 2),
      commit(1, 'text', 5.2, 4),
      commit(2, 'text', 10.5, 6),     // flushed
      commit(3, 'text', 10.5, 8),     // flushed
      commit(4, 'text', 10.5, 10),    // flushed
    ],
  }));
  assert.equal(r.summary.commitsDuringAudio, 2);
  assert.equal(r.summary.commitsAfterAudio, 3);
  assert.equal(r.summary.textLatency.median, 1.2, 'flushed commits must not enter the median');
});

test('translation lag ignores the flush, where text and translation arrive together', () => {
  // The regression this file exists for. During the flush every line's text and
  // translation land in the same message, so each pair has a lag of zero. With
  // enough flushed lines that dragged the median to 0 and reported instant
  // translation for an engine that was 1.3 s behind.
  const commits = [
    commit(0, 'text', 3.2, 2), commit(0, 'translation', 4.5, 2),   // 1.3 s behind
    commit(1, 'text', 5.2, 4), commit(1, 'translation', 6.5, 4),   // 1.3 s
  ];
  for (let i = 2; i < 20; i++) {
    commits.push(commit(i, 'text', 10.5, i * 2), commit(i, 'translation', 10.5, i * 2));
  }

  const r = profile.summarise(record({ audioSentAt: 10, commits }));
  assert.equal(
    r.summary.translationLagMedian, 1.3,
    'eighteen zero-lag flushed pairs must not outvote the two real ones',
  );
});

test('a run with no translation reports null rather than zero', () => {
  const r = profile.summarise(record({
    commits: [commit(0, 'text', 3.2, 2), commit(1, 'text', 5.2, 4)],
  }));
  assert.equal(r.summary.translationLatency.median, null);
  assert.equal(r.summary.translationLagMedian, null);
});

test('flush time is measured from end-of-audio, not from the start', () => {
  const r = profile.summarise(record({
    audioSentAt: 30,
    readyToStopAt: 31500,             // ms since start, as the client records it
    commits: [commit(0, 'text', 3.2, 2)],
  }));
  assert.equal(r.summary.flushSec, 1.5);
});

test('language codes map to the NLLB names the contract asks for', () => {
  assert.equal(profile.nllbCode('fr'), 'fra_Latn');
  assert.equal(profile.nllbCode('en'), 'eng_Latn');
});
