type ForkKind = "fork" | "clone";

const FORK_PREFIX = /^(fork|clone): /;

export const forkName = (kind: ForkKind, name: string): string =>
  `${kind}: ${name.replace(FORK_PREFIX, "")}`;

export const isForkName = (name: string | undefined): boolean =>
  !!name && FORK_PREFIX.test(name);
