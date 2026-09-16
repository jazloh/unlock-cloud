/**
 * Bazaar Lock — Marketplace with Gold Economy & Reward Tiers
 *
 * Tap a quest scroll then tap a merchant stall to send it there. Multiple
 * stalls can handle a quest but yield different reward quality. Budget
 * tracks gold; remaining gold counts toward final score.
 *
 * Usage:
 *   new BazaarLock(el, {
 *     budget: 100,
 *     stalls: [
 *       { id: 'claude', label: 'Anthropic', icon: '🧙', specialty: 'Reasoning', cost: 40 },
 *       { id: 'llama', label: 'Meta Tent', icon: '💪', specialty: 'General', cost: 15 }
 *     ],
 *     quests: [
 *       { id: 'search', label: 'Search archives',
 *         accepts: [
 *           { stall: 'claude', tier: 'gold', reward: '🛡️ War Shield', msg: 'Flawless research!' },
 *           { stall: 'llama', tier: 'bronze', reward: '🪵 Wooden Shield', msg: 'Passable, but rough.' }
 *         ],
 *         failMsg: 'The merchant has no idea what to do.' }
 *     ],
 *     onSubmit({ spent, remaining, rewards }) {}, onWrong(msg) {}
 *   });
 */
class BazaarLock {
  constructor(container, opts = {}) {
    this.container = container;
    this.budget = opts.budget || 100;
    this.stalls = opts.stalls || [];
    this.quests = opts.quests || [];
    this.onSubmit = opts.onSubmit || (() => {});
    this.onWrong = opts.onWrong || (() => {});
    this.assignments = {};
    this._selectedQuest = null;
    this._render();
  }

  _render() {
    this.container.innerHTML = '';
    const w = document.createElement('div');
    w.className = 'bzlk';

    const legend = document.createElement('div');
    legend.className = 'bzlk-legend';
    legend.textContent = 'Tap an errand, then tap a stall to send it there. Tap a staffed stall to recall its errand.';
    w.appendChild(legend);

    // Budget bar
    const bw = document.createElement('div');
    bw.className = 'bzlk-budget-wrap';
    bw.innerHTML = '<span class="bzlk-budget-label">💰 Gold</span>';
    const bar = document.createElement('div');
    bar.className = 'bzlk-budget-bar';
    this.budgetFill = document.createElement('div');
    this.budgetFill.className = 'bzlk-budget-fill';
    bar.appendChild(this.budgetFill);
    bw.appendChild(bar);
    this.budgetText = document.createElement('span');
    this.budgetText.className = 'bzlk-budget-text';
    bw.appendChild(this.budgetText);
    w.appendChild(bw);

    // Savings hint
    this.savingsEl = document.createElement('div');
    this.savingsEl.className = 'bzlk-savings';
    w.appendChild(this.savingsEl);

    // Quest pool
    const qp = document.createElement('div');
    qp.className = 'bzlk-quests';
    qp.innerHTML = '<div class="bzlk-section-label">Errands</div>';
    this.questEls = {};
    this.quests.forEach(q => {
      const c = document.createElement('div');
      c.className = 'bzlk-quest' + (this._selectedQuest === q.id ? ' bzlk-quest-selected' : '');
      c.dataset.quest = q.id;
      c.innerHTML = `📜 ${q.label}`;
      c.addEventListener('click', () => {
        this._selectedQuest = this._selectedQuest === q.id ? null : q.id;
        this._updateUI();
      });
      qp.appendChild(c);
      this.questEls[q.id] = c;
    });
    w.appendChild(qp);

    // Stalls
    const sr = document.createElement('div');
    sr.className = 'bzlk-stalls';
    sr.innerHTML = '<div class="bzlk-section-label">Bedrock Bazaar</div>';
    this.stallEls = {};
    this.stalls.forEach(st => {
      const card = document.createElement('div');
      card.className = 'bzlk-stall';
      card.dataset.stall = st.id;
      card.innerHTML = `<div class="bzlk-stall-icon">${st.icon}</div>
        <div class="bzlk-stall-name">${st.label}</div>
        <div class="bzlk-stall-spec">${st.specialty}</div>
        <div class="bzlk-stall-cost">${st.cost}g</div>
        <div class="bzlk-stall-assigned"></div>`;
      card.addEventListener('click', () => {
        if (this._selectedQuest) { this._assign(this._selectedQuest, st.id); this._selectedQuest = null; }
        else this._unassignFromStall(st.id);
      });
      sr.appendChild(card);
      this.stallEls[st.id] = card;
    });
    w.appendChild(sr);

    const btn = document.createElement('button');
    btn.className = 'bzlk-btn';
    btn.textContent = '🤝 Send Runners';
    btn.addEventListener('click', () => this._test());
    w.appendChild(btn);

    // Rewards summary (hidden until submit)
    this.rewardsEl = document.createElement('div');
    this.rewardsEl.className = 'bzlk-rewards';
    w.appendChild(this.rewardsEl);

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'bzlk-status';
    w.appendChild(this.statusEl);

    this.container.appendChild(w);
    this._updateUI();
    this._injectStyles();
  }

  _assign(qId, sId) {
    Object.keys(this.assignments).forEach(q => { if (q === qId) delete this.assignments[q]; });
    this.assignments[qId] = sId;
    this.rewardsEl.innerHTML = '';
    this._updateUI();
  }

  _unassignFromStall(sId) {
    const toRemove = Object.keys(this.assignments).filter(q => this.assignments[q] === sId);
    toRemove.forEach(q => delete this.assignments[q]);
    if (toRemove.length) { this.rewardsEl.innerHTML = ''; this._updateUI(); }
  }

  _getSpent() {
    let spent = 0;
    Object.values(this.assignments).forEach(sId => {
      const st = this.stalls.find(s => s.id === sId);
      if (st) spent += st.cost;
    });
    return spent;
  }

  _updateUI() {
    const spent = this._getSpent();
    const remaining = this.budget - spent;
    const pct = Math.min(100, (spent / this.budget) * 100);
    this.budgetFill.style.width = pct + '%';
    this.budgetFill.classList.toggle('bzlk-over-budget', spent > this.budget);
    this.budgetText.textContent = `${spent} / ${this.budget}g`;
    this.savingsEl.textContent = remaining >= 0 ? `💎 ${remaining}g remaining → bonus score` : '⚠️ Over budget!';
    this.savingsEl.classList.toggle('bzlk-over-budget-text', remaining < 0);

    // Stall assigned display
    const sq = {};
    Object.entries(this.assignments).forEach(([qId, sId]) => { (sq[sId] = sq[sId] || []).push(qId); });
    this.stalls.forEach(st => {
      const el = this.stallEls[st.id].querySelector('.bzlk-stall-assigned');
      const qs = sq[st.id] || [];
      el.innerHTML = qs.map(qId => {
        const q = this.quests.find(x => x.id === qId);
        return `<div class="bzlk-assigned-quest">📜 ${q ? q.label : qId}</div>`;
      }).join('');
    });

    // Quest pool
    const assigned = new Set(Object.keys(this.assignments));
    this.quests.forEach(q => {
      this.questEls[q.id].classList.toggle('bzlk-placed', assigned.has(q.id));
      this.questEls[q.id].classList.toggle('bzlk-quest-selected', this._selectedQuest === q.id);
    });
    this.stalls.forEach(st => this.stallEls[st.id].classList.toggle('bzlk-over', !!this._selectedQuest));
  }

  _test() {
    const spent = this._getSpent();
    if (spent > this.budget) {
      this.statusEl.textContent = '💸 Over budget! Reassign to cheaper runners.';
      this.onWrong('Over budget');
      return;
    }

    // Check all quests assigned
    const unassigned = this.quests.filter(q => !this.assignments[q.id]);
    if (unassigned.length) {
      this.statusEl.textContent = `❌ ${unassigned.length} errand(s) not assigned yet`;
      this.onWrong('Unassigned errands');
      return;
    }

    // Evaluate each quest
    const rewards = [];
    let anyFail = false;
    const failMsgs = [];

    this.quests.forEach(q => {
      const sId = this.assignments[q.id];
      const match = (q.accepts || []).find(a => a.stall === sId);
      if (match) {
        rewards.push({ quest: q.id, label: q.label, tier: match.tier, reward: match.reward, msg: match.msg });
        this.stallEls[sId].classList.add('bzlk-correct');
      } else {
        anyFail = true;
        if (q.failMsg) failMsgs.push(q.failMsg);
        if (sId) {
          this.stallEls[sId].classList.add('bzlk-wrong');
          setTimeout(() => this.stallEls[sId].classList.remove('bzlk-wrong'), 700);
        }
      }
    });

    if (anyFail) {
      this.statusEl.textContent = failMsgs[0] || '❌ Some runners can\'t handle their assigned errand';
      this.onWrong(failMsgs[0] || 'Wrong assignment');
      setTimeout(() => this.stalls.forEach(st => this.stallEls[st.id].classList.remove('bzlk-correct', 'bzlk-wrong')), 1200);
      return;
    }

    // Show rewards
    const remaining = this.budget - spent;
    const tierIcon = { gold: '🥇', silver: '🥈', bronze: '🥉' };
    const tierEffect = { gold: 'Bonus hint unlocked', silver: 'Standard difficulty', bronze: 'Harder puzzle ahead' };
    this.rewardsEl.innerHTML = '<div class="bzlk-rewards-title">⚔️ Quest Rewards</div>' +
      rewards.map(r =>
        `<div class="bzlk-reward-row bzlk-tier-${r.tier}">` +
        `<span class="bzlk-reward-tier">${tierIcon[r.tier] || '⚙️'}</span>` +
        `<span class="bzlk-reward-item">${r.reward}</span>` +
        `<span class="bzlk-reward-msg">${r.msg}</span></div>` +
        `<div class="bzlk-reward-effect bzlk-tier-${r.tier}-text">${tierEffect[r.tier]}</div>`
      ).join('') +
      `<div class="bzlk-reward-gold">💎 ${remaining}g saved → +${remaining} bonus points</div>`;

    this.statusEl.textContent = '✅ All runners dispatched!';
    setTimeout(() => this.onSubmit({ spent, remaining, rewards }), 3000);
  }

  reset() {
    this.assignments = {};
    this.rewardsEl.innerHTML = '';
    this._updateUI();
    this.statusEl.textContent = '';
    this.stalls.forEach(st => this.stallEls[st.id].classList.remove('bzlk-correct', 'bzlk-wrong'));
  }

  _injectStyles() {
    if (document.getElementById('bzlk-css')) return;
    const s = document.createElement('style'); s.id = 'bzlk-css';
    s.textContent = `
.bzlk{display:flex;flex-direction:column;gap:12px;padding:16px 0;max-width:400px;margin:0 auto}
.bzlk-legend{font-size:12px;line-height:1.5;color:var(--muted,#7a8ba8);background:var(--surface,#141b2d);border:1px solid var(--border,#1e2a45);border-radius:8px;padding:8px 10px}
.bzlk-budget-wrap{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.bzlk-budget-label{font-size:13px;font-weight:600;color:var(--text,#e0e6f0)}
.bzlk-budget-bar{flex:1;height:14px;background:var(--surface,#141b2d);border:1px solid var(--border,#1e2a45);border-radius:7px;overflow:hidden;min-width:100px}
.bzlk-budget-fill{height:100%;background:#22c55e;border-radius:7px;transition:width .3s}
.bzlk-budget-fill.bzlk-over-budget{background:#ef4444}
.bzlk-budget-text{font-size:12px;color:var(--muted,#7a8ba8);white-space:nowrap}
.bzlk-savings{font-size:11px;color:#22c55e;text-align:center}
.bzlk-over-budget-text{color:#ef4444}
.bzlk-section-label{font-size:11px;color:var(--muted,#7a8ba8);text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;width:100%}
.bzlk-quests{display:flex;flex-wrap:wrap;gap:8px}
.bzlk-quest{padding:7px 12px;background:var(--surface,#141b2d);border:1px solid #5c4a2a;border-radius:8px;font-size:12px;font-weight:600;color:#d4a853;cursor:pointer;user-select:none;-webkit-user-select:none;transition:all .2s}
.bzlk-quest.bzlk-quest-selected{border-color:var(--accent,#3b82f6);background:#1a2a4e;box-shadow:0 0 8px rgba(59,130,246,.3)}
.bzlk-quest.bzlk-placed{opacity:.25;pointer-events:none}
.bzlk-stalls{display:flex;flex-wrap:wrap;gap:8px;justify-content:center}
.bzlk-stall{flex:1;min-width:100px;max-width:140px;padding:10px 8px;background:var(--surface,#141b2d);border:2px dashed var(--border,#1e2a45);border-radius:10px;text-align:center;cursor:pointer;transition:all .2s}
.bzlk-stall.bzlk-over{border-color:var(--accent,#3b82f6);box-shadow:0 0 10px rgba(59,130,246,.2)}
.bzlk-stall.bzlk-correct{border-color:#22c55e;border-style:solid}
.bzlk-stall.bzlk-wrong{animation:bzlk-sh .4s;border-color:#ef4444}
@keyframes bzlk-sh{25%{transform:translateX(-4px)}75%{transform:translateX(4px)}}
.bzlk-stall-icon{font-size:28px;margin-bottom:4px}
.bzlk-stall-name{font-size:12px;font-weight:700;color:var(--text,#e0e6f0)}
.bzlk-stall-spec{font-size:10px;color:var(--muted,#7a8ba8);margin-bottom:2px}
.bzlk-stall-cost{font-size:11px;color:#d4a853;font-weight:600}
.bzlk-stall-assigned{margin-top:6px;min-height:20px}
.bzlk-assigned-quest{font-size:10px;color:#d4a853;padding:3px 0}
.bzlk-btn{padding:12px 28px;border:none;border-radius:8px;background:var(--accent,#3b82f6);color:#fff;font-size:14px;font-weight:600;cursor:pointer;align-self:center}
.bzlk-btn:active{opacity:.7}
.bzlk-rewards{display:flex;flex-direction:column;gap:6px}
.bzlk-rewards-title{font-size:13px;font-weight:700;color:var(--text,#e0e6f0);text-align:center}
.bzlk-reward-row{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:6px;background:var(--surface,#141b2d);border:1px solid var(--border,#1e2a45)}
.bzlk-tier-gold{border-color:#d4a853;background:rgba(212,168,83,.08)}
.bzlk-tier-silver{border-color:#94a3b8;background:rgba(148,163,184,.08)}
.bzlk-tier-bronze{border-color:#b45309;background:rgba(180,83,9,.08)}
.bzlk-reward-tier{font-size:18px}
.bzlk-reward-item{font-size:13px;font-weight:700;color:var(--text,#e0e6f0)}
.bzlk-reward-msg{font-size:11px;color:var(--muted,#7a8ba8);margin-left:auto}
.bzlk-reward-effect{font-size:10px;padding:0 10px 4px 36px;font-style:italic}
.bzlk-tier-gold-text{color:#d4a853}
.bzlk-tier-silver-text{color:#94a3b8}
.bzlk-tier-bronze-text{color:#b45309}
.bzlk-reward-gold{text-align:center;font-size:13px;font-weight:600;color:#22c55e;margin-top:4px}
.bzlk-status{font-size:13px;color:var(--muted,#7a8ba8);text-align:center;min-height:18px}
`;
    document.head.appendChild(s);
  }
}
