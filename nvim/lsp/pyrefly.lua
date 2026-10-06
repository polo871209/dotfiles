return {
    cmd = { 'pyrefly', 'lsp' },
    filetypes = { 'python' },
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
            diagnosticMode = vim.g.pi_agent and 'openFilesOnly' or 'workspace',
        },
    },
}
