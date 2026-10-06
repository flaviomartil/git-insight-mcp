<p align="center">
  <img src="assets/logo.png" alt="git-insight-mcp" width="200" />
</p>

# git-insight-mcp

[![CI](https://github.com/flaviomartil/git-insight-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/flaviomartil/git-insight-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Semantic git queries via MCP. Beyond `git log` — answer who/what/when/why about any line, file, or branch.

![demo](demo.gif)

Pairs with [terminal-history-mcp](https://github.com/HasanJahidul/terminal-history-mcp) and [localhost-mcp](https://github.com/HasanJahidul/localhost-mcp). Together: what you ran, what's running, what you changed.

## Why

Devs ask these constantly; `git` answers poorly:

- "Who last touched this function?" — `git blame` only gives lines, not authors-by-region
- "What PR introduced this line?" — manual: blame → commit SHA → search GH
- "Which files always change together?" — no built-in
- "Show unmerged branches older than 30 days" — bash one-liner gymnastics
- "What did I work on last week?" — manual log scrub

LLM agents need this context to make safe edits. Currently they `git log -n 5` and miss everything.

## Install

This maintained harness fork is [flaviomartil/git-insight-mcp](https://github.com/flaviomartil/git-insight-mcp), version `0.1.3-harness.1`, based on [HasanJahidul/git-insight-mcp](https://github.com/HasanJahidul/git-insight-mcp) commit `b584c723df75053aebe9c4a769daf9b1719e87a1`. The public npm release does not include these corrections. Build this checkout and use its CLI through the harness launcher. Run it on demand; no global MCP registration is needed.

```bash
npm ci --ignore-scripts
npm run build
npm test
```

Wire into Claude Code:

```bash
claude mcp add --scope user git-insight -- git-insight-mcp
```

Or any MCP-compatible client. Runs as a stdio MCP server.

For PR / issue lookups, set a GitHub token:

```bash
export GH_TOKEN=ghp_...
```

Without a token, local tools and PR references in commit messages still work. GitHub enrichment also uses existing `gh` authentication. Message references produce local links for GitHub, Bitbucket and Azure DevOps; they do not verify merge state or reviewers. Use `--remote-name` to select the provider in a repository with mirrors.

## Tools

| Tool | Purpose |
|------|---------|
| `who_touched` | Group blame by author. Lines, commits, last-touched, primary owner. Optional line-range narrowing. |
| `introducing_pr` | Find the PR associated with a commit or the last change to a line. Parses messages first; falls back to GitHub API. |
| `co_change` | Files most often changed together with the input file. |
| `branch_hygiene` | List branches with ahead/behind, last commit, merged status, stale flag. |
| `recent_work` | Standup helper: author's commits + files + ins/del in a window. |
| `commit_context` | Full commit context: subject, body, files, PR, related issues. |

## Sample output (`who_touched`)

```json
{
  "file": "src/auth.ts",
  "total_lines": 124,
  "authors": [
    { "name": "alice", "email": "alice@x.com", "lines": 87, "commits": 12, "last_commit_date": "2026-04-12T10:33:01.000Z" },
    { "name": "bob", "email": "bob@x.com", "lines": 37, "commits": 4, "last_commit_date": "2026-01-03T18:14:55.000Z" }
  ],
  "primary_owner": "alice"
}
```

## CLI usage (sanity checks)

```bash
git-insight-mcp who-touched src/auth.ts
git-insight-mcp co-change src/auth.ts
git-insight-mcp co-change src/auth.ts --cwd /path/to/repo --window 200 --threshold 3 --limit 10 --compact
git-insight-mcp branches
git-insight-mcp branches --remote --remote-name italents --base main
git-insight-mcp recent alice
git-insight-mcp commit a3e577e
git-insight-mcp intro-pr src/auth.ts:42
git-insight-mcp intro-pr a3e577e
git-insight-mcp                # MCP stdio server
```

## Build from source

```bash
git clone https://github.com/flaviomartil/git-insight-mcp.git
cd git-insight-mcp
npm ci --ignore-scripts
npm run build
node dist/cli.js branches
```

## Local corrections and limits

- GitHub API enrichment; local message links also support Bitbucket and Azure DevOps. Other providers use existing harness tools for API metadata.
- `co_change` uses one batched history query, defaults to 1000 commits and rejects windows above 5000. It returns `count`; correlation does not establish dependency.
- `commit_context.files_changed` contains objects with `path`, `insertions` and `deletions`. `recent_work` includes per-commit statistics and totals for the same limited commit window.
- Remote branch merge checks inspect remote refs, support a selected remote and reject an unresolved base instead of fabricating zero counts.
- Numeric inputs and blame ranges are validated. SQLite dependencies reserved for future work have been removed.
- The lockfile includes patched transitive dependencies for the advisories found during adaptation; verify it with `npm audit --omit=dev`.
- Function-level blame is by line range, not AST. Renames not yet tracked.
- GH API rate limit applies (5000/h authed). PR results uncached this version.

## License

MIT
