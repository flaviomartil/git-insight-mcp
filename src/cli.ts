#!/usr/bin/env node
import { parseArgs } from "node:util";
import { getRepoRoot } from "./git.js";
import { whoTouched } from "./who-touched.js";
import { coChange } from "./co-change.js";
import { branchHygiene } from "./branch-hygiene.js";
import { recentWork } from "./recent-work.js";
import { commitContext } from "./commit-context.js";
import { introducingPR } from "./introducing-pr.js";

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      cwd: { type: "string" }, window: { type: "string" }, threshold: { type: "string" },
      limit: { type: "string" }, since: { type: "string" }, "stale-days": { type: "string" },
      "remote-name": { type: "string" }, base: { type: "string" }, remote: { type: "boolean" },
      "line-start": { type: "string" }, "line-end": { type: "string" },
      compact: { type: "boolean" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" },
    },
  });
  if (values.help) return help();
  if (values.version) {
    const { readFile } = await import("node:fs/promises");
    console.log(JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version);
    return;
  }
  const [cmd = "server", arg, ...extra] = positionals;
  if (extra.length) throw new Error("Too many positional arguments");
  if (cmd === "server") {
    if (values.cwd) process.chdir(values.cwd);
    await import("./index.js");
    return;
  }
  const cwd = await getRepoRoot(values.cwd ?? process.cwd());
  const numeric = (value: string | undefined) => value === undefined ? undefined : Number(value);
  const remoteName = values["remote-name"];
  let result: unknown;
  switch (cmd) {
    case "who-touched": {
      if (!arg) throw new Error("usage: git-insight-mcp who-touched <file>");
      const start = numeric(values["line-start"]);
      const end = numeric(values["line-end"]);
      if ((start === undefined) !== (end === undefined)) throw new Error("Provide both --line-start and --line-end");
      result = await whoTouched({ cwd, file: arg, lineRange: start === undefined ? undefined : [start, end!] });
      break;
    }
    case "co-change":
      if (!arg) throw new Error("usage: git-insight-mcp co-change <file>");
      result = await coChange({ cwd, file: arg, window: numeric(values.window), threshold: numeric(values.threshold), limit: numeric(values.limit) });
      break;
    case "branches":
      result = await branchHygiene({ cwd, remote: values.remote, remoteName, base: values.base, staleDays: numeric(values["stale-days"]) });
      break;
    case "recent":
      result = await recentWork({ cwd, author: arg, since: values.since, limit: numeric(values.limit) });
      break;
    case "commit":
      if (!arg) throw new Error("usage: git-insight-mcp commit <revision>");
      result = await commitContext({ cwd, sha: arg, remoteName });
      break;
    case "intro-pr": {
      if (!arg) throw new Error("usage: git-insight-mcp intro-pr <revision|file:line>");
      const colon = arg.lastIndexOf(":");
      result = await introducingPR(colon >= 0
        ? { cwd, file: arg.slice(0, colon), line: Number(arg.slice(colon + 1)), remoteName }
        : { cwd, commit: arg, remoteName });
      break;
    }
    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
  console.log(JSON.stringify(result, null, values.compact ? undefined : 2));
}

function help() {
  console.log(`git-insight-mcp [server|who-touched|co-change|branches|recent|commit|intro-pr] [argument]
--cwd <repo>                 Repository root or subdirectory
--window <1..5000>           Co-change commit window (default 1000)
--threshold <1..5000>        Minimum co-change count (default 3)
--limit <1..1000>            Maximum results
--line-start N --line-end N  Blame range
--remote                    Inspect remote branches
--remote-name <name>        Select the remote for branches or PRs
--base <branch>             Branch comparison base
--stale-days <0..36500>      Stale branch age (default 30)
--since <git date>          Recent-work start (default 7 days ago)
--compact                   Compact JSON
--version | --help

GitHub API: GH_TOKEN/GITHUB_TOKEN or existing gh authentication.
Local PR references: GitHub, Bitbucket and Azure DevOps, without a token.`);
}

main().catch((error) => {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
});
