dotfiles := justfile_directory()

default:
    @just --list

# Stow + link global skills
link:
    @stow .
    @rm -rf ~/.pi
    @ln -sfn {{dotfiles}}/.pi ~/.pi

# Native markdown viewer that nvim opens with <leader>tm: `just mdview`, `just mdview test`
mod mdview "nvim/mdview"
