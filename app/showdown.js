/**
 * Showdown Mode — frontend game flow
 * ===================================
 * A multiplayer quiz battle: 3–5 players join a session, vote on a category,
 * then all receive the same 5 quiz-lock puzzles. Fewest wrong answers wins,
 * fastest completion time breaks ties.
 *
 * Screen flow:  JOIN → LOBBY → VOTE → PLAY (×5) → RESULTS
 *
 * Backend contract (all JSON; POST bodies / GET paths as noted):
 *   POST /api/showdown/join       { name, sessionCode }        -> { ok, players?, error? }
 *   POST /api/showdown/ready      { sessionCode, playerName, ready }
 *   GET  /api/showdown/session/{code}  -> {
 *          state, players:[{name,ready}], enabledCategories:[id],
 *          votes:{id:count}, voteDeadline, winningCategory, results:[...]
 *        }
 *   POST /api/showdown/vote       { sessionCode, playerName, category }
 *   GET  /api/showdown/puzzles/{code}  -> { puzzles:[ …config… ] }  (or a raw array)
 *   POST /api/showdown/penalty    { sessionCode, playerName, puzzleId }
 *   POST /api/showdown/result     { sessionCode, playerName, correct, penalties, timeMs }
 *
 * The backend is delivered separately (Phase 1). Every call degrades
 * gracefully so the UI never hard-crashes when an endpoint is missing.
 */
/*
 * SECURITY (2026-08-25):
 * - Auth: playerToken (from /join response) sent as Bearer token on all API calls.
 * - Validation: HYBRID approach — client validates locally (instant UX) AND
 *   fires async /attempt calls to backend (authoritative scoring). Backend
 *   remains the source of truth: client-side pass/fail is advisory only and
 *   must not be trusted for final results. In MOCK mode, no /attempt calls are
 *   made and validation stays fully client-side.
 */
(function () {
  'use strict';

  // Mock mode: `?mock=true` forces every backend call to be served from the
  // in-memory fake below. Even without the flag, calls transparently fall back
  // to the mock when the real backend is unreachable (see the fetch interceptor).
  const MOCK = new URLSearchParams(location.search).get('mock') === 'true';

  /* ─────────────────────────── Config ─────────────────────────── */

  const TOTAL_PUZZLES = 5;
  const POLL_MS = 2000;
  const PROGRESS_POLL_MS = 3000; // opponent-progress polling cadence during PLAY
  const VOTE_SECONDS = 30;
  const MIN_PLAYERS = 3;

  // Canonical category list. `id` is what the backend speaks; `label` is what
  // the player sees. Only ids present in session.enabledCategories are shown.
  const CATEGORIES = [
    { id: 'aws-core-services',   label: 'AWS Core Services',     icon: '☁️' },
    { id: 'agentic-ai',          label: 'Agentic AI',            icon: '🤖' },
    { id: 'security',            label: 'Security',              icon: '🛡️' },
    { id: 'vietnam-aws',         label: 'Vietnam & AWS',         icon: '🇻🇳' },
    { id: 'startups-innovation', label: 'Startups & Innovation', icon: '🚀' },
    { id: 'cloud-fundamentals',  label: 'Cloud Fundamentals',    icon: '📚' },
  ];
  const CAT_BY_ID = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));

  /* ══════════════════════ Mock backend (?mock=true) ═══════════════
   * When mock mode is active, every /api/showdown/* fetch is answered from
   * this in-memory fake so the whole JOIN → LOBBY → VOTE → PLAY → RESULTS
   * flow can be walked through with no server running.
   *
   * Phase timing is derived deterministically from the moment of join:
   *   join             → instant
   *   lobby "waiting"  → first 3s (only "You" is present, not ready)
   *   players ready up → after 3s ("Alice" + "Bob" appear, everyone ready)
   *   vote countdown   → 5s, then "Agentic AI" locks in as the winner
   *
   * Note: the brief lists categories/winner by human label, but the UI speaks
   * category ids (see CATEGORIES). The mock therefore emits ids
   * (e.g. 'agentic-ai') so the ballot renders and the winner reveal resolves.
   * ────────────────────────────────────────────────────────────── */

  const MOCK_LOBBY_WAIT_MS = 3000; // "waiting for players" phase length
  const MOCK_VOTE_WAIT_MS  = 5000; // vote countdown before the winner is locked
  const MOCK_ALICE_STEP_MS = 15000; // Alice solves one puzzle every 15s
  const MOCK_BOB_STEP_MS   = 20000; // Bob solves one puzzle every 20s

  // The six enabled categories, mapped from the brief's labels to UI ids.
  const MOCK_ENABLED_CATEGORIES = [
    'aws-core-services', 'agentic-ai', 'security',
    'vietnam-aws', 'startups-innovation', 'cloud-fundamentals',
  ];

  // The exact 5 puzzles from docs/quiz-mode-puzzle-config-example.json,
  // trimmed to the runtime fields each lock component actually consumes.
  const MOCK_PUZZLES = [
    {
      id: 'q1-keypad', type: 'quiz_lock', category: 'agentic-ai', ui: 'keypad-lock',
      question: 'In what year was Amazon Q Developer first announced?',
      config: {
        answer: '2025',
        falseOutputs: ['Access denied. That vault belongs to a different era.'],
      },
      mandatory: true,
    },
    {
      id: 'q2-word', type: 'quiz_lock', category: 'agentic-ai', ui: 'word-lock',
      question: "What 7-letter word means 'a sudden change of course in thought or action'?",
      config: { answer: 'TANGENT' },
      mandatory: true,
    },
    {
      id: 'q3-pillar', type: 'quiz_lock', category: 'agentic-ai', ui: 'pillar-lock',
      question: 'Classify each statement as True or False:',
      config: {
        pillars: ['True', 'False'],
        statements: [
          { text: 'Kiro CLI 3.0 is built on a unified agent harness shared with Kiro IDE and Kiro Web.', answer: 'True' },
          { text: 'Kiro CLI 3.0 fully supports Amazon Linux 2 (AL2), requiring CLI 2.x there instead.', answer: 'False' },
          { text: 'Amazon Bedrock AgentCore reached general availability in October 2025.', answer: 'True' },
          { text: 'The Amazon Nova 2 family, announced at re:Invent December 2025, has two models.', answer: 'False' },
        ],
      },
      mandatory: true,
    },
    {
      id: 'q4-spelling', type: 'quiz_lock', category: 'agentic-ai', ui: 'spelling-lock',
      question: 'Unscramble each AWS/AI term:',
      config: {
        title: 'SPELL IT OUT',
        pool: ['TANGENT', 'MEMORY', 'KIRO POWER'],
        pickCount: 3,
        sequential: true,
        scrambleLetters: true,
      },
      mandatory: true,
    },
    {
      id: 'q5-wager', type: 'quiz_lock', category: 'security', ui: 'wager-lock',
      question: 'Answer each security question to reach the target score:',
      config: {
        target: 4,
        questions: [
          { question: 'Which attack floods a server with traffic to take it offline?', options: ['DDoS', 'SQLi', 'XSS', 'CSRF'], answer: 'DDoS' },
          { question: "What does '2FA' stand for?", options: ['Two-Factor Authentication', 'Two-File Access', 'Firewall Auth', 'Full Feature Access'], answer: 'Two-Factor Authentication' },
          { question: 'Which AWS service provides managed DDoS protection?', options: ['Shield', 'WAF', 'GuardDuty', 'Inspector'], answer: 'Shield' },
          { question: 'What is the principle of granting minimum necessary permissions?', options: ['Least privilege', 'Zero trust', 'Defense in depth', 'Separation of duties'], answer: 'Least privilege' },
        ],
        stakes: [
          { label: 'Confident', wager: 1, penalty: 0, color: '#eab308', showOptions: 4 },
        ],
        revealAnswerOnWrong: false,
      },
      mandatory: true,
      isFinal: true,
    },
  ];

  // Live mock state. `joinAt` anchors all phase timing; `result` holds this
  // player's posted score so the results screen can rank them for real.
  const mock = { code: 'ABC123', joinAt: 0, result: null };

  function mockJson(body, status) {
    return Promise.resolve(new Response(JSON.stringify(body), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  }

  // Builds the GET /session response for the current point in the timeline.
  function mockSession() {
    const now = Date.now();
    if (!mock.joinAt) mock.joinAt = now;
    const elapsed = now - mock.joinAt;

    // RESULTS — once this player has finished and posted a result.
    if (mock.result) {
      return {
        code: mock.code,
        state: 'results',
        results: [
          { name: state.playerName, correct: mock.result.correct,   penalties: mock.result.penalties, timeMs: mock.result.timeMs },
          { name: 'Alice', correct: 5, penalties: 3, timeMs: 110000 },
          { name: 'Bob',   correct: 4, penalties: 1, timeMs: 85000 },
        ],
      };
    }

    // LOBBY — the opening "waiting for players" window: just "You", not ready.
    if (elapsed < MOCK_LOBBY_WAIT_MS) {
      return {
        code: mock.code,
        state: 'lobby',
        maxPlayers: 5,
        players: [{ name: state.playerName, ready: false }],
      };
    }

    // VOTING — Alice + Bob have joined and everyone is ready.
    const votingStartedAt = mock.joinAt + MOCK_LOBBY_WAIT_MS;
    const session = {
      code: mock.code,
      state: 'voting',
      maxPlayers: 5,
      players: [
        { name: state.playerName, ready: true },
        { name: 'Alice', ready: true },
        { name: 'Bob',   ready: true },
      ],
      enabledCategories: MOCK_ENABLED_CATEGORIES,
      votes: { 'agentic-ai': 2, 'security': 1 },
      voteDeadline: votingStartedAt + MOCK_VOTE_WAIT_MS,
    };

    // After the 5s countdown the winning category locks in.
    if (now >= votingStartedAt + MOCK_VOTE_WAIT_MS) {
      session.winningCategory = 'agentic-ai';
      session.state = 'playing';

      // Simulate opponents grinding through the 5 puzzles so the progress
      // panel feels alive during testing. Alice pulls ahead every 15s, Bob
      // every 20s; "You" mirrors this player's real position.
      const playElapsed = now - (votingStartedAt + MOCK_VOTE_WAIT_MS);
      const clamp = (v) => Math.max(0, Math.min(TOTAL_PUZZLES, v));
      const aliceSolved = clamp(Math.floor(playElapsed / MOCK_ALICE_STEP_MS));
      const bobSolved   = clamp(Math.floor(playElapsed / MOCK_BOB_STEP_MS));

      session.progress = {
        [state.playerName]: { solved: clamp(state.puzzleIndex || 0), penalties: state.penalties || 0 },
        Alice:   { solved: aliceSolved, penalties: 1 },
        Bob:     { solved: bobSolved,   penalties: 0 },
      };
      session.finished = [];
      if (aliceSolved >= TOTAL_PUZZLES) session.finished.push('Alice');
      if (bobSolved   >= TOTAL_PUZZLES) session.finished.push('Bob');
    }
    return session;
  }

  // Routes a single /api/showdown/* request to the right canned response.
  function mockFetch(url, init) {
    let body = {};
    if (init && init.body) { try { body = JSON.parse(init.body); } catch { /* non-json */ } }

    if (url.indexOf('/api/showdown/join') !== -1) {
      mock.joinAt = Date.now();
      mock.result = null;
      return mockJson({
        success: true,
        session: { code: mock.code, players: [{ name: state.playerName, ready: false }], state: 'lobby', maxPlayers: 5 },
      });
    }
    if (url.indexOf('/api/showdown/ready') !== -1)   return mockJson({ ok: true });
    if (url.indexOf('/api/showdown/vote') !== -1) {
      return mockJson({ category: 'agentic-ai', votes: { 'agentic-ai': 2, 'security': 1 }, resolved: true });
    }
    if (url.indexOf('/api/showdown/session/') !== -1) return mockJson(mockSession());
    if (url.indexOf('/api/showdown/puzzles/') !== -1) return mockJson({ puzzles: MOCK_PUZZLES });
    if (url.indexOf('/api/showdown/penalty') !== -1)  return mockJson({ ok: true });
    if (url.indexOf('/api/showdown/result') !== -1) {
      // Record this player's real score so the leaderboard reflects their run.
      mock.result = {
        correct:   typeof body.correct === 'number' ? body.correct : 5,
        penalties: typeof body.penalties === 'number' ? body.penalties : 2,
        timeMs:    typeof body.timeMs === 'number' ? body.timeMs : 95000,
      };
      return mockJson({ ok: true });
    }
    return mockJson({ ok: true }); // unknown showdown endpoint — succeed quietly
  }

  let mockFellBack = false;

  // Small persistent badge so it's obvious the UI is running on mock data.
  function showMockBadge(text) {
    if (typeof document === 'undefined') return;
    let b = document.getElementById('sd-mock-badge');
    if (!b) {
      b = document.createElement('div');
      b.id = 'sd-mock-badge';
      b.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:9999;' +
        'font:600 11px/1.4 system-ui,sans-serif;letter-spacing:.08em;color:#fff;' +
        'background:rgba(220,38,38,.9);padding:4px 8px;border-radius:6px;pointer-events:none';
      (document.body || document.documentElement).appendChild(b);
    }
    b.textContent = text || 'MOCK MODE';
  }

  // Intercept fetch. Forced mock serves everything from the fake; otherwise the
  // real backend is tried first and only a network failure degrades to the mock.
  (function installFetchInterceptor() {
    const realFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;

    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const isShowdownApi = url.indexOf('/api/showdown/') !== -1;

      if (isShowdownApi && MOCK) return mockFetch(url, init);
      if (!isShowdownApi) {
        return realFetch ? realFetch(input, init) : Promise.reject(new Error('fetch unavailable'));
      }
      if (!realFetch) return mockFetch(url, init);

      // Real backend with graceful degradation when the network is unreachable.
      return realFetch(input, init).catch(function () {
        if (!mockFellBack) {
          mockFellBack = true;
          console.info('[showdown] backend unreachable — falling back to mock data');
          showMockBadge('MOCK (offline)');
        }
        return mockFetch(url, init);
      });
    };
  })();

  /* ─────────────────────────── State ──────────────────────────── */

  const state = {
    screen: null,
    playerName: '',
    sessionCode: '',
    playerToken: null,
    myVote: null,
    voteEndsAt: 0,
    revealed: false,
    // play
    puzzles: [],
    puzzleIndex: 0,
    penalties: 0,
    playStartMs: 0,
    instance: null,
    submitted: false,
    // live opponent progress
    finishedSeen: null,
  };

  let poller = null;         // setInterval handle for the active screen
  let progressPoller = null; // setInterval handle for PLAY-phase progress polling
  let timerTick = null;      // 1-second UI ticker (vote countdown / play clock)

  /* ─────────────────────────── DOM utils ──────────────────────── */

  const $ = (id) => document.getElementById(id);

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // Entrance animation to play when a given screen becomes active. The flow is
  // linear (join → lobby → vote → play → results), so keying off the incoming
  // screen is enough to realise every transition the brief calls for.
  const SCREEN_ENTER = {
    join:    'sd-enter-fade',
    lobby:   'sd-enter-slide-left', // JOIN → LOBBY: slide left
    vote:    'sd-enter-fade',       // LOBBY → VOTE: fade
    play:    'sd-enter-zoom',       // VOTE → PLAY: zoom in ("battle begins")
    results: 'sd-enter-slide-up',   // PLAY → RESULTS: slide up + celebration
  };
  const ALL_ENTER_CLASSES = ['sd-enter-fade', 'sd-enter-slide-left', 'sd-enter-zoom', 'sd-enter-slide-up'];

  function showScreen(name) {
    state.screen = name;
    document.querySelectorAll('.sd-screen').forEach((s) => {
      s.hidden = s.id !== 'screen-' + name;
    });
    stopPolling();
    stopTimer();
    stopProgressPolling();

    // Re-trigger the entrance animation on the now-visible screen.
    const el = $('screen-' + name);
    if (el) {
      ALL_ENTER_CLASSES.forEach((c) => el.classList.remove(c));
      const enter = SCREEN_ENTER[name];
      if (enter) {
        void el.offsetWidth; // restart the animation
        el.classList.add(enter);
      }
    }
  }

  /* ─────────────────────── Polling / timers ───────────────────── */

  function startPolling(fn) {
    stopPolling();
    fn(); // fire immediately so the UI doesn't wait a full interval
    poller = setInterval(fn, POLL_MS);
  }
  function stopPolling() {
    if (poller) { clearInterval(poller); poller = null; }
  }
  function startTimer(fn) {
    stopTimer();
    fn();
    timerTick = setInterval(fn, 1000);
  }
  function stopTimer() {
    if (timerTick) { clearInterval(timerTick); timerTick = null; }
  }
  function startProgressPolling(fn) {
    stopProgressPolling();
    fn(); // fire immediately so the panel appears as soon as data exists
    progressPoller = setInterval(fn, PROGRESS_POLL_MS);
  }
  function stopProgressPolling() {
    if (progressPoller) { clearInterval(progressPoller); progressPoller = null; }
  }

  /* ─────────────────────────── API ────────────────────────────── */

  async function apiPost(path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (state.playerToken) headers['Authorization'] = 'Bearer ' + state.playerToken;
    const res = await fetch(path, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty / non-json */ }
    if (!res.ok) {
      const err = new Error(data.error || ('Request failed (' + res.status + ')'));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  async function apiGet(path) {
    const headers = {};
    if (state.playerToken) headers['Authorization'] = 'Bearer ' + state.playerToken;
    const res = await fetch(path, { headers });
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) {
      const err = new Error(data.error || ('Request failed (' + res.status + ')'));
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  // Server-side puzzle validation: submit an attempt for a puzzle and let the
  // backend decide correctness (used in production where answers aren't in config).
  async function apiAttempt(puzzleId, attempt) {
    return apiPost('/api/showdown/attempt', {
      sessionCode: state.sessionCode,
      puzzleId,
      attempt,
    });
  }

  const fetchSession = () =>
    apiGet('/api/showdown/session/' + encodeURIComponent(state.sessionCode));

  /* ══════════════════════════ SCREEN 1 · JOIN ═════════════════════ */

  function initJoin() {
    showScreen('join');
    const form = $('join-form');
    const errEl = $('join-error');
    const btn = $('join-btn');

    form.onsubmit = async (e) => {
      e.preventDefault();
      errEl.textContent = '';

      const name = $('join-name').value.trim();
      const code = $('join-code').value.trim().toUpperCase();

      if (!name) { errEl.textContent = 'Please enter your name.'; return; }
      if (!/^[A-Z0-9]{6}$/.test(code)) {
        errEl.textContent = 'Session code must be 6 letters or numbers.';
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Joining…';
      try {
        const data = await apiPost('/api/showdown/join', { name, sessionCode: code });
        state.playerToken = data.playerToken || null;
        state.playerName = name;
        state.sessionCode = code;
        try { sessionStorage.setItem('sd_player', name); sessionStorage.setItem('sd_code', code); } catch {}
        initLobby();
      } catch (err) {
        // Surface the backend's reason (not found / full) verbatim when present.
        errEl.textContent = err.data && err.data.error
          ? err.data.error
          : (err.status === 404 ? 'Session not found.'
            : err.status === 403 ? 'This session is full.'
            : 'Could not join. Check the code and try again.');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Join Session';
      }
    };
  }

  /* ══════════════════════════ SCREEN 2 · LOBBY ════════════════════ */

  function initLobby() {
    showScreen('lobby');
    $('lobby-code').textContent = state.sessionCode;
    state.myReady = false;

    $('ready-btn').onclick = async () => {
      state.myReady = !state.myReady;
      renderReadyButton();
      try {
        await apiPost('/api/showdown/ready', {
          sessionCode: state.sessionCode,
          playerName: state.playerName,
          ready: state.myReady,
        });
      } catch {
        // Non-fatal: the next poll reconciles server truth.
      }
    };

    renderReadyButton();
    startPolling(pollLobby);
  }

  function renderReadyButton() {
    const btn = $('ready-btn');
    if (state.myReady) {
      btn.textContent = '✓ Ready — waiting for others';
      btn.classList.add('sd-btn--ready');
    } else {
      btn.textContent = "I'm Ready";
      btn.classList.remove('sd-btn--ready');
    }
  }

  async function pollLobby() {
    let session;
    try { session = await fetchSession(); }
    catch { $('lobby-status').textContent = 'Reconnecting…'; return; }

    const players = Array.isArray(session.players) ? session.players : [];
    renderPlayerList(players);

    // Keep our own ready state in sync with the server's view of us.
    const me = players.find((p) => p.name === state.playerName);
    if (me && typeof me.ready === 'boolean' && me.ready !== state.myReady) {
      state.myReady = me.ready;
      renderReadyButton();
    }

    const readyCount = players.filter((p) => p.ready).length;
    const allReady = players.length >= MIN_PLAYERS && readyCount === players.length;

    if (players.length < MIN_PLAYERS) {
      $('lobby-status').textContent =
        'Waiting for players… (' + players.length + '/' + MIN_PLAYERS + ' minimum)';
    } else {
      $('lobby-status').textContent =
        readyCount + ' of ' + players.length + ' ready';
    }

    // Advance when the server says so, or when everyone here is ready.
    if (session.state === 'voting' || session.state === 'playing' ||
        session.state === 'results' || allReady) {
      initVote();
    }
  }

  function renderPlayerList(players) {
    const list = $('lobby-players');
    list.innerHTML = players.map((p) => {
      const isMe = p.name === state.playerName;
      const ready = !!p.ready;
      return '<li class="sd-player' + (isMe ? ' sd-player--me' : '') + '">' +
        '<span class="sd-player-name">' + escapeHtml(p.name) + (isMe ? ' (you)' : '') + '</span>' +
        '<span class="sd-player-ready ' + (ready ? 'is-ready' : 'is-waiting') + '">' +
        (ready ? '✓ Ready' : '…') + '</span>' +
        '</li>';
    }).join('');
  }

  /* ══════════════════════════ SCREEN 3 · VOTE ═════════════════════ */

  function initVote() {
    showScreen('vote');
    state.myVote = null;
    state.revealed = false;
    $('vote-reveal').hidden = true;

    // Reset the countdown ring to full and clear any urgent styling.
    const wrap = $('vote-timer');
    if (wrap) {
      wrap.classList.remove('is-urgent');
      const ring = wrap.querySelector('.sd-timer-ring-fg');
      if (ring) ring.style.strokeDashoffset = '0';
    }

    // Local fallback deadline; overridden by server voteDeadline if provided.
    state.voteEndsAt = Date.now() + VOTE_SECONDS * 1000;

    renderBallot(CATEGORIES.map((c) => c.id)); // optimistic; poll refines it
    startPolling(pollVote);
    startTimer(tickVote);
  }

  function renderBallot(enabledIds) {
    const grid = $('vote-grid');
    const empty = $('vote-empty');

    if (!enabledIds || enabledIds.length === 0) {
      grid.innerHTML = '';
      empty.hidden = false;
      return;
    }
    empty.hidden = true;

    grid.innerHTML = enabledIds.map((id) => {
      const cat = CAT_BY_ID[id];
      if (!cat) return '';
      const selected = state.myVote === id ? ' is-selected' : '';
      return '<button type="button" class="sd-cat-btn' + selected + '" data-cat="' + id + '">' +
        '<span class="sd-cat-icon">' + cat.icon + '</span>' +
        '<span class="sd-cat-label">' + escapeHtml(cat.label) + '</span>' +
        '<span class="sd-cat-tally" data-tally="' + id + '"></span>' +
        '</button>';
    }).join('');

    grid.querySelectorAll('.sd-cat-btn').forEach((btn) => {
      btn.onclick = () => castVote(btn.dataset.cat);
    });
  }

  async function castVote(catId) {
    state.myVote = catId; // allow changing until voting closes
    $('vote-grid').querySelectorAll('.sd-cat-btn').forEach((b) => {
      b.classList.toggle('is-selected', b.dataset.cat === catId);
    });
    try {
      await apiPost('/api/showdown/vote', {
        sessionCode: state.sessionCode,
        playerName: state.playerName,
        category: catId,
      });
    } catch {
      // Keep the optimistic selection; the tally poll reconciles.
    }
  }

  async function pollVote() {
    let session;
    try { session = await fetchSession(); }
    catch { return; }

    // Server may narrow the ballot (a category can be disabled mid-vote).
    if (Array.isArray(session.enabledCategories)) {
      const ids = session.enabledCategories;
      const current = Array.from($('vote-grid').querySelectorAll('.sd-cat-btn'))
        .map((b) => b.dataset.cat);
      if (ids.join(',') !== current.join(',')) renderBallot(ids);
      if (ids.length === 0) return; // "no categories" state already shown
    }

    if (typeof session.voteDeadline === 'number') {
      state.voteEndsAt = session.voteDeadline;
    }

    // Live tally.
    if (session.votes && typeof session.votes === 'object') {
      Object.entries(session.votes).forEach(([id, count]) => {
        const el = $('vote-grid').querySelector('[data-tally="' + CSS.escape(id) + '"]');
        if (el) el.textContent = count > 0 ? String(count) : '';
      });
    }

    // Winner resolved by the backend (all voted, or timer elapsed server-side).
    if (session.winningCategory && !state.revealed) {
      revealWinner(session.winningCategory);
    }
  }

  function tickVote() {
    const now = Date.now();
    const remaining = Math.max(0, Math.ceil((state.voteEndsAt - now) / 1000));
    const totalMs = VOTE_SECONDS * 1000;
    // Precise fraction (not the ceil'd seconds) so the ring depletes smoothly.
    const fracLeft = Math.max(0, Math.min(1, (state.voteEndsAt - now) / totalMs));

    const wrap = $('vote-timer');
    const num = $('vote-timer-num');
    if (num) num.textContent = String(remaining);

    const ring = wrap && wrap.querySelector('.sd-timer-ring-fg');
    if (ring) {
      const CIRC = 131.95; // 2π·21, matches r in the SVG
      ring.style.strokeDasharray = String(CIRC);
      ring.style.strokeDashoffset = String(CIRC * (1 - fracLeft)); // deplete as time runs out
    }
    if (wrap) wrap.classList.toggle('is-urgent', remaining <= 5 && remaining > 0);

    if (remaining <= 0 && !state.revealed) {
      stopTimer();
      resolveVoteLocally();
    }
  }

  // Timer hit zero without a server-declared winner: ask once more, else pick
  // the local front-runner so the game never stalls.
  async function resolveVoteLocally() {
    let session = null;
    try { session = await fetchSession(); } catch { /* offline */ }

    if (session && session.winningCategory) {
      revealWinner(session.winningCategory);
      return;
    }

    const votes = (session && session.votes) || {};
    const enabled = (session && Array.isArray(session.enabledCategories) && session.enabledCategories.length)
      ? session.enabledCategories
      : CATEGORIES.map((c) => c.id);

    let best = null, bestCount = -1, tied = [];
    enabled.forEach((id) => {
      const c = votes[id] || 0;
      if (c > bestCount) { bestCount = c; best = id; tied = [id]; }
      else if (c === bestCount) { tied.push(id); }
    });
    // Tie (including the all-zero case) → random among the leaders.
    const winner = tied.length > 1 ? tied[Math.floor(Math.random() * tied.length)] : best;
    revealWinner(winner || enabled[0]);
  }

  function revealWinner(catId) {
    if (state.revealed) return;
    state.revealed = true;
    state.winningCategory = catId; // remembered for the results share summary
    stopTimer();
    stopPolling();

    const cat = CAT_BY_ID[catId] || { icon: '❓', label: catId };
    $('reveal-icon').textContent = cat.icon;
    $('reveal-name').textContent = cat.label;

    const overlay = $('vote-reveal');
    overlay.hidden = false;
    // restart the entrance animation
    overlay.classList.remove('is-in');
    void overlay.offsetWidth;
    overlay.classList.add('is-in');

    setTimeout(() => initPlay(), 2600);
  }

  /* ══════════════════════════ SCREEN 4 · PLAY ═════════════════════ */

  async function initPlay() {
    showScreen('play');
    state.puzzleIndex = 0;
    state.penalties = 0;
    state.submitted = false;
    state.playStartMs = 0;
    state.finishedSeen = new Set();
    $('play-penalties').textContent = '0';

    // Progress panel starts empty/hidden until the first poll returns data.
    const panel = $('play-progress-panel');
    if (panel) { panel.hidden = true; panel.innerHTML = ''; }

    const mount = $('play-mount');
    mount.innerHTML = '<div class="sd-loading">Assembling puzzles…</div>';

    let puzzles;
    try {
      const data = await apiGet('/api/showdown/puzzles/' + encodeURIComponent(state.sessionCode));
      puzzles = Array.isArray(data) ? data : (data.puzzles || []);
    } catch (err) {
      mount.innerHTML = '<div class="sd-error">Could not load puzzles' +
        (err.message ? ': ' + escapeHtml(err.message) : '') + '</div>';
      return;
    }

    if (!Array.isArray(puzzles) || puzzles.length === 0) {
      mount.innerHTML = '<div class="sd-error">No puzzles were returned for this session.</div>';
      return;
    }

    state.puzzles = puzzles;
    state.playStartMs = Date.now();
    startTimer(tickPlayClock);
    startProgressPolling(pollProgress);
    renderPuzzle();
  }

  function tickPlayClock() {
    const s = Math.floor((Date.now() - state.playStartMs) / 1000);
    const m = Math.floor(s / 60);
    const el = $('play-timer');
    el.textContent =
      String(m).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');

    // Gentle pulse on each 30s boundary to remind players the clock is ticking.
    if (s > 0 && s % 30 === 0 && state._lastPulseSec !== s) {
      state._lastPulseSec = s;
      el.classList.remove('is-pulse');
      void el.offsetWidth; // restart the animation
      el.classList.add('is-pulse');
      setTimeout(() => el.classList.remove('is-pulse'), 1000);
    }
  }

  /* ── Live opponent progress ──────────────────────────────────── */

  // Poll the session for everyone's progress. Runs on its own 3s cadence
  // (PROGRESS_POLL_MS) independently of the 1s play clock, and stops once
  // this player finishes (finishRun) or leaves the PLAY screen (showScreen).
  async function pollProgress() {
    let session;
    try { session = await fetchSession(); }
    catch { return; } // transient network blip — keep the last panel state

    const progress = session && typeof session.progress === 'object' ? session.progress : null;
    const finished = Array.isArray(session && session.finished) ? session.finished : [];

    renderProgress(progress, finished);

    // Toast each player the first time they cross the finish line. Skip a toast
    // for ourselves, but still mark us as "seen" so we never self-notify.
    if (!state.finishedSeen) state.finishedSeen = new Set();
    finished.forEach((name) => {
      if (state.finishedSeen.has(name)) return;
      state.finishedSeen.add(name);
      if (name !== state.playerName) {
        showFinishToast(name);
        playFinishSfx();
      }
    });
  }

  // Renders the compact single-row panel of players + solved-dots. Hidden
  // entirely when there's no progress data yet (first few seconds).
  function renderProgress(progress, finished) {
    const panel = $('play-progress-panel');
    if (!panel) return;

    const names = progress ? Object.keys(progress) : [];
    if (names.length === 0) {
      panel.hidden = true;
      panel.innerHTML = '';
      return;
    }

    const finishedSet = new Set(finished || []);

    panel.innerHTML = names.map((name) => {
      const p = progress[name] || {};
      const solved = Math.max(0, Math.min(TOTAL_PUZZLES, Number(p.solved) || 0));
      const isMe = name === state.playerName;
      const isFinished = finishedSet.has(name) || solved >= TOTAL_PUZZLES;

      let dots = '';
      for (let i = 0; i < TOTAL_PUZZLES; i++) {
        dots += '<span class="sd-pg-dot' + (i < solved ? ' is-filled' : '') + '"></span>';
      }

      return '<span class="sd-pg-player' + (isMe ? ' sd-pg-player--me' : '') + '">' +
        '<span class="sd-pg-name">👤 ' + escapeHtml(name) + (isMe ? ' (you)' : '') + '</span>' +
        '<span class="sd-pg-dots">' + dots + '</span>' +
        (isFinished ? '<span class="sd-pg-flag" title="Finished">🏁</span>' : '') +
        '</span>';
    }).join('');

    panel.hidden = false;
  }

  // Brief "🏁 Name finished!" toast. Auto-removes after its CSS animation.
  function showFinishToast(name) {
    const host = $('sd-toast-host');
    if (!host) return;
    const el = document.createElement('div');
    el.className = 'sd-toast';
    el.textContent = '🏁 ' + name + ' finished!';
    host.appendChild(el);
    // Fallback removal in case animationend never fires (reduced-motion, etc.).
    let removed = false;
    const kill = () => { if (removed) return; removed = true; el.remove(); };
    el.addEventListener('animationend', (e) => {
      if (e.animationName === 'sd-toast-out') kill();
    });
    setTimeout(kill, 3200);
  }

  // Subtle, self-contained "ding" via WebAudio — no asset files needed.
  // Fully optional: any failure (autoplay policy, unsupported) is swallowed.
  let sfxCtx = null;

  // Unlock AudioContext on first user interaction (required by browser autoplay policy)
  function unlockAudio() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!sfxCtx) sfxCtx = new Ctx();
      if (sfxCtx.state === 'suspended') sfxCtx.resume();
    } catch {}
    document.removeEventListener('click', unlockAudio);
    document.removeEventListener('touchstart', unlockAudio);
  }
  document.addEventListener('click', unlockAudio, { once: true });
  document.addEventListener('touchstart', unlockAudio, { once: true });

  function playFinishSfx() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!sfxCtx) sfxCtx = new Ctx();
      if (sfxCtx.state === 'suspended') sfxCtx.resume();

      const now = sfxCtx.currentTime;
      const osc = sfxCtx.createOscillator();
      const gain = sfxCtx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, now);      // A5
      osc.frequency.setValueAtTime(1320, now + 0.1); // E6 — quick rising chime
      // Keep it quiet and short so it never becomes annoying.
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.06, now + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
      osc.connect(gain).connect(sfxCtx.destination);
      osc.start(now);
      osc.stop(now + 0.3);
    } catch { /* SFX is best-effort */ }
  }

  // Short ascending beep (C5 → E5) played when the player solves a puzzle.
  function playSfxCorrect() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!sfxCtx) sfxCtx = new Ctx();
      if (sfxCtx.state === 'suspended') sfxCtx.resume();
      const now = sfxCtx.currentTime;
      [523, 659, 784].forEach((freq, i) => {
        const osc = sfxCtx.createOscillator();
        const gain = sfxCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + i * 0.06);
        gain.gain.setValueAtTime(0.0001, now + i * 0.06);
        gain.gain.exponentialRampToValueAtTime(0.09, now + i * 0.06 + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.06 + 0.18);
        osc.connect(gain).connect(sfxCtx.destination);
        osc.start(now + i * 0.06); osc.stop(now + i * 0.06 + 0.18);
      });
    } catch {}
  }

  // Short descending buzz (E4 → A3) played when the player answers wrong.
  function playSfxWrong() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!sfxCtx) sfxCtx = new Ctx();
      if (sfxCtx.state === 'suspended') sfxCtx.resume();
      const now = sfxCtx.currentTime;
      [185, 195].forEach(freq => {
        const osc = sfxCtx.createOscillator();
        const gain = sfxCtx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(freq, now);
        osc.frequency.linearRampToValueAtTime(freq * 0.7, now + 0.25);
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.04, now + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
        osc.connect(gain).connect(sfxCtx.destination);
        osc.start(now); osc.stop(now + 0.25);
      });
    } catch {}
  }

  function playSfxGameComplete() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!sfxCtx) sfxCtx = new Ctx();
      if (sfxCtx.state === 'suspended') sfxCtx.resume();
      const now = sfxCtx.currentTime;
      const notes = [523, 659, 784, 1047]; // C5 E5 G5 C6 — ascending fanfare
      notes.forEach((freq, i) => {
        const osc = sfxCtx.createOscillator();
        const gain = sfxCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now + i * 0.12);
        gain.gain.setValueAtTime(0.0001, now + i * 0.12);
        gain.gain.exponentialRampToValueAtTime(0.06, now + i * 0.12 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.3);
        osc.connect(gain).connect(sfxCtx.destination);
        osc.start(now + i * 0.12); osc.stop(now + i * 0.12 + 0.3);
      });
    } catch { /* SFX is best-effort */ }
  }

  function renderPuzzle() {
    const puzzle = state.puzzles[state.puzzleIndex];
    const total = state.puzzles.length;
    const n = state.puzzleIndex + 1;

    $('play-progress-text').textContent = 'Puzzle ' + n + ' of ' + total;
    $('play-progress-fill').style.width = ((n - 1) / total * 100) + '%';
    $('play-log').textContent = '';

    // A prompt only exists for keypad/word puzzles; embedded-content puzzles
    // (pillar/wager/spelling) fall back to a per-type instruction.
    const cfg = puzzle.config || {};
    const prompt = puzzle.question || puzzle.prompt || cfg.question || cfg.prompt || defaultPrompt(puzzle.ui);
    $('play-question').textContent = prompt || '';

    const mount = $('play-mount');
    mount.innerHTML = '';

    const hooks = {
      onWrong: (msg) => recordPenalty(puzzle, msg),
      onSolved: () => onPuzzleSolved(),
    };
    state.instance = mountPuzzle(mount, puzzle, hooks);
  }

  function defaultPrompt(ui) {
    switch (ui) {
      case 'pillar-lock':   return 'Sort each statement into the correct column.';
      case 'wager-lock':    return 'Reach the target score. Bank points on each question.';
      case 'spelling-lock': return 'Unscramble each answer.';
      default:              return '';
    }
  }

  // Maps a backend puzzle config onto the right global component class.
  // Wiring mirrors puzzle-test-showdown.html exactly.
  function mountPuzzle(mount, puzzle, hooks) {
    const cfg = puzzle.config || {};
    try {
      switch (puzzle.ui) {
        case 'keypad-lock':
          return new KeypadLock(mount, {
            answer: cfg.answer,
            falseOutputs: cfg.falseOutputs,
            onSubmit: () => hooks.onSolved(),
            onWrong: (m) => hooks.onWrong(m),
          });

        case 'word-lock':
          return new WordLock(mount, {
            answer: cfg.answer,
            alphabet: cfg.alphabet,
            onSubmit: (word, correct) =>
              correct ? hooks.onSolved() : hooks.onWrong('Wrong word: ' + word),
          });

        case 'pillar-lock':
          return new PillarLock(mount, {
            pillars: cfg.pillars,
            statements: cfg.statements,
            onSubmit: () => hooks.onSolved(),
            onWrong: (m) => hooks.onWrong(m),
          });

        case 'spelling-lock':
          return new SpellingLock(mount, {
            title: cfg.title,
            pool: cfg.pool,
            words: cfg.words,
            pickCount: cfg.pickCount,
            sequential: cfg.sequential,
            scrambleLetters: cfg.scrambleLetters,
            onSubmit: () => hooks.onSolved(),
            onWrong: (m) => hooks.onWrong(m),
          });

        case 'wager-lock':
          return new WagerLock(mount, {
            target: cfg.target,
            questions: cfg.questions,
            stakes: cfg.stakes,
            revealAnswerOnWrong: cfg.revealAnswerOnWrong,
            repeatOnWrong: true,
            onSubmit: () => hooks.onSolved(),
            onWrong: (m) => hooks.onWrong(m),
          });

        default:
          mount.innerHTML = '<div class="sd-error">Unknown puzzle type: ' +
            escapeHtml(puzzle.ui || 'undefined') + '</div>';
          return null;
      }
    } catch (err) {
      mount.innerHTML = '<div class="sd-error">Failed to build this puzzle: ' +
        escapeHtml(err.message || String(err)) + '</div>';
      return null;
    }
  }

  function recordPenalty(puzzle, msg) {
    playSfxWrong();

    state.penalties += 1;
    $('play-penalties').textContent = String(state.penalties);
    const log = $('play-log');
    log.textContent = msg ? '⚠ ' + msg : '⚠ Wrong — try again';

    // Fire-and-forget: report to the backend for group/individual scoring.
    apiPost('/api/showdown/penalty', {
      sessionCode: state.sessionCode,
      playerName: state.playerName,
      puzzleId: puzzle.id || ('puzzle-' + (state.puzzleIndex + 1)),
    }).catch(() => { /* non-fatal */ });

    // In production, also register the wrong attempt with the backend so its
    // authoritative scoring stays in sync (fire-and-forget, non-blocking).
    if (!MOCK) {
      apiAttempt(puzzle.id || ('puzzle-' + (state.puzzleIndex + 1)), '__WRONG__')
        .catch(() => { /* non-fatal */ });
    }
  }

  function onPuzzleSolved() {
    // Client already validated this puzzle locally (instant UX). In production,
    // also register the solve with the backend (fire-and-forget, non-blocking)
    // so the server independently tracks authoritative correctness.
    if (!MOCK) {
      const currentPuzzle = state.puzzles[state.puzzleIndex];
      const puzzleId = (currentPuzzle && currentPuzzle.id) || ('puzzle-' + (state.puzzleIndex + 1));
      apiAttempt(puzzleId, '__SOLVED__').catch(() => { /* non-fatal */ });
    }

    playSfxCorrect();

    const flash = $('play-solved-flash');
    flash.classList.add('is-on');
    setTimeout(() => flash.classList.remove('is-on'), 900);

    const last = state.puzzleIndex >= state.puzzles.length - 1;
    if (last) {
      $('play-progress-fill').style.width = '100%';
      setTimeout(finishRun, 900);
    } else {
      setTimeout(() => {
        state.puzzleIndex += 1;
        renderPuzzle();
      }, 900);
    }
  }

  function finishRun() {
    stopTimer();
    stopProgressPolling();
    if (state.submitted) return;
    state.submitted = true;

    playSfxGameComplete();
    const timeMs = Date.now() - state.playStartMs;
    const correct = state.puzzles.length; // every lock only fires onSubmit when correct

    // Remembered for the "Your Results" breakdown card + share summary.
    state.myCorrect = correct;
    state.myPenalties = state.penalties;
    state.myTimeMs = timeMs;

    apiPost('/api/showdown/result', {
      sessionCode: state.sessionCode,
      playerName: state.playerName,
      correct,
      penalties: state.penalties,
      timeMs,
    }).catch(() => { /* non-fatal — results screen still polls */ });

    initResults(timeMs);
  }

  /* ══════════════════════════ SCREEN 5 · RESULTS ══════════════════ */

  function initResults(myTimeMs) {
    showScreen('results');
    state.myTimeMs = myTimeMs;
    state._celebrated = false;

    // Reset any celebration leftovers from a previous run.
    $('results-crown').classList.remove('is-champion');
    $('results-headline').textContent = 'Results';
    clearConfetti();

    renderYourResults();
    wireResultsActions();

    $('results-status').textContent = 'Waiting for everyone to finish…';
    startPolling(pollResults);
  }

  // "Your Results" mini card + star rating (based on completion time).
  function renderYourResults() {
    const card = $('results-yours');
    if (!card) return;
    if (state.myTimeMs == null) { card.hidden = true; return; }

    const correct = state.myCorrect != null ? state.myCorrect : TOTAL_PUZZLES;
    const pens = state.myPenalties != null ? state.myPenalties : 0;
    $('results-yours-line').textContent =
      correct + '/' + TOTAL_PUZZLES + ' correct · ' +
      pens + ' penalt' + (pens === 1 ? 'y' : 'ies') + ' · ' +
      fmtTime(state.myTimeMs);
    $('results-yours-stars').textContent = starRating(state.myTimeMs);
    card.hidden = false;
  }

  // ≤60s = ⭐⭐⭐, ≤90s = ⭐⭐, otherwise ⭐.
  function starRating(timeMs) {
    if (timeMs == null) return '⭐';
    const s = timeMs / 1000;
    if (s <= 60) return '⭐⭐⭐';
    if (s <= 90) return '⭐⭐';
    return '⭐';
  }

  // Wire the Share + Play again buttons (idempotent — safe to call repeatedly).
  function wireResultsActions() {
    const share = $('results-share');
    if (share) share.onclick = () => doShare(share);
    const again = $('results-again');
    if (again) again.onclick = resetToJoin;
  }

  function shareText() {
    const cat = CAT_BY_ID[state.winningCategory];
    const catLabel = cat ? cat.label : 'Showdown';
    const correct = state.myCorrect != null ? state.myCorrect : TOTAL_PUZZLES;
    const pens = state.myPenalties != null ? state.myPenalties : 0;
    return '🏆 I scored ' + correct + '/' + TOTAL_PUZZLES + ' in ' + catLabel +
      ' Showdown! Time: ' + fmtTime(state.myTimeMs) + ' | Penalties: ' + pens;
  }

  async function doShare(btn) {
    const text = shareText();
    const original = '📋 Share result';
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      } else {
        // Legacy fallback for browsers without the async clipboard API.
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
        document.body.appendChild(ta);
        ta.focus(); ta.select();
        ok = document.execCommand('copy');
        ta.remove();
      }
    } catch { ok = false; }

    btn.textContent = ok ? '✓ Copied to clipboard' : '⚠ Copy failed';
    setTimeout(() => { btn.textContent = original; }, 1800);
  }

  // Play again → full state reset → JOIN screen (no page reload).
  function resetToJoin() {
    stopPolling(); stopTimer(); stopProgressPolling();
    clearConfetti();

    state.playerName = '';
    state.sessionCode = '';
    state.playerToken = null;
    state.myVote = null;
    state.voteEndsAt = 0;
    state.revealed = false;
    state.winningCategory = null;
    state.puzzles = [];
    state.puzzleIndex = 0;
    state.penalties = 0;
    state.playStartMs = 0;
    state.instance = null;
    state.submitted = false;
    state.finishedSeen = null;
    state.myReady = false;
    state.myCorrect = null;
    state.myPenalties = null;
    state.myTimeMs = null;
    state._celebrated = false;
    state._lastPulseSec = null;

    try { sessionStorage.removeItem('sd_player'); sessionStorage.removeItem('sd_code'); } catch {}

    // Clear results DOM so a stale board never flashes on the next run.
    $('results-board').innerHTML = '';
    $('results-yours').hidden = true;
    $('results-crown').classList.remove('is-champion');
    $('results-headline').textContent = 'Results';
    $('results-status').textContent = '';

    // Reset the join form fields.
    ['join-name', 'join-code'].forEach((id) => { const el = $(id); if (el) el.value = ''; });
    const err = $('join-error'); if (err) err.textContent = '';

    initJoin();
  }

  // CSS-only confetti — inject a burst of pieces; each animates itself down.
  function fireConfetti() {
    const host = $('sd-confetti');
    if (!host) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    clearConfetti();
    const colors = ['#fbbf24', '#3b82f6', '#8b5cf6', '#22c55e', '#ef4444', '#eab308'];
    const N = 70;
    for (let i = 0; i < N; i++) {
      const p = document.createElement('span');
      p.className = 'sd-confetti-piece';
      p.style.left = (Math.random() * 100) + 'vw';
      p.style.background = colors[i % colors.length];
      p.style.animationDuration = (2.4 + Math.random() * 2.2) + 's';
      p.style.animationDelay = (Math.random() * 0.6) + 's';
      if (Math.random() < 0.5) p.style.borderRadius = '50%';
      host.appendChild(p);
    }
    setTimeout(clearConfetti, 6500);
  }

  function clearConfetti() {
    const host = $('sd-confetti');
    if (host) host.innerHTML = '';
  }

  async function pollResults() {
    let session;
    try { session = await fetchSession(); }
    catch { $('results-status').textContent = 'Reconnecting…'; return; }

    // Prefer a server-ranked leaderboard; otherwise derive one from players.
    let rows = Array.isArray(session.results) ? session.results.slice() : null;

    if (!rows) {
      const players = Array.isArray(session.players) ? session.players : [];
      rows = players.map((p) => ({
        name: p.name,
        correct: p.correct,
        penalties: p.penalties,
        timeMs: p.timeMs,
        finished: p.finished,
      }));
    }

    // Ranking: most correct (primary) → fewest penalties (tiebreak 1) →
    // fastest time (tiebreak 2). Players still in progress sink to the bottom.
    rows.sort((a, b) => {
      const af = a.timeMs != null, bf = b.timeMs != null;
      if (af !== bf) return af ? -1 : 1;
      const ac = a.correct != null ? a.correct : -1;
      const bc = b.correct != null ? b.correct : -1;
      if (bc !== ac) return bc - ac;                     // most correct first
      const ap = a.penalties != null ? a.penalties : Infinity;
      const bp = b.penalties != null ? b.penalties : Infinity;
      if (ap !== bp) return ap - bp;                     // then fewest penalties
      return (a.timeMs != null ? a.timeMs : Infinity) - (b.timeMs != null ? b.timeMs : Infinity); // then fastest
    });

    const allDone = rows.length > 0 && rows.every((r) => r.timeMs != null);
    const final = allDone || session.state === 'results';

    renderLeaderboard(rows, final);

    if (final) {
      stopPolling();
      $('results-status').textContent = 'Final results';
      const champ = rows[0];
      const iWon = champ && champ.name === state.playerName;
      $('results-headline').textContent =
        champ ? (iWon ? 'You win! 🎉' : champ.name + ' wins!') : 'Results';

      // Celebrate the winner once: crown animation + confetti burst.
      if (!state._celebrated) {
        state._celebrated = true;
        $('results-crown').classList.add('is-champion');
        fireConfetti();
      }
    } else {
      const done = rows.filter((r) => r.timeMs != null).length;
      $('results-status').textContent =
        'Waiting for everyone to finish… (' + done + '/' + rows.length + ')';
    }
  }

  function fmtTime(ms) {
    if (ms == null) return '—';
    const s = Math.round(ms / 1000);
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  // rows: pre-sorted leaderboard. `final` distinguishes an unfinished player
  // (⏳ "still playing…") from a disconnected one (— "DNF") once results lock.
  function renderLeaderboard(rows, final) {
    const medals = ['🥇', '🥈', '🥉'];
    $('results-board').innerHTML = rows.map((r, i) => {
      const isMe = r.name === state.playerName;
      const finished = r.timeMs != null;
      const rank = finished ? (medals[i] || String(i + 1)) : (final ? '—' : '⏳');
      const correct = r.correct != null ? r.correct : 0;

      let stats;
      if (finished) {
        stats =
          '<span class="sd-lb-correct">' + correct + '/' + TOTAL_PUZZLES + '</span>' +
          '<span class="sd-lb-pen">' + (r.penalties != null ? r.penalties : 0) + '⚠</span>' +
          '<span class="sd-lb-time">' + fmtTime(r.timeMs) + '</span>';
      } else if (final) {
        stats = '<span class="sd-lb-dnf">DNF</span>';
      } else {
        stats = '<span class="sd-lb-dnf">still playing…</span>';
      }

      const isWin = i === 0 && finished;
      return '<li class="sd-lb-row' + (isMe ? ' sd-lb-row--me' : '') +
        (isWin ? ' sd-lb-row--win' : '') + '">' +
        '<span class="sd-lb-rank">' + rank + '</span>' +
        '<span class="sd-lb-name">' + escapeHtml(r.name) + (isMe ? ' (you)' : '') + '</span>' +
        '<span class="sd-lb-stats">' + stats + '</span>' +
        '</li>';
    }).join('');
  }

  /* ─────────────────────────── Boot ───────────────────────────── */

  document.addEventListener('DOMContentLoaded', function () {
    if (MOCK) showMockBadge();
    initJoin();
  });
})();
