import { git, blameFile, resolveRevision } from "./git.js";
import { lookupPR } from "./github.js";
import type { IntroducingPRResult } from "./types.js";

export async function introducingPR(opts: {
  cwd: string;
  file?: string;
  line?: number;
  commit?: string;
  remoteName?: string;
}): Promise<IntroducingPRResult> {
  let ref = opts.commit;
  if (!ref) {
    if (!opts.file || opts.line === undefined) throw new Error("Provide either commit OR (file + line)");
    const blame = await blameFile(opts.file, { cwd: opts.cwd, lineRange: [opts.line, opts.line] });
    if (!blame.length) throw new Error(`No blame for ${opts.file}:${opts.line}`);
    ref = blame[0].sha;
  }
  const sha = await resolveRevision(ref, opts.cwd);
  const [author, date, rawMessage] = (await git(["show", "--no-patch", "--format=%an%x00%aI%x00%B", sha], opts.cwd)).split("\0");
  const message = rawMessage.trim();
  const { pr, source } = await lookupPR({ cwd: opts.cwd, sha, message, remoteName: opts.remoteName });
  return { commit: sha, commit_message: message, commit_date: date, author, pr, source };
}
