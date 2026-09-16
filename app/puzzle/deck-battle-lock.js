/**
 * Deck Battle Lock Puzzle (STS-inspired Persuasion Battle)
 *
 * Play cards (Persuasion/Composure) against a merchant with rotating intents.
 * Draw 4, play 2 per turn. Merchant cycles attack/block pattern.
 * Win by filling conviction meter. Lose if gold (HP) hits 0.
 *
 * Usage:
 *   new DeckBattleLock(containerEl, {
 *     merchant: { name: '🧔 Spice Trader', conviction: 8,
 *       pattern: [{ attack: 2, block: 0, text: '"Greetings"' }, ...] },
 *     startingDeck: [{ id, name, type: 'persuasion'|'composure'|'both', value }],
 *     gold: 80,
 *     onSubmit() { },
 *     onWalkAway() { }
 *   });
 */

class DeckBattleLock {
  constructor(container, opts = {}) {
    this.container = container;
    this.merchant = opts.merchant || { name: '🧔 Merchant', conviction: 8, pattern: [{ attack: 3, block: 1, text: '"..."' }] };
    this.startingDeck = opts.startingDeck || [];
    this.startGold = opts.gold || 80;
    this.onSubmit = opts.onSubmit || (() => {});
    this.onWalkAway = opts.onWalkAway || (() => {});
    // Fires once when the purse empties, so the host can charge for the failure.
    // Retry re-arms it, since a retried battle can go bankrupt again.
    this.onLose = opts.onLose || (() => {});
    this._init();
  }

  _init() {
    this.gold = this.startGold;
    this.conviction = 0;
    this.turn = 1;
    this.played = [];
    this.lastResult = null;
    this.gameOver = false;
    this.drawPile = this._shuffle([...this.startingDeck]);
    this.discardPile = [];
    this.hand = [];
    this._drawHand();
    this._render();
  }

  _shuffle(arr) { for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }

  _drawHand() {
    this.hand = [];
    this.played = [];
    for (let i = 0; i < 4; i++) {
      if (this.drawPile.length === 0) { this.drawPile = this._shuffle([...this.discardPile]); this.discardPile = []; }
      if (this.drawPile.length > 0) this.hand.push(this.drawPile.pop());
    }
  }

  _getIntent() { return this.merchant.pattern[(this.turn - 1) % this.merchant.pattern.length]; }

  // `_endTurn` empties the hand before the win/bankrupt render, while `played`
  // still holds its indices — so both of these must tolerate a missing card.
  _persuasionFromPlayed() { return this.played.reduce((s, i) => { const c = this.hand[i]; return s + (c && (c.type === 'persuasion' || c.type === 'both') ? c.value : 0); }, 0); }
  _composureFromPlayed() { return this.played.reduce((s, i) => { const c = this.hand[i]; return s + (c && (c.type === 'composure' || c.type === 'both') ? c.value : 0); }, 0); }

  _endTurn() {
    const intent = this._getIntent();
    const persuasion = this._persuasionFromPlayed();

    const convGain = Math.max(0, persuasion - intent.block);
    this.conviction = Math.min(this.merchant.conviction, this.conviction + convGain);
    const goldLoss = Math.max(0, intent.attack - this._composureFromPlayed());
    this.gold -= goldLoss;
    this.lastResult = { convGain, goldLoss };

    this.hand.forEach(c => this.discardPile.push(c));
    this.hand = [];

    if (this.conviction >= this.merchant.conviction) {
      this.gameOver = true;
      this._render();
      // Long enough to read the win banner before the host closes the whole popup.
      setTimeout(() => this.onSubmit(true), 2200);
      return;
    }
    if (this.gold <= 0) {
      this.gold = 0;
      this.gameOver = true;
      this._render();
      this.onLose({ spent: this.startGold, bankrupt: true });
      return;
    }

    this.turn++;
    this._drawHand();
    this._render();
  }

  _playCard(i) {
    if (this.gameOver) return;
    if (this.played.includes(i)) { this.played = this.played.filter(p => p !== i); this._render(); return; }
    // Selecting a 3rd card swaps out the oldest pick instead of no-op'ing,
    // so tapping a different card always feels responsive.
    if (this.played.length >= 2) this.played.shift();
    this.played.push(i);
    this._render();
  }

  _walkAway() { this.gameOver = true; this._render(); this.onWalkAway(); }

  /** Add cards to deck externally (quest rewards) */
  addCards(cards) { cards.forEach(c => this.startingDeck.push(c)); }

  reset() { this._init(); }

  _render() {
    this.container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'dblk';

    // How-to-play legend (always visible — not gated behind the hint system)
    if (!this.gameOver) {
      const legend = document.createElement('div');
      legend.className = 'dblk-legend';
      legend.innerHTML = `Play up to 2 cards, then <strong>End Turn</strong>. 🗣️ Persuasion fills their trust meter · 🛡️ Composure blocks the gold they take this turn.`;
      wrap.appendChild(legend);
    }

    // Stats bar
    const composureNow = this._composureFromPlayed();
    const stats = document.createElement('div');
    stats.className = 'dblk-stats';
    stats.innerHTML = `<span class="dblk-stat">💰 Gold <strong style="color:${this.gold<=15?'#6d211b':'#54370b'}">${this.gold}g</strong></span>
      <span class="dblk-stat">💬 Trust <strong>${this.conviction}/${this.merchant.conviction}</strong></span>
      <span class="dblk-stat">🛡️ Composure <strong>${composureNow}</strong></span>
      <span class="dblk-stat">Turn <strong>${this.turn}</strong></span>`;
    wrap.appendChild(stats);

    // Conviction bar
    const pct = (this.conviction / this.merchant.conviction) * 100;
    const barWrap = document.createElement('div');
    barWrap.className = 'dblk-bar-wrap';
    barWrap.innerHTML = `<div class="dblk-bar" style="width:${pct}%"></div>`;
    wrap.appendChild(barWrap);

    if (!this.gameOver) {
      // Last turn's outcome — emphasize gold lost, it's the thing that ends the negotiation
      if (this.lastResult) {
        const { convGain, goldLoss } = this.lastResult;
        const resEl = document.createElement('div');
        resEl.className = 'dblk-last' + (goldLoss > 0 ? ' dblk-last-hit' : '');
        resEl.innerHTML = `<span class="dblk-last-label">Turn ${this.turn - 1} result:</span> ${goldLoss > 0 ? `<span class="dblk-dmg">⚔️ −${goldLoss}g taken</span>` : `<span class="dblk-safe">🛡️ fully blocked — no gold lost</span>`}${convGain > 0 ? ` · <span class="dblk-gain">+${convGain} trust</span>` : ''}`;
        wrap.appendChild(resEl);
      }

      // Merchant intent
      const intent = this._getIntent();
      const prevP = this._persuasionFromPlayed();
      const predictedLoss = Math.max(0, intent.attack - composureNow);
      const mEl = document.createElement('div');
      mEl.className = 'dblk-merchant';
      mEl.innerHTML = `<div class="dblk-m-row"><span style="font-size:1.5rem;">${this.merchant.name.slice(0, 2)}</span>
        <div class="dblk-m-info"><strong>${this.merchant.name}</strong><br><span class="dblk-m-text">${intent.text}</span></div>
        <div class="dblk-m-intents"><div style="color:#6d211b">⚔️ Takes ${intent.attack}g</div><div style="color:#4c3060">🛡️ Blocks ${intent.block}</div></div></div>
        ${this.played.length > 0
          ? `<div class="dblk-preview">If you End Turn now: 🗣️${prevP} − 🛡️${intent.block} = <span style="color:#2c4326">+${Math.max(0, prevP - intent.block)} trust</span></div>
             <div class="dblk-dmg-pill${predictedLoss > 0 ? ' dblk-dmg-pill-hot' : ''}">${predictedLoss > 0 ? `⚠️ You will take −${predictedLoss}g` : '🛡️ Fully blocked — 0g lost'}</div>`
          : `<div class="dblk-preview dblk-preview-empty">Tap up to 2 cards below to plan this turn.</div>
             <div class="dblk-dmg-pill${intent.attack - composureNow > 0 ? ' dblk-dmg-pill-hot' : ''}">${intent.attack - composureNow > 0 ? `⚠️ Unblocked, you'll take −${intent.attack - composureNow}g` : '🛡️ Fully blocked — 0g lost'}</div>`}`;
      wrap.appendChild(mEl);

      // Hand
      const handEl = document.createElement('div');
      handEl.className = 'dblk-hand';
      this.hand.forEach((c, i) => {
        const isPlayed = this.played.includes(i);
        const typeLabel = c.type === 'both' ? 'Persuasion + Composure' : c.type === 'persuasion' ? 'Persuasion' : 'Composure';
        const color = c.type === 'persuasion' ? '#2c4326' : c.type === 'composure' ? '#4c3060' : '#54370b';
        const card = document.createElement('div');
        card.className = 'dblk-card' + (isPlayed ? ' dblk-played' : '');
        card.style.borderColor = color;
        card.title = isPlayed ? 'Tap to take this card back' : typeLabel;
        card.innerHTML = `${isPlayed ? '<div class="dblk-card-tag">PLAYED · tap to undo</div>' : ''}<div class="dblk-card-name">${c.name}</div><div class="dblk-card-type">${typeLabel}</div><div class="dblk-card-val" style="color:${color}">${c.type === 'both' ? '🗣️+🛡️ ' + c.value : (c.type === 'persuasion' ? '🗣️ ' : '🛡️ ') + c.value}</div>`;
        card.addEventListener('click', () => this._playCard(i));
        handEl.appendChild(card);
      });
      wrap.appendChild(handEl);

      // Actions
      const bar = document.createElement('div');
      bar.className = 'dblk-actions';
      const endBtn = document.createElement('button');
      endBtn.className = 'dblk-btn';
      endBtn.textContent = this.played.length >= 2 ? '⚡ End Turn' : `⏭️ End Turn (${this.played.length}/2)`;
      endBtn.addEventListener('click', () => this._endTurn());
      bar.appendChild(endBtn);
      const walkBtn = document.createElement('button');
      walkBtn.className = 'dblk-btn-sec';
      walkBtn.textContent = '🚪 Walk Away';
      walkBtn.addEventListener('click', () => this._walkAway());
      bar.appendChild(walkBtn);
      wrap.appendChild(bar);
    } else {
      // Result
      const res = document.createElement('div');
      res.className = 'dblk-result';
      const won = this.conviction >= this.merchant.conviction;
      if (won) {
        res.innerHTML = `<div class="dblk-win">✅ Convinced! Trade secured. Gold remaining: ${this.gold}g</div>`;
      } else if (this.gold <= 0) {
        res.innerHTML = `<div class="dblk-lose">❌ Bankrupt! The merchants took everything.</div>`;
      } else {
        res.innerHTML = `<div class="dblk-walk">🚪 You bow and leave. Come back with a stronger deck.</div>`;
      }
      // Retry would let the player restart a puzzle that's already about to close
      // and hand its reward — the win path is on its way out, not replayable.
      if (!won) {
        const retry = document.createElement('button');
        retry.className = 'dblk-btn-sec';
        retry.textContent = '↻ Retry';
        retry.addEventListener('click', () => this.reset());
        res.appendChild(retry);
      }
      wrap.appendChild(res);
    }

    this.container.appendChild(wrap);
    this._injectStyles();
  }

  _injectStyles() {
    if (document.getElementById('dblk-css')) return;
    const s = document.createElement('style'); s.id = 'dblk-css';
    s.textContent = `
.dblk{display:flex;flex-direction:column;gap:10px;padding:16px 0;max-width:420px;margin:0 auto}
.dblk-legend{font-size:12px;line-height:1.5;color:var(--muted,#7a8ba8);background:var(--surface,#141b2d);border:1px solid var(--border,#1e2a45);border-radius:8px;padding:8px 10px}
.dblk-legend strong{color:var(--text,#e0e6f0)}
.dblk-stats{display:flex;justify-content:space-between;font-size:12px;color:var(--muted,#7a8ba8)}
.dblk-stat strong{color:var(--text,#e0e6f0)}
.dblk-bar-wrap{height:6px;background:var(--surface,#141b2d);border-radius:3px;overflow:hidden}
.dblk-bar{height:100%;background:var(--green,#22c55e);transition:width .3s}
.dblk-merchant{background:var(--surface,#141b2d);border:1px solid var(--border,#1e2a45);border-radius:8px;padding:10px}
.dblk-m-row{display:flex;align-items:center;gap:8px}
.dblk-m-info{flex:1;font-size:12px;color:var(--text,#e0e6f0)}
.dblk-m-info strong{font-size:13px}
.dblk-m-text{color:var(--muted,#7a8ba8);font-style:italic}
.dblk-m-intents{text-align:right;font-size:12px;font-weight:600}
.dblk-preview{margin-top:8px;padding:6px 8px;background:var(--bg,#0a0e17);border-radius:4px;font-size:11px;color:var(--muted,#7a8ba8)}
.dblk-preview-empty{font-style:italic}
.dblk-dmg-pill{margin-top:6px;padding:8px 10px;border-radius:6px;font-size:13px;font-weight:700;text-align:center;background:#f0e6d4;color:#453724;border:1px solid var(--border,#1e2a45)}
.dblk-dmg-pill-hot{background:#e9c9b8;color:#6d211b;border-color:#6d211b}
.dblk-last{font-size:12px;padding:6px 10px;border-radius:6px;background:var(--surface,#141b2d);border:1px solid var(--border,#1e2a45);color:var(--muted,#7a8ba8)}
.dblk-last-hit{background:#e9c9b8;border-color:#6d211b}
.dblk-last-label{font-weight:600;color:var(--text,#e0e6f0)}
.dblk-dmg{color:#6d211b;font-weight:700}
.dblk-safe{color:#2c4326;font-weight:700}
.dblk-gain{color:#2c4326;font-weight:700}
.dblk-hand{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.dblk-card{position:relative;padding:10px 6px;background:var(--bg,#0a0e17);border:2px solid var(--border,#1e2a45);border-radius:8px;cursor:pointer;transition:all .15s;text-align:center}
.dblk-card:active{transform:scale(.95)}
.dblk-card.dblk-played{background:var(--surface,#141b2d)}
.dblk-card-tag{position:absolute;top:-8px;left:50%;transform:translateX(-50%);background:var(--accent,#3b82f6);color:#fff;font-size:9px;font-weight:700;letter-spacing:.3px;padding:2px 6px;border-radius:99px;white-space:nowrap}
.dblk-card-name{font-size:11px;font-weight:600;color:var(--text,#e0e6f0);white-space:normal;line-height:1.25;margin-top:4px}
.dblk-card-type{font-size:9px;color:var(--muted,#7a8ba8);text-transform:uppercase;letter-spacing:.3px;margin-top:2px}
.dblk-card-val{font-size:12px;font-weight:700;margin-top:4px}
.dblk-actions{display:flex;gap:8px;justify-content:center}
.dblk-btn,.dblk-btn-sec{padding:10px 16px;border:none;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer}
.dblk-btn{background:var(--accent,#3b82f6);color:#fff}
.dblk-btn-sec{background:var(--surface,#141b2d);border:1px solid var(--border,#1e2a45);color:var(--muted,#7a8ba8)}
.dblk-result{text-align:center;padding:16px}
.dblk-win{color:var(--green,#22c55e);font-weight:600;margin-bottom:8px}
.dblk-lose{color:var(--red,#e74c3c);font-weight:600;margin-bottom:8px}
.dblk-walk{color:var(--muted,#7a8ba8);font-style:italic;margin-bottom:8px}
`;
    document.head.appendChild(s);
  }
}
