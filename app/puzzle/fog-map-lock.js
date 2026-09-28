/**
 * Fog Map Lock Puzzle
 *
 * A grid covered in fog. Player spends energy to reveal tiles.
 * Some tiles contain intel (needed to unlock), some are traps (lose energy),
 * some have bonus energy, and one is the exit. Must reach the exit
 * with enough intel collected.
 *
 * Inspired by FTL sector maps / Betrayal at House on the Hill exploration.
 *
 * Usage:
 *   new FogMapLock(containerEl, {
 *     cols: 5,
 *     rows: 5,
 *     energy: 8,
 *     intelNeeded: 3,
 *     tiles: [
 *       { x: 0, y: 0, type: 'start' },
 *       { x: 2, y: 1, type: 'intel', label: '🔑 Keycard' },
 *       { x: 3, y: 2, type: 'trap', label: '⚡ Alarm', cost: 2 },
 *       { x: 4, y: 4, type: 'exit' },
 *       ...
 *     ],
 *     onSubmit(correct) { ... }
 *   });
 *
 * Energy Balance Guide:
 *   Formula: energy = floor(totalTiles × 0.45) + totalTrapCost × 0.3 - totalBonusGain × 0.5
 *   This gives ~45% exploration budget, partially offset by traps/bonuses.
 *
 *   | Grid   | Tiles | Suggested Energy | Feels like         |
 *   |--------|-------|------------------|--------------------|
 *   | 4×4    | 16    |  6–8             | Tight, fast        |
 *   | 5×5    | 25    |  9–12            | Standard           |
 *   | 6×6    | 36    | 13–16            | Moderate           |
 *   | 7×7    | 49    | 18–22            | Sprawling          |
 *   | 9×5    | 45    | 16–20            | Wide corridor      |
 *   | 9×7    | 63    | 22–28            | Large exploration  |
 *
 *   Tips for challenge:
 *   - Player should NOT be able to reveal all tiles (cap at ~50%)
 *   - Place intel so that at least 2 possible paths exist
 *   - Traps near intel make "greedy" paths risky
 *   - Bonuses on dead-end detours reward exploration but cost a reveal
 *   - intelNeeded should be (totalIntel - 1) so one can be skipped
 */

class FogMapLock {
  constructor(container, opts = {}) {
    this.container = container;
    this.cols = opts.cols || 5;
    this.rows = opts.rows || 5;
    this.startEnergy = opts.energy || 8;
    this.intelNeeded = opts.intelNeeded || 3;
    this.tiles = opts.tiles || [];
    this.onSubmit = opts.onSubmit || (() => {});

    this._buildGrid();
    this._init();
  }

  _buildGrid() {
    this.grid = {};
    this.tiles.forEach(t => {
      this.grid[`${t.x},${t.y}`] = { ...t, revealed: t.type === 'start' };
    });
    // Fill remaining cells as empty
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const key = `${x},${y}`;
        if (!this.grid[key]) this.grid[key] = { x, y, type: 'empty', revealed: false };
      }
    }
  }

  _init() {
    this.energy = this.startEnergy;
    this.intel = 0;
    this.revealed = new Set();
    this.won = false;
    this.failed = false;
    this.lastReveal = null;
    this.message = null;

    // Reveal start tile
    this.tiles.filter(t => t.type === 'start').forEach(t => {
      this.revealed.add(`${t.x},${t.y}`);
    });

    this._render();
  }

  _reveal(x, y) {
    if (this.won || this.failed) return;
    const key = `${x},${y}`;
    const existing = this.grid[key];

    if (this.revealed.has(key)) {
      if (existing.type === 'exit') this._tryExit(existing);
      return;
    }
    if (this.energy <= 0) return;

    // Must be adjacent to a revealed tile
    if (!this._isAdjacent(x, y)) {
      this.message = { text: 'Must reveal adjacent to explored tiles', type: 'warn' };
      this._render();
      return;
    }

    this.energy--;
    this.revealed.add(key);
    const tile = this.grid[key];
    this.lastReveal = tile;

    switch (tile.type) {
      case 'intel':
        this.intel++;
        this.message = { text: `${tile.label || 'Intel'} found! (${this.intel}/${this.intelNeeded})`, type: 'good' };
        break;
      case 'trap':
        const cost = tile.cost || 1;
        this.energy = Math.max(0, this.energy - cost);
        this.message = { text: `${tile.label || 'Trap!'} −${cost} energy`, type: 'bad' };
        break;
      case 'bonus':
        const gain = tile.gain || 2;
        this.energy += gain;
        this.message = { text: `${tile.label || 'Bonus!'} +${gain} energy`, type: 'good' };
        break;
      case 'exit':
        this._tryExit(tile);
        break;
      default:
        this.message = { text: 'Nothing here.', type: 'neutral' };
    }

    if (this.energy <= 0 && !this.won) {
      this.failed = true;
      this.message = { text: 'Out of energy! Mission failed.', type: 'bad' };
    }

    this._render();
  }

  _tryExit(tile) {
    if (this.intel >= this.intelNeeded) {
      this.won = true;
      this.message = { text: 'Exit reached! Mission complete.', type: 'win' };
      setTimeout(() => this.onSubmit(true), 600);
    } else {
      this.message = { text: `Exit found but need ${this.intelNeeded - this.intel} more intel`, type: 'warn' };
    }
  }

  _isAdjacent(x, y) {
    const dirs = [[0, 1], [0, -1], [1, 0], [-1, 0]];
    return dirs.some(([dx, dy]) => this.revealed.has(`${x + dx},${y + dy}`));
  }

  reset() {
    this._buildGrid();
    this._init();
  }

  _render() {
    this.container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'fmlk';

    // Status bar
    const status = document.createElement('div');
    status.className = 'fmlk-status';
    status.innerHTML = `
      <span class="fmlk-energy">⚡ ${this.energy}</span>
      <span class="fmlk-intel">🔑 ${this.intel}/${this.intelNeeded}</span>
      <span class="fmlk-legend">Tap fog to explore</span>`;
    wrap.appendChild(status);

    // Grid
    const grid = document.createElement('div');
    grid.className = 'fmlk-grid';
    grid.style.setProperty('--fmlk-cols', this.cols);
    grid.style.gridTemplateColumns = `repeat(${this.cols}, auto)`;

    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const key = `${x},${y}`;
        const tile = this.grid[key];
        const isRevealed = this.revealed.has(key);
        const isAdj = !isRevealed && this._isAdjacent(x, y);

        const cell = document.createElement('div');
        cell.className = 'fmlk-cell';

        if (isRevealed) {
          cell.classList.add('fmlk-revealed');
          cell.classList.add(`fmlk-type-${tile.type}`);
          cell.innerHTML = this._getTileIcon(tile);
          if (this.lastReveal === tile) cell.classList.add('fmlk-just-revealed');
          if (tile.type === 'exit' && !this.won && !this.failed) {
            cell.classList.add('fmlk-explorable');
            cell.addEventListener('click', () => this._reveal(x, y));
          }
        } else {
          cell.classList.add('fmlk-fog');
          if (isAdj && this.energy > 0 && !this.won && !this.failed) {
            cell.classList.add('fmlk-explorable');
            cell.addEventListener('click', () => this._reveal(x, y));
          }
          cell.innerHTML = isAdj && this.energy > 0 ? '<span class="fmlk-fog-icon">?</span>' : '';
        }

        grid.appendChild(cell);
      }
    }
    wrap.appendChild(grid);

    // Message
    if (this.message) {
      const msg = document.createElement('div');
      msg.className = `fmlk-msg fmlk-msg-${this.message.type}`;
      msg.textContent = this.message.text;
      wrap.appendChild(msg);
    }

    // Reset button on fail
    if (this.failed) {
      const btn = document.createElement('button');
      btn.className = 'fmlk-btn';
      btn.textContent = 'Retry';
      btn.addEventListener('click', () => this.reset());
      wrap.appendChild(btn);
    }

    this.container.appendChild(wrap);
    this._injectStyles();
  }

  _getTileIcon(tile) {
    switch (tile.type) {
      case 'start': return '<span class="fmlk-icon">🚪</span>';
      case 'intel': return '<span class="fmlk-icon">🔑</span>';
      case 'trap': return '<span class="fmlk-icon">⚡</span>';
      case 'bonus': return '<span class="fmlk-icon">🔋</span>';
      case 'exit': return '<span class="fmlk-icon">🏁</span>';
      case 'empty': return '<span class="fmlk-icon fmlk-icon-empty">·</span>';
      default: return '';
    }
  }

  _injectStyles() {
    if (document.getElementById('fmlk-css')) return;
    const s = document.createElement('style'); s.id = 'fmlk-css';
    s.textContent = `
.fmlk{display:flex;flex-direction:column;gap:12px;padding:16px 0;max-width:420px;margin:0 auto}
.fmlk-status{display:flex;justify-content:space-between;align-items:center;font-size:13px;padding:8px 12px;background:var(--surface,#141b2d);border:1px solid var(--border,#1e2a45);border-radius:8px}
.fmlk-energy{color:#eab308;font-weight:700}
.fmlk-intel{color:var(--green,#22c55e);font-weight:700}
.fmlk-legend{color:var(--muted,#7a8ba8);font-size:10px}
.fmlk-grid{display:grid;gap:3px;margin:0 auto;width:fit-content;max-width:100%}
.fmlk-cell{width:clamp(36px,calc((100vw - 80px) / var(--fmlk-cols)),56px);height:clamp(36px,calc((100vw - 80px) / var(--fmlk-cols)),56px);border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:18px;transition:all .3s}
.fmlk-fog{background:var(--surface,#141b2d);border:1px solid var(--border,#1e2a45)}
.fmlk-explorable{cursor:pointer;border:1px dashed var(--accent,#3b82f6);background:rgba(59,130,246,.05)}
.fmlk-explorable:hover{background:rgba(59,130,246,.15);border-color:var(--accent,#3b82f6)}
.fmlk-explorable:active{transform:scale(.9)}
.fmlk-fog-icon{color:var(--accent,#3b82f6);font-size:14px;font-weight:700;opacity:.6}
.fmlk-revealed{background:var(--bg,#0a0e17);border:1px solid var(--border,#1e2a45)}
.fmlk-just-revealed{animation:fmlk-pop .4s ease-out}
@keyframes fmlk-pop{0%{transform:scale(0.5);opacity:0}60%{transform:scale(1.1)}100%{transform:scale(1);opacity:1}}
.fmlk-type-start{border-color:var(--green,#22c55e);background:rgba(34,197,94,.08)}
.fmlk-type-intel{border-color:var(--green,#22c55e);background:rgba(34,197,94,.1)}
.fmlk-type-trap{border-color:var(--red,#ef4444);background:rgba(239,68,68,.08)}
.fmlk-type-bonus{border-color:#eab308;background:rgba(234,179,8,.08)}
.fmlk-type-exit{border-color:var(--accent,#3b82f6);background:rgba(59,130,246,.1)}
.fmlk-type-empty{opacity:.5}
.fmlk-icon{font-size:20px}
.fmlk-icon-empty{font-size:24px;color:var(--muted,#7a8ba8)}
.fmlk-msg{text-align:center;padding:8px 12px;border-radius:6px;font-size:13px;font-weight:600;animation:fmlk-pop .3s ease-out}
.fmlk-msg-good{color:var(--green,#22c55e);background:rgba(34,197,94,.1)}
.fmlk-msg-bad{color:var(--red,#ef4444);background:rgba(239,68,68,.1)}
.fmlk-msg-warn{color:#eab308;background:rgba(234,179,8,.1)}
.fmlk-msg-win{color:var(--green,#22c55e);background:rgba(34,197,94,.15);font-size:15px}
.fmlk-msg-neutral{color:var(--muted,#7a8ba8)}
.fmlk-btn{display:block;margin:0 auto;padding:10px 24px;background:var(--accent,#3b82f6);color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer}
.fmlk-btn:active{transform:scale(.95)}
`;
    document.head.appendChild(s);
  }
}
