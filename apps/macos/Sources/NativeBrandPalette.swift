import AppKit

/// TiboTattle's shared native dynamic palette. Values mirror the web report's
/// tokens (`--paper: #f5f1e8` and `--green: #174f45`) so every native surface
/// and the embedded report read as one product across Aqua and Dark Aqua.
enum NativeBrandPalette {
    /// Web accent #174f45 in light appearance and Forest Ink #76aa9c in dark.
    static let accent = NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(
                srgbRed: 118 / 255,
                green: 170 / 255,
                blue: 156 / 255,
                alpha: 1
            )
            : NSColor(
                srgbRed: 23 / 255,
                green: 79 / 255,
                blue: 69 / 255,
                alpha: 1
            )
    }

    /// Exact web report paper in each appearance. Painting this behind native
    /// report surfaces prevents a mismatched system-grey flash during reload.
    static let reportPaper = NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(
                srgbRed: 20 / 255,
                green: 26 / 255,
                blue: 23 / 255,
                alpha: 1
            )
            : NSColor(
                srgbRed: 245 / 255,
                green: 241 / 255,
                blue: 232 / 255,
                alpha: 1
            )
    }

    /// Web paper washed over the system sidebar material so vibrancy still
    /// reads through it.
    static let sidebarWash = NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(
                srgbRed: 45 / 255,
                green: 116 / 255,
                blue: 102 / 255,
                alpha: 0.22
            )
            : NSColor(
                srgbRed: 245 / 255,
                green: 241 / 255,
                blue: 232 / 255,
                alpha: 0.55
            )
    }
}
