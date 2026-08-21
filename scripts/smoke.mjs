#!/usr/bin/env node
/**
 * Headless smoke test: open the gallery, then open one robot per category and
 * assert the model actually rendered (meshes present, non-empty bounding box).
 *
 *   node scripts/serve.mjs &
 *   node scripts/smoke.mjs [--all] [--robot <id>] [--base http://localhost:8080]
 *
 * `--all` walks every robot in the registry, which is the check to run before
 * publishing a registry update: a robot whose upstream repository moved its
 * meshes fails here rather than in front of a visitor.
 */
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { launchBrowser } from './browser.mjs';
import { parseVisibility } from '../web/js/registry.js';

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i === -1 ? fallback : args[i + 1];
};
const base = flag('--base', process.env.BASE_URL || 'http://localhost:8080');
const registry = JSON.parse(readFileSync(new URL('../data/robots.json', import.meta.url)));

// The site only serves what data/visibility.md leaves checked, so that is what
// there is to smoke-test; an unchecked robot has no card and no detail page.
const visibilityPath = new URL('../data/visibility.md', import.meta.url);
const visibility = existsSync(visibilityPath)
  ? parseVisibility(readFileSync(visibilityPath, 'utf8'))
  : new Map();
const shown = registry.robots.filter((r) => visibility.get(r.id) !== false);
const hidden = registry.robots.length - shown.length;
if (hidden) console.log(`${hidden} robot(s) hidden by data/visibility.md`);

let targets;
if (flag('--robot')) {
  targets = shown.filter((r) => r.id === flag('--robot'));
  if (!targets.length) console.log(`${flag('--robot')}: not shown (or unknown) — nothing to test`);
} else if (args.includes('--all')) {
  targets = shown;
} else {
  // One representative (the lightest) per category keeps the default fast.
  const byCategory = new Map();
  for (const robot of shown) {
    const current = byCategory.get(robot.category);
    if (!current || robot.assets.mesh_bytes < current.assets.mesh_bytes) {
      byCategory.set(robot.category, robot);
    }
  }
  targets = [...byCategory.values()];
}

mkdirSync(new URL('../.cache/smoke', import.meta.url), { recursive: true });

const browser = await launchBrowser();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});
page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

await page.goto(`${base}/web/`, { waitUntil: 'networkidle' });
// The grid is rendered from data/robots.json, which main.js fetches after the
// document loads, so networkidle can resolve a beat before the cards exist on a
// busy runner. Wait for the first one rather than counting the instant
// navigation returns.
await page
  .locator('.card')
  .first()
  .waitFor({ timeout: 30000 })
  .catch(() => {});
const cards = await page.locator('.card').count();
console.log(`gallery: ${cards} cards`);
if (cards !== shown.length) {
  console.error(`  ✗ expected ${shown.length} cards`);
  // main.js turns a failed registry fetch into a paragraph in the grid and
  // returns, raising nothing this script would otherwise see. Printing what the
  // grid actually says is the difference between "0 cards" and a reason: on
  // 2026-08-21 a run on main reported 0 cards, rendered all 75 robots fine, and
  // left nothing in the log to explain the red.
  const why = await page
    .locator('#grid')
    .innerText()
    .catch(() => '');
  const first = why.trim().split('\n')[0];
  if (first) console.error(`    grid says: ${first}`);
  process.exitCode = 1;
}

let failures = 0;
for (const robot of targets) {
  const started = Date.now();
  await page.goto(`${base}/web/#robot=${robot.id}`, { waitUntil: 'commit' });
  let result;
  try {
    result = await page.waitForFunction(
      (id) => {
        // The stage stamps the id it finished loading, so a stale panel from the
        // previously viewed robot cannot satisfy the wait.
        const stage = document.querySelector('.stage');
        if (stage?.dataset.failed === id) {
          return { error: document.getElementById('stage-error').textContent.trim() };
        }
        if (stage?.dataset.loaded !== id) return false;
        return {
          joints: document.querySelectorAll('#d-joints .joint').length,
          // Every slider carries the limits its URDF declares; a joint without
          // that row means the raw XML never made it into the panel.
          limits: document.querySelectorAll('#d-joints .joint .joint-limits').length,
          specs: document.querySelectorAll('#d-specs dt').length,
          // The joint tree walks the loaded scene graph, so an empty one means
          // the panel broke rather than that the robot is simple: every
          // description has at least a root link.
          treeNodes: document.querySelectorAll('#d-tree .tree-node').length,
          treeMovable: document.querySelectorAll('#d-tree .tree-node[data-movable="true"]').length,
          meshes: Number(stage.dataset.meshes || 0),
          height: Number(stage.dataset.height || NaN),
          name: document.getElementById('d-name').textContent,
        };
      },
      robot.id,
      { timeout: 180000, polling: 400 },
    ).then((handle) => handle.jsonValue());
  } catch (err) {
    result = { error: `timeout after ${Math.round((Date.now() - started) / 1000)}s` };
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  if (result.error) {
    console.error(`  ✗ ${robot.id.padEnd(26)} ${result.error}`);
    failures += 1;
    continue;
  }
  // A URDF whose meshes 404 still "loads" — an empty scene is the real failure.
  if (!result.meshes) {
    console.error(`  ✗ ${robot.id.padEnd(26)} loaded but no visual geometry rendered`);
    failures += 1;
    continue;
  }
  if (result.limits !== result.joints) {
    console.error(
      `  ✗ ${robot.id.padEnd(26)} ${result.joints} joints but ${result.limits} limit rows`,
    );
    failures += 1;
    continue;
  }
  // A robot with sliders but no rows for them in the tree means the panel is
  // showing a different robot from the one on the stage.
  if (result.joints && result.treeMovable !== result.joints) {
    console.error(
      `  ✗ ${robot.id.padEnd(26)} ${result.joints} joint sliders but ` +
        `${result.treeMovable} movable joints in the tree`,
    );
    failures += 1;
    continue;
  }
  if (!result.treeNodes) {
    console.error(`  ✗ ${robot.id.padEnd(26)} joint tree is empty`);
    failures += 1;
    continue;
  }
  // Meshes present but nothing measurable means broken transforms.
  if (!Number.isFinite(result.height) || result.height <= 0) {
    console.error(
      `  ✗ ${robot.id.padEnd(26)} ${result.meshes} meshes but no measurable size ` +
        `(height=${result.height})`,
    );
    failures += 1;
    continue;
  }

  console.log(
    `  ✓ ${robot.id.padEnd(26)} ${String(result.joints).padStart(3)} joints  ` +
      `${String(result.meshes).padStart(3)} meshes  ${seconds.padStart(5)}s  ` +
      `${result.height.toFixed(2)} m`,
  );
  if (args.includes('--shots')) {
    await page.screenshot({ path: new URL(`../.cache/smoke/${robot.id}.png`, import.meta.url).pathname });
  }
}

const relevant = consoleErrors.filter((e) => !/favicon|thumbs\/.*404|Failed to load resource/.test(e));
if (relevant.length) {
  console.error(`\nconsole errors (${relevant.length}):`);
  for (const error of relevant.slice(0, 12)) console.error(`  ${error}`);
}

await browser.close();
if (failures) process.exitCode = 1;
// Every robot can render and the run still be a failure — the gallery check
// above sets the exit code too. A bare "75/75 robots rendered" above a non-zero
// exit reads as a passing run, so say which it was.
console.log(`\n${targets.length - failures}/${targets.length} robots rendered`);
if (process.exitCode) console.error('smoke test FAILED — see the errors above');
