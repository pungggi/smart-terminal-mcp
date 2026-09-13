#!/usr/bin/env node
/**
 * Engine guard — proactive check that every production (non-dev) dependency
 * in package-lock.json still supports the oldest Node runtime this package
 * supports (SUPPORT_FLOOR below).
 *
 * Why: dependency drift can silently raise the runtime floor (e.g.
 * @hono/node-server 2.x requires Node >= 20 while the 1.x line only needs
 * >= 18.14.1). This script fails CI instead of letting such a change land
 * unnoticed. See SECURITY.md "Patch runbook".
 *
 * Usage: node scripts/check-deps.mjs
 * Exit:  0 = all production deps support the floor, 1 = violations found.
 */

import { readFileSync } from 'node:fs';

const SUPPORT_FLOOR = '18.14.1';

/** Deliberate, documented exceptions: lockfile key -> reason. */
const ALLOWLIST = new Map([
  // ['node_modules/some-pkg': 'allowed to require newer Node, tracking issue #N'],
]);

// --- tiny semver-range evaluator for `engines.node` ranges -------------------
// Unknown/exotic tokens fail open (npm itself enforces engines at install
// time); this guard exists to catch the common ">= NEWER_MAJOR" drift.

const parse = (v) => {
  const p = String(v)
    .replace(/[\sxX*]+$/, '') // strip trailing wildcards / whitespace
    .split('.')
    .map((n) => parseInt(n, 10) || 0);
  return [p[0] || 0, p[1] || 0, p[2] || 0];
};
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const nextMinor = (v) => [v[0], v[1] + 1, 0];
const nextMajor = (v) => [v[0] + 1, 0, 0];
const caretUpper = (v) =>
  v[0] === 0 ? (v[1] === 0 ? [0, 0, v[2] + 1] : [0, v[1] + 1, 0]) : nextMajor(v);
const tildeUpper = (v) => (v[1] === 0 && v[2] === 0 ? nextMajor(v) : nextMinor(v));

/** Bare versions: full `a.b.c` = exact; partial or wildcard = x-range match. */
function satisfiesBare(floor, raw) {
  const wildcard = /[xX*]/.test(raw);
  const parts = raw.split('.').map((n) => parseInt(n, 10));
  if (wildcard || parts.length < 3) {
    if (Number.isNaN(parts[0])) return true;
    if (floor[0] !== parts[0]) return false;
    if (!Number.isNaN(parts[1]) && floor[1] !== parts[1]) return false;
    return true;
  }
  return cmp(floor, parts) === 0;
}

function opSatisfied(floor, op, ver) {
  const v = parse(ver);
  switch (op) {
    case '>=': return cmp(floor, v) >= 0;
    case '<=': return cmp(floor, v) <= 0;
    case '>': return cmp(floor, v) > 0;
    case '<': return cmp(floor, v) < 0;
    case '^': return cmp(floor, v) >= 0 && cmp(floor, caretUpper(v)) < 0;
    case '~': return cmp(floor, v) >= 0 && cmp(floor, tildeUpper(v)) < 0;
    default: return satisfiesBare(floor, ver);
  }
}

// Matches "op version" (whitespace tolerated inside, e.g. ">= 0.6") or bare versions.
const COMPARATOR_RE = /(>=|<=|>|<|\^|~)\s*v?([\dXx*][\dXx.]*)|v?([\dXx*][\dXx.]*)/g;

function branchSatisfied(floor, branch) {
  // "lo - hi" hyphen range
  const hyphen = branch.split(/\s+-\s+/);
  if (hyphen.length === 2) {
    return cmp(floor, parse(hyphen[0])) >= 0 && cmp(floor, parse(hyphen[1])) <= 0;
  }
  COMPARATOR_RE.lastIndex = 0;
  let m;
  while ((m = COMPARATOR_RE.exec(branch))) {
    const ok = m[1] ? opSatisfied(floor, m[1], m[2]) : satisfiesBare(floor, m[3]);
    if (!ok) return false;
  }
  return true; // nothing parseable: fail open (npm enforces engines at install time anyway)
}

const rangeSatisfied = (floor, range) =>
  range.split('||').some((branch) => branchSatisfied(floor, branch));

// --- check the lockfile -------------------------------------------------------

const lock = JSON.parse(
  readFileSync(
    process.env.LOCKFILE ?? new URL('../package-lock.json', import.meta.url),
    'utf8',
  ),
);
const floor = parse(SUPPORT_FLOOR);
const violations = [];

for (const [key, info] of Object.entries(lock.packages)) {
  if (key === '' || info.dev || info.optional) continue;
  const range = info.engines?.node;
  if (!range || ALLOWLIST.has(key)) continue;
  if (!rangeSatisfied(floor, range)) violations.push({ key, range });
}

if (ALLOWLIST.size) {
  console.log(`allowlisted (skipped): ${[...ALLOWLIST.keys()].join(', ')}`);
}

if (violations.length) {
  console.error(
    `\nengine-guard FAILED — these production dependencies require Node newer than ${SUPPORT_FLOOR}:`,
  );
  for (const { key, range } of violations) {
    console.error(`  ${key}  (engines.node: ${range})`);
  }
  console.error(
    `\nFix: pin an older compatible version in package-lock.json (see SECURITY.md "Patch runbook"),\n` +
      `or add a deliberate ALLOWLIST entry in scripts/check-deps.mjs if the floor should move.`,
  );
  process.exit(1);
}

console.log(`engine-guard: all production dependencies support Node >= ${SUPPORT_FLOOR}`);
