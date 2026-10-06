"""Long-lived Python runner.

Reads {"id","op","code"|...} JSON lines from stdin.
Emits {"id","op","stream"|"display"|"done", ...} to fd 3.
Stdout/stderr of user code are captured and forwarded as stream events.
"""

from __future__ import annotations

import ast
import io
import json
import os
import sys
import threading
import time
import traceback
from contextlib import redirect_stderr, redirect_stdout

PRELUDE_PATH = os.path.join(os.path.dirname(__file__), "prelude.py")


def _start_parent_watchdog() -> None:
    """Self-terminate if reparented: when the host (pi) is SIGKILL'd the kernel
    is otherwise orphaned and lingers, leaking RAM across pi restarts."""
    os_name = os.name
    if os_name != "posix":
        return
    ppid = os.getppid()
    if ppid <= 1:
        return

    def _watch() -> None:
        while True:
            if os.getppid() != ppid:
                os._exit(0)
            time.sleep(5)

    threading.Thread(target=_watch, daemon=True).start()


class _StreamForwarder(io.TextIOBase):
    """File-like that emits a kernel event per write, instead of buffering."""

    def __init__(self, stream_name: str, globals_dict: dict):
        self._name = stream_name
        self._globals = globals_dict

    def writable(self) -> bool:
        return True

    def write(self, s: str) -> int:
        if not s:
            return 0
        event = {
            "id": self._globals.get("_current_id", ""),
            "op": "stream",
            "stream": self._name,
            "text": s,
        }
        os.write(3, (json.dumps(event, allow_nan=False) + "\n").encode("utf-8"))
        return len(s)


def _build_globals() -> dict:
    g: dict = {"__name__": "__main__", "__builtins__": __builtins__}
    with open(PRELUDE_PATH, "r", encoding="utf-8") as f:
        prelude_src = f.read()
    exec(compile(prelude_src, PRELUDE_PATH, "exec"), g)  # noqa: S102 -- trusted local prelude, not user input
    return g


def _exec_cell(code: str, g: dict) -> object:
    """Execute code, returning the value of the final expression if any."""
    tree = ast.parse(code, mode="exec")
    if not tree.body:
        return None
    last = tree.body[-1]
    if isinstance(last, ast.Expr):
        body_module = ast.Module(body=tree.body[:-1], type_ignores=[])
        expr_module = ast.Expression(body=last.value)
        ast.fix_missing_locations(body_module)
        ast.fix_missing_locations(expr_module)
        if body_module.body:
            exec(compile(body_module, "<cell>", "exec"), g)  # noqa: S102 -- executing user cell code is this module's purpose
        return eval(compile(expr_module, "<cell>", "eval"), g)
    exec(compile(tree, "<cell>", "exec"), g)  # noqa: S102
    return None


def _serializable_or_degraded(value, error):
    try:
        json.dumps(value, default=str, allow_nan=False)
        return value, error
    except KeyboardInterrupt:
        return None, error or "KeyboardInterrupt during result serialization"
    except Exception:  # noqa: BLE001 -- fall back to repr for any non-JSON-serializable value
        return repr(value), error


def _emit_done_despite_sigint(emit, rid, value, error):
    try:
        emit({"id": rid, "op": "done", "value": value, "error": error})
    except KeyboardInterrupt:
        os.write(3, b"\n")
        emit(
            {
                "id": rid,
                "op": "done",
                "value": None,
                "error": error or "KeyboardInterrupt while emitting result",
            }
        )


def main() -> None:
    _start_parent_watchdog()
    globals_dict = _build_globals()
    stdout_fwd = _StreamForwarder("stdout", globals_dict)
    stderr_fwd = _StreamForwarder("stderr", globals_dict)

    def emit(event: dict) -> None:
        os.write(
            3, (json.dumps(event, default=str, allow_nan=False) + "\n").encode("utf-8")
        )

    def handle(req: dict) -> None:
        nonlocal globals_dict
        rid = req.get("id", "")
        op = req.get("op")
        globals_dict["_current_id"] = rid

        if op != "run":
            emit({"id": rid, "op": "done", "value": None, "error": f"unknown op: {op}"})
            return

        code = req.get("code", "")
        value: object = None
        error: str | None = None
        try:
            with redirect_stdout(stdout_fwd), redirect_stderr(stderr_fwd):
                value = _exec_cell(code, globals_dict)
        except BaseException:  # noqa: BLE001 -- must surface any cell failure (incl. SystemExit) as a result, never crash the kernel
            error = traceback.format_exc()

        value, error = _serializable_or_degraded(value, error)
        _emit_done_despite_sigint(emit, rid, value, error)

    while True:
        try:
            line = sys.stdin.readline()
        except KeyboardInterrupt:
            continue
        if not line:
            break
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        try:
            handle(req)
        except KeyboardInterrupt:
            continue


if __name__ == "__main__":
    main()
