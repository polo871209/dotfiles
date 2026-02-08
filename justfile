key-enable:
    @sudo cp katana/com.example.kanata.plist /Library/LaunchDaemons/
    @sudo launchctl load /Library/LaunchDaemons/com.example.kanata.plist

key-disable:
    @sudo launchctl unload /Library/LaunchDaemons/com.example.kanata.plist
    @sudo rm /Library/LaunchDaemons/com.example.kanata.plist

key-status:
    @sudo launchctl list | grep kanata || echo "Kanata not running"
