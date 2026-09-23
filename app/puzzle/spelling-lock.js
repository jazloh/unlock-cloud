/* SpellingLock — unscramble letters into a word.
 *
 * Three OPT-IN options, all defaulting to the original behaviour so the episodes
 * already using this component are untouched (see the shared-component rule):
 *
 *   clickSlotToReturn  false  Click a filled slot to send that one letter back to
 *                             the pool. Without it the only ways back are Undo
 *                             (pops the LAST letter) and Clear (wipes everything),
 *                             so fixing letter 2 of 8 costs six Undos.
 *   keepOnWrong        false  On a wrong word, keep the letters placed so the
 *                             player can see and fix the mistake. Default wipes
 *                             the whole attempt and restarts.
 *   upperCase          false  Normalise letters to uppercase for display AND
 *                             comparison. Answers like "DynamoDB" otherwise
 *                             render as mixed-case tiles, which reads as noise.
 *                             Not a correctness fix — the pool is built from the
 *                             answer so case already matches — purely legibility.
 */
class SpellingLock {
  constructor(el, opts) {
    this.el = el;
    this.cfg = opts.config || opts;
    this.onSubmit = opts.onSubmit;
    this.onWrong = opts.onWrong;
    this.title = opts.config?.title || opts.title || "TODAY'S SPECIALS";
    this.clickSlotToReturn = !!this.cfg.clickSlotToReturn;
    this.keepOnWrong = !!this.cfg.keepOnWrong;
    this.upperCase = !!this.cfg.upperCase;
    if (this.cfg.pool) {
      const pool = [...this.cfg.pool];
      const pick = this.cfg.pickCount || 3;
      this.words = [];
      for (let i = 0; i < pick && pool.length; i++) {
        const idx = Math.floor(Math.random() * pool.length);
        this.words.push(pool.splice(idx, 1)[0]);
      }
    } else {
      this.words = this.cfg.words;
    }
    this.current = 0;
    this.spelled = [];
    this.solved = [];
    this.pool = [];
    this._injectStyles();
    this._buildPool();
    this._render();
  }
  _injectStyles() {
    if (document.getElementById('splk-style')) return;
    const s = document.createElement('style'); s.id = 'splk-style';
    s.textContent = `
.splk-wrap{max-width:420px;margin:0 auto;padding:8px 0}
.splk-board{background:#2d4a2e;border:3px solid #5a3e1b;border-radius:12px;padding:1.2rem;box-shadow:inset 0 2px 8px rgba(0,0,0,.5)}
.splk-count{font-size:11px;color:#8fbc8f;text-align:center;margin-bottom:4px}
.splk-slots{min-height:44px;display:flex;align-items:center;justify-content:center;gap:3px;flex-wrap:wrap;margin-bottom:1rem;padding:8px;border-bottom:2px dashed #5a7a5a}
.splk-slot{width:28px;height:34px;border:2px solid #5a7a5a;border-radius:4px;display:flex;align-items:center;justify-content:center;font-family:'Courier New',monospace;font-size:1.1rem;font-weight:bold;color:#f0e6c0;background:transparent}
.splk-slot.filled{border-color:#f0e6c0;background:rgba(240,230,192,0.1)}
/* Filled slots are clickable only when clickSlotToReturn is enabled; the cursor
   and hover state are what tell the player that. */
.splk-slot-btn{cursor:pointer;padding:0;font-family:'Courier New',monospace;font-size:1.1rem;font-weight:bold;color:#f0e6c0}
.splk-slot-btn:hover{border-color:#ff6b6b;background:rgba(255,107,107,.18)}
.splk-slot-btn:focus-visible{outline:2px solid #8fbc8f;outline-offset:2px}
.splk-space{width:10px}
.splk-pool{display:flex;flex-wrap:wrap;gap:4px;justify-content:center}
.splk-letter{width:32px;height:36px;background:#3d5a3e;border:2px solid #8fbc8f;border-radius:4px;color:#f0e6c0;font-family:'Courier New',monospace;font-size:1rem;font-weight:bold;cursor:pointer;display:flex;align-items:center;justify-content:center}
.splk-letter.used{background:#1a3320;border-color:#2d4a2e;color:#2d4a2e;pointer-events:none}
.splk-actions{display:flex;gap:8px;justify-content:center;margin-top:1rem}
.splk-action{padding:6px 12px;background:#5a3e1b;border:1px solid #8fbc8f;border-radius:4px;color:#f0e6c0;cursor:pointer;font-size:12px}
.splk-done{margin-top:12px;font-size:13px;color:#2ecc71}
.splk-complete{background:#1a3320;border:2px solid #2ecc71;border-radius:12px;padding:1.5rem;text-align:center}
.splk-complete-title{font-size:1.2rem;color:#2ecc71;margin-bottom:8px}
.splk-complete-list{font-family:'Courier New',monospace;color:#f0e6c0;font-size:14px}`;
    document.head.appendChild(s);
  }
  _shuffle(str) { return str.split('').sort(() => Math.random() - 0.5); }
  // Single place that applies the case policy, so display and comparison can
  // never disagree.
  _norm(s) { return this.upperCase ? String(s).toUpperCase() : String(s); }
  _buildPool() {
    const letters = this._norm(this.words[this.current]).replace(/ /g, '');
    this.pool = this._shuffle(letters).map((ch, i) => ({ ch, i, used: false }));
  }
  _render() {
    if (this.current >= this.words.length) {
      this.el.innerHTML = `<div class="splk-wrap"><div class="splk-complete"><div class="splk-complete-title">✅ Board is ready!</div><div class="splk-complete-list">${this.solved.map(s => '• ' + s).join('<br>')}</div></div></div>`;
      this.onSubmit();
      return;
    }
    const word = this._norm(this.words[this.current]);
    const letters = word.split('');
    const usedSet = new Set(this.spelled.map(s => s.poolIdx));
    let nonSpaceCount = 0;
    const slotsHtml = letters.map(ch => {
      if (ch === ' ') return '<div class="splk-space"></div>';
      const pos = nonSpaceCount;
      const filled = this.spelled[pos];
      nonSpaceCount++;
      // Filled slots become buttons when clickSlotToReturn is on, so a single
      // misplaced letter can be pulled back without clearing the whole attempt.
      if (filled && this.clickSlotToReturn) {
        return `<button class="splk-slot filled splk-slot-btn" data-pos="${pos}" ` +
               `title="Click to return this letter" aria-label="Remove ${filled.ch}">${filled.ch}</button>`;
      }
      return `<div class="splk-slot${filled ? ' filled' : ''}">${filled ? filled.ch : ''}</div>`;
    }).join('');
    const poolHtml = this.pool.map(p => `<button class="splk-letter${usedSet.has(p.i) ? ' used' : ''}" data-idx="${p.i}" data-ch="${p.ch}">${p.ch}</button>`).join('');
    this.el.innerHTML = `<div class="splk-wrap"><div class="splk-board">
      <div class="splk-count">${this.title} (${this.current + 1}/${this.words.length})</div>
      <div class="splk-slots">${slotsHtml}</div>
      <div class="splk-pool">${poolHtml}</div>
      <div class="splk-actions"><button class="splk-action" id="splk-undo">↩ Undo</button><button class="splk-action" id="splk-clear">✕ Clear</button></div>
    </div>${this.solved.length ? `<div class="splk-done">${this.solved.map(s => '✅ ' + s).join('<br>')}</div>` : ''}</div>`;
    this.el.querySelectorAll('.splk-letter:not(.used)').forEach(b => b.addEventListener('click', e => this._tap(+e.target.dataset.idx, e.target.dataset.ch)));
    this.el.querySelectorAll('.splk-slot-btn').forEach(b => b.addEventListener('click', e => {
      const pos = +e.currentTarget.dataset.pos;
      if (Number.isInteger(pos)) this._returnAt(pos);
    }));
    this.el.querySelector('#splk-undo').addEventListener('click', () => { this.spelled.pop(); this._render(); });
    this.el.querySelector('#splk-clear').addEventListener('click', () => { this.spelled = []; this._render(); });
  }
  // Pull one letter back out of the answer, keeping the letters after it in order.
  _returnAt(pos) {
    if (pos < 0 || pos >= this.spelled.length) return;
    this.spelled.splice(pos, 1);
    this._render();
  }
  _tap(poolIdx, ch) {
    this.spelled.push({ ch, poolIdx });
    const target = this._norm(this.words[this.current]).replace(/ /g, '');
    if (this.spelled.length === target.length) {
      const spellStr = this.spelled.map(s => s.ch).join('');
      if (spellStr === target) {
        this.solved.push(this.words[this.current]);
        this.current++;
        this.spelled = [];
        if (this.current < this.words.length) this._buildPool();
        setTimeout(() => this._render(), 400);
      } else {
        // keepOnWrong: leave the attempt on the board so the player can see what
        // they spelled and fix it, instead of losing all their work.
        if (!this.keepOnWrong) this.spelled = [];
        if (this.onWrong) this.onWrong('Wrong spelling. Try again.');
        setTimeout(() => this._render(), 300);
      }
    } else { this._render(); }
  }
}
