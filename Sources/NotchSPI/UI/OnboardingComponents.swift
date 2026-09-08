import AppKit
import QuartzCore

// Small custom controls shared by the onboarding flow (and reusable elsewhere). All are pure
// AppKit in the codebase's house style: flipped where stacking matters, first-mouse friendly,
// drawn in draw(_:) so there is no layer ordering to fight. Motion rides Core Animation on the
// backing layer (transform springs, implicit morphs) so pixels never tear mid-gesture.

/// Reduce-Motion check for onboarding surfaces, with a DEBUG env override so visual QA can
/// verify the reduced experience without touching the user's system settings.
func onboardingReduceMotion() -> Bool {
    #if DEBUG
    if ProcessInfo.processInfo.environment["NSPI_QA_REDUCE_MOTION"] == "1" { return true }
    #endif
    return NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
}

// MARK: - Primary / secondary capsule button

/// A capsule action button on the dark aurora field. `.primary` is a flat accent fill that
/// brightens a step on hover; `.secondary` is a hairline glass outline; `.ghost` is bare text;
/// `.confirm` is a quiet green state chip (a settled fact, not a call to action — it doesn't
/// react, so it never fakes an affordance). No halos: elevation comes from color and motion.
final class GlowButton: NSControl {
    enum Style { case primary, secondary, ghost, confirm }

    var title: String { didSet { needsDisplay = true; invalidateIntrinsicContentSize() } }
    var style: Style {
        didSet {
            needsDisplay = true
            invalidateIntrinsicContentSize()
            window?.invalidateCursorRects(for: self)
        }
    }
    var onClick: (() -> Void)?

    private var hovering = false {
        didSet { if hovering != oldValue { needsDisplay = true } }
    }
    private var pressed = false {
        didSet { if pressed != oldValue { setDepressed(pressed) } }
    }
    private var trackingAreaRef: NSTrackingArea?

    init(title: String, style: Style = .primary, action: (() -> Void)? = nil) {
        self.title = title
        self.style = style
        self.onClick = action
        super.init(frame: .zero)
        wantsLayer = true
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var acceptsFirstResponder: Bool { isEnabled && isActionable }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { style == .confirm ? .staticText : .button }
    override func accessibilityLabel() -> String? { title }
    override func isAccessibilityEnabled() -> Bool { isEnabled }
    override func accessibilityPerformPress() -> Bool {
        guard isEnabled, isActionable, !isHiddenOrHasHiddenAncestor else { return false }
        onClick?()
        return true
    }
    override func keyDown(with event: NSEvent) {
        if [UInt16(36), 49, 76].contains(event.keyCode) { _ = accessibilityPerformPress() }
        else { super.keyDown(with: event) }
    }
    override func becomeFirstResponder() -> Bool { needsDisplay = true; return super.becomeFirstResponder() }
    override func resignFirstResponder() -> Bool { needsDisplay = true; return super.resignFirstResponder() }

    /// `.confirm` is state, not a control — no pointer, no press, no glow.
    private var isActionable: Bool { style != .confirm && isEnabled }

    private var titleFont: NSFont { .systemFont(ofSize: 13.5, weight: style == .primary ? .semibold : .medium) }

    override var intrinsicContentSize: NSSize {
        let s = (title as NSString).size(withAttributes: [.font: titleFont])
        let hPad: CGFloat = style == .ghost ? 10 : 22
        return NSSize(width: ceil(s.width) + hPad * 2, height: 34)
    }

    override func resetCursorRects() {
        if isActionable { addCursorRect(bounds, cursor: .pointingHand) }
    }

    // MARK: Motion (press spring on the backing layer)

    /// Press spring: squash around the button's own center (matrix-baked so the default AppKit
    /// anchor point can't drift it), release with a lively settle.
    private func setDepressed(_ down: Bool) {
        guard isActionable, let layer else { return }
        var m = CATransform3DIdentity
        if down {
            let c = CGPoint(x: bounds.midX, y: bounds.midY)
            m = CATransform3DTranslate(m, c.x, c.y, 0)
            m = CATransform3DScale(m, 0.955, 0.955, 1)
            m = CATransform3DTranslate(m, -c.x, -c.y, 0)
        }
        if onboardingReduceMotion() {
            layer.transform = m
            return
        }
        let s = CASpringAnimation(keyPath: "transform")
        s.fromValue = NSValue(caTransform3D: layer.presentation()?.transform ?? layer.transform)
        s.toValue = NSValue(caTransform3D: m)
        s.mass = 1
        s.stiffness = down ? 600 : 380
        s.damping = down ? 40 : 22
        s.duration = s.settlingDuration
        layer.transform = m
        layer.add(s, forKey: "press")
    }

    // MARK: Drawing

    override func draw(_ dirtyRect: NSRect) {
        let b = bounds
        let r = b.insetBy(dx: 1, dy: 1)
        let capsule = NSBezierPath(roundedRect: r, xRadius: r.height / 2, yRadius: r.height / 2)
        let textColor: NSColor

        switch style {
        case .primary:
            // Flat accent fill; hover lifts it one step toward the highlight tint. Color does
            // the work — no gradient body, no glow.
            let fill = hovering
                ? (NotchPalette.accent.blended(withFraction: 0.35, of: NotchPalette.accentHi) ?? NotchPalette.accent)
                : NotchPalette.accent
            fill.setFill()
            capsule.fill()
            textColor = NSColor(srgbRed: 0.04, green: 0.05, blue: 0.10, alpha: 1)
        case .secondary:
            NSColor(white: 1, alpha: hovering ? 0.12 : 0.06).setFill()
            capsule.fill()
            capsule.lineWidth = 1
            NSColor(white: 1, alpha: hovering ? 0.35 : 0.22).setStroke()
            capsule.stroke()
            textColor = NSColor(white: 1, alpha: 0.92)
        case .ghost:
            textColor = NSColor(white: 1, alpha: hovering ? 0.85 : 0.55)
        case .confirm:
            let mint = NSColor(srgbRed: 0.45, green: 0.85, blue: 0.60, alpha: 1)
            mint.withAlphaComponent(0.13).setFill()
            capsule.fill()
            capsule.lineWidth = 1
            mint.withAlphaComponent(0.45).setStroke()
            capsule.stroke()
            textColor = NSColor(srgbRed: 0.72, green: 0.95, blue: 0.80, alpha: 1)
        }

        let attrs: [NSAttributedString.Key: Any] = [.font: titleFont, .foregroundColor: textColor]
        let ts = (title as NSString).size(withAttributes: attrs)
        (title as NSString).draw(
            at: NSPoint(x: b.midX - ts.width / 2, y: b.midY - ts.height / 2), withAttributes: attrs)
        if window?.firstResponder === self {
            NSColor.keyboardFocusIndicatorColor.setStroke()
            capsule.lineWidth = 2
            capsule.stroke()
        }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let t = trackingAreaRef { removeTrackingArea(t) }
        let t = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                               owner: self, userInfo: nil)
        addTrackingArea(t)
        trackingAreaRef = t
    }

    override func mouseEntered(with event: NSEvent) { if isActionable { hovering = true } }
    override func mouseExited(with event: NSEvent) { hovering = false; pressed = false }
    override func mouseDown(with event: NSEvent) { if isActionable { pressed = true } }
    override func mouseDragged(with event: NSEvent) {
        pressed = isActionable && bounds.contains(convert(event.locationInWindow, from: nil))
    }
    override func mouseUp(with event: NSEvent) {
        let inside = bounds.contains(convert(event.locationInWindow, from: nil))
        pressed = false
        if inside { _ = accessibilityPerformPress() }
    }
}

// MARK: - Language pill (welcome page)

/// One selectable language pill. The page owns the exclusive-selection behavior; picking one
/// gives a small contented pop so the choice lands as a gesture, not a repaint.
final class LanguagePill: NSControl {
    let language: AppLanguage
    var isChosen = false {
        didSet {
            needsDisplay = true
            if isChosen, !oldValue { pop() }
            if isChosen != oldValue { NSAccessibility.post(element: self, notification: .valueChanged) }
        }
    }
    var onPick: ((AppLanguage) -> Void)?

    private var hovering = false { didSet { needsDisplay = true } }
    private var trackingAreaRef: NSTrackingArea?

    init(language: AppLanguage) {
        self.language = language
        super.init(frame: .zero)
        wantsLayer = true
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override var acceptsFirstResponder: Bool { isEnabled }
    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .radioButton }
    override func accessibilityLabel() -> String? { language.pickerLabel }
    override func accessibilityValue() -> Any? { isChosen ? 1 : 0 }
    override func isAccessibilityEnabled() -> Bool { isEnabled }
    override func accessibilityPerformPress() -> Bool {
        guard isEnabled, !isHiddenOrHasHiddenAncestor else { return false }
        onPick?(language)
        return true
    }
    override func keyDown(with event: NSEvent) {
        if [UInt16(36), 49, 76].contains(event.keyCode) { _ = accessibilityPerformPress() }
        else { super.keyDown(with: event) }
    }
    override func becomeFirstResponder() -> Bool { needsDisplay = true; return super.becomeFirstResponder() }
    override func resignFirstResponder() -> Bool { needsDisplay = true; return super.resignFirstResponder() }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .pointingHand) }

    override var intrinsicContentSize: NSSize {
        let s = (language.pickerLabel as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 12.5, weight: .medium)])
        return NSSize(width: ceil(s.width) + 30, height: 28)
    }

    private func pop() {
        guard !onboardingReduceMotion(), let layer else { return }
        let c = CGPoint(x: bounds.midX, y: bounds.midY)
        var up = CATransform3DIdentity
        up = CATransform3DTranslate(up, c.x, c.y, 0)
        up = CATransform3DScale(up, 1.06, 1.06, 1)
        up = CATransform3DTranslate(up, -c.x, -c.y, 0)
        let k = CAKeyframeAnimation(keyPath: "transform")
        k.values = [NSValue(caTransform3D: CATransform3DIdentity),
                    NSValue(caTransform3D: up),
                    NSValue(caTransform3D: CATransform3DIdentity)]
        k.keyTimes = [0, 0.4, 1]
        k.duration = 0.32
        k.timingFunctions = [CAMediaTimingFunction(name: .easeOut), CAMediaTimingFunction(name: .easeInEaseOut)]
        layer.add(k, forKey: "pop")
    }

    override func draw(_ dirtyRect: NSRect) {
        let r = bounds.insetBy(dx: 1, dy: 1)
        let capsule = NSBezierPath(roundedRect: r, xRadius: r.height / 2, yRadius: r.height / 2)
        if isChosen {
            NotchPalette.accent.withAlphaComponent(0.22).setFill()
            capsule.fill()
            capsule.lineWidth = 1
            NotchPalette.accentHi.withAlphaComponent(0.8).setStroke()
            capsule.stroke()
        } else {
            NSColor(white: 1, alpha: hovering ? 0.10 : 0.05).setFill()
            capsule.fill()
            capsule.lineWidth = 1
            NSColor(white: 1, alpha: 0.14).setStroke()
            capsule.stroke()
        }
        let color = isChosen ? NotchPalette.accentHi : NSColor(white: 1, alpha: 0.8)
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12.5, weight: .medium), .foregroundColor: color,
        ]
        let ts = (language.pickerLabel as NSString).size(withAttributes: attrs)
        (language.pickerLabel as NSString).draw(
            at: NSPoint(x: bounds.midX - ts.width / 2, y: bounds.midY - ts.height / 2), withAttributes: attrs)
        if window?.firstResponder === self {
            NSColor.keyboardFocusIndicatorColor.setStroke()
            let ring = NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 13, yRadius: 13)
            ring.lineWidth = 2
            ring.stroke()
        }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let t = trackingAreaRef { removeTrackingArea(t) }
        let t = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                               owner: self, userInfo: nil)
        addTrackingArea(t)
        trackingAreaRef = t
    }

    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }
    override func mouseUp(with event: NSEvent) {
        if bounds.contains(convert(event.locationInWindow, from: nil)) { _ = accessibilityPerformPress() }
    }
}

// MARK: - Keycap chip

/// A hotkey rendered as physical keycaps (one cap per symbol) in the product's own material:
/// indigo glass, top-lit, hairline rim, seated by a tight shadow — the visual language of a
/// real keyboard in this world's palette, so "press this" needs no words.
final class KeycapChipView: NSView {
    var keys: [String] { didSet { needsDisplay = true; invalidateIntrinsicContentSize() } }
    var capSize: CGFloat

    init(keys: [String], capSize: CGFloat = 40) {
        self.keys = keys
        self.capSize = capSize
        super.init(frame: .zero)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private var gap: CGFloat { capSize * 0.22 }

    override var intrinsicContentSize: NSSize {
        let n = CGFloat(keys.count)
        return NSSize(width: n * capSize + max(0, n - 1) * gap, height: capSize + 6)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let radius = capSize * 0.24
        var x: CGFloat = 0
        for key in keys {
            let r = NSRect(x: x, y: 3, width: capSize, height: capSize)
            let path = NSBezierPath(roundedRect: r, xRadius: radius, yRadius: radius)

            // tight drop shadow seating the cap on the glass
            ctx.saveGState()
            ctx.setShadow(offset: CGSize(width: 0, height: -1.5), blur: 3,
                          color: NSColor.black.withAlphaComponent(0.45).cgColor)
            NSColor(srgbRed: 0.10, green: 0.12, blue: 0.22, alpha: 1).setFill()
            path.fill()
            ctx.restoreGState()

            // top-lit indigo-glass face (the world's material, not neutral gray)
            NSGradient(starting: NSColor(srgbRed: 0.21, green: 0.24, blue: 0.40, alpha: 1),
                       ending: NSColor(srgbRed: 0.11, green: 0.13, blue: 0.25, alpha: 1))?
                .draw(in: path, angle: -90)

            // upper-edge highlight: light falls from above
            ctx.saveGState()
            path.addClip()
            let hi = notchGradient([
                (NSColor(white: 1, alpha: 0.20), 0),
                (NSColor(white: 1, alpha: 0.0), 1),
            ])
            ctx.drawLinearGradient(hi, start: CGPoint(x: r.midX, y: r.maxY),
                                   end: CGPoint(x: r.midX, y: r.maxY - capSize * 0.45), options: [])
            ctx.restoreGState()

            path.lineWidth = 1
            NSColor(white: 1, alpha: 0.17).setStroke()
            path.stroke()

            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: capSize * 0.45, weight: .medium),
                .foregroundColor: NSColor(white: 1, alpha: 0.95),
            ]
            let ts = (key as NSString).size(withAttributes: attrs)
            (key as NSString).draw(
                at: NSPoint(x: r.midX - ts.width / 2, y: r.midY - ts.height / 2), withAttributes: attrs)
            x += capSize + gap
        }
    }

    /// Split a display string like "⌘⇧1" or "⌘⇧Space" into per-cap symbols: leading modifier
    /// glyphs each get their own cap, and whatever remains is the key label.
    static func caps(from combo: HotkeyCombo) -> [String] {
        var out: [String] = []
        var label = Settings.displayString(combo)
        while let first = label.first, ["⌃", "⌥", "⇧", "⌘"].contains(String(first)) {
            out.append(String(first))
            label.removeFirst()
        }
        if !label.isEmpty { out.append(label) }
        return out
    }
}

// MARK: - Step dots

/// The onboarding progress indicator. Each dot is its own CALayer; changing `current` morphs
/// the lozenge fluidly from one station to the next (width, position, and tint all glide on a
/// gentle overshoot curve) instead of teleporting.
final class StepDotsView: NSView {
    var count: Int = 5 { didSet { if count != oldValue { rebuildLayers() } } }
    var current: Int = 0 { didSet { if current != oldValue { applyLayout(animated: !onboardingReduceMotion()) } } }

    private var dotLayers: [CALayer] = []

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        rebuildLayers()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override var intrinsicContentSize: NSSize {
        NSSize(width: CGFloat(count - 1) * 16 + 22, height: 6)
    }

    private func frames() -> [CGRect] {
        var x: CGFloat = 0
        var out: [CGRect] = []
        for i in 0..<count {
            let w: CGFloat = i == current ? 22 : 6
            out.append(CGRect(x: x, y: bounds.midY - 3, width: w, height: 6))
            x += w + 10
        }
        return out
    }

    private func rebuildLayers() {
        guard let host = layer else { return }
        dotLayers.forEach { $0.removeFromSuperlayer() }
        dotLayers = (0..<count).map { _ in
            let l = CALayer()
            l.cornerRadius = 3
            host.addSublayer(l)
            return l
        }
        applyLayout(animated: false)
    }

    override func layout() {
        super.layout()
        applyLayout(animated: false)
    }

    private func applyLayout(animated: Bool) {
        let fs = frames()
        guard fs.count == dotLayers.count else { return }
        CATransaction.begin()
        if animated {
            CATransaction.setAnimationDuration(0.40)
            CATransaction.setAnimationTimingFunction(CAMediaTimingFunction(controlPoints: 0.22, 1.12, 0.30, 1))
        } else {
            CATransaction.setDisableActions(true)
        }
        for (i, l) in dotLayers.enumerated() {
            l.frame = fs[i]
            l.backgroundColor = (i == current ? NotchPalette.accentHi : NSColor(white: 1, alpha: 0.22)).cgColor
        }
        CATransaction.commit()
    }
}
