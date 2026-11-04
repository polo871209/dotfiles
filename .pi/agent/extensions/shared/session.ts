import type { CustomEntry, SessionEntry } from "@earendil-works/pi-coding-agent";

export const isCustom = <T>(
  entry: SessionEntry,
  customType: string,
): entry is CustomEntry<T> =>
  entry.type === "custom" && entry.customType === customType;

export const customEntries = <T>(
  entries: readonly SessionEntry[],
  customType: string,
): CustomEntry<T>[] =>
  entries.filter((entry): entry is CustomEntry<T> =>
    isCustom<T>(entry, customType),
  );
