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

// ---------------------------------------------------------------------------
// per-word timing
//
// The measure that decides between an engine that commits word by word and one
// that commits whole sentences. Line-level latency cannot tell them apart - it
// times each line's first word - so these tests pin the definitions down.
// ---------------------------------------------------------------------------

test('tokenise splits elisions and drops punctuation, but keeps accents', () => {
  assert.deepEqual(profile.tokenize("Merci d'être venus, ce matin !"),
    ['merci', 'd', 'être', 'venus', 'ce', 'matin']);
  assert.deepEqual(profile.tokenize('C’est « exactement » ça…'),
    ['c', 'est', 'exactement', 'ça']);
  // venu / venus is a real error a reader would see; normalising accents or
  // plurals away would hide it.
  assert.notDeepEqual(profile.tokenize('venu'), profile.tokenize('venus'));
});

test('alignment counts substitutions, deletions and insertions', () => {
  const ref = ['le', 'chat', 'dort', 'ici'];
  assert.deepEqual(profile.align(ref, ref).hits.length, 4);

  const sub = profile.align(ref, ['le', 'chien', 'dort', 'ici']);
  assert.equal(sub.sub, 1);
  assert.equal(sub.hits.length, 3);

  const del = profile.align(ref, ['le', 'dort', 'ici']);
  assert.equal(del.del, 1);

  const ins = profile.align(ref, ['le', 'gros', 'chat', 'dort', 'ici']);
  assert.equal(ins.ins, 1);
  assert.deepEqual(ins.hits.map(([r]) => r), [0, 1, 2, 3], 'every reference word still found');
});

test('a word is credited from when it stopped changing, not when it first appeared', () => {
  // An engine that shows "chat", revises it to "chien", then back, has not
  // delivered "chat" at the first sighting.
  const t = new profile.WordTracker();
  t.update('le chat', 1.0);
  t.update('le chien', 2.0);
  t.update('le chat dort', 3.0);
  assert.deepEqual(t.tokens, ['le', 'chat', 'dort']);
  assert.deepEqual(t.since, [1.0, 3.0, 3.0]);
});

test('text that is withdrawn is forgotten', () => {
  const t = new profile.WordTracker();
  t.update('le chat dort', 1.0);
  t.update('le chat', 2.0);
  assert.deepEqual(t.tokens, ['le', 'chat']);
  assert.equal(t.since.length, 2);
});

test('word latency runs from when each word finished being spoken', () => {
  // Three words spoken at 0, 1 and 2 s in a 3 s clip; each committed 0.5 s
  // after it ended.
  const words = [{ w: 'un', t: 0 }, { w: 'deux', t: 1 }, { w: 'trois', t: 2 }];
  const t = new profile.WordTracker();
  t.update('un', 1.5);
  t.update('un deux', 2.5);
  t.update('un deux trois', 3.5);

  const s = profile.wordStats(words, t, 3, 10);
  assert.equal(s.latency.median, 0.5);
  assert.equal(s.latency.max, 0.5);
  assert.equal(s.wer, 0);
  assert.equal(s.matched, 3);
});

test('a sentence-at-once engine and a word-by-word engine are told apart', () => {
  // Same audio, same final text. One commits each word as it ends; the other
  // commits the whole sentence at the end. Line-level timing sees one line
  // arriving in each case; per-word timing must not.
  const words = ['a', 'b', 'c', 'd', 'e', 'f'].map((w, i) => ({ w, t: i }));

  const trickle = new profile.WordTracker();
  words.forEach((_, i) => trickle.update(words.slice(0, i + 1).map((x) => x.w).join(' '), i + 1.3));

  const lump = new profile.WordTracker();
  lump.update(words.map((x) => x.w).join(' '), 6.3);

  const a = profile.wordStats(words, trickle, 6, 60);
  const b = profile.wordStats(words, lump, 6, 60);
  assert.equal(a.latency.median, 0.3);
  assert.ok(b.latency.median > 2, `sentence-at-once should look slow per word, got ${b.latency.median}`);
});

test('latency drift is reported early against late', () => {
  // The backlog pattern measured on QVAC: fine at the start, far behind by the
  // end. This is what the four-minute rule exists to catch.
  const words = Array.from({ length: 30 }, (_, i) => ({ w: `w${i}`, t: i }));
  const t = new profile.WordTracker();
  const said = [];
  words.forEach((w, i) => {
    said.push(w.w);
    t.update(said.join(' '), i + 1 + i * 0.2);           // lag grows 0.2 s per word
  });
  const s = profile.wordStats(words, t, 30, 100);
  assert.ok(s.drift.lateMedian > s.drift.earlyMedian + 3,
    `expected drift, got early ${s.drift.earlyMedian} late ${s.drift.lateMedian}`);
});

test('words delivered only in the end-of-audio flush are counted apart', () => {
  const words = [{ w: 'un', t: 0 }, { w: 'deux', t: 1 }];
  const t = new profile.WordTracker();
  t.update('un', 1.2);
  t.update('un deux', 9);                                 // after audio was sent at 5 s
  const s = profile.wordStats(words, t, 2, 5);
  assert.equal(s.flushed, 1);
  assert.equal(s.latency.median, 0.2, 'the flushed word must not enter the median');
});

test('reference words that tokenise to several tokens share their interval', () => {
  const ref = profile.referenceTokens([{ w: "d'être", t: 1 }, { w: 'venus', t: 2 }], 3);
  assert.deepEqual(ref.map((r) => [r.token, r.start, r.end]),
    [['d', 1, 2], ['être', 1, 2], ['venus', 2, 3]]);
});
