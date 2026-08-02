---
name: ci-check
description: Run local CI checks and verify GitHub Actions status. Use before committing, after pushing, or when asked to check/fix CI.
---

# CI Check

Run CI checks locally first, then verify GitHub Actions if the branch has been pushed.

## Step 1: Run local CI

Run `./scripts/ci-local.sh` to execute the same checks as GitHub Actions: install, build, typecheck, and docker build. If any step fails, fix it before proceeding.

Use `./scripts/ci-local.sh --quick` to skip the docker build when iterating on TypeScript fixes.

## Step 2: Check remote CI (if pushed)

Run `gh run list --branch $(git branch --show-current) --limit 1` to find the most recent CI run for this branch. If no runs exist, the branch hasn't been pushed yet — tell the user.

If the run status is `completed` and conclusion is `success`, report that CI is green and stop.

If the run is `in_progress`, run `gh run watch <run-id>` to wait for completion. Then re-check.

If the run `failed`, proceed to Step 3.

## Step 3: Read the failure logs

Run `gh run view <run-id> --log-failed` to get only the log lines from failed steps. This is more focused than `--log` which dumps everything.

Identify which step failed:

- `pnpm install --frozen-lockfile` — lockfile out of sync
- `pnpm turbo build` — TypeScript compilation error
- `pnpm turbo typecheck` — type errors without build
- `docker build` — Dockerfile issue

## Step 4: Fix locally

Based on the failure:

**Lockfile drift**: Run `pnpm install` locally and commit the updated `pnpm-lock.yaml`.

**Build/typecheck failure**: Read the error, find the file and line, fix the issue. Run `./scripts/ci-local.sh --quick` to verify before pushing.

**Docker build failure**: Read the error. Common causes: missing COPY for a new config file, changed package name, missing dependency. Run `./scripts/ci-local.sh` (full) to verify.

## Step 5: Push and re-check

After fixing, push the branch and run Step 2 again. Repeat until CI is green.

## Commands Reference

| Command | Purpose |
|---------|---------|
| `./scripts/ci-local.sh` | Full local CI (install, build, typecheck, docker) |
| `./scripts/ci-local.sh --quick` | Local CI without docker build |
| `gh run list --branch <branch> --limit 5` | List recent runs for a branch |
| `gh run view <id>` | Summary of a specific run |
| `gh run view <id> --log-failed` | Only failed step logs |
| `gh run watch <id>` | Wait for an in-progress run |
