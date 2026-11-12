import type { GitHubClient } from "./github";
import { GitHubError } from "./github";

export const ASSETS_BRANCH = "tidy-assets";
export const KEEP_DAYS = 30;

/** Top-level date folders older than the cutoff, which the next commit leaves out. */
export function expiredFolders(names: string[], now: Date, days = KEEP_DAYS): string[] {
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  return names.filter((name) => !/^\d{4}-\d{2}-\d{2}$/.test(name) || name < cutoff);
}

async function readBranch(gh: GitHubClient, repo: string) {
  try {
    const ref = await gh.request<{ object: { sha: string } }>(`/repos/${repo}/git/ref/heads/${ASSETS_BRANCH}`);
    const commit = await gh.request<{ tree: { sha: string } }>(`/repos/${repo}/git/commits/${ref.object.sha}`);
    const tree = await gh.request<{ tree: { path: string; type: string }[] }>(`/repos/${repo}/git/trees/${commit.tree.sha}`);
    return { commit: ref.object.sha, tree: commit.tree.sha, folders: tree.tree.filter((e) => e.type === "tree").map((e) => e.path) };
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return null;
    throw error;
  }
}

/**
 * Stores files on the `tidy-assets` branch and returns a raw URL per path. GitHub's attachment
 * upload refuses App tokens, so the branch is the GitHub-only place an App can put images. It is
 * always a single commit holding the last 30 days, so it stays small and old files drop out.
 */
export async function storeAssets(gh: GitHubClient, repo: string, files: { path: string; data: Buffer }[]): Promise<Map<string, string>> {
  const blobs: { path: string; mode: string; type: string; sha: string }[] = [];
  for (const file of files) {
    const blob = await gh.request<{ sha: string }>(`/repos/${repo}/git/blobs`, {
      method: "POST",
      body: { content: file.data.toString("base64"), encoding: "base64" },
    });
    blobs.push({ path: file.path, mode: "100644", type: "blob", sha: blob.sha });
  }
  // Two reviews can publish at once; each rebuilds on the latest branch until its files are on it.
  for (let attempt = 1; ; attempt++) {
    const current = await readBranch(gh, repo);
    const removed = current ? expiredFolders(current.folders, new Date()).map((path) => ({ path, mode: "040000", type: "tree", sha: null })) : [];
    const tree = await gh.request<{ sha: string }>(`/repos/${repo}/git/trees`, {
      method: "POST",
      body: { ...(current ? { base_tree: current.tree } : {}), tree: [...blobs, ...removed] },
    });
    // No parent: the branch never builds up history, so removed files stop counting towards clones.
    // [skip ci] keeps the repository's push workflows from running on a branch of images.
    const commit = await gh.request<{ sha: string }>(`/repos/${repo}/git/commits`, {
      method: "POST",
      body: { message: "Review assets from tidy, kept for 30 days [skip ci]", tree: tree.sha, parents: [] },
    });
    try {
      if (current) await gh.request(`/repos/${repo}/git/refs/heads/${ASSETS_BRANCH}`, { method: "PATCH", body: { sha: commit.sha, force: true } });
      else await gh.request(`/repos/${repo}/git/refs`, { method: "POST", body: { ref: `refs/heads/${ASSETS_BRANCH}`, sha: commit.sha } });
    } catch (error) {
      // Another review created the branch first.
      if (!(error instanceof GitHubError && error.status === 422) || attempt === 3) throw error;
      continue;
    }
    const after = await gh.request<{ object: { sha: string } }>(`/repos/${repo}/git/ref/heads/${ASSETS_BRANCH}`);
    if (after.object.sha === commit.sha || attempt === 3) break;
  }
  return new Map(files.map((f) => [f.path, `https://raw.githubusercontent.com/${repo}/${ASSETS_BRANCH}/${f.path}`]));
}
