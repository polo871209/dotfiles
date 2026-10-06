return {
    cmd = { 'zls' },
    filetypes = { 'zig' },
    root_markers = { 'zls.json', { 'build.zig', 'build.zig.zon' }, '.git' },
    settings = {
        zls = {
            enable_build_on_save = true,
            build_on_save_step = 'check',
            build_on_save_args = { '-fincremental' },
            enable_autofix = true,

            warn_style = true,
            highlight_global_var_declarations = true,
            enable_import_access = true,
        },
    },
}
