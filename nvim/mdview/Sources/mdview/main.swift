import AppKit

// Protocol.swift holds the wire format. EOF on stdin, Esc, q, or closing the window quits.

let app = NSApplication.shared
// No Dock icon and no app switcher entry: the window is a temporary popup.
app.setActivationPolicy(.accessory)

// Key equivalents such as Cmd-C reach the web view only through a main menu.
let menu = NSMenu()
let item = NSMenuItem()
item.submenu = NSMenu()
item.submenu?.items = [
    NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"),
    NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"),
    NSMenuItem(title: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w"),
    NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"),
]
menu.addItem(item)
app.mainMenu = menu

let viewer = Viewer()

// Safari's history keys: Cmd-[ and Cmd-], Cmd-Left and Cmd-Right, and the mouse side buttons.
NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .otherMouseDown]) { event in
    let delta: Int?
    var quit = false
    if event.type == .otherMouseDown {
        // Buttons 3 and 4 are the side buttons, back and forward.
        delta = [3: -1, 4: 1][event.buttonNumber]
    } else {
        let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting([.capsLock, .numericPad, .function])
        let key = event.charactersIgnoringModifiers
        // 123 and 124 are the Left and Right arrows. 53 is Esc.
        if mods == .command, key == "[" || event.keyCode == 123 {
            delta = -1
        } else if mods == .command, key == "]" || event.keyCode == 124 {
            delta = 1
        } else {
            delta = nil
            quit = mods.isEmpty && (event.keyCode == 53 || key == "q")
        }
    }
    guard delta != nil || quit else { return event }
    MainActor.assumeIsolated {
        if let delta { viewer.go(delta) } else { NSApp.terminate(nil) }
    }
    return nil
}

Task.detached { [viewer] in
    // Split on raw 0x0A. AsyncLineSequence also splits on U+2028, which JSON leaves unescaped.
    var line = Data()
    do {
        for try await byte in FileHandle.standardInput.bytes {
            guard byte == 0x0A else {
                line.append(byte)
                continue
            }
            if let message = try? JSONDecoder().decode(Message.self, from: line) {
                await viewer.show(message)
            }
            line.removeAll(keepingCapacity: true)
        }
    } catch {}
    await MainActor.run { NSApp.terminate(nil) }
}

app.run()
