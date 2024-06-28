#!/bin/bash

# @raycast.title "Open Arc in Incognito"
# @raycast.icon 🥽
# @raycast.mode silent
# @raycast.packageName "Browser"
# @raycast.schemaVersion 1

# AppleScript to open Arc in incognito mode
osascript -e 'tell application "Arc"' \
          -e 'activate' \
          -e 'make new window with properties {incognito:true}' \
          -e 'end tell'
