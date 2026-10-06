import { git, defaultBranch, boundedInteger, resolveRevision } from "./git.js";
import type { BranchInfo } from "./types.js";

export async function branchHygiene(opts: {
  cwd: string;
  staleDays?: number;
  remote?: boolean;
  remoteName?: string;
  base?: string;
}): Promise<BranchInfo[]> {
  const staleDays = boundedInteger(opts.staleDays, 30, 0, 36500);
  const remoteName = opts.remoteName ?? "origin";
  const main = opts.base ?? await defaultBranch(opts.cwd, remoteName);
  const refPrefix = opts.remote ? `refs/remotes/${remoteName}/` : "refs/heads/";
  const baseRef = opts.remote ? `${remoteName}/${main}` : main;
  let base: string;
  try {
    base = await resolveRevision(baseRef, opts.cwd);
  } catch (error) {
    if (opts.remote || opts.base) throw error;
    base = await resolveRevision(`${remoteName}/${main}`, opts.cwd);
  }
  const merged = new Set((await git(["for-each-ref", `--merged=${base}`, "--format=%(refname:short)", refPrefix], opts.cwd)).trim().split("\n"));
  const out = await git(["for-each-ref", "--format=%(refname:short)%00%(committerdate:iso8601)%00%(authorname)", refPrefix], opts.cwd);
  const branches: BranchInfo[] = [];
  for (const line of out.split("\n").filter(Boolean)) {
    const [name, dateStr, author] = line.split("\0");
    if (name === main || name === `${remoteName}/${main}` || name === `${remoteName}/HEAD`) continue;
    const counts = await git(["rev-list", "--left-right", "--count", `${base}...${name}`], opts.cwd);
    const [behind, ahead] = counts.trim().split(/\s+/).map(Number);
    const last = new Date(dateStr).getTime();
    branches.push({ name, ahead, behind, last_commit_date: dateStr, last_commit_author: author, merged: merged.has(name), stale: Number.isFinite(last) && Date.now() - last > staleDays * 86400000 });
  }
  return branches.sort((a, b) => b.last_commit_date.localeCompare(a.last_commit_date));
}
