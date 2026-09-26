#!/usr/bin/env node
/**
 * Growing contribution snake.
 *
 * Like Platane/snk, a snake glides over last year's contribution graph and eats
 * the green days — but its tail grows as it eats: +1 segment for the lightest
 * green day up to +4 for the darkest, so the more you contribute, the longer it
 * gets. With every day eaten it chases its own tail, bites it — GAME OVER — and
 * the loop starts again.
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

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=")];
  }),
);
const user = args.user || process.env.GITHUB_REPOSITORY_OWNER;
const outDir = args.out || "dist";

const QUERY = `query($login: String!) {
  user(login: $login) { contributionsCollection { contributionCalendar {
    weeks { contributionDays { date contributionCount contributionLevel weekday } }
  } } }
}`;

async function loadCalendar() {
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
  light: { empty: "#ebedf0", levels: ["#9be9a8", "#40c463", "#30a14e", "#216e39"], snake: "#800080", head: "#5b005b", over: "#d1242f" },
  dark: { empty: "#161b22", levels: ["#0e4429", "#006d32", "#26a641", "#39d353"], snake: "#b43ab4", head: "#e27be2", over: "#f85149" },
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
const OVER_STEPS = 22; // flash + "GAME OVER" before the loop restarts

function buildGrid(calendar) {
  const weeks = calendar.data.user.contributionsCollection.contributionCalendar.weeks;
  const cells = []; // [x][y] → { exists, level }
  weeks.forEach((w, x) => {
    cells[x] = Array.from({ length: ROWS }, () => ({ exists: false, level: 0 }));
    for (const d of w.contributionDays) cells[x][d.weekday] = { exists: true, level: LEVEL[d.contributionLevel] ?? 0 };
  });
  return { cells, width: weeks.length };
}

/** Shortest grid path from `from` to the nearest cell satisfying `isGoal` (BFS, 4-neighbour). */
function pathToNearest(from, width, isGoal) {
  const key = (x, y) => y * width + x;
  const prev = new Map([[key(from.x, from.y), null]]);
  const queue = [from];
  for (let i = 0; i < queue.length; i++) {
    const p = queue[i];
    if (i > 0 && isGoal(p.x, p.y)) {
      const path = [];
      for (let q = p; q; q = prev.get(key(q.x, q.y))) path.push(q);
      return path.reverse().slice(1);
    }
    for (const [dx, dy] of [[-1, 0], [0, 1], [0, -1], [1, 0]]) {
      const n = { x: p.x + dx, y: p.y + dy };
      if (n.x < 0 || n.x >= width || n.y < 0 || n.y >= ROWS || prev.has(key(n.x, n.y))) continue;
      prev.set(key(n.x, n.y), p);
      queue.push(n);
    }
  }
  return null;
}

/** Straight-line steps (x first, then y) from a to b, excluding a. */
function walk(a, b) {
  const out = [];
  let { x, y } = a;
  while (x !== b.x) out.push({ x: (x += Math.sign(b.x - x)), y });
  while (y !== b.y) out.push({ x, y: (y += Math.sign(b.y - y)) });
  return out;
}

/**
 * Head route per step, when each green day is eaten, the length over time, and the
 * step at which the head bites the tail.
 */
function simulate({ cells, width }) {
  // the closing lap must fit on the board, so the snake stops growing at that size
  const maxLength = 2 * (width - 1) + 2 * (ROWS - 1) + 1;
  const eaten = new Map(); // "x,y" → step
  const head = [{ x: -1, y: 3 }]; // enters from the left edge, middle row
  const growth = [0]; // segments gained so far, per step
  let grown = 0;
  let meals = 0;
  const isFood = (x, y) => cells[x]?.[y]?.level > 0 && !eaten.has(`${x},${y}`);

  const moveTo = (p) => {
    head.push(p);
    if (isFood(p.x, p.y)) {
      eaten.set(`${p.x},${p.y}`, head.length - 1);
      grown = Math.min(maxLength - START_LENGTH, grown + GROWTH_BY_LEVEL[cells[p.x][p.y].level]);
      meals++;
    }
    growth.push(grown);
  };

  moveTo({ x: 0, y: 3 });
  for (;;) {
    let minX = Infinity;
    for (let x = 0; x < width && minX === Infinity; x++) for (let y = 0; y < ROWS; y++) if (isFood(x, y)) { minX = x; break; }
    if (minX === Infinity) break;
    const cur = head[head.length - 1];
    const path = pathToNearest(cur, width, (x, y) => x <= minX + LOOKAHEAD_WEEKS && isFood(x, y));
    if (!path) break;
    path.forEach(moveTo);
  }

  // closing lap: walk to a corner of a rectangle whose perimeter equals the snake's
  // length − 1, go once around it — the tail is exactly where the lap began, so the
  // head bites it (grids only have even cycles: an even length just touches it)
  const length = START_LENGTH + grown;
  const lap = Math.max(4, (length - 1) % 2 === 0 ? length - 1 : length - 2);
  const h = Math.min(ROWS, lap / 2); // rows spanned
  const w = lap / 2 + 2 - h; // columns spanned
  const cur = head[head.length - 1];
  const x0 = Math.max(0, Math.min(width - w, cur.x - Math.floor(w / 2)));
  const y0 = cur.y < ROWS / 2 ? 0 : ROWS - h;
  const corner = { x: x0, y: y0 };
  walk(cur, corner).forEach(moveTo);
  const lapPath = [
    ...walk(corner, { x: x0 + w - 1, y: y0 }),
    ...walk({ x: x0 + w - 1, y: y0 }, { x: x0 + w - 1, y: y0 + h - 1 }),
    ...walk({ x: x0 + w - 1, y: y0 + h - 1 }, { x: x0, y: y0 + h - 1 }),
    ...walk({ x: x0, y: y0 + h - 1 }, corner),
  ];
  lapPath.forEach(moveTo);
  return { head, growth, eaten, meals, finalLength: length, bite: head.length - 1 };
}

function render({ cells, width }, sim, theme) {
  const c = THEMES[theme];
  const w = PAD * 2 + width * PITCH - (PITCH - CELL);
  const h = PAD * 2 + ROWS * PITCH - (PITCH - CELL);
  const steps = sim.bite + OVER_STEPS;
  const duration = `${(steps * STEP_SECONDS).toFixed(1)}s`;
  const pct = (t) => +((Math.min(t, steps) / steps) * 100).toFixed(3);
  const px = (p) => [PAD + p.x * PITCH, PAD + p.y * PITCH];

  // the head's route: a keyframe wherever it turns (linear in between glides
  // smoothly), then it stays where it bit the tail
  const turns = [];
  sim.head.forEach((p, i) => {
    const a = sim.head[i - 1];
    const b = sim.head[i + 1];
    if (!a || !b || a.x - p.x !== p.x - b.x || a.y - p.y !== p.y - b.y) turns.push(i);
  });
  const [ex, ey] = px(sim.head[sim.bite]);
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
  // route (and, for grown ones, once the snake is long enough), flashes red when
  // the head bites the tail, then disappears until the next loop.
  const length = (t) => START_LENGTH + sim.growth[Math.min(t, sim.growth.length - 1)];
  const b = sim.bite;
  let segs = "";
  for (let i = sim.finalLength - 1; i >= 0; i--) {
    const size = Math.max(6, CELL - Math.floor(i / 8)); // tapers slightly toward the tail
    const off = (CELL - size) / 2;
    const [bx, by] = px({ x: -1 - i, y: 3 }); // where it waits before its delayed start
    let show = i;
    while (length(show) <= i) show++;
    const fill = i === 0 ? c.head : c.snake;
    css += `@keyframes s${i}{0%{opacity:0}${pct(show)}%{opacity:1}${pct(b)}%{fill:${c.over}}${pct(b + 3)}%{fill:${fill}}${pct(b + 6)}%{fill:${c.over}}${pct(b + 9)}%{fill:${fill}}${pct(b + 12)}%{opacity:0}100%{opacity:0}}`;
    segs += `<rect style="transform:translate(${bx}px,${by}px);animation:route ${duration} linear ${(i * STEP_SECONDS).toFixed(1)}s infinite,s${i} ${duration} step-end infinite" x="${off}" y="${off}" width="${size}" height="${size}" rx="${Math.min(4, size / 2)}" fill="${fill}"/>`;
  }

  // GAME OVER, from the bite to the restart
  css += `@keyframes over{0%{opacity:0}${pct(b + 3)}%{opacity:1}100%{opacity:1}}`;
  css += `.over{animation:over ${duration} step-end infinite;font:bold 22px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:3px}`;
  const over = `<text class="over" x="${w / 2}" y="${h / 2}" text-anchor="middle" dominant-baseline="central" fill="${c.over}" opacity="0">GAME OVER</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">`
    + `<desc>Contribution snake: ${sim.meals} green days eaten, grows from ${START_LENGTH} to ${sim.finalLength} segments, then bites its tail</desc>`
    + `<style>${css}</style>${dots}${segs}${over}</svg>`;
}

const grid = buildGrid(await loadCalendar());
const sim = simulate(grid);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "github-contribution-grid-snake.svg"), render(grid, sim, "light"));
writeFileSync(join(outDir, "github-contribution-grid-snake-dark.svg"), render(grid, sim, "dark"));
console.log(`snake eats ${sim.meals} green days, grows ${START_LENGTH} → ${sim.finalLength}, bites its tail at ${(sim.bite * STEP_SECONDS).toFixed(1)}s; loop ${((sim.bite + OVER_STEPS) * STEP_SECONDS).toFixed(1)}s`);
