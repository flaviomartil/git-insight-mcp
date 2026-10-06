import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { coChange } from "../co-change.js";
import { recentWork } from "../recent-work.js";
import { commitContext } from "../commit-context.js";
import { introducingPR } from "../introducing-pr.js";
import { branchHygiene } from "../branch-hygiene.js";
import { parseRemoteUrl, parseNumstat, resolveRevision } from "../git.js";
import { localPRUrl, fetchPRForCommit } from "../github.js";

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "git-insight-regression-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.invalid");
  const commit = (message: string) => { git("add", "--all"); git("commit", "-m", message); return git("rev-parse", "HEAD"); };
  writeFileSync(join(cwd, "target.ts"), "one\n");
  writeFileSync(join(cwd, "paired\t test.ts"), "one\n");
  writeFileSync(join(cwd, "empty.ts"), "");
  writeFileSync(join(cwd, "binary.dat"), Buffer.from([0, 1, 2]));
  const initial = commit("initial");
  writeFileSync(join(cwd, "target.ts"), "one\ntwo\n");
  writeFileSync(join(cwd, "paired\t test.ts"), "one\ntwo\n");
  writeFileSync(join(cwd, "space\nline.ts"), "first\n");
  const second = commit("paired change");
  writeFileSync(join(cwd, "other.ts"), "unrelated\n");
  commit("unrelated change");
  git("mv", "paired\t test.ts", "renamed.ts");
  const rename = commit("rename");
  writeFileSync(join(cwd, "target.ts"), "one\ntwo\nthree\n");
  const head = commit("Merge pull request #42 from feature");
  git("remote", "add", "origin", "https://dev.azure.com/example/project/_git/repo");
  git("remote", "add", "github", "https://github.com/example/repo.git");
  git("remote", "add", "italents", "https://bitbucket.org/example/repo.git");
  git("update-ref", "refs/remotes/italents/main", head);
  git("update-ref", "refs/remotes/italents/merged", second);
  git("update-ref", "refs/remotes/italents/feature", initial);
  return { cwd, git, head, initial, second, rename, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

test("co-change batches history, keeps literal filenames and bounds the window", async () => {
  const f = fixture();
  try {
    const result = await coChange({ cwd: f.cwd, file: "./target.ts", threshold: 1 });
    assert.equal(result.total_commits_touching, 3);
    assert.deepEqual(result.co_changed.find((file) => file.file === "paired\t test.ts"), { file: "paired\t test.ts", count: 2, ratio: 0.667 });
    assert.equal(result.co_changed.some((file) => file.file === "other.ts"), false);
    assert.equal(result.co_changed.some((file) => file.file === "target.ts"), false);
    assert.equal(result.co_changed.some((file) => file.file === "space\nline.ts"), true);
    assert.equal((await coChange({ cwd: f.cwd, file: "target.ts", threshold: 1, window: 1 })).co_changed.length, 0);
    assert.equal((await coChange({ cwd: f.cwd, file: ":(glob)*", threshold: 1 })).total_commits_touching, 0);
    await assert.rejects(coChange({ cwd: f.cwd, file: "target.ts", window: -1 }), /integer/);
    await assert.rejects(coChange({ cwd: f.cwd, file: "target.ts", window: 5001 }), /integer/);
    await assert.rejects(coChange({ cwd: f.cwd, file: "../outside" }), /inside/);
    const merge = f.git("commit-tree", f.git("rev-parse", "HEAD^{tree}"), "-p", f.initial, "-p", f.second, "-m", "merge fixture");
    f.git("update-ref", "refs/heads/main", merge);
    const merged = await coChange({ cwd: f.cwd, file: "target.ts", threshold: 1 });
    assert.equal(merged.total_commits_touching, 3);
    assert.equal(merged.co_changed.some((file) => /^[0-9a-f]{40,64}$/.test(file.file)), false);
  } finally { f.cleanup(); }
});

test("commit and recent-work statistics preserve renames, binaries and limited totals", async () => {
  const f = fixture();
  try {
    const recent = await recentWork({ cwd: f.cwd, since: "2000-01-01", limit: 1 });
    assert.equal(recent.commit_count, 1);
    assert.equal(recent.files_touched, 1);
    assert.equal(recent.insertions, 1);
    assert.equal(recent.commits[0].files, 1);
    assert.equal(recent.commits[0].insertions, recent.insertions);
    const renamed = await commitContext({ cwd: f.cwd, sha: f.rename, remoteName: "italents" });
    assert.deepEqual(renamed.files_changed, [{ path: "renamed.ts", insertions: 0, deletions: 0 }]);
    const initial = await commitContext({ cwd: f.cwd, sha: f.initial, remoteName: "italents" });
    assert.deepEqual(initial.files_changed.find((file) => file.path === "binary.dat"), { path: "binary.dat", insertions: 0, deletions: 0 });
    const changed = await commitContext({ cwd: f.cwd, sha: f.second, remoteName: "italents" });
    assert.equal(changed.files_changed.some((file) => file.path === "space\nline.ts"), true);
    assert.deepEqual(parseNumstat("1\t2\t\0old\0new\0"), [{ path: "new", insertions: 1, deletions: 2 }]);
    await assert.rejects(resolveRevision("--output=/tmp/should-not-exist", f.cwd));
    f.git("commit", "--allow-empty", "--allow-empty-message", "-m", "");
    const empty = await recentWork({ cwd: f.cwd, since: "2000-01-01", limit: 1 });
    assert.equal(empty.commits[0].subject, "");
    assert.equal(empty.insertions, 0);
  } finally { f.cleanup(); }
});

test("remote branches and offline PRs use the selected provider", async () => {
  const f = fixture();
  try {
    const branches = await branchHygiene({ cwd: f.cwd, remote: true, remoteName: "italents", staleDays: 0 });
    assert.equal(branches.some((branch) => branch.name === "italents/main"), false);
    assert.equal(branches.find((branch) => branch.name === "italents/merged")?.merged, true);
    assert.equal(branches.find((branch) => branch.name === "italents/merged")?.behind, 3);
    assert.equal(branches.find((branch) => branch.name === "italents/merged")?.ahead, 0);
    await assert.rejects(branchHygiene({ cwd: f.cwd, base: "missing" }));
    const preferred = await introducingPR({ cwd: f.cwd, commit: f.head });
    assert.equal(preferred.pr?.url, "https://dev.azure.com/example/project/_git/repo/pullrequest/42");
    assert.equal((await introducingPR({ cwd: f.cwd, commit: f.head, remoteName: "github" })).pr?.url, "https://github.com/example/repo/pull/42");
    assert.equal(preferred.source, "merge-commit-parse");
    assert.equal((await introducingPR({ cwd: f.cwd, commit: f.head, remoteName: "origin" })).pr?.url, "https://dev.azure.com/example/project/_git/repo/pullrequest/42");
    assert.equal((await introducingPR({ cwd: f.cwd, file: "target.ts", line: 3, remoteName: "italents" })).pr?.url, "https://bitbucket.org/example/repo/pull-requests/42");
    for (const url of ["git@ssh.dev.azure.com:v3/example/project/repo", "ssh://git@ssh.dev.azure.com/v3/example/project/repo", "https://example.visualstudio.com/DefaultCollection/project/_git/repo"]) {
      assert.equal(localPRUrl(parseRemoteUrl(url)!, 7), "https://dev.azure.com/example/project/_git/repo/pullrequest/7");
    }
    await assert.rejects(introducingPR({ cwd: f.cwd, commit: f.head, remoteName: "absent" }), /Unknown remote/);
  } finally { f.cleanup(); }
});

test("GitHub enrichment reuses gh without extracting credentials", async () => {
  const f = fixture();
  const previous = { PATH: process.env.PATH, GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
  const calls = join(f.cwd, "gh-calls.jsonl");
  writeFileSync(join(f.cwd, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const path = args.at(-1);
const value = path.includes("/commits/") ? [{ number: 9, merged_at: "2026-01-01" }] : path.includes("/reviews") ? [{ user: { login: "reviewer" } }] : { number: 9, title: "Fixture PR", html_url: "https://github.com/example/repo/pull/9", merged_at: null, user: { login: "author" } };
process.stdout.write(JSON.stringify(value));
`);
  chmodSync(join(f.cwd, "gh"), 0o700);
  process.env.PATH = `${f.cwd}:${previous.PATH}`;
  process.env.GH_TOKEN = "";
  process.env.GITHUB_TOKEN = "";
  try {
    const pr = await fetchPRForCommit({ owner: "example", repo: "repo", commitSha: f.initial });
    assert.equal(pr?.number, 9);
    assert.deepEqual(pr?.reviewers, ["reviewer"]);
    const requests = readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(requests.length, 3);
    assert.ok(requests.every((args) => args[0] === "api" && args.includes("github.com") && !args.includes("auth")));
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    f.cleanup();
  }
});

test("all MCP outputs validate through the real SDK client and bad input is rejected", async () => {
  const f = fixture();
  const client = new Client({ name: "regression", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("../index.js", import.meta.url))], cwd: f.cwd });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    assert.equal(tools.length, 6);
    for (const [name, args] of [
      ["who_touched", { file: "empty.ts" }],
      ["introducing_pr", { commit: f.head }],
      ["co_change", { file: "target.ts", threshold: 1 }],
      ["branch_hygiene", { remote: true, remote_name: "italents", stale_days: 0 }],
      ["recent_work", { since: "2000-01-01", limit: 1 }],
      ["commit_context", { sha: f.head }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, undefined, name);
      assert.ok(result.structuredContent, name);
      assert.deepEqual(JSON.parse((result.content as Array<{ text: string }>)[0].text), result.structuredContent);
    }
    for (const [name, args] of [
      ["co_change", { file: "target.ts", window: 0 }],
      ["co_change", { file: "target.ts", window: "10" }],
      ["who_touched", { file: "target.ts", line_start: 1 }],
      ["who_touched", { file: "target.ts", line_start: 2, line_end: 1 }],
      ["branch_hygiene", { remote: "false" }],
    ] as const) assert.equal((await client.callTool({ name, arguments: args })).isError, true);
    const cli = fileURLToPath(new URL("../cli.js", import.meta.url));
    const result = JSON.parse(execFileSync(process.execPath, [cli, "co-change", "target.ts", "--cwd", f.cwd, "--window", "1", "--threshold", "1", "--compact"], { encoding: "utf8" }));
    assert.equal(result.total_commits_touching, 1);
    assert.equal(result.co_changed.length, 0);
    assert.equal(f.git("status", "--porcelain"), "");
  } finally {
    await client.close();
    await transport.close();
    f.cleanup();
  }
});
