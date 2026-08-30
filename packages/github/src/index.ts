import { createHash } from 'node:crypto';

export interface FetchDeps {
  /** Injectable for tests; defaults to global fetch. */
  fetchFn?: typeof globalThis.fetch;
}

/** URL contract: codeload serves immutable tarballs addressed by full SHA. */
export function tarballUrl(repo: string, sha: string): string {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('sha must be 40-hex');
  return `https://codeload.github.com/${repo}/tar.gz/${sha}`;
}

export interface DownloadedBlob {
  bytes: Buffer;
  sha256: string;
}

export async function downloadTarball(
  repo: string,
  sha: string,
  deps: FetchDeps = {},
): Promise<DownloadedBlob> {
  const doFetch = deps.fetchFn ?? globalThis.fetch;
  const res = await doFetch(tarballUrl(repo, sha), { redirect: 'follow' });
  if (!res.ok) throw new Error(`codeload HTTP ${res.status} for ${repo}@${sha}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length === 0) throw new Error('empty tarball');
  return { bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
}
