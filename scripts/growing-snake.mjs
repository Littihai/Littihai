#!/usr/bin/env node
/**
 * Growing contribution snake.
 *
 * Like Platane/snk, a snake glides over last year's contribution graph and eats
 * the green days — but its tail grows as it eats: +1 segment for the lightest
 * green day up to +4 for the darkest, so the more you contribute, the longer it
 * gets.
 *
 * The rules of the game (also in the README):
 *
 *   hits a wall                  the game does not end before everything is eaten:
 *                                the snake only ever turns, it never leaves the board
 *   hits its body or its tail    must be avoided: the route never crosses the snake itself
 *                                (a tail cell counts as free once the tail has moved on)
 *   meets a contribution cell    eats it and grows
 *   contribution cells remain    keeps playing
 *   every cell eaten             the game ends: VICTORY, then the loop starts again
 *
 * Every segment replays the head's route a few steps later, so all segments share
 * one @keyframes (plus a small per-segment show/flash animation) and the file stays
 * small however long the snake gets. Pure CSS animation — what GitHub renders
 * inside a README <img>. No dependencies.
 *
 *   GITHUB_TOKEN=… node growing-snake.mjs --user=Littihai --out=dist
 *   node growing-snake.mjs --data=contrib.json --out=dist      (offline)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const QUERY = `query($login: String!) {
  user(login: $login) { contributionsCollection { contributionCalendar {
    weeks { contributionDays { date contributionCount contributionLevel weekday } }
  } } }
}`;

async function loadCalendar(args, user) {
  if (args.data) return JSON.parse(readFileSync(args.data, "utf8"));
  const token = process.env.GITHUB_TOKEN;
  if (!user || !token) throw new Error("need --user and GITHUB_TOKEN (or --data=file)");
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${token}`, "Content-Type": "application/json", "User-Agent": "growing-snake" },
    body: JSON.stringify({ query: QUERY, variables: { login: user } }),
  });
  const json = await res.json();
  if (!res.ok || json.errors) throw new Error(`GitHub API: ${res.status} ${JSON.stringify(json.errors ?? json)}`);
  return json;
}

const LEVEL = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

const THEMES = {
  light: { empty: "#ebedf0", levels: ["#9be9a8", "#40c463", "#30a14e", "#216e39"], snake: "#800080", head: "#5b005b", win: "#bf8700" },
  dark: { empty: "#161b22", levels: ["#0e4429", "#006d32", "#26a641", "#39d353"], snake: "#b43ab4", head: "#e27be2", win: "#f2cc60" },
};

const CELL = 11; // dot size
const PITCH = 14; // dot + gap
const PAD = 4;
const ROWS = 7;
const START_LENGTH = 4;
/** segments gained per meal, by contribution level (1 = lightest … 4 = darkest) */
const GROWTH_BY_LEVEL = [0, 1, 2, 3, 4];
/** eat the leftmost days first, looking this many weeks ahead, so none is left behind */
const LOOKAHEAD_WEEKS = 4;
const STEP_SECONDS = 0.1;
const END_STEPS = 22; // flash + "VICTORY" before the loop restarts
const DIRS = [[-1, 0], [0, 1], [0, -1], [1, 0]];

export function buildGrid(calendar) {
  const weeks = calendar.data.user.contributionsCollection.contributionCalendar.weeks;
  const cells = []; // [x][y] → { exists, level }
  weeks.forEach((w, x) => {
    cells[x] = Array.from({ length: ROWS }, () => ({ exists: false, level: 0 }));
    for (const d of w.contributionDays) cells[x][d.weekday] = { exists: true, level: LEVEL[d.contributionLevel] ?? 0 };
  });
  return { cells, width: weeks.length };
}

/**
 * One game, with the snake never longer than `maxLength`. Returns the head's route
 * (one cell per step, the entry cell left of the board first), when each green day
 * is eaten, the length over time and the step of the last meal — or null when the
 * snake cannot finish without touching itself.
 *
 * The body is simply the head's last `length` cells, so a cell is free for the head
 * at step t when the head left it before t − length + 1: the tail moves on while the
 * head travels. Each route is a shortest one under that rule, and a green day that
 * is not the goal is never walked over (it would grow the snake in the middle of a
 * route, and the rule above assumes the length stays put until the meal).
 */
export function play({ cells, width }, maxLength) {
  const cap = maxLength - START_LENGTH;
  const eaten = new Map(); // "x,y" → step
  const head = [{ x: -1, y: 3 }]; // enters from the left edge, middle row
  const growth = [0]; // segments gained so far, per step
  const lastVisit = new Map(); // cell → latest step at which the head stood there
  let grown = 0;
  let meals = 0;
  let total = 0;
  cells.forEach((col) => col.forEach((c) => { if (c.level > 0) total++; }));
  const key = (x, y) => y * width + x;
  const level = (x, y) => cells[x]?.[y]?.level ?? 0;
  const isFood = (x, y) => level(x, y) > 0 && !eaten.has(`${x},${y}`);
  const giveUpAfter = 8 * width * ROWS + 200; // steps; a route that wanders longer is a trapped snake

  const moveTo = (p) => {
    head.push(p);
    lastVisit.set(key(p.x, p.y), head.length - 1);
    if (isFood(p.x, p.y)) {
      eaten.set(`${p.x},${p.y}`, head.length - 1);
      grown = Math.min(cap, grown + GROWTH_BY_LEVEL[level(p.x, p.y)]);
      meals++;
    }
    growth.push(grown);
  };

  /** Free to enter at `step` for a snake that is `length` long then? */
  const free = (x, y, step, length) => {
    const seen = lastVisit.get(key(x, y));
    return seen === undefined || seen < step - length + 1;
  };

  /** Shortest route (BFS, 4-neighbour) from the head to the nearest cell satisfying `isGoal`, or null. */
  const route = (isGoal) => {
    const from = head[head.length - 1];
    const t0 = head.length - 1;
    const length = START_LENGTH + grown;
    const prev = new Map([[key(from.x, from.y), null]]);
    const depth = new Map([[key(from.x, from.y), 0]]);
    const queue = [from];
    for (let i = 0; i < queue.length; i++) {
      const p = queue[i];
      const d = depth.get(key(p.x, p.y));
      if (i > 0 && isGoal(p.x, p.y)) {
        const path = [];
        for (let q = p; q; q = prev.get(key(q.x, q.y))) path.push(q);
        return path.reverse().slice(1);
      }
      for (const [dx, dy] of DIRS) {
        const n = { x: p.x + dx, y: p.y + dy };
        if (n.x < 0 || n.x >= width || n.y < 0 || n.y >= ROWS || prev.has(key(n.x, n.y))) continue; // a wall: turn
        const food = isFood(n.x, n.y);
        if (food && !isGoal(n.x, n.y)) continue;
        // eating lengthens the snake at once, so its new tail must be clear of this cell too
        const len = food ? Math.min(maxLength, length + GROWTH_BY_LEVEL[level(n.x, n.y)]) : length;
        if (!free(n.x, n.y, t0 + d + 1, len)) continue; // the body (or the tail) is still there
        prev.set(key(n.x, n.y), p);
        depth.set(key(n.x, n.y), d + 1);
        queue.push(n);
      }
    }
    return null;
  };

  moveTo({ x: 0, y: 3 });
  while (meals < total) {
    if (head.length > giveUpAfter) return null;
    let minX = Infinity;
    for (let x = 0; x < width && minX === Infinity; x++) for (let y = 0; y < ROWS; y++) if (isFood(x, y)) { minX = x; break; }
    // the leftmost days first; if the body is in the way, any day; if even that is blocked, follow the tail until it clears
    let path = route((x, y) => x <= minX + LOOKAHEAD_WEEKS && isFood(x, y)) ?? route(isFood);
    if (!path) {
      const tail = head[head.length - (START_LENGTH + grown)];
      if (tail && tail.x >= 0) path = route((x, y) => x === tail.x && y === tail.y);
    }
    if (!path) {
      // one safe step to anywhere free
      const p = head[head.length - 1];
      const step = DIRS.map(([dx, dy]) => ({ x: p.x + dx, y: p.y + dy }))
        .find((n) => n.x >= 0 && n.x < width && n.y >= 0 && n.y < ROWS && free(n.x, n.y, head.length, START_LENGTH + grown));
      path = step ? [step] : null;
    }
    if (!path) return null;
    path.forEach(moveTo);
  }
  return { head, growth, eaten, meals, finalLength: START_LENGTH + grown, end: head.length - 1 };
}

/**
 * The route that cannot fail: left to right, up one column and down the next. It never
 * crosses itself, so the snake can be any length. Used only when a game above gets stuck.
 */
export function sweep({ cells, width }, maxLength) {
  const cap = maxLength - START_LENGTH;
  const eaten = new Map();
  const head = [{ x: -1, y: 0 }];
  const growth = [0];
  let grown = 0;
  let meals = 0;
  let last = 0;
  for (let x = 0; x < width; x++) {
    for (let i = 0; i < ROWS; i++) {
      const y = x % 2 === 0 ? i : ROWS - 1 - i;
      head.push({ x, y });
      const lv = cells[x][y].level;
      if (lv > 0) {
        eaten.set(`${x},${y}`, head.length - 1);
        grown = Math.min(cap, grown + GROWTH_BY_LEVEL[lv]);
        meals++;
        last = head.length - 1;
      }
      growth.push(grown);
    }
  }
  head.length = Math.max(2, last + 1);
  growth.length = head.length;
  return { head, growth, eaten, meals, finalLength: START_LENGTH + growth[growth.length - 1], end: head.length - 1 };
}

export function simulate(grid) {
  const longest = 2 * (grid.width - 1) + 2 * (ROWS - 1) + 1;
  // a shorter snake is harder to trap, so a stuck game is played again with a smaller cap
  for (const cap of [longest, 80, 60, 48, 40, 32, 24, 18, 12, 8]) {
    const sim = play(grid, Math.max(START_LENGTH, Math.min(cap, longest)));
    if (sim) return sim;
  }
  return sweep(grid, Math.min(60, longest));
}

function render({ cells, width }, sim, theme) {
  const c = THEMES[theme];
  const w = PAD * 2 + width * PITCH - (PITCH - CELL);
  const h = PAD * 2 + ROWS * PITCH - (PITCH - CELL);
  const steps = sim.end + END_STEPS;
  const duration = `${(steps * STEP_SECONDS).toFixed(1)}s`;
  const pct = (t) => +((Math.min(t, steps) / steps) * 100).toFixed(3);
  const px = (p) => [PAD + p.x * PITCH, PAD + p.y * PITCH];

  // the head's route: a keyframe wherever it turns (linear in between glides
  // smoothly), then it stays where it ate the last green day
  const turns = [];
  sim.head.forEach((p, i) => {
    const a = sim.head[i - 1];
    const b = sim.head[i + 1];
    if (!a || !b || a.x - p.x !== p.x - b.x || a.y - p.y !== p.y - b.y) turns.push(i);
  });
  const [ex, ey] = px(sim.head[sim.end]);
  let css = `@keyframes route{${turns.map((i) => { const [x, y] = px(sim.head[i]); return `${pct(i)}%{transform:translate(${x}px,${y}px)}`; }).join("")}100%{transform:translate(${ex}px,${ey}px)}}`;

  // dots; green ones empty out when eaten and come back when the loop restarts
  let dots = "";
  cells.forEach((col, x) => col.forEach((cell, y) => {
    if (!cell.exists) return;
    const [cx, cy] = px({ x, y });
    const fill = cell.level ? c.levels[cell.level - 1] : c.empty;
    const t = sim.eaten.get(`${x},${y}`);
    let attr = "";
    if (t !== undefined) {
      css += `@keyframes e${x}_${y}{0%{fill:${fill}}${pct(t)}%{fill:${c.empty}}100%{fill:${c.empty}}}`;
      attr = ` class="d" style="animation-name:e${x}_${y}"`;
    }
    dots += `<rect${attr} x="${cx}" y="${cy}" width="${CELL}" height="${CELL}" rx="2" fill="${fill}"/>`;
  }));
  css += `.d{animation:${duration} step-end infinite}`;

  // segment i replays the head's route i steps later. It shows once it is on the
  // route (and, for grown ones, once the snake is long enough), flashes gold when
  // the last green day is eaten, then disappears until the next loop.
  const length = (t) => START_LENGTH + sim.growth[Math.min(t, sim.growth.length - 1)];
  const b = sim.end;
  let segs = "";
  for (let i = sim.finalLength - 1; i >= 0; i--) {
    const size = Math.max(6, CELL - Math.floor(i / 8)); // tapers slightly toward the tail
    const off = (CELL - size) / 2;
    const [bx, by] = px({ x: -1 - i, y: sim.head[0].y }); // where it waits before its delayed start
    let show = i;
    while (length(show) <= i) show++;
    const fill = i === 0 ? c.head : c.snake;
    css += `@keyframes s${i}{0%{opacity:0}${pct(show)}%{opacity:1}${pct(b)}%{fill:${c.win}}${pct(b + 3)}%{fill:${fill}}${pct(b + 6)}%{fill:${c.win}}${pct(b + 9)}%{fill:${fill}}${pct(b + 12)}%{opacity:0}100%{opacity:0}}`;
    segs += `<rect style="transform:translate(${bx}px,${by}px);animation:route ${duration} linear ${(i * STEP_SECONDS).toFixed(1)}s infinite,s${i} ${duration} step-end infinite" x="${off}" y="${off}" width="${size}" height="${size}" rx="${Math.min(4, size / 2)}" fill="${fill}"/>`;
  }

  // VICTORY, from the last meal to the restart
  css += `@keyframes win{0%{opacity:0}${pct(b + 3)}%{opacity:1}100%{opacity:1}}`;
  css += `.win{animation:win ${duration} step-end infinite;font:bold 22px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:3px}`;
  const win = `<text class="win" x="${w / 2}" y="${h / 2}" text-anchor="middle" dominant-baseline="central" fill="${c.win}" opacity="0">VICTORY</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`
    + `<desc>Contribution snake: ${sim.meals} green days eaten without touching itself, grows from ${START_LENGTH} to ${sim.finalLength} segments, then VICTORY</desc>`
    + `<style>${css}</style>${dots}${segs}${win}</svg>`;
}

async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const [k, ...v] = a.replace(/^--/, "").split("=");
      return [k, v.join("=")];
    }),
  );
  const user = args.user || process.env.GITHUB_REPOSITORY_OWNER;
  const outDir = args.out || "dist";
  const grid = buildGrid(await loadCalendar(args, user));
  const sim = simulate(grid);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "github-contribution-grid-snake.svg"), render(grid, sim, "light"));
  writeFileSync(join(outDir, "github-contribution-grid-snake-dark.svg"), render(grid, sim, "dark"));
  console.log(`snake eats ${sim.meals} green days, grows ${START_LENGTH} → ${sim.finalLength}, wins at ${(sim.end * STEP_SECONDS).toFixed(1)}s; loop ${((sim.end + END_STEPS) * STEP_SECONDS).toFixed(1)}s`);
}

// run as a script, not when a test imports the functions above
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
