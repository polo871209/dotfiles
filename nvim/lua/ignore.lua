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
}

M.files = {
  '*.lock',
  '*-lock.json',
  '*-lock.yaml',
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
  'lock.json',
  'a.out',
  'main',
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
}

M.names = vim.list_extend(vim.deepcopy(M.dirs), { 'lock.json', 'a.out', 'main' })
M.patterns = vim.list_extend(vim.deepcopy(M.dirs), M.files)

return M
