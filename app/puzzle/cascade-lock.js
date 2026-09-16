class CascadeLock {
  constructor(el, opts) {
    this.el = el;
    this.cfg = opts.config || opts;
    this.onSubmit = opts.onSubmit;
    this.onWrong = opts.onWrong;
    this.cupNames = this.cfg.cupNames;
    this.steps = this.cfg.steps;
    // Opt-in: shuffle each step's options so the correct answer isn't always
    // first. Default OFF — other episodes keep their original option order.
    if (this.cfg.shuffle_options) {
      this.steps = this.steps.map(st => {
        if (!Array.isArray(st.options) || st.options.length < 2) return st;
        const idx = st.options.map((_, i) => i);
        for (let i = idx.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [idx[i], idx[j]] = [idx[j], idx[i]];
        }
        const newOptions = idx.map(i => st.options[i]);
        const newAnswer = idx.indexOf(st.answer);
        let newWrong = st.wrong;
        if (Array.isArray(st.wrong)) newWrong = idx.map(i => st.wrong[i]);
        return { ...st, options: newOptions, answer: newAnswer, wrong: newWrong };
      });
    }
    this.pause = this.cfg.pauseBetweenSteps || 3000;
    this.step = 0;
    this.waiting = false;
    this._injectStyles();
    this._render();
  }
  _injectStyles() {
    if (document.getElementById('cslk-style')) return;
    const s = document.createElement('style'); s.id = 'cslk-style';
    s.textContent = `
.cslk-wrap{max-width:420px;margin:0 auto;padding:8px 0}
.cslk-cups{display:flex;justify-content:center;gap:10px;margin:16px 0}
.cslk-cup{background:#3d2a1f;border:2px solid #555;border-radius:8px;padding:10px;text-align:center;width:70px;transition:all 0.6s}
.cslk-cup.lit{border-color:#f39c12;box-shadow:0 0 12px rgba(243,156,18,0.5)}
.cslk-cup.lit .cslk-cup-name{color:#f39c12}
.cslk-cup.done{border-color:#2ecc71;box-shadow:0 0 16px rgba(46,204,113,0.6);background:#1e3a2a}
.cslk-cup.done .cslk-cup-name{color:#2ecc71}
.cslk-cup-icon{font-size:1.5rem}
.cslk-cup-name{font-size:11px;color:#888;margin-top:4px}
.cslk-progress{display:flex;gap:3px;margin-bottom:12px}
.cslk-bar{flex:1;height:4px;border-radius:2px;background:#333}
.cslk-bar.done{background:#2ecc71}
.cslk-bar.active{background:#f39c12}
.cslk-input{background:var(--bg,#1a1a2e);border:1px solid var(--border,#444);border-radius:8px;padding:12px}
.cslk-question{font-size:13px;color:var(--text,#eee);margin-bottom:10px}
.cslk-option{display:block;width:100%;text-align:left;padding:10px;margin-bottom:6px;background:var(--surface,#2a2a4e);border:1px solid var(--border,#444);border-radius:6px;color:var(--text,#eee);cursor:pointer;font-size:13px}
.cslk-hint{font-size:11px;color:#e74c3c;margin-top:8px;min-height:16px}
.cslk-after{margin-top:12px;background:var(--surface,#2a2a4e);border-left:3px solid #2ecc71;border-radius:0 6px 6px 0;padding:10px;font-size:13px;color:#2ecc71;font-style:italic;animation:cslk-fade 0.5s}
.cslk-scene{background:linear-gradient(to bottom,#2a1a0a,#1a1a2e);border:2px solid #f39c12;border-radius:12px;padding:1.5rem;text-align:center;animation:cslk-fade 1.5s}
.cslk-scene-emoji{font-size:2rem;margin-bottom:10px}
.cslk-scene-text{font-size:14px;color:#f0e6c0;line-height:1.8;font-style:italic}
.cslk-scene-highlight{color:#f39c12;font-weight:bold}
.cslk-scene-sub{color:#ccc;font-style:normal}
.cslk-scene-big{color:#f39c12;font-size:1rem}
@keyframes cslk-fade{from{opacity:0}to{opacity:1}}`;
    document.head.appendChild(s);
  }
  _renderCups() {
    return `<div class="cslk-cups">${this.cupNames.map((name, i) => {
      const cls = this.step > this.steps.length ? 'done' : i < this.step ? 'lit' : '';
      return `<div class="cslk-cup ${cls}"><div class="cslk-cup-icon">☕</div><div class="cslk-cup-name">${name}</div></div>`;
    }).join('')}</div>`;
  }
  _render() {
    if (this.step >= this.steps.length) {
      const oc = this.cfg.onComplete || {};
      const emojis = oc.emojis || '🌅🔥🍞🐟';
      const mainText = oc.text || 'Complete.';
      const subText = oc.subtext || '';
      this.el.innerHTML = `<div class="cslk-wrap">${this._renderCups()}<div class="cslk-scene">
        <div class="cslk-scene-emoji">${emojis}</div>
        <div class="cslk-scene-text">
          <span class="cslk-scene-highlight">${mainText}</span><br><br>
          <span class="cslk-scene-big">${subText}</span>
        </div>
        <button id="cslk-continue" style="margin-top:16px;padding:10px 24px;border:2px solid #f39c12;background:transparent;color:#f39c12;border-radius:8px;font-size:14px;cursor:pointer">Continue...</button>
      </div></div>`;
      this.el.querySelector('#cslk-continue').addEventListener('click', () => this.onSubmit());
      return;
    }
    const st = this.steps[this.step];
    const progress = this.steps.map((_, i) => `<div class="cslk-bar${i < this.step ? ' done' : i === this.step ? ' active' : ''}"></div>`).join('');
    this.el.innerHTML = `<div class="cslk-wrap">${this._renderCups()}<div class="cslk-progress">${progress}</div>
      <div class="cslk-input"><div class="cslk-question">${st.question}</div>${st.options.map((o, i) => `<button class="cslk-option" data-opt="${i}">${o}</button>`).join('')}<div class="cslk-hint" id="cslk-hint"></div></div></div>`;
    this.el.querySelectorAll('[data-opt]').forEach(b => b.addEventListener('click', e => {
      if (this.waiting) return;
      const i = +e.currentTarget.dataset.opt;
      if (i === st.answer) {
        this.waiting = true;
        if (st.after) {
          const afterEl = document.createElement('div');
          afterEl.className = 'cslk-after';
          afterEl.textContent = st.after;
          this.el.querySelector('.cslk-input').appendChild(afterEl);
          setTimeout(() => { this.step++; this.waiting = false; this._render(); }, this.pause);
        } else { this.step++; this.waiting = false; this._render(); }
      } else {
        const hint = this.el.querySelector('#cslk-hint');
        if (hint && st.wrong && st.wrong[i]) hint.textContent = '❌ ' + st.wrong[i];
        if (this.onWrong) this.onWrong(st.wrong?.[i] || 'Wrong.');
      }
    }));
  }
}
