import AppKit
import Carbon.HIToolbox

let app = NSApplication.shared
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

NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .otherMouseDown]) { event in
    let delta: Int?
    var quit = false
    var find = false
    if event.type == .otherMouseDown {
        let backButton = 3, forwardButton = 4
        delta = [backButton: -1, forwardButton: 1][event.buttonNumber]
    } else {
        let mods = event.modifierFlags.intersection(.deviceIndependentFlagsMask).subtracting([.capsLock, .numericPad, .function])
        let key = event.charactersIgnoringModifiers
        let typing = event.window?.firstResponder is NSText
        if !typing, mods == .command, key == "[" || Int(event.keyCode) == kVK_LeftArrow {
            delta = -1
        } else if !typing, mods == .command, key == "]" || Int(event.keyCode) == kVK_RightArrow {
            delta = 1
        } else {
            delta = nil
            find = mods == .command && key == "f"
            quit = !typing && mods.isEmpty && (Int(event.keyCode) == kVK_Escape || key == "q")
        }
    }
    guard delta != nil || quit || find else { return event }
    MainActor.assumeIsolated {
        if let delta {
            viewer.go(delta)
        } else if find {
            viewer.find.shown = true
        } else if viewer.find.shown {
            viewer.find.shown = false
        } else {
            NSApp.terminate(nil)
        }
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
