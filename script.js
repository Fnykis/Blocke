const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");

const movesEl = document.getElementById("moves");
const crystallizedEl = document.getElementById("crystallized");
const statusEl = document.getElementById("status");

const newGameBtn = document.getElementById("newGame");
const revealBtn = document.getElementById("reveal");

const gridSize = 18;
const tileSize = canvas.width / gridSize;
const directions = [
  { x: 0, y: -1, name: "north" },
  { x: 1, y: 0, name: "east" },
  { x: 0, y: 1, name: "south" },
  { x: -1, y: 0, name: "west" },
];

const archetypes = [
  {
    name: "third-exit",
    description: "Hardens after leaving it three times.",
    trigger: (tile, state) => tile.leaveCount >= state.thresholds.thirdExit,
  },
  {
    name: "north-entry",
    description: "Hardens if entered from the north.",
    trigger: (tile) => tile.lastEntry === "north",
  },
  {
    name: "sequence",
    description: "Hardens if you repeat a direction twice.",
    trigger: (_tile, state) => state.recentDirections.slice(-2).every((d, _, arr) => d === arr[0]),
  },
  {
    name: "frequency",
    description: "Hardens if you visited similar tiles too often recently.",
    trigger: (tile, state) => {
      const recent = state.recentArchetypes.slice(-state.thresholds.frequencyWindow);
      const count = recent.filter((entry) => entry === tile.archetype).length;
      return count >= state.thresholds.frequencyCount;
    },
  },
  {
    name: "backtrack",
    description: "Hardens if you return too soon.",
    trigger: (tile, state) => {
      const recent = state.recentPositions.slice(-state.thresholds.backtrackWindow);
      return recent.some((pos) => pos.x === tile.x && pos.y === tile.y);
    },
  },
];

let game = null;

function createGame(seed = Math.random()) {
  const rng = mulberry32(Math.floor(seed * 1e9));
  const grid = [];
  const archetypePool = shuffle(archetypes, rng).slice(0, 4);
  const thresholds = {
    thirdExit: 3 + Math.floor(rng() * 2),
    frequencyWindow: 6 + Math.floor(rng() * 4),
    frequencyCount: 3 + Math.floor(rng() * 2),
    backtrackWindow: 4 + Math.floor(rng() * 3),
  };

  for (let y = 0; y < gridSize; y += 1) {
    const row = [];
    for (let x = 0; x < gridSize; x += 1) {
      const archetype = archetypePool[Math.floor(rng() * archetypePool.length)];
      row.push({
        x,
        y,
        archetype: archetype.name,
        state: "neutral",
        leaveCount: 0,
        visits: 0,
        lastEntry: null,
        reveal: 0,
      });
    }
    grid.push(row);
  }

  const player = { x: 1, y: 1 };
  const exit = { x: gridSize - 2, y: gridSize - 2 };

  grid[player.y][player.x].state = "safe";
  grid[exit.y][exit.x].state = "exit";

  return {
    rng,
    grid,
    player,
    exit,
    moveCount: 0,
    crystallized: 0,
    recentDirections: [],
    recentArchetypes: [],
    recentPositions: [],
    thresholds,
    archetypePool,
    message: "Learning...",
    revealTimer: 0,
  };
}

function drawBoard(state) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (let y = 0; y < gridSize; y += 1) {
    for (let x = 0; x < gridSize; x += 1) {
      const tile = state.grid[y][x];
      const isEdge = x === 0 || y === 0 || x === gridSize - 1 || y === gridSize - 1;
      const base = isEdge ? "#1c2234" : "#121827";
      let fill = base;

      if (tile.state === "wall") {
        fill = "#283146";
      } else if (tile.state === "safe") {
        fill = "#151e2f";
      }

      if (tile.reveal > 0 || state.revealTimer > 0) {
        const intensity = tile.reveal > 0 ? 0.8 : 0.4;
        fill = tint(fill, archetypeColor(tile.archetype), intensity);
      }

      ctx.fillStyle = fill;
      ctx.fillRect(x * tileSize, y * tileSize, tileSize, tileSize);

      if (tile.state === "exit") {
        ctx.fillStyle = "rgba(120, 255, 200, 0.35)";
        ctx.fillRect(x * tileSize + 4, y * tileSize + 4, tileSize - 8, tileSize - 8);
      }

      if (tile.state === "wall") {
        ctx.strokeStyle = "rgba(80, 100, 140, 0.5)";
        ctx.strokeRect(x * tileSize + 2, y * tileSize + 2, tileSize - 4, tileSize - 4);
      }
    }
  }

  ctx.fillStyle = "#fefefe";
  ctx.beginPath();
  ctx.arc(
    state.player.x * tileSize + tileSize / 2,
    state.player.y * tileSize + tileSize / 2,
    tileSize / 3,
    0,
    Math.PI * 2
  );
  ctx.fill();
}

function attemptMove(dx, dy) {
  if (!game) return;

  const nx = game.player.x + dx;
  const ny = game.player.y + dy;

  if (nx < 0 || ny < 0 || nx >= gridSize || ny >= gridSize) return;

  const destination = game.grid[ny][nx];
  if (destination.state === "wall") {
    flashMessage("Crystallized path blocks the way.");
    return;
  }

  const direction = directions.find((dir) => dir.x === dx && dir.y === dy);
  const currentTile = game.grid[game.player.y][game.player.x];

  currentTile.leaveCount += 1;
  applyTileRule(currentTile);

  destination.lastEntry = direction?.name ?? null;
  destination.visits += 1;

  game.player.x = nx;
  game.player.y = ny;

  game.recentDirections.push(direction?.name ?? "none");
  if (game.recentDirections.length > 12) {
    game.recentDirections.shift();
  }

  game.recentArchetypes.push(destination.archetype);
  if (game.recentArchetypes.length > 20) {
    game.recentArchetypes.shift();
  }

  game.recentPositions.push({ x: nx, y: ny });
  if (game.recentPositions.length > 14) {
    game.recentPositions.shift();
  }

  game.moveCount += 1;
  game.message = "Learning...";

  if (destination.state === "exit") {
    flashMessage("Exit reached. The maze remembers your path.");
    draw();
    return;
  }

  if (destination.state === "neutral") {
    destination.state = "safe";
  }

  checkFailure();
  draw();
}

function applyTileRule(tile) {
  if (tile.state === "wall" || tile.state === "exit") return;

  const archetype = archetypes.find((rule) => rule.name === tile.archetype);
  if (!archetype) return;

  const shouldCrystallize = archetype.trigger(tile, game);
  if (shouldCrystallize) {
    tile.state = "wall";
    tile.reveal = 1;
    game.crystallized += 1;
    flashMessage("A path crystallizes behind you.");
  }
}

function checkFailure() {
  if (!game) return;

  const { player, exit } = game;
  if (!pathExists(player, exit, game.grid)) {
    flashMessage("The maze has sealed. No route remains.");
  } else if (isTrapped(player, game.grid)) {
    flashMessage("You are sealed inside your own pattern.");
  }
}

function isTrapped(player, grid) {
  return directions.every((dir) => {
    const nx = player.x + dir.x;
    const ny = player.y + dir.y;
    if (nx < 0 || ny < 0 || nx >= gridSize || ny >= gridSize) return true;
    return grid[ny][nx].state === "wall";
  });
}

function pathExists(start, goal, grid) {
  const visited = Array.from({ length: gridSize }, () => Array(gridSize).fill(false));
  const queue = [start];
  visited[start.y][start.x] = true;

  while (queue.length > 0) {
    const current = queue.shift();
    if (current.x === goal.x && current.y === goal.y) return true;

    for (const dir of directions) {
      const nx = current.x + dir.x;
      const ny = current.y + dir.y;
      if (nx < 0 || ny < 0 || nx >= gridSize || ny >= gridSize) continue;
      if (visited[ny][nx]) continue;
      if (grid[ny][nx].state === "wall") continue;
      visited[ny][nx] = true;
      queue.push({ x: nx, y: ny });
    }
  }

  return false;
}

function draw() {
  movesEl.textContent = game.moveCount;
  crystallizedEl.textContent = game.crystallized;
  statusEl.textContent = game.message;

  if (game.revealTimer > 0) {
    game.revealTimer -= 1;
  }

  for (const row of game.grid) {
    for (const tile of row) {
      if (tile.reveal > 0) {
        tile.reveal = Math.max(0, tile.reveal - 0.02);
      }
    }
  }

  drawBoard(game);
}

function flashMessage(message) {
  game.message = message;
  statusEl.textContent = message;
}

function reset() {
  game = createGame();
  draw();
}

function handleKey(event) {
  const key = event.key.toLowerCase();
  if (["arrowup", "w"].includes(key)) attemptMove(0, -1);
  if (["arrowdown", "s"].includes(key)) attemptMove(0, 1);
  if (["arrowleft", "a"].includes(key)) attemptMove(-1, 0);
  if (["arrowright", "d"].includes(key)) attemptMove(1, 0);
}

function reveal() {
  if (!game) return;
  game.revealTimer = 60;
}

function tint(baseColor, overlay, alpha) {
  const base = hexToRgb(baseColor);
  const over = hexToRgb(overlay);
  const mix = (channel) => Math.round(base[channel] * (1 - alpha) + over[channel] * alpha);
  return `rgb(${mix("r")}, ${mix("g")}, ${mix("b")})`;
}

function hexToRgb(hex) {
  const normalized = hex.replace("#", "");
  const bigint = parseInt(normalized, 16);
  return {
    r: (bigint >> 16) & 255,
    g: (bigint >> 8) & 255,
    b: bigint & 255,
  };
}

function archetypeColor(type) {
  switch (type) {
    case "third-exit":
      return "#365b9d";
    case "north-entry":
      return "#5f3a88";
    case "sequence":
      return "#5a7d3b";
    case "frequency":
      return "#7c4a2a";
    case "backtrack":
      return "#4e7b7a";
    default:
      return "#2b3446";
  }
}

function shuffle(list, rng) {
  const array = [...list];
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function mulberry32(a) {
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

newGameBtn.addEventListener("click", reset);
revealBtn.addEventListener("click", () => {
  reveal();
  draw();
});

window.addEventListener("keydown", handleKey);

reset();
setInterval(draw, 1000 / 30);
