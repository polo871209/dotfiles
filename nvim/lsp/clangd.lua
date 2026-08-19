-- clangd ships with Xcode Command Line Tools (/usr/bin/clangd once
-- `xcode-select --install` has run) so there is nothing to add to mise.
-- Without a compile_commands.json (e.g. from CMake's
-- CMAKE_EXPORT_COMPILE_COMMANDS or `bear -- make`) it falls back to a
-- generic flag set, which is enough to find system/Homebrew OpenGL headers
-- (GLFW, GLAD, ...) on the default include path but may misresolve
-- project-local ones.
return {
    cmd = { 'clangd', '--background-index' },
    filetypes = { 'c', 'cpp', 'objc', 'objcpp' },
    root_markers = { 'compile_commands.json', 'compile_flags.txt', '.clangd', 'CMakeLists.txt', '.git' },
}
