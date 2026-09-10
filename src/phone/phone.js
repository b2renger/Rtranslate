/* Rtranslate phone caption viewer.
 *
 * Deliberately plain: no modules, no build step, no dependencies. It has to
 * work first time on whatever browser happens to be on the phone, over a LAN
 * with no internet, and keep working while the screen dims and the Wi-Fi
 * wobbles. EventSource handles the reconnecting; everything else here is about
 * staying readable. */

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var el = {
    bar: $('bar'),
    dot: $('dot'),
    status: $('status'),
    captions: $('captions'),
    hint: $('hint'),
    toast: $('toast'),
    btnLang: $('btn-lang'),
    btnSmaller: $('btn-smaller'),
    btnBigger: $('btn-bigger'),
    btnFull: $('btn-full'),
  };

  var state = {
    key: new URLSearchParams(location.search).get('k') || '',
    showTranslation: true,
    hasTranslation: false,
    size: Number(localStorage.getItem('wl.size') || 30),
    autoScroll: true,
    lines: [],
    buffer: '',
    connected: false,
    wakeLock: null,
    barTimer: null,
  };

  // ------------------------------------------------------------- rendering

  function applySize() {
    document.documentElement.style.setProperty('--size', state.size + 'px');
    localStorage.setItem('wl.size', String(state.size));
  }

  function pick(line) {
    if (state.hasTranslation && state.showTranslation) {
      return line.translation || line.text || '';
    }
    return line.text || line.translation || '';
  }

  function render() {
    var frag = document.createDocumentFragment();

    for (var i = 0; i < state.lines.length; i++) {
      var content = pick(state.lines[i]);
      if (!content) continue;
      var p = document.createElement('p');
      p.className = 'line';
      p.textContent = content;
      frag.appendChild(p);
    }

    if (state.buffer) {
      var b = document.createElement('p');
      b.className = 'line buffer';
      b.textContent = state.buffer;
      frag.appendChild(b);
    }

    el.captions.replaceChildren(frag);
    el.hint.hidden = state.lines.length > 0 || Boolean(state.buffer);

    if (state.autoScroll) {
      el.captions.scrollTop = el.captions.scrollHeight;
    }
  }

  el.captions.addEventListener('scroll', function () {
    var distance = el.captions.scrollHeight - el.captions.scrollTop - el.captions.clientHeight;
    // Generous threshold: the bottom padding is deep, and a reader who scrolled
    // back to re-read something should not be yanked forward.
    state.autoScroll = distance < 200;
  });

  // ------------------------------------------------------------ connection

  function setStatus(kind, text) {
    el.dot.className = 'dot' + (kind === 'live' ? ' live' : kind === 'lost' ? ' lost' : '');
    el.status.textContent = text;
  }

  function connect() {
    if (!state.key) {
      setStatus('lost', 'No access key');
      el.hint.textContent = 'This link is missing its access key. Re-scan the code shown on the desktop.';
      el.hint.hidden = false;
      return;
    }

    var source = new EventSource('/events?k=' + encodeURIComponent(state.key));

    source.onopen = function () {
      state.connected = true;
      setStatus('live', 'Connected');
    };

    source.onmessage = function (event) {
      var payload;
      try { payload = JSON.parse(event.data); } catch (e) { return; }

      state.lines = payload.lines || [];
      state.hasTranslation = Boolean(payload.hasTranslation);
      state.buffer = state.hasTranslation && state.showTranslation
        ? (payload.bufferTranslation || '')
        : (payload.bufferText || '');

      updateLangButton(payload);
      setStatus('live', payload.status || 'Connected');
      render();
    };

    source.addEventListener('bye', function () {
      setStatus('lost', 'Desktop stopped sharing');
      source.close();
    });

    source.onerror = function () {
      // EventSource reconnects on its own; say so rather than looking broken.
      if (state.connected) setStatus('lost', 'Reconnecting…');
      else setStatus('lost', 'Cannot reach the desktop');
      state.connected = false;
    };
  }

  function updateLangButton(payload) {
    if (!state.hasTranslation) {
      el.btnLang.hidden = true;
      return;
    }
    el.btnLang.hidden = false;
    var sourceLabel = (payload.sourceLabel || 'source').toUpperCase();
    var targetLabel = (payload.targetLabel || 'translation').toUpperCase();
    el.btnLang.textContent = state.showTranslation ? targetLabel : sourceLabel;
    el.btnLang.classList.toggle('on', state.showTranslation);
  }

  // -------------------------------------------------------------- controls

  el.btnLang.addEventListener('click', function () {
    state.showTranslation = !state.showTranslation;
    el.btnLang.classList.toggle('on', state.showTranslation);
    toast(state.showTranslation ? 'Showing translation' : 'Showing what was spoken');
    render();
  });

  el.btnSmaller.addEventListener('click', function () {
    state.size = Math.max(16, state.size - 3);
    applySize();
  });

  el.btnBigger.addEventListener('click', function () {
    state.size = Math.min(72, state.size + 3);
    applySize();
  });

  el.btnFull.addEventListener('click', function () {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else if (document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(function () {
        toast('Fullscreen was refused by the browser');
      });
    }
  });

  // Tap the captions to hide the bar; tap again to bring it back. The bar also
  // fades on its own so a phone left alone becomes a clean caption display.
  el.captions.addEventListener('click', function () {
    el.bar.classList.toggle('hidden');
    resetBarTimer();
  });

  function resetBarTimer() {
    clearTimeout(state.barTimer);
    if (el.bar.classList.contains('hidden')) return;
    state.barTimer = setTimeout(function () {
      el.bar.classList.add('hidden');
    }, 6000);
  }

  // ------------------------------------------------------------- wake lock

  async function keepAwake() {
    if (!('wakeLock' in navigator)) return;
    try {
      state.wakeLock = await navigator.wakeLock.request('screen');
      state.wakeLock.addEventListener('release', function () { state.wakeLock = null; });
    } catch (e) {
      /* denied, or the tab is not visible - retried on visibilitychange */
    }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') {
      if (!state.wakeLock) keepAwake();
      resetBarTimer();
    }
  });

  // ----------------------------------------------------------------- toast

  var toastTimer = null;
  function toast(message) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.hidden = true; }, 2200);
  }

  // ------------------------------------------------------------------ init

  applySize();
  connect();
  keepAwake();
  resetBarTimer();
})();
