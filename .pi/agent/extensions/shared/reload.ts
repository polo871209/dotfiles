export function surviveReload<T>(key: string, init: () => T): T {
  const g = globalThis as Record<string, unknown>;
  if (!(key in g)) g[key] = init();
  return g[key] as T;
}
