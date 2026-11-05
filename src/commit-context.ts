import { git, resolveRevision, parseNumstat } from "./git.js";
import { lookupPR, parseIssuesFromMessage } from "./github.js";
import type { CommitContextResult } from "./types.js";

const FILES_CAP = 32;

export async function commitContext(opts: { cwd: string; sha: string; remoteName?: string }): Promise<CommitContextResult> {
  const sha = await resolveRevision(opts.sha, opts.cwd);
  const showOut = await git(["show", "--format=%h%x00%an%x00%aI%x00%s%x00%b%x00%x00%x00", "--numstat", "-z", sha], opts.cwd);
  const sepIdx = showOut.indexOf("\0\0\0");
  const header = sepIdx >= 0 ? showOut.slice(0, sepIdx) : showOut;
  const numstatRaw = sepIdx >= 0 ? showOut.slice(sepIdx + 3).replace(/^[\0\n]+/, "") : "";
  const [short = "", author = "", date = "", subject = "", rawBody = ""] = header.split("\0");
  const body = rawBody.trim();
  const allFiles = parseNumstat(numstatRaw);
  const files = allFiles.slice(0, FILES_CAP);
  const fullMessage = `${subject}\n\n${body}`;
  const { pr } = await lookupPR({ cwd: opts.cwd, sha, message: fullMessage, remoteName: opts.remoteName });
  return {
    sha, short_sha: short, author, date, subject, body, files_changed: files,
    insertions: allFiles.reduce((sum, file) => sum + file.insertions, 0),
    deletions: allFiles.reduce((sum, file) => sum + file.deletions, 0),
    pr, related_issues: parseIssuesFromMessage(fullMessage),
  };
}
