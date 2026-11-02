import AppKit
import SwiftUI

/// Built-in Rex themes are not in defaults, so they get system colors.
public struct Theme {
    public var background = Color(nsColor: .windowBackgroundColor)
    public var foreground = Color(nsColor: .labelColor)
    public var muted = Color(nsColor: .secondaryLabelColor)
    public var selection = Color(nsColor: .selectedContentBackgroundColor)
    public var yellow = Color.yellow
    public var red = Color.red
    public var green = Color.green

    @MainActor public static func current(for appearance: NSAppearance) -> Theme {
        let dark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let defaults = UserDefaults.standard
        guard
            let id = defaults.string(
                forKey: dark ? "Workspace.darkThemeID" : "Workspace.lightThemeID"),
            let data = defaults.data(forKey: "Workspace.customThemes")
                ?? defaults.string(forKey: "Workspace.customThemes")?.data(using: .utf8),
            let themes = try? JSONDecoder().decode([StoredTheme].self, from: data),
            let palette = themes.first(where: { $0.id == id })?.palette
        else { return Theme() }
        var theme = Theme()
        theme.background = palette.background.color
        theme.foreground = palette.foreground.color
        theme.selection = palette.selectionBackground.color
        theme.muted = theme.foreground.mix(with: theme.background, by: 0.3)
        if palette.ansi.count == 16 {
            theme.red = palette.ansi[9].color
            theme.green = palette.ansi[10].color
            theme.yellow = palette.ansi[11].color
        }
        return theme
    }
}

private struct StoredTheme: Decodable {
    struct Palette: Decodable {
        let background: StoredColor
        let foreground: StoredColor
        let selectionBackground: StoredColor
        let ansi: [StoredColor]
    }

    let id: String
    let palette: Palette
}

private struct StoredColor: Decodable {
    let red: Double
    let green: Double
    let blue: Double
    let alpha: Double

    public var color: Color { Color(.sRGB, red: red, green: green, blue: blue, opacity: alpha) }
}
