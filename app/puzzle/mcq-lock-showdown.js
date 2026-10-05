/* McqLockShowdown — Showdown's final puzzle: N multiple-choice questions in a row.
 *
 * Replaces Showdown's use of WagerLock (episodes keep app/puzzle/wager-lock.js,
 * untouched). WagerLock is an episode mechanic — stakes, a score bar, a history
 * log, Next/Try Again buttons — and in a timed race those were all friction:
 *
 *   - After a correct answer the player had to click "Next Question".
 *     Here a correct answer advances on its own after a short beat.
 *   - After a wrong answer "Try Again" brought back the SAME question with the
 *     same four options, so a player could simply click through them: success
 *     was guaranteed by elimination, at a cost of 5s per miss. Here a miss shows
 *     the right answer (it is a teaching game) and, when the hold ends, replaces
 *     the question with a FRESH one from `nextQuestion()`. Same fix as pillar-lock's
 *     nextStatement for True/False.
 *
 * Options
 *   questions      [{ question, options[], answer }]  — answered in this order
 *   target         correct answers needed (default questions.length)
 *   nextQuestion   (missCount) => question | null. Supplies the replacement after
 *                  a miss. Showdown derives it from session_id so every device in
 *                  a race gets the same replacement. null → re-ask the same one.
 *   seed           string; makes option order deterministic (same on every device)
 *   autoAdvanceMs  pause on a correct answer before the next question (650)
 *   wrongHoldMs    how long a miss is shown before the replacement (4850 — just
 *                  inside Showdown's 5s lockout, as pillar-lock does)
 *   onSubmit()     once, when `target` questions are answered correctly
 *   onWrong(msg)   on every miss
 *
 * Keyboard: 1-4 or A-D picks an option. Input is ignored while the mount is
 * `inert` (Showdown's lockout) and once the instance has been unmounted.
 */
class McqLockShowdown {
  constructor(el, opts = {}) {
    this.el = el;
    this.questions = (opts.questions || []).slice();
    this.target = Math.max(1, Math.min(opts.target || this.questions.length, this.questions.length || 1));
    this.nextQuestion = typeof opts.nextQuestion === 'function' ? opts.nextQuestion : null;
    this.seed = String(opts.seed || '');
    this.autoAdvanceMs = opts.autoAdvanceMs != null ? opts.autoAdvanceMs : 650;
    this.wrongHoldMs = opts.wrongHoldMs != null ? opts.wrongHoldMs : 4850;
    this.onSubmit = opts.onSubmit || (() => {});
    this.onWrong = opts.onWrong || null;

    this.solved = 0;
    this.misses = 0;
    this.phase = 'answer';          // 'answer' | 'feedback' | 'done'
    this._submitted = false;
    this._timer = null;

    this._injectStyles();
    this.root = document.createElement('div');
    this.root.className = 'mcqs';
    this.el.appendChild(this.root);
    this.root.addEventListener('click', (e) => {
      const b = e.target.closest('.mcqs-option');
      if (b) this._choose(+b.dataset.i);
    });
    this._onKey = (e) => this._key(e);
    document.addEventListener('keydown', this._onKey);
    this._render();
  }

  get current() { return this.questions[this.solved]; }

  _hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }
  // Deterministic option order: sort by a hash of seed + question + option.
  _order(q) {
    const key = this.seed + '|' + q.question + '|';
    return q.options.slice().sort((a, b) => this._hash(key + a) - this._hash(key + b));
  }
  _esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  _active() {
    if (!this.root.isConnected) {
      document.removeEventListener('keydown', this._onKey);
      if (this._timer) clearTimeout(this._timer);
      return false;
    }
    return this.phase === 'answer' && !this.el.closest('[inert]');
  }

  _render() {
    const q = this.current;
    if (!q) { this.root.innerHTML = ''; return; }
    this._opts = this._order(q);
    const pips = Array.from({ length: this.target }, (_, i) =>
      `<span class="mcqs-pip${i < this.solved ? ' is-done' : ''}${i === this.solved ? ' is-now' : ''}"></span>`).join('');
    const opts = this._opts.map((o, i) =>
      `<button class="mcqs-option" data-i="${i}"><span class="mcqs-key">${'ABCD'[i] || i + 1}</span>` +
      `<span class="mcqs-text">${this._esc(o)}</span></button>`).join('');
    this.root.innerHTML =
      `<div class="mcqs-head"><span class="mcqs-step">Question ${Math.min(this.solved + 1, this.target)} of ${this.target}</span>` +
      `<span class="mcqs-pips" aria-hidden="true">${pips}</span></div>` +
      `<div class="mcqs-question">${this._esc(q.question)}</div>` +
      `<div class="mcqs-options${this._opts.length > 4 ? ' mcqs-options-many' : ''}">${opts}</div>` +
      `<div class="mcqs-foot" aria-live="polite">Click an answer, or press ${this._opts.length <= 4 ? 'A–' + 'ABCD'[this._opts.length - 1] : '1–' + this._opts.length}</div>`;
  }

  _key(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (!this._active() || !this._opts) return;
    let i = -1;
    if (/^[1-9]$/.test(e.key)) i = +e.key - 1;
    else if (/^[a-dA-D]$/.test(e.key)) i = e.key.toUpperCase().charCodeAt(0) - 65;
    if (i >= 0 && i < this._opts.length) { e.preventDefault(); this._choose(i); }
  }

  _mark(i, cls) {
    const b = this.root.querySelector(`.mcqs-option[data-i="${i}"]`);
    if (b) b.classList.add(cls);
  }
  _foot(text) {
    const f = this.root.querySelector('.mcqs-foot');
    if (f) f.textContent = text;
  }

  _choose(i) {
    if (!this._active() || i < 0 || i >= this._opts.length) return;
    const q = this.current;
    const pick = this._opts[i];
    this.phase = 'feedback';
    this.root.querySelectorAll('.mcqs-option').forEach((b) => { b.disabled = true; });

    if (pick === q.answer) {
      this._mark(i, 'is-correct');
      this.solved++;
      const pip = this.root.querySelectorAll('.mcqs-pip')[this.solved - 1];
      if (pip) pip.classList.add('is-done');
      if (this.solved >= this.target) {
        this.phase = 'done';
        this._foot('Correct — all done!');
        this._timer = setTimeout(() => {
          if (!this.root.isConnected || this._submitted) return;
          this._submitted = true;
          this.onSubmit(true);
        }, 450);
        return;
      }
      this._foot('Correct!');
      this._timer = setTimeout(() => {
        if (!this.root.isConnected) return;
        this.phase = 'answer';
        this._render();
      }, this.autoAdvanceMs);
      return;
    }

    // Miss: show the right answer, then replace the question.
    this._mark(i, 'is-wrong');
    this._mark(this._opts.indexOf(q.answer), 'is-answer');
    this.misses++;
    this._foot('Not quite — a new question is coming.');
    if (this.onWrong) this.onWrong('Wrong answer. Here comes a new question.');
    this._timer = setTimeout(() => {
      if (!this.root.isConnected) return;
      const fresh = this.nextQuestion ? this.nextQuestion(this.misses) : null;
      if (fresh && fresh.question && Array.isArray(fresh.options) && fresh.options.indexOf(fresh.answer) !== -1) {
        this.questions[this.solved] = fresh;
      }
      this.phase = 'answer';
      this._render();
    }, this.wrongHoldMs);
  }

  _injectStyles() {
    if (document.getElementById('mcqs-style')) return;
    const s = document.createElement('style'); s.id = 'mcqs-style';
    // Neutral fallbacks only; Showdown restyles everything under #play-mount.
    s.textContent = `
.mcqs{display:flex;flex-direction:column;gap:12px;max-width:560px;margin:0 auto}
.mcqs-head{display:flex;justify-content:space-between;align-items:center;font-size:12px;letter-spacing:.08em;text-transform:uppercase}
.mcqs-pips{display:flex;gap:5px}
.mcqs-pip{width:22px;height:5px;background:#555}
.mcqs-pip.is-done{background:#2ecc71}
.mcqs-question{font-size:16px;font-weight:600;line-height:1.45;text-align:center;padding:14px;border:1px solid #444;border-radius:8px}
.mcqs-options{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.mcqs-options-many{grid-template-columns:1fr 1fr 1fr}
.mcqs-option{display:flex;align-items:center;gap:10px;text-align:left;padding:12px;border:1px solid #555;border-radius:8px;background:transparent;color:inherit;font:inherit;font-weight:600;cursor:pointer}
.mcqs-key{flex:0 0 auto;width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;border:1px solid currentColor;border-radius:3px;font-size:11px;opacity:.75}
.mcqs-option.is-correct,.mcqs-option.is-answer{border-color:#2ecc71;background:rgba(46,204,113,.15)}
.mcqs-option.is-wrong{border-color:#e74c3c;background:rgba(231,76,60,.15)}
.mcqs-foot{text-align:center;font-size:12px;opacity:.75;min-height:1.2em}`;
    document.head.appendChild(s);
  }
}
