/** Single-process SWR cache for the MVP. Replace with shared persistence before scale-out. */
export function createCache<T>(ttlMs: number, maxStaleMs = 24 * 60 * 60 * 1000) {
  let prior: { data: T; time: number } | undefined;
  let inflight: Promise<T> | undefined;
  return async function load(loader: () => Promise<T>, now = Date.now()): Promise<{ data: T; stale: boolean; cachedAt: string }> {
    if (prior && now - prior.time < ttlMs) return { data: prior.data, stale: false, cachedAt: new Date(prior.time).toISOString() };
    if (!inflight) inflight = loader().finally(() => { inflight = undefined; });
    try {
      const data = await inflight;
      prior = { data, time: now };
      return { data, stale: false, cachedAt: new Date(now).toISOString() };
    } catch (error) {
      if (prior && now - prior.time <= maxStaleMs) return { data: prior.data, stale: true, cachedAt: new Date(prior.time).toISOString() };
      throw error;
    }
  };
}
