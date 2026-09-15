# Episode 11 — War Room @ Tech Summit

## 1. Meta

| Field | Value |
|-------|-------|
| Episode | 11 |
| Title | War Room @ Tech Summit |
| Arc | Frontier Agents |
| Category | aws |
| Duration | ~15 minutes (booth / walk-up) |
| Players | 1–1000+ (solo, leaderboard) |
| Difficulty | Tier 1 — Booth (walk-up) |
| AWS Topics | AWS DevOps Agent, AWS Security Agent (Continuum), AWS FinOps Agent, Amazon Bedrock, Incident Response, Cost Anomaly Detection, CloudTrail, AWS Secrets Manager, IAM |
| Setting | APJC Tech Summit, Conrad Singapore — player joins a customer war room VIRTUALLY over a video bridge from the summit floor |
| Tone | High-stakes incident response, advisory, accuracy-first for a technical crowd |
| Event | APJC Tech Summit 2026 — ASEAN (Sep 16–17, Conrad Singapore Orchard) |

**Premise:** You're at the Tech Summit when the VP of Engineering at a customer you've supported for years calls. Leaked credentials are running fraudulent Amazon Bedrock inference and the bill is spiking. You join the war-room video bridge — the customer's team is already running three AWS frontier agents in their environment. You don't touch the keyboard; you **advise**: discover, fix, prevent. At the end you drop off the bridge.

**Design pillars (standing rules):**
- **Advisory framing** — the player ADVISES the VP/team; the agents + team execute. Never "your role does the thing"; never auto-narrate the player's action. Each console: "here's what the agent found — do we act, or hold?"
- **Virtual join** — consoles are screens the team shares on the call; the player is remote (reinforces advise-not-touch).
- **Customer-VP relationship** — the VP is a long-standing customer contact; the relationship is WHY they call the player first.
- **Accuracy ground-truth** — every agent does ONLY what AWS documents. A technical crowd will catch overstatement.

**Learning Objectives:**
1. What each AWS frontier agent really does — and its honest boundaries.
2. AWS DevOps Agent: investigates, root-causes, produces mitigation plans; acts only via approved directed actions; cannot touch IAM keys.
3. AWS Security Agent (Continuum): code review + pen testing; found the hardcoded secret, staged a fix PR; does not revoke live IAM.
4. AWS FinOps Agent: cost-anomaly + CloudTrail attribution; reports only, no kill-switch.
5. Cross-discipline judgment — no single agent sees the whole picture; a human connects all three.

---

## 2. Accuracy Ground Truth (verified vs official AWS docs)

| Agent | Real capability | Can it act live? |
|-------|-----------------|------------------|
| **AWS DevOps Agent** | Root-cause on operational events; mitigation plans; prevention recommendations (agent-ready specs a human/Kiro implements). Executes only via **directed actions** — disabled by default, per-action human approval, logged to CloudTrail. Managed policy **excludes iam:*/sts:* and delete-class ops**. | Only with approval — and never on IAM keys |
| **AWS Security Agent (Continuum)** | Pen testing (OWASP), code review + fix-PRs, STRIDE threat modeling, design review. Here: **code review found the hardcoded secret** and staged a fix PR. | No — fixes CODE, does not revoke live IAM |
| **AWS FinOps Agent** | Cost Anomaly Detection → correlates CloudTrail → names cause + owner → reports to Slack/Jira. | No kill-switch — reports only |

**Incident resolution order (accurate):** the **team deactivates the leaked key first** (stops the bleeding) → **Continuum's PR** removes the secret from code → **DevOps Agent recommends** least-privilege + an SCP so a leaked key can't call Bedrock at scale, **team (or Kiro) implements** → **FinOps** attributes the spend. CloudTrail supplies the runtime timeline.

> **Prevention wording:** NOT "Bedrock Guardrails" (that is content-filtering — irrelevant to LLMjacking). Correct = least-privilege IAM + an SCP.

---

## 3. Room Graph (linear — booth-friendly, never stalls)

```
[100 War Room] ──▶ [200 DevOps Console] ──▶ [300 Security Console (Continuum)] ──▶ [400 FinOps Console] ──▶ [500 Synthesis] ──▶ [600 Resolved]
```

| Room | Unlocked by | Gate |
|------|-------------|------|
| 100 War Room | start | — |
| 200 DevOps Console | discovery from 100 | — |
| 300 Security Console | discovery from 200 | requires DevOps Finding (205) |
| 400 FinOps Console | discovery from 300 | requires Security Finding (305) |
| 500 Synthesis | discovery from 400 | requires FinOps Finding (405) |
| 600 Resolved | discovery from 500 | requires 205+305+405 (consumed by finale 599) |

Role select was REMOVED (was cosmetic, gated nothing meaningful). Player goes straight into the war room.

---

## 4. Puzzles

| Room | Puzzle | Type | ui | Teaches | Notes |
|------|--------|------|-----|---------|-------|
| 200 | log-devops | log-lock | log-lock | DevOps root-cause on ops log | pick 2 malicious `bedrock:InvokeModel` lines (leaked key AKIA…K7Q). `high_contrast:true` |
| 200 | npc-devops | tool | npc-dialog | DevOps capability + boundary | — |
| 200 | npc-decision-devops | tool | npc-dialog | Advise: key-first, then guardrail rec | **decision beat** — wrong pick = 30s penalty + VP pushback; correct answer position shuffled |
| 300 | timeline-security | timeline-lock | timeline-lock | Continuum code finding + CloudTrail runtime | `enhanced:true` (high-vis swap UI); events split Continuum(code) vs CloudTrail(runtime) |
| 300 | npc-security / npc-decision-security | tool | npc-dialog | Continuum boundary; advise scoped fix | decision beat |
| 400 | evidence-finops | evidence-lock | evidence-lock | Cost math + CloudTrail signer attribution | 42,000−1,200=40,800 fraudulent; `high_contrast:true` (light-theme readability) |
| 400 | npc-finops / npc-decision-finops | tool | npc-dialog | FinOps no-kill-switch; advise owner | decision beat |
| 500 | cascade-synthesis | cascade-lock | cascade-lock | Chain all three findings | 4-step MCQ finale; `shuffle_options:true`; requires+consumes 205/305/405; `is_ending` → 599 |

**Interaction variety:** tap-select (log), tap-swap (timeline), type (evidence), MCQ (cascade), dialog (npc). ≥3 types ✓. RARE: evidence-lock, cascade-lock.

**Opt-in component flags (ep11 only — all default off, backward-compatible across shared components):**
`npc-dialog.decision`, `log-lock.high_contrast`, `timeline-lock.enhanced`, `evidence-lock.high_contrast`, `cascade-lock.shuffle_options`.

---

## 5. Decision Beats (the advisory mechanic)

Three `npc-dialog` tool-puzzles (`npc-decision-devops/security/finops`) added so the advisory promise pays off:
- Correct "advise" option → VP confirms → awards the Finding item (205/305/405) via `success_card` → unlocks "End Conversation".
- Wrong option → **30s time penalty + VP pushback** → re-pick. Soft: never hard-blocks (walk-ups must always finish).
- Correct-answer position is **shuffled** (not always first).
- Penalty/gating wired ONLY in the `decision:true` path — other episodes' npc-dialogs unaffected.

---

## 6. Item Chain

```
log-devops ─▶ 202 (log confirmed) ─▶ decision beat ─▶ 205 DevOps Finding
timeline-security ─▶ 302 ─▶ decision beat ─▶ 305 Security Finding
evidence-finops ─▶ 402 ─▶ decision beat ─▶ 405 FinOps Finding
205 + 305 + 405 ─▶ (required + consumed by) cascade-synthesis / 599 (is_ending) ─▶ 600 Resolved
```

---

## 7. Scoring (booth — deliberately generous)

| Field | Value |
|-------|-------|
| base_score | 50 |
| time_bonus_per_minute | +3 |
| hint_penalty | −1 |
| wrong_combination_penalty | −2 |
| lore_bonus / all_lore_bonus | +2 each / +5 |
| lore_ids | 101, 106, 201, 301, 401, 501, 601 |

Stars: 5★ ≥62 · 4★ ≥52 · 3★ ≥40 · 2★ ≥25 · 1★ ≥0. Wrong validation is a soft penalty, never a hard block.

---

## 8. Images (assets/)

Video-bridge framing, back/side-view figures only (no front-facing faces). cover, war-room, devops-station, security-station, finops-station, synthesis, resolved, + 3 agent icons (agent-devops/security/finops). Palette: #FF9900 / #232F3E / #0D1424 / #1AB7C6 / #E0E6F0. Resize aspect-safe (scenes ~768×525, icons 320×320) before deploy.

---

## 9. End-Card Takeaway

"You didn't fix this alone — and neither could any single agent. It took a human to connect all three." Reinforces cross-discipline judgment as the human's irreplaceable role alongside frontier agents.
