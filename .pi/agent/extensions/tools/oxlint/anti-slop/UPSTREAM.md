# anti-slop provenance

- Source: https://github.com/dmmulroy/anti-slop
- Commit: `63dbb09f73438e550a6991dc6d778f979ffbf183` (2026-11-20)
- Copied from: `skills/install-anti-slop/assets/anti-slop/` with the skill's `scripts/install.mjs`, unmodified
- Installed at: `.pi/agent/extensions/tools/oxlint/anti-slop/`
- Registered in: `.pi/agent/extensions/.oxlintrc.json` (generic plugin, every generic rule at `error`)

## Deviations from upstream

- `oxlint` and `@oxlint/plugins` are pinned at `1.95.0` in `.pi/agent/npm/package.json`; upstream tests against `1.78.0`.
- The Effect plugin is copied but not registered, because the extensions do not depend on Effect.
- `ignorePatterns` lists `node_modules/**` and this folder only. The agent-directory ignores from the upstream instructions target a project root and match nothing in the extensions folder.
- The root `.oxfmtrc.json` ignores this folder, so the copy stays byte-identical to upstream.
