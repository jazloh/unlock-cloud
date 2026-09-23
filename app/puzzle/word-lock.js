/**
 * Word Combination Lock Puzzle
 *
 * Rolling reel UI for 3–6 letter words. Each reel shows the correct letter
 * mixed with 5 random decoy letters (6 per reel), shuffled.
 *
 * Usage:
 *   const lock = new WordLock(containerEl, {
 *     answer: 'SHOUT',
 *     onSubmit(word, correct) { ... }
 *   });
 *   lock.reset();
 */

class WordLock {
  constructor(container, opts = {}) {
    this.container = container;
    this.answer = opts.alphabet ? (opts.answer || '') : (opts.answer || '').toUpperCase();
    this.alphabet = opts.alphabet || null;
    this.onSubmit = opts.onSubmit || (() => {});
    this.onChange = opts.onChange || null;
    // _buildReels() randomly subsets decoys, so it reshuffles differently on
    // every call — a caller resuming a saved attempt must pass back the exact
    // reels it was given before, not just the selected indices, or a
    // remembered decoy letter can vanish from the new shuffle entirely.
    this.reelChars = opts.savedReels || this._buildReels();
    this.selected = Array.isArray(opts.initial) ? [...opts.initial] : new Array(this.answer.length).fill(0);
    this._render();
  }

  /* ── Build reel character sets ──────────────────── */

  _buildReels() {
    const ALPHA = this.alphabet || 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const pool = [...ALPHA];
    return [...this.answer].map(ch => {
      const decoys = new Set();
      while (decoys.size < Math.min(5, pool.length - 1)) {
        const r = pool[Math.floor(Math.random() * pool.length)];
        if (r !== ch && !decoys.has(r)) decoys.add(r);
      }
      const chars = [ch, ...decoys];
      // Shuffle
      for (let i = chars.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [chars[i], chars[j]] = [chars[j], chars[i]];
      }
      return chars;
    });
  }

  /* ── Render ─────────────────────────────────────── */

  _render() {
    this.container.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.className = 'wlock';

    const reels = document.createElement('div');
    reels.className = 'wlock-reels';
    this.reelEls = [];
    for (let i = 0; i < this.answer.length; i++) {
      const reel = this._createReel(i);
      reels.appendChild(reel);
      this.reelEls.push(reel);
    }
    wrapper.appendChild(reels);

    const btn = document.createElement('button');
    btn.className = 'wlock-submit';
    btn.textContent = 'Unlock';
    btn.addEventListener('click', () => {
      const word = this.getWord();
      this.onSubmit(word, word === this.answer);
    });
    wrapper.appendChild(btn);

    this.container.appendChild(wrapper);
    this._injectStyles();
    this._maybeHint();
  }

  /* ── First-time instruction overlay ─────────────── */
  _maybeHint() {
    let shown = false;
    try { shown = !!localStorage.getItem('resolve_hint_shown_wordlock'); } catch {}
    if (shown) return;
    try { localStorage.setItem('resolve_hint_shown_wordlock', '1'); } catch {}
    const host = this.container;
    if (typeof getComputedStyle === 'function' && getComputedStyle(host).position === 'static') host.style.position = 'relative';
    const ov = document.createElement('div');
    ov.className = 'wlock-hint';
    const inner = document.createElement('div');
    inner.className = 'wlock-hint-inner';
    // Name the input that actually works on the device in hand. Showdown runs on
    // laptops, where "swipe" is wrong and was the whole reason the reels felt hard.
    const touch = (typeof matchMedia === 'function' && matchMedia('(hover: none) and (pointer: coarse)').matches);
    inner.textContent = touch
      ? '↕ Swipe each reel up or down to change the letter'
      : '↕ Scroll, click above/below, or use ↑↓ keys to change each letter';
    ov.appendChild(inner);
    host.appendChild(ov);
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      clearTimeout(timer);
      document.removeEventListener('touchstart', finish, true);
      document.removeEventListener('mousedown', finish, true);
      ov.style.opacity = '0';
      setTimeout(() => { if (ov.parentNode) ov.remove(); }, 500);
    };
    const timer = setTimeout(finish, 2000);
    document.addEventListener('touchstart', finish, true);
    document.addEventListener('mousedown', finish, true);
  }

  _createReel(index) {
    const chars = this.reelChars[index];
    const CELL_H = 52;
    const COUNT = chars.length; // 6

    const reel = document.createElement('div');
    reel.className = 'wlock-reel';
    reel.style.height = `${CELL_H * 3}px`; // show 3 rows: prev, current, next

    const strip = document.createElement('div');
    strip.className = 'wlock-strip';
    // 3 copies for seamless wrap
    for (let pass = 0; pass < 3; pass++) {
      for (const ch of chars) {
        const cell = document.createElement('div');
        cell.className = 'wlock-cell';
        cell.style.height = `${CELL_H}px`;
        cell.textContent = ch;
        strip.appendChild(cell);
      }
    }
    reel.appendChild(strip);

    // Highlight window
    const win = document.createElement('div');
    win.className = 'wlock-window';
    win.style.top = `${CELL_H}px`;
    win.style.height = `${CELL_H}px`;
    reel.appendChild(win);

    // Fades
    const fadeTop = document.createElement('div');
    fadeTop.className = 'wlock-fade wlock-fade-top';
    fadeTop.style.height = `${CELL_H}px`;
    reel.appendChild(fadeTop);
    const fadeBot = document.createElement('div');
    fadeBot.className = 'wlock-fade wlock-fade-bot';
    fadeBot.style.height = `${CELL_H}px`;
    reel.appendChild(fadeBot);

    this._attachDrag(reel, strip, index, COUNT, CELL_H);
    requestAnimationFrame(() => {
      const target = -(COUNT + this.selected[index] - 1) * CELL_H;
      strip.style.transform = `translateY(${target}px)`;
    });

    return reel;
  }

  /* ── Drag / Touch ───────────────────────────────── */

  _attachDrag(reel, strip, index, count, CELL_H) {
    let dragging = false, moved = false, startY = 0, startOffset = 0, currentOffset = 0;
    let velocity = 0, lastY = 0, lastTime = 0, animFrame = null;

    const getY = (e) => (e.touches ? e.touches[0].clientY : e.clientY);

    const onStart = (e) => {
      dragging = true;
      moved = false;
      startY = getY(e);
      startOffset = currentOffset;
      velocity = 0;
      lastY = startY;
      lastTime = Date.now();
      if (animFrame) cancelAnimationFrame(animFrame);
      reel.classList.add('wlock-dragging');
      window.addEventListener('mousemove', onMove);
      window.addEventListener('touchmove', onMove, { passive: false });
      window.addEventListener('mouseup', onEnd);
      window.addEventListener('touchend', onEnd);
    };

    const onMove = (e) => {
      if (!dragging) return;
      e.preventDefault();
      const y = getY(e);
      if (Math.abs(y - startY) > 4) moved = true;
      const now = Date.now();
      const dt = now - lastTime;
      if (dt > 0) velocity = (y - lastY) / dt;
      lastY = y;
      lastTime = now;
      currentOffset = startOffset + (y - startY);
      strip.style.transform = `translateY(${currentOffset}px)`;
    };

    const onEnd = () => {
      if (!dragging) return;
      dragging = false;
      reel.classList.remove('wlock-dragging');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('touchmove', onMove, { passive: false });
      window.removeEventListener('mouseup', onEnd);
      window.removeEventListener('touchend', onEnd);
      // A swipe that overshoots the popup card lands the touchend on the
      // backdrop, which synthesizes a click there and closes the popup.
      // Swallow that one click so mid-drag doesn't blow away progress.
      if (moved) {
        window.__resolveSuppressBackdropClick = true;
        setTimeout(() => { window.__resolveSuppressBackdropClick = false; }, 0);
      }
      const decel = () => {
        if (Math.abs(velocity) < 0.01) { snap(); return; }
        velocity *= 0.92;
        currentOffset += velocity * 16;
        strip.style.transform = `translateY(${currentOffset}px)`;
        animFrame = requestAnimationFrame(decel);
      };
      decel();
    };

    const snap = () => {
      let idx = Math.round(-currentOffset / CELL_H) + 1;
      idx = ((idx % count) + count) % count;
      this.selected[index] = idx;
      const target = -(count + idx - 1) * CELL_H;
      currentOffset = target;
      strip.style.transition = 'transform 0.2s ease-out';
      strip.style.transform = `translateY(${target}px)`;
      setTimeout(() => { strip.style.transition = ''; }, 200);
      if (this.onChange) this.onChange({ reelChars: this.reelChars, selected: [...this.selected] });
    };

    reel.addEventListener('mousedown', onStart);
    reel.addEventListener('touchstart', onStart, { passive: true });

    strip._snap = () => { currentOffset = 0; snap(); };

    /* ── Desktop input, in addition to drag ─────────────────────────────
     * The reel was drag-only, which is fine on a phone but awkward on a laptop
     * trackpad — and Showdown's primary device IS a laptop. These are pure
     * additions: drag behaviour is untouched, so every episode using word-lock
     * keeps working exactly as before and simply gains three more ways in.
     *   • wheel / two-finger scroll over a reel steps one letter
     *   • click the letter above or below the window steps toward it
     *   • focus a reel and use ↑/↓ (or a letter key to jump straight to it)
     */
    const step = (delta) => {
      if (animFrame) cancelAnimationFrame(animFrame);
      strip.style.transition = '';
      const next = ((this.selected[index] + delta) % count + count) % count;
      this.selected[index] = next;
      currentOffset = -(count + next - 1) * CELL_H;
      strip.style.transition = 'transform 0.16s ease-out';
      strip.style.transform = `translateY(${currentOffset}px)`;
      setTimeout(() => { strip.style.transition = ''; }, 160);
      if (this.onChange) this.onChange({ reelChars: this.reelChars, selected: [...this.selected] });
    };
    reel._step = step;

    // Wheel: accumulate so a high-resolution trackpad doesn't fly past letters.
    let wheelAcc = 0;
    reel.addEventListener('wheel', (e) => {
      e.preventDefault();
      wheelAcc += e.deltaY;
      const THRESH = 24;
      while (Math.abs(wheelAcc) >= THRESH) {
        step(wheelAcc > 0 ? 1 : -1);
        wheelAcc += wheelAcc > 0 ? -THRESH : THRESH;
      }
    }, { passive: false });

    // Click above/below the centre window. Guarded by `moved` so the click that
    // ends a drag is never treated as a step.
    reel.addEventListener('click', (e) => {
      if (moved) return;
      const r = reel.getBoundingClientRect();
      const y = e.clientY - r.top;
      if (y < CELL_H) step(-1);
      else if (y > CELL_H * 2) step(1);
    });

    // Keyboard: arrows step, letter keys jump to that letter if it is on the reel.
    reel.tabIndex = 0;
    reel.setAttribute('role', 'spinbutton');
    reel.setAttribute('aria-label', `Letter ${index + 1}`);
    reel.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        step(e.key === 'ArrowDown' ? 1 : -1);
        return;
      }
      if (/^[a-zA-Z]$/.test(e.key)) {
        const want = e.key.toUpperCase();
        const target = this.reelChars[index].findIndex((c) => String(c).toUpperCase() === want);
        if (target >= 0) { e.preventDefault(); step(target - this.selected[index]); }
      }
    });
  }

  /* ── Public API ─────────────────────────────────── */

  getWord() {
    return this.selected.map((si, i) => this.reelChars[i][si]).join('');
  }

  reset() {
    this.selected = new Array(this.answer.length).fill(0);
    this.reelEls.forEach(reel => {
      const strip = reel.querySelector('.wlock-strip');
      if (strip._snap) strip._snap();
    });
  }

  /* ── Styles ─────────────────────────────────────── */

  _injectStyles() {
    if (document.getElementById('wlock-css')) return;
    const s = document.createElement('style');
    s.id = 'wlock-css';
    s.textContent = `
.wlock{display:flex;flex-direction:column;align-items:center;gap:16px;padding:16px 0}
.wlock-reels{display:flex;gap:6px}
.wlock-reel{position:relative;width:48px;overflow:hidden;border-radius:10px;background:#0d1220;border:1px solid var(--border,#1e2a45);cursor:grab;user-select:none;-webkit-user-select:none}
/* Reels are keyboard-focusable (role=spinbutton, ↑↓ to change) — show it. */
.wlock-reel:focus-visible{outline:2px solid var(--mode-color,#ff2e6a);outline-offset:2px}
.wlock-reel.wlock-dragging{cursor:grabbing}
.wlock-strip{display:flex;flex-direction:column;will-change:transform}
.wlock-cell{display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:700;color:#7a8ba8;letter-spacing:1px}
.wlock-window{position:absolute;left:0;right:0;border-top:2px solid #3b82f6;border-bottom:2px solid #3b82f6;pointer-events:none;z-index:2}
.wlock-fade{position:absolute;left:0;right:0;pointer-events:none;z-index:1}
.wlock-fade-top{top:0;background:linear-gradient(to bottom,#0d1220 30%,transparent)}
.wlock-fade-bot{bottom:0;background:linear-gradient(to top,#0d1220 30%,transparent)}
.wlock-submit{padding:12px 32px;border:none;border-radius:8px;background:var(--accent,#3b82f6);color:#fff;font-size:15px;font-weight:600;cursor:pointer;transition:opacity .2s;letter-spacing:.5px}
.wlock-submit:active{opacity:.7}
.wlock-hint{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(6,9,17,.72);border-radius:10px;z-index:5;transition:opacity .5s;padding:16px;text-align:center;pointer-events:none}
.wlock-hint-inner{color:#fff;font-size:14px;font-weight:600;line-height:1.4;max-width:240px}
`;
    document.head.appendChild(s);
  }
}
