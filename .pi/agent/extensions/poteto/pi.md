## pstack in pi

pstack is written for Cursor and lives in `~/.cache/cursor-plugins/pstack`. Translate its terms with this list. Drop a Cursor field the list does not cover.

- `Task` → `subagent`. Use `subagent_manage` to wait, read results, steer, or stop.
- `subagent_type: "poteto-agent"` or `generalPurpose` → `agent: "poteto-agent"`.
- `readonly: true` → `agent: "scout"` for this repository, `agent: "researcher"` for external tech.
- `run_in_background: true` → `background: true`.
- `model` and role slugs → no field. Every run of a route uses that route's model, so a panel shares one model. Say so once per task.
- `resume` → a fresh run with the earlier report pasted into its `task`.
- `environment: "cloud"`, or a step that works from a git worktree → the `worktree` tool, only if the user asked for a worktree. Otherwise mark the step `skip: worktree not requested`, work in the current checkout, and give each parallel worker its own files.
- `AskQuestion` → `ask_user_question`.
- A todolist → a list in your reply, updated at each phase.
- Another pstack skill → read `skills/<name>/SKILL.md` and follow it. The user types `/skill:<name>`.
- `create-skill` → the `writing-for-agents` skill at `~/dotfiles/.agents/skills/writing-for-agents/SKILL.md`.
- A built-in PR tool → `github_pr` to read a PR or resolve its threads, `gh` for every write.
- `.cursor/skills/` → `.agents/skills/`. `.cursor/rules/` → `AGENTS.md`.
- `https://github.com/cursor/plugins/blob/main/pstack/<path>` → the local copy at `<path>`.
- Agent transcripts → `~/.pi/agent/sessions/<slug>/`, where `/Users/you/proj` becomes `--Users-you-proj--`. The newest `.jsonl` is the current session.
- `/setup-pstack`, Cursor Automations, Bugbot, and Cursor cloud agents → none in pi. Write `Skipped in pi: <step>. <reason>.` and go on. Bugbot comments on a PR are review threads for `github_pr`.
