# Fuwari upstream synchronization

Shots of Rhapsody was created from the [Fuwari template](https://github.com/saicaca/fuwari). GitHub template repositories start with independent history, so a regular pull from the template repository is not a safe way to establish ancestry.

The reviewed lineage for this repository is deliberately pinned:

| Role | Commit |
| --- | --- |
| Imported Fuwari baseline | `415fb97054e57bb85da86e2ca4ea4a1ae7266219` |
| Reviewed Fuwari head | `6d39b0dec41282e7852e23e032998a5789abee28` |

The baseline was joined with an `ours` merge, which recorded ancestry without changing project files. The reviewed head was then merged normally. Do not replace either commit with a moving branch name when auditing this integration.

## Configure a clone

Git remote settings live in `.git/config` and are not shared by GitHub. Run the versioned setup script in every fresh clone:

```powershell
pwsh ./scripts/setup-upstream.ps1 -Fetch
```

The script is idempotent and configures:

- `origin` as the default push remote.
- `main` to push to `origin`.
- `upstream` to fetch only `saicaca/fuwari`'s `main` branch.
- An intentionally invalid push URL for `upstream`.

Verify the result:

```powershell
git remote -v
git config --local --get-all remote.upstream.fetch
git config --local --get remote.pushDefault
git config --local --get branch.main.pushRemote
```

The invalid push URL is a local accident-prevention measure, not an authorization boundary. GitHub repository permissions remain the actual enforcement layer.

## Review a future update

Never pull upstream directly into `main`, and never push to `upstream`. Fetch first, inspect the exact candidate commit, and merge it through a dedicated branch and pull request:

```powershell
git fetch upstream --prune
git log --oneline 6d39b0dec41282e7852e23e032998a5789abee28..upstream/main
git diff --stat 6d39b0dec41282e7852e23e032998a5789abee28..upstream/main

git switch main
git pull --ff-only origin main
git switch -c codex/fuwari-sync-YYYY-MM-DD
git merge --no-ff <reviewed-upstream-commit>

pnpm install --frozen-lockfile
pnpm check
pnpm lint:ci
pnpm build

git push --set-upstream origin codex/fuwari-sync-YYYY-MM-DD
```

Before merging the pull request, review every upstream commit and file change. Update the pinned reviewed-head value in this document only after that review succeeds.

## Known non-gating upstream check

The inherited `pnpm type-check` command runs TypeScript with `--isolatedDeclarations` even though this site does not emit a declaration package. At the reviewed upstream baseline and after the local compatibility work, it exits with 11 `TS9007`, `TS9010`, and `TS9013` annotation-inference diagnostics across the existing constants, content schema, RSS route, plugins, and utilities.

This command is retained to make the upstream issue visible, but it is not a migration gate. The required gates are `pnpm check` (`astro check`), `pnpm test:vocal`, `pnpm lint:ci`, `pnpm build`, content/hash verification when a manifest exists, and `pnpm verify:site`. Do not report the standalone declaration check as passing unless its upstream contract is deliberately repaired in a separately reviewed change.

## Prohibited shortcuts

- Do not run `git pull upstream main`.
- Do not merge `upstream/main` without first resolving it to a reviewed commit SHA.
- Do not change `upstream`'s push URL to a working GitHub URL.
- Do not push a synchronization branch directly to `main`.
- Do not assume the local invalid URL substitutes for GitHub permissions or branch rules.
