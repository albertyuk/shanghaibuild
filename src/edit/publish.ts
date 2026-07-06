/*
 * Publish from the browser: commits edited content straight to GitHub
 * via the Contents API (api.github.com allows CORS), one commit per
 * file. The host's git integration then redeploys the site — no local
 * git, no manual upload step. The token is held in component state for
 * the life of the tab and never persisted.
 */

export interface PublishTarget {
  owner: string;
  repo: string;
  branch: string;
  token: string;
}

const headers = (token: string) => ({
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2022-11-28",
});

/** owner/repo, encoded — user-typed fields never reshape the URL path. */
const repoSlug = (target: PublishTarget) =>
  `${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;

const apiPath = (target: PublishTarget, path: string) =>
  `https://api.github.com/repos/${repoSlug(target)}/contents/` +
  path.split("/").map(encodeURIComponent).join("/");

export function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export const textToBase64 = (text: string) =>
  bytesToBase64(new TextEncoder().encode(text).buffer as ArrayBuffer);

/**
 * Preflight: prove the token can actually write to the repo before any
 * uploads run, and convert the API's opaque failures into instructions.
 * GitHub quirk worth knowing: a fine-grained token with no access to a
 * repo gets 404 (not 403) on reads, and "Resource not accessible" 403s
 * only at write time — so without this check, bad tokens fail late and
 * cryptically.
 */
export async function assertWriteAccess(target: PublishTarget): Promise<void> {
  const res = await fetch(`https://api.github.com/repos/${repoSlug(target)}`, {
    headers: headers(target.token),
  });
  if (res.status === 401) {
    throw new Error("GitHub rejected the token (401). Paste the token again — it may be expired or mistyped.");
  }
  if (res.status === 404) {
    throw new Error(
      `The token can't see ${target.owner}/${target.repo}. When creating the fine-grained token, set Repository access to "Only select repositories" and pick this repo — the default "Public repositories (read-only)" option cannot write.`,
    );
  }
  if (!res.ok) {
    throw new Error(`GitHub ${res.status} while checking repo access.`);
  }
  const data = (await res.json()) as {
    permissions?: { push?: boolean };
    default_branch?: string;
  };
  if (!data.permissions?.push) {
    throw new Error(
      "The token can see the repo but has no write access. Edit the token's Repository permissions and set Contents to \"Read and write\" (or use a classic token with the repo scope).",
    );
  }
  const branchRes = await fetch(
    `https://api.github.com/repos/${repoSlug(target)}/branches/${encodeURIComponent(target.branch)}`,
    { headers: headers(target.token) },
  );
  if (branchRes.status === 404) {
    throw new Error(
      `Branch "${target.branch}" doesn't exist in ${target.owner}/${target.repo}. Its default branch is "${data.default_branch}" — put that (or whichever branch your host deploys) in the Branch field.`,
    );
  }
  if (!branchRes.ok) {
    throw new Error(`GitHub ${branchRes.status} while checking branch "${target.branch}".`);
  }
}

/** The blob sha of the file as it exists on the branch (null = absent).
 *  The Contents API requires it when replacing an existing file. */
async function existingSha(target: PublishTarget, path: string): Promise<string | null> {
  const res = await fetch(
    `${apiPath(target, path)}?ref=${encodeURIComponent(target.branch)}`,
    { headers: headers(target.token) },
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`GitHub ${res.status} reading ${path} — check token and repo access.`);
  }
  const data = (await res.json()) as { sha?: string };
  return data.sha ?? null;
}

/** Create or update one file on the branch. Returns the commit sha. */
export async function publishFile(
  target: PublishTarget,
  path: string,
  base64Content: string,
  message: string,
): Promise<string> {
  const sha = await existingSha(target, path);
  const res = await fetch(apiPath(target, path), {
    method: "PUT",
    headers: { ...headers(target.token), "Content-Type": "application/json" },
    body: JSON.stringify({
      message,
      content: base64Content,
      branch: target.branch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (res.status === 403) {
    throw new Error(
      `GitHub refused to write ${path} (403). The token lacks Contents "Read and write" on this repo — edit the token's Repository permissions, or check that branch protection on "${target.branch}" allows direct pushes.`,
    );
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`GitHub ${res.status} writing ${path}: ${detail}`);
  }
  const data = (await res.json()) as { commit?: { sha?: string } };
  return data.commit?.sha ?? "";
}
