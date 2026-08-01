import AppKit
import QuartzCore

/// The "Rose Two" math-curve loader (r = a·cos(2θ)): a rotating, breathing rose traced by a
/// fading trail of particles — NotchSPI's signature indicator. Pure AppKit: drawn with Core
/// Graphics on a `CADisplayLink` clock (the AppKit port of the original SwiftUI `Canvas`).
final class RoseLoaderView: NSView {
    var color: NSColor = .white { didSet { needsDisplay = true } }

    /// Welcome-page brand-moment mode: the trail is tinted accent→white toward the head, drawn
    /// additively with a soft bloom under the leading particles, so the rose reads as a signature
    /// of light instead of a dim gray glyph. Defaults off — the notch's quiet loader is unchanged.
    var hero: Bool = false { didSet { needsDisplay = true } }

    /// Whether the pipeline is actively working. At rest the rose still breathes/rotates, but
    /// those motions are minutes-slow (28s/rev, 4.3s pulse) — 24fps is imperceptible from 60 and
    /// this indicator is ALWAYS on screen beside the notch, so the idle cost matters. Working
    /// (running/streaming) takes the full clock.
    var busy: Bool = false { didSet { if busy != oldValue { retuneClock() } } }

    // config (from the original)
    private let particleCount = 48
    private let trailSpan = 0.3
    private let durationMs = 5200.0
    private let rotationDurationMs = 28000.0
    private let pulseDurationMs = 4300.0
    private let strokeWidth = 3.0
    private let roseA = 9.2
    private let roseABoost = 0.6
    private let roseBreathBase = 0.72
    private let roseBreathBoost = 0.28
    private let roseScale = 3.25
    private let pathSteps = 160

    private var link: CADisplayLink?
    private var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

    override init(frame frameRect: NSRect) { super.init(frame: frameRect) }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var isFlipped: Bool { false }
    override func hitTest(_ point: NSPoint) -> NSView? { nil } // decorative; never intercept clicks

    // MARK: Display clock — runs only while on screen (and motion is allowed)

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil { startLink() } else { stopLink() }
    }

    private func startLink() {
        guard link == nil, !reduceMotion else { needsDisplay = true; return }
        let l = displayLink(target: self, selector: #selector(tick))
        l.add(to: .main, forMode: .common)
        link = l
        retuneClock()
    }

    private func retuneClock() {
        guard let link, !reduceMotion else { return }
        let fps: Float = busy ? 60 : 24
        link.preferredFrameRateRange = CAFrameRateRange(minimum: max(15, fps - 12), maximum: fps, preferred: fps)
    }

    private func stopLink() { link?.invalidate(); link = nil }
    @objc private func tick() { needsDisplay = true }
    deinit { link?.invalidate() }

    // MARK: Geometry

    private func point(_ progress: Double, _ detail: Double) -> CGPoint {
        let t = progress * 2 * .pi
        let a = roseA + detail * roseABoost
        let r = a * (roseBreathBase + detail * roseBreathBoost) * cos(2 * t)
        return CGPoint(x: 50 + cos(t) * r * roseScale, y: 50 + sin(t) * r * roseScale)
    }

    private func normalize(_ p: Double) -> Double {
        let m = p.truncatingRemainder(dividingBy: 1)
        return (m + 1).truncatingRemainder(dividingBy: 1)
    }

    // MARK: Draw

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let sz = bounds.size
        guard sz.width > 1, sz.height > 1 else { return }
        // Reduce Motion: render one static, pleasing pose instead of animating.
        let timeMs = reduceMotion ? 1500.0 : CACurrentMediaTime() * 1000

        let scale = min(sz.width, sz.height) / 100
        let pulseAngle = (timeMs.truncatingRemainder(dividingBy: pulseDurationMs)) / pulseDurationMs * 2 * .pi
        let detail = 0.52 + ((sin(pulseAngle + 0.55) + 1) / 2) * 0.48
        let rotation = -((timeMs.truncatingRemainder(dividingBy: rotationDurationMs)) / rotationDurationMs) * 360
        let progress = (timeMs.truncatingRemainder(dividingBy: durationMs)) / durationMs

        // Size-aware legibility: the geometry lives in a 100-unit space, so at the notch's 16-22pt
        // sizes one unit is a fraction of a pixel — the trail's 0.9…3.6-unit particles collapse
        // into sub-pixel mush and the 12%-alpha curve reads as a smudge. `smallness` (0 at hero
        // sizes → 1 at ≤~20pt) compensates: thicker stroke, a touch more curve ink, and a particle
        // radius floor of about one device pixel — the signature stays quiet, but becomes *drawn*.
        let unitsPerPoint = 100 / max(1, min(sz.width, sz.height))
        let smallness = max(0, min(1, (unitsPerPoint - 1.2) / 3.8))

        ctx.saveGState()
        ctx.translateBy(x: sz.width / 2, y: sz.height / 2)
        ctx.rotate(by: rotation * .pi / 180)
        ctx.scaleBy(x: scale, y: scale)
        ctx.translateBy(x: -50, y: -50)

        if hero { ctx.setBlendMode(.plusLighter) }   // light accumulates on the dark aurora

        // faint full curve
        let path = CGMutablePath()
        for i in 0...pathSteps {
            let p = point(Double(i) / Double(pathSteps), detail)
            if i == 0 { path.move(to: p) } else { path.addLine(to: p) }
        }
        ctx.addPath(path)
        let curveColor = hero ? NotchPalette.accent.withAlphaComponent(0.22)
                              : color.withAlphaComponent(0.12 + 0.09 * smallness)
        ctx.setStrokeColor(curveColor.cgColor)
        ctx.setLineWidth(strokeWidth * (1 + smallness * 0.85))
        ctx.setLineCap(.round)
        ctx.setLineJoin(.round)
        ctx.strokePath()

        // trailing particles
        for i in 0..<particleCount {
            let tail = Double(i) / Double(particleCount - 1)
            let p = point(normalize(progress - tail * trailSpan), detail)
            let fade = pow(1 - tail, 0.56)
            let radius = max((0.9 + fade * 2.7) * (1 + smallness * 0.7), smallness * 2.4)
            let opacity = 0.04 + fade * 0.96
            // Hero: accent at the tail warming to near-white at the head, with a soft bloom under
            // the leading particles — the signature drawn in light.
            let particle: NSColor = hero
                ? (NotchPalette.accentHi.blended(withFraction: fade * 0.75, of: .white) ?? NotchPalette.accentHi)
                : color
            if hero, i < 6 {
                let bloomR = radius * 3.4
                let space = CGColorSpace(name: CGColorSpace.sRGB)!
                let c = (NotchPalette.accentHi.usingColorSpace(.sRGB) ?? NotchPalette.accentHi)
                if let g = CGGradient(colorsSpace: space,
                                      colors: [c.withAlphaComponent(0.35 * fade).cgColor,
                                               c.withAlphaComponent(0).cgColor] as CFArray,
                                      locations: [0, 1]) {
                    ctx.drawRadialGradient(g, startCenter: p, startRadius: 0,
                                           endCenter: p, endRadius: bloomR, options: [])
                }
            }
            let rect = CGRect(x: p.x - radius, y: p.y - radius, width: radius * 2, height: radius * 2)
            ctx.setFillColor(particle.withAlphaComponent(CGFloat(opacity)).cgColor)
            ctx.fillEllipse(in: rect)
        }
        ctx.restoreGState()
    }
}
