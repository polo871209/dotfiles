skills_dir := justfile_directory() / "opencode/skills"

default:
    @just --list

# Update all opencode skills from their upstream GitHub repos
# To add a new skill, append to the SKILLS array: "name=user/repo/branch/path"
skills-update:
    #!/usr/bin/env bash
    set -euo pipefail
    SKILLS=(
        "worktrunk=max-sixty/worktrunk/main/skills/worktrunk"
    )
    SKILLS_DIR="{{ skills_dir }}"
    RAW="https://raw.githubusercontent.com"
    for entry in "${SKILLS[@]}"; do
        skill="${entry%%=*}"
        repo_path="${entry#*=}"
        gh_repo="$(echo "$repo_path" | cut -d/ -f1-2)"
        branch="$(echo "$repo_path" | cut -d/ -f3)"
        skill_path="$(echo "$repo_path" | cut -d/ -f4-)"
        dest="$SKILLS_DIR/$skill"
        echo "==> Updating skill: $skill"
        mkdir -p "$dest/reference"
        curl -fsSL "$RAW/$repo_path/SKILL.md" -o "$dest/SKILL.md"
        echo "    SKILL.md"
        ref_files=$(gh api "repos/$gh_repo/contents/$skill_path/reference?ref=$branch" \
            --jq '.[].name | select(endswith(".md"))' 2>/dev/null || true)
        for f in $ref_files; do
            curl -fsSL "$RAW/$repo_path/reference/$f" -o "$dest/reference/$f"
            echo "    reference/$f"
        done
        echo "    done."
    done

# Bootstrap nushell tool caches (run once after first install)
bootstrap-nushell:
    #!/usr/bin/env nu
    mkdir ($nu.cache-dir)
    atuin init nu | save --force $"($nu.cache-dir)/atuin.nu"
    carapace _carapace nushell | save --force $"($nu.cache-dir)/carapace.nu"
    zoxide init nushell | save --force $"($nu.cache-dir)/zoxide.nu"
    print "Nushell caches initialized. Restart nushell to apply."

key-enable:
    @sudo cp katana/com.example.kanata.plist /Library/LaunchDaemons/
    @sudo launchctl load /Library/LaunchDaemons/com.example.kanata.plist

key-disable:
    @sudo launchctl unload /Library/LaunchDaemons/com.example.kanata.plist
    @sudo rm /Library/LaunchDaemons/com.example.kanata.plist

key-status:
    @sudo launchctl list | grep kanata || echo "Kanata not running"
