return {
    cmd = { 'asm-lsp' },
    filetypes = { 'asm', 'nasm', 'vmasm' },
    -- .asm-lsp.toml configures target arch/assembler per project
    root_markers = { '.asm-lsp.toml', '.git' },
}
