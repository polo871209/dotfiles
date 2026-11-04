import ClaudeUsage
import PendingPRs
import SessionPicker

@_cdecl("rex_extensions_start")
public func rexExtensionsStart() {
    MainActor.assumeIsolated {
        PickerHost.shared.start()
        UsagePanels.shared.start()
        PendingHost.shared.start()
    }
}
