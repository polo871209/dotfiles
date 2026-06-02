return {
    cmd = { 'zls' },
    filetypes = { 'zig', 'zir' },
    root_markers = { 'build.zig', 'build.zig.zon', '.git' },
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
