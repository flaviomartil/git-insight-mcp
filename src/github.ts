import { Octokit } from "@octokit/rest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { git, parseRemoteUrl } from "./git.js";
import type { ParsedRemote } from "./git.js";
import type { PRRef, IntroducingPRResult } from "./types.js";

const exec = promisify(execFile);
let cached: Octokit | null = null;

export function getOctokit(): Octokit | null {
  if (cached) return cached;
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  if (!token) return null;
  cached = new Octokit({ auth: token, request: { timeout: 10000 } });
  return cached;
}

export interface PRLookupArgs {
  owner: string;
  repo: string;
  commitSha?: string;
  prNumber?: number;
}

async function githubRequest(path: string): Promise<any> {
  const oct = getOctokit();
  if (oct) return (await oct.request(`GET /${path}`)).data;
  const { stdout } = await exec("gh", ["api", "--hostname", "github.com", "--method", "GET", path], { timeout: 15000, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout);
}

export async function fetchPRForCommit(args: PRLookupArgs): Promise<PRRef | null> {
  const prefix = `repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}`;
  try {
    let number = args.prNumber;
    if (!number && args.commitSha) {
      const prs = await githubRequest(`${prefix}/commits/${encodeURIComponent(args.commitSha)}/pulls?per_page=5`);
      number = (prs.find((pr: any) => pr.merged_at) ?? prs[0])?.number;
    }
    if (!number) return null;
    const pr = await githubRequest(`${prefix}/pulls/${number}`);
    let reviewers: string[];
    try {
      const reviews = await githubRequest(`${prefix}/pulls/${number}/reviews?per_page=100`);
      reviewers = [...new Set<string>(reviews.map((review: any) => review.user?.login).filter(Boolean))];
    } catch {
      reviewers = (pr.requested_reviewers ?? []).map((user: any) => user.login).filter(Boolean);
    }
    return { number: pr.number, title: pr.title, url: pr.html_url, merged_at: pr.merged_at, author: pr.user?.login ?? "", reviewers };
  } catch {
    return null;
  }
}

async function findRemote(cwd: string, remoteName?: string): Promise<ParsedRemote | null> {
  const names = (await git(["remote"], cwd)).trim().split("\n").filter(Boolean);
  if (remoteName && !names.includes(remoteName)) throw new Error("Unknown remote");
  const ordered = remoteName ? [remoteName] : [...names].sort((a, b) => Number(b === "origin") - Number(a === "origin"));
  for (const name of ordered) {
    let url = (await git(["remote", "get-url", name], cwd)).trim();
    const sshHost = url.match(/^[^@/]+@([^:]+):/)?.[1] ?? (url.startsWith("ssh://") ? new URL(url).hostname : undefined);
    if (sshHost && !["github.com", "bitbucket.org", "ssh.dev.azure.com"].includes(sshHost)) {
      try {
        const { stdout } = await exec("ssh", ["-G", "--", sshHost], { timeout: 3000, maxBuffer: 256 * 1024 });
        const host = stdout.match(/^hostname (.+)$/m)?.[1];
        if (host) url = url.replace(sshHost, host);
      } catch {}
    }
    const parsed = parseRemoteUrl(url);
    if (!parsed) continue;
    if (["github.com", "bitbucket.org", "dev.azure.com", "ssh.dev.azure.com"].includes(parsed.host)) return parsed;
  }
  return null;
}

export function localPRUrl(remote: ParsedRemote, number: number): string | null {
  const owner = remote.owner.split("/").map(encodeURIComponent).join("/");
  const repo = encodeURIComponent(remote.repo);
  if (remote.host === "github.com") return `https://github.com/${owner}/${repo}/pull/${number}`;
  if (remote.host === "bitbucket.org") return `https://bitbucket.org/${owner}/${repo}/pull-requests/${number}`;
  if (["dev.azure.com", "ssh.dev.azure.com"].includes(remote.host)) return `https://dev.azure.com/${owner}/_git/${repo}/pullrequest/${number}`;
  return null;
}

export async function lookupPR(opts: { cwd: string; sha: string; message: string; remoteName?: string }): Promise<Pick<IntroducingPRResult, "pr" | "source">> {
  const remote = await findRemote(opts.cwd, opts.remoteName);
  if (!remote) return { pr: null, source: "not-found" };
  const number = parsePRNumberFromMessage(opts.message);
  if (number) {
    const url = localPRUrl(remote, number);
    if (url) return { pr: { number, url, title: opts.message.split("\n")[0], author: "", merged_at: null, reviewers: [] }, source: "merge-commit-parse" };
  }
  const pr = remote.host === "github.com" ? await fetchPRForCommit({ owner: remote.owner, repo: remote.repo, commitSha: opts.sha }) : null;
  return { pr, source: pr ? "github-api" : "not-found" };
}

export function parsePRNumberFromMessage(msg: string): number | null {
  const match = msg.match(/(?:pull request #?|\(#|PR-?|Merged PR\s+)(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

export function parseIssuesFromMessage(msg: string): number[] {
  const out = new Set<number>();
  const re = /(?:fix(?:es)?|close[sd]?|resolve[sd]?)\s+#(\d+)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(msg)) !== null) out.add(parseInt(match[1], 10));
  return Array.from(out);
}
