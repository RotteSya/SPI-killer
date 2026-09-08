import AppKit
import QuartzCore

// The onboarding "welcome gift" reveal, built from scratch in pure AppKit + Core Animation so
// every frame is under our control (the design bar: nothing that reads as a stock template).
// Three pieces cooperate on Page 4:
//
//   • GiftSealView       — a sealed, breathing brand medallion the player taps to claim.
//   • RewardBurstView    — a hand-rolled particle field (flash + light rings + streaking sparks)
//                          in the brand palette, driven by one CADisplayLink. No CAEmitterLayer.
//   • DigitOdometerView  — a mechanically-correct rolling-digit counter that lands crisp.
//
// All three honor Reduce Motion by collapsing to a still, finished pose instead of dropping the
// feature. Coordinates inside each view use its own space; the page positions them by frame.

// MARK: - Rolling-digit odometer

/// A counter whose digits roll like a machined odometer: the units wheel spins continuously while
/// higher wheels flick over only as the wheel below completes its turn, so the number is smooth in
/// motion yet perfectly crisp at rest. Fixed-width columns (monospaced) keep the block from
/// breathing as digits change. This replaces the old integer-rounding roll, which visibly chunked.
final class DigitOdometerView: NSView {
    var color: NSColor = .white { didSet { needsDisplay = true } }
    var fontSize: CGFloat = 68 { didSet { invalidateIntrinsicContentSize(); needsDisplay = true } }
    var suffix: String = "" { didSet { invalidateIntrinsicContentSize(); needsDisplay = true } }
    /// Minimum number of digit columns (leading zeros roll too, odometer-style). Fixed grants and
    /// the default packs still fit the same compact three-column presentation.
    var minColumns: Int = 3

    private(set) var value: Int = 0
    private var displayValue: Double = 0     // eased, drives the wheels
    private var from: Double = 0
    private var target: Int = 0
    private var startTime: CFTimeInterval = 0
    private var duration: CFTimeInterval = 1.5
    private var link: CADisplayLink?
    var onFinished: (() -> Void)?

    private var reduceMotion: Bool { onboardingReduceMotion() }

    override var isFlipped: Bool { false }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .staticText }
    override func accessibilityLabel() -> String? { "\(target) \(suffix)".trimmingCharacters(in: .whitespaces) }

    private var digitFont: NSFont { .monospacedDigitSystemFont(ofSize: fontSize, weight: .bold) }
    private var suffixFont: NSFont { .systemFont(ofSize: fontSize * 0.34, weight: .semibold) }

    private var columns: Int { max(minColumns, String(max(0, target)).count) }
    private var digitWidth: CGFloat {
        // Monospaced digits share an advance; measure "8" as the canonical widest glyph.
        ceil(("8" as NSString).size(withAttributes: [.font: digitFont]).width)
    }

    override var intrinsicContentSize: NSSize {
        let numW = CGFloat(columns) * digitWidth
        let suffixW = suffix.isEmpty ? 0 : ceil((" " + suffix as NSString)
            .size(withAttributes: [.font: suffixFont]).width) + 4
        return NSSize(width: numW + suffixW, height: ceil(fontSize * 1.2))
    }

    /// Roll up to `newTarget`. Under Reduce Motion the number simply appears.
    func roll(to newTarget: Int, duration: CFTimeInterval = 1.5) {
        target = max(0, newTarget)
        NSAccessibility.post(element: self, notification: .valueChanged)
        invalidateIntrinsicContentSize()
        guard !reduceMotion else {
            value = target; displayValue = Double(target)
            needsDisplay = true; onFinished?()
            return
        }
        from = 0
        displayValue = 0
        value = 0
        self.duration = max(0.2, duration)
        startTime = CACurrentMediaTime()
        if link == nil {
            let l = displayLink(target: self, selector: #selector(tick))
            l.add(to: .main, forMode: .common)
            link = l
        }
        link?.isPaused = false
        needsDisplay = true
    }

    /// Set immediately with no animation (used for a page re-entry that's already been claimed).
    func setImmediate(_ v: Int) {
        link?.isPaused = true
        target = v; value = v; displayValue = Double(v)
        NSAccessibility.post(element: self, notification: .valueChanged)
        invalidateIntrinsicContentSize()
        needsDisplay = true
    }

    // Ease-out with a whisper of spring settle at the end — energetic entry, soft landing.
    private func eased(_ t: Double) -> Double {
        if t >= 1 { return 1 }
        let c = 1 - pow(1 - t, 3)                       // out-cubic base
        let settle = pow(1 - t, 2.2) * sin(t * .pi * 3) * 0.010  // tiny decaying wobble
        return min(1.0, c + settle)
    }

    @objc private func tick() {
        let t = min(1, max(0, (CACurrentMediaTime() - startTime) / duration))
        displayValue = from + (Double(target) - from) * eased(t)
        value = Int(displayValue.rounded())
        needsDisplay = true
        if t >= 1 {
            displayValue = Double(target); value = target
            link?.isPaused = true
            needsDisplay = true
            onFinished?()
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let font = digitFont
        let dw = digitWidth
        let cols = columns
        let numW = CGFloat(cols) * dw
        let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
        let suffixW = suffix.isEmpty ? 0 : ceil((" " + suffix as NSString)
            .size(withAttributes: [.font: suffixFont]).width) + 4
        let originX = (bounds.width - (numW + suffixW)) / 2

        let rowH = ("8" as NSString).size(withAttributes: attrs).height   // one digit window
        let midY = bounds.midY

        for i in 0..<cols {
            let place = pow(10.0, Double(cols - 1 - i))
            let pos = displayValue / place
            let digit = (Int(floor(pos)) % 10 + 10) % 10
            let frac = pos - floor(pos)
            // Units wheel rolls continuously; higher wheels flick only in the final tenth of their
            // own turn (crisp at rest, geneva-style hand-off during the roll).
            let offset = (i == cols - 1) ? frac : max(0, min(1, (frac - 0.9) / 0.1))

            let colX = originX + CGFloat(i) * dw
            ctx.saveGState()
            // Clip to this column's single-digit window so the outgoing/incoming glyphs are masked.
            ctx.clip(to: NSRect(x: colX, y: midY - rowH / 2, width: dw, height: rowH))
            // Counting up: current glyph slides up and out, next glyph rises in from below.
            drawGlyph(digit, at: colX, shift: offset * rowH, dw: dw, midY: midY, rowH: rowH, attrs: attrs)
            drawGlyph((digit + 1) % 10, at: colX, shift: offset * rowH - rowH, dw: dw, midY: midY, rowH: rowH, attrs: attrs)
            ctx.restoreGState()
        }

        if !suffix.isEmpty {
            let sAttrs: [NSAttributedString.Key: Any] = [
                .font: suffixFont, .foregroundColor: color.withAlphaComponent(0.72),
            ]
            let s = " " + suffix as NSString
            let sz = s.size(withAttributes: sAttrs)
            // Sit the unit label low against the digits (bottoms roughly aligned), not floating mid-height.
            let y = (midY - rowH / 2) + (rowH - sz.height) * 0.16
            s.draw(at: NSPoint(x: originX + numW + 4, y: y), withAttributes: sAttrs)
        }
    }

    private func drawGlyph(_ d: Int, at colX: CGFloat, shift: CGFloat, dw: CGFloat,
                           midY: CGFloat, rowH: CGFloat, attrs: [NSAttributedString.Key: Any]) {
        let str = "\(d)" as NSString
        let sz = str.size(withAttributes: attrs)
        let x = colX + (dw - sz.width) / 2
        let y = midY - rowH / 2 + shift
        str.draw(at: NSPoint(x: x, y: y), withAttributes: attrs)
    }

    deinit { link?.invalidate() }
}

// MARK: - Reward burst (flash + rings + streaking sparks)

/// A single-shot celebratory particle field for the claim moment, drawn by hand on one
/// CADisplayLink with additive compositing so light *adds* on the dark aurora — a central bloom,
/// two thin expanding rings, and a spray of streaking sparks in the brand palette. Deliberately
/// restrained (no rainbow, no rectangles): it should read as a pulse of brand light, not confetti.
final class RewardBurstView: NSView {
    private struct Spark {
        var p: CGPoint
        var v: CGPoint
        var color: NSColor
        var born: CFTimeInterval
        var life: CFTimeInterval
        var size: CGFloat
    }

    private var sparks: [Spark] = []
    private var ringStart: CFTimeInterval = 0
    private var flashStart: CFTimeInterval = 0
    private var active = false
    private var link: CADisplayLink?
    private var lastTick: CFTimeInterval = 0

    override var isFlipped: Bool { false }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    private var palette: [NSColor] {
        [
            NotchPalette.accentHi,
            NotchPalette.accent,
            NSColor(srgbRed: 0.52, green: 0.40, blue: 0.96, alpha: 1),  // violet
            NSColor(srgbRed: 0.26, green: 0.70, blue: 0.84, alpha: 1),  // teal
            NSColor(srgbRed: 0.99, green: 0.84, blue: 0.52, alpha: 1),  // warm gold (accent spark)
            NSColor(white: 1, alpha: 1),                                // white core sparks
        ]
    }

    /// Fire the burst from the view's center. `intensity` scales the spark count (0.6…1.2).
    func burst(intensity: CGFloat = 1.0) {
        guard !onboardingReduceMotion() else { return }
        let now = CACurrentMediaTime()
        let c = CGPoint(x: bounds.midX, y: bounds.midY)
        let count = Int(56 * max(0.5, min(1.3, intensity)))
        let pal = palette
        sparks.removeAll(keepingCapacity: true)
        for i in 0..<count {
            // Golden-angle spread for even coverage, jittered so it never looks mechanical.
            let base = Double(i) * 2.399963  // golden angle (rad)
            let jitter = Double((i * 37 % 100)) / 100.0 * 0.5 - 0.25
            let angle = base + jitter
            let speedTier = Double((i * 53) % 100) / 100.0
            let speed = 140.0 + speedTier * 330.0            // px/s
            let v = CGPoint(x: CGFloat(cos(angle)) * CGFloat(speed),
                            y: CGFloat(sin(angle)) * CGFloat(speed) + 40) // slight upward bias
            let color = pal[(i * 7) % pal.count]
            let life = 0.85 + Double((i * 29) % 100) / 100.0 * 0.75
            let size = 1.4 + CGFloat((i * 17) % 100) / 100.0 * 2.4
            sparks.append(Spark(p: c, v: v, color: color, born: now, life: life, size: size))
        }
        ringStart = now
        flashStart = now
        active = true
        lastTick = now
        if link == nil {
            let l = displayLink(target: self, selector: #selector(tick))
            l.add(to: .main, forMode: .common)
            link = l
        }
        link?.isPaused = false
        needsDisplay = true
    }

    @objc private func tick() {
        let now = CACurrentMediaTime()
        var dt = now - lastTick
        lastTick = now
        if dt <= 0 || dt > 0.05 { dt = 1.0 / 60.0 }        // clamp hitches for stable physics

        var anyAlive = false
        for i in sparks.indices {
            let age = now - sparks[i].born
            if age >= sparks[i].life { continue }
            anyAlive = true
            // Integrate: gravity pulls down (own y-up space ⇒ subtract), light air drag.
            sparks[i].v.y -= 520 * CGFloat(dt)
            sparks[i].v.x *= CGFloat(pow(0.16, dt))         // air drag: retains 16%/s (≈0.97/frame)
            sparks[i].v.y *= CGFloat(pow(0.16, dt))
            sparks[i].p.x += sparks[i].v.x * CGFloat(dt)
            sparks[i].p.y += sparks[i].v.y * CGFloat(dt)
        }
        let ringAge = now - ringStart
        let ringsAlive = ringAge < 0.9
        if !anyAlive && !ringsAlive {
            active = false
            link?.isPaused = true
        }
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        guard active, let ctx = NSGraphicsContext.current?.cgContext else { return }
        let now = CACurrentMediaTime()
        let c = CGPoint(x: bounds.midX, y: bounds.midY)
        ctx.setBlendMode(.plusLighter)   // additive: light accumulates on the dark field

        // — central flash bloom: a soft radial that blooms and fades fast —
        let fAge = now - flashStart
        if fAge < 0.42 {
            let ft = fAge / 0.42
            let r = 26 + ft * 90
            let a = (1 - ft) * 0.9
            drawRadialBloom(ctx, center: c, radius: CGFloat(r),
                            color: NSColor(white: 1, alpha: CGFloat(a)))
            drawRadialBloom(ctx, center: c, radius: CGFloat(r * 1.6),
                            color: NotchPalette.accentHi.withAlphaComponent(CGFloat(a * 0.5)))
        }

        // — two thin expanding light rings —
        let rAge = now - ringStart
        for (idx, delay) in [0.0, 0.12].enumerated() {
            let a0 = rAge - delay
            guard a0 > 0, a0 < 0.9 else { continue }
            let rt = a0 / 0.9
            let radius = 18 + rt * (idx == 0 ? 150 : 120)
            let alpha = pow(1 - rt, 1.7) * 0.85
            let width = (idx == 0 ? 2.6 : 1.6) * (1 - rt * 0.6)
            let ring = NSBezierPath(ovalIn: NSRect(x: c.x - CGFloat(radius), y: c.y - CGFloat(radius),
                                                   width: CGFloat(radius * 2), height: CGFloat(radius * 2)))
            ring.lineWidth = max(0.5, CGFloat(width))
            (idx == 0 ? NotchPalette.accentHi : NSColor(srgbRed: 0.52, green: 0.40, blue: 0.96, alpha: 1))
                .withAlphaComponent(CGFloat(alpha)).setStroke()
            ring.stroke()
        }

        // — streaking sparks: a motion-blurred line from a short trail to the head, plus a head dot —
        for s in sparks {
            let age = now - s.born
            guard age < s.life else { continue }
            let lifeT = age / s.life
            let alpha = pow(1 - lifeT, 1.4)
            // Trail points back along velocity so fast sparks streak, slow ones stay compact.
            let speed = hypot(s.v.x, s.v.y)
            let trailLen = min(22, speed * 0.03)
            let dir = speed > 0.001 ? CGPoint(x: s.v.x / speed, y: s.v.y / speed) : .zero
            let tail = CGPoint(x: s.p.x - dir.x * trailLen, y: s.p.y - dir.y * trailLen)

            let streak = NSBezierPath()
            streak.move(to: tail)
            streak.line(to: s.p)
            streak.lineWidth = s.size
            streak.lineCapStyle = .round
            s.color.withAlphaComponent(CGFloat(alpha) * 0.9).setStroke()
            streak.stroke()

            // bright head
            let hr = s.size * 0.9
            let head = NSBezierPath(ovalIn: NSRect(x: s.p.x - hr, y: s.p.y - hr, width: hr * 2, height: hr * 2))
            s.color.withAlphaComponent(CGFloat(alpha)).setFill()
            head.fill()
        }

        ctx.setBlendMode(.normal)
    }

    private func drawRadialBloom(_ ctx: CGContext, center: CGPoint, radius: CGFloat, color: NSColor) {
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        let c = (color.usingColorSpace(.sRGB) ?? color)
        let cg = c.cgColor
        let clear = c.withAlphaComponent(0).cgColor
        guard let grad = CGGradient(colorsSpace: space, colors: [cg, clear] as CFArray,
                                    locations: [0, 1]) else { return }
        ctx.saveGState()
        ctx.drawRadialGradient(grad, startCenter: center, startRadius: 0,
                               endCenter: center, endRadius: radius, options: [])
        ctx.restoreGState()
    }

    deinit { link?.invalidate() }
}

// MARK: - Gift seal (the tappable medallion)

/// The sealed brand medallion shown before the claim: a dark-glass disc ringed in accent light,
/// a soft breathing aurora-glow halo, a specular sweep, and a centered spark glyph. It is a real
/// control — hovering brightens it, pressing squashes it, and a click fires `onClick`. After the
/// claim it plays a short "break" (charge → dissolve into light) and hides itself.
final class GiftSealView: NSControl {
    var onClick: (() -> Void)?

    private var hovering = false { didSet { if hovering != oldValue { needsDisplay = true } } }
    private var pressed = false { didSet { if pressed != oldValue { needsDisplay = true } } }
    private var trackingAreaRef: NSTrackingArea?

    private var link: CADisplayLink?
    private let birth = CACurrentMediaTime()
    private var breakStart: CFTimeInterval?      // set when the seal is breaking open
    var onBreakComplete: (() -> Void)?

    private var reduceMotion: Bool { onboardingReduceMotion() }

    override var isFlipped: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var acceptsFirstResponder: Bool { false }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window != nil { startClock() } else { stopClock() }
    }

    private func startClock() {
        guard link == nil, !reduceMotion else { needsDisplay = true; return }
        let l = displayLink(target: self, selector: #selector(tick))
        l.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: 60, preferred: 60)
        l.add(to: .main, forMode: .common)
        link = l
    }
    private func stopClock() { link?.invalidate(); link = nil }
    @objc private func tick() { needsDisplay = true }

    /// Begin the break-open: a quick charge-squash, then dissolve into light. Calls
    /// `onBreakComplete` at the hand-off point (when the number should appear).
    func breakOpen() {
        guard !reduceMotion else { onBreakComplete?(); alphaValue = 0; return }
        breakStart = CACurrentMediaTime()
        startClock()
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let now = CACurrentMediaTime()

        // Breathing: slow scale + glow pulse while sealed.
        let breathe = reduceMotion ? 0 : sin((now - birth) * 1.9) * 0.5 + 0.5   // 0…1
        var scale: CGFloat = 1 + CGFloat(breathe) * 0.018
        var glow: CGFloat = 0.5 + CGFloat(breathe) * 0.5
        if hovering { glow = 1; scale *= 1.03 }
        if pressed { scale *= 0.96 }

        // Break choreography overrides the resting look.
        var contentAlpha: CGFloat = 1
        if let bs = breakStart {
            let age = now - bs
            let chargeDur = 0.22, dissolveDur = 0.34
            if age < chargeDur {
                let t = age / chargeDur
                scale = 1 - CGFloat(t) * 0.14            // squash inward (anticipation)
                glow = 0.5 + CGFloat(t) * 1.4            // charge up brightness
            } else {
                let t = min(1, (age - chargeDur) / dissolveDur)
                scale = 0.86 + CGFloat(t) * 0.9          // burst outward
                glow = 1.9 * CGFloat(1 - t)
                contentAlpha = CGFloat(1 - t)
                if age >= chargeDur + dissolveDur, alphaValue > 0 {
                    alphaValue = 0
                    stopClock()
                }
            }
            // Hand off to the reveal exactly at the charge→dissolve transition.
            if age >= chargeDur, onBreakComplete != nil {
                let cb = onBreakComplete; onBreakComplete = nil
                cb?()
            }
        }

        let b = bounds
        let side = min(b.width, b.height)
        let center = CGPoint(x: b.midX, y: b.midY)
        let R = side / 2 * scale

        ctx.saveGState()

        // — a restrained halo: just enough to lift the seal off the field (the celebration is
        //   the break itself, not a standing glow) —
        ctx.setBlendMode(.plusLighter)
        drawBloom(ctx, center: center, radius: R * 1.6,
                  color: NotchPalette.accent.withAlphaComponent(0.20 * glow * contentAlpha))
        drawBloom(ctx, center: center, radius: R * 1.15,
                  color: NotchPalette.accentHi.withAlphaComponent(0.14 * glow * contentAlpha))
        ctx.setBlendMode(.normal)

        guard contentAlpha > 0.02 else { ctx.restoreGState(); return }

        // — dark-glass disc, top-lit —
        let discR = R * 0.72
        let disc = NSBezierPath(ovalIn: NSRect(x: center.x - discR, y: center.y - discR,
                                               width: discR * 2, height: discR * 2))
        ctx.saveGState()
        disc.addClip()
        let bodyGrad = notchGradient([
            (NSColor(srgbRed: 0.12, green: 0.15, blue: 0.30, alpha: contentAlpha), 0.0),
            (NSColor(srgbRed: 0.04, green: 0.05, blue: 0.11, alpha: contentAlpha), 1.0),
        ])
        ctx.drawLinearGradient(bodyGrad,
                               start: CGPoint(x: center.x, y: center.y + discR),
                               end: CGPoint(x: center.x, y: center.y - discR), options: [])
        // Dome sheen: a soft radial pool of light falling from above, clipped to the glass —
        // reads as curvature, not as a pasted-on shape.
        ctx.setBlendMode(.plusLighter)
        drawBloom(ctx, center: CGPoint(x: center.x, y: center.y + discR * 0.85),
                  radius: discR * 1.15, color: NSColor(white: 1, alpha: 0.12 * contentAlpha))
        ctx.setBlendMode(.normal)
        ctx.restoreGState()

        // — accent rim (two weights for depth) —
        disc.lineWidth = 1.5
        NotchPalette.accentHi.withAlphaComponent(0.9 * contentAlpha).setStroke()
        disc.stroke()
        let outerRing = NSBezierPath(ovalIn: NSRect(x: center.x - R * 0.92, y: center.y - R * 0.92,
                                                    width: R * 1.84, height: R * 1.84))
        outerRing.lineWidth = 1
        NotchPalette.accent.withAlphaComponent(0.35 * glow * contentAlpha).setStroke()
        outerRing.stroke()

        // — rim shimmer: a slow bright arc travelling the outer ring, so the seal reads as a
        //   lit object turning in aurora light rather than a static badge —
        if !reduceMotion, breakStart == nil {
            let angle = CGFloat((now - birth) * 0.5).truncatingRemainder(dividingBy: .pi * 2)
            ctx.saveGState()
            ctx.setBlendMode(.plusLighter)
            for (span, alpha, width) in [(CGFloat(0.9), 0.55, 2.2), (CGFloat(1.6), 0.22, 1.2)] {
                let arc = NSBezierPath()
                arc.appendArc(withCenter: center, radius: R * 0.92,
                              startAngle: (angle - span / 2) * 180 / .pi,
                              endAngle: (angle + span / 2) * 180 / .pi)
                arc.lineWidth = width
                arc.lineCapStyle = .round
                NotchPalette.accentHi.withAlphaComponent(alpha * glow * contentAlpha).setStroke()
                arc.stroke()
            }
            ctx.restoreGState()
        }

        // — orbit spark: one tiny comet circling the seal while it waits, trailing ghosts —
        if !reduceMotion, breakStart == nil {
            let oa = CGFloat(-(now - birth) * 0.8)
            ctx.saveGState()
            ctx.setBlendMode(.plusLighter)
            for i in 0..<4 {
                let trail = CGFloat(i) * 0.10
                let a = oa + trail
                let p = CGPoint(x: center.x + cos(a) * R * 0.92, y: center.y + sin(a) * R * 0.92)
                let fade = pow(1 - CGFloat(i) / 4, 2.0)
                let rad = (2.2 - CGFloat(i) * 0.4)
                if i == 0 {
                    drawBloom(ctx, center: p, radius: 7,
                              color: NotchPalette.accentHi.withAlphaComponent(0.7 * contentAlpha))
                }
                NSColor(white: 1, alpha: (0.95 * fade) * contentAlpha).setFill()
                NSBezierPath(ovalIn: NSRect(x: p.x - rad, y: p.y - rad, width: rad * 2, height: rad * 2)).fill()
            }
            ctx.restoreGState()
        }

        // — the gift glyph, plainly: this is a present, so it looks like one —
        if let glyph = notchTintedSymbol("gift.fill", pointSize: discR * 0.72, weight: .medium,
                                         color: NSColor(white: 1, alpha: 0.95)) {
            ctx.saveGState()
            let gs = glyph.size
            glyph.draw(in: NSRect(x: center.x - gs.width / 2,
                                  y: center.y - gs.height / 2,
                                  width: gs.width, height: gs.height),
                       from: .zero, operation: .sourceOver, fraction: contentAlpha)
            ctx.restoreGState()
        }

        ctx.restoreGState()
    }

    private func drawBloom(_ ctx: CGContext, center: CGPoint, radius: CGFloat, color: NSColor) {
        guard radius > 1, color.alphaComponent > 0.001 else { return }
        let space = CGColorSpace(name: CGColorSpace.sRGB)!
        let c = (color.usingColorSpace(.sRGB) ?? color)
        guard let grad = CGGradient(colorsSpace: space,
                                    colors: [c.cgColor, c.withAlphaComponent(0).cgColor] as CFArray,
                                    locations: [0, 1]) else { return }
        ctx.drawRadialGradient(grad, startCenter: center, startRadius: 0,
                               endCenter: center, endRadius: radius, options: [])
    }

    // MARK: Interaction
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let t = trackingAreaRef { removeTrackingArea(t) }
        let t = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                               owner: self, userInfo: nil)
        addTrackingArea(t)
        trackingAreaRef = t
    }
    override func mouseEntered(with event: NSEvent) { if breakStart == nil { hovering = true; NSCursor.pointingHand.set() } }
    override func mouseExited(with event: NSEvent) { hovering = false; pressed = false; NSCursor.arrow.set() }
    override func mouseDown(with event: NSEvent) { if breakStart == nil { pressed = true } }
    override func mouseDragged(with event: NSEvent) {
        pressed = breakStart == nil && bounds.contains(convert(event.locationInWindow, from: nil))
    }
    override func mouseUp(with event: NSEvent) {
        let inside = bounds.contains(convert(event.locationInWindow, from: nil))
        pressed = false
        if inside, breakStart == nil { onClick?() }
    }

    deinit { link?.invalidate() }
}
