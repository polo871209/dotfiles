# Injected at kernel startup. Defines the in-cell `tool` proxy and helpers.
# All names defined here are available to user cells without import.

import base64 as _base64
import json as _json
import os as _os
import urllib.error as _urlerr
import urllib.request as _urlreq

# Set by the runner before each cell exec so events route to the right pending.
_current_id = ""


def _emit(event):
    # Emit a kernel event to the host over fd 3 (control channel).
    event.setdefault("id", _current_id)
    line = _json.dumps(event, default=str) + "\n"
    _os.write(3, line.encode("utf-8"))


def display(value):
    """Render a value in the current cell output."""
    try:
        # Matplotlib figures -> PNG.
        import matplotlib.figure as _mplfig  # pyrefly: ignore[missing-import]

        if isinstance(value, _mplfig.Figure):
            import io

            buf = io.BytesIO()
            value.savefig(buf, format="png", bbox_inches="tight")
            _emit(
                {
                    "op": "display",
                    "mime": "image/png",
                    "data": _base64.b64encode(buf.getvalue()).decode("ascii"),
                }
            )
            return
    except Exception:
        pass
    try:
        text = _json.dumps(value, default=str, indent=2)
        mime = "application/json"
    except Exception:
        text = repr(value)
        mime = "text/plain"
    _emit({"op": "display", "mime": mime, "data": text})


class _ToolCallable:
    __slots__ = ("_proxy", "_name")

    def __init__(self, proxy, name):
        self._proxy = proxy
        self._name = name

    def __repr__(self):
        return f"<tool.{self._name}>"

    def __call__(self, args=None, /, **kwargs):
        if args is None:
            merged = {}
        elif isinstance(args, dict):
            merged = dict(args)
        else:
            raise TypeError(
                f"tool.{self._name}(...) expects a dict (got {type(args).__name__})"
            )
        merged.update(kwargs)
        payload = _json.dumps(
            {
                "session": self._proxy._session,
                "name": self._name,
                "args": merged,
            }
        ).encode("utf-8")
        req = _urlreq.Request(
            f"{self._proxy._base}/v1/tool",
            data=payload,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._proxy._token}",
            },
        )
        try:
            with _urlreq.urlopen(req, timeout=120) as resp:
                body = resp.read()
        except _urlerr.HTTPError as exc:
            body = exc.read()
        try:
            data = _json.loads(body)
        except _json.JSONDecodeError:
            raise RuntimeError(f"tool.{self._name}: non-JSON response: {body[:200]!r}")
        if not isinstance(data, dict) or not data.get("ok"):
            msg = (data or {}).get("error") if isinstance(data, dict) else None
            raise RuntimeError(msg or f"tool.{self._name} failed")
        return data.get("value")


class _ToolProxy:
    __slots__ = ("_base", "_token", "_session")

    def __init__(self, base, token, session):
        self._base = base.rstrip("/")
        self._token = token
        self._session = session

    def __getattr__(self, name):
        if name.startswith("_"):
            raise AttributeError(name)
        return _ToolCallable(self, name)

    def __getitem__(self, name):
        return _ToolCallable(self, name)


# Shorthand wrappers around common bridge tools.
def read(path, offset=None, limit=None):
    args = {"path": path}
    if offset is not None:
        args["offset"] = offset
    if limit is not None:
        args["limit"] = limit
    return tool.read(args)


def write(path, content):
    return tool.write({"path": path, "content": content})


def tree(path=".", max_depth=3, show_hidden=False):
    return tool.tree({"path": path, "max_depth": max_depth, "show_hidden": show_hidden})


def env(key=None, value=None):
    """Get/set env vars in this kernel's process.

    No args -> full env dict. One arg -> value of `key` or None. Two args ->
    set `key=value` (coerced to str), return `value`. Scoped to this Python
    subprocess; does not affect the host pi process or JS kernel.
    """
    if key is None:
        return dict(_os.environ)
    if value is None:
        return _os.environ.get(key)
    _os.environ[key] = str(value)
    return value


def completion(prompt, model="default", system=None, schema=None):
    """Oneshot, stateless model call: no conversation history, no tools.

    model: "default" (session model / PI_SIDE_MODEL) or "provider/id".
    schema: JSON-Schema dict -> instructs structured output, parsed to a
    dict/list when the response parses as JSON, else returned as text.
    """
    args = {"prompt": prompt, "model": model}
    if system is not None:
        args["system"] = system
    if schema is not None:
        args["schema"] = schema
    return tool.completion(args)


def install(*pkgs, upgrade=False):
    """Install one or more Python packages into the eval venv via uv.

    Packages persist across cells and across pi sessions (shared venv at
    ~/.cache/pi-eval/venv). Subsequent `import` calls in the same kernel find
    the freshly installed module.
    """
    import importlib as _il
    import subprocess as _sp

    if not pkgs:
        return None
    venv_py = _os.environ.get("PI_EVAL_VENV_PYTHON")
    if not venv_py:
        raise RuntimeError(
            "install() requires PI_EVAL_VENV_PYTHON; kernel not running in a managed venv"
        )
    args = ["uv", "pip", "install", "--python", venv_py, "--quiet"]
    if upgrade:
        args.append("--upgrade")
    args.extend(pkgs)
    result = _sp.run(args, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(
            f"uv pip install failed (exit {result.returncode}):\n{result.stderr.strip() or result.stdout.strip()}"
        )
    _il.invalidate_caches()
    return list(pkgs)


tool = _ToolProxy(
    _os.environ["PI_EVAL_BRIDGE_URL"],
    _os.environ["PI_EVAL_BRIDGE_TOKEN"],
    _os.environ["PI_EVAL_BRIDGE_SESSION"],
)
