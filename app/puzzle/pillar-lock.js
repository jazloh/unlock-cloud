/**
 * Well-Architected Lock Puzzle
 *
 * Statements appear. Player sorts each into the correct Well-Architected pillar.
 *
 * Usage:
 *   new PillarLock(containerEl, {
 *     pillars: ['Security','Reliability','Performance','Cost','Operational Excellence'],
 *     statements: [
 *       { text: 'Encrypt data at rest and in transit', answer: 'Security' },
 *       { text: 'Deploy across multiple AZs', answer: 'Reliability' },
 *       { text: 'Use caching to reduce latency', answer: 'Performance' },
 *       { text: 'Right-size instances for workload', answer: 'Cost' },
 *       { text: 'Automate runbooks for incidents', answer: 'Operational Excellence' },
 *     ],
 *     onSubmit(correct) { ... }
 *   });
 *
 * Optional teaching feedback on wrong picks (opt-in, backward compatible):
 *   - Per-statement: statement.wrong_feedback = { 'PillarName': 'text', ... }
 *   - Per-config fallback: opts.pillar_wrong_feedback = { 'PillarName': 'text', ... }
 *   When either is present, the puzzle uses inline retry: on a wrong pick it shows the
 *   teaching text and lets the player try the same statement again, instead of the
 *   legacy "advance and reset on imperfect" flow.
 */

class PillarLock {
  constructor(container, opts = {}) {
    this.container = container;
    this.pillars = opts.pillars || [];
    this.statements = opts.statements || [];
    this.onSubmit = opts.onSubmit || (() => {});
    this.onWrong = opts.onWrong || null;
    this.pillarWrongFeedback = opts.pillar_wrong_feedback || opts.pillarWrongFeedback || {};
    // Retry-on-wrong (inline teaching) is enabled when any teaching text is configured.
    // Explicit override wins if provided. Takes precedence over immediateWrong below —
    // the two modes solve different problems and aren't meant to combine.
    this.retryOnWrong = (typeof opts.retryOnWrong === 'boolean')
      ? opts.retryOnWrong
      : (Object.keys(this.pillarWrongFeedback).length > 0
         || this.statements.some(s => s && s.wrong_feedback));
    /* immediateWrong (OPT-IN, default off so the episodes using this lock keep the
     * original flow): fire onWrong the moment a statement is sorted incorrectly,
     * rather than only after EVERY statement has been sorted. Previously the
     * penalty arrived at the very end of the sequence, which reads to a player as
     * "wrong answers cost nothing".
     *
     * It also holds the wrong card on screen for wrongHoldMs before advancing, so
     * the card stays visible for the whole of Showdown's 5s input lockout instead
     * of sliding on behind the scrim, and it suppresses the duplicate end-of-pass
     * onWrong so one mistake costs exactly one penalty. Ignored when retryOnWrong
     * is active. */
    const cfg = opts.config || {};
    this.immediateWrong = !!(opts.immediateWrong != null ? opts.immediateWrong : cfg.immediateWrong);
    const hold = opts.wrongHoldMs != null ? opts.wrongHoldMs : cfg.wrongHoldMs;
    this.wrongHoldMs = Number(hold != null ? hold : 5200);
    /* nextStatement (OPT-IN, default null → unchanged behaviour for episodes):
     * a supplier called after a wrong sort has served its hold, returning a
     * REPLACEMENT statement for the same slot. With it, a mistake costs the hold
     * and then re-asks the slot with fresh content; the set is never restarted and
     * a correct run of statements.length always finishes the puzzle.
     *
     * Why: in a competitive race the legacy flow advanced past a wrong sort, ran
     * out the remaining statements, and then threw the WHOLE pass away — so one
     * mistake on statement 1 meant answering four more for nothing and starting
     * over. The penalty was effectively unbounded and players read it as the puzzle
     * being broken. Re-asking the slot keeps the cost exactly one hold.
     *
     * Requires immediateWrong (the hold is what the player is being charged) and is
     * ignored under retryOnWrong, which already keeps the player on the statement. */
    this.nextStatement = typeof opts.nextStatement === 'function' ? opts.nextStatement : null;
    this._penalised = false;   // did this pass already report a wrong?
    this._advanceTimer = null; // pending statement advance (cancellable; see _scheduleAdvance)
    this.current = 0;
    this.answers = [];
    this._render();
  }

  _render() {
    this.container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'pillk';

    // Progress
    this.progressEl = document.createElement('div');
    this.progressEl.className = 'pillk-progress';
    wrap.appendChild(this.progressEl);

    // Statement card
    this.cardEl = document.createElement('div');
    this.cardEl.className = 'pillk-card';
    wrap.appendChild(this.cardEl);

    // Pillar buttons
    this.pillarBtns = document.createElement('div');
    this.pillarBtns.className = 'pillk-pillars';
    this.pillars.forEach(p => {
      const btn = document.createElement('button');
      btn.className = 'pillk-pillar';
      btn.textContent = p;
      btn.addEventListener('click', () => this._choose(p));
      this.pillarBtns.appendChild(btn);
    });
    wrap.appendChild(this.pillarBtns);

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'pillk-status';
    wrap.appendChild(this.statusEl);

    this.container.appendChild(wrap);
    this._injectStyles();
    this._showCurrent();
  }

  _showCurrent() {
    if (this.current >= this.statements.length) { this._test(); return; }
    this.progressEl.textContent = `${this.current + 1} / ${this.statements.length}`;
    this.cardEl.textContent = this.statements[this.current].text;
    this.cardEl.classList.remove('pillk-right', 'pillk-wrong');
    this.statusEl.textContent = '';
    this.statusEl.classList.remove('pillk-status-teach');
  }

  _choose(pillar) {
    if (this.current >= this.statements.length) return;
    // Ignore taps while an advance is already pending. Without this, extra taps
    // during the delay push EXTRA answers for a statement and fire onWrong again,
    // multiplying the penalty and desynchronising answers[] from statements[].
    if (this._advanceTimer) return;
    const stmt = this.statements[this.current];
    const correct = pillar === stmt.answer;

    if (correct) {
      this.answers.push({ pillar, correct: true });
      this.cardEl.classList.add('pillk-right');
      this.statusEl.textContent = '';
      this.statusEl.classList.remove('pillk-status-teach');
      this._scheduleAdvance(500);
      return;
    }

    // Wrong pick
    if (this.retryOnWrong) {
      // Inline teaching: show why it's wrong, stay on the same statement.
      const feedback = (stmt.wrong_feedback && stmt.wrong_feedback[pillar])
        || this.pillarWrongFeedback[pillar]
        || `Not quite — that isn't ${pillar}. Try again.`;
      this.cardEl.classList.add('pillk-wrong');
      this.statusEl.textContent = feedback;
      this.statusEl.classList.add('pillk-status-teach');
      if (this.onWrong) this.onWrong(feedback);
      setTimeout(() => {
        this.cardEl.classList.remove('pillk-wrong');
      }, 900);
      return;
    }

    let delay = 600;
    this.cardEl.classList.add('pillk-wrong');
    if (this.immediateWrong) {
      // Penalise THIS mistake now, not at the end of the sequence.
      this._penalised = true;
      if (this.onWrong) this.onWrong('Wrong — that statement is on the other side.');
      // Keep the wrong card up for the whole lockout so the player can see what
      // they got wrong instead of it advancing behind the scrim.
      delay = this.wrongHoldMs;

      // Re-ask this slot with a fresh statement once the hold is served. No answer
      // is recorded, so answers[] stays one-per-slot and all-correct — _test()
      // therefore awards the puzzle as soon as the last slot is answered, with no
      // restart. Pushing a wrong answer here instead would guarantee the pass fails.
      if (this.nextStatement) { this._scheduleReroll(delay); return; }
    }

    // Legacy: advance on wrong; overall check happens at _test with soft reset.
    this.answers.push({ pillar, correct: false });
    this._scheduleAdvance(delay);
  }

  /* Replace the CURRENT statement and re-show it. Shares _advanceTimer with
   * _scheduleAdvance so the single-pending-timer invariant still holds: the
   * tap guard in _choose() and the cancellation in reset() both key off it, and
   * that invariant is what closed the credited-false-solve bug. */
  _scheduleReroll(delay) {
    if (this._advanceTimer) clearTimeout(this._advanceTimer);
    this._advanceTimer = setTimeout(() => {
      this._advanceTimer = null;
      let fresh = null;
      try { fresh = this.nextStatement(this.current, this.statements[this.current]); } catch { fresh = null; }
      // A supplier that runs dry just leaves the statement in place — the player
      // retries the same one, which is still better than restarting the set.
      if (fresh && fresh.text && fresh.answer) this.statements[this.current] = fresh;
      this._showCurrent();
      // _showCurrent() clears the status, so say this AFTER it: the card text
      // changing without explanation reads as a glitch.
      this.statusEl.textContent = 'New statement — try this one.';
    }, delay);
  }

  /* All statement advances go through here so exactly one can be pending and
   * reset() can cancel it. Previously both the correct and wrong paths used a bare
   * setTimeout with no stored handle, so a timer scheduled before a soft reset kept
   * running and walked the FRESH pass forward — skipping a statement and leaving
   * answers[] short. Combined with the unguarded _test() below that credited a
   * solve the player never earned. */
  _scheduleAdvance(delay) {
    if (this._advanceTimer) clearTimeout(this._advanceTimer);
    this._advanceTimer = setTimeout(() => {
      this._advanceTimer = null;
      this.current++;
      this._showCurrent();
    }, delay);
  }

  _test() {
    /* Require one answer per statement. `[].every()` is TRUE, so a corrupted pass
     * (answers[] short because an orphaned advance skipped a statement) used to
     * report "All pillars correct!" and call onSubmit — a credited solve in a
     * competitive race. If the bookkeeping does not line up, treat the pass as
     * failed and re-run it rather than awarding it. */
    if (this.answers.length !== this.statements.length) {
      this.statusEl.classList.remove('pillk-status-teach');
      this.statusEl.textContent = 'Restarting this set\u2026';
      this.cardEl.textContent = 'Review and retry';
      setTimeout(() => this.reset(), 900);
      return;
    }
    const allCorrect = this.answers.every(a => a.correct);
    const score = this.answers.filter(a => a.correct).length;
    if (allCorrect) {
      this.cardEl.textContent = '🏛️';
      this.cardEl.classList.add('pillk-right');
      this.statusEl.classList.remove('pillk-status-teach');
      this.statusEl.textContent = `✅ All pillars correct! (${score}/${this.statements.length})`;
      this.pillarBtns.style.display = 'none';
      setTimeout(() => this.onSubmit(true), 400);
    } else {
      this.statusEl.classList.remove('pillk-status-teach');
      this.statusEl.textContent = `❌ ${score}/${this.statements.length} correct — try again`;
      this.cardEl.textContent = 'Review and retry';
      // Under immediateWrong each mistake was already penalised as it happened, so
      // reporting again here would charge a second lockout for the same errors.
      if (this.onWrong && !(this.immediateWrong && this._penalised)) {
        this.onWrong('Wrong — some statements are incorrect. Try again.');
      }
      setTimeout(() => this.reset(), 2000);
    }
  }

  reset() {
    // Cancel any pending advance BEFORE clearing state, or it fires against the
    // fresh pass and skips a statement.
    if (this._advanceTimer) { clearTimeout(this._advanceTimer); this._advanceTimer = null; }
    this.current = 0;
    this.answers = [];
    this._penalised = false;   // a fresh pass can be penalised again
    this.pillarBtns.style.display = '';
    this.statusEl.textContent = '';
    this._showCurrent();
  }

  _injectStyles() {
    if (document.getElementById('pillk-css')) return;
    const s = document.createElement('style'); s.id = 'pillk-css';
    s.textContent = `
.pillk{display:flex;flex-direction:column;align-items:center;gap:14px;padding:16px 0;max-width:380px;margin:0 auto}
.pillk-progress{font-size:12px;color:var(--muted,#7a8ba8);font-weight:600}
.pillk-card{width:100%;padding:20px;background:var(--surface,#141b2d);border:2px solid var(--border,#1e2a45);border-radius:10px;font-size:15px;color:var(--text,#e0e6f0);text-align:center;min-height:70px;display:flex;align-items:center;justify-content:center;transition:all .3s}
.pillk-card.pillk-right{border-color:#22c55e;background:#0c1a0c}
.pillk-card.pillk-wrong{border-color:#ef4444;background:#1a0a0a}
.pillk-card.pillk-right,.pillk-card.pillk-wrong{color:#e0e6f0}
.pillk-pillars{display:flex;flex-wrap:wrap;gap:6px;justify-content:center}
.pillk-pillar{padding:8px 14px;border:1px solid var(--border,#1e2a45);border-radius:8px;background:var(--surface,#141b2d);color:var(--muted,#7a8ba8);font-size:12px;font-weight:600;cursor:pointer;transition:all .15s}
.pillk-pillar:active{background:var(--accent,#3b82f6);color:#fff;transform:scale(.95)}
.pillk-status{font-size:13px;color:var(--muted,#7a8ba8);min-height:18px;text-align:center;line-height:1.4;padding:0 8px;max-width:340px}
.pillk-status.pillk-status-teach{color:#ef4444;font-weight:600}
`;
    document.head.appendChild(s);
  }
}
