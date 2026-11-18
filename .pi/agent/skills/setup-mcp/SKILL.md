---
name: setup-mcp
description: Add an MCP server to the current repository only, shared by every worktree when the repo has one folder per branch.
disable-model-invocation: true
---

Add the server the user names to this repository. Keep it out of `~/.pi/agent/mcp.json`, because that file loads the server into every project's context. If the user gives no server name, URL, or command, ask for them.

1. Find the **repo root**. If a parent folder of the current folder holds `.bare`, the root is that parent and the repo has one folder per branch. Otherwise, the root is `git rev-parse --show-toplevel`. The shared configuration is `<root>/.pi/mcp.json`.
2. Write the server into the shared configuration with `jq`, keeping the servers already there. Use the format in `docs/mcp.md` of the installed `@earendil-works/pi-coding-agent` package. Write a secret as `${ENV_VAR}` or `!command`, never as a literal.
3. If `git check-ignore -q .pi/mcp.json` fails in a worktree, append `.pi/` to `$(git rev-parse --git-common-dir)/info/exclude`.
4. If the repo has one folder per branch, link the shared configuration into every worktree from `git worktree list --porcelain`, skipping the bare entry: `mkdir -p <worktree>/.pi && ln -s <root>/.pi/mcp.json <worktree>/.pi/mcp.json`. If a worktree already has its own `.pi/mcp.json`, merge its servers into the shared configuration first, then replace it with the link. The `worktree` extension and the `wt` shell function link worktrees created later.
5. Pi reads a project `mcp.json` only with project trust. If no entry in `~/.pi/agent/trust.json` for the root or a parent folder is `true`, give the user a runbook step that sets `"<root>": true` in that file with `jq`.
6. Run `pi mcp list` in a worktree other than the current one. If it reports that the server needs sign-in, give the user a runbook step with `pi mcp login <name>`. Pi stores the sign-in per server name and URL, so one sign-in covers every worktree.

Done when `pi mcp list` shows the server as connected in two different worktrees. Tell the user to run `/reload` in open sessions.
