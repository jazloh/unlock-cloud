/**
 * Incident Timeline Lock Puzzle
 *
 * Tap two cards to swap them until the events read in chronological order.
 *
 * ENHANCED MODE (opt-in, backward compatible):
 *   Pass enhanced:true to get the high-visibility UI — how-to banner,
 *   numbered position badges, a "picked up X" status line, bright selection
 *   fill + grip icon, and swap animation. WITHOUT enhanced:true the component
 *   renders exactly as the original (faint dot timeline) so the 5 other
 *   episodes using timeline-lock are visually unchanged.
 *
 * Usage:
 *   new TimelineLock(containerEl, {
 *     events: [ { id:'a', label:'Alarm fired', time:'10:23' }, ... ],
 *     answer: ['a','b','c','d'],
 *     enhanced: true,          // ep11 only
 *     onSubmit(correct) { ... }
 *   });
 */

class TimelineLock {
  constructor(container, opts = {}) {
    this.container = container;
    this.events = (opts.events || []).map(e => {
      if (e.time) return { id: e.id, label: e.label, time: String(e.time) };
      const m = /^(.*?)\s*\(([^)]*\d[^)]*)\)\s*$/.exec(e.label || '');
      if (m) return { id: e.id, label: m[1].trim(), time: m[2].trim() };
      return { id: e.id, label: e.label, time: null };
    });
    this.answer = opts.answer || [];
    this.onSubmit = opts.onSubmit || (() => {});
    this.enhanced = !!opts.enhanced;      // OPT-IN — default false = legacy UI
    this.showTimes = false;
    this.order = this._shuffle(this.events.map(e => e.id));
    this.selected = null;
    this._render();
  }

  _shuffle(arr) {
    let s; do { s = [...arr]; for (let i = s.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [s[i], s[j]] = [s[j], s[i]]; } } while (s.length > 1 && s.every((v, i) => v === arr[i]));
    return s;
  }

  _render() {
    this.container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'tmlk' + (this.enhanced ? ' tmlk-enhanced' : '');

    const title = document.createElement('div');
    title.className = 'tmlk-title';
    title.textContent = this.enhanced
      ? 'Put the events in order — earliest at the top'
      : 'Arrange events in chronological order';
    wrap.appendChild(title);

    // Enhanced-only: explicit how-to banner + live pick status
    if (this.enhanced) {
      const how = document.createElement('div');
      how.className = 'tmlk-how';
      how.innerHTML = '👆 Tap a card to pick it up, then tap another to <b>swap</b> their places.';
      wrap.appendChild(how);

      this.pickEl = document.createElement('div');
      this.pickEl.className = 'tmlk-pick';
      this.pickEl.textContent = '';
      wrap.appendChild(this.pickEl);
    }

    this.listEl = document.createElement('div');
    this.listEl.className = 'tmlk-list';
    wrap.appendChild(this.listEl);

    if (this.events.some(e => e.time)) {
      this.timesBtn = document.createElement('button');
      this.timesBtn.className = 'tmlk-times-btn';
      this.timesBtn.textContent = '🕐 Check timestamps';
      this.timesBtn.addEventListener('click', () => {
        this.showTimes = true;
        this.timesBtn.textContent = '🕐 Timestamps revealed';
        this.timesBtn.disabled = true;
        this._renderItems();
      });
      wrap.appendChild(this.timesBtn);
    }

    const btn = document.createElement('button');
    btn.className = 'tmlk-btn';
    btn.textContent = this.enhanced ? 'Confirm Order' : 'Confirm Timeline';
    btn.addEventListener('click', () => this._test());
    wrap.appendChild(btn);

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'tmlk-status';
    wrap.appendChild(this.statusEl);

    this.container.appendChild(wrap);
    this._injectStyles();
    this._renderItems();
  }

  _renderItems() {
    this.listEl.innerHTML = '';
    this.itemEls = [];
    this.order.forEach((id, i) => {
      const ev = this.events.find(e => e.id === id);
      const el = document.createElement('div');
      el.className = 'tmlk-item';
      if (this.selected === i) el.classList.add('tmlk-selected');

      if (this.enhanced) {
        const pos = document.createElement('span');
        pos.className = 'tmlk-pos';
        pos.textContent = (i + 1);
        const body = document.createElement('span');
        body.className = 'tmlk-body';
        const timeHtml = (this.showTimes && ev.time) ? `<span class="tmlk-time">${ev.time}</span>` : '';
        body.innerHTML = `<span class="tmlk-ev-label">${ev.label}</span>${timeHtml}`;
        const grip = document.createElement('span');
        grip.className = 'tmlk-grip';
        grip.textContent = (this.selected === i) ? '✋' : '⇅';
        el.appendChild(pos);
        el.appendChild(body);
        el.appendChild(grip);
      } else {
        // Legacy DOM: dot + label + time
        const dot = document.createElement('span');
        dot.className = 'tmlk-dot';
        const timeHtml = (this.showTimes && ev.time) ? `<span class="tmlk-time">${ev.time}</span>` : '';
        el.innerHTML = `<span class="tmlk-dot"></span><span class="tmlk-ev-label">${ev.label}</span>${timeHtml}`;
      }

      el.addEventListener('click', () => this._tap(i));
      this.listEl.appendChild(el);
      this.itemEls.push(el);
    });
  }

  _tap(i) {
    if (this.selected === null) {
      this.selected = i;
      this._renderItems();
      if (this.enhanced && this.pickEl) {
        const ev = this.events.find(e => e.id === this.order[i]);
        this.pickEl.innerHTML = `Picked up <b>“${ev.label}”</b> — now tap where it should go.`;
        this.pickEl.classList.add('tmlk-pick-active');
      }
    } else if (this.selected === i) {
      this.selected = null;
      this._renderItems();
      if (this.enhanced && this.pickEl) { this.pickEl.textContent = ''; this.pickEl.classList.remove('tmlk-pick-active'); }
    } else {
      [this.order[this.selected], this.order[i]] = [this.order[i], this.order[this.selected]];
      const swapped = i;
      this.selected = null;
      this._renderItems();
      if (this.enhanced && this.pickEl) {
        this.pickEl.textContent = '';
        this.pickEl.classList.remove('tmlk-pick-active');
        if (this.itemEls[swapped]) {
          this.itemEls[swapped].classList.add('tmlk-justmoved');
          setTimeout(() => this.itemEls[swapped] && this.itemEls[swapped].classList.remove('tmlk-justmoved'), 450);
        }
      }
    }
  }

  _test() {
    const correct = this.order.every((id, i) => id === this.answer[i]);
    if (correct) {
      this.statusEl.textContent = '✅ Timeline correct!';
      this.itemEls.forEach(el => el.classList.add('tmlk-done'));
      setTimeout(() => this.onSubmit(true), 400);
    } else {
      this.statusEl.textContent = this.enhanced ? '❌ Not quite — keep swapping' : '❌ Wrong order';
      this.listEl.classList.add('tmlk-shake');
      setTimeout(() => this.listEl.classList.remove('tmlk-shake'), 600);
    }
  }

  reset() { this.order = this._shuffle(this.events.map(e => e.id)); this.selected = null; this._renderItems(); this.statusEl.textContent = ''; if (this.pickEl) this.pickEl.textContent=''; }

  _injectStyles() {
    if (document.getElementById('tmlk-css')) return;
    const s = document.createElement('style'); s.id = 'tmlk-css';
    s.textContent = `
/* ===== LEGACY BASE (unchanged from original — other episodes) ===== */
.tmlk{display:flex;flex-direction:column;gap:12px;padding:16px 0;max-width:360px;margin:0 auto}
.tmlk-title{font-size:13px;color:var(--muted,#7a8ba8);font-weight:600;text-align:center}
.tmlk-list{display:flex;flex-direction:column;gap:0;position:relative;padding-left:20px;border-left:2px solid var(--border,#1e2a45);margin-left:10px}
.tmlk-item{display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--surface,#141b2d);border:2px solid var(--border,#1e2a45);border-radius:8px;margin-bottom:8px;cursor:pointer;transition:all .15s;user-select:none;position:relative}
.tmlk-item:active{transform:scale(.97)}
.tmlk-item.tmlk-selected{border-color:var(--accent,#3b82f6);box-shadow:0 0 10px rgba(59,130,246,.3)}
.tmlk-item.tmlk-done{border-color:var(--green,#22c55e)}
.tmlk-dot{width:12px;height:12px;border-radius:50%;background:var(--accent,#3b82f6);flex-shrink:0;position:absolute;left:-27px}
.tmlk-done .tmlk-dot{background:var(--green,#22c55e)}
.tmlk-ev-label{font-size:13px;color:var(--text,#e0e6f0);font-weight:600}
.tmlk-time{margin-left:auto;font-size:12px;color:var(--accent,#3b82f6);font-family:'Courier New',monospace;font-weight:700;white-space:nowrap}
.tmlk-times-btn{padding:8px 16px;border:1px dashed var(--border,#1e2a45);border-radius:8px;background:transparent;color:var(--muted,#7a8ba8);font-size:12px;font-weight:600;cursor:pointer;align-self:center}
.tmlk-times-btn:active{opacity:.7}
.tmlk-times-btn:disabled{opacity:.7;cursor:default;border-style:solid;color:var(--accent,#3b82f6)}
.tmlk-shake{animation:tmlk-sh .4s}
@keyframes tmlk-sh{0%,100%{transform:translateX(0)}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}
.tmlk-btn{padding:12px 28px;border:none;border-radius:8px;background:var(--accent,#3b82f6);color:#fff;font-size:14px;font-weight:600;cursor:pointer;align-self:center}
.tmlk-btn:active{opacity:.7}
.tmlk-status{font-size:13px;color:var(--muted,#7a8ba8);text-align:center;min-height:18px}

/* ===== ENHANCED OVERRIDES (ep11 only — scoped under .tmlk-enhanced) ===== */
.tmlk-enhanced{gap:10px;max-width:380px}
.tmlk-enhanced .tmlk-title{font-size:14px;color:var(--text,#e0e6f0);font-weight:700}
.tmlk-enhanced .tmlk-how{font-size:12px;color:var(--muted,#7a8ba8);text-align:center;background:var(--surface,#141b2d);border:1px solid var(--border,#1e2a45);border-radius:8px;padding:8px 10px;line-height:1.5}
.tmlk-enhanced .tmlk-how b{color:var(--accent,#3b82f6)}
.tmlk-enhanced .tmlk-pick{font-size:12px;color:var(--muted,#7a8ba8);text-align:center;min-height:16px;transition:all .15s}
.tmlk-enhanced .tmlk-pick.tmlk-pick-active{color:var(--accent,#3b82f6);font-weight:600}
.tmlk-enhanced .tmlk-pick b{color:var(--accent,#3b82f6)}
.tmlk-enhanced .tmlk-list{gap:8px;position:static;padding-left:0;border-left:none;margin-left:0}
.tmlk-enhanced .tmlk-item{padding:12px 12px;border-radius:10px;margin-bottom:0;transition:transform .12s,border-color .15s,box-shadow .15s,background .15s}
.tmlk-enhanced .tmlk-item:hover{border-color:var(--accent,#3b82f6)}
.tmlk-enhanced .tmlk-item:active{transform:scale(.98)}
.tmlk-enhanced .tmlk-pos{width:26px;height:26px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:var(--bg,#0a0e17);border:1px solid var(--border,#1e2a45);border-radius:50%;font-size:13px;font-weight:800;color:var(--muted,#7a8ba8)}
.tmlk-enhanced .tmlk-body{flex:1;display:flex;align-items:center;gap:8px;min-width:0}
.tmlk-enhanced .tmlk-ev-label{line-height:1.35}
.tmlk-enhanced .tmlk-time{padding-left:8px}
.tmlk-enhanced .tmlk-grip{font-size:16px;color:var(--muted,#7a8ba8);flex-shrink:0}
.tmlk-enhanced .tmlk-item.tmlk-selected{border-color:var(--accent,#3b82f6);background:rgba(59,130,246,.16);box-shadow:0 0 0 3px rgba(59,130,246,.28),0 6px 16px rgba(59,130,246,.25);transform:translateY(-1px) scale(1.01)}
.tmlk-enhanced .tmlk-item.tmlk-selected .tmlk-pos{background:var(--accent,#3b82f6);color:#fff;border-color:var(--accent,#3b82f6)}
.tmlk-enhanced .tmlk-item.tmlk-selected .tmlk-grip{color:var(--accent,#3b82f6)}
.tmlk-enhanced .tmlk-item.tmlk-justmoved{animation:tmlk-pop .45s ease-out}
@keyframes tmlk-pop{0%{background:rgba(34,197,94,.28)}100%{background:var(--surface,#141b2d)}}
.tmlk-enhanced .tmlk-item.tmlk-done{background:rgba(34,197,94,.10)}
.tmlk-enhanced .tmlk-item.tmlk-done .tmlk-pos{background:var(--green,#22c55e);color:#fff;border-color:var(--green,#22c55e)}
.tmlk-enhanced .tmlk-btn{font-weight:700}
.tmlk-enhanced .tmlk-status{font-weight:600}
`;
    document.head.appendChild(s);
  }
}
