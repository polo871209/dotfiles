export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
