import AppKit
import SwiftUI

/// The colours of the web app's stylesheet (frontend/src/app.css), light and
/// dark, so the two read as the same app: its earthy lists and sage accent. Explicit colours, not hierarchical
/// ones: .tertiary and friends can vanish inside rows.
enum Palette {
    static let main = dynamic(0xFFFFFF, 0x2A2A2D)
    static let card = dynamic(0xFFFFFF, 0x333336)
    static let text = dynamic(0x1C1C1E, 0xF2F2F7)
    static let text2 = dynamic(0x6E6E73, 0xA1A1A6)
    static let text3 = dynamic(0xA1A1A6, 0x6E6E73)
    static let hair = dynamic(0xE5E5EA, 0x3A3A3E)
    static let hair2 = dynamic(0xEFEFF2, 0x333337)
    static let rowSelected = dynamic(0xE4EADB, 0x2F3828)
    static let pill = dynamic(0xEDEDF0, 0x3A3A3E)
    static let check = dynamic(0xC7C7CC, 0x5A5A60)
    static let checkOn = dynamic(0x668250, 0x76925F)
    // the sage of the app icon's tick
    static let accent = dynamic(0x668250, 0x7E9A66)
    static let deadline = dynamic(0xBE3B33, 0xEA5F57)
    static let moon = dynamic(0x4F5A8E, 0x8E98D2)
    // each list its own colour, earthy and muted, as its icon draws in it
    static let inbox = dynamic(0x6B4A2B, 0xC9A57B)
    static let star = dynamic(0xD08E2C, 0xE8A944)
    static let upcoming = dynamic(0x587089, 0x8FA4BC)
    static let anytime = dynamic(0x7D6893, 0xA996C4)
    static let someday = dynamic(0x7C8A45, 0xAAB66B)
    static let logbook = dynamic(0xA5553F, 0xD2826C)
    static let trash = dynamic(0xA0978B, 0x8C857B)

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
