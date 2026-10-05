/* SpellingLockShowdown — Showdown's own copy of SpellingLock.
 *
 * Requested in docs/showdown-spelling-clue-handoff.md. The episodes keep using
 * app/puzzle/spelling-lock.js, which is untouched; this file is loaded only by
 * showdown.html. Separate class name and a separate CSS prefix (splks-, style tag
 * #splks-style) so the two can share a page without overwriting each other.
 *
 * Differences from SpellingLock:
 *   clues        Array parallel to `words`; clues[i] is a fill-in-the-blank
 *                sentence for words[i], with "___" marking the blank. Rendered as
 *                TEXT (escaped): the bank is fetched live. Missing/empty clue →
 *                nothing rendered, so the Hanoi bank (no clues) looks as before.
 *   words only   No pool/pickCount: Showdown always passes explicit words, and a
 *                random pick would break the word/clue pairing.
 *   onSubmit     Fires exactly ONCE. The original called it from _render(), so
 *                every re-render after completion (a stale tap, Undo, Clear in
 *                the 400ms before the board redrew) reported another solve.
 *   keyboard     Typing a letter places the matching tile; Backspace returns the
 *                last one. Booth laptops have keyboards, and hunting tiles with a
 *                trackpad is the slow part of this puzzle.
 *   shuffle      Fisher-Yates, and never the answer itself. The original sorted
 *                with Math.random()-0.5, which is biased and could deal the word
 *                already unscrambled.
 *   listeners    Bound to this instance's own root element, which is removed with
 *                it when the next puzzle mounts, so nothing outlives the puzzle.
 *
 * Opt-in flags kept with their original meaning (Showdown passes all of them):
 *   clickSlotToReturn, keepOnWrong, upperCase.
 */
class SpellingLockShowdown {
  constructor(el, opts = {}) {
    const cfg = opts.config || opts;
    this.el = el;
    this.onSubmit = opts.onSubmit || (() => {});
    this.onWrong = opts.onWrong || null;
    this.title = cfg.title || opts.title || 'SPELL IT OUT';
    this.words = Array.isArray(cfg.words) ? cfg.words.slice() : [];
    this.clues = Array.isArray(cfg.clues) ? cfg.clues : [];
    this.clickSlotToReturn = !!cfg.clickSlotToReturn;
    this.keepOnWrong = !!cfg.keepOnWrong;
    this.upperCase = !!cfg.upperCase;
    this.current = 0;
    this.spelled = [];
    this.solved = [];
    this.pool = [];
    this._submitted = false;

    this._injectStyles();
    this.root = document.createElement('div');
    this.root.className = 'splks-wrap';
    this.el.appendChild(this.root);
    this.root.addEventListener('click', (e) => this._onClick(e));
    this._onKey = (e) => this._key(e);
    document.addEventListener('keydown', this._onKey);

    this._buildPool();
    this._render();
  }

  _esc(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  _norm(s) { return this.upperCase ? String(s).toUpperCase() : String(s); }
  _target() { return this._norm(this.words[this.current] || '').replace(/ /g, ''); }

  _shuffle(letters) {
    const a = letters.slice();
    for (let tries = 0; tries < 12; tries++) {
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      // A word made of one repeated letter can only come out one way.
      if (a.join('') !== letters.join('') || new Set(letters).size < 2) break;
    }
    return a;
  }
  _buildPool() {
    if (this.current >= this.words.length) { this.pool = []; return; }
    this.pool = this._shuffle(this._target().split('')).map((ch, i) => ({ ch, i }));
  }

  // Active = mounted and not under Showdown's wrong-answer lockout (`inert`).
  _active() {
    if (!this.root.isConnected) { document.removeEventListener('keydown', this._onKey); return false; }
    return !this._submitted && !this.el.closest('[inert]');
  }

  _clueHtml() {
    const clue = String(this.clues[this.current] || '').trim();
    if (!clue) return '';
    // Escape first, then turn the literal ___ into a visible blank.
    const html = this._esc(clue).replace(/_{3,}/, '<span class="splks-blank" aria-label="blank"></span>');
    return `<div class="splks-clue">${html}</div>`;
  }

  _render() {
    if (this.current >= this.words.length) {
      this.root.innerHTML = `<div class="splks-complete"><div class="splks-complete-title">All words spelled</div>` +
        `<div class="splks-complete-list">${this.solved.map((s) => this._esc(this._norm(s))).join(' · ')}</div></div>`;
      if (!this._submitted) { this._submitted = true; this.onSubmit(); }
      return;
    }
    const word = this._norm(this.words[this.current]);
    const used = new Set(this.spelled.map((s) => s.poolIdx));
    let pos = 0;
    const slots = word.split('').map((ch) => {
      if (ch === ' ') return '<div class="splks-space"></div>';
      const p = pos++;
      const filled = this.spelled[p];
      if (filled && this.clickSlotToReturn) {
        return `<button class="splks-slot filled splks-slot-btn" data-pos="${p}" ` +
               `title="Click to return this letter" aria-label="Remove ${this._esc(filled.ch)}">${this._esc(filled.ch)}</button>`;
      }
      return `<div class="splks-slot${filled ? ' filled' : ''}">${filled ? this._esc(filled.ch) : ''}</div>`;
    }).join('');
    const pool = this.pool.map((p) =>
      `<button class="splks-letter${used.has(p.i) ? ' used' : ''}" data-idx="${p.i}"` +
      `${used.has(p.i) ? ' tabindex="-1" aria-hidden="true"' : ''}>${this._esc(p.ch)}</button>`).join('');
    const done = this.solved.length
      ? `<div class="splks-done">${this.solved.map((s) => '<span>' + this._esc(this._norm(s)) + '</span>').join('')}</div>`
      : '';
    this.root.innerHTML = `<div class="splks-board">
      <div class="splks-count">${this._esc(this.title)} (${this.current + 1}/${this.words.length})</div>
      ${this._clueHtml()}
      <div class="splks-slots">${slots}</div>
      <div class="splks-pool">${pool}</div>
      <div class="splks-actions"><button class="splks-action" data-act="undo">↩ Undo</button>` +
      `<button class="splks-action" data-act="clear">✕ Clear</button>` +
      `<span class="splks-hint">or type the letters</span></div>
    </div>${done}`;
  }

  _onClick(e) {
    const t = e.target.closest('button');
    if (!t || !this._active()) return;
    if (t.classList.contains('splks-letter')) {
      if (!t.classList.contains('used')) this._tap(+t.dataset.idx);
    } else if (t.classList.contains('splks-slot-btn')) {
      this._returnAt(+t.dataset.pos);
    } else if (t.dataset.act === 'undo') {
      this.spelled.pop(); this._render();
    } else if (t.dataset.act === 'clear') {
      this.spelled = []; this._render();
    }
  }

  _key(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (!this._active() || this._busy) return;
    if (e.key === 'Backspace') {
      if (this.spelled.length) { e.preventDefault(); this.spelled.pop(); this._render(); }
      return;
    }
    if (!/^[a-zA-Z]$/.test(e.key)) return;
    const used = new Set(this.spelled.map((s) => s.poolIdx));
    const want = e.key.toUpperCase();
    const tile = this.pool.find((p) => !used.has(p.i) && p.ch.toUpperCase() === want);
    if (tile) { e.preventDefault(); this._tap(tile.i); }
  }

  _returnAt(pos) {
    if (!Number.isInteger(pos) || pos < 0 || pos >= this.spelled.length) return;
    this.spelled.splice(pos, 1);
    this._render();
  }

  _tap(poolIdx) {
    if (this._busy) return;
    const tile = this.pool.find((p) => p.i === poolIdx);
    if (!tile || this.spelled.some((s) => s.poolIdx === poolIdx)) return;
    this.spelled.push({ ch: tile.ch, poolIdx });
    const target = this._target();
    if (this.spelled.length < target.length) { this._render(); return; }

    // Word complete. _busy blocks input until the board redraws, so a stray tap
    // or keypress in that window can't land on the old tiles.
    this._busy = true;
    if (this.spelled.map((s) => s.ch).join('') === target) {
      // Leave the finished word on the board for a beat, then move on. The final
      // word's advance renders the complete state, which submits (once).
      this._render();
      this.root.classList.add('splks-solved');
      setTimeout(() => {
        if (!this.root.isConnected) return;
        this.root.classList.remove('splks-solved');
        this.solved.push(this.words[this.current]);
        this.current++;
        this.spelled = [];
        this._buildPool();
        this._busy = false;
        this._render();
      }, 400);
    } else {
      this._render();                      // show the full wrong attempt first
      if (!this.keepOnWrong) this.spelled = [];
      if (this.onWrong) this.onWrong('Wrong spelling. Try again.');
      setTimeout(() => { if (!this.root.isConnected) return; this._busy = false; this._render(); }, 300);
    }
  }

  _injectStyles() {
    if (document.getElementById('splks-style')) return;
    const s = document.createElement('style'); s.id = 'splks-style';
    // Neutral fallbacks only; Showdown restyles everything under #play-mount.
    s.textContent = `
.splks-wrap{max-width:460px;margin:0 auto;padding:4px 0}
.splks-board{display:flex;flex-direction:column;gap:10px;padding:14px;border:1px solid #444;border-radius:8px}
.splks-count{font-size:11px;text-align:center;letter-spacing:.08em}
.splks-clue{font-size:15px;line-height:1.4;text-align:center;margin:2px 0 4px}
.splks-blank{display:inline-block;min-width:3.2em;height:1em;vertical-align:-.15em;border-bottom:2px solid currentColor;margin:0 .15em}
.splks-slots{min-height:44px;display:flex;align-items:center;justify-content:center;gap:4px;flex-wrap:wrap;padding:6px}
.splks-slot{width:30px;height:36px;border:2px solid #666;border-radius:4px;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:1.05rem;background:transparent;color:inherit}
.splks-slot.filled{border-color:currentColor}
.splks-slot-btn{cursor:pointer;padding:0}
.splks-space{width:12px}
.splks-pool{display:flex;flex-wrap:wrap;gap:5px;justify-content:center}
.splks-letter{width:34px;height:38px;border:2px solid #888;border-radius:4px;font-weight:700;font-size:1rem;cursor:pointer;background:transparent;color:inherit}
.splks-letter.used{opacity:.2;pointer-events:none}
.splks-actions{display:flex;gap:8px;justify-content:center;align-items:center}
.splks-action{padding:6px 12px;border:1px solid #888;border-radius:4px;cursor:pointer;font-size:12px;background:transparent;color:inherit}
.splks-hint{font-size:11px;opacity:.7}
.splks-done{display:flex;gap:6px;justify-content:center;flex-wrap:wrap;margin-top:8px;font-size:12px}
.splks-complete{padding:1.2rem;text-align:center;border:2px solid #2ecc71;border-radius:8px}
.splks-complete-title{font-size:1.1rem;margin-bottom:6px}`;
    document.head.appendChild(s);
  }
}
