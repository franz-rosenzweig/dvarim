import AppKit
import SwiftUI

/// The colours of the web app's stylesheet (frontend/src/app.css), light and
/// dark, so the two read as the same app. Explicit colours, not hierarchical
/// ones: .tertiary and friends can vanish inside rows.
enum Palette {
    static let main = dynamic(0xFFFFFF, 0x2A2A2D)
    static let card = dynamic(0xFFFFFF, 0x333336)
    static let text = dynamic(0x1C1C1E, 0xF2F2F7)
    static let text2 = dynamic(0x6E6E73, 0xA1A1A6)
    static let text3 = dynamic(0xA1A1A6, 0x6E6E73)
    static let hair = dynamic(0xE5E5EA, 0x3A3A3E)
    static let hair2 = dynamic(0xEFEFF2, 0x333337)
    static let rowSelected = dynamic(0xCFE1FA, 0x2A3F5C)
    static let pill = dynamic(0xEDEDF0, 0x3A3A3E)
    static let check = dynamic(0xC7C7CC, 0x5A5A60)
    static let accent = dynamic(0x2B7DE9, 0x4C9AFF)
    static let deadline = dynamic(0xE23F3F, 0xFF5C5C)
    static let moon = dynamic(0x4C7BD9, 0x7AA2F7)
    static let star = Color(hex: 0xF5C33B)
    static let upcoming = Color(hex: 0xEE4D67)
    static let anytime = Color(hex: 0x3FB4A6)
    static let someday = Color(hex: 0xC5A166)
    static let logbook = Color(hex: 0x4CB35B)
    static let trash = Color(hex: 0x9A9AA0)
    static let inbox = Color(hex: 0x3D87F5)

    private static func dynamic(_ light: UInt32, _ dark: UInt32) -> Color {
        Color(nsColor: NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(hex: dark) : NSColor(hex: light)
        })
    }
}

/// The web app's measurements, in points: its CSS pixels are points here.
enum Metrics {
    static let column: CGFloat = 640          // .col max-width
    static let sideMargin: CGFloat = 48       // .content padding
    static let topMargin: CGFloat = 14
    static let bottomMargin: CGFloat = 40
    static let titleSize: CGFloat = 26        // h1.t
    static let rowFont: CGFloat = 14
    static let subFont: CGFloat = 11.5
    static let box: CGFloat = 16
}

extension Color {
    init(hex: UInt32) {
        self.init(red: Double((hex >> 16) & 0xff) / 255, green: Double((hex >> 8) & 0xff) / 255, blue: Double(hex & 0xff) / 255)
    }
}

extension NSColor {
    convenience init(hex: UInt32) {
        self.init(srgbRed: CGFloat((hex >> 16) & 0xff) / 255, green: CGFloat((hex >> 8) & 0xff) / 255, blue: CGFloat(hex & 0xff) / 255, alpha: 1)
    }
}
