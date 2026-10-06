"""Run one jev-ultrafast goal. Protocol: JSON lines on stdout, text-helper replies on stdin."""

import json
import os
import re
import signal
import subprocess
import sys
import threading
import time


def _reserve_stdout_for_protocol():
    proto = os.fdopen(os.dup(1), "w", buffering=1)
    os.dup2(2, 1)
    return proto


proto = _reserve_stdout_for_protocol()


def emit(**message):
    proto.write(json.dumps(message) + "\n")


signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))


def _watch_parent(ppid):
    while os.getppid() == ppid:
        time.sleep(5)
    os.kill(os.getpid(), signal.SIGTERM)


threading.Thread(target=_watch_parent, args=(os.getppid(),), daemon=True).start()

# jev_ultrafast exists only in the uv tool env whose python index.ts starts.
import browser_harness.macos as bh_macos  # pyrefly: ignore[missing-import]
import jev_ultrafast.agent as jev_agent  # pyrefly: ignore[missing-import]
from browser_harness.helpers import cdp  # pyrefly: ignore[missing-import]
from jev_ultrafast import Agent  # pyrefly: ignore[missing-import]
from jev_ultrafast.questions import TEXT_VALUE  # pyrefly: ignore[missing-import]


def field_text(context):
    emit(type="text_request", system=TEXT_VALUE, context=context)
    reply = json.loads(sys.stdin.readline() or "{}")
    if reply.get("error"):
        raise RuntimeError(f"Text helper failed: {reply['error']}; nothing typed.")
    raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", reply.get("text", "").strip())
    try:
        output = json.loads(raw)
        value = output["text"]
        if (
            set(output) != {"text"}
            or not isinstance(value, str)
            or not value.strip()
            or len(value) > 2000
        ):
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        raise ValueError(
            "Text helper returned no valid field value; nothing typed."
        ) from None
    return value, {
        "model": reply.get("model"),
        "latency_ms": reply.get("latency_ms", 0),
        "usage": {},
    }


if not hasattr(jev_agent, "field_text"):
    sys.exit("jev-ultrafast no longer has agent.field_text; update runner.py.")
jev_agent.field_text = field_text


def summary(state, status, error=None):
    page = state["page"] if state else {}
    emit(
        type="result",
        status=status,
        error=error,
        elapsed_ms=state["elapsed_ms"] if state else 0,
        url=page.get("url"),
        title=page.get("title"),
        text=page.get("text", ""),
        history=[
            {k: h.get(k) for k in ("kind", "action", "text", "url")}
            for h in state["history"]
        ]
        if state
        else [],
    )


def chrome_running():
    return (
        subprocess.run(
            ["pgrep", "-x", "Google Chrome"], capture_output=True, check=False
        ).returncode
        == 0
    )


def ensure_chrome():
    if chrome_running():
        return
    emit(type="note", text="starting Chrome in the background…")
    subprocess.run(["open", "-g", "-a", "Google Chrome"], check=True)
    deadline = time.monotonic() + 10
    while not chrome_running():
        if time.monotonic() > deadline:
            raise RuntimeError("Google Chrome did not start within 10 s.")
        time.sleep(0.2)


def auto_approve(done):
    deadline = time.monotonic() + 60
    while not done.is_set() and time.monotonic() < deadline:
        status, detail = bh_macos.approve_remote_debugging()
        if status == "ready":
            return
        if status in {"accessibility-required", "setup-required"}:
            emit(type="note", text=f"click Allow in Chrome, or {detail}")
            return
        time.sleep(0.5)


args = json.loads(sys.argv[1])
state = None
connected = threading.Event()
try:
    ensure_chrome()
    threading.Thread(target=auto_approve, args=(connected,), daemon=True).start()
    agent = Agent(args["url"], args["goal"])
    connected.set()
    with agent:
        if args.get("watch"):
            cdp("Target.activateTarget", targetId=agent.browser.target)
            agent.close = lambda: None
        state = agent.snapshot()
        for state in agent.run():
            last = state["history"][-1] if state["history"] else None
            emit(
                type="step",
                status=state["status"],
                elapsed_ms=state["elapsed_ms"],
                last=last and last["action"],
            )
        summary(state, state["status"])
except Exception as error:  # noqa: BLE001
    summary(state, "error", f"{type(error).__name__}: {error}")
