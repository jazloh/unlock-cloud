# re:Solve

A mobile-first escape room card game that teaches through immersive storytelling. Players explore rooms, collect items, solve puzzles, and piece together narratives — all within a timed session.

## Run Locally

1. Start a local server:

   ```
   npx http-server -p 8080 -c-1
   ```

   or with Python:

   ```
   python -m http.server 8080
   ```

2. Open http://localhost:8080/app/home.html

Requires any modern browser. The game loads JSON via fetch, so `file://` won't work.

## How It Works

Each **category** contains multiple **episodes**. An episode is a self-contained escape room with:

- **Rooms** — locations the player unlocks and explores
- **Cards** — items (red), objects (blue), events (yellow), penalties (black)
- **Puzzles** — interactive lock components that gate progression
- **Combinations** — item + object pairings that trigger discoveries
- **Narrative** — voice-narrated story segments (intro, mid-event, endings)
- **Scoring** — stars based on time, penalties, and hints used

Episodes are data-driven — the engine renders any scenario from JSON. Adding a new episode requires no code changes.

## Project Structure

```
app/
  engine.js             Core game engine (state, scoring, leaderboard)
  index.html / .js      Main game UI (single page app)
  home.html / .js       Episode selection with category browsing
  puzzle/               60+ puzzle lock components
  tools/                In-game tools (decoders, cipher wheel, etc.)
scenarios/
  categories.json       Category registry
  <category>/
    index.json          Episode list for category
    <episode>/
      meta.json         Title, difficulty, duration, player count
      cards.json        All cards (items, objects, locations, events)
      rooms.json        Room graph and unlock conditions
      puzzles.json      Puzzle configurations
      combinations.json Item + object interactions
      events.json       Timed events and penalties
      narrative.json    Voice segments and dialog
      scoring.json      Star thresholds
      image-style.json  Art style for image generation
      assets/           Cover, room, and ending images + voice audio
server/
  dev-server.js         Backend for multiplayer leaderboard
tests/
  happy-path.test.js    Unit tests (Node.js)
  *.spec.js             E2E tests (Playwright)
tools/
  cards_to_images.py    Generate card art via OpenAI gpt-image-1
  narrative_to_voice.py Generate voice audio via Amazon Polly
  resize_images.py      Optimize images for mobile
docs/                   Episode blueprints and fact-check reports
```

## Adding a New Episode

1. Create `scenarios/<category>/<episode-slug>/`
2. Add JSON files: `meta.json`, `cards.json`, `rooms.json`, `puzzles.json`, `combinations.json`, `events.json`, `narrative.json`, `scoring.json`, `image-style.json`
3. Register the episode slug in `scenarios/<category>/index.json`
4. Generate assets: `python tools/cards_to_images.py scenarios/<category>/<episode>`
5. Generate voice: `python tools/narrative_to_voice.py scenarios/<category>/<episode>`

## Tests

```bash
npm test                 # Unit tests (Node 18+)
npm run test:e2e         # E2E tests (Playwright)
npm run test:all         # Both
```
