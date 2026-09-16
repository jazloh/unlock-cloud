/**
 * Equipment Rack Lock Puzzle (Balatro Blind-Build)
 *
 * Champion assembly as a blind equipment rack. Players arrange, enable/disable
 * gear slots without seeing stats. Effects upgrade from penalties to bonuses
 * as quests are completed. Deploy on cooldown for tier impressions.
 *
 * Usage:
 *   new EquipmentRackLock(containerEl, {
 *     slots: [
 *       { id: 'weapon', base: { name: '🗡️ Wooden Stick', effect: 2, type: 'flat' },
 *         upgraded: { name: '🐉 Dragon Lance', effect: 2, type: 'mult' },
 *         quest: 'bazaar-recruit' },
 *     ],
 *     upgradedQuests: ['bazaar-recruit'],  // quests already completed
 *     observability: false,                // true = show score numbers
 *     cooldown: 30,                        // seconds between deploys
 *     tiers: [
 *       { min: 100, icon: '🦅', label: 'Soars', text: '...' },
 *       ...
 *     ],
 *     target: 'strides',                   // tier label needed to pass
 *     onSubmit(tier) { },                  // called when target tier reached
 *     onDeploy(tier) { }                   // called on every deploy
 *   });
 */

class EquipmentRackLock {
  constructor(container, opts = {}) {
    this.container = container;
    this.slots = (opts.slots || []).map(s => ({ ...s, enabled: true }));
    this.upgradedQuests = new Set(opts.upgradedQuests || []);
    this.observability = opts.observability || false;
    this.cooldownTime = opts.cooldown || 30;
    this.onSubmit = opts.onSubmit || (() => {});
    this.onDeploy = opts.onDeploy || (() => {});
    this.target = opts.target || 'strides';
    this.tiers = opts.tiers || [
      { min: 100, icon: '🦅', label: 'Soars', text: 'The Champion blazes through every task. Sir Cedric actually smiles.' },
      { min: 65, icon: '🏃', label: 'Strides', text: 'The Champion moves with purpose. Sir Cedric nods.' },
      { min: 30, icon: '🚶', label: 'Walks', text: 'The Champion moves steadily. Adequate, but uninspired.' },
      { min: 10, icon: '🦵', label: 'Stumbles', text: 'The Champion lurches forward, barely functional.' },
      { min: 0, icon: '💀', label: 'Collapses', text: 'The Champion takes one step and crumbles to dust.' },
    ];
    this.order = this.slots.map((_, i) => i);
    this.cooldown = 0;
    this.lastTier = null;
    this._selectedPos = null;
    this._render();
  }

  _getItem(slot) {
    return this.upgradedQuests.has(slot.quest) ? slot.upgraded : slot.base;
  }

  _applyEffect(score, item) {
    if (item.type === 'flat') return score + item.effect;
    if (item.type === 'mult') return Math.floor(score * item.effect);
    if (item.type === 'neg') return score - item.effect;
    if (item.type === 'div') return Math.floor(score / item.effect);
    return score;
  }

  _calcScore() {
    let s = 10;
    this.order.forEach(i => {
      if (this.slots[i].enabled) s = this._applyEffect(s, this._getItem(this.slots[i]));
    });
    return Math.max(0, s);
  }

  _getTier(score) {
    for (const t of this.tiers) { if (score >= t.min) return t; }
    return this.tiers[this.tiers.length - 1];
  }

  /**
   * The target tier is a floor, not an exact match — a deploy that lands ABOVE
   * it still passes. Overshooting used to silently fail: a fully upgraded rack
   * arranged for maximum score reaches the top tier, which never equalled a
   * mid-tier `target`, so the puzzle could not be completed by playing well.
   */
  _meetsTarget(tier) {
    const want = this.tiers.find(t => t.label.toLowerCase() === this.target.toLowerCase());
    if (!want) return tier.label.toLowerCase() === this.target.toLowerCase();
    return tier.min >= want.min;
  }

  _render() {
    this.container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'eqrk';

    const title = document.createElement('div');
    title.className = 'eqrk-title';
    title.textContent = "Champion's Equipment Rack";
    wrap.appendChild(title);

    const legend = document.createElement('div');
    legend.className = 'eqrk-legend';
    legend.textContent = 'Drag a slot to reorder it, or tap one then tap another to swap positions. Toggle ON/OFF to enable or disable a slot.';
    wrap.appendChild(legend);

    // Status bar
    this.statusEl = document.createElement('div');
    this.statusEl.className = 'eqrk-status';
    wrap.appendChild(this.statusEl);

    // Slots
    this.slotsEl = document.createElement('div');
    this.slotsEl.className = 'eqrk-slots';
    wrap.appendChild(this.slotsEl);

    // Buttons
    const bar = document.createElement('div');
    bar.className = 'eqrk-bar';
    this.deployBtn = document.createElement('button');
    this.deployBtn.className = 'eqrk-btn';
    this.deployBtn.textContent = '⚡ Deploy Champion';
    this.deployBtn.addEventListener('click', () => this._deploy());
    bar.appendChild(this.deployBtn);
    const resetBtn = document.createElement('button');
    resetBtn.className = 'eqrk-btn-sec';
    resetBtn.textContent = '↻ Reset';
    resetBtn.addEventListener('click', () => this._reset());
    bar.appendChild(resetBtn);
    wrap.appendChild(bar);

    // Result
    this.resultEl = document.createElement('div');
    this.resultEl.className = 'eqrk-result';
    wrap.appendChild(this.resultEl);

    this.container.appendChild(wrap);
    this._injectStyles();
    this._updateView();
  }

  _updateView() {
    // Status
    const cd = this.cooldown > 0 ? `⏳ ${this.cooldown}s` : '✅ Ready';
    const imp = this.lastTier ? `${this.lastTier.icon} ${this.lastTier.label}` : '—';
    this.statusEl.innerHTML = `<span class="eqrk-stat">Deploy: ${cd}</span><span class="eqrk-stat">Last: ${imp}</span>`;
    this.deployBtn.disabled = this.cooldown > 0;
    this.deployBtn.style.opacity = this.cooldown > 0 ? '0.5' : '1';

    // Slots
    this.slotsEl.innerHTML = '';
    this.order.forEach((idx, pos) => {
      const slot = this.slots[idx];
      const item = this._getItem(slot);
      const enabled = slot.enabled;

      const row = document.createElement('div');
      row.className = 'eqrk-row' + (enabled ? '' : ' eqrk-disabled') + (this._selectedPos === pos ? ' eqrk-selected' : '');
      row.draggable = true;
      row.dataset.pos = pos;

      row.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', pos); });
      row.addEventListener('dragover', e => e.preventDefault());
      row.addEventListener('drop', e => {
        e.preventDefault();
        const from = parseInt(e.dataTransfer.getData('text/plain'));
        const to = pos;
        if (from !== to) { const item = this.order.splice(from, 1)[0]; this.order.splice(to, 0, item); this._selectedPos = null; this._updateView(); }
      });

      // Tap-to-swap for mobile
      row.addEventListener('click', e => {
        if (e.target.closest('.eqrk-toggle')) return; // don't interfere with ON/OFF button
        if (this._selectedPos === null) {
          this._selectedPos = pos;
        } else if (this._selectedPos === pos) {
          this._selectedPos = null;
        } else {
          const from = this._selectedPos;
          const item = this.order.splice(from, 1)[0];
          this.order.splice(pos, 0, item);
          this._selectedPos = null;
        }
        this._updateView();
      });

      // Effect display
      let effectStr = '???';
      if (this.observability) {
        if (item.type === 'flat') effectStr = '+' + item.effect;
        else if (item.type === 'mult') effectStr = '×' + item.effect;
        else if (item.type === 'neg') effectStr = '−' + item.effect;
        else if (item.type === 'div') effectStr = '÷' + item.effect;
      }

      row.innerHTML = `<span class="eqrk-pos">${pos + 1}</span>
        <span class="eqrk-name">${item.name}</span>
        <span class="eqrk-effect">${effectStr}</span>`;

      const toggle = document.createElement('button');
      toggle.className = 'eqrk-toggle' + (enabled ? ' eqrk-on' : '');
      toggle.textContent = enabled ? 'ON' : 'OFF';
      toggle.addEventListener('click', e => { e.stopPropagation(); slot.enabled = !slot.enabled; this._updateView(); });
      row.appendChild(toggle);

      this.slotsEl.appendChild(row);
    });
  }

  _deploy() {
    if (this.cooldown > 0) return;
    const score = this._calcScore();
    const tier = this._getTier(score);
    this.lastTier = tier;

    let html = `<span class="eqrk-tier">${tier.icon} ${tier.text}</span>`;
    if (this.observability) html += `<span class="eqrk-score">Score: ${score}</span>`;
    this.resultEl.innerHTML = html;
    this.resultEl.className = 'eqrk-result eqrk-show';

    this.onDeploy(tier);
    if (this._meetsTarget(tier)) {
      setTimeout(() => this.onSubmit(tier), 600);
    }

    // Cooldown
    this.cooldown = this.cooldownTime;
    this._updateView();
    this._tick = setInterval(() => {
      this.cooldown--;
      if (this.cooldown <= 0) { clearInterval(this._tick); }
      this._updateView();
    }, 1000);
  }

  _reset() {
    this.order = this.slots.map((_, i) => i);
    this.slots.forEach(s => { s.enabled = true; });
    this.resultEl.innerHTML = '';
    this.resultEl.className = 'eqrk-result';
    this._updateView();
  }

  /** Call externally when a quest is completed to upgrade a slot */
  upgradeSlot(questId) {
    this.upgradedQuests.add(questId);
    this._updateView();
  }

  /** Call externally to enable observability */
  enableObservability() {
    this.observability = true;
    this._updateView();
  }

  _injectStyles() {
    if (document.getElementById('eqrk-css')) return;
    const s = document.createElement('style'); s.id = 'eqrk-css';
    s.textContent = `
.eqrk{display:flex;flex-direction:column;gap:12px;padding:16px 0;max-width:420px;margin:0 auto}
.eqrk-title{font-size:13px;color:var(--muted,#7a8ba8);font-weight:600;text-align:center;text-transform:uppercase;letter-spacing:1px}
.eqrk-legend{font-size:12px;line-height:1.5;color:var(--muted,#7a8ba8);background:var(--surface,#141b2d);border:1px solid var(--border,#1e2a45);border-radius:8px;padding:8px 10px}
.eqrk-status{display:flex;justify-content:space-between;padding:8px 12px;background:var(--surface,#141b2d);border-radius:6px;font-size:12px;color:var(--muted,#7a8ba8)}
.eqrk-stat{display:flex;align-items:center;gap:4px}
.eqrk-slots{display:flex;flex-direction:column;gap:6px}
.eqrk-row{display:flex;align-items:center;gap:8px;padding:10px 12px;background:var(--surface,#141b2d);border:1px solid var(--border,#1e2a45);border-radius:8px;cursor:grab;transition:all .15s}
.eqrk-row:active{cursor:grabbing;transform:scale(.98)}
.eqrk-row.eqrk-disabled{opacity:.4;border-style:dashed}
.eqrk-row.eqrk-selected{border-color:var(--accent,#3b82f6);background:#1a2a4e;box-shadow:0 0 8px rgba(59,130,246,.3)}
.eqrk-row.eqrk-selected .eqrk-name{color:#e0e6f0}
.eqrk-row.eqrk-selected .eqrk-pos,.eqrk-row.eqrk-selected .eqrk-effect{color:#7a8ba8}
.eqrk-pos{font-size:11px;color:var(--muted,#7a8ba8);min-width:16px}
.eqrk-name{flex:1;font-size:13px;font-weight:500;color:var(--text,#e0e6f0)}
.eqrk-effect{font-size:12px;font-weight:700;color:var(--muted,#7a8ba8);min-width:36px;text-align:center}
.eqrk-toggle{padding:4px 8px;border:1px solid var(--border,#1e2a45);border-radius:4px;font-size:11px;font-weight:600;cursor:pointer;background:var(--bg,#0a0e17);color:var(--muted,#7a8ba8);transition:all .15s}
.eqrk-toggle.eqrk-on{border-color:var(--green,#22c55e);color:var(--green,#22c55e)}
.eqrk-bar{display:flex;gap:8px;justify-content:center}
.eqrk-btn,.eqrk-btn-sec{padding:10px 20px;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;transition:all .15s}
.eqrk-btn{background:var(--accent,#3b82f6);color:#fff}
.eqrk-btn:disabled{cursor:not-allowed}
.eqrk-btn-sec{background:var(--surface,#141b2d);border:1px solid var(--border,#1e2a45);color:var(--muted,#7a8ba8)}
.eqrk-result{text-align:center;min-height:20px;transition:all .3s;opacity:0}
.eqrk-result.eqrk-show{opacity:1}
.eqrk-tier{display:block;font-size:13px;font-style:italic;color:var(--text,#e0e6f0)}
.eqrk-score{display:block;font-size:11px;color:var(--muted,#7a8ba8);margin-top:4px}
`;
    document.head.appendChild(s);
  }
}
