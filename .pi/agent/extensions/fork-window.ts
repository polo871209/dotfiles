import { existsSync, rmSync } from "node:fs";
import { basename } from "node:path";
import {
  SessionManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { run } from "./shared/exec";
import { forkName } from "./shared/fork-name";

export default function (pi: ExtensionAPI) {
  pi.on("session_before_fork", async (event, ctx) => {
    const { REX_SESSION } = process.env;
    const source = ctx.sessionManager.getSessionFile();
    const leafId = ctx.sessionManager.getLeafId();
    if (!REX_SESSION || !source || !existsSync(source) || !leafId) return;

    const copy = SessionManager.open(
      source,
      ctx.sessionManager.getSessionDir(),
    );
    const file = copy.createBranchedSession(leafId);
    if (!file || !existsSync(file)) return;
    const name = forkName(
      event.position === "at" ? "clone" : "fork",
      pi.getSessionName() ?? basename(ctx.cwd),
    );
    copy.appendSessionInfo(name);

    const r = await run(
      "rex",
      [
        "window",
        "new",
        "-s",
        REX_SESSION,
        "-c",
        ctx.cwd,
        "--",
        "pi",
        "--session",
        file,
      ],
      undefined,
      ctx.cwd,
      15_000,
    );
    if (r.code !== 0) {
      rmSync(file);
      ctx.ui.notify(
        `Fork window: ${(r.stderr || r.stdout).trim() || `rex window new exited with ${r.code}`}. Forking in this pane instead.`,
        "error",
      );
      return;
    }
    return { cancel: true };
  });
}
