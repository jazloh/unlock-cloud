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
    this._penalised = false;   // did this pass already report a wrong?
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
    const stmt = this.statements[this.current];
    const correct = pillar === stmt.answer;

    if (correct) {
      this.answers.push({ pillar, correct: true });
      this.cardEl.classList.add('pillk-right');
      this.statusEl.textContent = '';
      this.statusEl.classList.remove('pillk-status-teach');
      setTimeout(() => {
        this.current++;
        this._showCurrent();
      }, 500);
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
    }

    // Legacy: advance on wrong; overall check happens at _test with soft reset.
    this.answers.push({ pillar, correct: false });
    setTimeout(() => {
      this.current++;
      this._showCurrent();
    }, delay);
  }

  _test() {
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
