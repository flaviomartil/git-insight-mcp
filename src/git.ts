import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { relative, resolve, isAbsolute } from "node:path";
import type { FileStat } from "./types.js";

const exec = promisify(execFile);

export class GitError extends Error {
  constructor(message: string, public stderr?: string) {
    super(message);
    this.name = "GitError";
  }
}

export async function git(args: string[], cwd: string): Promise<string> {
  try {
    const { stdout } = await exec("git", ["--literal-pathspecs", ...args], { cwd, timeout: 30000, maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  } catch (e: any) {
    throw new GitError(e?.message ?? "git failed", e?.stderr);
  }
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await git(["rev-parse", "--git-dir"], cwd);
    return true;
  } catch {
    return false;
  }
}

export async function getRepoRoot(cwd: string): Promise<string> {
  return (await git(["rev-parse", "--show-toplevel"], cwd)).trim();
}

export async function currentBranch(cwd: string): Promise<string> {
  return (await git(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
}

export async function defaultBranch(cwd: string, remoteName = "origin"): Promise<string> {
  // try origin/HEAD symbolic-ref, fall back to common names
  try {
    const out = await git(["symbolic-ref", `refs/remotes/${remoteName}/HEAD`], cwd);
    return out.trim().slice(`refs/remotes/${remoteName}/`.length);
  } catch {
    const branches = (await git(["for-each-ref", "--format=%(refname:short)", "refs/heads/", `refs/remotes/${remoteName}/`], cwd)).split("\n");
    for (const cand of ["main", "master", "develop"]) {
      if (branches.includes(cand) || branches.includes(`${remoteName}/${cand}`)) return cand;
    }
    throw new Error("Cannot resolve the default branch; provide base explicitly");
  }
}

export async function gitOriginUrl(cwd: string): Promise<string | null> {
  try {
    return (await git(["config", "--get", "remote.origin.url"], cwd)).trim() || null;
  } catch {
    return null;
  }
}

export interface ParsedRemote {
  host: string;
  owner: string;
  repo: string;
}

export function parseRemoteUrl(url: string): ParsedRemote | null {
  let host: string;
  let path: string;
  const ssh = url.match(/^[^@/]+@([^:]+):(.+)$/);
  if (ssh) {
    host = ssh[1];
    path = ssh[2];
  } else {
    try {
      const parsed = new URL(url);
      if (!["https:", "http:", "ssh:"].includes(parsed.protocol)) return null;
      host = parsed.hostname;
      path = parsed.pathname.replace(/^\//, "");
    } catch {
      return null;
    }
  }
  path = path.replace(/\/$/, "").replace(/\.git$/, "");
  if (host === "altssh.bitbucket.org") host = "bitbucket.org";
  if (host === "ssh.github.com") host = "github.com";
  const azure = path.match(/^(?:v3\/)?([^/]+)\/([^/]+)\/(?:_git\/)?([^/]+)$/);
  if (["ssh.dev.azure.com", "dev.azure.com"].includes(host) && azure) {
    return { host, owner: `${azure[1]}/${azure[2]}`, repo: azure[3] };
  }
  const parts = path.split("/");
  if (host.endsWith(".visualstudio.com")) {
    const marker = parts.indexOf("_git");
    if (marker > 0 && parts[marker + 1]) return { host: "dev.azure.com", owner: `${host.split(".")[0]}/${parts[marker - 1]}`, repo: parts[marker + 1] };
  }
  return parts.length === 2 && parts.every(Boolean) ? { host, owner: parts[0], repo: parts[1] } : null;
}

export function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(`Expected an integer between ${min} and ${max}`);
  return result;
}

export async function resolveRevision(ref: string, cwd: string): Promise<string> {
  return (await git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], cwd)).trim();
}

export async function repoFile(file: string, cwd: string): Promise<string> {
  const root = await getRepoRoot(cwd);
  const path = relative(root, resolve(root, file));
  if (!path || path === ".." || path.startsWith("../") || isAbsolute(path) || path.includes("\0")) throw new Error("File must be inside the repository");
  return path;
}

export function parseNumstat(output: string): FileStat[] {
  const tokens = output.replace(/^\n/, "").split("\0");
  const files: FileStat[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const match = tokens[i].match(/^(\d+|-)\t(\d+|-)\t([\s\S]*)$/);
    if (!match) continue;
    let path = match[3];
    if (!path) {
      i++;
      path = tokens[++i];
    }
    if (!path) throw new Error("Invalid numstat filename");
    files.push({ path, insertions: match[1] === "-" ? 0 : Number(match[1]), deletions: match[2] === "-" ? 0 : Number(match[2]) });
  }
  return files;
}

export interface BlameLine {
  sha: string;
  author: string;
  authorMail: string;
  authorTime: number;
  lineNo: number;
  content: string;
}

export async function blameFile(file: string, opts: { cwd: string; lineRange?: [number, number] }): Promise<BlameLine[]> {
  const args = ["blame", "--porcelain"];
  if (opts.lineRange) {
    const start = boundedInteger(opts.lineRange[0], 1, 1, Number.MAX_SAFE_INTEGER);
    const end = boundedInteger(opts.lineRange[1], start, start, Number.MAX_SAFE_INTEGER);
    args.push("-L", `${start},${end}`);
  }
  args.push("--", await repoFile(file, opts.cwd));
  const out = await git(args, opts.cwd);
  return parsePorcelainBlame(out);
}

export function parsePorcelainBlame(porcelain: string): BlameLine[] {
  const out: BlameLine[] = [];
  const lines = porcelain.split("\n");
  const meta = new Map<string, Record<string, string>>();
  let i = 0;
  while (i < lines.length) {
    const header = lines[i++];
    if (!header) break;
    const m = header.match(/^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/);
    if (!m) continue;
    const sha = m[1];
    const lineNo = parseInt(m[3], 10);
    const seen = meta.get(sha) ?? {};
    while (i < lines.length && !lines[i].startsWith("\t")) {
      const kv = lines[i++];
      const sp = kv.indexOf(" ");
      if (sp === -1) continue;
      const k = kv.slice(0, sp);
      const v = kv.slice(sp + 1);
      seen[k] = v;
    }
    meta.set(sha, seen);
    const content = (lines[i++] ?? "").replace(/^\t/, "");
    out.push({
      sha,
      author: seen.author ?? "",
      authorMail: (seen["author-mail"] ?? "").replace(/^<|>$/g, ""),
      authorTime: parseInt(seen["author-time"] ?? "0", 10),
      lineNo,
      content,
    });
  }
  return out;
}
