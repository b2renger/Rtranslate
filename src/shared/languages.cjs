/**
 * Canonical language table - the single source of truth for language codes.
 *
 * This exists because the three code systems in play disagree with each other,
 * and forwarding whatever the OS locale hands us is how that bites. Whisper
 * wants ISO 639-1; NLLB-200 wants its own FLORES-style tags.
 *
 * Main reads this and hands it to the renderer over IPC, so dropdowns and server
 * flags can never drift apart.
 */

const LANGUAGES = [
  { id: 'fr', label: 'Français', short: 'FR', whisper: 'fr', nllb: 'fra_Latn' },
  { id: 'en', label: 'English', short: 'EN', whisper: 'en', nllb: 'eng_Latn' },
];

/**
 * Auto-detection is a *source* option only. Whisper's LID handles FR/EN well -
 * the two are acoustically and orthographically distant - but Phase 0 has not
 * confirmed it holds on short utterances, so the UI marks it as such.
 */
const AUTO_SOURCE = {
  id: 'auto',
  label: 'Auto (FR / EN)',
  short: 'AUTO',
  whisper: 'auto',
  nllb: null,
  experimental: true,
};

function byId(id) {
  if (id === 'auto') return AUTO_SOURCE;
  return LANGUAGES.find((l) => l.id === id) || null;
}

module.exports = { LANGUAGES, AUTO_SOURCE, byId };
