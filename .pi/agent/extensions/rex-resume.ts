import { createHash } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// https://www.superlogical.com/rex/docs/build/program-resume
declare global {
  var rexResumeToken: string | undefined;
}

// Pi reloads extensions on every session switch, so the token must outlive this module.
globalThis.rexResumeToken ??= process.env.OSC7577_TOKEN;

// The tools that pi runs must not report as pi.
delete process.env.OSC7577_TOKEN;

function report(token: string, fields: string) {
  const body = `pid=${process.pid}:time=${Math.floor(Date.now() / 1000)}:${fields}`;
  const mac = createHash("sha256").update(`${body}:${token}`).digest("hex");

  process.stdout.write(`\x1b]7577;${body}:mac=${mac}\x1b\\`);
}

const base64 = (text: string) => Buffer.from(text).toString("base64");

export default function (pi: ExtensionAPI) {
  const token = globalThis.rexResumeToken;

  if (!token) return;
  let killedBySignal = false;

  const markKilled = () => {
    killedBySignal = true;
  };

  process.on("SIGTERM", markKilled);
  process.on("SIGHUP", markKilled);

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    const sessionFile = ctx.sessionManager.getSessionFile();

    if (!sessionFile) {
      report(token, "clear=1");

      return;
    }

    const argv = ["pi", "--session", sessionFile].map(base64).join(",");

    report(token, `argv=${argv}:cwd=${base64(ctx.cwd)}`);
  });

  pi.on("session_shutdown", (event, ctx) => {
    process.off("SIGTERM", markKilled);
    process.off("SIGHUP", markKilled);

    if (ctx.hasUI && event.reason === "quit" && !killedBySignal) report(token, "clear=1");
  });
}
