import SwiftUI

/// SVG path data ("M2 3L4 5Q…Z") as a SwiftUI Path, so the app draws the web
/// app's own icons (frontend/src/lib/icons.js) rather than look-alikes. Every
/// command, absolute and relative, with arcs turned into cubic curves.
struct SVGPath {
    static func parse(_ d: String) -> Path {
        var path = Path()
        var t = Tokens(d)
        var cmd: Character = "M"
        var cur = CGPoint.zero, start = CGPoint.zero
        var lastCubic: CGPoint?, lastQuad: CGPoint?

        while !t.done {
            if let c = t.command() { cmd = c } else if cmd == "M" { cmd = "L" } else if cmd == "m" { cmd = "l" }
            let rel = cmd.isLowercase
            func pt() -> CGPoint {
                let x = t.number(), y = t.number()
                return rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y)
            }
            switch cmd.uppercased().first! {
            case "M":
                cur = pt(); start = cur; path.move(to: cur)
                lastCubic = nil; lastQuad = nil
            case "L":
                cur = pt(); path.addLine(to: cur)
                lastCubic = nil; lastQuad = nil
            case "H":
                let x = t.number(); cur = CGPoint(x: rel ? cur.x + x : x, y: cur.y); path.addLine(to: cur)
                lastCubic = nil; lastQuad = nil
            case "V":
                let y = t.number(); cur = CGPoint(x: cur.x, y: rel ? cur.y + y : y); path.addLine(to: cur)
                lastCubic = nil; lastQuad = nil
            case "C":
                let c1 = pt(), c2 = pt(), p = pt()
                path.addCurve(to: p, control1: c1, control2: c2)
                cur = p; lastCubic = c2; lastQuad = nil
            case "S":
                let c1 = lastCubic.map { CGPoint(x: 2 * cur.x - $0.x, y: 2 * cur.y - $0.y) } ?? cur
                let c2 = pt(), p = pt()
                path.addCurve(to: p, control1: c1, control2: c2)
                cur = p; lastCubic = c2; lastQuad = nil
            case "Q":
                let c = pt(), p = pt()
                path.addQuadCurve(to: p, control: c)
                cur = p; lastQuad = c; lastCubic = nil
            case "T":
                let c = lastQuad.map { CGPoint(x: 2 * cur.x - $0.x, y: 2 * cur.y - $0.y) } ?? cur
                let p = pt()
                path.addQuadCurve(to: p, control: c)
                cur = p; lastQuad = c; lastCubic = nil
            case "A":
                let rx = t.number(), ry = t.number(), rot = t.number()
                let large = t.flag(), sweep = t.flag()
                let p = pt()
                arc(&path, from: cur, to: p, rx: rx, ry: ry, rotation: rot, large: large, sweep: sweep)
                cur = p; lastCubic = nil; lastQuad = nil
            case "Z":
                path.closeSubpath(); cur = start
                lastCubic = nil; lastQuad = nil
            default:
                return path
            }
        }
        return path
    }

    /// An elliptical arc, endpoint form (SVG 1.1, F.6.5), as cubic curves of at most a quarter turn each.
    private static func arc(_ path: inout Path, from p0: CGPoint, to p1: CGPoint, rx rxIn: Double, ry ryIn: Double,
                            rotation: Double, large: Bool, sweep: Bool) {
        var rx = abs(rxIn), ry = abs(ryIn)
        guard rx > 0, ry > 0, p0 != p1 else { path.addLine(to: p1); return }
        let phi = rotation * .pi / 180, cosP = cos(phi), sinP = sin(phi)
        let dx = (p0.x - p1.x) / 2, dy = (p0.y - p1.y) / 2
        let x1 = cosP * dx + sinP * dy, y1 = -sinP * dx + cosP * dy
        let lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
        if lambda > 1 { rx *= sqrt(lambda); ry *= sqrt(lambda) }
        let num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
        let den = rx * rx * y1 * y1 + ry * ry * x1 * x1
        var coef = sqrt(max(0, num / den))
        if large == sweep { coef = -coef }
        let cx1 = coef * rx * y1 / ry, cy1 = -coef * ry * x1 / rx
        let cx = cosP * cx1 - sinP * cy1 + (p0.x + p1.x) / 2
        let cy = sinP * cx1 + cosP * cy1 + (p0.y + p1.y) / 2
        func angle(_ ux: Double, _ uy: Double, _ vx: Double, _ vy: Double) -> Double {
            let a = atan2(ux * vy - uy * vx, ux * vx + uy * vy)
            return a
        }
        let theta1 = angle(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
        var delta = angle((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
        if !sweep && delta > 0 { delta -= 2 * .pi }
        if sweep && delta < 0 { delta += 2 * .pi }
        let segments = max(1, Int(ceil(abs(delta) / (.pi / 2))))
        let step = delta / Double(segments)
        let k = 4.0 / 3.0 * tan(step / 4)
        var a = theta1
        for _ in 0..<segments {
            let cosA = cos(a), sinA = sin(a), cosB = cos(a + step), sinB = sin(a + step)
            func map(_ x: Double, _ y: Double) -> CGPoint {
                CGPoint(x: cx + rx * x * cosP - ry * y * sinP, y: cy + rx * x * sinP + ry * y * cosP)
            }
            path.addCurve(to: map(cosB, sinB),
                          control1: map(cosA - k * sinA, sinA + k * cosA),
                          control2: map(cosB + k * sinB, sinB - k * cosB))
            a += step
        }
    }

    /// Numbers and commands, as SVG writes them: "-1.5.5" is -1.5 then .5.
    private struct Tokens {
        let s: [Character]
        var i = 0
        init(_ d: String) { s = Array(d) }
        var done: Bool { mutating get { skip(); return i >= s.count } }
        mutating func skip() { while i < s.count, s[i] == " " || s[i] == "," || s[i] == "\n" || s[i] == "\t" { i += 1 } }
        mutating func command() -> Character? {
            skip()
            guard i < s.count, s[i].isLetter, s[i] != "e", s[i] != "E" else { return nil }
            defer { i += 1 }
            return s[i]
        }
        mutating func flag() -> Bool {
            skip()
            guard i < s.count else { return false }
            defer { i += 1 }
            return s[i] == "1"
        }
        mutating func number() -> Double {
            skip()
            var j = i
            if j < s.count, s[j] == "-" || s[j] == "+" { j += 1 }
            var dot = false
            while j < s.count {
                let c = s[j]
                if c.isNumber { j += 1 }
                else if c == ".", !dot { dot = true; j += 1 }
                else if c == "e" || c == "E" {
                    j += 1
                    if j < s.count, s[j] == "-" || s[j] == "+" { j += 1 }
                } else { break }
            }
            defer { i = j }
            return Double(String(s[i..<j])) ?? 0
        }
    }
}

/// One of the web app's icons: its paths in an 18-point (or other) box, a turn
/// of the whole, and whether it is filled (even-odd) or drawn as a line.
struct SVGIcon: Shape {
    let paths: [String]
    var box: CGFloat = 18
    var rotate: Double = 0                 // degrees, about the box's centre
    var stroke: CGFloat? = nil              // a line icon's width, in the box's units

    func path(in rect: CGRect) -> Path {
        var p = Path()
        for d in paths { p.addPath(SVGPath.parse(d)) }
        let scale = min(rect.width, rect.height) / box
        let c = box / 2
        var t = CGAffineTransform(translationX: rect.minX, y: rect.minY).scaledBy(x: scale, y: scale)
        if rotate != 0 {
            t = t.translatedBy(x: c, y: c).rotated(by: rotate * .pi / 180).translatedBy(x: -c, y: -c)
        }
        let placed = p.applying(t)
        if let stroke {
            return placed.strokedPath(StrokeStyle(lineWidth: stroke * scale, lineCap: .round, lineJoin: .round))
        }
        return placed
    }
}

extension SVGIcon {
    /// Filled with the even-odd rule, as the web app's list icons are.
    func drawn(_ colour: Color) -> some View {
        fill(colour, style: FillStyle(eoFill: stroke == nil))
    }
}
