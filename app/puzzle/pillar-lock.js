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
 */

class PillarLock {
  constructor(container, opts = {}) {
    this.container = container;
    this.pillars = opts.pillars || [];
    this.statements = opts.statements || [];
    this.onSubmit = opts.onSubmit || (() => {});
    this.onWrong = opts.onWrong || null;
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
  }

  _choose(pillar) {
    if (this.current >= this.statements.length) return;
    const correct = pillar === this.statements[this.current].answer;
    this.answers.push({ pillar, correct });

    if (correct) {
      this.cardEl.classList.add('pillk-right');
    } else {
      this.cardEl.classList.add('pillk-wrong');
    }

    setTimeout(() => {
      this.current++;
      this._showCurrent();
    }, 600);
  }

  _test() {
    const allCorrect = this.answers.every(a => a.correct);
    const score = this.answers.filter(a => a.correct).length;
    if (allCorrect) {
      this.cardEl.textContent = '🏛️';
      this.cardEl.classList.add('pillk-right');
      this.statusEl.textContent = `✅ All pillars correct! (${score}/${this.statements.length})`;
      this.pillarBtns.style.display = 'none';
      setTimeout(() => this.onSubmit(true), 400);
    } else {
      this.statusEl.textContent = `❌ ${score}/${this.statements.length} correct — try again`;
      this.cardEl.textContent = 'Review and retry';
      if (this.onWrong) this.onWrong('Wrong — some statements are incorrect. Try again.');
      setTimeout(() => this.reset(), 2000);
    }
  }

  reset() {
    this.current = 0;
    this.answers = [];
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
.pillk-status{font-size:13px;color:var(--muted,#7a8ba8);min-height:18px;text-align:center}
`;
    document.head.appendChild(s);
  }
}
