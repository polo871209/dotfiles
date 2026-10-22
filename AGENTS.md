# Dotfiles

Make changes only through paths inside this checkout. `~/.config`, `~/.pi`, and `~/.agents` can resolve here. Use repository paths so scope is explicit.

Never write a configuration value that equals the tool's default. If an existing value equals the default, delete it.

# Skills

- Own skills live in `.pi/agent/skills/`.
- Third-party skills live in `.agents/skills/`, tracked by `skills-lock.json`. Pi loads them through `skills` in `.pi/agent/settings.json`. Install from the repository root with `DISABLE_TELEMETRY=1 npx skills@latest add <owner/repo> --skill <name> -a pi -y`, and update with `just update-skill`. Never pass `-g`, because it installs to `~/.agents/` outside this checkout.
- Never edit a file under `.agents/skills/`, because the next update overwrites it.
- To change the content of a third-party skill, move it to `.pi/agent/skills/` and remove it from the lock with `npx skills remove <name>`.
