# Security Policy

## Reporting a vulnerability

Use GitHub's **Private Vulnerability Reporting** (Security tab → "Report a
vulnerability"). Please do **not** open public issues for suspected
vulnerabilities. Reports are triaged within 72 hours; fixes ship per the SLAs
below.

## Supported runtimes

- Node.js **>= 18.14.1** — the npm package and the bundled VS Code extension
  follow the same floor.
- The floor is enforced in CI by `scripts/check-deps.mjs` (engine guard) and by
  the `node 18.14.1` job in the test matrix. Raising it is a deliberate,
  documented decision.

## Proactive controls (what is automated)

| Control | Mechanism | Cadence |
| --- | --- | --- |
| CVE alerts + automatic fix PRs | Dependabot alerts + automated security fixes | continuous |
| Version-update PRs (npm, docker, actions) | Dependabot (`.github/dependabot.yml`) | weekly (Mon) |
| Lockfile CVE scan | `npm audit --audit-level=high` + OSV-Scanner (`Security scan` workflow) | weekly + manual |
| Runtime-floor regression guard | `node scripts/check-deps.mjs` (CI `engine-guard` job) | every push/PR |
| Tests across supported runtimes | CI matrix: Node 18.14.1 / 20 / 22 | every push/PR |

Weekly scan findings open (or append to) an issue labeled `security-scan`.
Scans do not block PRs — a transitive CVE in unreachable code should not
freeze development; triage happens in the tracking issue.

## Patch policy (SLAs, from advisory publication)

| Severity | Fix within |
| --- | --- |
| Critical | 3 days |
| High | 7 days |
| Medium | 30 days |
| Low | next scheduled dependency update |

## Patch runbook (transitive dependencies)

1. **Prefer the smallest in-range lockfile bump.** Example: commit `2257d48`
   pinned `@hono/node-server` 1.19.9 → 1.19.17 for CVE-2026-29087 — no
   `package.json` change, no overrides, Node 18 support preserved.
2. **Pin, then install.** Edit the lockfile entry (version/resolved/integrity
   from `npm view <pkg>@<ver>`) and run `npm install` — npm keeps a pin that
   satisfies the parent's range.
3. **Beware range drift.** When a parent range spans majors
   (`^1.19.9 || ^2.0.5`), plain `npm update` resolves to the newest major,
   which can silently raise the Node requirement (e.g. `@hono/node-server`
   2.x needs Node >= 20). The CI engine guard catches exactly this.
4. **Only escalate to a major bump (or `overrides`)** when the fixed minor
   line does not exist — and do it together with a deliberate `SUPPORT_FLOOR`
   bump in `scripts/check-deps.mjs` and this document.
