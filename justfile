dotfiles := justfile_directory()

default:
    @just --list

# Stow + link global skills
link:
    @stow .
    @rm -rf ~/.pi
    @ln -sfn {{dotfiles}}/.pi ~/.pi
