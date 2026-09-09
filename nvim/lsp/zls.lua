return {
    cmd = { 'zls' },
    -- .zon files also detect as `zig`, and nothing detects as `zir`, so `zig`
    -- alone covers everything zls answers for.
    filetypes = { 'zig' },
    -- zls.json holds per-project server settings and outranks the build files
    -- next to it.
    root_markers = { 'zls.json', { 'build.zig', 'build.zig.zon' }, '.git' },
    settings = {
        zls = {
            -- Full semantic diagnostics (cross-file type errors, undefined
            -- symbols) via build-on-save. Prefers a `check` step in build.zig;
            -- -fincremental keeps rebuilds near-instant.
            enable_build_on_save = true,
            build_on_save_step = 'check',
            build_on_save_args = { '-fincremental' },
            enable_autofix = true,

            -- Cheap extra diagnostics (no compile needed).
            warn_style = true, -- naming/style: snake_case vars, PascalCase types
            highlight_global_var_declarations = true,
            enable_import_access = true, -- flag unused @import / private access
        },
    },
}
