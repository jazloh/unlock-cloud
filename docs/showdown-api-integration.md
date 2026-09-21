# Showdown API — Integration (Single Source of Truth)

> **Status:** ACTIVE, authoritative. Reflects the **deployed** backend API as confirmed by the backend engineer on 2026-09-17.
> Supersedes `docs/archive/showdown-backend-api-contract-v4-superseded.md` (the old frontend proposal — do not implement against it).
> **Scope:** data-layer rewrite of `app/showdown.js` only. No changes to HEAT screen DOM/IDs, `index.css`, or the 5 shared puzzle components' core behavior.
> **Event target:** AWS Cloud & AI Day Hanoi, 2026-09-29.

---

## 0. Division of responsibility

- **Backend owns:** session lifecycle, lobby/seats/PINs, category voting + tie-break, picking which **question IDs** to serve (per type), live standings (rank, %, elapsed).
- **Engine owns:** the question bank (bundled on CDN), resolving ALL content from IDs (text/options/answers), pillar-lock correct-vs-decoy side selection, rendering, client-side correctness scoring.
- **The wire carries IDs only** — never question text, options, or answers.

## 1. Base URLs

- **[A] Admin/Game:** `https://1fvjsw6674.execute-api.ap-southeast-5.amazonaws.com/dev` — `/games/{game_id}/*`
- **[S] Showdown:** `https://8qc41th8u0.execute-api.ap-southeast-5.amazonaws.com/v1` — `/showdown/{session_id}/*`
- Region `ap-southeast-5`, account `878451097385`. All engine endpoints **unauthenticated**. JSON, ISO-8601 UTC.
- **CORS:** both bases are `AllowOrigin: '*'` (confirmed Q11) — any origin works, no allow-list to maintain.
- Error envelope: `{ "error": { "code": "...", "message": "..." } }`. IDs (`seat_token`, `player_id`, `token`) travel in the JSON **body**, never as an `Authorization` header.

## 2. Endpoint mapping (old showdown.js → deployed)

| Today (`app/showdown.js`) | Deployed contract | Verdict |
|---|---|---|
| — | `POST [A] /games/{game_id}/seats/claim {pin}` → `{seat_number, seat_token}` | **ADDED** — identity root |
| — | `GET [A] /games/{game_id}/public` → `{status, current_session_id, current_session_state}` | **ADDED** — session discovery |
| `POST /api/showdown/join {name,sessionCode}` | `POST [S] /showdown/{session_id}/players {seat_token, display_name}` → `{session_id, player_id, display_name, seat_number, token}` | **REPLACED** (setup-only) |
| `POST /api/showdown/ready` | *(nothing)* | **REMOVED** — no ready concept |
| `GET /api/showdown/session/{code}` (4 call sites) | `GET [S] /showdown/{session_id}/standings` (~1s) | **REPLACED** — one source of truth |
| `POST /api/showdown/vote {...}` | `POST [S] /showdown/{session_id}/vote {player_id, category, token}` → `{voting_closed, assignment?}` | **REPLACED** |
| `GET /api/showdown/puzzles/{code}` (full config) | `GET [S] /showdown/{session_id}/puzzles` → `{winning_category, picks{type:[ids]}}` | **REPLACED + bank resolver** |
| `POST /api/showdown/penalty` | *(nothing)* | **REMOVED** |
| `POST /api/showdown/attempt` | *(nothing)* | **REMOVED** |
| `POST /api/showdown/result {correct,penalties,timeMs}` | `POST [S] /showdown/{session_id}/progress {player_id, puzzles_completed, token}` | **REPLACED** (cumulative; elapsed server-side) |
| `GET /api/showdown/leaderboard/{code}` | `standings` (same poll) | **MERGED** |

**Net:** 2 new [A] calls, 4 [S] calls, one bank fetch, one 1s poll loop. Removed: ready, penalty, attempt, `Bearer` header, the entire penalty/re-rank concept.

> **§3.3 join-shape correction (backend doc bug):** the deployed `/players` returns
> `{session_id, player_id, display_name, seat_number, token}` — **not** the
> `category/voting_closed/assignment` shown in the old engine-integration spec §3.3.
> Build against the real shape. The write `token` we need is present.

## 3. Identity & flow (per device)

`game_id` (from QR/URL) → **PIN** → `seat_token` → discover `session_id` → `player_id` + `token`.

1. `POST [A] /games/{game_id}/seats/claim {pin}` → store `seat_number`, `seat_token`.
2. `GET [A] /games/{game_id}/public` → poll until `current_session_id` present.
3. `POST [S] /showdown/{session_id}/players {seat_token, display_name}` → store `player_id` + `token` (setup-only; 409 otherwise).
4. `POST [S] /showdown/{session_id}/vote {player_id, category, token}` when `state==voting`.
5. `GET [S] /showdown/{session_id}/puzzles` when `state==in_progress` → resolve from bank.
6. `POST [S] /showdown/{session_id}/progress {player_id, puzzles_completed, token}` after each solve (cumulative).
7. `GET [S] /showdown/{session_id}/standings` (~1s) drives every screen.

State machine (from `standings.state`, or `/public.current_session_state` pre-session):
`setup → voting → in_progress → completed`.

## 4. Confirmed backend answers (2026-09-17) — build assumptions

| # | Answer | Engine action |
|---|---|---|
| **Q1** | PIN = **exactly 6**, uppercase, excludes `0 O 1 I L` | Client-side 6-char validation is safe |
| **Q3** | `standings[]` **is** populated at 0% during `setup` | Lobby renders roster from standings; no "you-only" fallback |
| **Q5** | **BACKEND WILL FIX** — `word` pool constrained to alpha-only ≤8 chars at resolve | Keep a config-error guard as backstop; no lossy workaround |
| **Q6** | `puzzle_count` = number of lock **types** (3–5, host-configurable), **not** fixed 5; a type may carry multiple IDs (pool) | **Do not hardcode 5.** Read `puzzle_count`; race lanes = that many dots |
| **Q7** | `/progress` **clamped** `[0,puzzle_count]`, not monotonic, not rate-limited | Fine for supervised event |
| **Q8** | Superseded device → old calls get **409**; `/players` is lobby-only so mid-race displaced device has **no re-auth path** | Terminal "opened on another device" message; mid-race refresh is a deferred product call |
| **Q9** | `voting_window_sec` = **total**; anchor at `voting_started_at` (in payload) | `remaining = voting_window_sec − (now − voting_started_at)` |
| **Q10** | One locked vote per player | Lock ballot after first accepted vote |
| **Q11** | CORS `*` on both bases | No allow-list work |
| **Q12** | `end_reason` ∈ `all_completed | force_completed | countdown_expired | reset` | Map podium copy to these |
| **Q2** | QR/URL shape is frontend-owned | Use `?game=<id>`; error if absent |
| **Q4** | Backend never resolves pillar side, no seed | Seed `hash(session_id + statement_id)` engine-side (deterministic) |
| **Q13** | Wager `target` is engine's choice | `target = number of mcq questions` |

## 5. Bank-resolution layer (the biggest new subsystem)

**Where the bank lives:** ship `docs/quiz-mode-question-bank.json` (171 KB) as a **same-origin** versioned asset (`app/data/quiz-mode-question-bank.json?v=N`, matching the `?v=` bump convention). Fetch once at boot/lobby, index `id → entry` per (category,type) for O(1) lookup. Same-origin keeps CORS off the critical path.

**Driver:** given `winning_category` + `picks{type:[ids]}`, resolve each type into the lock config its constructor already consumes. Canonical order: `numeric → word → statement → spelling → mcq` (picks is a JSON object; key order is not a contract). Derive puzzle count from resolved slots; cross-check against `standings.puzzle_count`.

**Type → lock mapping**

- **`numeric` → keypad-lock:** `{answer:String(entry.answer), falseOutputs:[<generic non-hinting flavor>]}`. All numeric answers are digit-only (1–6 digits). 13 carry a `unit` → append to the **question text** (`"… (in TiB)"`), never the answer.
- **`word` → word-lock:** `{answer: entry.answer}`. Backend now guarantees playable (≤8 alpha) after the Q5 fix; still guard: if a pick is non-alpha or >8, surface a config error (do not mangle).
- **`mcq` → wager-lock:** two bank shapes — `options:[4]` (use as-is, already includes answer) **or** `answer + decoys[3]` (build `options = [answer, ...decoys]`). Normalizer: `options = entry.options ?? [answer, ...decoys]`; assert answer present & ≥2 options. Config: `questions[]` in fixed order, single `Confident` stake (auto-skips picker), `revealAnswerOnWrong:false`, `repeatOnWrong:true`, `target = questions.length`.
- **`statement` → pillar-lock:** `{pillars:['True','False'], statements:[{text,answer}]}`. Each entry has a `template` with one `{trueValue|falseValue}` slot (index 0 = True, 1 = False). **Deterministic side per Q4:** `side = fnv1a(session_id + entry.id) & 1`; side 0 → substitute index-0 fragment, `answer:'True'`; side 1 → index-1, `answer:'False'`. Only the chosen fragment ever enters the DOM. Prefer explicit `correct`/`wrong` fields when present (e.g. `vnaws-stmt-002` anomaly); else index-0=correct; else config error.
- **`spelling` → spelling-lock:** pass `{title:'SPELL IT OUT', words:[resolved answers in deterministic order], sequential:true, scrambleLetters:true}` — pass an explicit `words` list (NOT `pool`+`pickCount`, which samples randomly per client and breaks cross-device fairness).

**Missing/malformed ID:** validate all slots immediately after `/puzzles`, before rendering puzzle 1. Report every bad id at once (`category`, `type`, `id`, reason) in `#play-mount` (reuse `.sd-error`), with a Retry that re-GETs `/puzzles` (idempotent). Never silently skip.

## 6. State machine + 1s polling → HEAT screens (no DOM/ID changes)

Replace the three current pollers with **one** self-scheduling `setTimeout` loop (in-flight lock, backoff 1→2→5s on error, pause on `document.hidden` + immediate poll on `visibilitychange`, **stop** at `completed`). `standings.state` is the single screen driver — never advance locally.

- **`setup` → LOBBY** (`#screen-lobby`): roster from `standings[].display_name` at 0%. `#lobby-code` banner → "Seat N" from `seat_number` (the "share this code" hint is removed — others join via QR). `#ready-btn` → disabled "Waiting for the host" (no endpoint).
- **`voting` → VOTE** (`#screen-vote`): ballot from `standings.categories[]` (map via `CAT_BY_ID`/`SD_ICONS` into `#vote-grid`). Countdown from `voting_window_sec` anchored at `voting_started_at`. Live tally from `standings.voting.tally`. Lock ballot after first vote. Reveal via `winning_category` / `assignment`.
- **`in_progress` → PLAY** (`#screen-play`): one-time `GET /puzzles` → resolve bank → `mountPuzzle()`. Race lanes = `puzzle_count` dots keyed by `player_id`, each player's solved dots = `round(completion_pct/100 × puzzle_count)`, fed through the existing `renderProgress()` `--solved` smooth-slide. Authoritative time = `standings.elapsed_ms` (play clock is cosmetic). `POST /progress` (cumulative) after each solve.
- **`completed` → RESULTS** (`#screen-results`): podium from `standings` **in server `rank` order — never client re-sort**. Champion = `winner_player_id`. `end_reason` → podium copy. Star rating re-anchored to `elapsed_ms`.

## 7. Engine-side deviations (no backend change; all fairness/correctness)

1. **Identity by `player_id`, not `display_name`** — every "is this me?" check (lobby, lanes, toasts, podium) rekeyed. Two "Alex"es currently corrupt all of them.
2. **Deterministic question selection** — pillar side (Q4) and spelling words seeded from `session_id`+id, so same-session players get identical content in a timed race.
3. **Render server `rank` verbatim** — no client re-rank (would disagree with the projector).
4. **Mock only on explicit `?mock=true`** — remove the implicit fallback-to-mock on network error (would show fake opponents/winner on flaky WiFi).
5. **PIN + identity persisted in `localStorage`** for refresh/reconnect recovery (rehydrate → `/public` → `/standings` → route by state; `/puzzles` idempotent).

## 8. Mock mode (`?mock=true`)

Interceptor matches the two API bases (not `/api/showdown/*`). Scripted timeline: `claim → /public (setup→session id) → /players → /vote → /puzzles → /progress → /standings` walking `setup→voting→in_progress→completed`. **`/puzzles` mock returns real bank IDs** (e.g. `agentic-*`) so the resolver, the `{a|b}` parser, and both mcq shapes are exercised offline. Fault switches for rehearsal: `&mockfail=bankid` (bogus id → config error) and `&mockfail=auth` (superseded-token path). No implicit fallback outside `?mock=true`.

## 9. UI changes the HEAT screens need (IDs preserved, no index.css/component edits)

- `#join-code` → **PIN** field (6 chars, uppercase, alphabet mask, `inputmode`).
- `#lobby-code` → "Seat N"; remove the share-code hint.
- `#ready-btn` → disabled "Waiting for the host".
- Penalty surfaces (`#play-penalties`, `#results-yours-line`, `.sd-lb-pen`) → keep nodes, show completion% + elapsed instead.
- Race lanes → `puzzle_count` dots keyed by `player_id` (was 5 hardcoded, keyed by name).
- "Waiting for next round" → reuse lobby screen with different status copy (no 6th screen).
- Missing `game_id` in URL → `#join-error` "Open this page from your table's QR code", form disabled.

## 10. Phased build sequence

- **P0 — Scaffolding:** bundle bank to `app/data/`, add to deploy manifest; add identity state fields; [A]/[S] base constants. *Test:* bank fetch+index in mock; `?mock=true` loads.
- **P1 — Identity/JOIN + discovery:** claim → `/public` poll → `/players`; JOIN → PIN + URL `game_id`. *Test:* mock walk reaches LOBBY; 403/409 inline errors; refresh restores identity.
- **P2 — State machine + standings poll:** one 1s loop + reducer→screen. *Test:* mock timeline flips screens; no DOM/ID drift.
- **P3 — Voting:** `/vote`, ballot/tally/countdown, reveal. *Test:* tally updates; reveal once; both close paths.
- **P4 — Bank resolver + PLAY:** `/puzzles` → resolver → `mountPuzzle()`; lanes from `completion_pct`; cumulative `/progress`. *Test:* per-type resolver unit tests vs real bank (options/decoys branch, pillar True & False, missing-ID error, `vnaws-stmt-002`); end-to-end solve reports progress.
- **P5 — RESULTS + cleanup:** podium/rank from standings; retire penalty/correct sort; hide dead UI. *Test:* podium by server rank; champion; DNF rows; play-again reset.
- **P6 — Hardening:** reconnect/refresh, superseded-token terminal message, offline mock badge, error copy. *Test:* kill/restore network mid-PLAY; reclaim PIN on 2nd device; live `dev` smoke test.

Each phase gated on the mock walkthrough before touching live; live smoke test at P1 and P6.

## 11. Known deferred items

- **Q8 mid-race token refresh** — product decision; today's terminal message is correct.
- **Client-authoritative scoring** — a DevTools user can POST `puzzles_completed`; accepted for a supervised on-site event (server clamps to `[0,puzzle_count]`).
- **wager-lock internal order shuffle** — every player gets the same question set; only order differs (bounded, accepted).
