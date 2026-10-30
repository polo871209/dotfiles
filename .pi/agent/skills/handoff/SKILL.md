---
name: handoff
description: Compact the current conversation into a handoff document on the macOS clipboard for another agent to pick up.
disable-model-invocation: true
---

Write a handoff document that summarises the current conversation so a fresh agent can continue the work. Copy it to the macOS clipboard with `pbcopy` through a quoted heredoc, so the shell expands nothing in the document:

```sh
pbcopy <<'HANDOFF'
<document>
HANDOFF
```

The clipboard is the only destination. Write no file.

Include a "suggested skills" section in the document, naming which skills the next agent should call the Skill tool for.

Reference other artifacts (specs, plans, ADRs, issues, commits, diffs) by path or URL instead of copying their content.

Redact sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the document to it.

The step is done when `pbpaste` prints the full document. Reply with one line saying the handoff is on the clipboard.
