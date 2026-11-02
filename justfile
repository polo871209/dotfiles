dotfiles := justfile_directory()

default:
    @just --list

# Stow + link global skills
link:
    @stow .
    @rm -rf ~/.pi
    @ln -sfn {{dotfiles}}/.pi ~/.pi

# Update third-party skills in .agents/skills from skills-lock.json
update-skill:
    DISABLE_TELEMETRY=1 npx -y skills@latest update -p -y

# Native markdown viewer that nvim opens with <leader>tm: `just mdview`, `just mdview test`
mod mdview "nvim/mdview"

# Rex app extensions, such as the ⌘K session picker: `just rex` patches Rex, `just rex unpatch`
mod rex "rex/extensions"
