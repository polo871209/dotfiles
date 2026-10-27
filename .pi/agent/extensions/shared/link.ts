/** A link whose URL starts with this prefix is handled inside pi instead of being opened by the OS. */
export const PI_LINK_PREFIX = "pi-";

/** Emitted on `pi.events` with the clicked URL (a string) for every click on a `pi-` link. */
export const LINK_OPEN = "link:open";

/** Emitted on `pi.events` once clicks on `pi-` links reach `LINK_OPEN` listeners in this session. */
export const LINK_READY = "link:ready";
