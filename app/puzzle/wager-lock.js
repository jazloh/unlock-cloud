/**
 * Wager Lock Puzzle
 *
 * Player is presented with a question and must choose a confidence level
 * BEFORE answering. Higher confidence = more reward on correct, more penalty
 * on wrong. Forces metacognition — "how sure am I?"
 *
 * Multiple rounds. Accumulate points to hit the target.
 *
 * Inspired by Final Jeopardy / poker pot mechanics.
 *
 * Usage:
 *   new WagerLock(containerEl, {
 *     target: 10,
 *     questions: [
 *       {
 *         question: 'What port does HTTPS use?',
 *         options: ['80', '443', '8080', '22'],
 *         answer: '443',
 *       },
 *       ...
 *     ],
 *     stakes: [
 *       { label: 'Safe', wager: 1, penalty: 0, color: '#22c55e', showOptions: 2 },
 *       { label: 'Confident', wager: 2, penalty: -1, color: '#eab308', showOptions: 4 },
 *       { label: 'All In', wager: 4, penalty: -3, color: '#ef4444', showOptions: 6 },
 *     ],
 *     onSubmit(correct) { ... }
 *   });
 */

class WagerLock {
  constructor(container, opts = {}) {
    this.container = container;
    this.target = opts.target || 10;
    this.questions = opts.questions || [];
    this.stakes = opts.stakes || [
      { label: 'Safe', wager: 1, penalty: 0, color: '#22c55e', showOptions: 2 },
      { label: 'Confident', wager: 2, penalty: -1, color: '#eab308', showOptions: 4 },
      { label: 'All In', wager: 4, penalty: -3, color: '#ef4444', showOptions: 6 },
    ];
    this.maxRounds = opts.maxRounds || null;
    this.onSubmit = opts.onSubmit || (() => {});
    this.onWrong = opts.onWrong || null;
    this.revealAnswerOnWrong = opts.revealAnswerOnWrong !== false; // default true
    this.repeatOnWrong = opts.repeatOnWrong || false;

    this._init();
  }

  _init() {
    this.score = 0;
    this.round = 0;
    this.phase = 'wager'; // 'wager' | 'answer' | 'result'
    this.chosenStake = null;
    this.chosenAnswer = null;
    this.correct = null;
    this.won = false;
    this.history = [];
    this._shuffled = this._shuffle([...this.questions]);
    this._render();
  }

  _shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  _getVisibleOptions(q, count) {
    if (count >= q.options.length) return this._shuffle([...q.options]);
    const decoys = q.options.filter(o => o !== q.answer);
    const shuffledDecoys = this._shuffle([...decoys]);
    const selected = [q.answer, ...shuffledDecoys.slice(0, count - 1)];
    return this._shuffle(selected);
  }

  _selectStake(idx) {
    if (this.phase !== 'wager') return;
    this.chosenStake = idx;
    this.phase = 'answer';
    this._render();
  }

  _selectAnswer(answer) {
    if (this.phase !== 'answer') return;
    this.chosenAnswer = answer;
    const q = this._shuffled[this.round];
    const stake = this.stakes[this.chosenStake];
    this.correct = answer === q.answer;

    if (!this.correct && this.onWrong) this.onWrong('Wrong — try again.');

    if (this.correct) {
      this.score += stake.wager;
    } else {
      this.score += stake.penalty;
      if (this.score < 0) this.score = 0;
    }

    this.history.push({
      question: q.question,
      answer,
      correct: this.correct,
      stake: stake.label,
      delta: this.correct ? `+${stake.wager}` : `${stake.penalty}`,
    });

    if (this.maxRounds && this.round + 1 >= this.maxRounds) {
      // End the puzzle after maxRounds questions, regardless of score
      this.won = true;
      this.phase = 'result';
      this._render();
      setTimeout(() => this.onSubmit(true), 500);
      return;
    }

    if (this.score >= this.target) {
      this.won = true;
      this.phase = 'result';
      this._render();
      setTimeout(() => this.onSubmit(true), 600);
      return;
    }

    this.phase = 'result';
    this._render();
  }

  _nextRound() {
    this.round++;
    if (this.round >= this._shuffled.length) {
      this._shuffled = this._shuffle([...this.questions]);
      this.round = 0;
    }
    this.phase = 'wager';
    this.chosenStake = null;
    this.chosenAnswer = null;
    this.correct = null;
    this._render();
  }

  reset() { this._init(); }

  _render() {
    this.container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'wglk';

    // Score bar
    const pct = Math.min(100, (this.score / this.target) * 100);
    const scoreBar = document.createElement('div');
    scoreBar.className = 'wglk-bar-wrap';
    scoreBar.innerHTML = `<div class="wglk-bar" style="width:${pct}%"></div>`;
    wrap.appendChild(scoreBar);

    const scoreLabel = document.createElement('div');
    scoreLabel.className = 'wglk-score';
    scoreLabel.innerHTML = `<span>Score: <strong>${this.score}</strong> / ${this.target}</span><span>Round ${this.round + 1}</span>`;
    wrap.appendChild(scoreLabel);

    if (this.won) {
      const res = document.createElement('div');
      res.className = 'wglk-result wglk-win';
      res.textContent = `Target reached! (${this.score}/${this.target})`;
      wrap.appendChild(res);
      this.container.appendChild(wrap);
      this._injectStyles();
      return;
    }

    const q = this._shuffled[this.round];

    // Auto-skip stake selection when only one stake is configured — no meaningful choice.
    if (this.phase === 'wager' && this.stakes.length === 1) {
      this.chosenStake = 0;
      this.phase = 'answer';
      // fall through to render the answer phase
    }

    // Question (always visible)
    const qEl = document.createElement('div');
    qEl.className = 'wglk-question';
    qEl.textContent = q.question;
    wrap.appendChild(qEl);

    if (this.phase === 'wager') {
      // Stake selection
      const stakeBox = document.createElement('div');
      stakeBox.className = 'wglk-stakes';
      stakeBox.innerHTML = '<div class="wglk-stakes-title">How confident are you?</div>';
      const stakeRow = document.createElement('div');
      stakeRow.className = 'wglk-stake-row';
      this.stakes.forEach((s, i) => {
        const btn = document.createElement('button');
        btn.className = 'wglk-stake';
        btn.style.setProperty('--stake-color', s.color);
        btn.innerHTML = `<span class="wglk-stake-label">${s.label}</span>
          <span class="wglk-stake-reward">✓ +${s.wager}</span>
          <span class="wglk-stake-penalty">✕ ${s.penalty}</span>
          <span class="wglk-stake-choices">${s.showOptions || '?'} choices</span>`;
        btn.addEventListener('click', () => this._selectStake(i));
        stakeRow.appendChild(btn);
      });
      stakeBox.appendChild(stakeRow);
      wrap.appendChild(stakeBox);
    } else if (this.phase === 'answer') {
      // Show chosen stake
      const stakeInfo = document.createElement('div');
      stakeInfo.className = 'wglk-chosen-stake';
      const s = this.stakes[this.chosenStake];
      const showCount = s.showOptions || q.options.length;
      stakeInfo.innerHTML = `<span style="color:${s.color};font-weight:700">${s.label}</span> — correct: +${s.wager} | wrong: ${s.penalty} | ${showCount} choices`;
      wrap.appendChild(stakeInfo);

      // Build visible options: always include answer, fill rest from decoys
      const visibleOptions = this._getVisibleOptions(q, showCount);

      // Answer options
      const opts = document.createElement('div');
      opts.className = 'wglk-options';
      if (visibleOptions.length > 4) opts.classList.add('wglk-options-many');
      visibleOptions.forEach(opt => {
        const btn = document.createElement('button');
        btn.className = 'wglk-option';
        btn.textContent = opt;
        btn.addEventListener('click', () => this._selectAnswer(opt));
        opts.appendChild(btn);
      });
      wrap.appendChild(opts);
    } else if (this.phase === 'result') {
      // Show result
      const res = document.createElement('div');
      res.className = `wglk-round-result ${this.correct ? 'wglk-correct' : 'wglk-wrong'}`;
      const s = this.stakes[this.chosenStake];
      res.innerHTML = `
        <div class="wglk-result-icon">${this.correct ? '✓' : '✕'}</div>
        <div class="wglk-result-text">${this.correct ? 'Correct!' : (this.revealAnswerOnWrong ? `Wrong — answer: ${q.answer}` : 'Wrong!')}</div>
        <div class="wglk-result-delta" style="color:${this.correct ? s.color : 'var(--red,#ef4444)'}">${this.correct ? '+' + s.wager : s.penalty} pts</div>`;
      wrap.appendChild(res);

      const nextBtn = document.createElement('button');
      nextBtn.className = 'wglk-btn';
      nextBtn.textContent = (this.correct || !this.repeatOnWrong) ? 'Next Question' : 'Try Again';
      nextBtn.addEventListener('click', () => {
        if (!this.correct && this.repeatOnWrong) {
          this.phase = 'wager';
          this.chosenStake = null;
          this.chosenAnswer = null;
          this.correct = null;
          this._render();
        } else {
          this._nextRound();
        }
      });
      wrap.appendChild(nextBtn);
    }

    // History log
    if (this.history.length > 0) {
      const hist = document.createElement('div');
      hist.className = 'wglk-history';
      hist.innerHTML = '<div class="wglk-hist-title">History</div>' +
        this.history.map((h, i) =>
          `<div class="wglk-hist-row ${h.correct ? 'wglk-hist-correct' : 'wglk-hist-wrong'}">
            <span class="wglk-hist-num">#${i + 1}</span>
            <span class="wglk-hist-q">${h.question}</span>
            <span class="wglk-hist-answer">${h.correct ? '✓' : '✕'} ${h.answer}</span>
            <span class="wglk-hist-meta">
              <span class="wglk-hist-stake">${h.stake}</span>
              <span class="wglk-hist-delta">${h.delta}</span>
            </span>
          </div>`
        ).join('');
      wrap.appendChild(hist);
    }

    this.container.appendChild(wrap);
    this._injectStyles();
  }

  _injectStyles() {
    if (document.getElementById('wglk-css')) return;
    const s = document.createElement('style'); s.id = 'wglk-css';
    s.textContent = `
.wglk{display:flex;flex-direction:column;gap:12px;padding:16px 0;max-width:420px;margin:0 auto}
.wglk-bar-wrap{width:100%;height:8px;background:var(--surface,#141b2d);border-radius:4px;overflow:hidden;border:1px solid var(--border,#1e2a45)}
.wglk-bar{height:100%;background:var(--green,#22c55e);transition:width .4s;border-radius:4px}
.wglk-score{display:flex;justify-content:space-between;font-size:12px;color:var(--muted,#7a8ba8)}
.wglk-score strong{color:var(--text,#e0e6f0)}
.wglk-question{text-align:center;font-size:15px;font-weight:600;color:var(--text,#e0e6f0);padding:16px;background:var(--surface,#141b2d);border:1px solid var(--border,#1e2a45);border-radius:10px;line-height:1.5}
.wglk-stakes{text-align:center}
.wglk-stakes-title{font-size:12px;color:var(--muted,#7a8ba8);margin-bottom:10px;text-transform:uppercase;letter-spacing:1px}
.wglk-stake-row{display:flex;gap:8px;justify-content:center}
.wglk-stake{display:flex;flex-direction:column;align-items:center;gap:4px;padding:12px 16px;background:var(--bg,#0a0e17);border:2px solid var(--stake-color);border-radius:10px;cursor:pointer;transition:all .15s;min-width:90px}
.wglk-stake:hover{background:rgba(255,255,255,.03);transform:scale(1.03)}
.wglk-stake:active{transform:scale(.97)}
.wglk-stake-label{font-size:13px;font-weight:700;color:var(--stake-color)}
.wglk-stake-reward{font-size:11px;color:var(--green,#22c55e)}
.wglk-stake-penalty{font-size:11px;color:var(--red,#ef4444)}
.wglk-stake-choices{font-size:10px;color:var(--muted,#7a8ba8);border-top:1px solid var(--border,#1e2a45);padding-top:4px;margin-top:2px}
.wglk-chosen-stake{text-align:center;font-size:12px;color:var(--muted,#7a8ba8);padding:6px;background:var(--surface,#141b2d);border-radius:6px}
.wglk-options{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.wglk-options-many{grid-template-columns:1fr 1fr 1fr}
.wglk-option{padding:14px 12px;background:var(--bg,#0a0e17);border:1px solid var(--border,#1e2a45);border-radius:8px;color:var(--text,#e0e6f0);font-size:14px;font-weight:600;cursor:pointer;text-align:center;transition:all .15s}
.wglk-option:hover{border-color:var(--accent,#3b82f6);background:rgba(59,130,246,.05)}
.wglk-option:active{transform:scale(.97)}
.wglk-round-result{text-align:center;padding:16px;border-radius:10px;animation:wglk-pop .3s ease-out}
@keyframes wglk-pop{0%{transform:scale(.9);opacity:0}100%{transform:scale(1);opacity:1}}
.wglk-correct{background:rgba(34,197,94,.1);border:1px solid var(--green,#22c55e)}
.wglk-wrong{background:rgba(239,68,68,.1);border:1px solid var(--red,#ef4444)}
.wglk-result-icon{font-size:28px;font-weight:900;margin-bottom:4px}
.wglk-correct .wglk-result-icon{color:var(--green,#22c55e)}
.wglk-wrong .wglk-result-icon{color:var(--red,#ef4444)}
.wglk-result-text{font-size:13px;color:var(--text,#e0e6f0);margin-bottom:4px}
.wglk-result-delta{font-size:18px;font-weight:700}
.wglk-result{text-align:center;padding:16px;border-radius:10px;font-size:15px;font-weight:700}
.wglk-win{color:var(--green,#22c55e);background:rgba(34,197,94,.15)}
.wglk-btn{display:block;margin:0 auto;padding:10px 24px;background:var(--accent,#3b82f6);color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer}
.wglk-btn:active{transform:scale(.95)}
.wglk-history{background:var(--surface,#141b2d);border:1px solid var(--border,#1e2a45);border-radius:8px;padding:10px 12px;max-height:200px;overflow-y:auto}
.wglk-hist-title{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--muted,#7a8ba8);margin-bottom:8px}
.wglk-hist-row{display:grid;grid-template-columns:24px 1fr auto auto;gap:6px;align-items:center;padding:6px 0;border-bottom:1px solid var(--border,#1e2a45);font-size:11px}
.wglk-hist-row:last-child{border:none}
.wglk-hist-num{color:var(--muted,#7a8ba8);font-size:10px;font-weight:600}
.wglk-hist-q{color:var(--text,#e0e6f0);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.wglk-hist-answer{font-weight:600;white-space:nowrap}
.wglk-hist-correct .wglk-hist-answer{color:var(--green,#22c55e)}
.wglk-hist-wrong .wglk-hist-answer{color:var(--red,#ef4444)}
.wglk-hist-meta{display:flex;gap:4px;align-items:center;white-space:nowrap}
.wglk-hist-stake{color:var(--muted,#7a8ba8);font-size:10px;background:var(--bg,#0a0e17);padding:1px 5px;border-radius:3px}
.wglk-hist-delta{font-weight:700;font-size:11px}
.wglk-hist-correct .wglk-hist-delta{color:var(--green,#22c55e)}
.wglk-hist-wrong .wglk-hist-delta{color:var(--red,#ef4444)}
`;
    document.head.appendChild(s);
  }
}
