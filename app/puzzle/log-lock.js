/**
 * Log Parser Lock Puzzle
 *
 * Scrollable log output. Player selects the correct lines that contain the clue.
 *
 * Usage:
 *   new LogLock(containerEl, {
 *     lines: [
 *       { text: '2024-01-15 10:23:01 INFO Starting service...', correct: false },
 *       { text: '2024-01-15 10:23:05 ERROR Connection refused 10.0.3.42:5432', correct: true },
 *       { text: '2024-01-15 10:23:06 WARN Retrying in 5s...', correct: false },
 *     ],
 *     prompt: 'Select the line showing the database connection error',
 *     onSubmit(correct) { ... }
 *   });
 */

class LogLock {
  constructor(container, opts = {}) {
    this.container = container;
    this.lines = opts.lines || [];
    this.prompt = opts.prompt || 'Select the relevant log lines';
    this.onSubmit = opts.onSubmit || (() => {});
    this.highContrast = !!opts.highContrast;
    this.selected = new Set();
    this._render();
  }

  _render() {
    this.container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'loglk' + (this.highContrast ? ' loglk-hc' : '');

    const promptEl = document.createElement('div');
    promptEl.className = 'loglk-prompt';
    promptEl.textContent = this.prompt;
    wrap.appendChild(promptEl);

    this.countEl = document.createElement('div');
    this.countEl.className = 'loglk-count';
    this.countEl.textContent = 'Tap the suspicious log lines to select them';
    wrap.appendChild(this.countEl);

    const logBox = document.createElement('div');
    logBox.className = 'loglk-box';
    this.lineEls = [];
    this.lines.forEach((line, i) => {
      const el = document.createElement('div');
      el.className = 'loglk-line';
      const check = document.createElement('span');
      check.className = 'loglk-check';
      check.textContent = '✓';
      el.appendChild(check);
      const num = document.createElement('span');
      num.className = 'loglk-num';
      num.textContent = i + 1;
      const txt = document.createElement('span');
      txt.className = 'loglk-text';
      txt.textContent = line.text;
      // Color code log levels
      if (line.text.includes('ERROR')) txt.classList.add('loglk-err');
      else if (line.text.includes('WARN')) txt.classList.add('loglk-warn');
      else if (line.text.includes('INFO')) txt.classList.add('loglk-info');
      el.appendChild(num);
      el.appendChild(txt);
      el.addEventListener('click', () => this._toggle(i));
      logBox.appendChild(el);
      this.lineEls.push(el);
    });
    wrap.appendChild(logBox);

    const btn = document.createElement('button');
    btn.className = 'loglk-btn';
    btn.textContent = 'Analyze';
    btn.addEventListener('click', () => this._test());
    wrap.appendChild(btn);

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'loglk-status';
    wrap.appendChild(this.statusEl);

    this.container.appendChild(wrap);
    this._injectStyles();
  }

  _toggle(i) {
    if (this.selected.has(i)) { this.selected.delete(i); this.lineEls[i].classList.remove('loglk-selected'); }
    else { this.selected.add(i); this.lineEls[i].classList.add('loglk-selected'); }
    if (this.countEl) {
      const n = this.selected.size;
      this.countEl.textContent = n ? `${n} line${n>1?'s':''} selected — tap “Analyze” when ready` : 'Tap the suspicious log lines to select them';
    }
  }

  _test() {
    const correctSet = new Set(this.lines.map((l, i) => l.correct ? i : -1).filter(i => i >= 0));
    const correct = this.selected.size === correctSet.size && [...this.selected].every(i => correctSet.has(i));
    if (correct) {
      this.statusEl.textContent = '✅ Correct lines identified!';
      this.lineEls.forEach((el, i) => { if (correctSet.has(i)) el.classList.add('loglk-correct'); });
      setTimeout(() => this.onSubmit(true), 400);
    } else {
      this.statusEl.textContent = '❌ Wrong selection — try again';
      this.lineEls.forEach(el => { el.classList.add('loglk-shake'); setTimeout(() => el.classList.remove('loglk-shake'), 600); });
    }
  }

  reset() { this.selected = new Set(); this.lineEls.forEach(el => el.classList.remove('loglk-selected','loglk-correct')); this.statusEl.textContent = ''; }

  _injectStyles() {
    if (document.getElementById('loglk-css')) return;
    const s = document.createElement('style');
    s.id = 'loglk-css';
    s.textContent = `
.loglk{display:flex;flex-direction:column;gap:12px;padding:16px 0;max-width:400px;margin:0 auto}
.loglk-prompt{font-size:13px;color:#7a8ba8;font-weight:600}
.loglk-box{background:#0c0c0c;border:1px solid #1e2a45;border-radius:8px;padding:8px;max-height:200px;overflow-y:auto;font-family:'Courier New',monospace;font-size:11px}
.loglk-line{display:flex;gap:8px;padding:4px 6px;border-radius:4px;cursor:pointer;transition:background .15s;border:1px solid transparent}
.loglk-line:hover{background:rgba(59,130,246,.05)}
.loglk-line.loglk-selected{background:rgba(59,130,246,.22);border-color:#3b82f6;box-shadow:inset 0 0 0 1px #3b82f6}
.loglk-line.loglk-selected .loglk-text{color:#dbeafe}
.loglk-line.loglk-correct{background:rgba(34,197,94,.18);border-color:#22c55e}
.loglk-check{color:transparent;min-width:14px;flex-shrink:0;font-weight:800;transition:color .12s}
.loglk-line.loglk-selected .loglk-check{color:#3b82f6}
.loglk-line.loglk-correct .loglk-check{color:#22c55e}
.loglk-count{font-size:12px;color:#3b82f6;font-weight:600;text-align:center;min-height:16px}
.loglk-num{color:#1e2a45;min-width:20px;text-align:right;flex-shrink:0}
.loglk-text{color:#7a8ba8;word-break:break-all}
.loglk-err{color:#ef4444}
.loglk-warn{color:#eab308}
.loglk-info{color:#7a8ba8}
.loglk-shake{animation:loglk-sh .4s}
@keyframes loglk-sh{0%,100%{transform:translateX(0)}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}
.loglk-btn{padding:12px 28px;border:none;border-radius:8px;background:#3b82f6;color:#fff;font-size:14px;font-weight:600;cursor:pointer;align-self:center}
.loglk-btn:active{opacity:.7}
.loglk-status{font-size:13px;color:#7a8ba8;text-align:center;min-height:18px}
/* High-contrast selection (opt-in via highContrast:true) — ep11 */
.loglk-hc .loglk-box{padding:10px}
.loglk-hc .loglk-line{padding:9px 10px;margin:3px 0;border-width:2px;border-radius:8px}
.loglk-hc .loglk-line:hover{background:rgba(59,130,246,.12)}
.loglk-hc .loglk-line.loglk-selected{background:rgba(59,130,246,.38);border-color:#60a5fa;box-shadow:0 0 0 2px rgba(96,165,250,.55),0 4px 14px rgba(59,130,246,.4);border-left:5px solid #60a5fa}
.loglk-hc .loglk-line.loglk-selected .loglk-text{color:#fff}
.loglk-hc .loglk-line.loglk-selected .loglk-num{color:#bfdbfe}
.loglk-hc .loglk-check{min-width:18px;font-size:13px}
.loglk-hc .loglk-line.loglk-selected .loglk-check{color:#fff;text-shadow:0 0 6px rgba(96,165,250,.9)}
.loglk-hc .loglk-line.loglk-correct{background:rgba(34,197,94,.34);border-color:#4ade80;border-left:5px solid #4ade80}
.loglk-hc .loglk-line.loglk-correct .loglk-text{color:#fff}
`;
    document.head.appendChild(s);
  }
}
