#!/bin/sh

# @raycast.schemaVersion 1
# @raycast.title qmk build
# @raycast.mode silent
# @raycast.icon ⌨️

osascript <<EOF
tell application "iTerm"
    activate
    set newWindow to (create window with default profile)
    tell current session of newWindow
        write text "cd /Users/polo/Documents/app/qmk_firmware && ./util/docker_build.sh sofle:polo871209"
    end tell
end tell
EOF