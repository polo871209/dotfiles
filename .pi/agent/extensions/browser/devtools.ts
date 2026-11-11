import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type ConsoleEntry = {
  level: string;
  source: string;
  text: string;
  location?: string;
};

export type RequestEntry = {
  method: string;
  url: string;
  type?: string;
  status?: number;
  failure?: string;
  bytes?: number;
  ms?: number;
};

export type DevtoolsReport = {
  console: ConsoleEntry[];
  console_by_level: Record<string, number>;
  problem_requests: RequestEntry[];
  requests: number;
  requests_by_type: Record<string, number>;
  log_path: string;
};

interface RemoteObject {
  value?: unknown;
  description?: string;
  unserializableValue?: string;
  type?: string;
}

interface CallFrame {
  url: string;
  lineNumber: number;
  columnNumber: number;
}

const MAX_LISTED = 30;
const MAX_TEXT = 500;

const clip = (text: string, max = MAX_TEXT) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

const describe = (arg: RemoteObject) =>
  arg.value !== undefined
    ? typeof arg.value === "string"
      ? arg.value
      : JSON.stringify(arg.value)
    : (arg.unserializableValue ?? arg.description ?? arg.type ?? "");

const at = (url?: string, line?: number) =>
  url ? `${url}${line === undefined ? "" : `:${line + 1}`}` : undefined;

/** Collects console messages and network requests from CDP events of several tabs. */
export class DevtoolsRecorder {
  readonly console: ConsoleEntry[] = [];
  private readonly requests: RequestEntry[] = [];
  private readonly open = new Map<
    string,
    { entry: RequestEntry; start: number }
  >();
  private lastActivity = Date.now();

  handle(method: string, params: Record<string, any>, sessionId: string) {
    this.lastActivity = Date.now();
    const key = `${sessionId}:${params.requestId}`;
    switch (method) {
      case "Runtime.consoleAPICalled": {
        const frame: CallFrame | undefined = params.stackTrace?.callFrames?.[0];
        this.console.push({
          level: params.type === "warning" ? "warning" : params.type,
          source: "console",
          text: clip((params.args as RemoteObject[]).map(describe).join(" ")),
          location: at(frame?.url, frame?.lineNumber),
        });
        break;
      }
      case "Runtime.exceptionThrown": {
        const details = params.exceptionDetails;
        this.console.push({
          level: "error",
          source: "exception",
          text: clip(details.exception?.description ?? details.text),
          location: at(details.url, details.lineNumber),
        });
        break;
      }
      case "Log.entryAdded": {
        const entry = params.entry;
        this.console.push({
          level: entry.level,
          source: entry.source,
          text: clip(entry.text),
          location: at(entry.url, entry.lineNumber),
        });
        break;
      }
      case "Network.requestWillBeSent": {
        const previous = this.open.get(key);
        if (previous && params.redirectResponse) {
          previous.entry.status = params.redirectResponse.status;
          previous.entry.ms = Math.round(
            (params.timestamp - previous.start) * 1000,
          );
        }
        const entry: RequestEntry = {
          method: params.request.method,
          url: params.request.url,
          type: params.type,
        };
        this.requests.push(entry);
        this.open.set(key, { entry, start: params.timestamp });
        break;
      }
      case "Network.responseReceived": {
        const request = this.open.get(key);
        if (!request) break;
        request.entry.status = params.response.status;
        request.entry.type ??= params.type;
        break;
      }
      case "Network.loadingFinished": {
        const request = this.open.get(key);
        if (!request) break;
        request.entry.bytes = params.encodedDataLength;
        request.entry.ms = Math.round(
          (params.timestamp - request.start) * 1000,
        );
        this.open.delete(key);
        break;
      }
      case "Network.loadingFailed": {
        const request = this.open.get(key);
        if (!request) break;
        request.entry.failure = params.blockedReason
          ? `blocked: ${params.blockedReason}`
          : params.canceled
            ? "canceled"
            : params.errorText;
        request.entry.ms = Math.round(
          (params.timestamp - request.start) * 1000,
        );
        this.open.delete(key);
        break;
      }
    }
  }

  /** Resolves once no event arrived for `quietMs`, or after `capMs`. */
  async quiet(quietMs = 500, capMs = 5_000) {
    const deadline = Date.now() + capMs;
    while (Date.now() < deadline && Date.now() - this.lastActivity < quietMs)
      await new Promise((resolve) => setTimeout(resolve, 100));
  }

  async report(): Promise<DevtoolsReport> {
    const dir = join(tmpdir(), "pi-browser");
    await mkdir(dir, { recursive: true });
    const log_path = join(dir, `devtools-${Date.now()}.json`);
    await writeFile(
      log_path,
      JSON.stringify(
        { console: this.console, requests: this.requests },
        null,
        2,
      ),
    );
    const count = (keys: string[]) => {
      const counts: Record<string, number> = {};
      for (const key of keys) counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    };
    return {
      console: this.console
        .filter((entry) => entry.level === "error" || entry.level === "warning")
        .slice(0, MAX_LISTED),
      console_by_level: count(this.console.map((entry) => entry.level)),
      problem_requests: this.requests
        .filter(
          (request) =>
            request.failure !== undefined || (request.status ?? 0) >= 400,
        )
        .slice(0, MAX_LISTED)
        .map((request) => ({ ...request, url: clip(request.url, 300) })),
      requests: this.requests.length,
      requests_by_type: count(this.requests.map((r) => r.type ?? "Other")),
      log_path,
    };
  }
}
