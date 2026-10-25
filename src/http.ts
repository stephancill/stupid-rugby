export type ApiError = Error & { status: number };

export function isRateLimited({ error }: { error: unknown }) {
  return (error as Partial<ApiError> | null)?.status === 429;
}

// Upstream APIs (and the caching proxy in front of them) answer 429 when rate limited.
export async function getJson({ url, source }: { url: string; source: string }): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) {
    const message = `${source} API ${res.status} for ${url}: ${await res.text()}`;
    throw Object.assign(new Error(message), { status: res.status }) satisfies ApiError;
  }
  return res.json();
}
