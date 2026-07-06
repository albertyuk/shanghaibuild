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

const apiPath = (target: PublishTarget, path: string) =>
  `https://api.github.com/repos/${target.owner}/${target.repo}/contents/` +
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
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200);
    throw new Error(`GitHub ${res.status} writing ${path}: ${detail}`);
  }
  const data = (await res.json()) as { commit?: { sha?: string } };
  return data.commit?.sha ?? "";
}
