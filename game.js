/* Connect: two puzzles a day, three clues to one answer.
 * Puzzles come from puzzles.js (built by tools/build_puzzles.py). Every step of play is
 * logged as an anonymous event to a Google Sheet (see SETUP_TRACKING.md). */
(() => {
  'use strict';

  const CONFIG = {
    // Google Apps Script web-app URL that appends events to the tracking sheet.
    // Empty: events are only kept in the page (window.__connectEvents) for testing.
    LOG_URL: '',
    POINTS: [15, 10, 5],
    OPTION_POINTS: 2,
  };
  const KEY = 'three-clues-one-answer';            // must match tools/build_puzzles.py
  const EMOJI = { 1: '🟩', 2: '🟨', 3: '🟧', 4: '🟦', 0: '⬛' };
  const HOW = { 1: 'Clue 1', 2: 'Clue 2', 3: 'Clue 3', 4: 'Options', 0: 'Missed' };

  const params = new URLSearchParams(location.search);
  const PREVIEW = params.has('preview');           // editor preview: ?preview&day=2
  const FROM = (params.get('from') || params.get('utm_source') || '').slice(0, 40);

  // ---------- small helpers ----------
  const $ = (s) => document.querySelector(s);
  function el(tag, props = {}, kids = []) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v);
    }
    for (const c of [].concat(kids)) if (c != null && c !== false) e.append(c);
    return e;
  }
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };
  function randomId(n) {
    const a = new Uint8Array(n);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.from(a, (b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');
  }
  function localDate(d = new Date()) {
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function prettyDate(iso, opts = { weekday: 'long', day: 'numeric', month: 'long' }) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-GB', opts);
  }
  function unscramble(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) ^ KEY.charCodeAt(i % KEY.length);
    return JSON.parse(new TextDecoder().decode(bytes));
  }

  // ---------- answer matching ----------
  function norm(s) {
    return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
      .replace(/^(the|a|an) /, '').trim();
  }
  function lev(a, b) {
    if (Math.abs(a.length - b.length) > 2) return 3;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[b.length];
  }
  function isRight(guess, set) {
    const g = norm(guess);
    if (!g) return false;
    for (const raw of [set.answer, ...set.accept]) {
      const a = norm(raw);
      if (!a) continue;
      if (g === a || g.replace(/ /g, '') === a.replace(/ /g, '')) return true;
      if (a.length >= 5 && lev(g, a) <= (a.length >= 9 ? 2 : 1)) return true;
      if (a.length >= 6 && ` ${g} `.includes(` ${a} `)) return true;   // "kipling's jungle book"
    }
    return false;
  }

  // ---------- the day's puzzles ----------
  const DAYS = window.CONNECT_DAYS || [];
  const today = localDate();
  let dayIdx = DAYS.findIndex((d) => d.date === today);
  if (PREVIEW && params.get('day')) dayIdx = Math.min(DAYS.length, Math.max(1, +params.get('day'))) - 1;
  const DAY = dayIdx >= 0 ? DAYS[dayIdx] : null;
  const SETS = DAY ? unscramble(DAY.data) : [];
  const MAX = SETS.length * CONFIG.POINTS[0];
  const STATE_KEY = DAY ? `connect_day_${PREVIEW ? 'preview_' : ''}${DAY.date}` : null;
  if (PREVIEW && params.has('reset') && STATE_KEY) store.set(STATE_KEY, null);
  let state = (STATE_KEY && store.get(STATE_KEY, null)) || { setIdx: 0, clue: 1, optionsShown: false, guesses: [], results: [], started: false, done: false };
  const save = () => STATE_KEY && store.set(STATE_KEY, state);

  // ---------- player and session ----------
  const player = store.get('connect_player', null) || randomId(10);
  store.set('connect_player', player);
  const visitN = (store.get('connect_visits', 0) || 0) + 1;
  store.set('connect_visits', visitN);
  if (!store.get('connect_first_day', null)) store.set('connect_first_day', today);
  const session = randomId(8);
  const t0 = performance.now();
  let tClue = performance.now();       // when the current clue appeared
  let tSet = performance.now();        // when the current puzzle started (this page load)

  const ua = navigator.userAgent || '';
  const device = /iPad|Tablet/i.test(ua) ? 'tablet' : /Mobi|Android|iPhone/i.test(ua) ? 'mobile' : 'desktop';
  const os = /iPhone|iPad|iPod/i.test(ua) ? 'iOS' : /Android/i.test(ua) ? 'Android' : /Windows/i.test(ua) ? 'Windows'
    : /Mac OS X|Macintosh/i.test(ua) ? 'Mac' : /Linux/i.test(ua) ? 'Linux' : 'other';
  const browser = /FBAN|FBAV|Instagram|WhatsApp|Line\//i.test(ua) ? 'in-app' : /Edg\//.test(ua) ? 'Edge'
    : /SamsungBrowser/.test(ua) ? 'Samsung' : /Firefox|FxiOS/.test(ua) ? 'Firefox' : /Chrome|CriOS/.test(ua) ? 'Chrome'
    : /Safari/.test(ua) ? 'Safari' : 'other';
  let refHost = '';
  try { refHost = document.referrer ? new URL(document.referrer).hostname : ''; } catch (e) { /* ignore */ }
  let tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { /* ignore */ }

  window.__connectEvents = [];
  function log(event, data = {}) {
    const set = SETS[state.setIdx];
    const payload = {
      app: 'connect', v: 1, ts: new Date().toISOString(), player, session, visit_n: visitN, event,
      day: DAY ? DAY.date : '', day_n: dayIdx + 1, preview: PREVIEW ? 1 : 0,
      set_no: set ? state.setIdx + 1 : '', set_id: set ? set.id : '',
      clue: set ? state.clue : '', ms_session: Math.round(performance.now() - t0),
      from: FROM, ref: refHost, tz, lang: navigator.language || '', device, os, browser,
      screen: `${screen.width}x${screen.height}`, ...data,
    };
    window.__connectEvents.push(payload);
    if (!CONFIG.LOG_URL) return;
    const body = JSON.stringify(payload);
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(CONFIG.LOG_URL, new Blob([body], { type: 'text/plain' }))) return;
    } catch (e) { /* fall through */ }
    try { fetch(CONFIG.LOG_URL, { method: 'POST', mode: 'no-cors', keepalive: true, headers: { 'Content-Type': 'text/plain' }, body }); } catch (e) { /* ignore */ }
  }

  // ---------- screens ----------
  const app = $('#app');
  function screen_(...kids) { app.replaceChildren(...kids); window.scrollTo(0, 0); }

  function renderNoPuzzle() {
    const first = DAYS[0] && DAYS[0].date;
    const last = DAYS[DAYS.length - 1] && DAYS[DAYS.length - 1].date;
    const msg = first && today < first
      ? `The first puzzles go live on ${prettyDate(first)}. See you then!`
      : 'New puzzles are on their way. Check back soon!';
    screen_(el('div', { class: 'hero' }, [
      el('h1', { text: 'Three clues. One answer.' }),
      el('p', { class: 'tagline', text: msg }),
    ]));
    log('open', { status: first && today < first ? 'before_start' : 'after_end', last_day: last || '' });
  }

  function renderLanding() {
    const going = state.started && !state.done;
    screen_(el('div', { class: 'hero' }, [
      el('span', { class: 'date-chip', text: `${prettyDate(DAY.date)} · Day ${dayIdx + 1}` }),
      el('h1', { text: 'Three clues. One answer.' }),
      el('p', { class: 'tagline', text: `${cap(['', 'one', 'two', 'three', 'four'][SETS.length] || String(SETS.length))} puzzles today. In each one, three clues point to the same thing. Name it.` }),
    ]), el('ol', { class: 'rules' }, [
      el('li', { text: "Read clue 1 and type your guess. Spelling needn't be perfect." }),
      el('li', { text: 'Wrong guess? The next clue opens and you guess again.' }),
      el('li', {}, ['Fewer clues, more points: ', el('b', { text: '15' }), ', ', el('b', { text: '10' }), ' or ', el('b', { text: '5' }), '.']),
      el('li', {}, ['Still stuck after clue 3? Pick from four choices for ', el('b', { text: '2' }), ' points.']),
    ]), el('button', {
      class: 'btn primary block', text: going ? 'Carry on' : "Play today's puzzles",
      onclick: () => {
        if (!state.started) { state.started = true; save(); log('start'); }
        tSet = performance.now(); tClue = performance.now();
        renderSet();
      },
    }));
  }

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function shuffledOptions(set) {
    // Same order every time for a given puzzle, so a reload doesn't reshuffle.
    const all = [set.answer, ...set.options];
    let h = 0;
    for (const ch of set.id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    for (let i = all.length - 1; i > 0; i--) { h = (h * 1103515245 + 12345) >>> 0; const j = h % (i + 1); [all[i], all[j]] = [all[j], all[i]]; }
    return all;
  }

  // An opened clue card. Earlier clues are compact; wrong guesses show under the clue they were made on.
  function clueCard(text, i, cls, guesses) {
    const misses = guesses.filter((g) => g.clue === i + 1 && !g.right);
    return el('div', { class: `clue ${cls}` }, [
      el('div', { class: 'label', text: `Clue ${i + 1}` }),
      el('div', { text }),
      ...misses.map((g) => el('div', { class: 'miss', text: `\u2717 ${g.text}` })),
    ]);
  }

  // Bring the given element fully into view (after a re-render, and again once a phone keyboard has closed).
  function keepInView(sel) {
    const go = () => { const t = $(sel); if (t) t.scrollIntoView({ block: 'nearest' }); };
    go(); setTimeout(go, 350);
  }

  function renderSet(feedback = '') {
    const set = SETS[state.setIdx];
    const worth = state.optionsShown ? CONFIG.OPTION_POINTS : CONFIG.POINTS[state.clue - 1];
    // Opened clues first, then the answer box right under the newest clue, then the clues still to come.
    const opened = set.clues.slice(0, state.clue).map((text, i) => {
      const latest = i === state.clue - 1;
      return clueCard(text, i, latest ? (state.clue > 1 ? 'latest fresh' : 'latest') : 'older', state.guesses);
    });
    const upcoming = [];
    if (!state.optionsShown) {
      for (let i = state.clue; i < set.clues.length; i++) {
        upcoming.push(i === state.clue
          ? el('button', { class: 'clue locked next', type: 'button', onclick: () => nextClue('tapped_card') }, [
            el('div', { class: 'label', text: `Clue ${i + 1}` }),
            el('div', { class: 'hint', text: `Tap to open \u00b7 worth ${CONFIG.POINTS[i]}` }),
          ])
          : el('div', { class: 'clue locked' }, [el('div', { class: 'label', text: `Clue ${i + 1}` }), el('div', { text: `Opens after clue ${i}` })]));
      }
    }
    const kids = [
      el('div', { class: 'puzzle-head' }, [
        el('span', { class: 'muted', text: `Puzzle ${state.setIdx + 1} of ${SETS.length}` }),
        el('span', { class: 'pts', text: `Worth ${worth}` }),
      ]),
      el('p', { class: 'ask', text: 'What do the clues point to?' }),
      ...opened,
    ];
    if (state.optionsShown) {
      kids.push(el('p', { class: 'muted small', text: `Pick one for ${CONFIG.OPTION_POINTS} points.` }));
      kids.push(el('div', { class: 'options', id: 'options' }, shuffledOptions(set).map((o) => el('button', { class: 'option', text: o, onclick: () => pickOption(o) }))));
    } else {
      const input = el('input', { type: 'text', id: 'guess', placeholder: 'Type your answer here', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'go', 'aria-label': 'Your answer' });
      const form = el('form', { class: 'guess', onsubmit: (e) => { e.preventDefault(); guess(input.value); } }, [
        input, el('button', { class: 'btn primary', type: 'submit', text: 'Guess' }),
      ]);
      kids.push(form);
      kids.push(el('div', { class: 'feedback', id: 'feedback', text: feedback }));
      kids.push(...upcoming);
      if (state.clue === 3) {
        kids.push(el('button', { class: 'btn ghost block', text: `Show four options (worth ${CONFIG.OPTION_POINTS})`, onclick: () => showOptions('asked') }));
      }
    }
    kids.push(el('div', { class: 'center' }, el('button', { class: 'link', text: 'Give up and see the answer', onclick: giveUp })));
    screen_(...kids);
    if (state.optionsShown) keepInView('#options');
    else if (state.clue > 1) keepInView('#feedback');
    const inp = $('#guess');
    if (inp && device === 'desktop') inp.focus();
  }

  function guess(text) {
    const set = SETS[state.setIdx];
    if (!text.trim()) { $('#guess').focus(); return; }
    const right = isRight(text, set);
    state.guesses.push({ clue: state.clue, text: text.slice(0, 80), right });
    save();
    log('guess', { guess: text.slice(0, 80), correct: right ? 1 : 0, ms_clue: Math.round(performance.now() - tClue) });
    if (right) return finishSet(state.clue, CONFIG.POINTS[state.clue - 1]);
    if (state.clue < 3) {
      nextClue('wrong_guess', `Not quite. Here's clue ${state.clue + 1}. Guess again.`);
    } else {
      showOptions('wrong_guess');
    }
  }

  function nextClue(reason, feedback = '') {
    const msPrev = Math.round(performance.now() - tClue);
    state.clue += 1; save();
    tClue = performance.now();
    log('clue', { reason, ms_prev_clue: msPrev });
    renderSet(feedback);
    const f = $('#feedback'); if (f && feedback) { f.classList.add('shake'); }
  }

  function showOptions(reason) {
    state.optionsShown = true; save();
    log('options_shown', { reason, ms_clue: Math.round(performance.now() - tClue) });
    tClue = performance.now();
    renderSet();
  }

  function pickOption(choice) {
    const set = SETS[state.setIdx];
    const right = choice === set.answer;
    log('option_pick', { choice, correct: right ? 1 : 0, ms_clue: Math.round(performance.now() - tClue) });
    finishSet(right ? 4 : 0, right ? CONFIG.OPTION_POINTS : 0);
  }

  function giveUp() {
    log('give_up', { ms_clue: Math.round(performance.now() - tClue) });
    finishSet(0, 0);
  }

  function finishSet(result, points) {
    const set = SETS[state.setIdx];
    const guesses = state.guesses;
    const msSet = Math.round(performance.now() - tSet);
    state.results.push({ id: set.id, result, points, guesses: state.guesses, ms: msSet });
    log('set_done', { result: HOW[result], points, guesses_n: state.guesses.length, ms_set: msSet });
    const setNo = state.setIdx + 1;
    state.setIdx += 1; state.clue = 1; state.optionsShown = false; state.guesses = [];
    const last = state.setIdx >= SETS.length;
    if (last) {
      state.done = true;
      state.score = state.results.reduce((s, r) => s + r.points, 0);
      log('day_done', { score: state.score, ms_day: state.results.reduce((s, r) => s + r.ms, 0) });
    }
    save();
    const verdict = result === 0 ? 'Not this time' : result === 4 ? `With the options · +${points}` : `Got it on clue ${result} · +${points}`;
    screen_(
      el('div', { class: 'puzzle-head' }, [el('span', { class: 'muted', text: `Puzzle ${setNo} of ${SETS.length}` }), el('span')]),
      ...set.clues.map((text, i) => clueCard(text, i, 'older', guesses)),
      el('div', { class: `reveal r${result}` }, [
        el('div', { class: 'verdict', text: verdict }),
        el('div', { class: 'answer', text: set.answer }),
        el('div', { class: 'why', text: set.explanation }),
      ]),
      el('button', {
        class: 'btn primary block', id: 'next-btn', text: last ? 'See your score' : 'Next puzzle',
        onclick: () => { if (last) renderResults(); else { tSet = performance.now(); tClue = performance.now(); renderSet(); } },
      }),
    );
    keepInView('#next-btn');
  }

  function shareText() {
    const tiles = state.results.map((r) => EMOJI[r.result]).join(' ');
    const url = `${location.origin}${location.pathname}?from=share`;
    return `Connect · ${prettyDate(DAY.date, { day: 'numeric', month: 'short' })}\n${tiles}  ${state.score}/${MAX}\n${url}`;
  }

  async function share() {
    const text = shareText();
    let method = 'none';
    try {
      if (navigator.share && device !== 'desktop') { await navigator.share({ text }); method = 'native'; }
      else if (navigator.clipboard) { await navigator.clipboard.writeText(text); method = 'clipboard'; $('#share-note').textContent = 'Copied. Paste it anywhere.'; }
      else { window.prompt('Copy your result:', text); method = 'prompt'; }
    } catch (e) { method = 'cancelled'; }
    log('share', { method });
  }

  function renderResults(revisit = false) {
    const review = el('div', { class: 'review', id: 'review', hidden: true });
    function showReview(i) {
      const r = state.results[i];
      const set = SETS[i];
      review.hidden = false;
      review.replaceChildren(
        el('b', { text: `Puzzle ${i + 1}: ${set.answer}` }),
        el('ol', {}, set.clues.map((c) => el('li', { text: c }))),
        el('div', { class: 'small', text: set.explanation }),
        r.guesses.length ? el('div', { class: 'small muted', text: `Your guesses: ${r.guesses.map((g) => g.text).join(', ')}` }) : null,
      );
      log('review', { set_no: i + 1, set_id: set.id });
    }
    const next = DAYS[dayIdx + 1];
    const countdown = el('div', { class: 'countdown center' });
    function tick() {
      if (!next || PREVIEW) { countdown.textContent = next ? '' : 'New puzzles are on their way. Check back soon!'; return; }
      const now = new Date();
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      const mins = Math.max(0, Math.round((midnight - now) / 60000));
      countdown.textContent = `New puzzles in ${Math.floor(mins / 60)}h ${mins % 60}m`;
    }
    tick(); setInterval(tick, 30000);
    screen_(el('div', { class: 'center' }, [
      el('span', { class: 'date-chip', text: `${prettyDate(DAY.date)} · Day ${dayIdx + 1}` }),
      el('div', { class: 'score', text: `${state.score}/${MAX}` }),
      el('div', { class: 'tiles' }, state.results.map((r, i) => el('button', { class: `tile t${r.result}`, onclick: () => showReview(i) }, [
        el('div', { class: 'n', text: `Puzzle ${i + 1}` }), el('div', { class: 'how', text: HOW[r.result] }),
      ]))),
      el('p', { class: 'muted small', text: 'Tap a puzzle to see its clues again.' }),
      el('button', { class: 'btn primary', text: 'Share your result', onclick: share }),
      el('div', { class: 'share-note', id: 'share-note' }),
      review,
      countdown,
    ]));
    if (revisit) log('results_view');
  }

  // ---------- start ----------
  const help = $('#help');
  $('#help-btn').addEventListener('click', () => { help.showModal(); log('help'); });
  $('#help-close').addEventListener('click', () => help.close());

  document.addEventListener('visibilitychange', () => {
    log(document.visibilityState === 'hidden' ? 'hidden' : 'visible', { stage: !DAY ? 'none' : state.done ? 'results' : state.started ? 'playing' : 'landing' });
  });

  if (!DAY) { renderNoPuzzle(); return; }
  log('open', { status: state.done ? 'done' : state.started ? 'in_progress' : 'new', visits: visitN });
  if (state.done) renderResults(true);
  else renderLanding();
})();
