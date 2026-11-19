# dotfiles

My macOS setup. The [Brewfile](Brewfile) and the [mise configuration](mise/config.toml) list every installed tool.

## Main tools

- Agent: [pi](https://pi.dev/), with [my extensions](.pi/agent/extensions/AGENTS.md)
- Terminal: [Rex](https://www.superlogical.com/rex/docs/installation)
- Editor: [Neovim](https://neovim.io/)
- Prompt: [zprompt](zprompt/)
- Completion: [Carapace](https://carapace.sh/)
- Versions and project environment: [mise](https://mise.jdx.dev/)
- History: [Atuin](https://docs.atuin.sh/cli/)
- Browser: [Zen](https://zen-browser.app/)
- Dictation: [Hex](https://anoma.ly/hex/)
- Launcher, clipboard history, and window management: [Nanocast](https://github.com/polo871209/nanocast)

## Set up a new Mac

1. Install the tools and link the configuration:

   ```bash
   git clone https://github.com/polo871209/dotfiles.git ~/dotfiles && cd ~/dotfiles
   cat dot_zshenv >| ~/.zshenv
   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
   eval "$(/opt/homebrew/bin/brew shellenv)"
   brew bundle install
   mise x just@latest -- just link
   mise install
   ```

2. Start a login shell, so that `PATH` includes the mise tools. Then build the prompt and finish the installs:

   ```bash
   exec zsh -l
   just zprompt
   uv tool install git+https://github.com/browser-use/jev-ultrafast.git
   touch ~/.hushlogin
   ./zen-browser/install.sh
   ```

3. Open Hex and finish its onboarding. Then run `just link` again to link the Hex settings.

4. Set up Atuin:

   ```bash
   atuin setup
   ```

5. Install [Rex](https://www.superlogical.com/rex/docs/installation). Then open a Rex terminal and install the `xterm-rex` terminal type, because `rex` is on `PATH` only in Rex terminals:

   ```bash
   rex terminfo setup
   ```

6. Set up GitHub over SSH. When `gh auth login` asks, upload the new key:

   ```bash
   ssh-keygen -t ed25519
   gh auth login --git-protocol ssh
   git remote set-url origin git@github.com:polo871209/dotfiles.git
   ```

7. Add the TypeSafe API key to the login keychain:

   ```bash
   security add-generic-password -a "$USER" -s typesafe-api-key -U -w
   ```

## Secrets stay in the keychain

No secret is in this repository or in the shell environment. Each tool reads its secret when it needs it:

- mise runs `gh auth token` for the GitHub API.
- pi runs the `security` command in [models.json](.pi/agent/models.json) for the TypeSafe key.

## Project environment variables

Put a project's environment variables in `.mise.toml`. [git/ignore](git/ignore) keeps that file out of every repository.

```toml
[env]
LOG_LEVEL = "debug"
```

Run `mise trust` once in the project. Only tools that mise starts through its shims see these variables, for example `node`, `pnpm`, and `go`. The shell does not see them. For Python, use `uv run`, because the `python` shim ignores the project's `.venv`.
