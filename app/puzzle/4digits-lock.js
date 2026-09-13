/**
 * 4-Digit Combination Lock Puzzle
 *
 * Rolling drum UI — each digit scrolls vertically via touch/mouse drag.
 * Usage:
 *   const lock = new DigitLock(containerEl, { onSubmit(code) { ... } });
 *   lock.reset();
 *
 * Emits onSubmit(code: string) when the player confirms their combination.
 */

class DigitLock {
  constructor(container, opts = {}) {
    this.container = container;
    this.onSubmit = opts.onSubmit || (() => {});
    this.onChange = opts.onChange || null;
    this.digits = Array.isArray(opts.initial) ? [...opts.initial] : [0, 0, 0, 0];
    this._render();
  }

  /* ── Render ─────────────────────────────────────── */

  _render() {
    this.container.innerHTML = '';
    const wrapper = document.createElement('div');
    wrapper.className = 'dlock';

    // Reels
    const reels = document.createElement('div');
    reels.className = 'dlock-reels';
    this.reelEls = [];
    for (let i = 0; i < 4; i++) {
      const reel = this._createReel(i);
      reels.appendChild(reel);
      this.reelEls.push(reel);
    }
    wrapper.appendChild(reels);

    // Submit
    const btn = document.createElement('button');
    btn.className = 'dlock-submit';
    btn.textContent = 'Unlock';
    btn.addEventListener('click', () => this.onSubmit(this.getCode()));
    wrapper.appendChild(btn);

    this.container.appendChild(wrapper);
    this._injectStyles();
  }

  _createReel(index) {
    const reel = document.createElement('div');
    reel.className = 'dlock-reel';

    // Build digit strip: 0-9 repeated for seamless wrap
    const strip = document.createElement('div');
    strip.className = 'dlock-strip';
    for (let pass = 0; pass < 3; pass++) {
      for (let d = 0; d < 10; d++) {
        const cell = document.createElement('div');
        cell.className = 'dlock-cell';
        cell.textContent = d;
        strip.appendChild(cell);
      }
    }
    reel.appendChild(strip);

    // Highlight window
    const win = document.createElement('div');
    win.className = 'dlock-window';
    reel.appendChild(win);

    // Fade overlays
    const fadeTop = document.createElement('div');
    fadeTop.className = 'dlock-fade dlock-fade-top';
    reel.appendChild(fadeTop);
    const fadeBot = document.createElement('div');
    fadeBot.className = 'dlock-fade dlock-fade-bot';
    reel.appendChild(fadeBot);

    this._attachDrag(reel, strip, index);
    // Init position to show 0 in center (offset by 10 cells into the middle copy)
    requestAnimationFrame(() => this._snapTo(strip, index));

    return reel;
  }

  /* ── Drag / Touch ───────────────────────────────── */

  _attachDrag(reel, strip, index) {
    const CELL_H = 48;
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
      reel.classList.add('dlock-dragging');
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
      reel.classList.remove('dlock-dragging');
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
      // Momentum
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
      // Window is 1 cell down, so visible digit = cell at offset+1
      let idx = Math.round(-currentOffset / CELL_H) + 1;
      idx = ((idx % 10) + 10) % 10;
      this.digits[index] = idx;
      const target = -(10 + idx - 1) * CELL_H;
      currentOffset = target;
      strip.style.transition = 'transform 0.2s ease-out';
      strip.style.transform = `translateY(${target}px)`;
      setTimeout(() => { strip.style.transition = ''; }, 200);
      if (this.onChange) this.onChange([...this.digits]);
    };

    reel.addEventListener('mousedown', onStart);
    reel.addEventListener('touchstart', onStart, { passive: true });

    // Store snap fn for reset
    strip._snap = () => { currentOffset = 0; snap(); };
  }

  _snapTo(strip, index) {
    const CELL_H = 48;
    const target = -(10 + this.digits[index] - 1) * CELL_H;
    strip.style.transform = `translateY(${target}px)`;
  }

  /* ── Public API ─────────────────────────────────── */

  getCode() {
    return this.digits.join('');
  }

  reset() {
    this.digits = [0, 0, 0, 0];
    this.reelEls.forEach(reel => {
      const strip = reel.querySelector('.dlock-strip');
      if (strip._snap) strip._snap();
    });
  }

  /* ── Styles (injected once) ─────────────────────── */

  _injectStyles() {
    if (document.getElementById('dlock-css')) return;
    const s = document.createElement('style');
    s.id = 'dlock-css';
    s.textContent = `
.dlock{display:flex;flex-direction:column;align-items:center;gap:16px;padding:16px 0}
.dlock-reels{display:flex;gap:8px}
.dlock-reel{position:relative;width:52px;height:144px;overflow:hidden;border-radius:10px;background:#0d1220;border:1px solid var(--border,#1e2a45);cursor:grab;user-select:none;-webkit-user-select:none}
.dlock-reel.dlock-dragging{cursor:grabbing}
.dlock-strip{display:flex;flex-direction:column;will-change:transform}
.dlock-cell{height:48px;display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:700;font-variant-numeric:tabular-nums;color:#7a8ba8;transition:color .15s}
.dlock-window{position:absolute;top:48px;left:0;right:0;height:48px;border-top:2px solid #3b82f6;border-bottom:2px solid #3b82f6;pointer-events:none;z-index:2}
.dlock-fade{position:absolute;left:0;right:0;height:48px;pointer-events:none;z-index:1}
.dlock-fade-top{top:0;background:linear-gradient(to bottom,#0d1220 30%,transparent)}
.dlock-fade-bot{bottom:0;background:linear-gradient(to top,#0d1220 30%,transparent)}
.dlock-submit{padding:12px 32px;border:none;border-radius:8px;background:var(--accent,#3b82f6);color:#fff;font-size:15px;font-weight:600;cursor:pointer;transition:opacity .2s;letter-spacing:.5px}
.dlock-submit:active{opacity:.7}
`;
    document.head.appendChild(s);
  }
}
