#!/bin/bash

# User Configuration
git config --global user.name "PoLo"
git config --global user.email "qazh0123@gmail.com"

# Init Configuration
git config --global init.defaultBranch "main"

# Core Configuration
git config --global core.autocrlf false
git config --global core.excludesFile ~/.config/git/ignore
git config --global core.editor nvim
git config --global core.filemode false
git config --global core.quotepath false

# Rerere Configuration
git config --global rerere.enabled true
git config --global rerere.autoupdate true

# Pull Configuration
git config --global pull.rebase true

# Git LFS Configuration
git config --global filter.lfs.required true
git config --global filter.lfs.clean "git-lfs clean -- %f"
git config --global filter.lfs.smudge "git-lfs smudge -- %f"
git config --global filter.lfs.process "git-lfs filter-process"

# Additional Configuration
git config --global diff.algorithm histogram
