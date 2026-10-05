# Handoff: fill-in-the-blank clues for Showdown spelling puzzles

**For:** Showdown engineer
**From:** question bank team (Malaysia bank, AWS Cloud & AI Day Kuala Lumpur, 2026-11-04)
**Status:** request only. Nothing in `app/` has been changed.

## Why

Today the spelling puzzle shows only scrambled letters under a fixed prompt ("Unscramble each answer."). Players get no hint about which word they're building, so long answers turn into guesswork.

The Malaysia bank will give every spelling entry a clue sentence with a blank:

```
In AWS, Simple Storage ___ is object storage.
Letters: C E V I S E R      Answer: SERVICE
```

## Bank change (already decided, bank team owns this)

Spelling entries get a new optional `question` field with `___` marking the blank:

```json
{ "id": "awscore-spell-011",
  "question": "In AWS, Simple Storage ___ is object storage.",
  "answer": "Service",
  "source": "https://aws.amazon.com/s3/" }
```

Rules the bank team will follow:
- `question` is plain text with exactly one `___` (three underscores). Multi-word answers still use one `___` for the whole answer.
- The answer itself never appears in the `question`.
- `answer` rules don't change: letters and spaces only, 5–16 letters.
- Older entries (the Hanoi bank) have no `question`. They must keep working exactly as they do today.

## Engine changes requested

### 1. New component: `app/puzzle/spelling-lock-showdown.js`

Duplicate `app/puzzle/spelling-lock.js` and leave the original **untouched**, since episodes also use it.

In the copy:

- **Rename the class** to `SpellingLockShowdown`. Both files are loaded as global scripts, so keeping the name `SpellingLock` would let one silently overwrite the other.
- **Use a new CSS prefix and style-tag id** so the two components can't share or overwrite each other's styles. For example, change `splk-` to `splks-` and `#splk-style` to `#splks-style`. As written, `_injectStyles()` skips injecting when `#splk-style` already exists.
- **Add a `clues` option:** an array parallel to `words`, where `clues[i]` is the clue for `words[i]`.
  - In the constructor: `this.clues = Array.isArray(this.cfg.clues) ? this.cfg.clues : [];`
  - In `_render()`, between the counter line and the slots, show the current clue if there is one. Show nothing if the clue is missing or empty:
    ```js
    const clue = String(this.clues[this.current] || '').trim();
    const clueHtml = clue ? `<div class="splks-clue">${this._esc(clue)}</div>` : '';
    ```
  - **Escape the clue.** It comes from the bank, which is fetched live, so treat it as text, not HTML:
    ```js
    _esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
    ```
  - Suggested style, matching the board's colours: `.splks-clue{font-size:15px;line-height:1.4;color:#f0e6c0;text-align:center;margin:4px 0 8px}`
  - Optional polish: render `___` as a visible blank (an underlined span), or fill it in with the solved word once the player gets it right.
- The `pool` / `pickCount` mode can be removed from the copy. Showdown always passes explicit `words`, and random picking would break the word/clue pairing.

### 2. `app/showdown.html`

Add the new script next to the existing one (`app/showdown.html:283`):

```html
<script src="puzzle/spelling-lock-showdown.js"></script>
```

Keep `puzzle/spelling-lock.js` loaded too, unless nothing else on the page uses it.

### 3. `app/showdown.js`: building the spelling slot (around `:1985`)

Collect each entry's `question` alongside its answer, in the same order:

```js
const words = [];
const clues = []; // parallel to words; '' when the entry has no question
// ...inside ids.forEach, after words.push(w):
clues.push(nonEmpty(e.question) ? String(e.question) : '');
```

Pass `clues` in the slot config, and adjust the prompt when clues are present:

```js
question: clues.some(Boolean) ? 'Unscramble the letters to fill each blank.' : 'Unscramble each answer.',
config: { title: 'SPELL IT OUT', words, clues, sequential: true, /* ...existing flags... */ }
```

Substitution needs no extra work. A substituted entry carries its own `question`, so the clue always matches the word.

### 4. `app/showdown.js`: mounting the lock (around `:2138`)

Point `case 'spelling-lock':` at the new class and pass `clues`:

```js
return new SpellingLockShowdown(mount, {
  title: cfg.title,
  words: cfg.words,
  clues: cfg.clues,
  // ...existing options unchanged...
});
```

### 5. `app/puzzle-test-showdown.html` (optional)

This test page loads `puzzle/spelling-lock.js` (`:68`) and has a `spelling-lock` case (`:144`). Switch it to the new file and add `clues` to its sample, so the new component can be tested on its own.

### 6. Cache-busting

Bump `BANK_VERSION` (`app/showdown.js:140`), and whatever version query the page uses for scripts, so browsers at the booth don't keep the old component.

## Acceptance checks

1. **Hanoi bank (no `question`):** the spelling puzzle looks and plays exactly like today, with no empty clue box.
2. **Malaysia bank:** each word shows its own clue, and the clue changes as the player moves to the next word.
3. **Escaping:** a clue containing `<b>` or `&` displays as literal text.
4. **Episodes:** a puzzle that uses `spelling-lock.js` is unchanged, with styles intact even if both files load on one page.
5. **Mock mode:** `showdown.html?mock=true&game=test&mockplay=300` still plays end to end.

## Contacts and related files

- Bank authoring rules: `.kiro/skills/showdown-question-bank/SKILL.md` (spelling section to be updated with the new `question` field once this ships).
- Engine overview: `.kiro/skills/showdown/SKILL.md`.
- The backend needs no change, because it only picks IDs. Its copy of the Malaysia bank must still include the new `question` fields, since the client reads its text from there.
