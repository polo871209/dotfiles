// Shared types for the eval extension.

export interface DisplayItem {
  mime: string;
  data: string;
}

export interface CellResult {
  title?: string;
  stdout: string;
  stderr: string;
  value: unknown;
  error: string | null;
  displays: DisplayItem[];
  durationMs: number;
  timedOut?: boolean;
  aborted?: boolean;
}

export type KernelRequest = { id: string; op: "run"; code: string };

export interface KernelEventDisplay {
  id: string;
  op: "display";
  mime: string;
  data: string;
}
export interface KernelEventStream {
  id: string;
  op: "stream";
  stream: "stdout" | "stderr";
  text: string;
}
export interface KernelEventDone {
  id: string;
  op: "done";
  value: unknown;
  error: string | null;
}
export type KernelEvent =
  | KernelEventDisplay
  | KernelEventStream
  | KernelEventDone;

export interface BridgeRequest {
  session: string;
  name: string;
  args: Record<string, unknown>;
}
export interface BridgeResponse {
  ok: boolean;
  value?: unknown;
  error?: string;
}
