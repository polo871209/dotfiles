import SwiftUI

extension View {
    /// Casts the shadow from the card shape, because a shadow on the content redraws the list offscreen.
    public func overlayCard(_ theme: Theme) -> some View {
        let shape = RoundedRectangle(cornerRadius: 12)
        return background {
            shape.fill(theme.background).shadow(color: .black.opacity(0.35), radius: 24, y: 8)
        }
        .overlay(shape.strokeBorder(theme.muted.opacity(0.35)))
    }
}
