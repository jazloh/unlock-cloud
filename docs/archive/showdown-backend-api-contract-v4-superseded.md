> ⛔ **SUPERSEDED 2026-09-17.** This is the original *frontend-authored proposal* for the Showdown backend. The backend was ultimately built to a different contract; ~85% of this document is now counterfactual. **Do not implement against this doc.** The single source of truth is [`docs/showdown-api-integration.md`](../showdown-api-integration.md), which reflects the deployed API. Kept for historical record only.

---

# Showdown Mode — Backend API Contract

> **For:** Backend Engineer **From:** Frontend/Engine Engineer **Date:** 2026-08-26 **Status:** Draft v4 — all 5 phases complete

---

## Overview

Showdown is a multiplayer quiz battle mode. The frontend (`app/showdown.html`) handles UI rendering and puzzle gameplay. The backend handles session management, voting, question assembly, scoring, and the leaderboard.

**Flow:** Join → Lobby → Vote → Play (5 puzzles) → Results

---

## API Endpoints Required

### 1. `POST /api/showdown/join`

Player joins a session.

**Request:**

```json
{
  "name": "PlayerName",
  "sessionCode": "ABC123"
}

```

**Response (success):**

```json
{
  "success": true,
  "session": {
    "code": "ABC123",
    "players": [
      { "name": "PlayerName", "ready": false }
    ],
    "state": "lobby",
    "maxPlayers": 5
  }
}

```

**Response (error):**

```json
{
  "success": false,
  "error": "Session not found"  // or "Session is full" or "Name already taken"
}

```

---

### 2. `POST /api/showdown/ready`

Player toggles ready status.

**Request:**

```json
{
  "sessionCode": "ABC123",
  "playerName": "PlayerName",
  "ready": true
}

```

**Response:**

```json
{ "success": true }

```

---

### 3. `GET /api/showdown/session/{sessionCode}`

Frontend polls this every 2 seconds for lobby/vote state updates.

**Response (lobby state):**

```json
{
  "code": "ABC123",
  "state": "lobby",
  "players": [
    { "name": "Alice", "ready": true },
    { "name": "Bob", "ready": false },
    { "name": "Charlie", "ready": true }
  ],
  "maxPlayers": 5,
  "enabledCategories": ["AWS Core Services", "Agentic AI", "Security", "Vietnam & AWS", "Startups & Innovation", "Cloud Fundamentals"]
}

```

**Response (voting state):**

```json
{
  "code": "ABC123",
  "state": "voting",
  "players": [...],
  "enabledCategories": ["AWS Core Services", "Agentic AI", "Security", "Vietnam & AWS", "Startups & Innovation", "Cloud Fundamentals"],
  "votes": {
    "Agentic AI": 2,
    "Security": 1
  },
  "voteResolved": false,
  "winningCategory": null
}

```

**Response (vote resolved):**

```json
{
  "code": "ABC123",
  "state": "playing",
  "winningCategory": "Agentic AI",
  "votes": { "Agentic AI": 2, "Security": 1 }
}

```

**State transitions:** `lobby` → `voting` → `playing` → `complete`

- `lobby` → `voting`: when all players (≥3) are ready
- `voting` → `playing`: when vote resolves (majority or timeout + random tiebreak)
- `playing` → `complete`: when all players submit results (or timeout)

---

### 4. `POST /api/showdown/vote`

Player submits/changes their category vote.

**Request:**

```json
{
  "sessionCode": "ABC123",
  "playerName": "Alice",
  "category": "Agentic AI"
}

```

**Response:**

```json
{ "success": true }

```

**Rules:**

- Allow changing vote until voting closes
- Resolve by majority; tie broken randomly
- Only offer categories currently enabled (admin-controlled flag)
- Lock result once resolved

---

### 5. `GET /api/showdown/puzzles/{sessionCode}`

After vote resolves, frontend fetches the assembled puzzle set.

**Response:**

```json
{
  "category": "Agentic AI",
  "puzzles": [
    {
      "id": "q1-keypad",
      "type": "quiz_lock",
      "ui": "keypad-lock",
      "question": "In what year was Amazon Q Developer first announced?",
      "config": {
        "answer": "2025",
        "falseOutputs": ["Access denied. That vault belongs to a different era."]
      }
    },
    {
      "id": "q2-word",
      "type": "quiz_lock",
      "ui": "word-lock",
      "question": "What 7-letter word means 'a sudden change of course'?",
      "config": {
        "answer": "TANGENT"
      }
    },
    {
      "id": "q3-pillar",
      "type": "quiz_lock",
      "ui": "pillar-lock",
      "question": "Classify each statement as True or False:",
      "config": {
        "pillars": ["True", "False"],
        "statements": [
          { "text": "Statement text here (already resolved, no raw templates)", "answer": "True" },
          { "text": "Another statement", "answer": "False" }
        ]
      }
    },
    {
      "id": "q4-spelling",
      "type": "quiz_lock",
      "ui": "spelling-lock",
      "question": "Unscramble each term:",
      "config": {
        "pool": ["TANGENT", "MEMORY", "KIRO POWER"],
        "pickCount": 3,
        "sequential": true,
        "scrambleLetters": true
      }
    },
    {
      "id": "q5-wager",
      "type": "quiz_lock",
      "ui": "wager-lock",
      "question": "Answer the multiple-choice questions:",
      "config": {
        "target": 6,
        "questions": [
          { "question": "Q text?", "options": ["A","B","C","D"], "answer": "A" }
        ],
        "stakes": [
          { "label": "Confident", "wager": 1, "penalty": 0, "color": "#eab308", "showOptions": 4 }
        ],
        "revealAnswerOnWrong": false
      }
    }
  ]
}

```

**CRITICAL Security Rules:**

1. Only send each client questions relevant to their session — never the entire bank
2. For pillar-lock: resolve `{correct|wrong}` templates SERVER-SIDE before sending. Client must never see both sides.
3. All players in the same session get IDENTICAL puzzle content
4. Assembly happens once per session, not once per player

---

### 6. `POST /api/showdown/penalty`

Frontend fires this on each wrong answer (fire-and-forget, no blocking).

**Request:**

```json
{
  "sessionCode": "ABC123",
  "playerName": "Alice",
  "puzzleId": "q1-keypad",
  "timestamp": 1724598000000
}

```

**Response:**

```json
{ "success": true }

```

---

### 7. `POST /api/showdown/result`

Frontend submits when player completes all 5 puzzles.

**Request:**

```json
{
  "sessionCode": "ABC123",
  "playerName": "Alice",
  "correct": 5,
  "penalties": 3,
  "timeMs": 95000
}

```

**Response:**

```json
{ "success": true }

```

---

### 8. `GET /api/showdown/leaderboard/{sessionCode}`

Frontend polls this after completion.

**Response:**

```json
{
  "state": "complete",
  "leaderboard": [
    { "rank": 1, "name": "Alice", "correct": 5, "penalties": 2, "timeMs": 95000 },
    { "rank": 2, "name": "Bob", "correct": 5, "penalties": 3, "timeMs": 110000 },
    { "rank": 3, "name": "Charlie", "correct": 4, "penalties": 1, "timeMs": 85000 }
  ]
}

```

**Ranking logic:**

1. Most correct answers (primary)
2. Fewest penalties (tiebreaker 1)
3. Fastest time in ms (tiebreaker 2)

---

## Security Requirements

### Authentication (MANDATORY)

On successful `/join`, return a `playerToken` (UUID v4 or short JWT). All subsequent requests MUST include:

```
Authorization: Bearer {playerToken}

```

Backend validates:

- Token exists and is not expired
- Token maps to the claimed `playerName` + `sessionCode`
- Reject with 401 if invalid

Tokens expire when session moves to "complete" state (or after 2 hours).

### Answer Protection — Server-Side Validation (MANDATORY)

**Answers are NEVER sent to the client.** The `/puzzles` endpoint returns questions WITHOUT answer fields. Instead, the client submits each attempt to a new `/attempt` endpoint for server-side validation.

---

### NEW ENDPOINT: `POST /api/showdown/attempt`

Player submits an answer attempt for a specific puzzle.

**Request:**

```json
{
  "sessionCode": "ABC123",
  "puzzleId": "q1-keypad",
  "attempt": "2025"
}

```

(Authorization header required)

**Response (correct):**

```json
{
  "correct": true,
  "puzzleId": "q1-keypad"
}

```

**Response (incorrect):**

```json
{
  "correct": false,
  "puzzleId": "q1-keypad",
  "penaltyApplied": true
}

```

**Attempt format per puzzle type:**

| Puzzle | `attempt` field format | Example |
| --- | --- | --- |
| keypad-lock | String (digits) | `"2025"` |
| word-lock | String (uppercase) | `"TANGENT"` |
| pillar-lock | Array of "True"/"False" | `["True","False","True","False"]` |
| spelling-lock | String (the word) | `"DYNAMODB"` |
| wager-lock | Object with answer + index | `{"answer":"DDoS","questionIndex":0}` |

**Rules:**

- Backend validates attempt against stored answer
- On wrong: auto-increment player's penalty count server-side
- For pillar-lock: return correct only if ALL answers match
- Rate limit: max 60 attempts per player per session

---

### Impact on `/puzzles` Response

Remove ALL `answer` fields before sending to client:

| Puzzle | Field to REMOVE | What client still gets |
| --- | --- | --- |
| keypad-lock | `config.answer` | `falseOutputs` only |
| word-lock | `config.answer` | Nothing (word length discoverable from reel count) |
| pillar-lock | `statements[].answer` | `statements[].text` + `pillars` array |
| spelling-lock | (pool IS the answer) | `pool` (shuffled letters) — fine, player sees them anyway |
| wager-lock | `questions[].answer` | `questions[].question` + `options` |

---

### Result Validation (MANDATORY)

Backend MUST compute final results from its own records:

1. Track `puzzle_start_time` server-side (when player first GETs `/puzzles`)
2. Count penalties from failed `/attempt` calls (not from client-reported `/penalty` POSTs)
3. Count correct answers from successful `/attempt` calls
4. On `POST /result`, cross-validate:- `timeMs` ≈ `(server_now - puzzle_start_time)` ± 5s tolerance

- `correct` matches backend's successful `/attempt` count
- `penalties` ≥ backend's failed `/attempt` count
- **Reject if validation fails** (400 + reason)

### Rate Limiting (MANDATORY)

| Endpoint | Limit | Reason |
| --- | --- | --- |
| `/join` | 5 per IP per minute | Prevent code brute-force |
| `/attempt` | 60 per player per session | Prevent answer brute-force |
| `/vote` | 10 per player | Prevent vote-flip abuse |
| `/ready` | 20 per player | Prevent toggle spam |

### CORS (MANDATORY)

```
Access-Control-Allow-Origin: https://beta.re-solve.cloud
Access-Control-Allow-Origin: http://localhost:8080

```

No wildcard (`*`).

### Session Expiry

- Auto-expire 2 hours after creation
- Return `410 Gone` on all endpoints for expired sessions
- Admin can manually expire/reset

---

## Session Lifecycle

```
Admin creates session (via admin portal) → generates 6-char code
   ↓
Players join with code → state: "lobby"
   ↓
All players ready (≥3 minimum) → state: "voting"
   ↓
30s voting countdown → majority wins (tie = random) → state: "playing"
   ↓
Backend assembles 5 puzzles from winning category → serves via GET /puzzles
   ↓
Players solve puzzles → POST /result when done → state: "complete" when all finish
   ↓
Leaderboard available via GET /leaderboard

```

---

## Admin Controls Needed

1. **Create session** — generates a new 6-char code, sets max players
2. **Enable/disable categories** — toggle per category (prevents it from appearing on ballot)
3. **Reset session** — clear all players/votes for a fresh round
4. **Force-start voting** — skip waiting for all players to be ready
5. **Force-resolve vote** — manually pick a category if voting is stuck

---

## Open Questions (Confirm Before Building)

| # | Question | Options |
| --- | --- | --- |
| 1 | Penalty tracking: per-player or pooled? | **Recommended: per-player** (each player's own mistakes count only against them) |
| 2 | Timeout for completing puzzles? | Frontend has no timeout currently — should backend enforce one? (e.g., 10 min max) |
| 3 | What if a player disconnects mid-game? | Mark as "did not finish" with their partial progress? |
| 4 | Real-time progress (see other players' puzzle progress)? | WebSocket (best UX) vs polling (simpler)? |
| 5 | Session code format? | Frontend validates 6-char alphanumeric — confirm this matches your generator |

---

## Frontend Test Page

You can see the full UI (with mock data) at:

```
http://localhost:8080/app/showdown.html?mock=true

```

The mock simulates all API responses so you can see exactly what the frontend expects at each stage.

---

## Question Bank Reference

- File: `docs/quiz-mode-question-bank.json` (486 entries, 81 per category)
- Types per category: 13 numeric, 13 word, 30 mcq, 25 statement, 9 spelling (added 2026-08-25)
- Puzzle config format: `docs/quiz-mode-puzzle-config-example.json`
- Full backend instructions: `docs/quiz-mode-instructions-backend.md`
- Full engine instructions: `docs/quiz-mode-instructions-engine.md`

---

## Phase 3: Real-Time Progress (WebSocket)

### Why This Is Needed

During the PLAY phase, players want to see other players' live progress ("Alice just solved puzzle 3!"). This creates competitive tension — the core "battle" feel of Showdown.

Without real-time: players solve puzzles in isolation and only see others' results at the end. With real-time: players see a live progress bar showing who's ahead, creating urgency.

### Architecture Decision: REST Polling (consistent with existing engine)

The existing re:Solve engine uses **REST polling with event queue batching** (see `LeaderboardClient` in `engine.js`):

- Events queued locally → flushed every 10 seconds via POST
- Status polled every 10 seconds via GET
- No WebSocket, no SSE anywhere in the codebase

**Showdown MUST follow the same pattern for consistency.** Use REST polling at 2-3 second intervals during the PLAY phase (shorter than the 10s normal mode because Showdown games are faster).

### WebSocket Endpoint

```
ws://[backend-host]/api/showdown/ws/{sessionCode}?token={playerToken}

```

**Connection lifecycle:**

1. Frontend connects after joining the session (lobby phase)
2. Connection stays open through lobby → vote → play → results
3. Server pushes events; frontend sends minimal messages (ready, vote, attempt)
4. Connection closes when session moves to "complete" or after 2-hour expiry

### Server → Client Messages (pushed by backend)

```json
// Player joined/left
{ "type": "player_update", "players": [{"name":"Alice","ready":true}, ...] }

// Vote update
{ "type": "vote_update", "votes": {"agentic-ai": 2, "security": 1}, "timeLeft": 15 }

// Vote resolved
{ "type": "vote_resolved", "winningCategory": "agentic-ai" }

// Player progress (during PLAY phase) — key for competitive feel
{ "type": "progress", "player": "Alice", "puzzlesSolved": 3, "totalPuzzles": 5 }

// Player finished
{ "type": "player_finished", "player": "Alice", "rank": 1, "timeMs": 95000 }

// Game complete — all players done
{ "type": "game_complete", "leaderboard": [...] }

```

### Client → Server Messages (sent by frontend)

```json
// Player ready (replaces POST /ready)
{ "type": "ready", "ready": true }

// Vote (replaces POST /vote)
{ "type": "vote", "category": "agentic-ai" }

// Puzzle attempt (replaces POST /attempt)
{ "type": "attempt", "puzzleId": "q1-keypad", "attempt": "2025" }
// Server responds with: { "type": "attempt_result", "puzzleId": "q1-keypad", "correct": true }

```

### Fallback: REST Polling

If WebSocket isn't feasible for the timeline, the frontend already supports REST polling via `GET /session/{code}`. Add a `progress` field to the session response:

```json
{
  "state": "playing",
  "progress": {
    "Alice": { "solved": 3, "penalties": 1 },
    "Bob": { "solved": 2, "penalties": 0 },
    "Charlie": { "solved": 4, "penalties": 2 }
  }
}

```

Frontend polls this every 2 seconds during the PLAY phase and updates the progress UI.

### Frontend Integration (what we'll build)

- During PLAY phase: show a small progress panel at the top showing all players' puzzle completion (e.g., progress dots or a mini leaderboard)
- Visual indicator when someone finishes ahead of you ("🏁 Alice finished!")
- Sound effect when someone completes a puzzle (optional, adds competitive pressure)

### Decision Needed from Backend Engineer

| Option | Pros | Cons | Effort |
| --- | --- | --- | --- |
| **WebSocket** | Real-time (<100ms), less server load, bidirectional | More complex infrastructure, connection management | Medium-High |
| **REST Polling** (2s interval) | Simple, stateless, works everywhere | Laggy (up to 2s delay), more HTTP requests at scale | Low |
| **SSE (Server-Sent Events)** | Real-time for server→client, simpler than WS | One-directional only (client→server still needs REST) | Medium |

**Recommendation for Hanoi (Sept 29):** Start with REST polling (add `progress` to session response). It's the simplest to build and "good enough" for a live event. Upgrade to WebSocket post-event if the mode becomes permanent.

---

## Validation Flow Summary (Hybrid Architecture)

```
┌─ Frontend (instant UX) ───────────────────────────────────────┐
│  Player answers → client validates locally → shows result      │
│  + async fire-and-forget POST /attempt to backend              │
└────────────────────────────────────────────────────────────────┘
                              ↕
┌─ Backend (source of truth) ───────────────────────────────────┐
│  Receives /attempt → validates independently → tracks score    │
│  On POST /result → cross-validates client vs server records    │
│  Leaderboard computed from SERVER-SIDE records only            │
└────────────────────────────────────────────────────────────────┘

```

