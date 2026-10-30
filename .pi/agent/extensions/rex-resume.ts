import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function resumeFileForBlock(blockId: string): string {
  const stateHome =
    process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(
    stateHome,
    "pi",
    "rex-resume",
    blockId.replace(/^block:/, ""),
  );
}

export default function (pi: ExtensionAPI) {
  const blockId = process.env.REX_BLOCK;
  if (!blockId || process.env.PI_IS_SUBAGENT === "1") return;
  const resumeFile = resumeFileForBlock(blockId);

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (!sessionFile) {
      fs.rmSync(resumeFile, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(resumeFile), { recursive: true });
    fs.writeFileSync(resumeFile, sessionFile);
  });
}
