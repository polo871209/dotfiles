import { existsSync, rmSync } from "node:fs";
import { basename } from "node:path";
import type { UserMessage } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { run } from "./shared/exec";
import { forkName } from "./shared/fork-name";

const userText = (content: UserMessage["content"]): string =>
  typeof content === "string"
    ? content
    : content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("");

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    const draft = process.env.PI_FORK_DRAFT;
    if (draft === undefined) return;
    delete process.env.PI_FORK_DRAFT;
    ctx.ui.setEditorText(draft);
  });

  pi.on("session_before_fork", async (event, ctx) => {
    const { REX_SESSION } = process.env;
    const source = ctx.sessionManager.getSessionFile();
    const selected = ctx.sessionManager.getEntry(event.entryId);
    if (!REX_SESSION || !source || !existsSync(source) || !selected) return;

    const draft =
      event.position === "before" &&
      selected.type === "message" &&
      selected.message.role === "user"
        ? userText(selected.message.content)
        : undefined;
    const targetLeafId = draft === undefined ? selected.id : selected.parentId;
    if (!targetLeafId) return;

    const copy = SessionManager.open(
      source,
      ctx.sessionManager.getSessionDir(),
    );
    const file = copy.createBranchedSession(targetLeafId);
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
        "--json",
        "--",
        ...(draft === undefined ? [] : ["env", `PI_FORK_DRAFT=${draft}`]),
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

    // Rex.app ignores the server's active window, so only an app action switches its visible tab: https://discord.com/channels/1546797889009881158/1559289044439932949
    const { window_id } = JSON.parse(r.stdout) as { window_id: string };
    const select = await run(
      "rex",
      [
        "do",
        "-s",
        REX_SESSION,
        "session.select",
        `session_id=${REX_SESSION}`,
        `window_id=${window_id}`,
      ],
      undefined,
      ctx.cwd,
      15_000,
    );
    if (select.code !== 0)
      ctx.ui.notify(
        `Fork window opened, but Rex could not switch to it: ${(select.stderr || select.stdout).trim()}`,
        "warning",
      );
    return { cancel: true };
  });
}
