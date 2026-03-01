#!/usr/bin/env bash

# Zen Browser Dotfiles Installer for macOS
# This script symlinks Zen Browser configuration files to the active profile

set -e

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Zen Browser profile directory
ZEN_DIR="$HOME/Library/Application Support/zen"
DOTFILES_ZEN_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "🔍 Finding Zen Browser profile..."

# Check if Zen Browser directory exists
if [ ! -d "$ZEN_DIR" ]; then
    echo -e "${RED}❌ Zen Browser directory not found at: $ZEN_DIR${NC}"
    echo "Please install Zen Browser first."
    exit 1
fi

# Find the default profile from profiles.ini
if [ ! -f "$ZEN_DIR/profiles.ini" ]; then
    echo -e "${RED}❌ profiles.ini not found${NC}"
    exit 1
fi

# Find the first existing profile directory from all [Install*] sections,
# then fall back to any profile Path= entry that exists on disk.
PROFILE_PATH=""
while IFS='=' read -r key val; do
    if [[ "$key" == "Default" && -d "$ZEN_DIR/$val" ]]; then
        PROFILE_PATH="$val"
        break
    fi
done < <(awk '/^\[Install/{found=1} found && /^Default=/{print; found=0}' "$ZEN_DIR/profiles.ini")

if [ -z "$PROFILE_PATH" ]; then
    # Fallback: use the first Path= entry whose directory exists
    while IFS='=' read -r key val; do
        if [ -d "$ZEN_DIR/$val" ]; then
            PROFILE_PATH="$val"
            break
        fi
    done < <(grep "^Path=" "$ZEN_DIR/profiles.ini" | cut -d'=' -f2- | sed 's/^/Path=/')
fi

if [ -z "$PROFILE_PATH" ]; then
    echo -e "${RED}❌ No existing profile directory found in profiles.ini${NC}"
    exit 1
fi

FULL_PROFILE_PATH="$ZEN_DIR/$PROFILE_PATH"

echo -e "${GREEN}✓ Found profile: $PROFILE_PATH${NC}"

# Function to create symlink
create_symlink() {
    local source="$1"
    local target="$2"
    local filename=$(basename "$source")

    if [ -L "$target" ]; then
        echo -e "${YELLOW}⚠ Removing existing symlink: $filename${NC}"
        rm "$target"
    elif [ -f "$target" ]; then
        echo -e "${YELLOW}⚠ Backing up existing file: $filename${NC}"
        mv "$target" "$target.backup.$(date +%Y%m%d_%H%M%S)"
    fi

    ln -s "$source" "$target"
    echo -e "${GREEN}✓ Linked: $filename${NC}"
}

echo ""
echo "📝 Creating symlinks..."

# Symlink user.js
if [ -f "$DOTFILES_ZEN_DIR/user.js" ]; then
    create_symlink "$DOTFILES_ZEN_DIR/user.js" "$FULL_PROFILE_PATH/user.js"
else
    echo -e "${YELLOW}⚠ user.js not found in dotfiles${NC}"
fi

# Symlink zen-keyboard-shortcuts.json
if [ -f "$DOTFILES_ZEN_DIR/zen-keyboard-shortcuts.json" ]; then
    create_symlink "$DOTFILES_ZEN_DIR/zen-keyboard-shortcuts.json" "$FULL_PROFILE_PATH/zen-keyboard-shortcuts.json"
else
    echo -e "${YELLOW}⚠ zen-keyboard-shortcuts.json not found in dotfiles${NC}"
fi

echo ""
echo -e "${GREEN}✅ Zen Browser configuration installed!${NC}"
echo ""
echo "📌 Next steps:"
echo "   1. Restart Zen Browser for changes to take effect"
echo "   2. Customize zen-browser/user.js with your preferences"
echo "   3. Commit these files to your dotfiles repo"
