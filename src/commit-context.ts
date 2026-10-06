import { git, resolveRevision, parseNumstat } from "./git.js";
import { lookupPR, parseIssuesFromMessage } from "./github.js";
import type { CommitContextResult } from "./types.js";

export async function commitContext(opts: { cwd: string; sha: string; remoteName?: string }): Promise<CommitContextResult> {
  const sha = await resolveRevision(opts.sha, opts.cwd);
  const showOut = await git(["show", "--no-patch", "--format=%h%x00%an%x00%aI%x00%s%x00%b", sha], opts.cwd);
  const [short, author, date, subject, rawBody] = showOut.split("\0");
  const body = rawBody.trim();
  const files = parseNumstat(await git(["show", "--numstat", "-z", "--pretty=format:", sha], opts.cwd));
  const fullMessage = `${subject}\n\n${body}`;
  const { pr } = await lookupPR({ cwd: opts.cwd, sha, message: fullMessage, remoteName: opts.remoteName });
  return {
    sha, short_sha: short, author, date, subject, body, files_changed: files,
    insertions: files.reduce((sum, file) => sum + file.insertions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    pr, related_issues: parseIssuesFromMessage(fullMessage),
  };
}
