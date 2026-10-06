import { git, boundedInteger, parseNumstat } from "./git.js";
import { parsePRNumberFromMessage } from "./github.js";
import type { RecentWorkResult } from "./types.js";

export async function recentWork(opts: {
  cwd: string;
  author?: string;
  since?: string;
  limit?: number;
}): Promise<RecentWorkResult> {
  const since = opts.since ?? "7 days ago";
  const limit = boundedInteger(opts.limit, 100, 1, 1000);
  const author = opts.author ?? (await git(["config", "user.name"], opts.cwd)).trim();
  if (!author) throw new Error("Provide author or configure git user.name");
  const output = await git(["log", `--author=${author}`, `--since=${since}`, "-n", String(limit), "--format=%x00%x00%x00%H%x00%aI%x00%s", "--numstat", "-z"], opts.cwd);
  const filesSet = new Set<string>();
  const commits = output.split(/\0{3,}/).filter(Boolean).map((record) => {
    const [sha, date, subject = "", ...stats] = record.split("\0");
    const files = parseNumstat(stats.join("\0"));
    for (const file of files) filesSet.add(file.path);
    return {
      sha, date, subject,
      pr: parsePRNumberFromMessage(subject) ?? undefined,
      files: files.length,
      insertions: files.reduce((sum, file) => sum + file.insertions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    };
  });
  return {
    author, since, commit_count: commits.length, files_touched: filesSet.size,
    insertions: commits.reduce((sum, commit) => sum + commit.insertions, 0),
    deletions: commits.reduce((sum, commit) => sum + commit.deletions, 0),
    commits,
  };
}
