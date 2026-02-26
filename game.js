// Cave Snake (Phaser 3) - Infinite-up, trail-permanent, reveal-by-completion
// Controls (local): WASD / Arrows move, first move starts/restarts, I = New Map, O = Toggle Path

const ARCADE_CONTROLS = {
  P1U: ["w", "ArrowUp"],
  P1D: ["s", "ArrowDown"],
  P1L: ["a", "ArrowLeft"],
  P1R: ["d", "ArrowRight"],
  P1B: ["i"], // New map
  P1C: ["o"], // Toggle path
};

const KEYBOARD_TO_ARCADE = {};
for (const [code, keys] of Object.entries(ARCADE_CONTROLS)) {
  keys.forEach((k) => (KEYBOARD_TO_ARCADE[(k || "").toLowerCase()] = code));
}

// ---------- Tuning knobs ----------
const SCREEN_W = 800;
const SCREEN_H = 600;

const GRID_W = 25; // fixed width
const CHUNK_H = 12; // rows added each time (keep EVEN to ensure clean exits)
const START_CHUNKS = 1; // initial revealed chunks
const ADD_CHUNKS = 1; // chunks revealed when you complete the current area
const MAX_ROW_SHIFT = 3; // smaller lateral moves => more obstacles
const LONG_SWEEP_CHANCE = 0.14;
const SPEED_DIAL = 1.0; // code-only speed multiplier (higher = faster)
const START_LIVES = 3;

const TILE = 28;
const UI_H = 70;
const PLAY_TOP = UI_H;
const PLAY_BOTTOM = SCREEN_H - 20;
const PLAY_H = PLAY_BOTTOM - PLAY_TOP;
const GRID_X0 = Math.floor((SCREEN_W - GRID_W * TILE) / 2);

const STATE_MENU = 0;
const STATE_PLAY = 1;
const STATE_DEAD = 2;
const STATE_ENTRY = 3;

// ---------- Theme (arcade / neon) ----------
const THEME = {
  // core
  bg: 0x080b10,
  playBg: 0x080b10,

  // tiles
  tileFree: 0x16314d,
  tileTrail: 0x2bf06f,
  tileTrailInset: 0x0f2d19,
  tileBomb: 0x000000,

  // UI
  hudBg: 0x07121c,
  hudStroke: 0x62c0ff,
  panelBg: 0x08121d,
  panelStroke: 0x62c0ff,
  dangerStroke: 0xff6b6b,

  // accents
  accent: 0x62c0ff,
  success: 0x2bf06f,
  danger: 0xff6b6b,
  warn: 0xfde047,

  // text
  text: "#EDF6FF",
  muted: "#AFC6DE",
  dim: "#8CA3B8",

  // FX
  scanlinesAlpha: 0.10,
  vignetteAlpha: 0.22,
};

const FONT_PIXEL = "'Press Start 2P', 'Courier New', monospace";

// ---------- Phaser bootstrap ----------
const config = {
  type: Phaser.AUTO,
  width: SCREEN_W,
  height: SCREEN_H,
  backgroundColor: "#080B10",
  pixelArt: true,
  antialias: false,
  roundPixels: true,
  scene: { create, update },
};
new Phaser.Game(config);

// ---------- Game singletons ----------
let scene, g;
let state = STATE_MENU;
let showPath = true;

let world, snake, ui, fx, music, leaderboard;
let bestChunk = 1;
let nameEntry = null;
let highScoreNotice = "";

// For death overlay stats (because code resets map on death)
let lastRunStats = null;

function create() {
  scene = this;
  if (scene.game && scene.game.canvas) {
    scene.game.canvas.style.imageRendering = "pixelated";
  }
  g = this.add.graphics();

  fx = new FX(scene);
  leaderboard = new Leaderboard("cave_snake_leaderboard", 8);
  music = scene.sound && scene.sound.context ? new MusicEngine(scene.sound.context) : null;
  ui = new UIRoot(scene);

  newMap(); // also builds snake
  setState(STATE_MENU);

  scene.input.keyboard.on("keydown", (e) => {
    const key = ((e.key || "") + "").toLowerCase();
    const code = KEYBOARD_TO_ARCADE[key] || e.key;
    onPress(code);
  });
}

function update(_, dt) {
  if (state === STATE_PLAY) {
    if (music) music.setLevel(world.revealed);
    snake.step(dt);

    if (snake.expandedCount > 0) {
      for (let i = 0; i < snake.expandedCount; i++) fx.levelUp();
      ui.onExpand(snake);
      snake.expandedCount = 0;
    }

    if (snake.respawnCount > 0) {
      for (let i = 0; i < snake.respawnCount; i++) fx.beep(170, 0.09, 0.14, "sawtooth");
      ui.onRespawn(snake);
      snake.respawnCount = 0;
    }

    bestChunk = Math.max(bestChunk, world.revealed, snake.chunkLevel());

    if (snake.dead) {
      const deathReason = snake.deathReason;

      lastRunStats = {
        time: snake.time || 0,
        score: snake.currentScore(),
        level: snake.chunkLevel(),
        bestLevel: bestChunk,
        maxY: snake.maxY,
        revealed: world.revealedHeight,
        fillPct: world.totalFree > 0 ? Math.floor((100 * snake.len) / world.totalFree) : 0,
        livesLeft: snake.lives,
        reason: deathReason || "UNKNOWN",
      };
      ui.setLastRun(lastRunStats);

      fx.explode();
      newMap();
      if (leaderboard && leaderboard.qualifies(lastRunStats.score)) {
        startNameEntry(lastRunStats.score, lastRunStats.level, deathReason);
        setState(STATE_ENTRY, deathReason);
      } else {
        setState(STATE_DEAD, deathReason);
      }
    }
  }

  world.draw(g, snake, showPath);
  ui.update(state, snake, world, bestChunk, showPath, dt);
}

// ---------- Input ----------
function onPress(code) {
  if (state === STATE_ENTRY) {
    onNameEntryPress(code);
    return;
  }

  if (state === STATE_DEAD) {
    fx.beep(650, 0.08, 0.10, "square");
    setState(STATE_MENU);
    return;
  }

  if (code === "P1U") onMoveInput(0, +1);
  else if (code === "P1D") onMoveInput(0, -1);
  else if (code === "P1L") onMoveInput(-1, 0);
  else if (code === "P1R") onMoveInput(+1, 0);
  else if (code === "P1C") {
    showPath = !showPath;
    fx.beep(showPath ? 900 : 500, 0.06, 0.08, "square");
    ui.toast(showPath ? "PATH ON" : "PATH OFF", "info");
  } else if (code === "P1B") {
    fx.beep(300, 0.08, 0.10, "square");
    newMap();
    setState(STATE_MENU);
  }
}

function onMoveInput(dx, dy) {
  if (state !== STATE_PLAY) {
    fx.beep(650, 0.08, 0.10, "square");
    startRun();
  }
  snake.setWantedDir(dx, dy);
}

function setState(next, msg) {
  state = next;
  if (music) {
    music.setLevel(state === STATE_PLAY && world ? world.revealed : 1);
    music.setActive(state === STATE_PLAY);
  }
  ui.setMode(state, msg || "", buildUiContext());
}

function buildUiContext() {
  return {
    bestChunk,
    lastRunStats,
    leaderboard: leaderboard ? leaderboard.getEntries() : [],
    nameEntry,
    highScoreNotice,
  };
}

function startNameEntry(score, level, reason) {
  nameEntry = {
    score: Math.max(0, score | 0),
    level: Math.max(1, level | 0),
    chars: ["A", "A", "A"],
    cursor: 0,
    reason: reason || "",
  };
}

function onNameEntryPress(code) {
  if (!nameEntry) return;

  const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const isLetterOrDigit = typeof code === "string" && code.length === 1 && /[a-z0-9]/i.test(code);

  if (code === "P1L") {
    nameEntry.cursor = (nameEntry.cursor + 2) % 3;
    fx.beep(440, 0.05, 0.06, "square");
  } else if (code === "P1R") {
    nameEntry.cursor = (nameEntry.cursor + 1) % 3;
    fx.beep(520, 0.05, 0.06, "square");
  } else if (code === "P1U" || code === "P1D") {
    const curr = nameEntry.chars[nameEntry.cursor];
    const idx = Math.max(0, charset.indexOf(curr));
    const next = (idx + (code === "P1U" ? 1 : -1) + charset.length) % charset.length;
    nameEntry.chars[nameEntry.cursor] = charset[next];
    fx.beep(700, 0.045, 0.06, "triangle");
  } else if (isLetterOrDigit) {
    nameEntry.chars[nameEntry.cursor] = code.toUpperCase();
    nameEntry.cursor = Math.min(2, nameEntry.cursor + 1);
    fx.beep(760, 0.04, 0.06, "triangle");
  } else if (code === "P1B" || code === "Enter" || code === " ") {
    const initials = nameEntry.chars.join("");
    const result = leaderboard.add(initials, nameEntry.score, nameEntry.level);
    if (result && result.rank === 1) {
      highScoreNotice = `CONGRATS ${initials}! NEW #1 WITH ${nameEntry.score}`;
      fx.levelUp();
    } else if (result && result.rank) {
      highScoreNotice = `GREAT RUN ${initials}! YOU PLACED #${result.rank}`;
    } else {
      highScoreNotice = `SCORE SAVED FOR ${initials}`;
    }
    nameEntry = null;
    fx.beep(980, 0.08, 0.10, "square");
    setState(STATE_MENU);
    return;
  } else if (code === "Escape" || code === "P1C") {
    nameEntry = null;
    highScoreNotice = "";
    fx.beep(300, 0.06, 0.08, "square");
    setState(STATE_MENU);
    return;
  } else {
    return;
  }

  ui.setMode(state, "", buildUiContext());
}

function startRun() {
  highScoreNotice = "";
  snake.reset(); // same world (map persists)
  setState(STATE_PLAY);
}

function newMap() {
  const seed = (Math.random() * 0xffffffff) >>> 0;
  world = new World(seed);
  snake = new Snake(world);
}

// ---------- Core model ----------
class World {
  constructor(seed) {
    this.seed = seed >>> 0;

    this.chunks = [];
    this.chunkStarts = [];
    this.revealed = 0;

    this.totalFree = 0; // how many free tiles exist in revealed area
    this.totalPathLen = 0; // canonical path length (matches totalFree with this generator)
    this.expandFlash = 0;

    // camera info for UI layers (callouts/particles anchored to grid)
    this.lastCamBottom = 0;
    this.lastVisRows = 0;

    this.revealMore(START_CHUNKS);
  }

  get revealedHeight() {
    return this.revealed * CHUNK_H;
  }

  isFree(x, y) {
    if (x < 0 || x >= GRID_W || y < 0 || y >= this.revealedHeight) return false;
    const c = (y / CHUNK_H) | 0;
    const k = y * GRID_W + x;
    return this.chunks[c].free.has(k);
  }

  maybeExpand(snake) {
    if (snake.len >= this.totalFree) {
      this.revealMore(ADD_CHUNKS);
      return true;
    }
    return false;
  }

  revealMore(n) {
    for (let i = 0; i < n; i++) {
      const idx = this.revealed + i;
      const chunksLoaded = idx + 1;
      const chunk = generateChunk(this.seed, idx, chunksLoaded);

      this.chunks[idx] = chunk;
      this.chunkStarts[idx] = this.totalPathLen;

      this.totalPathLen += chunk.path.length;
      this.totalFree += chunk.freeCount;
    }
    this.revealed += n;
    this.expandFlash = 1;
  }

  pathKeyAt(globalIndex) {
    for (let c = 0; c < this.revealed; c++) {
      const start = this.chunkStarts[c];
      const p = this.chunks[c].path;
      const j = globalIndex - start;
      if (j >= 0 && j < p.length) return p[j];
    }
    return null;
  }

  draw(g, snake, showPath) {
    g.clear();

    // Playfield background
    g.fillStyle(THEME.playBg, 1);
    g.fillRect(0, PLAY_TOP, SCREEN_W, PLAY_BOTTOM - PLAY_TOP);

    const visRows = Math.max(8, ((PLAY_BOTTOM - PLAY_TOP) / TILE) | 0);

    let camBottom = 0;
    if (snake) {
      camBottom = (snake.headY - ((visRows * 0.35) | 0)) | 0;
      const maxCam = this.revealedHeight - visRows;
      if (maxCam > 0) camBottom = clamp(camBottom, 0, maxCam);
      else camBottom = 0;
    }

    // expose for UI layers
    this.lastCamBottom = camBottom;
    this.lastVisRows = visRows;

    const yMin = camBottom;
    const yMax = camBottom + visRows - 1;

    // Tiles
    for (let y = yMin; y <= yMax; y++) {
      if (y < 0 || y >= this.revealedHeight) continue;
      const chunk = this.chunks[(y / CHUNK_H) | 0];

      for (let x = 0; x < GRID_W; x++) {
        const r = toScreen(x, y, camBottom);
        const k = y * GRID_W + x;

        const free = chunk.free.has(k);
        const visited = snake && snake.visited.has(k);

        if (!free) {
          // Bomb (simple / dark)
          g.fillStyle(THEME.tileBomb, 1);
          g.fillRect(r.x, r.y, TILE - 1, TILE - 1);
        } else if (visited) {
          // Trail (permanent)
          g.fillStyle(THEME.tileTrail, 1);
          g.fillRect(r.x, r.y, TILE - 1, TILE - 1);
          g.fillStyle(THEME.tileTrailInset, 0.34);
          g.fillRect(r.x + 4, r.y + 4, TILE - 9, TILE - 9);
        } else {
          // Free
          g.fillStyle(THEME.tileFree, 1);
          g.fillRect(r.x, r.y, TILE - 1, TILE - 1);
        }
      }
    }

    // Canonical path (hint) - draw OVER tiles so toggle is clearly visible.
    if (showPath) {
      g.lineStyle(3, 0x5ab6ff, 0.58);
      g.beginPath();

      const cStart = (yMin / CHUNK_H) | 0;
      const cEnd = (yMax / CHUNK_H) | 0;

      for (let c = cStart; c <= cEnd && c < this.revealed; c++) {
        const p = this.chunks[c].path;
        for (let i = 0; i < p.length - 1; i++) {
          const a = p[i],
            b = p[i + 1];
          const ay = (a / GRID_W) | 0,
            by = (b / GRID_W) | 0;
          if ((ay < yMin && by < yMin) || (ay > yMax && by > yMax)) continue;

          const ax = a % GRID_W,
            bx = b % GRID_W;
          const pa = cellCenter(ax, ay, camBottom);
          const pb = cellCenter(bx, by, camBottom);
          g.moveTo(pa.x, pa.y);
          g.lineTo(pb.x, pb.y);
        }
      }

      // Connect chunk boundaries
      for (let c = cStart; c < cEnd && c + 1 < this.revealed; c++) {
        const a = this.chunks[c].path[this.chunks[c].path.length - 1];
        const b = this.chunks[c + 1].path[0];
        const ay = (a / GRID_W) | 0,
          by = (b / GRID_W) | 0;
        if ((ay < yMin && by < yMin) || (ay > yMax && by > yMax)) continue;

        const ax = a % GRID_W,
          bx = b % GRID_W;
        const pa = cellCenter(ax, ay, camBottom);
        const pb = cellCenter(bx, by, camBottom);
        g.moveTo(pa.x, pa.y);
        g.lineTo(pb.x, pb.y);
      }

      g.strokePath();
    }

    // Head
    if (snake) {
      const r = toScreen(snake.headX, snake.headY, camBottom);
      g.fillStyle(0xfff06a, 1);
      g.fillRect(r.x + 4, r.y + 4, TILE - 9, TILE - 9);
      g.lineStyle(2, 0xffffff, 0.45);
      g.strokeRect(r.x + 2, r.y + 2, TILE - 5, TILE - 5);
    }

    // Expand flash
    if (this.expandFlash > 0) {
      g.fillStyle(0xffffff, 0.08 * this.expandFlash);
      g.fillRect(0, PLAY_TOP, SCREEN_W, PLAY_BOTTOM - PLAY_TOP);
      this.expandFlash = Math.max(0, this.expandFlash - 0.05);
    }
  }
}

class Snake {
  constructor(world) {
    this.world = world;
    this.visited = new Set();
    this.reset();
  }

  reset() {
    this.headX = GRID_W - 1;
    this.headY = 0;

    this.dirX = -1;
    this.dirY = 0;

    this.wantX = this.dirX;
    this.wantY = this.dirY;
    this.turnQueue = [];

    this.visited.clear();
    this.visited.add(this.key(this.headX, this.headY));

    this.len = 1;
    this.time = 0;
    this.acc = 0;
    this.lives = START_LIVES;

    this.maxY = this.headY;

    this.dead = false;
    this.deathReason = "";
    this.expandedCount = 0;
    this.respawnCount = 0;
    this.lastRespawnReason = "";
    this.waitingForMove = false;
    this.waitingReason = "";
  }

  key(x, y) {
    return y * GRID_W + x;
  }

  chunkLevel() {
    const byMax = (this.maxY / CHUNK_H) | 0;
    const byHead = (this.headY / CHUNK_H) | 0;
    return Math.max(byMax, byHead) + 1;
  }

  currentScore() {
    return Math.max(0, (this.chunkLevel() - 1) * 1000 + this.len);
  }

  restoreVisitedForRespawn(latestChunk) {
    this.visited.clear();
    for (let c = 0; c < latestChunk; c++) {
      const chunk = this.world.chunks[c];
      if (!chunk) continue;
      for (const key of chunk.free) this.visited.add(key);
    }
  }

  setWantedDir(dx, dy) {
    const wasWaitingForMove = this.waitingForMove;
    if (wasWaitingForMove) {
      this.waitingForMove = false;
      this.waitingReason = "";
      this.acc = 0;
    }

    const last = this.turnQueue.length
      ? this.turnQueue[this.turnQueue.length - 1]
      : { x: this.wantX, y: this.wantY };

    if (dx === last.x && dy === last.y) return;
    if (dx === -last.x && dy === -last.y) {
      if (wasWaitingForMove) this.waitingForMove = true;
      return;
    }

    if (this.turnQueue.length >= 2) this.turnQueue.shift();
    this.turnQueue.push({ x: dx, y: dy });
  }

  step(dt) {
    if (this.dead) return;
    if (this.waitingForMove) return;

    this.time += dt / 1000;
    this.acc += dt;

    const stepMs = this.moveIntervalMs();

    while (this.acc >= stepMs) {
      this.acc -= stepMs;
      const moved = this.moveOne();
      if (this.dead) return;
      if (!moved) break;

      if (this.world.maybeExpand(this)) {
        this.expandedCount++;
        this.waitingForMove = true;
        this.waitingReason = "NEW TILES: CHOOSE MOVE";
        this.turnQueue.length = 0;
        this.acc = 0;
        break;
      }

      if (!this.hasAnyValidMove()) {
        this.respawnAtLatestChunk("NO VALID MOVES");
        break;
      }

      if (!this.isRemainingReachable()) {
        this.respawnAtLatestChunk("PATH BLOCKED");
        break;
      }
    }
  }

  moveIntervalMs() {
    const chunkPressure = Math.max(0, this.world.revealed - START_CHUNKS);
    const base = Math.max(80, 240 - chunkPressure * 10);
    return base / SPEED_DIAL;
  }

  hasAnyValidMove() {
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ];
    for (let i = 0; i < dirs.length; i++) {
      const dx = dirs[i][0];
      const dy = dirs[i][1];
      const nx = this.headX + dx;
      const ny = this.headY + dy;
      const k = this.key(nx, ny);
      if (this.world.isFree(nx, ny) && !this.visited.has(k)) return true;
    }
    return false;
  }

  isRemainingReachable() {
    const remaining = this.world.totalFree - this.len;
    if (remaining <= 0) return true;

    const headKey = this.key(this.headX, this.headY);
    const seen = new Set([headKey]);
    const qx = [this.headX];
    const qy = [this.headY];
    let qi = 0;
    let reachableUnvisited = 0;

    while (qi < qx.length) {
      const x = qx[qi];
      const y = qy[qi];
      qi++;

      const neighbors = [
        [x + 1, y],
        [x - 1, y],
        [x, y + 1],
        [x, y - 1],
      ];
      for (let i = 0; i < neighbors.length; i++) {
        const nx = neighbors[i][0];
        const ny = neighbors[i][1];
        if (!this.world.isFree(nx, ny)) continue;

        const nk = this.key(nx, ny);
        if (seen.has(nk)) continue;
        if (nk !== headKey && this.visited.has(nk)) continue;

        seen.add(nk);
        qx.push(nx);
        qy.push(ny);

        if (!this.visited.has(nk)) {
          reachableUnvisited++;
          if (reachableUnvisited >= remaining) return true;
        }
      }
    }

    return reachableUnvisited >= remaining;
  }

  respawnAtLatestChunk(reason) {
    this.lives = Math.max(0, this.lives - 1);
    if (this.lives <= 0) {
      this.die(`OUT OF LIVES (${reason})`);
      return;
    }

    const latestChunk = Math.max(0, this.world.revealed - 1);
    this.headX = GRID_W - 1;
    this.headY = latestChunk * CHUNK_H;
    this.maxY = Math.max(this.maxY, this.headY);
    this.dirX = -1;
    this.dirY = 0;
    this.wantX = this.dirX;
    this.wantY = this.dirY;

    this.restoreVisitedForRespawn(latestChunk);
    this.visited.add(this.key(this.headX, this.headY));
    this.len = this.visited.size;

    this.waitingForMove = true;
    this.waitingReason = "RESPAWN: CHOOSE MOVE";
    this.turnQueue.length = 0;
    this.acc = 0;

    this.lastRespawnReason = reason;
    this.respawnCount++;
  }

  moveOne() {
    if (this.turnQueue.length > 0) {
      const next = this.turnQueue.shift();
      this.wantX = next.x;
      this.wantY = next.y;
    }

    this.dirX = this.wantX;
    this.dirY = this.wantY;

    const nx = this.headX + this.dirX;
    const ny = this.headY + this.dirY;

    if (!this.world.isFree(nx, ny)) {
      this.respawnAtLatestChunk("HIT WALL");
      return false;
    }

    const k = this.key(nx, ny);
    if (this.visited.has(k)) {
      this.respawnAtLatestChunk("HIT YOUR TRAIL");
      return false;
    }

    this.headX = nx;
    this.headY = ny;
    this.visited.add(k);
    this.len++;

    if (ny > this.maxY) this.maxY = ny;
    return true;
  }

  die(msg) {
    this.dead = true;
    this.deathReason = msg;
  }
}

// ---------- Chunk generator (guaranteed solvable) ----------
function generateChunk(seed, idx, chunksLoaded) {
  const yBase = idx * CHUNK_H;
  const rng = new Rng(seed ^ Math.imul(idx + 1, 0x9e3779b9));
  const turnDifficulty = clamp(((chunksLoaded || 1) - START_CHUNKS) / 14, 0, 1);
  const pairChance = 0.3 + 0.6 * turnDifficulty;
  const dipChance = 0.35 + 0.6 * turnDifficulty;
  const requiredDips = Math.floor(turnDifficulty * 4);
  const shiftMax = Math.max(1, Math.round(MAX_ROW_SHIFT + 2 - 3 * turnDifficulty));
  const zigzagBias = 0.15 + 0.75 * turnDifficulty;
  const forcedReversalsTarget = Math.floor(turnDifficulty * 8);
  const edgeSweepChance = Math.max(0.03, LONG_SWEEP_CHANCE * (1 - 0.75 * turnDifficulty));

  const free = new Set();
  const path = [];

  function add(x, y) {
    const k = y * GRID_W + x;
    if (!free.has(k)) {
      free.add(k);
      path.push(k);
    }
  }

  function pickTargetX(currentX, forceLongSweep, preferredDir, forcePreferredDir) {
    let targetX;
    if (!forceLongSweep && preferredDir && (forcePreferredDir || rng.next() < zigzagBias)) {
      const span = 1 + rng.int(shiftMax);
      targetX = clamp(currentX + preferredDir * span, 0, GRID_W - 1);
    } else if (rng.next() < edgeSweepChance) {
      targetX = rng.next() < 0.5 ? 0 : GRID_W - 1;
    } else {
      const span = 1 + rng.int(shiftMax);
      const dir = rng.next() < 0.5 ? -1 : +1;
      targetX = clamp(currentX + dir * span, 0, GRID_W - 1);
    }

    if (targetX === currentX) {
      targetX =
        currentX < (GRID_W >> 1) ? Math.min(GRID_W - 1, currentX + 1) : Math.max(0, currentX - 1);
    }

    if (forcePreferredDir && preferredDir) {
      const actualDir = targetX > currentX ? 1 : -1;
      if (actualDir !== preferredDir) {
        const span = forceLongSweep ? 2 : 1;
        targetX = clamp(currentX + preferredDir * span, 0, GRID_W - 1);
      }
    }

    if (forceLongSweep && Math.abs(targetX - currentX) < 2) {
      if (currentX <= 1) targetX = Math.min(GRID_W - 1, currentX + 2);
      else if (currentX >= GRID_W - 2) targetX = Math.max(0, currentX - 2);
      else targetX = currentX + (rng.next() < 0.5 ? -2 : 2);
    }

    return targetX;
  }

  let x = GRID_W - 1;
  let y = yBase;
  let downMoves = 0;
  let lastHorizDir = 0;
  let forcedReversalsDone = 0;
  add(x, y);

  while (y < yBase + CHUNK_H - 1) {
    const localY = y - yBase;
    const canUseTwoRows = localY <= CHUNK_H - 3;
    const needMoreDips = downMoves < requiredDips;
    const useTwoRows = canUseTwoRows && (needMoreDips || rng.next() < pairChance);
    const forceReversal = lastHorizDir !== 0 && forcedReversalsDone < forcedReversalsTarget;
    const preferredDir = -lastHorizDir;
    const targetX = pickTargetX(x, useTwoRows && needMoreDips, preferredDir, forceReversal);
    const segmentDir = x === targetX ? 0 : targetX > x ? 1 : -1;

    if (useTwoRows) {
      while (x !== targetX) {
        const dir = targetX > x ? 1 : -1;
        const remaining = Math.abs(targetX - x);

        if (remaining >= 2 && (downMoves < requiredDips || rng.next() < dipChance)) {
          const nx1 = x + dir;
          const nx2 = x + dir * 2;
          add(x, y + 1);
          add(nx1, y + 1);
          add(nx1, y);
          add(nx2, y);
          x = nx2;
          downMoves++;
        } else {
          x += dir;
          add(x, y);
        }
      }

      if (segmentDir !== 0) {
        if (lastHorizDir !== 0 && segmentDir !== lastHorizDir) forcedReversalsDone++;
        lastHorizDir = segmentDir;
      }
      add(x, y + 1);
      y += 2;
      add(x, y);
    } else {
      while (x !== targetX) {
        x += targetX > x ? 1 : -1;
        add(x, y);
      }

      if (segmentDir !== 0) {
        if (lastHorizDir !== 0 && segmentDir !== lastHorizDir) forcedReversalsDone++;
        lastHorizDir = segmentDir;
      }
      y += 1;
      add(x, y);
    }
  }

  while (x !== GRID_W - 1) {
    x += GRID_W - 1 > x ? 1 : -1;
    add(x, y);
  }

  return { idx, yBase, free, path, freeCount: free.size };
}

// ---------- UI (refactored into components) ----------
class UIRoot {
  constructor(scene) {
    this.scene = scene;
    this.lastRun = null;

    this.screenFx = new ScreenTreatment(scene);
    this.hud = new HudBar(scene);
    this.minimap = new MiniMap(scene);
    this.toastQueue = new ToastQueue(scene);
    this.banner = new Banner(scene);
    this.particles = new ParticleSystem(scene);
    this.callouts = new CalloutLayer(scene);
    this.overlay = new Overlay(scene);

    this.setMode(STATE_MENU, "", {});
  }

  setLastRun(stats) {
    this.lastRun = stats || null;
    this.overlay.setLastRun(this.lastRun);
  }

  setMode(state, msg, ctx) {
    this.hud.setVisible(state === STATE_PLAY);
    this.minimap.setVisible(state === STATE_PLAY);
    this.overlay.setMode(state, msg || "", ctx || {});
  }

  toast(text, type) {
    this.toastQueue.push(text, type || "info");
  }

  onExpand(snake) {
    // Expansion ceremony: banner + particles + toast
    const level = snake && snake.world ? snake.world.revealed : 1;
    this.banner.show(`LEVEL ${level}`, "accent", 0.85);
    this.toastQueue.push(`LEVEL ${level}`, "accent");
    this.particles.queueBurst(snake.headX, snake.headY, "accent");
  }

  onRespawn(snake) {
    // Respawn ceremony: distinct from death
    const reason = snake.lastRespawnReason || "RESPAWN";
    this.toastQueue.push(`RESPAWNED (${reason})  LIVES ${snake.lives}`, "danger");
    this.banner.show("RESPAWN", "danger", 0.65);
    this.callouts.spawn(snake.headX, snake.headY, reason);
    this.particles.queueBurst(snake.headX, snake.headY, "danger");
  }

  update(state, snake, world, bestChunk, showPath, dt) {
    // Screen FX is always on (arcade treatment)
    this.screenFx.update(state, snake, world, dt);

    // HUD + minimap only meaningful in play
    this.hud.update(state, snake, world, bestChunk, showPath, dt);
    this.minimap.update(state, snake, world, dt);

    // World-anchored layers need world camera info (set during world.draw)
    this.particles.update(state, snake, world, dt);
    this.callouts.update(state, snake, world, dt);

    // Foreground layers
    this.toastQueue.update(state, dt);
    this.banner.update(state, dt);

    // Menu / Dead overlays
    this.overlay.update(state, snake, world, bestChunk, dt);
  }
}

class ScreenTreatment {
  constructor(scene) {
    this.scene = scene;

    this.scanImg = null;
    this.vignetteImg = null;
    this.border = scene.add.graphics().setDepth(6);

    this.ensureTextures();
    this.createImages();
  }

  ensureTextures() {
    const scanKey = "__hs_scanlines";
    const vigKey = "__hs_vignette";

    if (!this.scene.textures.exists(scanKey)) {
      const tmp = this.scene.make.graphics({ x: 0, y: 0, add: false });
      const w = SCREEN_W;
      const h = PLAY_H;

      // transparent background by default
      for (let y = 0; y < h; y += 3) {
        tmp.fillStyle(0xffffff, 0.06);
        tmp.fillRect(0, y, w, 1);
      }

      tmp.generateTexture(scanKey, w, h);
      tmp.destroy();
    }

    if (!this.scene.textures.exists(vigKey)) {
      const tmp = this.scene.make.graphics({ x: 0, y: 0, add: false });
      const w = SCREEN_W;
      const h = PLAY_H;

      // edge darkening (cheap vignette)
      const steps = 10;
      const pad = 70;
      for (let i = 0; i < steps; i++) {
        const t = (i + 1) / steps;
        const a = THEME.vignetteAlpha * t * 0.18;

        // top
        tmp.fillStyle(0x000000, a);
        tmp.fillRect(0, i * (pad / steps), w, pad / steps);

        // bottom
        tmp.fillStyle(0x000000, a);
        tmp.fillRect(0, h - (i + 1) * (pad / steps), w, pad / steps);

        // left
        tmp.fillStyle(0x000000, a);
        tmp.fillRect(i * (pad / steps), 0, pad / steps, h);

        // right
        tmp.fillStyle(0x000000, a);
        tmp.fillRect(w - (i + 1) * (pad / steps), 0, pad / steps, h);
      }

      tmp.generateTexture(vigKey, w, h);
      tmp.destroy();
    }
  }

  createImages() {
    const scanKey = "__hs_scanlines";
    const vigKey = "__hs_vignette";

    this.scanImg = this.scene.add.image(0, PLAY_TOP, scanKey).setOrigin(0).setDepth(6);
    this.scanImg.setAlpha(THEME.scanlinesAlpha);

    this.vignetteImg = this.scene.add.image(0, PLAY_TOP, vigKey).setOrigin(0).setDepth(6);
    this.vignetteImg.setAlpha(1);
  }

  update(state, snake, world, dt) {
    // Border around play area (arcade bezel)
    this.border.clear();

    const pulse = 0.5 + 0.5 * Math.sin(this.scene.time.now * 0.004);
    const waiting = snake && snake.waitingForMove;
    const c = waiting ? THEME.warn : THEME.accent;
    const a = waiting ? 0.55 + 0.35 * pulse : 0.28;

    const frameTop = PLAY_TOP - 2;
    const frameBottom = PLAY_BOTTOM + 2;

    this.border.lineStyle(2, c, a);
    this.border.strokeRect(8, frameTop, SCREEN_W - 16, frameBottom - frameTop);

    // Little corner ticks for arcade feel
    this.border.lineStyle(2, c, a * 0.9);
    const L = 18;
    const x0 = 8,
      y0 = frameTop,
      x1 = SCREEN_W - 8,
      y1 = frameBottom;
    this.border.beginPath();
    // top-left
    this.border.moveTo(x0, y0 + L);
    this.border.lineTo(x0, y0);
    this.border.lineTo(x0 + L, y0);
    // top-right
    this.border.moveTo(x1 - L, y0);
    this.border.lineTo(x1, y0);
    this.border.lineTo(x1, y0 + L);
    // bottom-left
    this.border.moveTo(x0, y1 - L);
    this.border.lineTo(x0, y1);
    this.border.lineTo(x0 + L, y1);
    // bottom-right
    this.border.moveTo(x1 - L, y1);
    this.border.lineTo(x1, y1);
    this.border.lineTo(x1, y1 - L);
    this.border.strokePath();
  }
}

class HudBar {
  constructor(scene) {
    this.scene = scene;

    this.gfx = scene.add.graphics().setDepth(10);
    this.textA = initPixelText(scene.add.text(0, 0, "", this.styleSmall()).setDepth(11));
    this.textB = initPixelText(scene.add.text(0, 0, "", this.styleSmall()).setDepth(11));
    this.textC = initPixelText(scene.add.text(0, 0, "", this.styleSmall()).setDepth(11));

    this.bigTime = initPixelText(scene.add.text(0, 0, "", this.styleBig()).setDepth(11));
    this.hintChip = initPixelText(scene.add.text(0, 0, "", this.styleChip()).setDepth(12), 1);

    this.visible = true;
    this.setVisible(false);
  }

  styleSmall() {
    return {
      fontFamily: FONT_PIXEL,
      fontSize: "12px",
      color: THEME.text,
    };
  }

  styleBig() {
    return {
      fontFamily: FONT_PIXEL,
      fontSize: "17px",
      color: THEME.text,
      fontStyle: "bold",
    };
  }

  styleChip() {
    return {
      fontFamily: FONT_PIXEL,
      fontSize: "10px",
      color: "#0B1220",
      fontStyle: "bold",
    };
  }

  setVisible(v) {
    this.visible = !!v;
    this.gfx.setVisible(this.visible);
    this.textA.setVisible(this.visible);
    this.textB.setVisible(this.visible);
    this.textC.setVisible(this.visible);
    this.bigTime.setVisible(this.visible);
    this.hintChip.setVisible(this.visible);
  }

  update(state, snake, world, bestChunk, showPath, dt) {
    if (!this.visible) return;
    if (!snake || !world) return;

    const x = 10;
    const y = 10;
    const w = SCREEN_W - 20;
    const h = UI_H - 20;

    const segW = Math.floor(w / 3);
    const segA = { x: x, y: y, w: segW, h };
    const segB = { x: x + segW, y: y, w: segW, h };
    const segC = { x: x + segW * 2, y: y, w: w - segW * 2, h };

    // draw panel
    this.gfx.clear();
    this.gfx.fillStyle(THEME.hudBg, 0.98);
    this.gfx.fillRoundedRect(x, y, w, h, 10);
    this.gfx.lineStyle(2, THEME.hudStroke, 0.55);
    this.gfx.strokeRoundedRect(x, y, w, h, 10);

    // separators
    this.gfx.lineStyle(1, THEME.hudStroke, 0.25);
    this.gfx.beginPath();
    this.gfx.moveTo(segB.x, y + 8);
    this.gfx.lineTo(segB.x, y + h - 8);
    this.gfx.moveTo(segC.x, y + 8);
    this.gfx.lineTo(segC.x, y + h - 8);
    this.gfx.strokePath();

    // level (big)
    const level = snake.chunkLevel();
    this.bigTime.setText(`LEVEL ${level}`);
    this.bigTime.setPosition(segA.x + 14, segA.y + 6);

    // left subline
    const spd = Math.round(1000 / snake.moveIntervalMs());
    this.textA.setText(`BEST ${bestChunk}  LIVES ${snake.lives}  SPD ${spd}`);
    this.textA.setPosition(segA.x + 14, segA.y + 28);

    // center
    const revealed = world.revealedHeight;
    this.textB.setText(`HEIGHT ${snake.maxY}\nPATH ${showPath ? "ON" : "OFF"}`);
    this.textB.setPosition(segB.x + 14, segB.y + 8);

    // right
    const cellsVisited = snake.len;
    const cellsTotal = world.totalFree;
    this.textC.setText(`SCORE ${snake.currentScore()}\nVIS ${cellsVisited}/${cellsTotal}`);
    this.textC.setPosition(segC.x + 14, segC.y + 8);

    // hint chip when waiting for move
    if (snake.waitingForMove) {
      const pulse = 0.5 + 0.5 * Math.sin(this.scene.time.now * 0.008);
      const chipText = snake.waitingReason || "CHOOSE MOVE";
      this.hintChip.setText(chipText);

      const cx = segC.x + segC.w - 14;
      const cy = segC.y + segC.h - 10;

      // draw chip background
      const tw = this.hintChip.width + 18;
      const th = 20;
      const rx = cx - tw;
      const ry = cy - th;

      this.gfx.fillStyle(THEME.warn, 0.85);
      this.gfx.fillRoundedRect(rx, ry, tw, th, 8);
      this.gfx.lineStyle(2, THEME.warn, 0.55 + 0.35 * pulse);
      this.gfx.strokeRoundedRect(rx, ry, tw, th, 8);

      this.hintChip.setPosition(rx + 9, ry + 2);
      this.hintChip.setVisible(true);
    } else {
      this.hintChip.setVisible(false);
    }
  }
}

class MiniMap {
  constructor(scene) {
    this.scene = scene;
    this.gfx = scene.add.graphics().setDepth(10);
    this.visible = true;
    this.setVisible(false);
  }

  setVisible(v) {
    this.visible = !!v;
    this.gfx.setVisible(this.visible);
  }

  update(state, snake, world, dt) {
    if (!this.visible) return;
    if (!snake || !world) return;

    const x = SCREEN_W - 22;
    const y = PLAY_TOP + 16;
    const h = PLAY_BOTTOM - PLAY_TOP - 32;
    const w = 10;

    const revealed = Math.max(1, world.revealedHeight);
    const headY = clamp(snake.headY, 0, revealed);
    const maxY = clamp(snake.maxY, 0, revealed);

    const headT = headY / revealed;
    const maxT = maxY / revealed;

    const headPy = y + h - headT * h;
    const maxPy = y + h - maxT * h;

    this.gfx.clear();

    // background
    this.gfx.fillStyle(0x000000, 0.22);
    this.gfx.fillRoundedRect(x - 4, y - 6, w + 8, h + 12, 8);

    // bar
    this.gfx.fillStyle(0xffffff, 0.10);
    this.gfx.fillRoundedRect(x, y, w, h, 5);

    // chunk ticks (every CHUNK_H rows)
    this.gfx.lineStyle(1, THEME.accent, 0.12);
    const chunks = Math.max(1, world.revealed);
    for (let c = 1; c < chunks; c++) {
      const ty = y + h - (c * CHUNK_H / revealed) * h;
      this.gfx.beginPath();
      this.gfx.moveTo(x - 2, ty);
      this.gfx.lineTo(x + w + 2, ty);
      this.gfx.strokePath();
    }

    // markers
    this.gfx.fillStyle(THEME.accent, 0.9);
    this.gfx.fillRect(x - 2, headPy - 2, w + 4, 4);

    this.gfx.fillStyle(THEME.success, 0.9);
    this.gfx.fillRect(x - 2, maxPy - 2, w + 4, 4);
  }
}

class ToastQueue {
  constructor(scene) {
    this.scene = scene;
    this.gfx = scene.add.graphics().setDepth(14);
    this.text = scene
      .add.text(0, 0, "", {
        fontFamily: FONT_PIXEL,
        fontSize: "13px",
        color: THEME.text,
        fontStyle: "bold",
      })
      .setDepth(15)
      .setOrigin(0.5);
    initPixelText(this.text, 2);

    this.text.setShadow(1, 1, "#000000", 2, true, true);

    this.queue = [];
    this.active = null;
  }

  push(msg, type) {
    this.queue.push({ msg: String(msg || ""), type: type || "info" });
  }

  colorFor(type) {
    if (type === "danger") return THEME.danger;
    if (type === "accent") return THEME.accent;
    if (type === "success") return THEME.success;
    return THEME.accent;
  }

  update(state, dt) {
    // only show toasts during play (keeps overlays clean)
    if (state !== STATE_PLAY) {
      this.gfx.clear();
      this.text.setText("");
      this.active = null;
      this.queue.length = 0;
      return;
    }

    if (!this.active && this.queue.length) {
      const next = this.queue.shift();
      this.active = {
        msg: next.msg,
        type: next.type,
        t: 0,
        dur: 1100,
      };
      this.text.setText(next.msg);
    }

    if (!this.active) {
      this.gfx.clear();
      this.text.setText("");
      return;
    }

    this.active.t += dt;
    const t = this.active.t;
    const dur = this.active.dur;

    const fadeIn = 140;
    const fadeOut = 220;
    let a = 1;
    if (t < fadeIn) a = t / fadeIn;
    else if (t > dur - fadeOut) a = Math.max(0, (dur - t) / fadeOut);

    const y = PLAY_TOP + 18 + (1 - a) * -10;
    const x = SCREEN_W / 2;

    this.text.setPosition(x, y);
    this.text.setAlpha(a);

    const padX = 14;
    const padY = 8;
    const bw = this.text.width + padX * 2;
    const bh = 28;

    this.gfx.clear();
    const c = this.colorFor(this.active.type);

    this.gfx.fillStyle(0x000000, 0.35 * a);
    this.gfx.fillRoundedRect(x - bw / 2 + 2, y - bh / 2 + 2, bw, bh, 10);

    this.gfx.fillStyle(THEME.panelBg, 0.92 * a);
    this.gfx.fillRoundedRect(x - bw / 2, y - bh / 2, bw, bh, 10);

    this.gfx.lineStyle(2, c, 0.75 * a);
    this.gfx.strokeRoundedRect(x - bw / 2, y - bh / 2, bw, bh, 10);

    if (t >= dur) {
      this.active = null;
      this.gfx.clear();
      this.text.setText("");
    }
  }
}

class Banner {
  constructor(scene) {
    this.scene = scene;

    this.gfx = scene.add.graphics().setDepth(16);
    this.text = scene
      .add.text(SCREEN_W / 2, PLAY_TOP + 120, "", {
        fontFamily: FONT_PIXEL,
        fontSize: "24px",
        color: "#FFFFFF",
        fontStyle: "bold",
      })
      .setDepth(17)
      .setOrigin(0.5);
    initPixelText(this.text, 2);

    this.text.setShadow(2, 2, "#000000", 4, true, true);

    this.active = false;
    this.t = 0;
    this.dur = 850;
    this.kind = "accent";
  }

  show(msg, kind, durSec) {
    this.active = true;
    this.t = 0;
    this.kind = kind || "accent";
    this.dur = Math.max(450, Math.floor((durSec || 0.85) * 1000));
    this.text.setText(String(msg || ""));
  }

  colorFor(kind) {
    if (kind === "danger") return THEME.danger;
    if (kind === "success") return THEME.success;
    return THEME.accent;
  }

  update(state, dt) {
    if (state !== STATE_PLAY) {
      this.active = false;
      this.gfx.clear();
      this.text.setText("");
      return;
    }
    if (!this.active) return;

    this.t += dt;

    const t = this.t;
    const dur = this.dur;

    // scale pop-in + fade-out
    const inMs = 180;
    const outMs = 260;

    let a = 1;
    let s = 1;

    if (t < inMs) {
      const p = t / inMs;
      s = 0.85 + 0.15 * easeOutCubic(p);
      a = p;
    } else if (t > dur - outMs) {
      const p = (t - (dur - outMs)) / outMs;
      a = 1 - p;
      s = 1 + 0.02 * p;
    }

    const y = PLAY_TOP + 120;
    this.text.setPosition(SCREEN_W / 2, y);
    this.text.setAlpha(a);
    this.text.setScale(s);

    const c = this.colorFor(this.kind);

    const bw = Math.min(680, this.text.width + 80);
    const bh = 84;

    this.gfx.clear();
    this.gfx.fillStyle(0x000000, 0.32 * a);
    this.gfx.fillRoundedRect(SCREEN_W / 2 - bw / 2 + 3, y - bh / 2 + 3, bw, bh, 14);

    this.gfx.fillStyle(THEME.panelBg, 0.86 * a);
    this.gfx.fillRoundedRect(SCREEN_W / 2 - bw / 2, y - bh / 2, bw, bh, 14);

    this.gfx.lineStyle(3, c, 0.85 * a);
    this.gfx.strokeRoundedRect(SCREEN_W / 2 - bw / 2, y - bh / 2, bw, bh, 14);

    // top neon strip
    this.gfx.fillStyle(c, 0.20 * a);
    this.gfx.fillRect(SCREEN_W / 2 - bw / 2, y - bh / 2, bw, 6);

    if (t >= dur) {
      this.active = false;
      this.gfx.clear();
      this.text.setText("");
    }
  }
}

class CalloutLayer {
  constructor(scene) {
    this.scene = scene;
    this.items = [];
  }

  spawn(gridX, gridY, msg) {
    const t = this.scene.add
      .text(0, 0, String(msg || ""), {
        fontFamily: FONT_PIXEL,
        fontSize: "12px",
        color: "#FFFFFF",
        fontStyle: "bold",
      })
      .setDepth(13)
      .setOrigin(0.5);
    initPixelText(t, 1);

    t.setShadow(1, 1, "#000000", 3, true, true);

    this.items.push({
      text: t,
      gx: gridX,
      gy: gridY,
      t: 0,
      dur: 900,
    });
  }

  update(state, snake, world, dt) {
    if (state !== STATE_PLAY || !world) {
      // clean up
      for (const it of this.items) it.text.destroy();
      this.items.length = 0;
      return;
    }

    const cam = world.lastCamBottom || 0;

    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.t += dt;

      const p = it.t / it.dur;
      const a = p < 0.15 ? p / 0.15 : p > 0.85 ? (1 - p) / 0.15 : 1;

      const r = toScreen(it.gx, it.gy, cam);
      const y = r.y - 18 - 18 * p;
      const x = r.x + TILE * 0.5;

      it.text.setPosition(x, y);
      it.text.setAlpha(clamp(a, 0, 1));

      if (it.t >= it.dur) {
        it.text.destroy();
        this.items.splice(i, 1);
      }
    }
  }
}

class ParticleSystem {
  constructor(scene) {
    this.scene = scene;
    this.gfx = scene.add.graphics().setDepth(12);

    this.pendingBursts = [];
    this.parts = [];
  }

  queueBurst(gx, gy, kind) {
    this.pendingBursts.push({ gx, gy, kind: kind || "accent" });
  }

  colorFor(kind) {
    if (kind === "danger") return THEME.danger;
    if (kind === "success") return THEME.success;
    return THEME.accent;
  }

  flushBursts(world) {
    if (!world || this.pendingBursts.length === 0) return;

    const cam = world.lastCamBottom || 0;

    while (this.pendingBursts.length) {
      const b = this.pendingBursts.shift();
      const r = toScreen(b.gx, b.gy, cam);
      const cx = r.x + TILE * 0.5;
      const cy = r.y + TILE * 0.5;

      const col = this.colorFor(b.kind);

      const n = 22;
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = 40 + Math.random() * 120;
        this.parts.push({
          x: cx,
          y: cy,
          vx: Math.cos(a) * sp,
          vy: Math.sin(a) * sp - 40,
          life: 0,
          dur: 420 + Math.random() * 220,
          size: 2 + Math.random() * 5,
          col,
        });
      }
    }
  }

  update(state, snake, world, dt) {
    if (state !== STATE_PLAY) {
      this.pendingBursts.length = 0;
      this.parts.length = 0;
      this.gfx.clear();
      return;
    }

    this.flushBursts(world);

    this.gfx.clear();
    if (this.parts.length === 0) return;

    for (let i = this.parts.length - 1; i >= 0; i--) {
      const p = this.parts[i];
      p.life += dt;
      const t = p.life / p.dur;

      // integrate
      const s = dt / 1000;
      p.vy += 260 * s; // gravity
      p.x += p.vx * s;
      p.y += p.vy * s;

      const a = t < 0.2 ? t / 0.2 : 1 - t;
      const alpha = clamp(a, 0, 1) * 0.8;

      this.gfx.fillStyle(p.col, alpha);
      this.gfx.fillRect(p.x - p.size * 0.5, p.y - p.size * 0.5, p.size, p.size);

      if (p.life >= p.dur) this.parts.splice(i, 1);
    }
  }
}

class Overlay {
  constructor(scene) {
    this.scene = scene;

    this.backdrop = scene.add.graphics().setDepth(20);
    this.panel = scene.add.graphics().setDepth(21);

    this.title = scene
      .add.text(SCREEN_W / 2, SCREEN_H / 2 - 90, "", {
        fontFamily: FONT_PIXEL,
        fontSize: "36px",
        color: "#FFFFFF",
        align: "center",
        fontStyle: "bold",
      })
      .setOrigin(0.5)
      .setDepth(22);
    initPixelText(this.title, 2);

    this.sub = scene
      .add.text(SCREEN_W / 2, SCREEN_H / 2 - 10, "", {
        fontFamily: FONT_PIXEL,
        fontSize: "13px",
        color: THEME.text,
        align: "center",
      })
      .setOrigin(0.5)
      .setDepth(22);
    initPixelText(this.sub, 2);

    this.help = scene
      .add.text(SCREEN_W / 2, SCREEN_H / 2 + 90, "", {
        fontFamily: FONT_PIXEL,
        fontSize: "12px",
        color: THEME.muted,
        align: "center",
      })
      .setOrigin(0.5)
      .setDepth(22);
    initPixelText(this.help, 2);

    this.stats = scene
      .add.text(SCREEN_W / 2, SCREEN_H / 2 + 30, "", {
        fontFamily: FONT_PIXEL,
        fontSize: "12px",
        color: THEME.text,
        align: "center",
      })
      .setOrigin(0.5)
      .setDepth(22);
    initPixelText(this.stats, 2);

    this.board = scene
      .add.text(SCREEN_W / 2, SCREEN_H / 2 + 150, "", {
        fontFamily: FONT_PIXEL,
        fontSize: "11px",
        color: "#CFF1FF",
        align: "center",
      })
      .setOrigin(0.5)
      .setDepth(22);
    initPixelText(this.board, 2);

    this.title.setShadow(2, 2, "#000000", 4, true, true);
    this.sub.setShadow(1, 1, "#000000", 2, true, true);
    this.help.setShadow(1, 1, "#000000", 2, true, true);
    this.stats.setShadow(1, 1, "#000000", 2, true, true);
    this.board.setShadow(1, 1, "#000000", 2, true, true);

    this.mode = STATE_MENU;
    this.msg = "";
    this.ctx = { bestChunk: 1 };
    this.lastRun = null;

    this.modeSince = scene.time.now;
    this.setMode(STATE_MENU, "", { bestChunk: 1, leaderboard: [], nameEntry: null });
  }

  setLastRun(stats) {
    this.lastRun = stats || null;
  }

  setMode(state, msg, ctx) {
    if (state !== this.mode) this.modeSince = this.scene.time.now;
    this.mode = state;
    this.msg = msg || "";
    this.ctx = ctx || { bestChunk: 1 };

    const show = state !== STATE_PLAY;

    this.backdrop.setVisible(show);
    this.panel.setVisible(show);
    this.title.setVisible(show);
    this.sub.setVisible(show);
    this.help.setVisible(show);
    this.stats.setVisible(show);
    this.board.setVisible(show);

    if (!show) return;

    if (state === STATE_MENU) {
      this.title.setText("CAVE SNAKE");
      this.sub.setText(
        "SLITHER FAST. CLAIM EVERY TILE."
      );
      this.help.setText(
        "WASD / ARROWS TO MOVE. FIRST MOVE STARTS.\n" +
        "I = NEW MAP   O = TOGGLE PATH"
      );
      const notice = this.ctx.highScoreNotice ? `\n${this.ctx.highScoreNotice}` : "";
      this.stats.setText(`BEST LVL ${this.ctx.bestChunk || 1}   PRESS ANY ARROW TO START${notice}`);
      this.board.setText(this.formatBoard(this.ctx.leaderboard));
      this.title.setColor("#FFFFFF");
      this.sub.setColor("#EAF4FF");
      this.help.setColor("#F4FBFF");
      this.stats.setColor(this.ctx.highScoreNotice ? "#FFF06A" : "#CFF1FF");
      this.board.setColor("#CFF1FF");
    } else if (state === STATE_ENTRY) {
      const entry = this.ctx.nameEntry || { score: 0, level: 1, chars: ["A", "A", "A"], cursor: 0 };
      const blink = Math.floor(this.scene.time.now / 220) % 2 === 0;
      this.title.setText("NEW HIGH SCORE");
      this.sub.setText(`SCORE ${entry.score}   LEVEL ${entry.level}`);
      this.help.setText("UP/DOWN LETTER   LEFT/RIGHT SLOT   I OR ENTER SAVE");
      this.stats.setText(this.formatEntryName(entry, blink));
      this.board.setText(this.formatBoard(this.ctx.leaderboard));
      this.title.setColor("#FFFFFF");
      this.sub.setColor("#EAF4FF");
      this.help.setColor("#F4FBFF");
      this.stats.setColor("#FFF06A");
      this.board.setColor("#CFF1FF");
    } else {
      this.title.setText("GAME OVER");
      const reason = this.msg ? this.msg : "YOU LOST";
      this.sub.setText(reason);

      if (this.lastRun) {
        const s = this.lastRun;
        this.stats.setText(
          `SCORE: ${s.score}   LVL: ${s.level}   BEST: ${s.bestLevel}\n` +
          `HEIGHT: ${s.maxY}   REVEALED: ${s.revealed}`
        );
      } else {
        this.stats.setText("");
      }

      this.help.setText("Press any key to continue.\nThen MOVE to start.");
      this.board.setText(this.formatBoard(this.ctx.leaderboard));
      this.title.setColor("#FFFFFF");
      this.sub.setColor(THEME.text);
      this.help.setColor(THEME.text);
      this.stats.setColor(THEME.text);
      this.board.setColor("#C7D8EA");
    }
  }

  formatBoard(entries) {
    const list = Array.isArray(entries) ? entries.slice(0, 8) : [];
    if (list.length === 0) return "LEADERBOARD\nNO SCORES YET";

    const rows = ["LEADERBOARD"];
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const rank = String(i + 1).padStart(2, " ");
      const nm = String((e && e.name) || "AAA").toUpperCase().padEnd(3, " ").slice(0, 3);
      const lvl = Math.max(1, ((e && e.level) | 0));
      const score = Math.max(0, ((e && e.score) | 0));
      rows.push(`${rank}. ${nm}   ${score}  (LVL ${lvl})`);
    }
    return rows.join("\n");
  }

  formatEntryName(entry, blink) {
    const chars = (entry && Array.isArray(entry.chars) ? entry.chars : ["A", "A", "A"]).slice(0, 3);
    while (chars.length < 3) chars.push("A");
    const cursor = Math.max(0, Math.min(2, (entry && entry.cursor) | 0));

    const out = [];
    for (let i = 0; i < 3; i++) {
      const c = String(chars[i] || "A").toUpperCase().slice(0, 1);
      out.push(i === cursor && blink ? `[${c}]` : ` ${c} `);
    }
    return out.join(" ");
  }

  menuSnakePerimeter(x, y, w, h, inset) {
    const left = x + inset;
    const right = x + w - inset;
    const top = y + inset;
    const bottom = y + h - inset;
    return (right - left) * 2 + (bottom - top) * 2;
  }

  menuSnakePoint(x, y, w, h, inset, dist) {
    const left = x + inset;
    const right = x + w - inset;
    const top = y + inset;
    const bottom = y + h - inset;
    const topLen = right - left;
    const rightLen = bottom - top;
    const bottomLen = topLen;
    const leftLen = rightLen;
    const perimeter = topLen + rightLen + bottomLen + leftLen;

    let d = ((dist % perimeter) + perimeter) % perimeter;
    if (d < topLen) return { x: left + d, y: top };
    d -= topLen;
    if (d < rightLen) return { x: right, y: top + d };
    d -= rightLen;
    if (d < bottomLen) return { x: right - d, y: bottom };
    d -= bottomLen;
    return { x: left, y: bottom - d };
  }

  drawMenuSnake(x, y, w, h, pulse) {
    const inset = 10;
    const perimeter = this.menuSnakePerimeter(x, y, w, h, inset);
    const headDist = (this.scene.time.now * 0.24) % perimeter;
    const segments = 13;
    const spacing = 11;

    for (let i = segments - 1; i >= 0; i--) {
      const d = headDist - i * spacing;
      const p = this.menuSnakePoint(x, y, w, h, inset, d);
      const t = 1 - i / (segments - 1);
      const isHead = i === 0;
      const size = isHead ? 8 : 6;
      const alpha = (isHead ? 0.9 : 0.25 + 0.55 * t) * (0.78 + 0.22 * pulse);
      const color = isHead ? 0xfff06a : THEME.tileTrail;

      this.panel.fillStyle(color, alpha);
      this.panel.fillRect(
        Math.round(p.x - size * 0.5),
        Math.round(p.y - size * 0.5),
        size,
        size
      );
    }
  }

  update(state, snake, world, bestChunk, dt) {
    if (this.mode === STATE_PLAY) return;

    this.backdrop.clear();
    this.panel.clear();

    if (this.mode === STATE_MENU) {
      // centered title + leaderboard panel
      const fadeT = clamp((this.scene.time.now - this.modeSince) / 300, 0, 1);
      const a = 0.48 + 0.12 * fadeT;

      this.backdrop.fillStyle(0x000000, a);
      this.backdrop.fillRect(0, 0, SCREEN_W, SCREEN_H);

      // panel
      const w = 700;
      const h = 450;
      const x = (SCREEN_W - w) / 2;
      const y = (SCREEN_H - h) / 2 - 12;

      const pulse = 0.5 + 0.5 * Math.sin(this.scene.time.now * 0.004);
      const borderA = 0.55 + 0.25 * pulse;

      this.panel.fillStyle(THEME.panelBg, 0.97);
      this.panel.fillRoundedRect(x, y, w, h, 12);
      this.panel.lineStyle(3, THEME.panelStroke, Math.max(0.8, borderA));
      this.panel.strokeRoundedRect(x, y, w, h, 12);

      // neon strip
      this.panel.fillStyle(THEME.panelStroke, 0.18);
      this.panel.fillRect(x, y, w, 6);
      this.drawMenuSnake(x, y, w, h, pulse);

      // centered text layout
      const wobble = Math.sin(this.scene.time.now * 0.006) * 2;
      this.title.setPosition(SCREEN_W / 2, y + 56 + wobble).setFontSize(28);
      this.sub.setPosition(SCREEN_W / 2, y + 118).setFontSize(14);
      this.board.setPosition(SCREEN_W / 2, y + 244).setFontSize(11);
      this.help.setPosition(SCREEN_W / 2, y + 376).setFontSize(11);
      this.stats.setPosition(SCREEN_W / 2, y + 410).setFontSize(11);
      this.stats.setVisible(true);
      this.help.setVisible(true);
      this.board.setVisible(true);
    } else if (this.mode === STATE_ENTRY) {
      const fadeT = clamp((this.scene.time.now - this.modeSince) / 220, 0, 1);
      const a = 0.56 + 0.14 * fadeT;

      this.backdrop.fillStyle(0x000000, a);
      this.backdrop.fillRect(0, 0, SCREEN_W, SCREEN_H);

      const w = 700;
      const h = 450;
      const x = (SCREEN_W - w) / 2;
      const y = (SCREEN_H - h) / 2 - 12;

      const pulse = 0.5 + 0.5 * Math.sin(this.scene.time.now * 0.006);
      const borderA = 0.70 + 0.24 * pulse;

      this.panel.fillStyle(THEME.panelBg, 0.96);
      this.panel.fillRoundedRect(x, y, w, h, 12);
      this.panel.lineStyle(3, THEME.warn, borderA);
      this.panel.strokeRoundedRect(x, y, w, h, 12);
      this.panel.fillStyle(THEME.warn, 0.18);
      this.panel.fillRect(x, y, w, 6);

      const entry = this.ctx.nameEntry || { level: 1, chars: ["A", "A", "A"], cursor: 0 };
      const blink = Math.floor(this.scene.time.now / 220) % 2 === 0;
      this.stats.setText(this.formatEntryName(entry, blink));

      this.title.setPosition(SCREEN_W / 2, y + 56).setFontSize(26);
      this.sub.setPosition(SCREEN_W / 2, y + 118).setFontSize(13);
      this.stats.setPosition(SCREEN_W / 2, y + 188).setFontSize(24);
      this.board.setPosition(SCREEN_W / 2, y + 300).setFontSize(11);
      this.help.setPosition(SCREEN_W / 2, y + 418).setFontSize(10);
      this.stats.setVisible(true);
      this.help.setVisible(true);
      this.board.setVisible(true);
    } else if (this.mode === STATE_DEAD) {
      // full overlay
      this.backdrop.fillStyle(0x000000, 0.68);
      this.backdrop.fillRect(0, 0, SCREEN_W, SCREEN_H);

      const w = 660;
      const h = 320;
      const x = (SCREEN_W - w) / 2;
      const y = (SCREEN_H - h) / 2 - 30;

      const pulse = 0.5 + 0.5 * Math.sin(this.scene.time.now * 0.004);
      const borderA = 0.70 + 0.25 * pulse;

      this.panel.fillStyle(THEME.panelBg, 0.95);
      this.panel.fillRoundedRect(x, y, w, h, 14);
      this.panel.lineStyle(3, THEME.dangerStroke, borderA);
      this.panel.strokeRoundedRect(x, y, w, h, 14);
      this.panel.fillStyle(THEME.dangerStroke, 0.18);
      this.panel.fillRect(x, y, w, 6);

      this.title.setPosition(SCREEN_W / 2, y + 72).setFontSize(34);
      this.sub.setPosition(SCREEN_W / 2, y + 132).setFontSize(13);
      this.stats.setPosition(SCREEN_W / 2, y + 202).setFontSize(12);
      this.help.setPosition(SCREEN_W / 2, y + 272).setFontSize(12);
      this.stats.setVisible(true);
      this.help.setVisible(true);
      this.board.setVisible(false);
    }
  }
}

function drawArrowTri(gfx, x, y, dir, size, col, alpha) {
  gfx.fillStyle(col, alpha);
  gfx.beginPath();
  if (dir > 0) {
    gfx.moveTo(x - size * 0.6, y - size);
    gfx.lineTo(x - size * 0.6, y + size);
    gfx.lineTo(x + size, y);
  } else {
    gfx.moveTo(x + size * 0.6, y - size);
    gfx.lineTo(x + size * 0.6, y + size);
    gfx.lineTo(x - size, y);
  }
  gfx.closePath();
  gfx.fillPath();
}

function easeOutCubic(t) {
  const u = 1 - t;
  return 1 - u * u * u;
}

// ---------- Audio FX ----------
class FX {
  constructor(scene) {
    this.scene = scene;
  }

  toneAt(t, freq, dur, vol, type) {
    try {
      const ctx = this.scene.sound.context;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = type || "square";
      osc.frequency.setValueAtTime(freq, t);

      gain.gain.setValueAtTime(Math.max(0.0001, vol || 0.08), t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(t);
      osc.stop(t + dur);
    } catch (e) { }
  }

  beep(freq, dur, vol, type) {
    try {
      const ctx = this.scene.sound.context;
      this.toneAt(ctx.currentTime, freq, dur, vol, type);
    } catch (e) { }
  }

  levelUp() {
    try {
      const ctx = this.scene.sound.context;
      const t = ctx.currentTime;
      this.toneAt(t + 0.0, 700, 0.08, 0.1, "triangle");
      this.toneAt(t + 0.09, 900, 0.08, 0.1, "triangle");
      this.toneAt(t + 0.18, 1200, 0.1, 0.12, "triangle");
    } catch (e) { }
  }

  explode() {
    try {
      const ctx = this.scene.sound.context;
      const t = ctx.currentTime;
      this.toneAt(t + 0.0, 220, 0.08, 0.16, "sawtooth");
      this.toneAt(t + 0.07, 160, 0.1, 0.18, "square");
      this.toneAt(t + 0.16, 110, 0.12, 0.2, "triangle");
    } catch (e) { }
  }
}

class Leaderboard {
  constructor(storageKey, maxEntries) {
    this.storageKey = storageKey || "cave_snake_leaderboard";
    this.maxEntries = Math.max(3, maxEntries | 0);
    this.entries = [];
    this._load();
  }

  _load() {
    try {
      if (typeof localStorage === "undefined") return;
      const raw = localStorage.getItem(this.storageKey);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return;

      this.entries = parsed
        .map((e) => ({
          name: this._normalizeName(e && e.name),
          level: Math.max(1, (e && e.level) | 0),
          score: Math.max(0, (((e && e.score) | 0) || (Math.max(1, (e && e.level) | 0) * 1000))),
          t: Number((e && e.t) || 0) || Date.now(),
        }))
        .sort((a, b) => b.score - a.score || b.level - a.level || a.t - b.t)
        .slice(0, this.maxEntries);
    } catch (e) { }
  }

  _save() {
    try {
      if (typeof localStorage === "undefined") return;
      localStorage.setItem(this.storageKey, JSON.stringify(this.entries));
    } catch (e) { }
  }

  _normalizeName(name) {
    const clean = String(name || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 3);
    return (clean + "AAA").slice(0, 3);
  }

  getEntries() {
    return this.entries.slice();
  }

  qualifies(score) {
    const s = Math.max(0, score | 0);
    if (this.entries.length < this.maxEntries) return true;
    return s > this.entries[this.entries.length - 1].score;
  }

  add(name, score, level) {
    const entry = {
      name: this._normalizeName(name),
      score: Math.max(0, score | 0),
      level: Math.max(1, level | 0),
      t: Date.now(),
    };

    this.entries.push(entry);
    this.entries.sort((a, b) => b.score - a.score || b.level - a.level || a.t - b.t);
    let rank = this.entries.indexOf(entry) + 1;
    if (this.entries.length > this.maxEntries) {
      // If the entry was pushed out, return null rank.
      if (this.entries.indexOf(entry) >= this.maxEntries) rank = 0;
      this.entries.length = this.maxEntries;
    }
    this._save();
    return rank > 0 ? { rank } : null;
  }
}

class MusicEngine {
  constructor(audioCtx) {
    this.ctx = audioCtx;
    this.enabled = true;

    this.master = this.ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(this.ctx.destination);

    this.lead = this._makeVoice("square", 0.040);
    this.harmony = this._makeVoice("square", 0.022);
    this.bass = this._makeVoice("triangle", 0.045);

    // Timing: fixed-step sequencer (eighth notes)
    this.bpm = 142;
    this.stepSec = (60 / this.bpm) / 2; // 8th note
    this.baseBpm = this.bpm;
    this.bpmPerLevel = 2;
    this.maxBpm = 220;
    this.level = 1;
    this.lookahead = 0.20;
    this.intervalMs = 25;

    this._timer = null;
    this._playing = false;
    this._pos = 0;
    this._nextTime = 0;

    // ORIGINAL 4-bar loop (32 eighth-notes), E natural minor vibe.
    // Notes used: D5(74) E5(76) F#5(78) G5(79) A5(81) B5(83)
    this.leadPat = [
      76, null, 79, null, 83, null, 79, null, // bar 1
      81, null, 79, null, 78, null, 76, null, // bar 2
      74, null, 76, null, 79, null, 81, null, // bar 3
      83, null, 81, null, 79, null, 78, 76,   // bar 4 (resolve)
    ];

    // Bass hits (roots) aligned to bars: E2, D2, C2, B1 (simple progression feel).
    // Only schedule when not null (so it can ring out).
    this.bassPat = [
      40, null, null, null, 40, null, null, null, // E2
      38, null, null, null, 38, null, null, null, // D2
      36, null, null, null, 36, null, null, null, // C2
      35, null, null, null, 35, null, null, null, // B1
    ];
  }

  setActive(on) {
    if (!this.enabled) {
      this._fadeTo(0, 0.10);
      this._stopScheduler();
      return;
    }
    if (on) this.play();
    else this.stop();
  }

  play() {
    this._resumeIfNeeded();
    if (this._playing) {
      this._fadeTo(1, 0.18);
      return;
    }
    this._playing = true;
    this._pos = 0;
    this._nextTime = this.ctx.currentTime + 0.06;
    this._fadeTo(1, 0.22);
    this._startScheduler();
  }

  stop() {
    this._fadeTo(0, 0.18);
    this._stopScheduler();
    this._playing = false;
  }

  setEnabled(v) {
    this.enabled = !!v;
    if (!this.enabled) this.stop();
  }

  setLevel(level) {
    const nextLevel = Math.max(1, level | 0);
    if (nextLevel === this.level) return;
    this.level = nextLevel;

    const nextBpm = Math.min(
      this.maxBpm,
      this.baseBpm + (this.level - 1) * this.bpmPerLevel
    );
    if (nextBpm === this.bpm) return;

    this.bpm = nextBpm;
    this.stepSec = (60 / this.bpm) / 2;
  }

  _startScheduler() {
    if (this._timer) return;
    this._timer = setInterval(() => this._tick(), this.intervalMs);
  }

  _stopScheduler() {
    if (!this._timer) return;
    clearInterval(this._timer);
    this._timer = null;
  }

  _tick() {
    const now = this.ctx.currentTime;
    while (this._nextTime < now + this.lookahead) {
      this._scheduleStep(this._pos, this._nextTime);
      this._pos = (this._pos + 1) % this.leadPat.length;
      this._nextTime += this.stepSec;
    }
  }

  _scheduleStep(i, t) {
    const lead = this.leadPat[i];
    const harm = this._harmonyNote(lead);
    const bass = this.bassPat[i];

    // Lead & harmony: schedule rests explicitly (silence on rests)
    this._note(this.lead, t, lead, this.stepSec * 0.92);
    this._note(this.harmony, t, harm, this.stepSec * 0.90);

    // Bass: only schedule when there is a note, so it doesn't get hard-cut by rests
    if (bass != null) this._note(this.bass, t, bass, this.stepSec * 1.90);
  }

  // D I A T O N I C  3rd below (E natural minor) to keep harmony "correct".
  // (then drop an octave for separation)
  _harmonyNote(midi) {
    if (midi == null) return null;

    // Third below within E natural minor over the note set we use.
    // D->B, E->C, F#->D, G->E, A->F#, B->G
    const map = {
      74: 71, // D5 -> B4
      76: 72, // E5 -> C5
      78: 74, // F#5 -> D5
      79: 76, // G5 -> E5
      81: 78, // A5 -> F#5
      83: 79, // B5 -> G5
    };

    const h = map[midi];
    return h == null ? null : h - 12; // drop 1 octave
  }

  _note(voice, t, midi, dur) {
    const g = voice.gain.gain;

    if (midi == null) {
      g.setValueAtTime(0, t);
      return;
    }

    const f = 440 * Math.pow(2, (midi - 69) / 12);
    voice.osc.frequency.setValueAtTime(f, t);

    const a = 0.004; // attack
    const r = Math.min(0.06, dur * 0.35);

    g.setValueAtTime(0.0001, t);
    g.linearRampToValueAtTime(voice.vol, t + a);
    g.linearRampToValueAtTime(0.0001, t + dur + r);
  }

  _fadeTo(level, sec) {
    const t = this.ctx.currentTime;
    const target = (this.enabled ? level : 0) * 0.12; // master cap
    const g = this.master.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(target, t + Math.max(0.01, sec || 0.15));
  }

  _makeVoice(type, vol) {
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = type;
    gain.gain.value = 0;
    osc.connect(gain);
    gain.connect(this.master);
    osc.start();
    return { osc, gain, vol };
  }

  _resumeIfNeeded() {
    if (this.ctx && this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => { });
    }
  }
}
// ---------- RNG ----------
class Rng {
  constructor(seed) {
    this.s = (seed >>> 0) || 0x12345678;
  }
  nextU32() {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x >>> 0;
    return this.s;
  }
  next() {
    return this.nextU32() / 4294967296;
  }
  int(n) {
    return (this.next() * n) | 0;
  }
}

// ---------- Helpers ----------
function initPixelText(text, pad) {
  if (!text) return text;
  const p = pad == null ? 2 : pad;
  text.setPadding(p, p, p, p);
  text.setLineSpacing(2);
  return text;
}

function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

function toScreen(x, y, camBottom) {
  return {
    x: GRID_X0 + x * TILE,
    y: PLAY_BOTTOM - (y - camBottom + 1) * TILE,
  };
}

function cellCenter(x, y, camBottom) {
  const r = toScreen(x, y, camBottom);
  return { x: r.x + TILE * 0.5, y: r.y + TILE * 0.5 };
}
