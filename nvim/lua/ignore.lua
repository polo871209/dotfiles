local M = {}

M.dirs = {
  '.claude',
  '.codex',
  '.git',
  '.specify',
  '.swarm',
  '.terraform',
  '.vite',
  '.vscode',
  '.windsurf',
  '.zig-cache',
  'zig-out',
}

M.files = {
  '*.7z',
  '*.avif',
  '*.bin',
  '*.bmp',
  '*.class',
  '*.db',
  '*.dylib',
  '*.exe',
  '*.gif',
  '*.ico',
  '*.jpeg',
  '*.jpg',
  '*.lock',
  '*.mov',
  '*.mp4',
  '*.otf',
  '*.pdf',
  '*.png',
  '*.pyc',
  '*.so',
  '*.sqlite',
  '*.tar',
  '*.ttf',
  '*.webp',
  '*.zip',
  '*-lock.json',
  '*-lock.yaml',
  'a.out',
  'lock.json',
  'main',
}

M.names = vim.list_extend(vim.deepcopy(M.dirs), { 'lock.json', 'a.out', 'main' })
M.patterns = vim.list_extend(vim.deepcopy(M.dirs), M.files)

return M
