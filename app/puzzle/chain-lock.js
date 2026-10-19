/**
 * Lambda Chain Lock Puzzle
 *
 * Connect event sources → Lambda functions → destinations in correct order.
 * Player drags items into a pipeline sequence.
 *
 * Usage:
 *   new ChainLock(containerEl, {
 *     items: [
 *       { id: 'api', label: 'API Gateway', icon: '🌐' },
 *       { id: 'fn1', label: 'Validate', icon: 'λ' },
 *       { id: 'sqs', label: 'SQS Queue', icon: '📨' },
 *       { id: 'fn2', label: 'Process', icon: 'λ' },
 *       { id: 'ddb', label: 'DynamoDB', icon: '🗄️' },
 *     ],
 *     answer: ['api','fn1','sqs','fn2','ddb'],
 *     // optional labels; each defaults to the original pipeline wording
 *     title, submitLabel, placeholder, successText, wrongText,
 *     onSubmit(correct) { ... }
 *   });
 */

class ChainLock {
  constructor(container, opts = {}) {
    this.container = container;
    this.items = opts.items || [];
    this.answer = opts.answer || [];
    this.onSubmit = opts.onSubmit || (() => {});
    // Optional labels. Defaults are the original text, so episodes that don't
    // pass them render exactly as before.
    this.title = opts.title || 'Build the event pipeline';
    this.submitLabel = opts.submitLabel || 'Deploy Pipeline';
    this.placeholder = opts.placeholder || 'Tap items to build chain →';
    this.successText = opts.successText || '✅ Pipeline deployed!';
    this.wrongText = opts.wrongText || '❌ Wrong pipeline order';
    this.chain = [];
    this._render();
  }

  _render() {
    this.container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'chnlk';

    const title = document.createElement('div');
    title.className = 'chnlk-title';
    title.textContent = this.title;
    wrap.appendChild(title);

    // Pipeline display
    this.pipeEl = document.createElement('div');
    this.pipeEl.className = 'chnlk-pipe';
    wrap.appendChild(this.pipeEl);

    // Item pool
    this.poolEl = document.createElement('div');
    this.poolEl.className = 'chnlk-pool';
    wrap.appendChild(this.poolEl);

    const bar = document.createElement('div');
    bar.className = 'chnlk-bar';
    const resetBtn = document.createElement('button');
    resetBtn.className = 'chnlk-btn-sec';
    resetBtn.textContent = '↻ Reset';
    resetBtn.addEventListener('click', () => this.reset());
    bar.appendChild(resetBtn);
    const btn = document.createElement('button');
    btn.className = 'chnlk-btn';
    btn.textContent = this.submitLabel;
    btn.addEventListener('click', () => this._test());
    bar.appendChild(btn);
    wrap.appendChild(bar);

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'chnlk-status';
    wrap.appendChild(this.statusEl);

    this.container.appendChild(wrap);
    this._injectStyles();
    this._updateView();
  }

  _updateView() {
    const inChain = new Set(this.chain);
    // Pool
    this.poolEl.innerHTML = '';
    this.items.forEach(item => {
      if (inChain.has(item.id)) return;
      const chip = document.createElement('div');
      chip.className = 'chnlk-chip';
      chip.innerHTML = `<span class="chnlk-icon">${item.icon}</span> ${item.label}`;
      chip.addEventListener('click', () => { this.chain.push(item.id); this._updateView(); });
      this.poolEl.appendChild(chip);
    });
    // Pipeline
    this.pipeEl.innerHTML = '';
    if (!this.chain.length) { this.pipeEl.innerHTML = '<span style="color:var(--muted)"></span>'; this.pipeEl.firstChild.textContent = this.placeholder; return; }
    this.chain.forEach((id, i) => {
      const item = this.items.find(x => x.id === id);
      const el = document.createElement('div');
      el.className = 'chnlk-node';
      el.innerHTML = `<span class="chnlk-icon">${item.icon}</span>${item.label}`;
      el.addEventListener('click', () => { this.chain.splice(i, 1); this._updateView(); });
      this.pipeEl.appendChild(el);
      if (i < this.chain.length - 1) {
        const arrow = document.createElement('span');
        arrow.className = 'chnlk-arrow';
        arrow.textContent = '→';
        this.pipeEl.appendChild(arrow);
      }
    });
  }

  _test() {
    const correct = this.chain.length === this.answer.length && this.chain.every((id, i) => id === this.answer[i]);
    if (correct) {
      this.statusEl.textContent = this.successText;
      this.pipeEl.querySelectorAll('.chnlk-node').forEach(el => el.classList.add('chnlk-done'));
      setTimeout(() => this.onSubmit(true), 400);
    } else {
      this.statusEl.textContent = this.wrongText;
      this.pipeEl.classList.add('chnlk-shake');
      setTimeout(() => this.pipeEl.classList.remove('chnlk-shake'), 600);
    }
  }

  reset() { this.chain = []; this._updateView(); this.statusEl.textContent = ''; }

  _injectStyles() {
    if (document.getElementById('chnlk-css')) return;
    const s = document.createElement('style'); s.id = 'chnlk-css';
    s.textContent = `
.chnlk{display:flex;flex-direction:column;gap:12px;padding:16px 0;max-width:400px;margin:0 auto}
.chnlk-title{font-size:13px;color:var(--muted,#7a8ba8);font-weight:600;text-align:center}
.chnlk-pipe{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-height:44px;padding:12px;background:var(--surface,#141b2d);border:2px dashed var(--border,#1e2a45);border-radius:8px;transition:all .2s}
.chnlk-node{padding:6px 10px;background:var(--bg,#0a0e17);border:1px solid var(--accent,#3b82f6);border-radius:6px;font-size:12px;font-weight:600;color:var(--text,#e0e6f0);cursor:pointer;display:flex;align-items:center;gap:4px;white-space:nowrap}
.chnlk-node.chnlk-done{border-color:var(--green,#22c55e);color:var(--green,#22c55e)}
.chnlk-arrow{color:var(--accent,#3b82f6);font-size:16px}
.chnlk-icon{font-size:14px}
.chnlk-pool{display:flex;flex-wrap:wrap;gap:6px;justify-content:center}
.chnlk-chip{padding:8px 12px;background:var(--surface,#141b2d);border:1px solid var(--border,#1e2a45);border-radius:8px;font-size:12px;color:var(--text,#e0e6f0);cursor:pointer;display:flex;align-items:center;gap:6px;transition:all .15s}
.chnlk-chip:active{transform:scale(.95)}
.chnlk-bar{display:flex;gap:8px;justify-content:center}
.chnlk-btn,.chnlk-btn-sec{padding:10px 20px;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer}
.chnlk-btn{background:var(--accent,#3b82f6);color:#fff}
.chnlk-btn-sec{background:var(--surface,#141b2d);border:1px solid var(--border,#1e2a45);color:var(--muted,#7a8ba8)}
.chnlk-shake{animation:chnlk-sh .4s}
@keyframes chnlk-sh{0%,100%{transform:translateX(0)}25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}
.chnlk-status{font-size:13px;color:var(--muted,#7a8ba8);text-align:center;min-height:18px}
`;
    document.head.appendChild(s);
  }
}
