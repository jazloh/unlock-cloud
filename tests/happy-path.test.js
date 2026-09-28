/**
 * Re:Solve — Happy Path Tests
 * Simulates a successful playthrough of each episode using the game engine directly.
 * Run: node --test tests/happy-path.test.js
 */

const { readFileSync } = require('fs');
const { join } = require('path');
const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');

// --- Engine loader with file-based fetch mock ---

function loadEngine() {
  const src = readFileSync(join(__dirname, '..', 'app', 'engine.js'), 'utf-8');
  const patched = src
    .replace(/localStorage\./g, '({getItem(){},setItem(){},removeItem(){}}).')
    .replace(/fetch\(/g, 'globalThis.__fetch(');
  const fn = new Function(patched + '\nreturn GameEngine;');
  return fn();
}

function mockFetch(scenarioDir) {
  globalThis.__fetch = (url) => {
    const clean = url.replace(/\?v=\d+/, '');
    const file = clean.replace(/^[^/]*\//, '');
    const fullPath = join(scenarioDir, file);
    try {
      const data = readFileSync(fullPath, 'utf-8');
      return Promise.resolve({ json: () => Promise.resolve(JSON.parse(data)) });
    } catch {
      return Promise.reject(new Error(`File not found: ${fullPath}`));
    }
  };
}

const GameEngine = loadEngine();
const SCENARIOS = join(__dirname, '..', 'scenarios', 'aws');
const SCENARIOS_BIBLE = join(__dirname, '..', 'scenarios', 'bible-jesus-miracles');

async function createEngine(episodeDir) {
  const dir = join(SCENARIOS, episodeDir);
  mockFetch(dir);
  const engine = new GameEngine('.');
  await engine.load();
  return engine;
}

// Helper: discover a card
function discover(engine, cardId, label) {
  const result = engine.discoverCard(cardId);
  assert.ok(result || engine.discoveredCards.has(cardId) || engine.revealedCards.has(cardId),
    `Failed to discover card #${cardId} (${label})`);
}

// Helper: solve a puzzle by marking it solved and discovering the result card
function solvePuzzle(engine, puzzleId, resultCardId, label) {
  engine.solvedPuzzles.add(puzzleId);
  if (resultCardId) discover(engine, resultCardId, label || `puzzle result #${resultCardId}`);
}

// Helper: solve a code_entry puzzle via engine API
function solveCode(engine, puzzleId, answer) {
  const result = engine.tryCodeEntry(puzzleId, answer);
  assert.ok(result.correct, `Puzzle ${puzzleId} failed: ${result.message}`);
}

function assertCompleted(engine) {
  assert.ok(engine.finished, 'Engine should be finished');
  assert.ok(engine.completed, 'Engine should be completed (success)');
}

// ============================================================
// EP0 — Boot Sequence
// ============================================================
describe('EP0 — Boot Sequence', () => {
  let engine;
  before(async () => { engine = await createEngine('ep0-boot-sequence'); engine.start(); });

  test('Start Chamber: discover chip and box, combine them', () => {
    assert.equal(engine.currentRoom, 1);
    discover(engine, 2, 'Locked Box');
    discover(engine, 3, 'Key Chip');
    const result = engine.tryCombination(3, 2);
    assert.equal(result.id, 5);
    assert.ok(engine.unlockedRooms.includes(20));
    assert.ok(engine.unlockedRooms.includes(10));
  });

  test('Sequence Room: solve sequence lock → Access Key', () => {
    engine.navigateToRoom(20);
    solvePuzzle(engine, 'seq-grid', 33, 'Access Key');
    assert.ok(engine.inventory.includes(33));
  });

  test('Combination Room: discover items, combine → Charged Cell', () => {
    engine.navigateToRoom(10);
    discover(engine, 11, 'Power Cell');
    discover(engine, 12, 'Device');
    const result = engine.tryCombination(11, 12);
    assert.equal(result.id, 23);
    assert.ok(engine.inventory.includes(16));
  });

  test('Hidden Room: find hidden 42 → Data Fragment', () => {
    discover(engine, 30, 'Hidden Room');
    const found = engine.tryHiddenNumber(30, 42);
    assert.ok(found);
    assert.ok(engine.inventory.includes(42));
  });

  test('Code Room: solve word lock → Ending', () => {
    solvePuzzle(engine, 'morse-go', null, 'Morse');
    discover(engine, 50, 'Code Room');
    solveCode(engine, 'base64-decode', 'locknu');
    assertCompleted(engine);
  });
});

// ============================================================
// EP1 — Awakening
// ============================================================
describe('EP1 — Awakening', () => {
  let engine;
  before(async () => { engine = await createEngine('ep1-awakening'); engine.start(); });

  test('Spawn Room: solve log analysis, discover items', () => {
    assert.equal(engine.currentRoom, 100);
    solvePuzzle(engine, 'log-analysis', 101, 'System Logs');
    discover(engine, 103, 'Broken Communicator');
    discover(engine, 102, 'Blast Door');
  });

  test('Processing Chamber: get Repair Kit, combine, login → IAM Token', () => {
    discover(engine, 110, 'Processing Chamber');
    engine.navigateToRoom(110);
    discover(engine, 111, 'Active Machine');
    discover(engine, 112, 'Repair Kit');

    // Combine Repair Kit + Broken Communicator → Repaired Communicator #115
    const combo = engine.tryCombination(112, 103);
    assert.equal(combo.id, 115);
    assert.ok(engine.inventory.includes(115));

    // Login to EC2 → IAM Access Token #116 (terminal_lock, solve via puzzle mark)
    solvePuzzle(engine, 'terminal-ec2', 116, 'IAM Access Token');
    assert.ok(engine.inventory.includes(116));
  });

  test('Archive Room: search terminal → SG Blueprint, enter Policy Vault', () => {
    discover(engine, 120, 'Archive Room');
    engine.navigateToRoom(120);
    discover(engine, 121, 'Network Diagram');

    // Search terminal → Security Group Blueprint #125 (terminal_lock)
    solvePuzzle(engine, 'terminal-archive', 125, 'SG Blueprint');
    assert.ok(engine.inventory.includes(125));

    // Enter Policy Vault via keypad
    solvePuzzle(engine, 'keypad-vault', 160, 'Policy Vault');
    assert.ok(engine.unlockedRooms.includes(160));
  });

  test('Policy Vault: get reference sheet, configure IAM policy → Policy Token', () => {
    engine.navigateToRoom(160);
    assert.equal(engine.currentRoom, 160);
    discover(engine, 161, 'Policy Console');
    discover(engine, 162, 'NACL Reference Sheet');

    // Solve policy lock → Policy Token #165
    solvePuzzle(engine, 'policy-lock', 165, 'Policy Token');
    assert.ok(engine.inventory.includes(165));
  });

  test('Gateway Antechamber: configure SG → door opens', () => {
    engine.navigateToRoom(100);
    // Blast door requires #116, #115, #165 — all in inventory, consumes them
    discover(engine, 130, 'Gateway Antechamber');
    engine.navigateToRoom(130);
    assert.equal(engine.currentRoom, 130);

    discover(engine, 133, 'Port Reference Card');

    // Solve SG config (terminal_lock) → Event #135
    solvePuzzle(engine, 'slider-sg', 135, 'Door opens');
    assert.ok(engine.unlockedRooms.includes(170));
  });

  test('NACL Corridor: configure NACL rules', () => {
    engine.navigateToRoom(170);
    assert.equal(engine.currentRoom, 170);
    discover(engine, 171, 'NACL Control Panel');

    // Solve NACL lock → Event #175
    solvePuzzle(engine, 'nacl-sg-lock', 175, 'NACL configured');
    assert.ok(engine.unlockedRooms.includes(180));
  });

  test('Wire Junction: reconnect wires → power restored', () => {
    engine.navigateToRoom(180);
    assert.equal(engine.currentRoom, 180);

    // Solve wire lock → Event #185
    solvePuzzle(engine, 'wire-junction', 185, 'Power restored');
    assert.ok(engine.unlockedRooms.includes(140));
  });

  test('Internet Gateway: enter VPC ID → Ending', () => {
    engine.navigateToRoom(140);
    assert.equal(engine.currentRoom, 140);

    // Solve keypad gateway → Event #150 (ending)
    solvePuzzle(engine, 'keypad-gateway', 150, 'Gateway activated');
    assertCompleted(engine);
  });
});

// ============================================================
// EP2 — Day One
// ============================================================
describe('EP2 — Day One', () => {
  let engine;
  before(async () => { engine = await createEngine('ep2-day-one'); engine.start(); });

  test('Reception: talk to Maya → Temp Badge', () => {
    assert.equal(engine.currentRoom, 100);
    discover(engine, 101, 'Maya');
    discover(engine, 103, 'Office Cat');
  });

  test('Your Desk: read stickies, solve dashboard → Error Logs', () => {
    discover(engine, 200, 'Your Desk');
    engine.navigateToRoom(200);
    discover(engine, 202, 'Task Sticky Notes');
    discover(engine, 203, 'Warning Sticky Notes');
    discover(engine, 204, 'Password Sticky Notes');
    discover(engine, 205, 'Basement Access Note');
    solvePuzzle(engine, 'dashboard-critical', 206, 'Quick Dashboard');
  });

  test('War Room: talk to Jordan, triage incident', () => {
    discover(engine, 300, 'War Room');
    engine.navigateToRoom(300);
    discover(engine, 301, 'Jordan');
    discover(engine, 302, 'Incident Timeline');
    discover(engine, 303, 'War Room Dashboard');
    solvePuzzle(engine, 'sort-triage', 305, 'Incident Triaged');
  });

  test('Data Team: talk to Priya, solve model selection', () => {
    engine.navigateToRoom(200);
    discover(engine, 500, 'Data Team Office');
    engine.navigateToRoom(500);
    discover(engine, 501, 'Dr. Priya');
    discover(engine, 502, 'Model Selection Whiteboard');
    discover(engine, 503, 'Model Benchmarks');
    solvePuzzle(engine, 'match-models', 505, 'Correct Model Selected');
  });

  test('DevOps Bullpen: talk to Sam, diagnose root cause', () => {
    engine.navigateToRoom(200);
    discover(engine, 700, 'DevOps Bullpen');
    engine.navigateToRoom(700);
    discover(engine, 701, 'Sam');
    discover(engine, 702, 'Pipeline Diagram');
    discover(engine, 703, 'Deployment Logs');
    solvePuzzle(engine, 'timeline-rootcause', 708, 'Root Cause Found');
  });

  test('Server Closet: reconnect cables', () => {
    discover(engine, 400, 'Server Closet');
    engine.navigateToRoom(400);
    discover(engine, 401, 'Patch Panel');
    discover(engine, 404, 'Server Rack Labels');
    solvePuzzle(engine, 'wire-cables', 403, 'Cables Reconnected');
  });

  test('Security Office: configure guardrails → Exec Badge', () => {
    engine.navigateToRoom(200);
    discover(engine, 600, 'Security Office');
    engine.navigateToRoom(600);
    discover(engine, 601, 'Frank');
    discover(engine, 602, 'CCTV Footage');
    // Card 603 may require being in room 600 context — use revealCard directly
    engine.revealCard(603);
    solvePuzzle(engine, 'sg-guardrails', 605, 'Guardrails Restored');
    discover(engine, 613, 'Executive Badge');
  });

  test('Executive Floor: open cabinet, decrypt files → Satellite Key', () => {
    engine.navigateToRoom(200);
    discover(engine, 800, 'Executive Floor');
    engine.navigateToRoom(800);
    discover(engine, 801, 'The Fox');
    discover(engine, 802, 'Locked Filing Cabinet');
    solvePuzzle(engine, 'policy-cabinet', 804, 'Cabinet Opened');
    solvePuzzle(engine, 'key-ctofiles', 806, 'Satellite Key');
  });

  test('Archive Basement: search terminal → Architecture Doc', () => {
    engine.navigateToRoom(200);
    discover(engine, 1100, 'Archive Basement');
    engine.navigateToRoom(1100);
    discover(engine, 1101, 'Original Architecture Whiteboard');
    solvePuzzle(engine, 'terminal-archive', 1103, 'Architecture Doc');
  });

  test('Rooftop: configure prompt flow, activate chain → Ending', () => {
    engine.navigateToRoom(800);
    discover(engine, 1200, 'Rooftop');
    engine.navigateToRoom(1200);
    discover(engine, 1201, 'Satellite Console');
    solvePuzzle(engine, 'path-promptflow', 1203, 'Prompt Flow Restored');
    discover(engine, 1207, 'NOVA');
    solvePuzzle(engine, 'chain-final', 1205, 'Systems Restored');
    assertCompleted(engine);
  });
});


// ============================================================
// BIBLE — EP0 — The Master's Investigation (Wedding at Cana)
// ============================================================
describe('Bible EP0 — The Master\'s Investigation', () => {
  let engine;
  before(async () => {
    const dir = join(SCENARIOS_BIBLE, 'ep0-masters-investigation');
    mockFetch(dir);
    engine = new GameEngine('.');
    await engine.load();
    engine.start();
  });

  test('Head Table: discover Cup + Ezra, combine → unlocks Servants Corner', () => {
    assert.equal(engine.currentRoom, 100);
    discover(engine, 101, 'Extraordinary Cup');
    discover(engine, 103, 'Ezra NPC');
    const result = engine.tryCombination(101, 103);
    assert.equal(result.id, 109);
    assert.ok(engine.unlockedRooms.includes(120));
  });

  test('Servants Corner: discover Servants, solve witness-wires → unlocks Stone Jars + Joachim\'s Shop', () => {
    engine.navigateToRoom(120);
    assert.equal(engine.currentRoom, 120);
    discover(engine, 121, 'The Servants NPC');
    solvePuzzle(engine, 'witness-wires', 131, 'Servant Testimony');
    assert.ok(engine.unlockedRooms.includes(140));
    assert.ok(engine.unlockedRooms.includes(160));
  });

  test('Stone Jars: discover jars, solve jar-volume (120)', () => {
    engine.navigateToRoom(140);
    assert.equal(engine.currentRoom, 140);
    discover(engine, 141, 'Six Stone Jars');
    discover(engine, 142, 'Jar Wine Sample');
    discover(engine, 143, 'Courtyard Well');
    solvePuzzle(engine, 'jar-volume', 149, 'Jar Examination');
  });

  test('Joachim\'s Shop: discover Joachim, solve merchant-eliminate', () => {
    engine.navigateToRoom(160);
    assert.equal(engine.currentRoom, 160);
    discover(engine, 161, 'Joachim NPC');
    discover(engine, 162, 'Delivery Records');
    solvePuzzle(engine, 'merchant-eliminate', 169, 'Merchant Eliminated');
  });

  test('Stone Jars: cross courtyard maze → unlocks Bride\'s Family', () => {
    engine.navigateToRoom(140);
    solvePuzzle(engine, 'courtyard-maze', 168, 'Crossed courtyard');
    assert.ok(engine.unlockedRooms.includes(180));
  });

  test('Bride\'s Family: discover Miriam, solve miriam-word (WINE) → unlocks Eastern Corner', () => {
    engine.navigateToRoom(180);
    assert.equal(engine.currentRoom, 180);
    discover(engine, 181, 'Miriam NPC');
    solvePuzzle(engine, 'miriam-word', 191, 'Miriam Testimony');
    assert.ok(engine.unlockedRooms.includes(200));
  });

  test('Eastern Corner: discover Simon & Andrew, solve first-sign → unlocks The Well', () => {
    engine.navigateToRoom(200);
    assert.equal(engine.currentRoom, 200);
    discover(engine, 201, 'Simon & Andrew NPC');
    solvePuzzle(engine, 'first-sign', 211, 'Disciple Witness');
    assert.ok(engine.unlockedRooms.includes(220));
  });

  test('The Well: discover items, solve timeline → Evidence Chain, solve WATER → kavod → Ending', () => {
    engine.navigateToRoom(220);
    assert.equal(engine.currentRoom, 220);
    discover(engine, 221, 'Well Water');
    discover(engine, 222, 'Final Wine Taste');
    discover(engine, 223, 'Evidence Table');
    solvePuzzle(engine, 'investigation-timeline', 225, 'Complete Evidence Chain');
    solvePuzzle(engine, 'final-conclusion', 228, 'Water became wine');
    solvePuzzle(engine, 'kavod-word', 999, 'His Glory');
    assertCompleted(engine);
  });
});


// ============================================================
// Bible EP1 — Philip's Impossible Math
// ============================================================
describe('Bible EP1 — Philip\'s Impossible Math', () => {
  let engine;
  before(async () => {
    const dir = join(SCENARIOS_BIBLE, 'ep1-philips-impossible-math');
    mockFetch(dir);
    engine = new GameEngine('.');
    await engine.load();
    engine.start();
  });

  test('The Hillside: count the crowd → unlocks The Crowd', () => {
    assert.equal(engine.currentRoom, 100);
    discover(engine, 102, 'Philip\'s Calculation');
    discover(engine, 103, 'Distant Markets');
    solvePuzzle(engine, 'crowd-counter', 113, 'Crowd counted');
    assert.ok(engine.unlockedRooms.includes(120));
  });

  test('The Crowd: solve denarii-math (200) → unlocks Boy\'s Basket + Arrangement', () => {
    engine.navigateToRoom(120);
    assert.equal(engine.currentRoom, 120);
    discover(engine, 121, 'Hungry Families NPC');
    discover(engine, 122, 'Empty Merchant NPC');
    discover(engine, 123, 'Judas NPC');
    discover(engine, 124, 'Denarii Calculator');
    solvePuzzle(engine, 'denarii-math', 133, 'Search exhausted');
    assert.ok(engine.unlockedRooms.includes(140));
    assert.ok(engine.unlockedRooms.includes(160));
  });

  test('The Boy\'s Basket: solve offering-table → The Offering (#155)', () => {
    engine.navigateToRoom(140);
    assert.equal(engine.currentRoom, 140);
    discover(engine, 141, 'Andrew NPC');
    discover(engine, 143, 'The Boy\'s Trust');
    solvePuzzle(engine, 'offering-table', 153, 'Five loaves and two fish');
    assert.ok(engine.inventory.includes(155));
  });

  test('The Arrangement: solve crowd-seating → Crowd Arranged (#174)', () => {
    engine.navigateToRoom(160);
    assert.equal(engine.currentRoom, 160);
    discover(engine, 162, 'Group Tally');
    solvePuzzle(engine, 'crowd-seating', 173, 'Crowd arranged');
  });

  test('Gate: combine Offering + Crowd Arranged → unlocks The Blessing', () => {
    const result = engine.tryCombination(155, 174);
    assert.equal(result.id, 175);
    assert.ok(engine.unlockedRooms.includes(180));
  });

  test('The Blessing: solve bread-break + supply-run → unlocks Hillside After', () => {
    engine.navigateToRoom(180);
    assert.equal(engine.currentRoom, 180);
    discover(engine, 182, 'The Endless Basket');
    solvePuzzle(engine, 'bread-break', 195, 'Miracle witnessed');
    solvePuzzle(engine, 'supply-run', 193, 'Basket never empties');
    assert.ok(engine.unlockedRooms.includes(200));
  });

  test('Hillside After: hidden baskets, PROPHET word-lock, combine → Ending', () => {
    engine.navigateToRoom(200);
    assert.equal(engine.currentRoom, 200);
    discover(engine, 203, 'Crowd\'s Declaration');
    // Hidden element: find 12 baskets
    solvePuzzle(engine, 'hidden-baskets', null, 'Hidden baskets');
    engine.revealCard(202);
    engine.revealCard(310);
    assert.ok(engine.inventory.includes(202));
    // Word-lock: PROPHET
    solvePuzzle(engine, 'prophet-word', 218, 'Prophet declared');
    assert.ok(engine.inventory.includes(219));
    // Final combination: #219 + #204 → #999 ending
    const result = engine.tryCombination(219, 204);
    assert.equal(result.id, 999);
    assertCompleted(engine);
  });
});

// ============================================================
// Bible EP1 — JSON Validation
// ============================================================
describe('Bible EP1 — JSON Validation', () => {
  const ep1Dir = join(__dirname, '..', 'scenarios', 'bible-jesus-miracles', 'ep1-philips-impossible-math');
  const jsonFiles = [
    'meta.json', 'narrative.json', 'cards.json', 'combinations.json',
    'puzzles.json', 'events.json', 'scoring.json', 'rooms.json', 'image-style.json'
  ];

  for (const file of jsonFiles) {
    test(`${file} parses as valid JSON`, () => {
      const raw = readFileSync(join(ep1Dir, file), 'utf-8');
      assert.doesNotThrow(() => JSON.parse(raw), `${file} is not valid JSON`);
    });
  }
});

// ============================================================
// EP4 — The Spec Architect
// ============================================================
describe('EP4 — The Spec Architect', () => {
  let engine;
  before(async () => { engine = await createEngine('ep4-spec-architect'); engine.start(); });

  test('The Desk: sort priorities → Sorted Papers, get badge, enter Drafting Hall', () => {
    assert.equal(engine.currentRoom, 1);
    discover(engine, 2, 'Pip');
    discover(engine, 4, 'Dormant Golem');
    discover(engine, 3, 'Architect Badge');
    solvePuzzle(engine, 'sort-priorities', 5, 'Sorted Papers');
    // Badge unlocks Drafting Hall
    discover(engine, 10, 'The Drafting Hall');
    assert.ok(engine.unlockedRooms.includes(10));
  });

  test('The Drafting Hall: talk to Ashford, solve spec-lock (3 rounds)', () => {
    engine.navigateToRoom(10);
    assert.equal(engine.currentRoom, 10);
    discover(engine, 11, 'Lord Ashford');
    discover(engine, 13, 'Marcus Notes');
    solvePuzzle(engine, 'spec-requirements', 12, 'Project Specs');
    assert.ok(engine.inventory.includes(12));
    // Spec puzzle unlocks Golem Workshop
    discover(engine, 30, 'The Golem Workshop');
    assert.ok(engine.unlockedRooms.includes(30));
  });

  test('Golem Workshop: load context, wire MCP', () => {
    engine.navigateToRoom(30);
    assert.equal(engine.currentRoom, 30);

    solvePuzzle(engine, 'context-memory', 31, 'Context Loaded');
    solvePuzzle(engine, 'wire-mcp', 32, 'MCP Connected');
    // context + wire unlock Build Yard
    discover(engine, 50, 'The Build Yard');
    assert.ok(engine.unlockedRooms.includes(50));
  });

  test('Build Yard: terminal command, place architecture, navigate codebase', () => {
    engine.navigateToRoom(50);
    assert.equal(engine.currentRoom, 50);

    solvePuzzle(engine, 'terminal-build', 51, 'First Command');
    solvePuzzle(engine, 'blueprint-arch', 52, 'Architecture Done');
    solvePuzzle(engine, 'path-codebase', 53, 'Codebase Mapped');
    // path puzzle unlocks Launch Tower
    discover(engine, 70, 'The Launch Tower');
    assert.ok(engine.unlockedRooms.includes(70));
  });

  test('Launch Tower: test pipeline, deploy order, find bug, ship it', () => {
    engine.navigateToRoom(70);
    assert.equal(engine.currentRoom, 70);

    solvePuzzle(engine, 'match-tests', 71, 'Tests Ready');
    solvePuzzle(engine, 'timeline-deploy', 72, 'Deploy Sequence');
    solvePuzzle(engine, 'log-bug', 73, 'Bug Found');
    solvePuzzle(engine, 'defuse-ship', 99, 'Launched!');
    assertCompleted(engine);
  });
});

// ============================================================
// EP0.5 — Cloud Onboarding (Booth Qualifier)
// ============================================================
describe('EP0.5 — Cloud Onboarding', () => {
  let engine;
  before(async () => { engine = await createEngine('ep0.5-cloud-onboarding'); engine.start(); });

  test('Lobby: solve jigsaw → Step 1 event reveals IT Setup, awards Desk Slip', () => {
    assert.equal(engine.currentRoom, 100);
    solvePuzzle(engine, 'jigsaw-welcome', 105, 'Step 1 Complete');
    assert.ok(engine.unlockedRooms.includes(200), 'IT Setup should be unlocked');
    assert.ok(engine.inventory.includes(102), 'Desk Slip should be in inventory');
    // Optional bonus lore
    discover(engine, 110, 'Jeff B Mug');
  });

  test('IT Setup: pick up cables, solve wire-lock → Step 2 reveals Security', () => {
    engine.navigateToRoom(200);
    assert.equal(engine.currentRoom, 200);
    discover(engine, 202, 'Cable Bundle');
    solvePuzzle(engine, 'wire-laptop', 205, 'Step 2 Complete');
    assert.ok(engine.unlockedRooms.includes(300), 'Security Office should be unlocked');
  });

  test('Security Office: solve keypad with Desk Slip → Step 3 reveals Break Room, awards Badge', () => {
    engine.navigateToRoom(300);
    assert.equal(engine.currentRoom, 300);
    solvePuzzle(engine, 'keypad-iam', 305, 'Step 3 Complete');
    assert.ok(engine.unlockedRooms.includes(400), 'Break Room should be unlocked');
    assert.ok(engine.inventory.includes(302), 'Activated Badge should be in inventory');
    discover(engine, 310, 'Lambdas Poster');
  });

  test('Break Room: meet Alex → Boot Note → Step 4 reveals Server Room', () => {
    engine.navigateToRoom(400);
    assert.equal(engine.currentRoom, 400);
    discover(engine, 401, 'Alex');
    // Alex reveals 402 automatically; player picks "Head to Server Room" awarding 405
    assert.ok(engine.revealedCards.has(402) || engine.inventory.includes(402),
      'Boot Sequence Note should be revealed by Alex');
    discover(engine, 405, 'Step 4 Complete');
    assert.ok(engine.unlockedRooms.includes(500), 'Server Room should be unlocked');
    discover(engine, 410, 'Coffee Manual');
  });

  test('Server Room: solve sort-lock → Welcome to the cloud (ending)', () => {
    engine.navigateToRoom(500);
    assert.equal(engine.currentRoom, 500);
    solvePuzzle(engine, 'sort-boot', 599, 'Welcome to the cloud');
    discover(engine, 510, 'Founding Photo');
    assertCompleted(engine);
  });
});



// ============================================================
// EP6 — The Bolt (AI-DLC Apprentice, 5 rooms, 1→2→1→1 branching)
// ============================================================
describe('EP6 — The Bolt', () => {
  let engine;
  before(async () => { engine = await createEngine('ep6-the-bolt'); engine.start(); });

  test('War Room: listen to PO, solve spec-lock → Both Context Lab and Architecture Bay unlock', () => {
    assert.equal(engine.currentRoom, 100);
    discover(engine, 102, 'The PO');
    solvePuzzle(engine, 'spec-lock', 105, 'Spec Validated');
    assert.ok(engine.unlockedRooms.includes(200), 'Context Lab should be unlocked');
    assert.ok(engine.unlockedRooms.includes(300), 'Architecture Bay should be unlocked');
  });

  test('Context Lab: solve context-lock → Context Package (211) awarded, read lore', () => {
    engine.navigateToRoom(200);
    assert.equal(engine.currentRoom, 200);
    discover(engine, 210, 'Lore — Context is King');
    solvePuzzle(engine, 'context-lock', 205, 'Context Curated');
    assert.ok(engine.inventory.includes(211), 'Context Package should be in inventory');
  });

  test('Architecture Bay: solve blueprint-lock → Architecture Package (311) awarded, read lore', () => {
    engine.navigateToRoom(300);
    assert.equal(engine.currentRoom, 300);
    discover(engine, 310, 'Lore — Anti-Patterns');
    solvePuzzle(engine, 'blueprint-lock', 305, 'Architecture Verified');
    assert.ok(engine.inventory.includes(311), 'Architecture Package should be in inventory');
  });

  test('Convergence: with both packages, discover gate (350) → Review Room unlocks', () => {
    discover(engine, 350, 'Both Packages Ready');
    assert.ok(engine.unlockedRooms.includes(400), 'Review Room should be unlocked');
  });

  test('Review Room: sync with Agent, solve cascade-lock → Launch Pad unlocks', () => {
    engine.navigateToRoom(400);
    assert.equal(engine.currentRoom, 400);
    discover(engine, 401, 'The Agent (Review Room)');
    discover(engine, 410, 'Lore — The Loop');
    solvePuzzle(engine, 'cascade-lock', 405, 'Outcome Verified');
    assert.ok(engine.unlockedRooms.includes(500), 'Launch Pad should be unlocked');
  });

  test('Launch Pad: solve defuse-lock → Shipped! (ending)', () => {
    engine.navigateToRoom(500);
    assert.equal(engine.currentRoom, 500);
    solvePuzzle(engine, 'defuse-lock', 599, 'Shipped!');
    assertCompleted(engine);
  });
});


// ============================================================
// EP7 — Macet (Grand Finale, 12 rooms, branching + revisits)
// ============================================================
describe('EP7 — Macet', () => {
  let engine;
  before(async () => { engine = await createEngine('ep7-macet'); engine.start(); });

  test('Gridlock: read lore, solve word-lock → Control Tower opens', () => {
    assert.equal(engine.currentRoom, 100);
    discover(engine, 101, 'Lore — The Old Way');
    discover(engine, 102, 'Lore — The Dual Loop');
    solvePuzzle(engine, 'word-lock', 110, 'Conductor named');
    assert.ok(engine.unlockedRooms.includes(200), 'Control Tower should be unlocked');
  });

  test('Control Tower: talk to Raja, restart FSM → Stage Graph opens', () => {
    engine.navigateToRoom(200);
    assert.equal(engine.currentRoom, 200);
    discover(engine, 201, 'Raja');
    solvePuzzle(engine, 'defuse-restart', 210, 'FSM restarted');
    assert.ok(engine.unlockedRooms.includes(300), 'Stage Graph should be unlocked');
  });

  test('Stage Graph: route agents (blueprint), enter stage count → Inner Loop + Memory Vault open', () => {
    engine.navigateToRoom(300);
    assert.equal(engine.currentRoom, 300);
    discover(engine, 301, 'Lore — 5 Phases');
    solvePuzzle(engine, 'blueprint-route', 310, 'Agents Routed');
    assert.ok(engine.inventory.includes(311), 'Composer slip should be in inventory');
    solvePuzzle(engine, 'keypad-stages', 320, 'Stage count 14');
    assert.ok(engine.unlockedRooms.includes(400), 'Inner Loop should be unlocked');
    assert.ok(engine.unlockedRooms.includes(450), 'Memory Vault should be unlocked');
  });

  test('Inner Loop (4A): read lore, solve wager → verification-key in inventory', () => {
    engine.navigateToRoom(400);
    assert.equal(engine.currentRoom, 400);
    discover(engine, 401, 'Lore — Two Ways to Verify');
    solvePuzzle(engine, 'wager-verify', 410, 'verification-key');
    assert.ok(engine.inventory.includes(410), 'verification-key should be in inventory');
  });

  test('Memory Vault (4B): solve decay, then 4digits → memory.md in inventory', () => {
    engine.navigateToRoom(450);
    assert.equal(engine.currentRoom, 450);
    solvePuzzle(engine, 'decay-state', 452, 'State observed');
    assert.ok(engine.inventory.includes(453), 'State fragments should be in inventory');
    solvePuzzle(engine, '4digits-encode', 460, 'memory.md');
    assert.ok(engine.inventory.includes(460), 'memory.md should be in inventory');
  });

  test('Control Tower revisit: with both items → Composer Studio opens', () => {
    engine.navigateToRoom(200);
    // Both items in inventory — discover the report-back card
    discover(engine, 220, 'Report back to Raja');
    assert.ok(engine.unlockedRooms.includes(500), "Composer's Studio should be unlocked");
  });

  test("Composer's Studio: read lore, solve context-lock → Verification Lab opens", () => {
    engine.navigateToRoom(500);
    assert.equal(engine.currentRoom, 500);
    discover(engine, 501, 'Lore — Right-Size or Suffer');
    solvePuzzle(engine, 'context-golem', 510, 'Golem unloaded');
    assert.ok(engine.unlockedRooms.includes(600), 'Verification Lab should be unlocked');
  });

  test('Verification Lab: read lore, solve prompt-lock → Sub-Agent Bay + Audit Trail open', () => {
    engine.navigateToRoom(600);
    assert.equal(engine.currentRoom, 600);
    discover(engine, 601, 'Lore — Generate Verify Learn');
    solvePuzzle(engine, 'prompt-verify', 610, 'Verification prompt');
    assert.ok(engine.unlockedRooms.includes(700), 'Sub-Agent Bay should be unlocked');
    assert.ok(engine.unlockedRooms.includes(750), 'Audit Trail should be unlocked');
  });

  test('Sub-Agent Bay (7A): solve fog-map → Podium opens', () => {
    engine.navigateToRoom(700);
    assert.equal(engine.currentRoom, 700);
    solvePuzzle(engine, 'fogmap-agents', 710, 'Sub-agents dispatched');
    assert.ok(engine.unlockedRooms.includes(800), 'Podium should be unlocked');
  });

  test('Audit Trail (7B): read lore, solve evidence-lock (Podium already unlocked via 7A, idempotent)', () => {
    engine.navigateToRoom(750);
    assert.equal(engine.currentRoom, 750);
    discover(engine, 751, 'Lore — 72 Events');
    solvePuzzle(engine, 'evidence-audit', 760, 'Audit traced');
    // Podium remains unlocked; both branches idempotently reveal room 800
    assert.ok(engine.unlockedRooms.includes(800), 'Podium should still be unlocked');
  });

  test("Conductor's Podium: solve streak-lock with items → Release Gate opens", () => {
    engine.navigateToRoom(800);
    assert.equal(engine.currentRoom, 800);
    // items 410 + 460 already in inventory from Rooms 4A and 4B
    solvePuzzle(engine, 'streak-conduct', 810, 'Orchestra played');
    assert.ok(engine.unlockedRooms.includes(900), 'Release Gate should be unlocked');
  });

  test('Release Gate: read lore, proceed → Learning Loop opens', () => {
    engine.navigateToRoom(900);
    assert.equal(engine.currentRoom, 900);
    discover(engine, 901, 'Lore — Traffic Cleared');
    discover(engine, 910, 'Proceed to Learning Loop');
    assert.ok(engine.unlockedRooms.includes(1000), 'Learning Loop should be unlocked');
  });

  test('Learning Loop: solve cascade-lock → Macet Selesai (ending)', () => {
    engine.navigateToRoom(1000);
    assert.equal(engine.currentRoom, 1000);
    solvePuzzle(engine, 'cascade-learning', 999, 'Macet selesai');
    assertCompleted(engine);
  });
});


// ============================================================
// EP-ETP — Escape to Production (Kiro + AI-DLC booth episode)
// ============================================================
describe('EP-ETP — Escape to Production', () => {
  let engine;
  before(async () => { engine = await createEngine('ep-escape-to-production'); engine.start(); });

  test('The Crash: read lore, solve log + sort + pillar → Codebase unlocks', () => {
    assert.equal(engine.currentRoom, 100);
    discover(engine, 101, 'Welcome to Kiro Labs');
    solvePuzzle(engine, 'log-crash', 102, 'Error Source Found');
    solvePuzzle(engine, 'sort-crash', 103, 'Timeline Reconstructed');
    solvePuzzle(engine, 'pillar-crash', 104, 'Incident Triaged');
    assert.ok(engine.unlockedRooms.includes(200), 'The Codebase should be unlocked');
  });

  test('The Codebase: read lore, wire features → Kiro Config Badge, wager → Design Room + Build Pipeline unlock', () => {
    engine.navigateToRoom(200);
    assert.equal(engine.currentRoom, 200);
    discover(engine, 201, 'Tech Debt Report');
    discover(engine, 202, 'Architecture Guide');
    solvePuzzle(engine, 'wire-kiro-features', 210, 'Features Mapped');
    assert.ok(engine.inventory.includes(215), 'Kiro Config Badge should be in inventory');
    solvePuzzle(engine, 'wager-kiro', 211, 'Kiro Knowledge Verified');
    assert.ok(engine.unlockedRooms.includes(300), 'The Design Room should be unlocked');
    assert.ok(engine.unlockedRooms.includes(400), 'The Build Pipeline should be unlocked');
  });

  test('The Design Room: read lore, chain methodology → AI-DLC Blueprint, spec workflow → Deploy Gate unlocks', () => {
    engine.navigateToRoom(300);
    assert.equal(engine.currentRoom, 300);
    discover(engine, 301, 'AI-DLC Primer');
    solvePuzzle(engine, 'chain-aidlc', 310, 'Methodology Ordered');
    assert.ok(engine.inventory.includes(315), 'AI-DLC Blueprint should be in inventory');
    solvePuzzle(engine, 'spec-aidlc', 311, 'Spec Workflow Complete');
    assert.ok(engine.unlockedRooms.includes(500), 'Deploy Gate should be unlocked');
  });

  test('The Build Pipeline: read lore, streak → Pipeline Token, cascade → Deploy Gate also unlocks', () => {
    engine.navigateToRoom(400);
    assert.equal(engine.currentRoom, 400);
    discover(engine, 401, 'The Rebuild Plan');
    solvePuzzle(engine, 'streak-build', 410, 'Build Knowledge Confirmed');
    assert.ok(engine.inventory.includes(415), 'Pipeline Token should be in inventory');
    solvePuzzle(engine, 'cascade-build', 411, 'Pipeline Restored');
    // Deploy Gate already unlocked from Design Room, idempotent
    assert.ok(engine.unlockedRooms.includes(500), 'Deploy Gate should still be unlocked');
  });

  test('Deploy Gate: read lore, terminal deploy (consumes badge), defuse ship (consumes blueprint + token) → Ending', () => {
    engine.navigateToRoom(500);
    assert.equal(engine.currentRoom, 500);
    discover(engine, 501, 'Deploy Checklist');
    // Terminal deploy requires and consumes Kiro Config Badge (215)
    solvePuzzle(engine, 'terminal-deploy', 510, 'Deploy Command Accepted');
    // Defuse deploy requires and consumes AI-DLC Blueprint (315) + Pipeline Token (415)
    solvePuzzle(engine, 'defuse-deploy', 511, 'You\'re Hired!');
// EP11 — War Room @ Tech Summit (booth walk-up, linear 100→600)
// ============================================================
describe('EP11 — War Room @ Tech Summit', () => {
  let engine;
  before(async () => { engine = await createEngine('ep11-war-room'); engine.start(); });

  test('War Room: read intel, meet agents, proceed to DevOps console', () => {
    assert.equal(engine.currentRoom, 100);
    discover(engine, 101, 'The Call');            // lore
    discover(engine, 106, 'Three Agents');        // lore
    discover(engine, 102, 'VP role select');      // NPC card — now mandatory, gates room 200
    solvePuzzle(engine, 'npc-vp', null, 'VP role select');   // NPC (mandatory)
    discover(engine, 200, 'DevOps console');      // proceed (requires_item: [102])
    assert.ok(engine.unlockedRooms.includes(200), 'DevOps console should be unlocked');
  });

  test('DevOps console: solve log-lock → confirm, advise VP go/no-go → DevOps Finding, proceed to Security', () => {
    engine.navigateToRoom(200);
    assert.equal(engine.currentRoom, 200);
    discover(engine, 201, 'DevOps Agent Brief');
    solvePuzzle(engine, 'log-devops', 202, 'Log Stream Confirmed');   // investigate puzzle → intermediate
    // VP decision beat (npc-dialog, SOFT): pick the correct advisory option → awards the finding
    discover(engine, 210, 'VP go/no-go (DevOps)');
    solvePuzzle(engine, 'npc-decision-devops', 205, 'DevOps Finding');
    assert.ok(engine.inventory.includes(205), 'DevOps Finding should be in inventory');
    discover(engine, 300, 'Security console');
    assert.ok(engine.unlockedRooms.includes(300), 'Security console should be unlocked');
  });

  test('Security console: solve timeline-lock → order, advise VP which fix → Security Finding, proceed to FinOps', () => {
    engine.navigateToRoom(300);
    assert.equal(engine.currentRoom, 300);
    solvePuzzle(engine, 'timeline-security', 302, 'Intrusion Timeline Reconstructed');
    // VP decision beat: advise the scoped fix → awards the finding
    discover(engine, 310, 'VP which fix (Security)');
    solvePuzzle(engine, 'npc-decision-security', 305, 'Security Finding');
    assert.ok(engine.inventory.includes(305), 'Security Finding should be in inventory');
    discover(engine, 400, 'FinOps console');
    assert.ok(engine.unlockedRooms.includes(400), 'FinOps console should be unlocked');
  });

  test('FinOps console: solve evidence-lock → trace, advise VP owner → FinOps Finding, proceed to Synthesis', () => {
    engine.navigateToRoom(400);
    assert.equal(engine.currentRoom, 400);
    discover(engine, 401, 'FinOps Agent Brief');
    solvePuzzle(engine, 'evidence-finops', 402, 'Spend Traced to Source');
    // VP decision beat: advise the leaked access key → awards the finding
    discover(engine, 410, 'VP name the owner (FinOps)');
    solvePuzzle(engine, 'npc-decision-finops', 405, 'FinOps Finding');
    assert.ok(engine.inventory.includes(405), 'FinOps Finding should be in inventory');
    discover(engine, 500, 'Synthesis');
    assert.ok(engine.unlockedRooms.includes(500), 'Synthesis should be unlocked');
  });

  test('Synthesis: chain all three findings via cascade-lock → Incident Resolved (ending)', () => {
    engine.navigateToRoom(500);
    assert.equal(engine.currentRoom, 500);
    discover(engine, 501, 'The Big Screen');
    // Finale consumes all three findings (they are present in inventory)
    solvePuzzle(engine, 'cascade-synthesis', 599, 'Incident Resolved');
    assert.ok(engine.unlockedRooms.includes(600), 'Resolved room should be unlocked');
    assertCompleted(engine);
  });
});



// ============================================================
// EP — Inbox Zero (Booth Qualifier, 3 rooms, 5 puzzles + 1 NPC)
// ============================================================
describe('EP — Inbox Zero', () => {
  let engine;
  before(async () => { engine = await createEngine('ep-inbox-zero'); engine.start(); });

  test('The Avalanche: read sticky note, solve word-lock (HELP) → unlocks Meet Quick', () => {
    assert.equal(engine.currentRoom, 100);
    discover(engine, 110, 'Sticky note lore');
    solvePuzzle(engine, 'puzzle-urgent', 105, 'URGENT decoded');
    assert.ok(engine.unlockedRooms.includes(200), 'Meet Quick should be unlocked');
  });

  test('Meet Quick: talk to Sam, sort capabilities, draft prompt → both items awarded', () => {
    engine.navigateToRoom(200);
    assert.equal(engine.currentRoom, 200);
    discover(engine, 201, 'Sam NPC');
    solvePuzzle(engine, 'puzzle-sort', 205, 'Capabilities sorted');
    assert.ok(engine.inventory.includes(211), 'Category Map should be in inventory');
    solvePuzzle(engine, 'puzzle-prompt', 215, 'First prompt sent');
    assert.ok(engine.inventory.includes(212), 'Well-Formed Prompt should be in inventory');
  });

  test('Head back to the board: consume both items → unlocks Clear the Board', () => {
    discover(engine, 220, 'Head back');
    assert.ok(engine.unlockedRooms.includes(300), 'Clear the Board should be unlocked');
  });

  test('Clear the Board: read board-call lore, trim context → Clean Context awarded', () => {
    engine.navigateToRoom(300);
    assert.equal(engine.currentRoom, 300);
    discover(engine, 310, '4 PM board call lore');
    solvePuzzle(engine, 'puzzle-context', 305, 'Context stabilized');
    assert.ok(engine.inventory.includes(213), 'Clean Context should be in inventory');
  });

  test('Clear the Board: defuse-lock → INBOX ZERO (ending)', () => {
    solvePuzzle(engine, 'puzzle-defuse', 399, 'Inbox Zero');
    assertCompleted(engine);
  });
});



// ============================================================
// EP — Community Day (Booth Qualifier, 3 rooms, 5 puzzles + 1 NPC)
// ============================================================
describe('EP — Community Day (ep-acd-2026)', () => {
  let engine;
  before(async () => { engine = await createEngine('ep-acd-2026'); engine.start(); });

  test('Doors Open: read lanyard lore, solve word-lock (LEARN) → unlocks The Floor', () => {
    assert.equal(engine.currentRoom, 100);
    discover(engine, 110, 'Lanyard Card lore');
    solvePuzzle(engine, 'puzzle-badge', 105, 'Badge unlocked');
    assert.ok(engine.unlockedRooms.includes(200), 'The Floor should be unlocked');
  });

  test('The Floor: talk to Kiro, walk fog map, ask for agenda → both items awarded', () => {
    engine.navigateToRoom(200);
    assert.equal(engine.currentRoom, 200);
    discover(engine, 201, 'Kiro NPC');
    solvePuzzle(engine, 'puzzle-floor', 205, 'Floor walked');
    assert.ok(engine.inventory.includes(211), 'Session Intel should be in inventory');
    solvePuzzle(engine, 'puzzle-agenda', 215, 'Agenda built');
    assert.ok(engine.inventory.includes(212), 'Personalized Agenda should be in inventory');
  });

  test('Head to the auditorium: consume both items → unlocks Closing Quiz', () => {
    discover(engine, 220, 'Head to auditorium');
    assert.ok(engine.unlockedRooms.includes(300), 'Closing Quiz should be unlocked');
  });

  test('Closing Quiz: read swag-table lore, solve evidence-lock → Winning Answer awarded', () => {
    engine.navigateToRoom(300);
    assert.equal(engine.currentRoom, 300);
    discover(engine, 310, 'Swag-table lore');
    solvePuzzle(engine, 'puzzle-quiz', 305, 'Quiz cleared');
    assert.ok(engine.inventory.includes(313), 'Winning Answer should be in inventory');
  });

  test('Closing Quiz: defuse-lock → BUZZER BEAT (ending)', () => {
    solvePuzzle(engine, 'puzzle-buzzer', 399, 'Buzzer beat');
    assertCompleted(engine);
  });
});
