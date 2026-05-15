dotfiles := justfile_directory()

default:
    @just --list

# Stow + link global skills
link:
    @stow .
    @mkdir -p ~/.agents
    @ln -sfn {{dotfiles}}/.agents/skills ~/.agents/skills
