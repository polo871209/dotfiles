return {
    cmd = { 'pyrefly', 'lsp' },
    filetypes = { 'python' },
    -- requirements.txt and Pipfile projects have no pyproject.toml, so without
    -- them the walk continues to .git and the server roots too high, which
    -- moves which config and venv it resolves.
    root_markers = {
        'pyrefly.toml',
        'pyproject.toml',
        'setup.py',
        'setup.cfg',
        'requirements.txt',
        'Pipfile',
        '.git',
    },
    -- pyrefly reads its VSCode settings from initializationOptions with the
    -- `python.` prefix stripped. The interpreter stays unset on purpose:
    -- pyrefly resolves the active venv, then walks up to a pyvenv.cfg, which
    -- is what a roaming daemon needs.
    init_options = {
        pyrefly = {
            -- Project-wide diagnostics cost one full check per project that
            -- carries a pyrefly config, and the agent daemon holds that cost
            -- for hours while only ever asking about files it opened.
            diagnosticMode = vim.g.pi_agent and 'openFilesOnly' or 'workspace',
        },
    },
}
