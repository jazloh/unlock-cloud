/**
 * Showdown Mode — frontend game flow (DEPLOYED-BACKEND integration)
 * =================================================================
 * A multiplayer quiz battle run on-site: each device claims a numbered seat
 * with a PIN, discovers the live session, joins the lobby, votes on a category,
 * then races the same quiz-lock puzzles. Live standings (rank / completion% /
 * elapsed) drive every screen — the client never advances locally.
 *
 * Screen flow:  JOIN → LOBBY → VOTE → PLAY → RESULTS
 *
 * SINGLE SOURCE OF TRUTH: docs/showdown-api-integration.md (reflects the
 * deployed backend, confirmed 2026-09-17). This file is a data-layer rewrite
 * of the older /api/showdown/* mock-first implementation.
 *
 * BUILD STATUS (phased — see SSOT §10):
 *   P0 Scaffolding ............ DONE (bank asset + index, base URLs, identity state)
 *   P1 Identity/JOIN + discovery DONE (claim → /public → /players, PIN, persistence)
 *   P2 State machine + poll .... DONE (one 1s loop, reducer→screen, LOBBY wired)
 *   P3 Voting .................. DONE (ballot/tally/countdown/reveal via standings)
 *   P4 Bank resolver + PLAY .... DONE (resolveBank + mountPuzzle + race + progress)
 *   P5 RESULTS + podium ........ DONE (server rank order, champion, end_reason, stars)
 *   P6 Hardening ............... DONE (rehydrate+resume, superseded terminal, retries)
 *
 *   INTEGRATION COMPLETE — all 7 phases (P0–P6) wired against the deployed backend.
 *
 * Wire contract (SSOT §1–§3): two API bases, IDs only over the wire.
 *   POST [S] /games/{game_id}/seats/claim {pin}         -> {seat_number, seat_token}   (v2: moved to [S])
 *   GET  [S] /games/{game_id}/public                    -> {status, current_session_id, current_session_state}   (v2: moved to [S])
 *   POST [S] /showdown/{session_id}/players {seat_token, display_name}
 *                                                       -> {session_id, player_id, display_name, seat_number, token}
 *   POST [S] /showdown/{session_id}/vote {player_id, category, token}   (P3)
 *   GET  [S] /showdown/{session_id}/puzzles             -> {winning_category, picks{type:[ids]}}  (P4)
 *   POST [S] /showdown/{session_id}/progress {player_id, puzzles_completed, token}  (P4)
 *   GET  [S] /showdown/{session_id}/standings           (~1s, single screen driver)
 *
 * Tokens (seat_token / token) travel in the JSON BODY, never as Authorization
 * headers (SSOT §1). Mock only on explicit ?mock=true — no fallback-to-mock on
 * network error (SSOT §7 deviation #4).
 */
(function () {
  'use strict';

  /* ─────────────────────────── Flags ──────────────────────────── */

  const params = new URLSearchParams(location.search);
  // Mock mode is EXPLICIT only. There is deliberately no implicit fallback to
  // mock on network error (SSOT §7 deviation #4) — a flaky booth WiFi must show
  // a real error, never fake opponents/winners.
  const MOCK = params.get('mock') === 'true';
  // Rehearsal fault switches (SSOT §8): only meaningful under ?mock=true.
  const MOCK_FAIL = params.get('mockfail') || ''; // 'bankid' | 'auth' | 'badpin' | 'latejoin'
  // Optional host-set event name (display-only) for the attract-screen eyebrow,
  // e.g. ?event_name=AWS%20Cloud%20Day. Presentation only; absent = eyebrow hidden.
  const EVENT_NAME = (params.get('event_name') || params.get('event') || '').trim();

  /* ─────────────────────────── Theme (Feature 1) ──────────────── */
  // HEAT dark is the default; 'light' remaps the palette CSS custom properties
  // in showdown.css under the .sd-theme-light scope. Applied SYNCHRONOUSLY here
  // (before first paint) so a persisted choice never flashes the wrong theme.
  // The one-accent lock is preserved: orange stays the accent, lime = live/win,
  // gold = code/1st — only the shades shift for light-surface AA.
  const THEME_KEY = 'sd_theme';
  function getTheme() {
    try { return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'heat'; } catch { return 'heat'; }
  }
  function applyTheme(t) {
    const light = t === 'light';
    document.documentElement.classList.toggle('sd-theme-light', light);
    if (document.body) {
      document.body.classList.toggle('sd-theme-light', light);
      // VS Select mode mechanism: accents flow from --mode-color (coral) via
      // body[data-mode='showdown']. data-theme mirrors it for parity with the
      // broadcast board. Presentation-only; set here (not in showdown.html).
      document.body.setAttribute('data-mode', 'showdown');
      document.body.setAttribute('data-theme', 'showdown');
    }
  }
  function setTheme(t) {
    try { localStorage.setItem(THEME_KEY, t); } catch { /* storage off — session-only */ }
    applyTheme(t);
    updateThemeToggle();
  }
  applyTheme(getTheme()); // pre-paint, before any DOM is shown

  // Small, unobtrusive theme toggle built at runtime into the JOIN chrome (no
  // showdown.html edits). Independent of game_id, so it never reintroduces the
  // disabled-form footgun. Reduced-motion safe (no animation).
  function buildThemeToggle() {
    if (typeof document === 'undefined' || document.getElementById('sd-theme-toggle')) return;
    const host = document.getElementById('screen-join') || document.body;
    if (!host) return;
    const btn = document.createElement('button');
    btn.id = 'sd-theme-toggle';
    btn.type = 'button';
    btn.className = 'sd-theme-toggle';
    btn.setAttribute('aria-label', 'Toggle light or dark theme');
    btn.addEventListener('click', () => setTheme(getTheme() === 'light' ? 'heat' : 'light'));
    host.appendChild(btn);
    updateThemeToggle();
  }
  function updateThemeToggle() {
    const btn = typeof document !== 'undefined' && document.getElementById('sd-theme-toggle');
    if (!btn) return;
    const light = getTheme() === 'light';
    // Label shows the theme you'll switch TO. \u2600 = sun, \u263e = moon.
    btn.textContent = light ? '\u263e Dark' : '\u2600 Light';
    btn.setAttribute('aria-pressed', String(light));
  }

  /* ─────────────────────────── Base URLs (SSOT §1) ────────────── */

  // v2 (2026-09-18): the engine now talks to exactly ONE base — the Showdown
  // API [S] — for EVERY call, including seat-claim and /public (both moved off
  // the Admin API [A] onto [S]). See showdown-engine-integration-api-v2.md §1.
  const BASE_S = 'https://8qc41th8u0.execute-api.ap-southeast-5.amazonaws.com/v1';  // Showdown/Engine: ALL calls
  // BASE_A is no longer called by the engine (v2). Kept only so the ?mock=true
  // fetch interceptor's base match keeps working for any legacy URL; the admin
  // API hosts Cognito-protected host/GM routes the engine never touches.
  const BASE_A = 'https://1fvjsw6674.execute-api.ap-southeast-5.amazonaws.com/dev'; // Admin/Game (NOT called by engine)

  /* ─────────────────────────── Config ─────────────────────────── */

  const POLL_MS = 1000;         // standings cadence (~1s, SSOT §6)
  const BACKOFF_MS = [1000, 2000, 5000]; // error backoff ladder 1→2→5s (SSOT §6)

  // PIN: exactly 6, uppercase, excludes 0 O 1 I L (SSOT Q1). This is the client
  // input alphabet + validation mask.
  const PIN_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // A-Z minus O,I,L + 2-9
  const PIN_LEN = 6;
  const PIN_RE = new RegExp('^[' + PIN_ALPHABET + ']{' + PIN_LEN + '}$');

  // Display name: capped client-side because every surface that shows it is
  // width-constrained — the race lane's name column and the three podium plates.
  // showdown.html ships maxlength="20"; 12 is what actually fits at these type
  // sizes in a half-width booth pane. The backend imposes no limit of its own.
  const NAME_MAX = 12;

  // Same-origin, versioned bank asset (SSOT §5). Tracks app/VERSION for the
  // ?v= cache-bust convention (NOT bumped by this task — local only).
  const BANK_VERSION = '13';
  // Relocated under app/showdown/ (2026-09-21): the old app/data/ path was not
  // reliably present on S3. Local bundle stays the source (NOT the live
  // /showdown/bank proxy). ?v= cache-buster tracks app/VERSION (not bumped here).
  const BANK_URL = 'showdown/quiz-mode-question-bank.json?v=' + BANK_VERSION;

  // localStorage key for refresh/reconnect recovery (SSOT §7 deviation #5).
  const LS_IDENTITY = 'sd_identity_v2';

  // sessionStorage key for the game_id (CHANGE 3). ?game=<id> from the table QR
  // is persisted here so it survives in-session navigation; on a later boot with
  // no ?game= we fall back to this stored value before asking for a table code.
  const SS_GAME_ID = 'sd_game_id';
  function persistGameId(id) {
    if (!id) return;
    try { sessionStorage.setItem(SS_GAME_ID, id); } catch { /* storage off — non-fatal */ }
  }
  function loadGameId() {
    try { return sessionStorage.getItem(SS_GAME_ID) || null; } catch { return null; }
  }

  // Canonical category list. `id` is what the backend speaks; `label` is shown.
  const CATEGORIES = [
    { id: 'aws-core-services',   label: 'AWS Core Services',     icon: '☁️' },
    { id: 'agentic-ai',          label: 'Agentic AI',            icon: '🤖' },
    { id: 'security',            label: 'Security',              icon: '🛡️' },
    { id: 'vietnam-aws',         label: 'Vietnam & AWS',         icon: '🇻🇳' },
    { id: 'startups-innovation', label: 'Startups & Innovation', icon: '🚀' },
    { id: 'cloud-fundamentals',  label: 'Cloud Fundamentals',    icon: '📚' },
    // 7th live category present in the deployed /showdown/bank (confirmed
    // 2026-09-22). Registered so a FrugalArchitect win renders a proper label +
    // icon on the ballot/reveal/share instead of the raw slug. Resolution itself
    // never depended on this map (it indexes BANK_INDEX[winning_category]).
    { id: 'FrugalArchitect',     label: 'Frugal Architect',      icon: '💰' },
  ];
  const CAT_BY_ID = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));

  /* ── HEAT inline-SVG mark set (unchanged; used by VOTE/RESULTS in P3/P5) ── */
  const SD_ICONS = {
    vault: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 10V8a5 5 0 0 1 10 0v2h1a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h1zm2 0h6V8a3 3 0 0 0-6 0v2z"/></svg>',
    'aws-core-services': '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="4" y="4" width="16" height="4.4" rx="1"/><rect x="4" y="9.8" width="16" height="4.4" rx="1"/><rect x="4" y="15.6" width="16" height="4.4" rx="1"/></svg>',
    'agentic-ai': '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/><rect x="10.4" y="2.5" width="1.4" height="3"/><rect x="12.2" y="2.5" width="1.4" height="3"/><rect x="10.4" y="18.5" width="1.4" height="3"/><rect x="12.2" y="18.5" width="1.4" height="3"/><rect x="2.5" y="10.4" width="3" height="1.4"/><rect x="2.5" y="12.2" width="3" height="1.4"/><rect x="18.5" y="10.4" width="3" height="1.4"/><rect x="18.5" y="12.2" width="3" height="1.4"/></svg>',
    security: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l8 3v6c0 4.5-3.2 8.4-8 9-4.8-.6-8-4.5-8-9V5l8-3z"/></svg>',
    'vietnam-aws': '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l2.9 6.4 7 .6-5.3 4.6 1.6 6.8L12 17.3 5.8 20.9l1.6-6.8L2.1 9l7-.6L12 2z"/></svg>',
    'startups-innovation': '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2c3.5 3 5 7 5 11l-2 3H9l-2-3c0-4 1.5-8 5-11z"/><path d="M9 18l3 4 3-4z"/></svg>',
    'cloud-fundamentals': '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 2h11v16H7a2 2 0 0 0-2 2V4a2 2 0 0 1 2-2zm0 16h9v2H7a1 1 0 0 1 0-2z"/></svg>',
    'FrugalArchitect': '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 3.2c.5 0 .9.4.9.9v.6c1.4.2 2.5 1 2.8 2.2a.9.9 0 0 1-1.7.5c-.2-.6-.9-1-1.9-1-1.1 0-1.8.5-1.8 1.1 0 .5.4.8 1.9 1.1 1.9.4 3.4 1 3.4 2.8 0 1.4-1.1 2.3-2.7 2.5v.6a.9.9 0 0 1-1.8 0v-.6c-1.5-.2-2.6-1-3-2.2a.9.9 0 0 1 1.7-.6c.2.7 1 1.1 2.1 1.1 1.2 0 1.9-.5 1.9-1.1 0-.6-.5-.9-2-1.2-1.8-.4-3.3-1-3.3-2.7 0-1.3 1-2.2 2.6-2.5v-.6c0-.5.4-.9.9-.9z"/></svg>',
  };
  const SD_FLAG_SVG = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 3v18H3V3h2zm2 0h13l-2.6 4L20 11H7V3z"/></svg>';
  const iconSvg = (id) => SD_ICONS[id] || SD_ICONS.vault;

  /* ─────────────────────────── State (SSOT §3) ────────────────── */
  // Identity is now seat/session based (game_id → PIN → seat_token → session_id
  // → player_id + token). This REPLACES the old sessionCode/playerToken pair.

  const state = {
    screen: null,
    // identity
    gameId: null,        // from URL ?game=<id>
    pin: null,           // 6-char, uppercase, alphabet-masked
    displayName: '',
    seatNumber: null,    // from claim
    seatToken: null,     // from claim (body credential)
    sessionId: null,     // discovered via /public
    playerId: null,      // from /players
    token: null,         // write credential from /players (body, not header)
    // last standings snapshot (single source of truth for screens)
    standings: null,
    // vote (P3)
    myVote: null,
    voteLocked: false,
    revealed: false,
    // play (P4)
    puzzles: [],
    puzzleIndex: 0,
    puzzlesCompleted: 0,
    playStartMs: 0,
    instance: null,
    // misc UI
    _lastPulseSec: null,
    _celebrated: false,
    // play clock (authoritative elapsed_ms, anchored + smoothed between polls)
    _clockSrvMs: null,
    _clockAt: 0,
    _clockShownMs: null,
  };

  /* ─────────────────────── Bank index (P0, SSOT §5) ───────────── */
  // Loaded once at boot. Indexed id→entry per (category,type) for O(1) lookup
  // by the P4 resolver. `type` keys in the bank: mcq | numeric | word |
  // statement | spelling.

  let BANK = null;        // raw parsed bank
  let BANK_INDEX = null;  // { category: { type: Map<id, entry> } }
  let BANK_FLAT = null;   // Map<id, { category, type, entry }>  (convenience)
  let bankReady = null;   // Promise resolving when the bank is indexed

  // Bank-parity fix (Option A): the backend resolves /puzzles picks from the
  // bank served at [S] /showdown/bank, which carries ALL live categories (7+,
  // incl. FrugalArchitect). Fetching THAT at boot makes category drift between
  // the client and backend structurally impossible. The same-origin local
  // bundle (BANK_URL) stays as the offline/failure fallback — it has the same
  // JSON shape ({ categories: { <cat>: { <type>: [entries] } }, ... }). MOCK
  // never touches the network (stays fully offline via the local bundle).
  const LIVE_BANK_URL = BASE_S + '/showdown/bank';
  const LIVE_BANK_TIMEOUT_MS = 5000; // cap the boot fetch so a hang falls back

  // Index a parsed bank into BANK / BANK_INDEX / BANK_FLAT. Shared verbatim by
  // the live and local paths so both sources are indexed identically (the P4
  // resolver is unchanged and source-agnostic).
  function indexBank(raw) {
    BANK = raw;
    BANK_INDEX = {};
    BANK_FLAT = new Map();
    let entries = 0, cats = 0, typeCount = 0;
    const cats_ = (raw && raw.categories) || {};
    Object.keys(cats_).forEach((cat) => {
      BANK_INDEX[cat] = {};
      cats++;
      Object.keys(cats_[cat]).forEach((type) => {
        const arr = cats_[cat][type];
        if (!Array.isArray(arr)) return;
        const m = new Map();
        arr.forEach((entry) => {
          if (entry && entry.id) {
            m.set(entry.id, entry);
            BANK_FLAT.set(entry.id, { category: cat, type, entry });
            entries++;
          }
        });
        BANK_INDEX[cat][type] = m;
        typeCount++;
      });
    });
    return { entries, cats, typeCount };
  }

  // Fetch + parse a bank URL, validating shape. Throws on non-200, non-JSON, or
  // a bank with no categories (malformed/empty) so the caller can fall back.
  async function fetchBankJson(url, opts) {
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error('bank fetch failed (' + res.status + ')');
    const raw = await res.json(); // throws on non-JSON / empty body
    if (!raw || typeof raw !== 'object' || !raw.categories ||
        typeof raw.categories !== 'object' || !Object.keys(raw.categories).length) {
      throw new Error('bank malformed or empty');
    }
    return raw;
  }

  async function loadBank() {
    if (bankReady) return bankReady;
    bankReady = (async () => {
      let raw = null;
      let usedLive = false;

      // Real (non-mock) boot: try the authoritative live bank first. Any
      // failure (network error, non-200, malformed/empty JSON, or timeout)
      // falls through to the local bundle below. MOCK skips this entirely so
      // the offline walkthrough never hits the network.
      if (!MOCK) {
        try {
          let opts, timer = null;
          if (typeof AbortController === 'function') {
            const ac = new AbortController();
            timer = setTimeout(() => ac.abort(), LIVE_BANK_TIMEOUT_MS);
            opts = { signal: ac.signal };
          }
          try {
            raw = await fetchBankJson(LIVE_BANK_URL, opts);
            usedLive = true;
          } finally {
            if (timer) clearTimeout(timer);
          }
        } catch (e) {
          console.warn('[showdown] live bank fetch failed (' + (e && e.message) +
            ') \u2014 falling back to local bundle');
          raw = null;
        }
      }

      // Fallback / mock / offline: the same-origin local bundle (keeps the ?v=
      // cache-buster). If this ALSO fails, the promise rejects and loadPuzzles
      // surfaces its normal load-error UI (unchanged behavior).
      if (!raw) raw = await fetchBankJson(BANK_URL);

      const stats = indexBank(raw);
      const src = usedLive ? 'live' : (MOCK ? 'local (mock)' : 'local fallback');
      console.info('[showdown] bank: ' + src);
      console.info('[showdown] bank indexed: ' + stats.entries + ' entries across ' +
        stats.cats + ' categories, ' + stats.typeCount + ' (category,type) buckets');
      return stats;
    })();
    return bankReady;
  }

  // Resolve a single bank id → { category, type, entry }, or null. Used by P4.
  function bankLookup(id) {
    return (BANK_FLAT && BANK_FLAT.get(id)) || null;
  }

  /* ══════════════════════ Mock backend (?mock=true) ═══════════════
   * Interceptor matches the TWO API bases (SSOT §8), NOT /api/showdown/*.
   * Scripted timeline walks setup→voting→in_progress→completed on a clock
   * anchored at the seat claim. /puzzles returns REAL bank IDs (agentic-*) so
   * the P4 resolver can be exercised offline. Fault switches: &mockfail=badpin
   * (403 on claim), &mockfail=auth (409 superseded on /players & writes),
   * &mockfail=bankid (bogus puzzle id → P4 config error).
   * ────────────────────────────────────────────────────────────── */

  // Timeline (ms from claim). Kept short so a mock walkthrough is quick.
  const MOCK_SESSION_DELAY_MS = 1500; // /public withholds session_id this long
  const MOCK_SETUP_MS   = 6000;  // setup   window (lobby)
  const MOCK_VOTING_MS  = 6000;  // voting  window
  // in_progress window. 9s is right for a quick walkthrough but is too short to
  // actually finish all 5 locks, which makes the finished-and-waiting spectator
  // state unreachable in mock. &mockplay=<seconds> widens it for that test.
  // Mock-only; ignored entirely against the live backend.
  const MOCK_PLAY_MS = (() => {
    const s = Number(params.get('mockplay'));
    return Number.isFinite(s) && s > 0 ? Math.min(s, 600) * 1000 : 9000;
  })();
  // completed thereafter.

  const MOCK_SESSION_ID = 'mock-session-0001';
  const MOCK_GAME_STATUS = 'active';

  const MOCK_CATEGORIES = CATEGORIES.map(c => c.id);

  // REAL bank ids per type for the winning category (agentic-ai). Mixed shapes
  // so P4 exercises: mcq decoys→options, pillar True/False, spelling multi-word.
  const MOCK_PICKS = {
    numeric:   ['agentic-num-001'],
    word:      ['agentic-word-002'],
    statement: ['agentic-stmt-001', 'agentic-stmt-004'],
    spelling:  ['agentic-spell-002', 'agentic-spell-006'],
    mcq:       ['agentic-mcq-001', 'agentic-mcq-002'],
  };
  // Puzzle count = number of lock TYPES present (SSOT Q6) — do not hardcode 5.
  const MOCK_PUZZLE_COUNT = Object.keys(MOCK_PICKS).length;

  const mock = { claimAt: 0 };

  // Mock timeline anchor + "my" server-side progress persisted per-tab so a
  // reload continues the SAME session (lets refresh/resume be exercised offline).
  function mockClaimAt() {
    if (mock.claimAt) return mock.claimAt;
    try { const s = sessionStorage.getItem('sd_mock_claimAt'); if (s) { mock.claimAt = Number(s); return mock.claimAt; } } catch {}
    mock.claimAt = Date.now();
    try { sessionStorage.setItem('sd_mock_claimAt', String(mock.claimAt)); } catch {}
    return mock.claimAt;
  }
  function mockMyCompleted() {
    try { const s = sessionStorage.getItem('sd_mock_progress'); if (s != null) return Number(s); } catch {}
    return state.puzzlesCompleted || 0;
  }

  function mockPhase() {
    const now = Date.now();
    const claimAt = mockClaimAt();
    const t = now - claimAt;
    const sessionReady = t >= MOCK_SESSION_DELAY_MS;
    let stateName;
    if (t < MOCK_SETUP_MS) stateName = 'setup';
    else if (t < MOCK_SETUP_MS + MOCK_VOTING_MS) stateName = 'voting';
    else if (t < MOCK_SETUP_MS + MOCK_VOTING_MS + MOCK_PLAY_MS) stateName = 'in_progress';
    else stateName = 'completed';
    return { t, sessionReady, stateName };
  }

  function mockRoster(stateName) {
    // completion_pct: 0 in setup/voting; opponents grind during in_progress;
    // frozen at 100/partial in completed. "You" mirrors real progress.
    const ph = mockPhase();
    const playT = ph.t - (MOCK_SETUP_MS + MOCK_VOTING_MS);
    const pClamp = Math.max(0, Math.min(playT, MOCK_PLAY_MS));
    const clampPct = (v) => Math.max(0, Math.min(100, Math.round(v)));
    let mePct = 0, alicePct = 0, bobPct = 0;
    let meMs = 0, aliceMs = 0, bobMs = 0;
    if (stateName === 'in_progress') {
      mePct = clampPct((mockMyCompleted() / MOCK_PUZZLE_COUNT) * 100);
      alicePct = clampPct((playT / MOCK_PLAY_MS) * 120); // Alice pulls ahead
      bobPct   = clampPct((playT / MOCK_PLAY_MS) * 80);
      // Per-player elapsed_ms (matches live shape). YOUR clock only starts after
      // the first solve — mirrors the server (elapsed begins at first /progress).
      meMs = mockMyCompleted() > 0 ? pClamp : 0;
      aliceMs = pClamp; bobMs = pClamp;
    } else if (stateName === 'completed') {
      mePct = clampPct((mockMyCompleted() / MOCK_PUZZLE_COUNT) * 100);
      alicePct = 100; bobPct = 80; // Bob finishes <100% → DNF row
      meMs = mockMyCompleted() > 0 ? MOCK_PLAY_MS : 0;
      aliceMs = MOCK_PLAY_MS; bobMs = MOCK_PLAY_MS;
    }
    const meName = state.displayName || 'You';
    const rows = [
      { player_id: state.playerId || 'p-you', display_name: meName, seat_number: state.seatNumber || 1, completion_pct: mePct, elapsed_ms: meMs },
      { player_id: 'p-alice', display_name: 'Alice', seat_number: 2, completion_pct: alicePct, elapsed_ms: aliceMs },
      { player_id: 'p-bob',   display_name: 'Bob',   seat_number: 3, completion_pct: bobPct, elapsed_ms: bobMs },
    ];
    // Server rank order (SSOT §6): by completion desc. Rendered verbatim.
    rows.sort((a, b) => b.completion_pct - a.completion_pct);
    rows.forEach((r, i) => { r.rank = i + 1; });
    return rows;
  }

  function mockStandings() {
    const ph = mockPhase();
    const st = ph.stateName;
    const rows = mockRoster(st);
    const base = {
      session_id: MOCK_SESSION_ID,
      state: st,
      puzzle_count: MOCK_PUZZLE_COUNT,
      standings: rows,
      // NOTE: no top-level elapsed_ms — the deployed backend carries elapsed_ms
      // ONLY per row (standings[].elapsed_ms). Matching that here keeps the mock
      // an honest mirror and exercises the per-player clock path.
    };
    if (st === 'voting') {
      base.categories = MOCK_CATEGORIES;
      base.voting_window_sec = Math.round(MOCK_VOTING_MS / 1000);
      base.voting_started_at = new Date(mock.claimAt + MOCK_SETUP_MS).toISOString();
      base.voting = { tally: { 'agentic-ai': 2, 'security': 1 } };
      // Surface the winner in the last stretch so the reveal fires ON the vote
      // screen (before the state machine flips to in_progress).
      const votingEndsAt = mock.claimAt + MOCK_SETUP_MS + MOCK_VOTING_MS;
      if (Date.now() >= votingEndsAt - 2500) {
        base.winning_category = 'agentic-ai';
        base.voting.closed = true;
      }
    }
    if (st === 'in_progress' || st === 'completed') {
      base.winning_category = 'agentic-ai';
    }
    // Game clock fields (SSOT standings shape) — drive the peripheral clock-heat
    // bar during PLAY. The mock sweeps a 90s → 0 countdown across the short PLAY
    // window so BOTH the ramp AND the final-minute state are exercised offline.
    if (st === 'in_progress') {
      const playT = Math.max(0, ph.t - (MOCK_SETUP_MS + MOCK_VOTING_MS));
      const frac = Math.max(0, Math.min(1, playT / MOCK_PLAY_MS));
      base.game_remaining_sec = Math.max(0, Math.round(90 * (1 - frac)));
      base.is_final_minute = base.game_remaining_sec <= 60;
    } else if (st === 'completed') {
      base.game_remaining_sec = 0;
      base.is_final_minute = false;
    }
    if (st === 'completed') {
      base.winner_player_id = rows[0].player_id;
      base.end_reason = 'all_completed';
    }
    return base;
  }

  function mockJson(body, status) {
    return Promise.resolve(new Response(JSON.stringify(body), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json' },
    }));
  }
  function mockErr(status, code, message) {
    // Mirror the deployed FLAT error envelope: {"error":"<string>"} (confirmed
    // live 2026-09-22), not the older nested {code,message}.
    return mockJson({ error: message || code }, status);
  }

  function mockFetch(url, init) {
    let body = {};
    if (init && init.body) { try { body = JSON.parse(init.body); } catch { /* non-json */ } }

    // POST [A] /games/{game_id}/seats/claim {pin}
    if (url.indexOf('/seats/claim') !== -1) {
      if (MOCK_FAIL === 'badpin') return mockErr(403, 'invalid_pin', 'That PIN was not recognised.');
      mock.claimAt = Date.now();
      try { sessionStorage.setItem('sd_mock_claimAt', String(mock.claimAt)); sessionStorage.removeItem('sd_mock_progress'); } catch {}
      return mockJson({ seat_number: 1, seat_token: 'mock-seat-token-abc' });
    }
    // GET [A] /games/{game_id}/public
    if (url.indexOf('/public') !== -1) {
      const ph = mockPhase();
      return mockJson({
        status: MOCK_GAME_STATUS,
        current_session_id: ph.sessionReady ? MOCK_SESSION_ID : null,
        current_session_state: ph.stateName,
      });
    }
    // POST [S] /showdown/{session_id}/players (setup-only; 409 otherwise)
    if (url.indexOf('/players') !== -1) {
      // &mockfail=latejoin models a device that arrives after the lobby closed.
      if (MOCK_FAIL === 'latejoin') return mockErr(409, 'not_in_setup', 'The lobby has already closed.');
      const ph = mockPhase();
      if (ph.stateName !== 'setup') return mockErr(409, 'not_in_setup', 'The lobby has already closed.');
      return mockJson({
        session_id: MOCK_SESSION_ID,
        player_id: 'p-you',
        display_name: state.displayName || 'You',
        seat_number: 1,
        token: 'mock-write-token-xyz',
      });
    }
    // GET [S] /showdown/{session_id}/standings (~1s driver) — a READ, stays
    // healthy under &mockfail=auth so the superseded case surfaces on WRITES.
    if (url.indexOf('/standings') !== -1) {
      return mockJson(mockStandings());
    }
    // POST [S] /showdown/{session_id}/vote (P3). &mockfail=auth = superseded write.
    if (url.indexOf('/vote') !== -1) {
      if (MOCK_FAIL === 'auth') return mockErr(409, 'superseded', 'This seat was opened on another device.');
      const votingEndsAt = mockClaimAt() + MOCK_SETUP_MS + MOCK_VOTING_MS;
      const closed = Date.now() >= votingEndsAt - 2500;
      return mockJson({ voting_closed: closed, assignment: closed ? { winning_category: 'agentic-ai' } : undefined });
    }
    // GET [S] /showdown/{session_id}/puzzles (P4) — REAL bank ids
    if (url.indexOf('/puzzles') !== -1) {
      const picks = JSON.parse(JSON.stringify(MOCK_PICKS));
      if (MOCK_FAIL === 'bankid') picks.numeric = ['agentic-num-DOES-NOT-EXIST'];
      // &mockfail=badword models the backend serving a word id whose answer
      // word-lock cannot render (agentic-word-001 = "/spec", not alpha-only).
      // Exercises resolveBank's deterministic substitution instead of a dead race.
      if (MOCK_FAIL === 'badword') picks.word = ['agentic-word-001'];
      return mockJson({ winning_category: 'agentic-ai', picks: picks });
    }
    // POST [S] /showdown/{session_id}/progress (P4). &mockfail=auth = superseded.
    if (url.indexOf('/progress') !== -1) {
      if (MOCK_FAIL === 'auth') return mockErr(409, 'superseded', 'This seat was opened on another device.');
      if (typeof body.puzzles_completed === 'number') {
        try { sessionStorage.setItem('sd_mock_progress', String(body.puzzles_completed)); } catch {}
      }
      return mockJson({ ok: true });
    }
    return mockJson({ ok: true }); // unknown — succeed quietly
  }

  /* ── MOCK badge ──────────────────────────────────────────────── */
  function showMockBadge(text) {
    if (typeof document === 'undefined') return;
    let b = document.getElementById('sd-mock-badge');
    if (!b) {
      b = document.createElement('div');
      b.id = 'sd-mock-badge';
      // Styling lives in showdown.css (#sd-mock-badge). Setting inline anchors
      // here previously fought that rule's left/top and stretched the fixed
      // element to fill the viewport (a full-screen wash). Keep JS to DOM only.
      (document.body || document.documentElement).appendChild(b);
    }
    b.textContent = text || 'MOCK MODE';
  }

  /* ── fetch interceptor: mock ONLY on explicit ?mock=true, matched on the two
   *    API bases. No implicit fallback-to-mock on network error (deviation #4). */
  (function installFetchInterceptor() {
    const realFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const isApi = url.indexOf(BASE_A) !== -1 || url.indexOf(BASE_S) !== -1;
      if (MOCK && isApi) return mockFetch(url, init);
      if (!realFetch) return Promise.reject(new Error('fetch unavailable'));
      return realFetch(input, init); // real backend or same-origin asset; no fallback
    };
  })();

  /* ─────────────────────────── DOM utils ──────────────────────── */

  const $ = (id) => document.getElementById(id);

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const SCREEN_ENTER = {
    join:    'sd-enter-fade',
    lobby:   'sd-enter-slide-left',
    vote:    'sd-enter-fade',
    play:    'sd-enter-zoom',
    results: 'sd-enter-slide-up',
  };
  const ALL_ENTER_CLASSES = ['sd-enter-fade', 'sd-enter-slide-left', 'sd-enter-zoom', 'sd-enter-slide-up'];

  // Switch visible screen + (re)trigger its entrance animation. Idempotent per
  // screen: calling with the current screen is a no-op so the ~1s poll loop can
  // call the reducer every tick without restarting animations.
  function showScreen(name) {
    if (state.screen === name) return;
    state.screen = name;
    document.querySelectorAll('.sd-screen').forEach((s) => {
      s.hidden = s.id !== 'screen-' + name;
    });
    const el = $('screen-' + name);
    if (el) {
      ALL_ENTER_CLASSES.forEach((c) => el.classList.remove(c));
      const enter = SCREEN_ENTER[name];
      if (enter) { void el.offsetWidth; el.classList.add(enter); }
    }
  }

  /* ─────────────────────────── API layer ──────────────────────── */
  // JSON in/out; tokens travel in the BODY (SSOT §1). Errors surface the
  // {error:{code,message}} envelope with status attached.

  async function apiRequest(method, url, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    let data = {};
    try { data = await res.json(); } catch { /* empty / non-json */ }
    if (!res.ok) {
      // Error envelope is a FLAT string on the deployed backend
      // ({"error":"pin is required and must be a string"}), confirmed live
      // 2026-09-22. The older doc showed a nested {error:{code,message}}. Accept
      // BOTH so the real server message always reaches the UI (a flat string was
      // previously dropped, leaving only a generic "Request failed (400)").
      let msg = null, code = null;
      const e = data && data.error;
      if (typeof e === 'string') { msg = e; }
      else if (e && typeof e === 'object') { msg = e.message || null; code = e.code || null; }
      const err = new Error(msg || ('Request failed (' + res.status + ')'));
      err.status = res.status;
      err.code = code;
      err.data = data;
      throw err;
    }
    return data;
  }
  const apiGet  = (url) => apiRequest('GET', url);
  const apiPost = (url, body) => apiRequest('POST', url, body);

  // ── endpoint wrappers ──
  // v2: claim + public are on BASE_S (single-base rule).
  const claimSeat   = (gameId, pin) => apiPost(BASE_S + '/games/' + encodeURIComponent(gameId) + '/seats/claim', { pin });
  const getPublic   = (gameId) => apiGet(BASE_S + '/games/' + encodeURIComponent(gameId) + '/public');
  // v2 doc names the field `nickname`, but the deployed backend still REQUIRES
  // `display_name` (a nickname-only body 400s "display_name is required",
  // verified live 2026-09-18). Send BOTH so we satisfy the live contract and the
  // documented field name.
  const postPlayers = (sessionId, seatToken, displayName) =>
    apiPost(BASE_S + '/showdown/' + encodeURIComponent(sessionId) + '/players', { seat_token: seatToken, display_name: displayName, nickname: displayName });
  const getStandings = (sessionId) => apiGet(BASE_S + '/showdown/' + encodeURIComponent(sessionId) + '/standings');
  // P3/P4 wrappers (defined now; wired by later phases):
  const postVote     = (sessionId, playerId, category, token) =>
    apiPost(BASE_S + '/showdown/' + encodeURIComponent(sessionId) + '/vote', { player_id: playerId, category, token });
  const getPuzzles   = (sessionId) => apiGet(BASE_S + '/showdown/' + encodeURIComponent(sessionId) + '/puzzles');
  const postProgress = (sessionId, playerId, puzzlesCompleted, token) =>
    apiPost(BASE_S + '/showdown/' + encodeURIComponent(sessionId) + '/progress', { player_id: playerId, puzzles_completed: puzzlesCompleted, token });

  // Write retry (SSOT §11): 5xx / network blips retried up to 2× with jitter;
  // progress is cumulative so replays are idempotent-safe. A 409 is terminal
  // (superseded) — routed to handleSuperseded, never retried.
  function isRetryable(err) { return !err || err.status == null || err.status >= 500; }
  async function retryWrite(fn, label) {
    let attempt = 0;
    for (;;) {
      try { return await fn(); }
      catch (err) {
        if (err && err.status === 409) { handleSuperseded(label, err); throw err; }
        if (attempt >= 2 || !isRetryable(err)) throw err;
        attempt++;
        const jitter = (200 + Math.floor(Math.random() * 300)) * attempt;
        await new Promise((r) => setTimeout(r, jitter));
      }
    }
  }

  /* ────────────────────── Identity persistence (SSOT §7.5) ─────── */

  function persistIdentity() {
    try {
      localStorage.setItem(LS_IDENTITY, JSON.stringify({
        gameId: state.gameId,
        pin: state.pin,
        displayName: state.displayName,
        seatNumber: state.seatNumber,
        seatToken: state.seatToken,
        sessionId: state.sessionId,
        playerId: state.playerId,
        token: state.token,
        myVote: state.myVote,
        voteLocked: state.voteLocked,
      }));
    } catch { /* storage unavailable — non-fatal */ }
  }
  function loadIdentity() {
    try {
      const raw = localStorage.getItem(LS_IDENTITY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  function clearIdentity() {
    try { localStorage.removeItem(LS_IDENTITY); } catch {}
  }

  /* ════════════════════ Standings poll loop (P2, SSOT §6) ═════════
   * ONE self-scheduling ~1s setTimeout loop. Single in-flight lock, error
   * backoff 1→2→5s, paused while document.hidden (immediate poll on
   * visibilitychange), STOPS at state==completed. standings.state is the ONLY
   * screen driver — the client never advances locally.
   * ────────────────────────────────────────────────────────────── */

  let pollTimer = null;
  let pollInFlight = false;
  // BUGFIX (join race): the standings poll starts STOPPED and is only armed by
  // startPollLoop() after a successful /players join (or a rehydrated identity).
  // Previously this defaulted to false, so a routine visibilitychange during the
  // JOIN name step (common on mobile after a QR scan / tab switch) let the
  // visibilitychange handler call schedulePoll → getStandings with the
  // session_id discovered by the /public wait loop, and reduceToScreen jumped
  // straight to LOBBY ("Waiting for the host") WITHOUT ever POSTing /players —
  // so the backend never registered the player. Defaulting to true closes that
  // race: no standings poll until we have actually joined.
  let pollStopped = true;
  let backoffIdx = -1; // -1 = healthy (1s cadence); 0/1/2 index into BACKOFF_MS

  function startPollLoop() {
    stopPollLoop();
    pollStopped = false;
    schedulePoll(0); // fire immediately
  }
  function stopPollLoop() {
    pollStopped = true;
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (typeof stopPlayClock === 'function') stopPlayClock(); // halt the smoothed clock too
  }
  function schedulePoll(delay) {
    if (pollStopped) return;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(pollTick, delay);
  }

  async function pollTick() {
    pollTimer = null;
    if (pollStopped) return;
    // Never poll standings without a joined session (defense-in-depth for the
    // join race): the loop is only meaningful once /players has returned a
    // player_id. Without one we would query /showdown/undefined/standings.
    if (!state.sessionId || !state.playerId) { stopPollLoop(); return; }
    if (document.hidden) { schedulePoll(POLL_MS); return; }   // paused while hidden
    if (pollInFlight) { schedulePoll(POLL_MS); return; }      // guard re-entrancy
    pollInFlight = true;
    try {
      const standings = await getStandings(state.sessionId);
      state.standings = standings;
      backoffIdx = -1; // healthy again
      reduceToScreen(standings.state, standings);
      if (standings.state === 'completed') { stopPollLoop(); return; } // stop at completed
      schedulePoll(POLL_MS);
    } catch (err) {
      handlePollError(err);
    } finally {
      pollInFlight = false;
    }
  }

  function handlePollError(err) {
    // Superseded/closed (Q8): terminal — the seat was opened elsewhere.
    if (err && err.status === 409) { handleSuperseded('standings', err); return; }
    // Transient 5xx / network blip: keep the last render, show "Reconnecting…",
    // and back off (1→2→5s). Non-fatal.
    backoffIdx = Math.min(backoffIdx + 1, BACKOFF_MS.length - 1);
    const delay = BACKOFF_MS[backoffIdx];
    console.warn('[showdown] standings poll error (' + (err && (err.code || err.status || err.message)) +
      '), reconnecting in ' + delay + 'ms');
    showReconnecting();
    schedulePoll(delay);
  }

  // Show a non-destructive "Reconnecting…" note in the active screen's status
  // node without clobbering the rest of the render (the next success restores it).
  function showReconnecting() {
    if (state.screen === 'lobby') { const el = $('lobby-status'); if (el) el.textContent = 'Reconnecting\u2026'; }
    else if (state.screen === 'results') { const el = $('results-status'); if (el) el.textContent = 'Reconnecting\u2026'; }
    else if (state.screen === 'play') { const el = $('play-log'); if (el) el.textContent = 'Reconnecting\u2026'; }
    else if (state.screen === 'vote') {
      const h = document.querySelector('#screen-vote .sd-vote-head .sd-subtitle');
      if (h) h.textContent = 'Reconnecting\u2026';
    }
  }

  // Immediate poll when the tab becomes visible again.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && !pollStopped) {
      backoffIdx = -1;
      schedulePoll(0);
    }
  });

  /* ── Reducer: standings.state → HEAT screen (SSOT §6) ──────────── */
  // standings.state is the ONLY screen driver — the client never advances
  // locally. All four screens are fully wired (P2 lobby, P3 vote, P4 play, P5 results).
  function reduceToScreen(st, standings) {
    switch (st) {
      case 'setup':
        showScreen('lobby');
        renderLobby(standings);
        break;
      case 'voting':
        showScreen('vote');
        renderVote(standings);
        break;
      case 'in_progress':
        // Stamp the local clock anchor the first time we observe the race live, so
        // the header timer moves before the first solve (server elapsed_ms is 0
        // until the first /progress POST). Set once — never re-stamped.
        if (!state._raceAnchorAt) state._raceAnchorAt = Date.now();
        showScreen('play');
        enterPlay(standings);
        break;
      case 'completed':
        showScreen('results');
        renderResults(standings);
        break;
      default:
        console.warn('[showdown] unknown state from standings:', st);
    }
  }

  /* ══════════════════════════ SCREEN 1 · JOIN (P1) ════════════════ */

  // Reconfigure the shared #join-code input into a PIN field at runtime (SSOT
  // §9). We do NOT edit showdown.html — only its attributes/labels here.
  function configurePinInput() {
    const codeInput = $('join-code');
    if (codeInput) {
      codeInput.setAttribute('maxlength', String(PIN_LEN));
      /* No placeholder. The field is drawn as six character cells, so a centred
       * "PIN" string straddles the cell dividers and reads as a rendering fault on
       * the very first screen a walk-up participant sees. The "SEAT PIN" label
       * directly above already names the field and the aria-label below covers
       * assistive tech, so the placeholder carried no information. */
      codeInput.removeAttribute('placeholder');
      codeInput.setAttribute('inputmode', 'latin');
      codeInput.setAttribute('autocapitalize', 'characters');
      codeInput.setAttribute('pattern', '[' + PIN_ALPHABET + ']{' + PIN_LEN + '}');
      codeInput.setAttribute('aria-label', 'Seat PIN');
      // Live mask: uppercase + strip anything outside the PIN alphabet.
      codeInput.addEventListener('input', function () {
        const cleaned = codeInput.value.toUpperCase().split('')
          .filter((ch) => PIN_ALPHABET.indexOf(ch) !== -1)
          .join('').slice(0, PIN_LEN);
        if (codeInput.value !== cleaned) codeInput.value = cleaned;
      });
    }
    // Relabel the field (SSOT §9). The <label for="join-code"> text is updated
    // in place if present, without touching element ids.
    const label = document.querySelector('label[for="join-code"]');
    if (label) label.textContent = 'Seat PIN';
  }

  // JOIN is a small step machine (reordered from the old single form):
  //   resolve game_id → PIN claim (only if needed) → waiting-for-session landing
  //   → name entry (always empty) → join.
  // getReusableIdentity / hidePinField / unhidePinField / ensureGameCodeField /
  // extractGameId / joinErrorMessage below are REUSED (not duplicated); the old
  // runIdentityFlow + discoverAndJoin are replaced by this explicit sequence.
  let joinReusable = null;   // stored identity usable for THIS game_id (seat already held)
  let joinWaitTimer = null;  // /public poll timer for the waiting-for-session landing
  let joinWaitTick = 0;      // drives the live "waiting" status so it never reads frozen
  // BUGFIX (join never fires): the name step now OWNS the join. pendingJoinName
  // holds the name the player entered; nameJoinTimer is a light /public
  // readiness poll used ONLY when the session is not join-ready yet, so the join
  // auto-fires the instant a setup session appears instead of silently bouncing
  // back to the waiting screen. joinInFlight guards against overlapping POSTs.
  let pendingJoinName = null;
  let nameJoinTimer = null;
  let nameJoinTick = 0;
  let joinInFlight = false;

  function initJoin() {
    showScreen('join');
    configurePinInput();

    // CHANGE 3 (show-once): a valid stored seat_token for THIS game_id means the
    // PIN was already claimed on a prior visit. Skip the PIN box entirely and go
    // straight to the waiting-for-session landing, which auto-advances to the
    // name step the moment a session is live.
    joinReusable = getReusableIdentity();
    if (joinReusable) {
      state.seatToken = joinReusable.seatToken;
      if (joinReusable.seatNumber != null) state.seatNumber = joinReusable.seatNumber;
      if (joinReusable.pin) state.pin = joinReusable.pin;
      persistIdentity();
      renderWaitingStep(); // seat held → resolve session, then empty name entry
      return;
    }

    // No reusable seat → collect the PIN (and, ONLY if game_id is unknown
    // everywhere, the inline table link/code) before claiming.
    renderCredsStep();
  }

  // Toggle the name field (never disabled — dropping `required` keeps the
  // :has() arm-glow honest while the field is hidden).
  function showNameField(show) {
    const input = $('join-name');
    if (input) {
      input.hidden = !show;
      if (show) { input.setAttribute('required', 'required'); input.removeAttribute('aria-hidden'); input.tabIndex = 0; }
      else { input.removeAttribute('required'); input.setAttribute('aria-hidden', 'true'); input.tabIndex = -1; }
    }
    const label = document.querySelector('label[for="join-name"]');
    if (label) label.hidden = !show;
  }

  function removeGameCodeField() {
    const input = $('join-gamecode'); if (input) input.remove();
    const label = document.querySelector('label[for="join-gamecode"]'); if (label) label.remove();
  }
  function removeWaitingPanel() {
    const panel = $('join-waiting'); if (panel) panel.remove();
    const screen = $('screen-join'); if (screen) screen.classList.remove('sd-attract-mode');
  }
  // Show/hide the submit button RELIABLY. `.sd-btn { display:inline-block }` has
  // the same specificity as the UA `[hidden]{display:none}` and loads later, so
  // the `hidden` attribute alone does NOT hide it — drive inline display too.
  function showJoinButton(show) {
    const btn = $('join-btn');
    if (!btn) return;
    btn.hidden = !show;
    btn.style.display = show ? '' : 'none';
  }

  // STEP 1 — credentials: the PIN (always, since no valid stored seat) plus the
  // game-code field. CHANGE 1 (BUGFIX): when game_id is KNOWN (URL/storage/id)
  // the field is SHOWN, POPULATED with the game_id, and READ-ONLY so the player
  // can see which game they are joining (previously it was removed). When the
  // game_id is unknown, the field stays an editable inline prompt to paste the
  // table link / code.
  function renderCredsStep() {
    const form = $('join-form');
    const errEl = $('join-error');
    const btn = $('join-btn');
    clearSessionWaitLoop();
    clearNameJoinLoop();
    removeWaitingPanel();
    showNameField(false);   // name is collected AFTER a session is live
    unhidePinField();       // PIN visible for the claim
    ensureGameCodeField(form);
    if (!state.gameId) {
      setGameCodeReadonly(false);
      if (errEl && !errEl.textContent) errEl.textContent = 'No table code detected. Paste your table link or game code above, or open this page from your table\u2019s QR.';
    } else {
      setGameCodeReadonly(true); // populated + read-only (shows the game being joined)
      persistGameId(state.gameId);
    }
    if (btn) { btn.disabled = false; btn.textContent = 'Continue'; }
    showJoinButton(true);
    if (form) form.onsubmit = onCredsSubmit;
    const focusEl = !state.gameId ? $('join-gamecode') : $('join-code');
    if (focusEl && typeof focusEl.focus === 'function') focusEl.focus();
  }

  // Validate the PIN by CLAIMING the seat (claim works WITHOUT a session). On
  // success the seat_token is persisted, so the PIN box is not shown again for
  // this game; a 403 / flat error re-shows the PIN box with an inline prompt
  // (CHANGE 3). The form is never disabled/dead.
  async function onCredsSubmit(e) {
    e.preventDefault();
    const errEl = $('join-error');
    const btn = $('join-btn');
    if (errEl) errEl.textContent = '';

    // Resolve game_id from the inline field if it was unknown.
    if (!state.gameId) {
      const gc = $('join-gamecode');
      const parsed = gc ? extractGameId(gc.value) : null;
      if (parsed) { state.gameId = parsed; persistGameId(parsed); }
    }
    if (!state.gameId) {
      if (errEl) errEl.textContent = 'Enter your table link or game code (or open this page from your table\u2019s QR).';
      const gc = $('join-gamecode'); if (gc) gc.focus();
      return;
    }

    const pin = $('join-code').value.trim().toUpperCase();
    if (!PIN_RE.test(pin)) {
      if (errEl) errEl.textContent = 'PIN must be 6 characters (letters and numbers).';
      const code = $('join-code'); if (code) code.focus();
      return;
    }

    btn.disabled = true;
    const btnText = btn.textContent;
    btn.textContent = 'Checking\u2026';
    try {
      const claim = await claimSeat(state.gameId, pin);
      state.pin = pin;
      state.seatNumber = claim.seat_number != null ? claim.seat_number : null;
      state.seatToken = claim.seat_token || null;
      persistIdentity();
      renderWaitingStep(); // seat held → waiting landing → empty name entry
    } catch (err) {
      // Invalid PIN / claim failure → RE-SHOW the PIN box with a clear prompt.
      if (errEl) errEl.textContent = joinErrorMessage(err, 'claim');
      btn.disabled = false;
      btn.textContent = btnText;
      const code = $('join-code'); if (code) { code.focus(); if (code.select) code.select(); }
    }
  }

  // STEP 2 — waiting-for-session LANDING. It is valid to hold a claimed seat
  // before the host starts a session; poll GET /public (~POLL_MS) until a
  // session is live, then advance to name entry. A dedicated live panel (NOT a
  // frozen "Joining…" button) built at runtime from existing chrome classes;
  // the submit button is hidden here.
  function renderWaitingStep() {
    const form = $('join-form');
    const btn = $('join-btn');
    const errEl = $('join-error');
    clearNameJoinLoop();
    pendingJoinName = null;
    showNameField(false);
    hidePinField();
    removeGameCodeField();
    if (btn) btn.disabled = false;
    showJoinButton(false);
    if (errEl) errEl.textContent = '';
    if (form) form.onsubmit = (e) => { e.preventDefault(); }; // no manual submit while waiting
    buildWaitingPanel();
    startSessionWaitLoop();
  }

  // WAITING = the ported "VS Select" arcade ATTRACT screen (replaces the old
  // plain spinner panel). Built at runtime inside #screen-join (no showdown.html
  // edits): re:Solve crest, neon SHOWDOWN wordmark (Press Start 2P), dashed
  // coral rule, blinking "STARTING NEW SESSION" prompt, subtitle, and a live
  // "waiting for host" foot (id join-waiting-status, driven by
  // updateWaitingStatus). Adding .sd-attract-mode hides the base hero + card so
  // the attract screen owns the viewport. Motion is reduced-motion gated in CSS.
  function buildWaitingPanel() {
    const screen = $('screen-join');
    if (!screen || $('join-waiting')) return;
    screen.classList.add('sd-attract-mode');

    const root = document.createElement('div');
    root.id = 'join-waiting';
    root.className = 'sdl-attract';

    const core = document.createElement('div');
    core.className = 'sdl-attract-core';

    const crest = document.createElement('img');
    crest.className = 'sdl-crest';
    crest.src = 'showdown/resolve-logo.png';
    crest.alt = 're:Solve';

    const logo = document.createElement('div');
    logo.className = 'sdl-attract-logo';
    // Optional event-name eyebrow (◆ RESOLVE EVENT) above the wordmark, matching
    // the reference attract markup. Rendered only when a host-set event_name is
    // present; otherwise it stays hidden (parity with the reference default).
    if (EVENT_NAME) {
      const eyebrow = document.createElement('span');
      eyebrow.className = 'sdl-eventname';
      const dia = document.createElement('span');
      dia.className = 'dia';
      dia.setAttribute('aria-hidden', 'true');
      dia.textContent = '\u25c6'; // ◆
      eyebrow.appendChild(dia);
      eyebrow.appendChild(document.createTextNode(' ' + EVENT_NAME));
      logo.appendChild(eyebrow);
    }
    const title = document.createElement('span');
    title.className = 'sdl-attract-title';
    title.textContent = 'SHOWDOWN';
    logo.appendChild(title);

    const rule = document.createElement('div');
    rule.className = 'sdl-attract-rule';
    rule.setAttribute('aria-hidden', 'true');

    const prompt = document.createElement('p');
    prompt.className = 'sdl-attract-prompt';
    prompt.setAttribute('role', 'status');
    prompt.setAttribute('aria-live', 'polite');
    // \u25b8 / \u25c2 = arrow brackets, \u00b7 = middot. No em dashes.
    prompt.innerHTML = '\u25b8 <span class="b">STARTING NEW SESSION</span> \u25c2';

    const sub = document.createElement('p');
    sub.className = 'sdl-attract-sub';
    sub.textContent = state.seatNumber != null
      ? ('Seat ' + state.seatNumber + ' secured \u00b7 First to finish wins')
      : 'First to finish wins \u00b7 Grab a seat and stand by';

    core.appendChild(crest);
    core.appendChild(logo);
    core.appendChild(rule);
    core.appendChild(prompt);
    core.appendChild(sub);

    const foot = document.createElement('p');
    foot.className = 'sdl-attract-foot';
    foot.id = 'join-waiting-status';
    foot.setAttribute('role', 'status');
    foot.setAttribute('aria-live', 'polite');
    foot.textContent = 'Waiting for the host to start the round';

    root.appendChild(core);
    root.appendChild(foot);
    screen.appendChild(root);
  }

  function updateWaitingStatus(reconnecting) {
    const status = $('join-waiting-status');
    if (!status) return;
    if (reconnecting) { status.textContent = 'Reconnecting\u2026'; return; }
    const dots = '.'.repeat(1 + (joinWaitTick % 3));
    status.textContent = 'Waiting for the host to start the session' + dots;
  }

  function clearSessionWaitLoop() {
    if (joinWaitTimer) { clearTimeout(joinWaitTimer); joinWaitTimer = null; }
  }

  // A session is joinable once /public reports a current_session_id in a
  // pre/live state (setup/voting/in_progress). An id present with an unknown
  // state is treated as joinable; a completed state keeps us waiting for the
  // next round.
  function isJoinableSession(pub) {
    if (!pub || !pub.current_session_id) return false;
    const s = pub.current_session_state;
    if (!s) return true;
    return s === 'setup' || s === 'voting' || s === 'in_progress';
  }

  function startSessionWaitLoop() {
    clearSessionWaitLoop();
    joinWaitTick = 0;
    const attempt = async () => {
      joinWaitTimer = null;
      try {
        const pub = await getPublic(state.gameId);
        if (isJoinableSession(pub)) {
          state.sessionId = pub.current_session_id;
          clearSessionWaitLoop();
          renderNameStep();
          return;
        }
        joinWaitTick++;
        updateWaitingStatus(false);
      } catch (err) {
        // Transient /public blip — keep the landing alive and retry (SSOT §6).
        console.warn('[showdown] /public wait error (' + (err && (err.status || err.message)) + '); retrying');
        updateWaitingStatus(true);
      }
      joinWaitTimer = setTimeout(attempt, POLL_MS);
    };
    attempt(); // fire immediately (advances instantly when a session is already live)
  }

  // STEP 3 — name entry + JOIN. The name input ALWAYS renders EMPTY (CHANGE 2:
  // no prefill). This step OWNS the join: on submit we capture the name and fire
  // POST /players. If the session is not join-ready yet (no session_id, or the
  // round already advanced past setup), we do NOT bounce back to the waiting
  // screen — we keep the name entry, show an inline status, and auto-fire the
  // join the instant a joinable (setup) session appears.
  function renderNameStep() {
    const form = $('join-form');
    const btn = $('join-btn');
    const errEl = $('join-error');
    clearSessionWaitLoop();
    clearNameJoinLoop();
    removeWaitingPanel();
    hidePinField();
    removeGameCodeField();
    showNameField(true);
    const nameInput = $('join-name');
    if (nameInput) {
      nameInput.value = ''; // ALWAYS empty for the participant to key in
      // Cap at NAME_MAX at runtime (showdown.html ships maxlength="20", which
      // overflows the race lane and the podium plates). Attribute-only change —
      // same pattern as the #join-code PIN reconfiguration above.
      nameInput.setAttribute('maxlength', String(NAME_MAX));
      nameInput.setAttribute('placeholder', 'e.g. Alex (max ' + NAME_MAX + ')');
    }
    pendingJoinName = null;
    joinInFlight = false;
    if (btn) { btn.disabled = false; btn.textContent = 'Join Session'; }
    showJoinButton(true);
    if (errEl) errEl.textContent = '';
    if (form) form.onsubmit = onNameSubmit;
    if (nameInput && typeof nameInput.focus === 'function') nameInput.focus();
  }

  // Submit just captures the name and defers to tryFireJoin (single join path).
  function onNameSubmit(e) {
    e.preventDefault();
    const errEl = $('join-error');
    // Trim, collapse runs of whitespace, then hard-cap — belt and braces behind
    // the maxlength attribute, which a paste or an autofill can still outrun.
    const name = $('join-name').value.trim().replace(/\s+/g, ' ').slice(0, NAME_MAX);
    if (!name) { if (errEl) errEl.textContent = 'Please enter your name.'; return; }
    if (errEl) errEl.textContent = '';
    state.displayName = name;
    pendingJoinName = name;
    tryFireJoin();
  }

  // The ONE place that POSTs /players. Fires immediately when a session_id is
  // known; otherwise arms the readiness poll so the join auto-fires the moment a
  // joinable session appears. Never silently bounces to the waiting screen.
  async function tryFireJoin() {
    if (joinInFlight || !pendingJoinName) return;
    const errEl = $('join-error');
    const btn = $('join-btn');
    if (!state.sessionId) {
      // No live session yet: keep the name, wait for one (no bounce).
      startNameJoinLoop('Waiting for the host to open the lobby');
      return;
    }
    joinInFlight = true;
    if (btn) { btn.disabled = true; btn.textContent = 'Joining\u2026'; }
    try {
      const p = await postPlayers(state.sessionId, state.seatToken, pendingJoinName);
      state.playerId = p.player_id || null;
      state.token = p.token || null;
      if (p.seat_number != null) state.seatNumber = p.seat_number;
      if (p.display_name) state.displayName = p.display_name;
      persistIdentity();
      clearNameJoinLoop();
      pendingJoinName = null;
      joinInFlight = false;
      startPollLoop(); // single standings poll after a successful join
    } catch (err) {
      joinInFlight = false;
      if (btn) { btn.disabled = false; btn.textContent = 'Join Session'; }
      // A stale/rejected seat_token (403/404): the stored seat no longer works.
      // Fall back to a fresh PIN claim (never leave a dead form).
      if (err && (err.status === 403 || err.status === 404)) {
        clearNameJoinLoop();
        pendingJoinName = null;
        joinReusable = null;
        state.seatToken = null;
        renderCredsStep();
        if (errEl) errEl.textContent = 'Please re-enter your seat PIN.';
        return;
      }
      // 409: /players is SETUP-stage only, so the round already advanced (lobby
      // closed). Surface a clear status and KEEP polling — if the host opens a
      // fresh setup session we auto-fire the join. No silent bounce.
      if (err && err.status === 409) {
        startNameJoinLoop('The lobby has closed. Waiting for the host to open the next round');
        return;
      }
      // Transient error: keep the name, show the reason, and retry via the poll.
      if (errEl) errEl.textContent = joinErrorMessage(err, 'join');
      startNameJoinLoop('Reconnecting');
    }
  }

  function clearNameJoinLoop() {
    if (nameJoinTimer) { clearTimeout(nameJoinTimer); nameJoinTimer = null; }
  }

  // Readiness poll used ONLY while a name is pending but the session is not
  // join-ready. Polls GET /public; when a session in the SETUP stage is present
  // (the only stage /players accepts), it auto-fires the join. Runs a live
  // "waiting" status so the screen never reads frozen. No em dashes in copy.
  function startNameJoinLoop(statusMsg) {
    clearNameJoinLoop();
    nameJoinTick = 0;
    const paint = () => {
      const errEl = $('join-error');
      if (errEl) errEl.textContent = statusMsg + '.'.repeat(1 + (nameJoinTick % 3));
    };
    paint();
    const attempt = async () => {
      nameJoinTimer = null;
      if (!pendingJoinName) return; // name cleared (left the step) — stop quietly
      try {
        const pub = await getPublic(state.gameId);
        if (pub && pub.current_session_id) state.sessionId = pub.current_session_id;
        const s = pub && pub.current_session_state;
        // Fire only when the session can accept a join (setup). An unknown state
        // with a live session id is treated as joinable (best effort).
        const joinReady = pub && pub.current_session_id && (!s || s === 'setup');
        if (joinReady && pendingJoinName && !joinInFlight) {
          clearNameJoinLoop();
          tryFireJoin();
          return;
        }
      } catch (err) {
        // Transient /public blip — keep waiting and retry.
      }
      nameJoinTick++;
      paint();
      nameJoinTimer = setTimeout(attempt, POLL_MS);
    };
    nameJoinTimer = setTimeout(attempt, POLL_MS);
  }

  // CHANGE 4 helpers ─────────────────────────────────────────────
  // A reusable identity = a stored seat_token whose gameId matches the current
  // game_id. Lets "Play again" show only the name field and skip the claim.
  function getReusableIdentity() {
    if (!state.gameId) return null;
    const saved = loadIdentity();
    if (saved && saved.gameId === state.gameId && saved.seatToken) return saved;
    return null;
  }
  // Hide (never disable) the PIN field + its label. Dropping `required` keeps the
  // :has(#join-code:valid) arm-glow working with only the name filled.
  function hidePinField() {
    const codeInput = $('join-code');
    if (codeInput) {
      codeInput.hidden = true;
      codeInput.removeAttribute('required');
      codeInput.setAttribute('aria-hidden', 'true');
      codeInput.tabIndex = -1;
    }
    const label = document.querySelector('label[for="join-code"]');
    if (label) label.hidden = true;
  }
  // Restore the PIN field for a normal claim (recovery when a stored seat fails).
  function unhidePinField() {
    const codeInput = $('join-code');
    if (codeInput) {
      codeInput.hidden = false;
      codeInput.setAttribute('required', 'required');
      codeInput.removeAttribute('aria-hidden');
      codeInput.tabIndex = 0;
    }
    const label = document.querySelector('label[for="join-code"]');
    if (label) label.hidden = false;
  }

  /* ── Display names: cap length, disambiguate collisions ─────────────
   * The backend enforces NO uniqueness on display_name, so two players can both
   * be "Alex". Identity is always keyed on player_id (never on the name), but a
   * duplicated label is unreadable on the race strip and the podium.
   *
   * We disambiguate with the seat_number the backend already returns from
   * /seats/claim — "ALEX S2" is meaningful at a booth (it names the physical
   * seat) where a random suffix would not be. The suffix is added ONLY to names
   * that actually collide, so a unique name is never decorated.
   *
   * Pass the full standings rows so the collision set is computed per render. */
  function dupNameIds(rows) {
    const seen = Object.create(null);
    const dup = Object.create(null);
    (rows || []).forEach((r) => {
      const k = String(r && r.display_name || '').trim().toLowerCase();
      if (!k) return;
      if (seen[k]) dup[k] = true;
      seen[k] = true;
    });
    return dup;
  }

  // `dup` is the map from dupNameIds(rows); omit it to skip disambiguation.
  function sdName(row, dup) {
    const raw = String(row && row.display_name || '').trim();
    let out = raw.slice(0, NAME_MAX);
    if (dup && raw && dup[raw.toLowerCase()]) {
      const seat = row && row.seat_number;
      if (seat != null && seat !== '') out += ' S' + seat;
    }
    return out;
  }

  // Map claim/players errors to inline copy (SSOT §6/§9). `context` = 'claim'
  // (PIN step) or 'join' (name step) so a 409 reads correctly for each. We never
  // surface the raw server string for 403/404/409 (the live claim-409 text
  // carries an em-dash); the fallback strips em/en dashes to keep rendered
  // strings dash-clean.
  function stripDashes(s) { return s ? String(s).replace(/[\u2014\u2013]/g, '-').trim() : s; }
  function joinErrorMessage(err, context) {
    if (!err) return 'Could not join. Please try again.';
    if (err.status === 403) return 'That PIN wasn\u2019t recognised. Check your table card and try again.';
    if (err.status === 409) {
      return context === 'claim'
        ? 'This seat is already claimed. Ask the host to reset it, then try again.'
        : 'The lobby has already closed for this session.';
    }
    if (err.status === 404) return 'Seat not found. Check your table card and try again.';
    return stripDashes(err.message) || 'Could not join. Please try again.';
  }

  // Parse a game_id from a pasted full URL (…?game=<id>) or a bare id/code.
  // Returns null for an empty value or a URL that carries no game param.
  function extractGameId(raw) {
    const v = (raw || '').trim();
    if (!v) return null;
    const m = v.match(/[?&]game=([^&#\s]+)/i);
    if (m) return decodeURIComponent(m[1]);
    if (/^https?:\/\//i.test(v)) return null; // a link without ?game= is unusable
    return v; // treat a bare token as the id/code
  }

  // Inject a "table link / game code" input at the top of the JOIN form when the
  // URL had no ?game= (runtime DOM only — no showdown.html edits). Reuses the
  // existing .sd-label / .sd-input styling so it matches the form, and never
  // disables the name/PIN inputs.
  function ensureGameCodeField(form) {
    if (!form || $('join-gamecode')) return;
    const label = document.createElement('label');
    label.className = 'sd-label';
    label.setAttribute('for', 'join-gamecode');
    label.textContent = 'Table link or game code';
    const input = document.createElement('input');
    input.className = 'sd-input';
    input.id = 'join-gamecode';
    input.type = 'text';
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('placeholder', 'Paste your table link');
    // Clear the "missing code" hint as soon as a usable value is supplied.
    input.addEventListener('input', () => {
      const errEl = $('join-error');
      if (errEl && extractGameId(input.value)) errEl.textContent = '';
    });
    form.insertBefore(input, form.firstChild);
    form.insertBefore(label, input);
  }

  // CHANGE 1 (BUGFIX): drive the game-code field between its two states without
  // touching showdown.html. READ-ONLY = game_id is known: populate it with the
  // exact game_id, mark it readonly + aria-readonly, style it muted/inset (via
  // .sd-input--readonly in showdown.css) so it plainly reads as display-only,
  // and take it out of the tab order. EDITABLE = game_id unknown: restore the
  // "paste your table link" prompt so the player can supply it.
  function setGameCodeReadonly(readonly) {
    const input = $('join-gamecode');
    if (!input) return;
    const label = document.querySelector('label[for="join-gamecode"]');
    if (readonly) {
      input.value = state.gameId || '';
      input.readOnly = true;
      input.setAttribute('readonly', 'readonly');
      input.setAttribute('aria-readonly', 'true');
      input.classList.add('sd-input--readonly');
      input.removeAttribute('placeholder');
      input.tabIndex = -1;
      if (label) label.textContent = 'Joining game';
    } else {
      input.readOnly = false;
      input.removeAttribute('readonly');
      input.removeAttribute('aria-readonly');
      input.classList.remove('sd-input--readonly');
      input.setAttribute('placeholder', 'Paste your table link');
      input.tabIndex = 0;
      if (label) label.textContent = 'Table link or game code';
    }
  }

  /* ── Identity flow: claim → /public poll → /players (SSOT §3) ──── */

  // NOTE: the old runIdentityFlow + discoverAndJoin (claim + a coupled /public
  // poll that immediately POSTed /players and repurposed the JOIN button as a
  // frozen "Waiting for host…" label) are REPLACED by the step machine above:
  // renderCredsStep (claim) → renderWaitingStep (startSessionWaitLoop polls
  // /public) → renderNameStep (POST /players) → startPollLoop.

  /* ══════════════════════════ SCREEN 2 · LOBBY (P2, SSOT §6) ══════ */
  // Roster from standings[] at 0% during setup (Q3). #lobby-code banner shows
  // "Seat N"; the share-code hint is removed (others join via QR). #ready-btn
  // becomes a disabled "Waiting for the host" (no ready endpoint exists).

  let lobbyChromeReady = false;
  function initLobbyChrome() {
    if (lobbyChromeReady) return;
    lobbyChromeReady = true;
    // Banner → "Seat N".
    const codeLabel = document.querySelector('#screen-lobby .sd-code-label');
    if (codeLabel) codeLabel.textContent = 'Your seat';
    const codeVal = $('lobby-code');
    if (codeVal) codeVal.textContent = state.seatNumber != null ? ('Seat ' + state.seatNumber) : 'Seat -';
    // Remove the "share this code" hint (no code to share; QR-based join).
    const codeHint = document.querySelector('#screen-lobby .sd-code-hint');
    if (codeHint) codeHint.hidden = true;
    // Ready button → disabled "Waiting for the host".
    const ready = $('ready-btn');
    if (ready) {
      ready.disabled = true;
      ready.textContent = 'Waiting for the host\u2026';
      ready.onclick = null;
      ready.classList.remove('sd-btn--ready');
    }
    // Hint copy.
    const hint = $('lobby-hint');
    if (hint) hint.textContent = 'The host starts the round when everyone\u2019s seated.';
  }

  function renderLobby(standings) {
    initLobbyChrome();
    const codeVal = $('lobby-code');
    if (codeVal && state.seatNumber != null) codeVal.textContent = 'Seat ' + state.seatNumber;

    const roster = (standings && Array.isArray(standings.standings)) ? standings.standings : [];
    renderRoster(roster);

    const statusEl = $('lobby-status');
    if (statusEl) {
      statusEl.textContent = roster.length === 1
        ? 'Waiting for players\u2026 (1 seated)'
        : roster.length + ' players seated';
    }
  }

  // Roster keyed by player_id (SSOT §7 deviation #1: identity by player_id, not
  // display_name — two "Alex"es must not collide). Completion% shown (0% in
  // setup); the penalty column is retired.
  function renderRoster(roster) {
    const list = $('lobby-players');
    if (!list) return;
    // Seat presence shown as a VS Select status-badge (uppercase word + 7px
    // square marker), not a 0% readout — in the lobby nobody has progress yet,
    // so occupancy is the honest signal. Identity stays keyed by player_id.
    const dup = dupNameIds(roster);
    list.innerHTML = roster.map((p) => {
      const isMe = state.playerId && p.player_id === state.playerId;
      return '<li class="sd-player' + (isMe ? ' sd-player--me' : '') + '" data-pid="' + escapeHtml(p.player_id || '') + '">' +
        '<span class="sd-player-name">' + escapeHtml(sdName(p, dup)) + (isMe ? ' (you)' : '') + '</span>' +
        '<span class="sd-player-ready is-seated">Seated</span>' +
        '</li>';
    }).join('');
  }

  /* ══════════════════════════ SCREEN 3 · VOTE (P3, SSOT §6) ═══════ */
  // Ballot from standings.categories[] (ids → labels/icons via CAT_BY_ID/SD_ICONS
  // into #vote-grid). Countdown: voting_window_sec is TOTAL, anchored at
  // voting_started_at (Q9). Live tally from standings.voting.tally. Ballot locks
  // after the first ACCEPTED vote (Q10). Reveal via winning_category (standings)
  // or the assignment returned by the vote that closed voting. The state machine
  // advances to in_progress — we NEVER resolve locally.

  const VOTE_RING_CIRC = 131.95; // 2π·21, matches r in the #vote-timer SVG
  let voteBallotIds = null;      // ids currently rendered in the grid

  function renderVote(standings) {
    const cats = (standings && Array.isArray(standings.categories)) ? standings.categories : [];
    // CHANGE 1: set the base VOTE subtitle at render time. Set BEFORE
    // updateVoteCountdown so that during closing/tally the countdown's
    // "Tallying votes…" (and the reveal) still win — the new copy never
    // overwrites it. No em-dash: exact period-separated string.
    if (!state.revealed) {
      const headEl = document.querySelector('#screen-vote .sd-vote-head .sd-subtitle');
      if (headEl) headEl.textContent = 'Pick your target. Choose the topic you know best!';
    }
    // (Re)build the ballot when the category set changes.
    const key = cats.join(',');
    if (voteBallotIds !== key) {
      voteBallotIds = key;
      buildBallot(cats);
    }
    updateTally(standings);
    updateVoteCountdown(standings);

    // Reveal (once) — from standings.winning_category if the backend surfaces it.
    if (!state.revealed && standings && standings.winning_category) {
      revealWinner(standings.winning_category);
    }
  }

  function buildBallot(catIds) {
    const grid = $('vote-grid');
    const empty = $('vote-empty');
    if (!grid) return;
    if (!catIds.length) {
      grid.innerHTML = '';
      if (empty) { empty.hidden = false; empty.textContent = 'Waiting for the host to open voting\u2026'; }
      return;
    }
    if (empty) empty.hidden = true;
    grid.innerHTML = catIds.map((id) => {
      const cat = CAT_BY_ID[id] || { label: id };
      const selected = state.myVote === id ? ' is-selected' : '';
      return '<button type="button" class="sd-cat-btn' + selected + '" data-cat="' + escapeHtml(id) + '">' +
        '<span class="sd-cat-icon">' + iconSvg(id) + '</span>' +
        '<span class="sd-cat-label">' + escapeHtml(cat.label) + '</span>' +
        '<span class="sd-cat-tally" data-tally="' + escapeHtml(id) + '"></span>' +
        '</button>';
    }).join('');
    grid.querySelectorAll('.sd-cat-btn').forEach((btn) => {
      btn.onclick = () => castVote(btn.dataset.cat);
    });
    applyBallotLock();
  }

  function applyBallotLock() {
    const grid = $('vote-grid');
    if (!grid) return;
    grid.querySelectorAll('.sd-cat-btn').forEach((b) => {
      b.classList.toggle('is-selected', b.dataset.cat === state.myVote);
      if (state.voteLocked) b.setAttribute('disabled', 'disabled');
      else b.removeAttribute('disabled');
    });
  }

  function castVote(catId) {
    if (state.voteLocked || state.revealed) return; // one locked vote (Q10)
    state.myVote = catId;
    applyBallotLock();
    retryWrite(() => postVote(state.sessionId, state.playerId, catId, state.token), 'vote')
      .then((res) => {
        state.voteLocked = true; // lock only after an ACCEPTED vote
        persistIdentity();       // remember the vote for refresh recovery (P6)
        applyBallotLock();
        // Reveal if this vote closed voting and carried the assignment.
        const winner = res && (res.winning_category ||
          (res.assignment && (res.assignment.winning_category || res.assignment.category ||
            (typeof res.assignment === 'string' ? res.assignment : null))));
        if ((res && res.voting_closed) && winner && !state.revealed) revealWinner(winner);
      })
      .catch((err) => {
        if (err && err.status === 409) return; // superseded (terminal) handled in retryWrite
        // Not accepted — keep selection but allow a retry.
        state.voteLocked = false;
        applyBallotLock();
      });
  }

  function updateTally(standings) {
    const grid = $('vote-grid');
    if (!grid) return;
    const tally = (standings && standings.voting && standings.voting.tally) || {};
    Object.keys(tally).forEach((id) => {
      const el = grid.querySelector('[data-tally="' + CSS.escape(id) + '"]');
      if (el) { const n = Number(tally[id]) || 0; el.textContent = n > 0 ? String(n) : ''; }
    });
  }

  // remaining = voting_window_sec − (now − voting_started_at); floored at 0.
  function updateVoteCountdown(standings) {
    const wrap = $('vote-timer');
    const num = $('vote-timer-num');
    const windowSec = Number(standings && standings.voting_window_sec);
    const startedAt = standings && standings.voting_started_at ? Date.parse(standings.voting_started_at) : NaN;
    let remaining = null;
    if (!isNaN(windowSec) && !isNaN(startedAt)) {
      remaining = Math.max(0, windowSec - (Date.now() - startedAt) / 1000);
    }
    if (remaining == null) { if (num) num.textContent = '\u2013'; return; }

    const secs = Math.ceil(remaining);
    if (num) num.textContent = state.revealed ? '\u2713' : String(secs);
    const ring = wrap && wrap.querySelector('.sd-timer-ring-fg');
    if (ring && windowSec > 0) {
      const fracLeft = Math.max(0, Math.min(1, remaining / windowSec));
      ring.style.strokeDasharray = String(VOTE_RING_CIRC);
      ring.style.strokeDashoffset = String(VOTE_RING_CIRC * (1 - fracLeft));
    }
    if (wrap) wrap.classList.toggle('is-urgent', secs <= 5 && secs > 0 && !state.revealed);

    // Expiry with no winner yet: show a waiting message rather than stalling.
    // We do NOT advance — the state machine drives the flip to in_progress.
    if (remaining <= 0 && !state.revealed) {
      const empty = $('vote-empty');
      if (empty && !$('vote-grid').children.length) {
        empty.hidden = false; empty.textContent = 'Waiting for the host\u2026';
      }
      const head = document.querySelector('#screen-vote .sd-vote-head .sd-subtitle');
      if (head) head.textContent = 'Tallying votes\u2026';
    }
  }

  function revealWinner(catId) {
    if (state.revealed) return;
    state.revealed = true;
    state.winningCategory = catId;
    const cat = CAT_BY_ID[catId] || { label: catId };
    const iconEl = $('reveal-icon');
    if (iconEl) iconEl.innerHTML = iconSvg(catId);
    const nameEl = $('reveal-name');
    if (nameEl) nameEl.textContent = cat.label;
    const overlay = $('vote-reveal');
    if (overlay) {
      overlay.hidden = false;
      overlay.classList.remove('is-in');
      void overlay.offsetWidth;
      overlay.classList.add('is-in');
    }
    applyBallotLock();
    // No local advance: the ~1s standings loop flips to PLAY when state==in_progress.
  }

  /* ══════════════════════════ SCREEN 4 · PLAY (P4, SSOT §5 + §6) ══ */
  // On in_progress: one-time GET /puzzles (idempotent) → resolveBank(picks,
  // winning_category, session_id) → validate ALL slots → mountPuzzle() per slot.
  // Race lanes = puzzle_count dots keyed by player_id; solved dots =
  // round(completion_pct/100 × puzzle_count). Authoritative time = elapsed_ms
  // (the play clock is cosmetic). POST /progress (cumulative) after each solve.
  // No penalty/attempt calls (Showdown has no penalties).

  const TYPE_ORDER = ['numeric', 'word', 'statement', 'spelling', 'mcq'];
  const GENERIC_KEYPAD_FALSE = ['That code doesn\u2019t open this vault.'];

  let playChromeReady = false;
  let playLoadStarted = false;

  function enterPlay(standings) {
    if (!playChromeReady) {
      playChromeReady = true;
      // Fresh play session: reset the clock anchor so a re-entered round (or a
      // rehydrated resume) starts its monotonic guard clean.
      state._clockSrvMs = null; state._clockAt = 0; state._clockShownMs = null;
      initPlayChrome();
      startPlayClock();
    }
    if (!playLoadStarted) {
      playLoadStarted = true;
      loadPuzzles();
    }
    updatePlay(standings); // per-tick: race lanes + authoritative clock
  }

  function initPlayChrome() {
    // Retire the penalty stat (Showdown has no penalties now) — keep the node.
    const pen = $('play-penalties');
    if (pen) { const stat = pen.closest('.sd-stat'); if (stat) stat.style.display = 'none'; }
    attachPressSfx();   // delegated press cue for whichever lock is mounted
    mountMuteToggle();  // booth staff must be able to silence a machine in one tap
    const q = $('play-question');
    if (q) q.textContent = '';
    // Clear the HTML placeholder "Puzzle 1 of 5" so a non-5 puzzle_count round
    // never flashes a wrong count before the first renderPuzzle().
    const ptext = $('play-progress-text');
    if (ptext) ptext.textContent = '';
    const mount = $('play-mount');
    if (mount) mount.innerHTML = '<div class="sd-loading">Assembling puzzles\u2026</div>';
  }

  // One-time (idempotent) puzzle load + resolve + validate. Safe to call again
  // from a Retry or on refresh.
  async function loadPuzzles() {
    const mount = $('play-mount');
    if (mount) mount.innerHTML = '<div class="sd-loading">Assembling puzzles\u2026</div>';
    try {
      await loadBank();
      const data = await getPuzzles(state.sessionId); // idempotent GET
      const winning = data && data.winning_category;
      const picks = (data && data.picks) || {};
      const { slots, errors } = resolveBank(picks, winning, state.sessionId);
      if (errors.length) { renderPuzzleErrors(errors); return; }
      // Cross-check resolved slot count against standings.puzzle_count (Q6).
      const pc = state.standings && state.standings.puzzle_count;
      if (pc != null && pc !== slots.length) {
        console.warn('[showdown] puzzle_count mismatch: standings=' + pc + ' resolved=' + slots.length);
      }
      state.puzzles = slots;
      console.info('[showdown] resolved ' + slots.length + ' puzzle slots: ' +
        slots.map((s) => s.ui).join(', '));

      // Resume point (P6 dev #5): on a mid-race refresh, jump to where the
      // server says we are — round(my completion_pct/100 × puzzle_count).
      const myRow = (state.standings && Array.isArray(state.standings.standings))
        ? state.standings.standings.find((r) => r.player_id === state.playerId) : null;
      const denom = slots.length || 1;
      let resume = myRow ? Math.round((Number(myRow.completion_pct) || 0) / 100 * denom) : 0;
      resume = Math.max(0, Math.min(resume, slots.length));
      state.puzzlesCompleted = resume;
      state.puzzleIndex = Math.min(resume, slots.length - 1);
      if (resume >= slots.length) {
        // Already finished everything — spectate until the server flips to completed.
        enterFinishedWaiting(standings);
      } else {
        if (resume > 0) console.info('[showdown] resuming at puzzle ' + (resume + 1) + '/' + slots.length);
        renderPuzzle();
      }
    } catch (err) {
      if (err && err.status === 409) { handleSuperseded('puzzles', err); return; }
      renderPuzzleLoadError(err);
    }
  }

  /* ── Bank resolver (SSOT §5) ───────────────────────────────────── */
  // Canonical order numeric→word→statement→spelling→mcq. numeric/word take ONE
  // question each (one slot per id); statement/spelling/mcq aggregate their ids
  // into a single lock. Returns { slots, errors } — every bad id is reported.

  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }
  const bad = (category, type, id, reason) => ({ category, type, id, reason });

  /* ── word-lock playability + deterministic substitution ─────────────
   * word-lock renders one A-Z reel per character, so its answer MUST be
   * alpha-only and <= 8 characters. Several live bank entries are not
   * (awscore-word-001 "EC2", awscore-word-002 "S3", agentic-word-001 "/spec",
   * cloudf-word-002 "On-prem").
   *
   * Previously such a pick pushed an error, and loadPuzzles() replaces the WHOLE
   * race with an error panel on any error — so one unusable word ID killed all
   * five puzzles, and its Retry re-fetched the same IDs and failed identically.
   * With 2 of 13 word entries unusable in aws-core-services that is roughly a
   * 1-in-7 dead race, which at a booth is a visible failure with no recovery.
   *
   * So: substitute a playable word from the SAME category instead. The choice is
   * seeded from session_id + the original id, exactly like resolveStatement's
   * True/False side, so every device in the race substitutes identically and the
   * race stays fair. Only if the category has no playable word at all do we fall
   * back to erroring, which is then genuinely unplayable rather than a coin flip.
   *
   * The durable fix is still backend-side (constrain the word slot's eligible ids
   * at resolve time); this keeps the event safe until that lands. */
  const WORD_OK_RE = /^[A-Za-z]{1,8}$/;
  const wordPlayable = (entry) => !!entry && WORD_OK_RE.test(String(entry.answer || ''));

  /* Generic deterministic substitution for ANY type.
   *
   * A pick the engine cannot use — id missing from the bank (bank/backend drift),
   * or content a lock cannot render — used to push an error, and loadPuzzles()
   * replaces the WHOLE race with an error panel on any error whose Retry refetches
   * the same ids. So a single bad pick of any type was an unrecoverable dead race.
   *
   * Substituting a usable entry of the same type from the same category keeps the
   * race alive. Seeded from session_id + the original id, exactly like
   * resolveStatement's True/False side, so every device in the race substitutes
   * IDENTICALLY and the race stays fair. `usable` filters to entries the relevant
   * lock can actually render. Returns null only when the category genuinely has no
   * usable entry of that type, which is then a real error rather than a coin flip.
   *
   * `excludeId` avoids picking the very entry we rejected. */
  function substituteEntry(type, origId, category, sessionId, usable, excludeId) {
    const bucket = (BANK_INDEX && BANK_INDEX[category]) || {};
    const m = bucket[type];
    if (!m || typeof m.forEach !== 'function') return null;
    const candidates = [];
    m.forEach((entry, id) => {
      if (id === excludeId) return;
      if (!usable || usable(entry)) candidates.push({ id, entry });
    });
    if (!candidates.length) return null;
    candidates.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); // stable order
    return candidates[fnv1a(String(sessionId) + String(origId)) % candidates.length];
  }

  const substituteWord = (origId, category, sessionId) =>
    substituteEntry('word', origId, category, sessionId, wordPlayable, origId);

  /* "Usable" per type — the minimum each lock needs to render. Mirrors the
   * validation each branch already performs, so a substitute can never itself be
   * rejected downstream. */
  const nonEmpty = (v) => v !== undefined && v !== null && String(v).trim() !== '';
  // Must match the numeric branch's own guard (1-6 digits) exactly. A looser
  // predicate would let a substitute pass selection and then fail validation
  // downstream, pushing the very error the substitution exists to avoid. No bank
  // entry violates this today, so this is guarding against a future bank edit.
  const numericUsable   = (e) => !!e && /^\d{1,6}$/.test(String(e.answer));
  const spellingUsable  = (e) => !!e && nonEmpty(e.answer);
  const statementUsable = (e) => !!e && /\{[^|}]*\|[^|}]*\}/.test(String(e.template || ''));
  const mcqUsable = (e) => {
    if (!e || e.answer == null) return false;
    const opts = Array.isArray(e.options) ? e.options
      : (Array.isArray(e.decoys) ? [e.answer].concat(e.decoys) : null);
    return !!opts && opts.length >= 2 && opts.indexOf(e.answer) !== -1;
  };

  /* Try a deterministic substitution; push an error and return null only if the
   * category has nothing usable. Keeps each call site to a few lines. */
  function subOrNull(type, id, category, sessionId, usable, errors, errType) {
    const sub = substituteEntry(type, id, category, sessionId, usable, id);
    if (!sub) {
      errors.push(bad(category, errType, id,
        'not found in bank, and no usable substitute in category'));
      return null;
    }
    console.warn('[showdown] ' + type + ' pick ' + id +
      ' missing from bank — substituting ' + sub.id);
    return sub.entry;
  }

  function resolveBank(picks, winningCategory, sessionId) {
    const slots = [];
    const errors = [];
    const bucket = (BANK_INDEX && BANK_INDEX[winningCategory]) || {};
    const lookup = (type, id) => {
      const m = bucket[type];
      if (m && m.has(id)) return m.get(id);
      const flat = BANK_FLAT && BANK_FLAT.get(id); // tolerate category drift; validated below
      return flat ? flat.entry : null;
    };

    TYPE_ORDER.forEach((type) => {
      const ids = Array.isArray(picks[type]) ? picks[type] : [];
      if (!ids.length) return;

      if (type === 'numeric') {
        ids.forEach((id) => {
          let e = lookup('numeric', id);
          if (!e) {
            const sub = subOrNull('numeric', id, winningCategory, sessionId, numericUsable, errors, type);
            if (!sub) return;
            e = sub;
          }
          if (!/^\d{1,6}$/.test(String(e.answer))) {
            errors.push(bad(winningCategory, type, id, 'answer not 1\u20136 digits')); return;
          }
          // A unit is appended to the QUESTION text, never the answer.
          const q = e.question + (e.unit ? ' (in ' + e.unit + ')' : '');
          slots.push({ id, ui: 'keypad-lock', category: winningCategory, type, question: q,
            config: { answer: String(e.answer), falseOutputs: GENERIC_KEYPAD_FALSE.slice() } });
        });

      } else if (type === 'word') {
        ids.forEach((id) => {
          const e = lookup('word', id);
          let entry = e;
          let useId = id;
          // A missing id, or an answer word-lock physically cannot render, now swaps
          // in a playable word from the same category instead of killing the race.
          // Deterministic, so every device in the race gets the SAME substitute.
          if (!entry || !wordPlayable(entry)) {
            const sub = substituteWord(id, winningCategory, sessionId);
            if (!sub) {
              errors.push(bad(winningCategory, type, id, entry
                ? 'word not alpha \u22648: "' + String(entry.answer || '') + '" and no playable substitute in category'
                : 'not found in bank, and no playable substitute in category'));
              return;
            }
            console.warn('[showdown] word pick ' + id + ' unplayable (' +
              (entry ? JSON.stringify(entry.answer) : 'missing') + ') \u2014 substituting ' +
              sub.id + ' (' + JSON.stringify(sub.entry.answer) + ')');
            entry = sub.entry;
            useId = sub.id;
          }
          slots.push({ id: useId, ui: 'word-lock', category: winningCategory, type,
            question: entry.question || '', config: { answer: String(entry.answer) } });
        });

      } else if (type === 'statement') {
        const statements = [];
        ids.forEach((id) => {
          let e = lookup('statement', id);
          if (!e) {
            const sub = subOrNull('statement', id, winningCategory, sessionId, statementUsable, errors, type);
            if (!sub) return;
            e = sub;
          }
          const r = resolveStatement(e, sessionId);
          if (r.error) { errors.push(bad(winningCategory, type, id, r.error)); return; }
          statements.push({ text: r.text, answer: r.answer });
        });
        if (statements.length) {
          // immediateWrong: penalise each wrong sort as it happens. Defaults off in
          // the component, so the episodes using pillar-lock keep the original
          // end-of-sequence behaviour. wrongHoldMs matches WRONG_LOCK_SEC so the
          // wrong card stays visible for the whole lockout.
          slots.push({ id: 'statement:' + ids.join(','), ui: 'pillar-lock', category: winningCategory,
            type, question: 'Sort each statement into True or False.',
            config: { pillars: ['True', 'False'], statements,
                      immediateWrong: true, wrongHoldMs: (WRONG_LOCK_SEC * 1000) + 200 } });
        }

      } else if (type === 'spelling') {
        const words = [];
        ids.forEach((id) => {
          let e = lookup('spelling', id);
          if (!e) {
            const sub = subOrNull('spelling', id, winningCategory, sessionId, spellingUsable, errors, type);
            if (!sub) return;
            e = sub;
          }
          const w = String(e.answer || '');
          if (!w) { errors.push(bad(winningCategory, type, id, 'empty spelling answer')); return; }
          words.push(w); // explicit deterministic order (picks[] order), NOT pool+pickCount
        });
        if (words.length) {
          // Showdown opts into all three spelling-lock affordances. They default
          // off in the component, so the episodes using it are unaffected.
          // clickSlotToReturn is REQUIRED alongside keepOnWrong: once a wrong word
          // fills every slot the pool is empty, so returning a letter is the only
          // way to correct it.
          slots.push({ id: 'spelling:' + ids.join(','), ui: 'spelling-lock', category: winningCategory,
            type, question: 'Unscramble each answer.',
            config: { title: 'SPELL IT OUT', words, sequential: true, scrambleLetters: true,
                      clickSlotToReturn: true, keepOnWrong: true, upperCase: true } });
        }

      } else if (type === 'mcq') {
        const questions = [];
        ids.forEach((id) => {
          let e = lookup('mcq', id);
          if (!e) {
            const sub = subOrNull('mcq', id, winningCategory, sessionId, mcqUsable, errors, type);
            if (!sub) return;
            e = sub;
          }
          const answer = e.answer;
          // Two bank shapes: options:[4] as-is, OR answer + decoys[3].
          const options = Array.isArray(e.options)
            ? e.options.slice()
            : (answer != null && Array.isArray(e.decoys) ? [answer].concat(e.decoys) : null);
          if (answer == null || !options || options.length < 2 || options.indexOf(answer) === -1) {
            errors.push(bad(winningCategory, type, id, 'mcq missing answer or <2 options')); return;
          }
          questions.push({ question: e.question || '', options, answer });
        });
        if (questions.length) {
          slots.push({ id: 'mcq:' + ids.join(','), ui: 'wager-lock', category: winningCategory, type,
            question: 'Answer each question to reach the target.',
            config: {
              target: questions.length, questions,
              // Single tier: Showdown has no stake CHOICE and no penalties, so this is
              // informational only. Colour moved off the episode-era #eab308 onto the
              // VS Select warning hue; wager/penalty/showOptions untouched because they
              // drive the component's target logic and how many options are revealed.
              stakes: [{ label: 'Confident', wager: 1, penalty: 0, color: '#ffb020', showOptions: 4 }],
              revealAnswerOnWrong: false, repeatOnWrong: true,
            } });
        }
      }
    });

    return { slots, errors };
  }

  // Resolve a statement template to ONE deterministic side (Q4). Only the chosen
  // fragment ever enters the DOM. Prefer explicit correct/wrong fields
  // (vnaws-stmt-002 anomaly); else the slot's index-0 fragment is the True one.
  function resolveStatement(entry, sessionId) {
    const tpl = entry.template || '';
    const m = tpl.match(/\{([^}]*)\|([^}]*)\}/);
    if (!m) return { error: 'no {a|b} slot in template' };
    let trueFrag, falseFrag;
    if (typeof entry.correct === 'string' && typeof entry.wrong === 'string') {
      trueFrag = entry.correct; falseFrag = entry.wrong;
    } else {
      trueFrag = m[1]; falseFrag = m[2];
    }
    if (trueFrag == null || falseFrag == null) return { error: 'cannot determine true/false fragment' };
    const side = fnv1a(String(sessionId) + entry.id) & 1; // 0 → True, 1 → False
    const frag = side === 0 ? trueFrag : falseFrag;
    return { text: tpl.replace(m[0], frag), answer: side === 0 ? 'True' : 'False' };
  }

  /* ── Puzzle rendering + mounting ───────────────────────────────── */

  function renderPuzzle() {
    const puzzle = state.puzzles[state.puzzleIndex];
    if (!puzzle) return;
    const total = state.puzzles.length;
    const n = state.puzzleIndex + 1;
    const ptext = $('play-progress-text');
    if (ptext) ptext.textContent = 'Puzzle ' + n + ' of ' + total;
    const fill = $('play-progress-fill');
    if (fill) fill.style.width = ((n - 1) / total * 100) + '%';
    const log = $('play-log'); if (log) log.textContent = '';
    const q = $('play-question'); if (q) q.textContent = puzzle.question || '';

    const mount = $('play-mount');
    if (!mount) return;
    clearWrongLockout(); // drop any lingering lockout before swapping puzzles
    mount.innerHTML = '';
    state.instance = mountPuzzle(mount, puzzle, {
      onSolved: onPuzzleSolved,
      onWrong: onPuzzleWrong,
    });

    /* Puzzle swaps were a hard cut: one lock vanished and the next appeared in the
     * same frame, which is the clearest "unfinished" tell in a game's motion. A
     * single short enter (VS Select's 160-180ms range) makes the sequence feel
     * authored. Applied to the MOUNT, not the components, so it covers all five and
     * touches nothing shared. Re-triggered by removing the class and forcing a
     * reflow, because the class is already present from the previous puzzle.
     * Reduced motion is handled in CSS — the class becomes a no-op. */
    mount.classList.remove('sd-mount-enter');
    void mount.offsetWidth;
    mount.classList.add('sd-mount-enter');

    // The question above it is part of the same beat, so it moves with the puzzle.
    if (q) {
      q.classList.remove('sd-q-enter');
      void q.offsetWidth;
      q.classList.add('sd-q-enter');
    }
  }

  // Construct the right lock component (mirrors puzzle-test-showdown.html).
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
            onSubmit: (word, correct) => correct ? hooks.onSolved() : hooks.onWrong('Wrong word: ' + word),
          });
        // NOTE: these mounts pass an EXPLICIT field whitelist, not the whole cfg.
        // Any new component option must be added here too or it silently never
        // arrives — the component sees undefined and falls back to its default.
        case 'pillar-lock':
          return new PillarLock(mount, {
            pillars: cfg.pillars,
            statements: cfg.statements,
            immediateWrong: cfg.immediateWrong,   // penalise each wrong sort at once
            wrongHoldMs: cfg.wrongHoldMs,
            onSubmit: () => hooks.onSolved(),
            onWrong: (m) => hooks.onWrong(m),
          });
        case 'spelling-lock':
          return new SpellingLock(mount, {
            title: cfg.title,
            words: cfg.words,
            sequential: cfg.sequential,
            scrambleLetters: cfg.scrambleLetters,
            clickSlotToReturn: cfg.clickSlotToReturn, // click a slot to return a letter
            keepOnWrong: cfg.keepOnWrong,             // don't wipe the whole attempt
            upperCase: cfg.upperCase,
            onSubmit: () => hooks.onSolved(),
            onWrong: (m) => hooks.onWrong(m),
          });
        case 'wager-lock':
          return new WagerLock(mount, {
            target: cfg.target,
            questions: cfg.questions,
            stakes: cfg.stakes,
            revealAnswerOnWrong: cfg.revealAnswerOnWrong,
            repeatOnWrong: cfg.repeatOnWrong,
            onSubmit: () => hooks.onSolved(),
            onWrong: (m) => hooks.onWrong(m),
          });
        default:
          mount.innerHTML = '<div class="sd-error">Unknown puzzle type: ' + escapeHtml(puzzle.ui || 'undefined') + '</div>';
          return null;
      }
    } catch (err) {
      mount.innerHTML = '<div class="sd-error">Failed to build this puzzle: ' + escapeHtml(err.message || String(err)) + '</div>';
      return null;
    }
  }

  // Wrong attempt: cosmetic only (no penalty count, no /attempt call, NO POST).
  // Feature 2: impose a ~5s local lockout on the current puzzle, then re-enable
  // so the player retries. There is no backend penalty concept — the only cost
  // is that server-side elapsed_ms keeps running. Applies uniformly to all 5
  // lock types because every one already surfaces its wrong signal through the
  // onWrong/onSubmit hooks showdown.js passes at mount time (no component edit).
  function onPuzzleWrong(msg) {
    playSfxWrong();
    const log = $('play-log');
    if (log) log.textContent = msg ? '\u26a0 ' + msg : '\u26a0 Try again';
    startWrongLockout();
  }

  /* ── 5-second wrong-answer lockout (Feature 2, showdown.js-only) ──
   * Gates input on the mounted puzzle for ~5s with a ticking countdown, then
   * re-enables. Blocks BOTH pointer (scrim overlay) and keyboard (`inert` on the
   * puzzle content). Purely local UX — no network call is made on a wrong answer.
   * Reduced-motion safe: the countdown is a plain number updating each second. */
  const WRONG_LOCK_SEC = 5;
  let wrongLocked = false;
  let wrongTimer = null;

  /* The scrim lives in a runtime-inserted shell that WRAPS #play-mount, and
   * `inert` is set on #play-mount ITSELF rather than on its children.
   *
   * Why: several lock components re-render by clearing the mount's innerHTML on a
   * wrong answer — wager-lock.js:148 (`container.innerHTML = ''`, reached via
   * _render() at :129, immediately after onWrong at :94) and spelling-lock.js:84
   * (re-render at +300ms). An overlay appended INTO the mount was destroyed
   * milliseconds after being created, and per-child `inert` flags were dropped
   * along with the replaced children. That is why mcq appeared never to pause and
   * spelling paused only briefly.
   *
   * The shell is a sibling wrapper no component ever touches, so the scrim
   * survives any number of re-renders and covers exactly the puzzle area — the
   * question above it stays readable during the pause. Puzzle progress is
   * untouched; this gates input only. Built at runtime (no showdown.html edits). */
  function lockoutHost() {
    const mount = $('play-mount');
    if (!mount) return null;
    let shell = mount.parentElement;
    if (!shell || !shell.classList.contains('sd-mount-shell')) {
      shell = document.createElement('div');
      shell.className = 'sd-mount-shell';
      mount.parentNode.insertBefore(shell, mount);
      shell.appendChild(mount);
    }
    return shell;
  }

  function clearWrongLockout() {
    wrongLocked = false;
    if (wrongTimer) { clearInterval(wrongTimer); wrongTimer = null; }
    const host = lockoutHost();
    if (host) {
      const ov = host.querySelector('.sd-lockout');
      if (ov) ov.remove();
    }
    const mount = $('play-mount');
    if (mount) { mount.classList.remove('sd-locked'); mount.inert = false; }
  }

  function startWrongLockout() {
    const mount = $('play-mount');
    const host = lockoutHost();
    if (!mount || !host || wrongLocked) return;   // ignore repeat wrongs while locked
    wrongLocked = true;
    // `inert` on the mount itself survives the component clearing its children.
    mount.inert = true;
    mount.classList.add('sd-locked');
    const ov = document.createElement('div');
    ov.className = 'sd-lockout';
    ov.setAttribute('role', 'status');
    host.appendChild(ov);
    let rem = WRONG_LOCK_SEC;
    const paint = () => { ov.textContent = 'Wrong. Try again in ' + rem + 's'; };
    paint();
    wrongTimer = setInterval(() => {
      rem -= 1;
      if (rem <= 0) { clearWrongLockout(); }
      else { paint(); playSfxLockTick(); } // make the pause audible, not just visible
    }, 1000);
  }

  function onPuzzleSolved() {
    clearWrongLockout(); // a correct answer clears any residual lockout
    playSfxCorrect();
    const flash = $('play-solved-flash');
    if (flash) { flash.classList.add('is-on'); setTimeout(() => flash.classList.remove('is-on'), 900); }
    if (window.SDFx) SDFx.burst();

    // A5 — punchier SOLVE: a quick lime overexpose + scale beat on YOUR race
    // lane, riding alongside the existing spark burst (reduced-motion guarded).
    const racePanel = $('play-progress-panel');
    const meLane = racePanel && racePanel.querySelector('.sd-pg-player--me');
    if (meLane) pulseOnce(meLane, 'sd-pg-solved', 600);

    // Cumulative progress (SSOT §6/Q7 — server clamps [0,puzzle_count]).
    state.puzzlesCompleted += 1;
    retryWrite(() => postProgress(state.sessionId, state.playerId, state.puzzlesCompleted, state.token), 'progress')
      .catch(() => { /* 409 → terminal (handled in retryWrite); 5xx exhausted → non-fatal */ });

    const last = state.puzzleIndex >= state.puzzles.length - 1;
    const fill = $('play-progress-fill');
    if (fill) fill.style.width = ((state.puzzleIndex + 1) / state.puzzles.length * 100) + '%';

    if (last) {
      playSfxGameComplete();
      // Do NOT advance to RESULTS locally — the standings loop flips at completed.
      // Let the full-screen SOLVED flash finish first: it sits at z-index 40 over
      // the mount, so rendering the spectator card underneath it immediately means
      // the player reads their finishing time through a giant word. Set the flag
      // now so the per-poll refresh is armed, but reveal the card once the
      // celebration clears (flash is 900ms; see onPuzzleSolved above).
      state._finishedWaiting = true;
      const q = $('play-question');
      if (q) q.textContent = 'All five locks cracked. You’re in — watching the rest of the race…';
      setTimeout(() => enterFinishedWaiting(state._lastStandings), 950);
    } else {
      setTimeout(() => { state.puzzleIndex += 1; renderPuzzle(); }, 700);
    }
  }

  // Report every bad id at once (SSOT §5). Retry re-GETs /puzzles (idempotent).
  function renderPuzzleErrors(errors) {
    const mount = $('play-mount');
    if (!mount) return;
    const items = errors.map((e) =>
      '<li>' + escapeHtml(e.category) + ' / ' + escapeHtml(e.type) + ' / ' +
      escapeHtml(e.id) + ': ' + escapeHtml(e.reason) + '</li>').join('');
    mount.innerHTML = '<div class="sd-error">Some puzzles couldn\u2019t be prepared:' +
      '<ul>' + items + '</ul>' +
      '<button type="button" class="sd-btn sd-btn--primary" id="sd-puzzle-retry">Retry</button></div>';
    const retry = $('sd-puzzle-retry');
    if (retry) retry.onclick = () => { loadPuzzles(); };
  }

  function renderPuzzleLoadError(err) {
    const mount = $('play-mount');
    if (!mount) return;
    mount.innerHTML = '<div class="sd-error">Could not load puzzles' +
      (err && err.message ? ': ' + escapeHtml(err.message) : '') + '.' +
      ' <button type="button" class="sd-btn sd-btn--primary" id="sd-puzzle-retry">Retry</button></div>';
    const retry = $('sd-puzzle-retry');
    if (retry) retry.onclick = () => { loadPuzzles(); };
  }

  /* ── Per-tick PLAY updates: authoritative clock + race lanes ───── */

  /* ── Race-strip competitive cues (visual only; reduced-motion guarded) ──
   * Layered on top of the existing renderRace() --solved slide. Every cue is a
   * short, one-shot, transform/opacity beat added then auto-removed so it can
   * re-fire on the next qualifying poll. prefersReducedMotion() is the single
   * guard reused everywhere (mirrors the CSS @media collapse). */
  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function pulseOnce(el, cls, ms) {
    if (!el || prefersReducedMotion()) return;
    el.classList.remove(cls);
    void el.offsetWidth;              // restart the animation if still mid-flight
    el.classList.add(cls);
    clearTimeout(el['_sdt_' + cls]);
    el['_sdt_' + cls] = setTimeout(() => el.classList.remove(cls), ms);
  }

  // B — CLOCK HEAT: the peripheral bottom heat bar (frozen during PLAY) is
  // allowed a RESTRAINED reaction to the game clock — faster breathe + brighter
  // as time runs out, a stronger (still restrained) state in the final minute.
  // The ember bed + vault grain STAY frozen; only this one edge bar reacts.
  // Driven by standings.game_remaining_sec / is_final_minute (SSOT shape).
  const HEAT_RAMP_SEC = 120; // begin intensifying under 2 minutes remaining
  function updateClockHeat(standings) {
    const bar = document.querySelector('.sd-heatbar');
    if (!bar) return;
    const remaining = (standings && typeof standings.game_remaining_sec === 'number')
      ? standings.game_remaining_sec : null;
    const finalMin = !!(standings && standings.is_final_minute) ||
      (remaining != null && remaining <= 60);
    let level = 0; // 0 = calm … 1 = hot
    if (remaining != null && remaining <= HEAT_RAMP_SEC) {
      level = Math.max(0, Math.min(1, (HEAT_RAMP_SEC - remaining) / HEAT_RAMP_SEC));
    }
    if (finalMin) level = Math.max(level, 0.82);
    // level → breathe duration (calm 8s → hot ~2.2s), opacity band + soft glow.
    bar.style.setProperty('--sd-heat-dur', (8 - level * 5.8).toFixed(2) + 's');
    bar.style.setProperty('--sd-heat-lo', (0.30 + level * 0.20).toFixed(3));
    bar.style.setProperty('--sd-heat-hi', (0.55 + level * 0.42).toFixed(3));
    bar.style.setProperty('--sd-heat-glow', Math.round(level * 10) + 'px');
    bar.classList.toggle('sd-heat-live', level > 0.001);
    bar.classList.toggle('sd-heat-final', finalMin);
  }

  function updatePlay(standings) {
    state._lastStandings = standings; // so the spectator card can render off-poll
    setPlayClockFromServer(myElapsedMs(standings)); // authoritative + smoothed clock
    updateClockHeat(standings);
    renderRace(standings);
    // Refresh the spectator card only once it EXISTS. The first render is deferred
    // behind the SOLVED flash (see onPuzzleSolved), and a ~1s poll landing inside
    // that window would otherwise render it early and undo the deferral.
    if (state._finishedWaiting && document.querySelector('#play-mount .sd-spectate')) {
      renderFinishedWaiting(standings);
    }
  }

  /* ── Finished-and-waiting: spectate, don't stare at a dead string ──────
   * Reached when you have cracked all 5 locks but the round is still running (the
   * client NEVER advances to RESULTS locally — the standings loop flips at
   * `completed`). This is a competitive race, not a co-op crew, so the old
   * "Waiting for the crew…" was wrong on both counts: wrong relationship, and it
   * gave a finished player nothing to look at for what can be a long wait.
   *
   * The live race strip above stays on and keeps updating, so here we add the
   * information a finished racer actually wants: their locked-in time, their
   * provisional position, and who is still going. Marked PROVISIONAL because
   * final rank is the server's call at `completed`. Re-rendered every poll. */
  function renderFinishedWaiting(standings) {
    const mount = $('play-mount');
    if (!mount) return;
    const rows = (standings && Array.isArray(standings.standings)) ? standings.standings : [];
    const dup = dupNameIds(rows);
    const me = rows.find((r) => state.playerId && r.player_id === state.playerId);
    const myPos = me && me.rank != null ? Number(me.rank) : null;
    /* Count and list OTHERS only. We reach this state from local knowledge that all
     * five locks are solved, but the server's completion_pct for our own row lags
     * the final /progress POST by up to a poll — so filtering on pct alone showed
     * the player who just finished as one of the racers still going, chasing
     * themselves at 80%. Our own row is finished by definition here. */
    const others = rows.filter((r) => !state.playerId || r.player_id !== state.playerId);
    const still = others.filter((r) => (Number(r.completion_pct) || 0) < 100).length;

    const ord = (n) => {
      if (n == null) return null;
      const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
      return n + (s[(v - 20) % 10] || s[v] || s[0]);
    };

    const myTime = me && typeof me.elapsed_ms === 'number' && me.elapsed_ms > 0
      ? fmtTime(me.elapsed_ms) : (state._clockShownMs != null ? fmtTime(state._clockShownMs) : null);

    // Opponents still racing, nearest-first, so the threat is at the top.
    const chasers = others
      .filter((r) => (Number(r.completion_pct) || 0) < 100)
      .sort((a, b) => (Number(b.completion_pct) || 0) - (Number(a.completion_pct) || 0))
      .map((r) => '<li class="sd-spec-row"><span class="sd-spec-name">' + escapeHtml(sdName(r, dup)) +
        '</span><span class="sd-spec-pct">' + Math.round(Number(r.completion_pct) || 0) + '%</span></li>')
      .join('');

    mount.innerHTML =
      '<div class="sd-spectate">' +
        '<div class="sd-spec-head">' +
          '<span class="sd-spec-badge">Finished</span>' +
          (myTime ? '<span class="sd-spec-time">' + escapeHtml(myTime) + '</span>' : '') +
        '</div>' +
        (myPos != null
          ? '<div class="sd-spec-pos">Currently <strong>' + escapeHtml(String(ord(myPos))) + '</strong>' +
            '<span class="sd-spec-prov">provisional</span></div>'
          : '') +
        (still > 0
          ? '<div class="sd-spec-sub">' + still + (still === 1 ? ' racer' : ' racers') + ' still going</div>' +
            '<ul class="sd-spec-list">' + chasers + '</ul>'
          : '<div class="sd-spec-sub">Everyone is in. Final results coming up…</div>') +
      '</div>';
  }

  // Enter the finished-and-waiting state (arms the per-poll refresh above).
  function enterFinishedWaiting(standings) {
    state._finishedWaiting = true;
    const q = $('play-question');
    if (q) q.textContent = 'All five locks cracked. You’re in — watching the rest of the race…';
    renderFinishedWaiting(standings || state._lastStandings);
  }

  // Authoritative play time is the CURRENT player's row elapsed_ms — a
  // PER-PLAYER field inside standings.standings[], NOT a top-level
  // standings.elapsed_ms. The deployed backend carries NO top-level elapsed_ms
  // (confirmed live 2026-09-22), so the old top-level read left #play-timer
  // frozen at 00:00 the entire round. This mirrors how RESULTS resolves
  // myRow.elapsed_ms. Server elapsed_ms is 0 until the first /progress post, so
  // 00:00 before the first solve is expected — it advances once progress posts.
  function myElapsedMs(standings) {
    const rows = (standings && Array.isArray(standings.standings)) ? standings.standings : null;
    if (rows && state.playerId) {
      const me = rows.find((r) => r.player_id === state.playerId);
      if (me && typeof me.elapsed_ms === 'number') return me.elapsed_ms;
    }
    // Fallback only if a future payload ever adds a top-level elapsed_ms.
    return (standings && typeof standings.elapsed_ms === 'number') ? standings.elapsed_ms : null;
  }

  /* ── PLAY clock: authoritative elapsed_ms, smoothed between ~1s polls ──
   * elapsed_ms is authoritative but arrives ~1s apart and can stall to 2–5s
   * during poll backoff. We anchor the last server value to a wall-clock stamp
   * and repaint every 250ms so the readout keeps moving instead of freezing,
   * re-syncing on each fresh server value. Monotonic (never ticks backwards);
   * never advances while elapsed is 0 (pre-first-solve stays 00:00). */
  let playClockTimer = null;
  function setPlayClockFromServer(ms) {
    if (ms == null) return;
    if (state._clockSrvMs !== ms) { state._clockSrvMs = ms; state._clockAt = Date.now(); }
    paintPlayClock();
  }
  /* Pre-first-solve the clock runs off a LOCAL anchor stamped when the race first
   * went in_progress. Server elapsed_ms is 0 until the first /progress POST, and
   * /progress only fires on a solve — so the header read a frozen 00:00 for the
   * whole of the first question, which looked broken. Once the server value goes
   * above 0 it takes over and the existing monotonic clamp hides the handover.
   * Ranking is unaffected: server elapsed_ms remains the only authority. */
  function paintPlayClock() {
    const el = $('play-timer');
    if (!el) return;
    let ms = state._clockSrvMs;
    if (ms == null || ms <= 0) {
      if (!state._raceAnchorAt) return;               // no anchor yet → leave as-is
      ms = Date.now() - state._raceAnchorAt;
    } else if (state._clockAt) {
      ms += (Date.now() - state._clockAt);            // fill the inter-poll gap
    }
    if (state._clockShownMs != null && ms < state._clockShownMs) ms = state._clockShownMs; // monotonic
    state._clockShownMs = ms;
    el.textContent = fmtTime(ms);
  }
  function startPlayClock() {
    if (playClockTimer) return;
    playClockTimer = setInterval(paintPlayClock, 250);
  }
  function stopPlayClock() {
    if (playClockTimer) { clearInterval(playClockTimer); playClockTimer = null; }
  }

  // Race lanes = puzzle_count dots keyed by player_id (SSOT §6, dev #1). Each
  // player's solved dots = round(completion_pct/100 × puzzle_count), fed through
  // the existing .sd-pg CSS via the --solved custom property (smooth slide).
  function renderRace(standings) {
    const panel = $('play-progress-panel');
    if (!panel) return;
    const rows = (standings && Array.isArray(standings.standings)) ? standings.standings : [];
    if (!rows.length) { panel.hidden = true; return; }
    const pc = Number(standings && standings.puzzle_count) || state.puzzles.length || rows.length;

    // Rebuild lanes only when the SET of player_ids changes (sorted key → stable
    // across rank reordering so the runner can slide instead of hard-cut).
    const rosterKey = rows.map((r) => r.player_id).slice().sort().join('|');
    // Roster key intentionally excludes names, so re-label on the same roster when
    // a collision suffix appears (a late joiner can create a duplicate).
    const dup = dupNameIds(rows);
    const labelKey = rows.map((r) => r.player_id + ':' + sdName(r, dup)).slice().sort().join('|');
    if (panel._sdRoster !== rosterKey || panel._sdLabels !== labelKey) {
      panel._sdRoster = rosterKey;
      panel._sdLabels = labelKey;
      panel.innerHTML = rows.map((r) => {
        const isMe = state.playerId && r.player_id === state.playerId;
        let dots = '';
        for (let i = 0; i < pc; i++) dots += '<span class="sd-pg-dot"></span>';
        return '<span class="sd-pg-player' + (isMe ? ' sd-pg-player--me' : '') +
          '" data-pid="' + escapeHtml(r.player_id || '') + '">' +
          '<span class="sd-pg-ghost" data-ghost="idle" aria-hidden="true"></span>' +
          '<span class="sd-pg-name">' + escapeHtml(sdName(r, dup)) + (isMe ? ' (you)' : '') + '</span>' +
          '<span class="sd-pg-dots"><span class="sd-pg-runner"></span>' + dots + '</span>' +
          '<span class="sd-pg-flag" hidden>Done</span>' +
          '</span>';
      }).join('');
    }

    const byId = {};
    rows.forEach((r) => { byId[r.player_id] = r; });

    // Motion cues ride on the existing --solved slide. Compare against the
    // previous poll snapshot (per player_id) so pct/rank deltas can fire brief,
    // one-shot beats. Undefined on first paint → nothing flashes on entry.
    const prev = panel._sdPrev || null;
    const curr = {};
    const reduce = prefersReducedMotion();
    const myRow = rows.find((r) => state.playerId && r.player_id === state.playerId);
    const myRank = myRow && myRow.rank != null ? Number(myRow.rank) : null;
    const prevMyRank = prev && prev._myRank != null ? prev._myRank : null;

    panel.querySelectorAll('.sd-pg-player').forEach((lane) => {
      const r = byId[lane.dataset.pid];
      if (!r) return;
      const pct = Math.max(0, Math.min(100, Number(r.completion_pct) || 0));
      const rank = r.rank != null ? Number(r.rank) : null;
      const isMe = state.playerId && r.player_id === state.playerId;
      const solved = Math.round(pct / 100 * pc);
      lane.style.setProperty('--solved', solved);
      lane.querySelectorAll('.sd-pg-dot').forEach((d, i) => d.classList.toggle('is-filled', i < solved));
      const flag = lane.querySelector('.sd-pg-flag');
      if (flag) flag.hidden = pct < 100;

      // A4 — LEADER shimmer: persistent gold sheen on the current 1st place
      // (collapses to a static gold tint under reduced motion, via CSS).
      lane.classList.toggle('sd-pg-leader', rank === 1);

      /* Ghost racer state. Priority: done > leading > trailing > running > idle.
       * "running" needs a movement signal, so it holds for ~1.5s after a solve
       * rather than only on the poll where pct changed — otherwise the run cycle
       * would flicker for a single frame every few questions. "trailing" only
       * applies once someone is actually ahead (rank > 1 and any progress made),
       * so nobody gets the teary ghost merely for being at 0% on the start line. */
      const was = prev && prev[lane.dataset.pid];

      const ghost = lane.querySelector('.sd-pg-ghost');
      if (ghost) {
        if (was && pct > was.pct) lane._sdMovedAt = Date.now();
        const moving = lane._sdMovedAt && (Date.now() - lane._sdMovedAt) < 1500;
        let g;
        if (pct >= 100) g = 'done';
        else if (rank === 1 && pct > 0) g = 'leading';
        else if (moving) g = 'running';
        else if (rank != null && rank > 1 && pct > 0) g = 'trailing';
        else g = 'idle';
        if (ghost.dataset.ghost !== g) ghost.dataset.ghost = g;
      }

      curr[lane.dataset.pid] = { pct: pct, rank: rank };

      if (!was || reduce) return; // first paint / reduced motion → no one-shot cues

      // A2 — opponent ADVANCE tick: a brief beat when their completion% rises.
      if (!isMe && pct > was.pct) pulseOnce(lane, 'sd-pg-advance', 520);

      // A3 — PASS-ME alarm (~600ms): an opponent crossed from behind you to
      // ahead of you on this poll. Flash their lane + your own lane rail red.
      if (!isMe && rank != null && was.rank != null && myRank != null && prevMyRank != null &&
          was.rank > prevMyRank && rank < myRank) {
        pulseOnce(lane, 'sd-pg-pass', 600);
        const meLane = panel.querySelector('.sd-pg-player--me');
        if (meLane) pulseOnce(meLane, 'sd-pg-passed', 600);
        // Being overtaken is the sharpest moment in the race and the one a player
        // is least likely to SEE — their eyes are on the puzzle, not the strip.
        playSfxPassed();
      }
    });

    // Taking 1st is the counterpart to being passed. Fired here rather than
    // per-lane because it is about MY rank, and only on the transition so it
    // cannot retrigger every poll while I stay in front.
    if (!reduce && myRank === 1 && prevMyRank != null && prevMyRank > 1) playSfxLead();

    curr._myRank = myRank;
    panel._sdPrev = curr;
    panel.hidden = false;
  }

  /* ── Superseded-token terminal path (Q8, SSOT §11) ─────────────── */
  // No mid-race re-auth path exists (confirmed backend gap) — a terminal, honest
  // message is the correct behavior. Stop the loop; never loop silently or
  // fabricate progress.
  let superseded = false;
  function handleSuperseded(where, err) {
    if (superseded) return;
    superseded = true;
    stopPollLoop();
    const detail = (err && err.message) ? err.message : 'This seat was opened on another device.';
    console.warn('[showdown] superseded (409) via ' + where + ' — stopping. ' + detail);
    renderTerminal(detail + ' Continue on that device.');
  }

  // Full-screen terminal overlay (created at runtime — no showdown.html edits).
  function renderTerminal(msg) {
    let el = document.getElementById('sd-terminal');
    if (!el) {
      el = document.createElement('div');
      el.id = 'sd-terminal';
      el.setAttribute('role', 'alertdialog');
      el.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;' +
        'justify-content:center;text-align:center;padding:24px;background:rgba(10,7,5,.94);' +
        'color:#fff;font:600 16px/1.55 system-ui,-apple-system,sans-serif';
      (document.body || document.documentElement).appendChild(el);
    }
    el.innerHTML = '<div style="max-width:340px"><div style="font-size:34px;margin-bottom:14px">\u26a0\ufe0f</div>' +
      escapeHtml(msg) + '</div>';
  }

  /* ══════════════════════════ SCREEN 5 · RESULTS (P5, SSOT §6) ════ */
  // Podium rendered in SERVER rank order (deviation #3 — never client re-sort).
  // Champion = winner_player_id. Rows show completion_pct + elapsed_ms (penalty
  // nodes repurposed, §9). end_reason → copy (Q12). Stars re-anchored to
  // elapsed_ms only. Identity (champion / your row) keyed by player_id (dev #1).

  const END_REASON_COPY = {
    all_completed:     'Every racer cracked the vault.',
    force_completed:   'The host ended the round.',
    countdown_expired: 'Time\u2019s up. Pencils down.',
    reset:             'Round reset by the host.',
  };

  // ≤60s ⭐⭐⭐, ≤90s ⭐⭐, else ⭐ (anchored to elapsed time only).
  function starRating(timeMs) {
    if (timeMs == null) return '\u2b50';
    const s = timeMs / 1000;
    if (s <= 60) return '\u2b50\u2b50\u2b50';
    if (s <= 90) return '\u2b50\u2b50';
    return '\u2b50';
  }

  let resultsShown = false;
  function renderResults(standings) {
    if (resultsShown) return; // the poll stops at completed → one-shot render
    resultsShown = true;

    // Server rank order, as delivered — NOT re-sorted client-side (deviation #3).
    const rows = (standings && Array.isArray(standings.standings)) ? standings.standings.slice() : [];
    const winnerId = standings && standings.winner_player_id;
    const sessionElapsed = standings && standings.elapsed_ms;
    const puzzleCount = Number(standings && standings.puzzle_count) || 0;

    const dup = dupNameIds(rows);
    const board = $('results-board');
    if (board) {
      board.innerHTML = rows.map((r, i) => {
        const isMe = state.playerId && r.player_id === state.playerId;
        const isWin = winnerId ? r.player_id === winnerId : i === 0;
        const pct = Math.max(0, Math.min(100, Number(r.completion_pct) || 0));
        const finished = pct >= 100;
        const elapsed = (typeof r.elapsed_ms === 'number') ? r.elapsed_ms : (isMe ? sessionElapsed : null);
        const rank = r.rank != null ? r.rank : (i + 1);
        // Repurposed stat nodes: completion% + elapsed, or a DNF marker.
        const stats = finished
          ? '<span class="sd-lb-correct">' + pct + '%</span>' +
            (elapsed != null ? '<span class="sd-lb-time">' + fmtTime(elapsed) + '</span>' : '')
          : '<span class="sd-lb-dnf">DNF</span><span class="sd-lb-correct">' + pct + '%</span>';
        return '<li class="sd-lb-row' + (isMe ? ' sd-lb-row--me' : '') + (isWin ? ' sd-lb-row--win' : '') +
          '" data-pid="' + escapeHtml(r.player_id || '') + '">' +
          '<span class="sd-lb-rank">' + rank + '</span>' +
          '<span class="sd-lb-name">' + escapeHtml(sdName(r, dup)) + (isMe ? ' (you)' : '') + '</span>' +
          '<span class="sd-lb-stats">' + stats + '</span>' +
          '</li>';
      }).join('');
    }

    // Headline + champion celebration (keyed by player_id).
    const champ = rows.find((r) => winnerId ? r.player_id === winnerId : false) || rows[0];
    const iWon = champ && state.playerId && champ.player_id === state.playerId;
    const headline = $('results-headline');
    if (headline) headline.textContent = champ ? (iWon ? 'You win! \ud83c\udf89' : sdName(champ, dup) + ' wins!') : 'Results';
    const crown = $('results-crown');
    if (crown) crown.classList.add('is-champion');

    // end_reason copy.
    const statusEl = $('results-status');
    if (statusEl) statusEl.textContent = (standings && END_REASON_COPY[standings.end_reason]) || 'Final results.';

    // "Your Results" card: completion% + elapsed + stars (no penalties, §9).
    const myRow = rows.find((r) => state.playerId && r.player_id === state.playerId);
    const myElapsed = myRow && typeof myRow.elapsed_ms === 'number' ? myRow.elapsed_ms : sessionElapsed;
    const myPct = myRow ? Math.max(0, Math.min(100, Number(myRow.completion_pct) || 0)) : null;
    const yours = $('results-yours');
    if (yours && myRow) {
      const line = $('results-yours-line');
      if (line) line.textContent = myPct + '% complete \u00b7 ' + fmtTime(myElapsed);
      const stars = $('results-yours-stars');
      if (stars) stars.textContent = starRating(myElapsed);
      yours.hidden = false;
    }

    wireResultsActions();
    playSfxGameComplete();
    fireConfetti();
    void puzzleCount;
  }

  function wireResultsActions() {
    // "Share result" is retired: it copied a boast to the clipboard, which has no
    // use at a booth where the crowd leaderboard is already on a dedicated screen.
    // Removed at runtime rather than from showdown.html, matching how the lobby
    // strips its share-code hint (no showdown.html DOM edits). doShare/shareText
    // are left in place, unreferenced, so restoring this is a one-line change.
    const share = $('results-share');
    if (share) share.remove();
    const again = $('results-again');
    if (again) again.onclick = playAgain;
  }

  function shareText() {
    const st = state.standings || {};
    const catId = state.winningCategory || st.winning_category;
    const cat = CAT_BY_ID[catId];
    const label = cat ? cat.label : 'Showdown';
    const myRow = (st.standings || []).find((r) => state.playerId && r.player_id === state.playerId);
    const pct = myRow ? Math.max(0, Math.min(100, Number(myRow.completion_pct) || 0)) : 0;
    const elapsed = myRow && typeof myRow.elapsed_ms === 'number' ? myRow.elapsed_ms : st.elapsed_ms;
    return '\ud83c\udfc6 I cracked ' + pct + '% of the ' + label + ' Showdown vault in ' + fmtTime(elapsed) + '!';
  }

  async function doShare(btn) {
    const text = shareText();
    const original = btn.textContent;
    let ok = false;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text); ok = true;
      } else {
        const ta = document.createElement('textarea');
        ta.value = text; ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
        document.body.appendChild(ta); ta.focus(); ta.select();
        ok = document.execCommand('copy'); ta.remove();
      }
    } catch { ok = false; }
    btn.textContent = ok ? '\u2713 Copied to clipboard' : '\u26a0 Copy failed';
    setTimeout(() => { btn.textContent = original; }, 1800);
  }

  // Play again → keep seat_token + game_id so JOIN skips the PIN box and returns
  // via the waiting-for-session landing → EMPTY name entry (CHANGE 2/3); clear
  // only round-scoped state so tryRehydrate won't resume the finished session.
  // Falls back to a full clear if no seat is held.
  function playAgain() {
    stopPollLoop();
    const saved = loadIdentity() || {};
    const gameId = saved.gameId != null ? saved.gameId : state.gameId;
    const seatToken = saved.seatToken != null ? saved.seatToken : state.seatToken;
    if (gameId && seatToken) {
      try {
        localStorage.setItem(LS_IDENTITY, JSON.stringify({
          gameId: gameId,
          pin: saved.pin != null ? saved.pin : state.pin,
          displayName: saved.displayName || state.displayName || '',
          seatNumber: saved.seatNumber != null ? saved.seatNumber : state.seatNumber,
          seatToken: seatToken,
          // round-scoped fields cleared so we rejoin fresh (no resume):
          sessionId: null, playerId: null, token: null,
          myVote: null, voteLocked: false,
        }));
      } catch { clearIdentity(); }
      persistGameId(gameId); // keep game_id for the reduced JOIN after reload
    } else {
      clearIdentity();
    }
    // Reset the mock timeline so an offline ?mock=true walkthrough starts a fresh
    // round (no-op against the live backend).
    try { sessionStorage.removeItem('sd_mock_claimAt'); sessionStorage.removeItem('sd_mock_progress'); } catch {}
    location.reload();
  }

  // CSS-only confetti burst (winner celebration). Reduced-motion aware.
  function fireConfetti() {
    const host = $('sd-confetti');
    if (!host) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    clearConfetti();
    // VS Select palette, read from the live tokens so it stays theme-correct
    // (coral mode accent, action, success, bone text). Retires the HEAT hexes.
    const cs = getComputedStyle(document.body || document.documentElement);
    const tok = (name, fb) => (cs.getPropertyValue(name).trim() || fb);
    const colors = [
      tok('--mode-color', 'var(--showdown)'),
      tok('--action', 'var(--action)'),
      tok('--success', 'var(--success)'),
      tok('--text', 'var(--text)'),
    ];
    for (let i = 0; i < 70; i++) {
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

  /* ─────────────────────── SFX / FX helpers (P3–P5 reuse) ──────── */
  // Preserved from the HEAT build; not wired into the P0–P2 data layer but kept
  // for the VOTE/PLAY/RESULTS phases and referenced by the shared FX canvas.

  let sfxCtx = null;
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

  function sfxTone(freqs, opts) {
    opts = opts || {};
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!sfxCtx) sfxCtx = new Ctx();
      if (sfxCtx.state === 'suspended') sfxCtx.resume();
      const now = sfxCtx.currentTime;
      const step = opts.step || 0.06;
      freqs.forEach((f, i) => {
        const osc = sfxCtx.createOscillator();
        const gain = sfxCtx.createGain();
        osc.type = opts.type || 'sine';
        osc.frequency.setValueAtTime(f, now + i * step);
        gain.gain.setValueAtTime(0.0001, now + i * step);
        gain.gain.exponentialRampToValueAtTime(opts.vol || 0.07, now + i * step + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + i * step + (opts.dur || 0.2));
        osc.connect(gain).connect(sfxCtx.destination);
        osc.start(now + i * step); osc.stop(now + i * step + (opts.dur || 0.2));
      });
    } catch { /* best-effort */ }
  }
  /* ── Sound design ──────────────────────────────────────────────────
   * Three raw oscillator beeps wired straight to destination is what a
   * prototype sounds like. A competitive game needs feedback you feel, and it
   * can be fully procedural — no assets, no download weight, no licensing.
   *
   * Constraints that shaped these, all from the booth:
   *  - THREE LAPTOPS SIT SIDE BY SIDE. Every cue is under ~320ms and quiet, and
   *    the voices occupy different pitch registers so simultaneous play from
   *    neighbouring machines does not turn to mush.
   *  - Players wear no headphones and the hall is loud, so cues are shaped for
   *    transient clarity (a fast attack and a filtered body) rather than volume.
   *  - Everything runs through ONE master bus with a limiter, so no combination
   *    of cues can clip, and a single mute switch silences all of it.
   *  - Muting persists: at a booth someone will want it off, once, for good. */
  let sfxBus = null;      // master gain -> limiter -> destination
  let sfxMuted = false;
  try { sfxMuted = localStorage.getItem('sd_muted') === '1'; } catch { /* private mode */ }

  function audioReady() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      if (!sfxCtx) sfxCtx = new Ctx();
      if (sfxCtx.state === 'suspended') sfxCtx.resume();
      if (!sfxBus) {
        const gain = sfxCtx.createGain();
        gain.gain.value = 0.9;
        // Fast-attack compressor acting as a safety limiter: with several cues
        // overlapping (a solve landing while the race strip fires) raw gains sum
        // and clip, which reads as cheap.
        const comp = sfxCtx.createDynamicsCompressor();
        comp.threshold.value = -14; comp.knee.value = 12;
        comp.ratio.value = 12; comp.attack.value = 0.002; comp.release.value = 0.12;
        gain.connect(comp).connect(sfxCtx.destination);
        sfxBus = gain;
      }
      return sfxMuted ? null : sfxCtx;
    } catch { return null; }
  }

  /* One shaped voice. `type` picks the oscillator, `cut` a lowpass corner so
   * nothing is harsh on laptop speakers, and the gain envelope is explicit
   * (attack/decay) rather than two exponential ramps that click. */
  function voice(o) {
    const ctx = audioReady();
    if (!ctx) return;
    const t0 = ctx.currentTime + (o.at || 0);
    const dur = o.dur || 0.14;
    const osc = ctx.createOscillator();
    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(o.f, t0);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t0 + dur);
    const g = ctx.createGain();
    const peak = Math.max(0.0001, o.vol == null ? 0.06 : o.vol);
    const atk = o.atk == null ? 0.006 : o.atk;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let node = osc;
    if (o.cut) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = o.cut; lp.Q.value = o.q || 0.7;
      node = osc.connect(lp);
      lp.connect(g);
    } else {
      osc.connect(g);
    }
    void node;
    g.connect(sfxBus);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  }
  const chord = (notes) => notes.forEach(voice);

  // Kept for compatibility with any existing caller.
  function sfxTone(freqs, opts) {
    opts = opts || {};
    freqs.forEach((f, i) => voice({
      f, at: i * (opts.step || 0.06), dur: opts.dur || 0.2,
      vol: opts.vol || 0.07, type: opts.type || 'sine',
    }));
  }

  /* The cue set. Each one is a distinct gesture, not a different pitch of the
   * same beep — that distinctness is what lets a player parse what happened
   * without looking away from the puzzle. */

  // Key press / letter placed. Deliberately tiny: it fires up to ~14 times in a
  // single spelling answer, so it has to disappear into the background.
  const playSfxTick = () => voice({ f: 880, to: 620, dur: 0.035, vol: 0.022, type: 'triangle', cut: 2600, atk: 0.001 });

  // Correct: a rising major third with a bright transient on top. Short enough
  // to not delay the next puzzle.
  const playSfxCorrect = () => chord([
    { f: 587, to: 880, dur: 0.16, vol: 0.055, type: 'triangle', cut: 4200 },
    { f: 1175, dur: 0.09, vol: 0.022, type: 'sine', at: 0.02 },
  ]);

  // Wrong: a low filtered thud. The old sawtooth buzz read as an error *beep*;
  // a body-hit reads as "that cost you" without being shrill in a noisy room.
  const playSfxWrong = () => chord([
    { f: 196, to: 110, dur: 0.22, vol: 0.075, type: 'triangle', cut: 620, atk: 0.002 },
    { f: 98,  to: 74,  dur: 0.26, vol: 0.05,  type: 'sine',     cut: 400 },
  ]);

  // Each second of the 5s lockout: a dry, quiet tick so the pause is felt.
  const playSfxLockTick = () => voice({ f: 320, dur: 0.05, vol: 0.03, type: 'square', cut: 1200 });

  // You took the lead — bright, confident, upward.
  const playSfxLead = () => chord([
    { f: 784, dur: 0.1, vol: 0.05, type: 'triangle', cut: 5000 },
    { f: 1046, dur: 0.14, vol: 0.045, type: 'triangle', cut: 5000, at: 0.07 },
  ]);

  // Someone overtook you — the same interval inverted, so it is unmistakably
  // the bad twin of the cue above.
  const playSfxPassed = () => chord([
    { f: 740, dur: 0.1, vol: 0.045, type: 'triangle', cut: 3000 },
    { f: 494, dur: 0.16, vol: 0.05, type: 'triangle', cut: 2200, at: 0.07 },
  ]);

  // Final seconds of the vote window.
  const playSfxUrgent = () => voice({ f: 440, dur: 0.07, vol: 0.04, type: 'square', cut: 1800 });

  // All five locks cracked.
  const playSfxGameComplete = () => chord([
    { f: 523,  dur: 0.16, vol: 0.055, type: 'triangle', cut: 5200 },
    { f: 659,  dur: 0.16, vol: 0.055, type: 'triangle', cut: 5200, at: 0.10 },
    { f: 784,  dur: 0.18, vol: 0.055, type: 'triangle', cut: 5200, at: 0.20 },
    { f: 1046, dur: 0.30, vol: 0.06,  type: 'triangle', cut: 6000, at: 0.30 },
    { f: 1568, dur: 0.22, vol: 0.02,  type: 'sine',     at: 0.32 },
  ]);

  /* Press feedback for every lock, without touching a single component.
   *
   * A delegated listener on #play-mount catches any button press inside whichever
   * lock is mounted — keypad digits, letter tiles, reels, pillars, options — and
   * answers within a frame. Doing it here rather than in the five components keeps
   * the 22 episodes silent and untouched, and survives the components replacing
   * their own innerHTML (which is why per-element listeners would not work).
   *
   * Deliberately NOT fired for the Undo/Clear ghost buttons: those are corrections,
   * and rewarding them with the same click as progress muddles the feedback. */
  function attachPressSfx() {
    const mount = document.getElementById('play-mount');
    if (!mount || mount._sdPressSfx) return;
    mount._sdPressSfx = true;
    mount.addEventListener('pointerdown', (e) => {
      const t = e.target && e.target.closest
        ? e.target.closest('button, .wlock-reel, .splk-letter, .kpdlk-key, .wglk-option, .pillk-pillar')
        : null;
      if (!t) return;
      if (t.classList.contains('splk-action')) return;  // Undo / Clear
      if (t.disabled) return;
      playSfxTick();
    }, { passive: true });
    // The reels are driven by wheel and keyboard too, so those get a tick as well.
    mount.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (/^([0-9a-zA-Z]|Enter|ArrowUp|ArrowDown)$/.test(e.key)) playSfxTick();
    }, { passive: true });
  }

  /* Mute control, built at runtime (no showdown.html edits) and parked next to
   * the existing theme toggle. Present on every screen from PLAY onward so a
   * booth attendant can silence one machine without hunting through settings. */
  function mountMuteToggle() {
    if (document.getElementById('sd-mute')) { setMuted(sfxMuted); return; }
    const btn = document.createElement('button');
    btn.id = 'sd-mute';
    btn.type = 'button';
    btn.className = 'sd-mute';
    btn.setAttribute('aria-pressed', sfxMuted ? 'true' : 'false');
    btn.onclick = () => setMuted(!sfxMuted);
    /* Parent to .sd-app, NOT next to the theme toggle. The theme toggle lives
     * inside #screen-join, which is hidden the moment play starts — adopting its
     * parent made the button zero-size and invisible exactly when it is needed.
     * .sd-app spans every screen, and the CSS pins this `fixed`. */
    const host = document.querySelector('.sd-app') || document.body || document.documentElement;
    host.appendChild(btn);
    setMuted(sfxMuted);
  }

  function setMuted(next) {
    sfxMuted = !!next;
    try { localStorage.setItem('sd_muted', sfxMuted ? '1' : '0'); } catch { /* ignore */ }
    const btn = document.getElementById('sd-mute');
    if (btn) {
      btn.setAttribute('aria-pressed', sfxMuted ? 'true' : 'false');
      btn.textContent = sfxMuted ? '🔇 Sound off' : '🔊 Sound on';
      btn.title = sfxMuted ? 'Turn sound on' : 'Turn sound off';
    }
  }
  // Silence "unused" linters for symbols reserved for later phases / HTML FX.
  void SD_FLAG_SVG; void bankLookup;

  function fmtTime(ms) {
    if (ms == null) return '-';
    const s = Math.round(ms / 1000);
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }

  /* ─────────────────────── Refresh / reconnect (SSOT §7.5, dev #5) ─ */
  // On boot with a stored identity for THIS game_id: verify the session via
  // /public (detect a superseded/replaced session), then hand to the standings
  // loop which routes by state. voting → ballot re-locks if we already voted;
  // in_progress → loadPuzzles re-GETs /puzzles (idempotent) and resumes at
  // round(my completion_pct/100 × puzzle_count); completed → podium. The server
  // elapsed_ms makes the clock resume exactly.
  async function tryRehydrate() {
    const saved = loadIdentity();
    if (!saved || !saved.gameId || saved.gameId !== state.gameId) return false;
    if (!saved.sessionId || !saved.playerId || !saved.token) return false;
    state.pin = saved.pin || null;
    state.displayName = saved.displayName || '';
    state.seatNumber = saved.seatNumber != null ? saved.seatNumber : null;
    state.seatToken = saved.seatToken || null;
    state.sessionId = saved.sessionId;
    state.playerId = saved.playerId;
    state.token = saved.token;
    state.myVote = saved.myVote || null;
    state.voteLocked = !!saved.voteLocked;

    // Detect a replaced session (our identity would be stale/superseded).
    try {
      const pub = await getPublic(state.gameId);
      if (pub && pub.current_session_id && pub.current_session_id !== state.sessionId) {
        console.warn('[showdown] stored session superseded by ' + pub.current_session_id + ' — clearing identity');
        clearIdentity();
        return false; // fall back to JOIN
      }
    } catch (e) {
      // Network blip on /public — proceed optimistically; the poll loop retries.
      console.warn('[showdown] /public check failed on rehydrate (' + (e && e.message) + ') — proceeding');
    }
    console.info('[showdown] rehydrated identity from localStorage (player ' + state.playerId + ')');
    startPollLoop();
    return true;
  }

  /* ─────────────────────────── Boot ───────────────────────────── */

  document.addEventListener('DOMContentLoaded', function () {
    if (MOCK) showMockBadge();

    // Re-assert the persisted theme now that <body> exists, and build the JOIN
    // theme toggle (Feature 1). Independent of game_id / rehydrate path.
    applyTheme(getTheme());
    buildThemeToggle();

    // Mock-only debug seam so the offline walkthrough can assert the resolver
    // directly (pillar True/False sides, both mcq shapes, numeric unit, bad ids).
    if (MOCK) {
      window.__sdDebug = {
        resolveBank: (picks, cat, sid) => resolveBank(picks, cat, sid),
        resolveStatement: (entry, sid) => resolveStatement(entry, sid),
        fnv1a,
        bankReady: () => loadBank(),
        getBankFlat: () => BANK_FLAT,
        getState: () => state,
      };
    }

    // game_id from the table QR (?game=<id>) — SSOT §9/Q2. CHANGE 1: ?game= is
    // ALWAYS priority and is stored to sessionStorage, OVERWRITING any prior
    // value. With no URL param, fall back to the stored sessionStorage id, then
    // a stored identity's game_id; normalise whatever we find back into
    // sessionStorage so later in-session navigation keeps it.
    const urlGameId = params.get('game') || null;
    if (urlGameId) {
      state.gameId = urlGameId;
      persistGameId(urlGameId); // overwrite
    } else {
      let gid = loadGameId();
      if (!gid) { const saved = loadIdentity(); gid = (saved && saved.gameId) || null; }
      state.gameId = gid;
      if (gid) persistGameId(gid);
    }
    // MOCK convenience: with ?mock=true and no real game_id anywhere, synthesise
    // one so the fully-offline walkthrough runs without a table code (the mock
    // backend ignores the id; this NEVER affects the live path).
    if (MOCK && !state.gameId) state.gameId = 'mock-game';

    // P0: fetch + index the question bank at boot (log counts). Non-blocking for
    // JOIN/LOBBY; the P4 resolver awaits bankReady before mounting puzzles.
    loadBank().catch((e) => console.error('[showdown] bank load failed:', e && e.message));

    // Refresh recovery first; otherwise start at JOIN.
    tryRehydrate().then((ok) => { if (!ok) initJoin(); })
      .catch(() => initJoin());
  });
})();
