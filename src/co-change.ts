import { git, boundedInteger, repoFile } from "./git.js";
import type { CoChangeResult, CoChangeEntry } from "./types.js";

export async function coChange(opts: {
  cwd: string;
  file: string;
  window?: number;
  threshold?: number;
  limit?: number;
}): Promise<CoChangeResult> {
  const window = boundedInteger(opts.window, 1000, 1, 5000);
  const threshold = boundedInteger(opts.threshold, 3, 1, 5000);
  const limit = boundedInteger(opts.limit, 20, 1, 1000);
  const file = await repoFile(opts.file, opts.cwd);
  const output = await git(["log", "-n", String(window), "--format=%x00%x00%x00%H", "--name-only", "-z", "--full-diff", "--diff-merges=dense-combined", "--no-renames", "--", file], opts.cwd);
  const commits = output.split(/\0{3,}/).filter(Boolean);
  const counts = new Map<string, number>();
  for (const commit of commits) {
    const separator = commit.indexOf("\0");
    if (separator < 0) continue;
    const paths = commit.slice(separator + 1).replace(/^\n/, "").split("\0").filter(Boolean);
    for (const path of new Set(paths)) {
      if (path !== file) counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  const total = commits.length;
  const entries: CoChangeEntry[] = Array.from(counts.entries())
    .filter(([, count]) => count >= threshold)
    .map(([file, count]) => ({ file, count, ratio: +(count / total).toFixed(3) }))
    .sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))
    .slice(0, limit);
  return { file, total_commits_touching: total, co_changed: entries };
}
