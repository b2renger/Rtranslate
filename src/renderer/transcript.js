/**
 * Caption state and rendering.
 *
 * Two things drive the design:
 *
 * 1. The server sends the FULL line list on every update in `full` mode, not a
 *    delta. So we replace state and re-render, and we keep DOM nodes keyed by
 *    line identity to avoid rebuilding the whole transcript on every frame.
 *
 * 2. Committed text and in-flight buffer are rendered differently on purpose.
 *    Simultaneous decoding revises itself; readers handle that correctly when
 *    they can see which words are still provisional, and find it maddening when
 *    they cannot.
 */

const SILENCE_SPEAKER = -2;

export class Transcript {
  constructor(container) {
    this.container = container;
    this.lines = [];
    this.buffer = '';
    this.display = { primaryField: 'text', secondaryField: null, bufferField: 'buffer_transcription' };
    this.nodes = new Map();
    this.autoScroll = true;

    container.addEventListener('scroll', () => {
      const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
      this.autoScroll = nearBottom;
    });
  }

  setDisplay(display) {
    this.display = { ...this.display, ...display };
    this.render();
  }

  clear() {
    this.lines = [];
    this.buffer = '';
    this.nodes.clear();
    this.container.replaceChildren();
  }

  /** @returns {boolean} true if the message carried transcript content */
  ingest(msg) {
    if (!msg || typeof msg !== 'object') return false;
    if (msg.type === 'config' || msg.type === 'ready_to_stop') return false;

    // We request `full` mode, so `lines` is the whole state. `new_lines` only
    // appears in diff mode - handled defensively in case that default changes.
    const incoming = msg.lines || msg.new_lines;
    if (Array.isArray(incoming)) {
      this.lines = incoming.filter((l) => l && l.speaker !== SILENCE_SPEAKER && (l.text || l.translation));
    }

    const bufferField = this.display.bufferField;
    const nextBuffer = (msg[bufferField] ?? msg.buffer_transcription ?? '') || '';
    this.buffer = String(nextBuffer);

    this.render();
    return true;
  }

  keyFor(line, index) {
    return `${line.speaker ?? 0}|${line.start ?? index}`;
  }

  render() {
    const { primaryField, secondaryField } = this.display;
    const seen = new Set();

    this.lines.forEach((line, index) => {
      const key = this.keyFor(line, index);
      seen.add(key);

      let node = this.nodes.get(key);
      if (!node) {
        node = buildLineNode();
        this.nodes.set(key, node);
        this.container.insertBefore(node.root, this.bufferNode || null);
      }

      const primary = line[primaryField] ?? '';
      // Native English mode has no `translation` field at all: the ASR output
      // IS the English. Falling back keeps the view populated either way.
      const primaryText = primary || line.text || '';
      node.primary.textContent = primaryText;

      if (secondaryField) {
        const secondary = line[secondaryField] ?? '';
        node.secondary.textContent = secondary;
        node.secondary.hidden = !secondary;
      } else {
        node.secondary.hidden = true;
      }

      node.meta.textContent = metaFor(line);
      node.meta.hidden = !node.meta.textContent;
    });

    // Drop nodes for lines the server pruned.
    for (const [key, node] of this.nodes) {
      if (!seen.has(key)) {
        node.root.remove();
        this.nodes.delete(key);
      }
    }

    this.renderBuffer();
    if (this.autoScroll) this.container.scrollTop = this.container.scrollHeight;
  }

  renderBuffer() {
    if (!this.bufferNode) {
      const el = document.createElement('p');
      el.className = 'line buffer';
      this.bufferNode = el;
      this.container.append(el);
    }
    this.bufferNode.textContent = this.buffer;
    this.bufferNode.hidden = !this.buffer;
    // Keep it last: the provisional tail always belongs at the end.
    this.container.append(this.bufferNode);
  }

  toPlainText({ includeSource = true } = {}) {
    const { primaryField, secondaryField } = this.display;
    return this.lines
      .map((line) => {
        const primary = line[primaryField] || line.text || '';
        if (includeSource && secondaryField && line[secondaryField]) {
          return `${line[secondaryField]}\n  -> ${primary}`;
        }
        return primary;
      })
      .filter(Boolean)
      .join('\n');
  }

  isEmpty() {
    return this.lines.length === 0 && !this.buffer;
  }
}

function buildLineNode() {
  const root = document.createElement('div');
  root.className = 'line-group';

  const meta = document.createElement('span');
  meta.className = 'line-meta';

  const secondary = document.createElement('p');
  secondary.className = 'line source';

  const primary = document.createElement('p');
  primary.className = 'line';

  root.append(meta, secondary, primary);
  return { root, meta, secondary, primary };
}

function metaFor(line) {
  const bits = [];
  if (line.detected_language) bits.push(String(line.detected_language).toUpperCase());
  if (typeof line.speaker === 'number' && line.speaker > 1) bits.push(`Speaker ${line.speaker}`);
  return bits.join(' · ');
}
