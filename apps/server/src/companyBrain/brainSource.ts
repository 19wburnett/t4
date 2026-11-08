export type RepositoryTarget =
  | { readonly _tag: "github"; readonly repository: string }
  | { readonly _tag: "url"; readonly url: string };

const OWNER_REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

/** `owner/repo` and github.com links go through the GitHub lookup; other clone URLs as given. */
export function parseRepositoryInput(input: string): RepositoryTarget | null {
  const trimmed = input.trim().replace(/\.git$/, "");
  if (OWNER_REPO.test(trimmed)) return { _tag: "github", repository: trimmed };
  const githubSsh = /^git@github\.com:([^/]+\/[^/]+)$/.exec(trimmed);
  if (githubSsh?.[1] !== undefined) return { _tag: "github", repository: githubSsh[1] };
  try {
    const url = new URL(input.trim());
    if (url.hostname === "github.com" || url.hostname === "www.github.com") {
      const [owner, repo] = url.pathname.split("/").filter(Boolean);
      const repository = `${owner}/${repo?.replace(/\.git$/, "")}`;
      return owner && repo && OWNER_REPO.test(repository) ? { _tag: "github", repository } : null;
    }
    return ["https:", "http:", "ssh:", "git:", "file:"].includes(url.protocol)
      ? { _tag: "url", url: input.trim() }
      : null;
  } catch {
    return /^[^@\s]+@[^:\s]+:\S+$/.test(input.trim()) ? { _tag: "url", url: input.trim() } : null;
  }
}

/** Remote URLs and git's messages can carry tokens; clients never see them. */
export const redactUrl = (text: string) => text.replace(/(\w+:\/\/)[^/@\s]+@/g, "$1");

export function parseGitStatus(porcelain: string) {
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  let changes = 0;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("# branch.head ")) {
      const head = line.slice("# branch.head ".length).trim();
      branch = head === "(detached)" ? null : head;
    } else if (line.startsWith("# branch.ab ")) {
      const match = /\+(\d+) -(\d+)/.exec(line);
      ahead = Number(match?.[1] ?? 0);
      behind = Number(match?.[2] ?? 0);
    } else if (line.trim() !== "" && !line.startsWith("#")) {
      changes++;
    }
  }
  return { branch, ahead, behind, changes };
}
