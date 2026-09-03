---
name: embedding-http-requests
description: HTTP requests written inside source-code comments and sent from there. Use when adding, fixing, or verifying one, or when editing the shared kulala.http globals.
disable-model-invocation: true
---

A request lives in a comment beside the code it exercises rather than in a separate `.http` file, and is sent from there with `<leader>Rs`. The syntax is the JetBrains `.http` dialect.

Most of what goes wrong here **fails silently**: a malformed comment still sends, and the server still answers 200. Send every request before calling it done. Inspection proves nothing.

## 1. Write the request in a comment

Any comment style works: a run of line comments, a block comment, a Python docstring, a Lua `[[ ]]`. Markers, indentation, and delimiter-only lines (`"""`, `/*`, `*/`) are stripped, so write the request as it looks in an `.http` file:

```python
def create_user():
    # POST https://httpbin.org/post
    # Content-Type: application/json
    #
    # {"name": "ada"}
```

- **The commented blank line is load-bearing.** A run of line comments ends at the first uncommented line, so the separator between headers and body must itself be `#` or `//` alone. A real blank line truncates the request and drops the body silently, answered 200 by a server that never saw it.
- Prose above the request is dropped, up to the first line that reads as a request start: `###`, `# @directive`, `@var =`, `run`, `import`, or an all-caps method line.
- **Keep all-caps-word-plus-space prose out of the comment.** `TODO fix this` and `GET requests are cached` both parse as method lines.
- Several requests in one comment: separate them with `### name` headers, each one named, because an unnamed `###` breaks the send. The cursor picks which request runs.

Completion: stripping the comment markers by eye leaves valid `.http`, and every blank line inside the request is commented.

## 2. Draw globals from `kulala.http`

Reach for this when the request needs a host, credentials, or a login another request already performs. The file is the nearest `kulala.http` searching upward from the source file, so it holds hosts and logins belonging to one repo and is committed alongside it. Only that nearest file is read. A comment with no `kulala.http` above it gets no globals at all.

- Above the first `###`: document variables such as `@host = https://api.example.com`, referenced from any embedded request as `{{host}}`.
- Under a `### name` header: a reusable request. Call it with `run #name` on its own line in any comment. The named block runs first, ahead of the request below it.

## 3. Pass a value between requests

One mechanism works. The producing block ends with a post-request script, and the consumer reads the global as `{{token}}`:

```
> {%
client.global.set("token", response.body.json.token);
%}
```

Paths are plain dots: `response.body.json.token`, never JSONPath `$.json.token`.

Three alternatives read as correct and fail silently, each leaving an unresolved `{{...}}` and usually a 401: `@name-json-key` captures, request variables (`{{login.response.body.$.token}}`), and variables declared under a `### Shared` header. Use none of them.

## 4. Send it and read the result

Interactively, put the cursor in the comment and press `<leader>Rs`, which sends the one request under it. Headlessly, run [`verify.sh`](verify.sh) with the file and the line the request sits on, plus a longer wait in seconds for a slow endpoint:

```bash
verify.sh FILE LINE [WAIT]
```

```
RESULT n=1 POST:200 | inlay L8 "✔ 1208.79 ms"
```

`n` counts responses, so a request expanded by `run #name` reports `n=2`.

Test a block in `kulala.http` on its own the same way, pointing the script at that file and the block's line, because it's useful for proving a login works before any comment depends on it.

```bash
verify.sh kulala.http 4
```

Completion: every request touched reports its expected status code with a `✔` inlay, and where the endpoint echoes the request body, that echo confirms the body arrived. A `✘`, a `:1` code, or `n=0` means it never ran. Recheck the separator rule in step 1 before editing the request itself.
