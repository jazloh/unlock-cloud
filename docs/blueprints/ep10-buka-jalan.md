# Episode 10 — Buka Jalan

## 1. Meta

| Field | Value |
|-------|-------|
| Episode | 10 |
| Title | Buka Jalan (Clear the Way / Open the Road) |
| Arc | AIDLC |
| Category | aws |
| Duration | 45 minutes |
| Players | 1–1000+ (solo, leaderboard) |
| Difficulty | Tier 2 — Intermediate |
| AWS Topics | AI-DLC, Adaptive Workflows, AI Coding Agents, Context Management, Parallel Construction, Human-in-the-Loop, Dual-Loop Verification |
| Setting | Kuala Lumpur — worst traffic jam of the year crashes the GoLancar ride-hailing app; ship the fix before rush hour ends |
| Tone | Relatable KL commuter comedy; mamak, teh tarik, LRT; fun-first with AI-DLC woven in |
| Audience | Malaysian audience (gov-safe) |
| Cloned from | ep8-macet (Jakarta "Macet"), localized 2026-08-27 |

**Premise:** KL's worst traffic jam just crashed your ride-hailing app (GoLancar). Ship the fix before rush hour ends. Discover the AI-powered express lane (AI-DLC) — or navigate every turn yourself. Two paths, presented equally: **Manual Navigation** (do it yourself, slower) vs **AI Navigator** (AI-DLC express lane). Manual is not "bad" — just slower.

**Localization (Jakarta → KL):** TransJakarta BRT → RapidKL LRT; warung → mamak; kopi → teh tarik; Pak Dedi → Pak Din / Pak Ali; Bahasa Indonesia → Bahasa Melayu (locale `ms.json`). GoLancar kept as fictional app (avoids using a real ride-hail crashing at a gov event). Gov-audience content scan clean (busway→LRT, indomie→maggi, TransKuala Lumpur→RapidKL, "sesak banget"→"sesak gila").

**Learning Objectives (AI-DLC made tangible):**
1. Adaptive workflow composition (the two-paths choice + traffic-lane sort).
2. Context management (context-lock).
3. AI proposes, human validates (spec-lock).
4. Dual-loop verification (defuse-lock).
5. Parallel construction / "BOLTS" (word-lock).
6. Learning loop — decisions become rules (match-lock).
7. Core principle: ADAPT (finale word-lock).

---

## 2. Room Graph (dual-path)

```
                                   ┌─▶ [600 Express Lane (AI-DLC)] ─┐
[100 Gridlock] ▶ [200 Tollbooth] ─┤                                ├─▶ [400 Construction] ▶ [500 Verification] ▶ [1000 Learning Loop] ▶ [700 Deployment]
                                   └─▶ [300 Overpass] ▶ [900 Log Jam] ─┘
                          └─▶ [800 The Mamak] (optional backstory)
```

- **AI-DLC path:** 100 → 200 → 600 → 400 → 500 → 1000 → 700 (faster)
- **Manual path:** 100 → 200 → 300 → 900 → 400 → 500 → 1000 → 700
- Pivot mechanic: manual players can discover the express lane mid-game and switch.

| Room | Name | Unlock text (start) |
|------|------|---------------------|
| 100 | The Gridlock | Traffic hasn't moved in 20 minutes. Your phone… |
| 200 | Requirements Tollbooth | You open your laptop. A toll plaza blocks the… |
| 800 | The Mamak | Pak Ali waves you over for a quick… (optional) |
| 300 | Architecture Overpass | The toll sign turns green. A wide overpass… |
| 900 | The Log Jam | Traffic stops dead. The crash logs scatter… |
| 600 | The Express Lane | The LRT gate opens onto empty, fast asphalt. |
| 400 | Construction Lane | Cranes and cones. Your coding terminal waits… |
| 500 | Verification Checkpoint | Scanners and blinking lights block the lane… |
| 1000 | The Learning Loop | The fix is live — but Kiro wants to learn from… |
| 700 | Deployment Terminal | GoLancar HQ. The map is waiting to light back… |

---

## 3. Puzzles

| Room | Puzzle | Type | Teaches |
|------|--------|------|---------|
| 100 | npc-pakdedi | npc-dialog | Story intro, route hints |
| 200 | npc-pakbudi | npc-dialog | AI-DLC basics, LRT pass |
| 200 | wordlock-scope | word-lock | Adaptive depth (SCOPE) |
| 300 | blueprint-arch | blueprint-lock | Architecture (manual path) |
| 900 | timeline-crash | timeline-lock | Crash tracing (manual path) |
| 600 | ctx-aidlc | context-lock | Context management |
| 600 | wordlock-bolts | word-lock | Parallel construction (BOLTS) |
| 400 | triage-lanes | traffic-lane-lock | Adaptive composition (AI/Human/Skip sort) |
| 400 | npc-rina | npc-dialog | Sub-agents, human gates (Kiro) |
| 400 | spec-validate | spec-lock | AI proposes, human validates |
| 500 | defuse-bugs | defuse-lock | Dual-loop verification |
| 500 | wordlock-ship | word-lock | Human approval gate (SHIP) |
| 1000 | match-learn | match-lock | Learning loop (decisions → rules) |
| 700 | wordlock-adapt | word-lock | Core principle (ADAPT — finale) |
| 800 | npc-commuter | npc-dialog | Optional backstory |

**Interaction variety:** word (×4), context, blueprint, timeline, traffic-lane, spec, defuse, match, dialog. ≥3 types ✓. Custom RARE type: traffic-lane-lock.

---

## 4. Scoring

Stars: 5★ ≥85 · 4★ ≥70 · 3★ ≥45 · 2★ ≥25 · 1★ ≥0.
lore_ids: 101, 201, 302, 402, 501, 603, 604, 801, 803, 902, 1002. Per-path lore bonuses (AI-DLC vs manual).

---

## 5. Notes

- Registered in `scenarios/aws/index.json`; counted in `scenarios/categories.json` (AWS).
- Locale: `locales/ms.json` + `locales/index.json` → `{"code":"ms","label":"Bahasa Melayu","flag":"🇲🇾"}`.
- Optional mamak room (800) is backstory-only — does not gate progression.
- Full engine + role system (Builder / Planner / Strategist lanes, mid-game switching) inherited from ep8.
