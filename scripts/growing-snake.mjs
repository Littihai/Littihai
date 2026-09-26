#!/usr/bin/env node
/**
 * Growing contribution snake.
 *
 * Draws the last year's contribution graph as an animated SVG in which a snake
 * sweeps the grid column by column and grows as it eats: 1 segment for the
 * lightest green day up to 4 for the darkest — so the more you contribute, the
 * longer it gets. Pure CSS animation (no
 * JS), which is what GitHub renders inside a README <img>. No dependencies.
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
  light: { empty: "#ebedf0", levels: ["#9be9a8", "#40c463", "#30a14e", "#216e39"], head: "#86198f", body: "#c026d3", bar: "#c026d3" },
  dark: { empty: "#161b22", levels: ["#0e4429", "#006d32", "#26a641", "#39d353"], head: "#f0abfc", body: "#d946ef", bar: "#d946ef" },
};

const CELL = 11; // square size
const PITCH = 14; // square + gap
const PAD = 4;
const START_LENGTH = 3;
/** segments gained per meal, by contribution level (1 = lightest … 4 = darkest) */
const GROWTH_BY_LEVEL = [0, 1, 2, 3, 4];
const STEP_SECONDS = 0.1;
const PAUSE_STEPS = 12; // empty board before the loop restarts

function buildGrid(calendar) {
  const weeks = calendar.data.user.contributionsCollection.contributionCalendar.weeks;
  // serpentine: down the first week, up the next, … — every one of the 7 rows,
  // so the snake keeps moving even across the missing days of a partial week
  const path = [];
  weeks.forEach((w, x) => {
    const byDay = new Map(w.contributionDays.map((d) => [d.weekday, d]));
    const rows = x % 2 === 0 ? [0, 1, 2, 3, 4, 5, 6] : [6, 5, 4, 3, 2, 1, 0];
    for (const y of rows) {
      const day = byDay.get(y);
      path.push({ x, y, exists: !!day, level: day ? LEVEL[day.contributionLevel] ?? 0 : 0 });
    }
  });
  return { path, weeks: weeks.length };
}

/** For every cell: when the head reaches it and when the tail leaves it. */
function simulate(path) {
  const n = path.length;
  const grownBy = []; // segments gained up to and including step t (head at t)
  let meals = 0;
  let grown = 0;
  for (let t = 0; t < n; t++) {
    if (path[t].level > 0) meals++;
    grown += GROWTH_BY_LEVEL[path[t].level];
    grownBy[t] = grown;
  }
  const length = (t) => START_LENGTH + grownBy[Math.min(t, n - 1)];
  const finalLength = length(n - 1);
  const total = n - 1 + finalLength + PAUSE_STEPS; // head exits, tail follows, short pause
  const leave = [];
  let t = 0;
  for (let k = 0; k < n; k++) {
    if (t < k) t = k;
    while (t - length(t) + 1 <= k) t++; // first step at which the tail has passed k
    leave[k] = t;
  }
  return { total, leave, finalLength, meals };
}

function render(path, weeks, sim, theme) {
  const c = THEMES[theme];
  const width = PAD * 2 + weeks * PITCH - (PITCH - CELL);
  const gridHeight = PAD * 2 + 7 * PITCH - (PITCH - CELL);
  const height = gridHeight + 10;
  const pct = (t) => +((t / sim.total) * 100).toFixed(3);
  const colorOf = (cell) => (!cell.exists ? "none" : cell.level ? c.levels[cell.level - 1] : c.empty);

  let css = `.s{animation:${(sim.total * STEP_SECONDS).toFixed(1)}s step-end infinite}`;
  let rects = "";
  path.forEach((cell, k) => {
    const orig = colorOf(cell);
    const after = cell.exists ? (cell.level ? c.empty : orig) : "none";
    const frames = [[0, orig], [k, c.head]];
    if (sim.leave[k] > k + 1) frames.push([k + 1, c.body]);
    frames.push([sim.leave[k], after]);
    css += `@keyframes k${k}{${frames.map(([t, f]) => `${pct(t)}%{fill:${f}}`).join("")}100%{fill:${after}}}.k${k}{animation-name:k${k}}`;
    rects += `<rect class="s k${k}" x="${PAD + cell.x * PITCH}" y="${PAD + cell.y * PITCH}" width="${CELL}" height="${CELL}" rx="2" fill="${orig}"/>`;
  });
  // progress bar under the grid
  const barW = width - PAD * 2;
  css += `@keyframes bar{0%{width:0}${pct(path.length + sim.finalLength - 1)}%{width:${barW}px}100%{width:${barW}px}}`;
  css += `.bar{animation:bar ${(sim.total * STEP_SECONDS).toFixed(1)}s linear infinite}`;
  const bar = `<rect class="bar" x="${PAD}" y="${gridHeight + 2}" width="0" height="4" rx="2" fill="${c.bar}"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`
    + `<desc>Contribution snake: ${sim.meals} green days eaten, grows from ${START_LENGTH} to ${sim.finalLength} segments</desc>`
    + `<style>${css}</style>${rects}${bar}</svg>`;
}

const calendar = await loadCalendar();
const { path, weeks } = buildGrid(calendar);
const sim = simulate(path);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "github-contribution-grid-snake.svg"), render(path, weeks, sim, "light"));
writeFileSync(join(outDir, "github-contribution-grid-snake-dark.svg"), render(path, weeks, sim, "dark"));
console.log(`snake eats ${sim.meals} green days and grows ${START_LENGTH} → ${sim.finalLength}; loop ${(sim.total * STEP_SECONDS).toFixed(1)}s`);
