import AppKit
import Combine
import QuartzCore

/// The notch's content, in pure AppKit — and the single clock that moves it.
///
/// One body, one clock: the panel FRAME, the slab radii, the light field and the content staging
/// are all driven from the same display-link morph (`geoMorph`), so nothing can drift apart the
/// way a window-server animation and a view tween can. Three ideas carry the design:
///
///  1. **One rose.** The signature indicator never crossfades or duplicates: the same
///     `RoseLoaderView` glides and rescales between its menu-bar pose and its header pose,
///     riding the slab's leading edge — a shared-element transition, not two ghosts.
///  2. **A content plate.** The expanded header + answer are laid out ONCE at their final size
///     and clipped to the slab's path with a layer mask. Mid-morph the slab's edges *reveal*
///     finished content — text never re-wraps, the status line never re-truncates, and no
///     scroller flashes while the card is still growing.
///  3. **Springs for streaming.** The panel's line-by-line growth and the follow-bottom scroll
///     ride retargetable critically-damped springs, so arriving tokens pour the card open in one
///     continuous glide instead of a staircase of `setFrame` jumps.
final class NotchView: NSView {
    var onExplanation: (() -> Void)?
    var onAddMaterial: (() -> Void)?
    var onNewGroup: (() -> Void)?
    var onSelectRegion: (() -> Void)?
    var onRemoveMaterial: ((UUID) -> Void)?
    private let materialStrip = QuestionMaterialStrip()

    private let model: TutorModel
    private let onHover: (Bool) -> Void
    private let onCycleDepth: () -> Void
    private let onEditPersona: () -> Void
    private let onSettings: () -> Void
    private let onToggleReasoning: () -> Void
    private let onCopyAnswer: () -> Void
    private let onStopAuto: () -> Void
    /// Supplies the CURRENT collapsed/expanded panel frames (screen coords). Geometry stays owned
    /// by the controller; this view owns the clock that travels between the two.
    private let frameProvider: (Bool) -> NSRect

    // Surface (fills the whole panel incl. the transparent shadow margin).
    private let surface = NotchSurfaceView()
    // Interior light field (Metal) — the obsidian's living light, between body and content.
    private let luma = NotchLumaView()
    private var lastAnswerLen = 0
    private var followBottom = false
    private var userDetached = false   // the user scrolled up to read; never yank them back down

    /// The one persistent rose (see note 1 above). Floats above the content plate, unmasked.
    private let rose = RoseLoaderView()

    // Expanded content plate (see note 2 above).
    private let expandedContent = FlippedContainer()
    private let contentMask = CAShapeLayer()
    private let modeLabel = NotchView.makeLabel(size: 12.5, weight: .semibold, color: NotchPalette.primary)
    private let statusText = NotchView.makeLabel(size: 11, weight: .regular, color: NotchPalette.secondary)
    private let capsule = NotchCapsuleButton()
    private lazy var gearButton = NotchControlButton(
        systemName: "gearshape", tint: NotchPalette.secondary, label: L10n.settingsTitle,
        action: { [weak self] in self?.onSettings() })
    private let answerScroll = FollowScrollView()
    private let answerStream = StreamingAnswerView()
    /// Top-edge dissolve for scrolled answers: once the text scrolls under the header it fades
    /// out over ~16pt instead of being guillotined mid-glyph. Strength follows the offset, so an
    /// unscrolled answer keeps its first line at full ink.
    private let scrollFade = CAGradientLayer()

    private lazy var morph = DisplayTween(host: self, value: 0)
    /// Geometry channel: expanding overshoots (soft spring) while `morph` (opacity/staging)
    /// stays a clamped out-cubic. They MUST be separate — a spring on opacity would flash the
    /// content past full mid-landing.
    private lazy var geoMorph = DisplayTween(host: self, value: 0)

    // Frame anchors for the morph lerp. Re-anchored to the live window frame at each morph start
    // so a reversal or a mid-stream height change can never cause a frame jump.
    private var collapsedAnchor: NSRect = .zero
    private var expandedAnchor: NSRect = .zero

    // Streaming springs (see note 3 above), stepped by one shared ticker.
    private lazy var ticker = NotchTicker(host: self)
    private var heightSpring = CriticalSpring()
    private var scrollSpring = CriticalSpring()

    private var wasExpanded = false
    private var lastPlateSize = CGSize.zero
    private var hovering = false
    private var trackingAreaRef: NSTrackingArea?
    private var cancellables = Set<AnyCancellable>()

    private var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

    init(model: TutorModel,
         frameProvider: @escaping (Bool) -> NSRect,
         onHover: @escaping (Bool) -> Void,
         onCycleDepth: @escaping () -> Void,
         onEditPersona: @escaping () -> Void,
         onSettings: @escaping () -> Void,
         onToggleReasoning: @escaping () -> Void,
         onCopyAnswer: @escaping () -> Void,
         onStopAuto: @escaping () -> Void) {
        self.model = model
        self.frameProvider = frameProvider
        self.onHover = onHover
        self.onCycleDepth = onCycleDepth
        self.onEditPersona = onEditPersona
        self.onSettings = onSettings
        self.onToggleReasoning = onToggleReasoning
        self.onCopyAnswer = onCopyAnswer
        self.onStopAuto = onStopAuto
        super.init(frame: .zero)
        build()
        observe()
        refresh()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var isFlipped: Bool { true }

    // MARK: Build

    private func build() {
        addSubview(surface)
        addSubview(luma)

        // The header carries the wordmark, not a category name — fixed "NotchSPI" in every mode
        // and language (the capsule + status line already say what the instrument is doing).
        // A breath of tracking matches the onboarding's brand moment.
        modeLabel.attributedStringValue = NSAttributedString(string: "NotchSPI", attributes: [
            .font: NSFont.systemFont(ofSize: 12.5, weight: .semibold),
            .foregroundColor: NotchPalette.primary,
            .kern: 0.5,
        ])

        configureAnswerArea()
        [modeLabel, statusText, capsule, gearButton, answerScroll, materialStrip].forEach { expandedContent.addSubview($0) }
        expandedContent.wantsLayer = true
        expandedContent.layer?.mask = contentMask
        addSubview(expandedContent)
        expandedContent.alphaValue = 0

        addSubview(rose)   // above the plate; decorative, never intercepts clicks

        // The capsule dispatches by the active mode: stop (auto session) / cycle depth (tutor)
        // / edit persona (personality). Auto wins — while a session is live the capsule IS
        // the panel's stop button.
        capsule.onClick = { [weak self] in
            guard let self else { return }
            if self.model.autoActive { self.onStopAuto() }
            else if self.model.mode == "personality" { self.onEditPersona() }
            else { self.onCycleDepth() }
        }

        morph.onChange = { [weak self] _ in self?.applyLayout() }
        geoMorph.onChange = { [weak self] g in
            self?.applyMorphFrame(g)
            self?.applyLayout()
        }
        ticker.onTick = { [weak self] dt in self?.springTick(dt) }
    }

    private func configureAnswerArea() {
        answerScroll.drawsBackground = false
        answerScroll.hasVerticalScroller = true
        answerScroll.autohidesScrollers = true
        answerScroll.scrollerStyle = .overlay
        answerScroll.borderType = .noBorder
        answerScroll.horizontalScrollElasticity = .none
        answerScroll.documentView = answerStream
        materialStrip.onExplain = { [weak self] in self?.onExplanation?() }
        materialStrip.onAdd = { [weak self] in self?.onAddMaterial?() }
        materialStrip.onClear = { [weak self] in self?.onNewGroup?() }
        materialStrip.onSelect = { [weak self] in self?.onSelectRegion?() }
        materialStrip.onRemove = { [weak self] id in self?.onRemoveMaterial?(id) }
        answerStream.onToggleReasoning = { [weak self] in self?.onToggleReasoning() }
        answerStream.canCopyAnswer = { [weak self] in
            guard let self else { return false }
            return self.model.mode != "personality" && self.model.resultState != .retake
                && self.model.status != .running && self.model.status != .streaming
                && AnswerComposer.clipboardAnswer(self.model.answer) != nil
        }
        answerStream.onCopyAnswer = { [weak self] in self?.onCopyAnswer() }
        answerScroll.onUserScroll = { [weak self] in self?.noteUserScroll() }
        answerScroll.wantsLayer = true
        answerScroll.layer?.mask = scrollFade
    }

    private func observe() {
        // Any model change → refresh content + re-evaluate the morph after @Published commits.
        model.objectWillChange
            .sink { [weak self] in DispatchQueue.main.async { self?.refresh() } }
            .store(in: &cancellables)
    }

    // MARK: Refresh (content from model)

    private func refresh() {
        let tint = roseTint()
        let busy = model.status == .running || model.status == .streaming
        rose.color = tint; rose.busy = busy

        luma.setState(model.status)
        // Streaming token arrival → one ripple through the light field.
        if model.status == .streaming, model.answer.count > lastAnswerLen { luma.pulse() }
        lastAnswerLen = model.answer.count

        materialStrip.isHidden = !model.showMaterialStrip
        if model.showMaterialStrip { materialStrip.update(model.materials, explanationAvailable: model.explanationAvailable) }
        statusText.stringValue = model.statusText
        statusText.textColor = model.resultState == .review
            ? NSColor(calibratedRed: 0.95, green: 0.66, blue: 0.20, alpha: 1)
            : NotchPalette.secondary

        let isPersona = model.mode == "personality"
        capsule.title = model.autoActive
            ? L10n.autoStopCapsule(model.autoProgress)
            : isPersona
                ? (model.personaLabel.isEmpty ? L10n.t("设置人物像", "人物像を設定", "Set persona") : model.personaLabel)
                : model.depthLabel

        let attr = NotchType.answerString(model.renderedAnswer, presentation: NotchType.presentation(for: model))
        answerStream.setAnswer(attr, isPlaceholder: model.answer.isEmpty)
        // While streaming, keep the newest text in view (a long answer scrolls within its region).
        if model.status == .streaming { followBottom = true }
        else if model.status != .running { followBottom = false }
        if model.answer.isEmpty {
            // A new turn resets the reading position instantly — no smooth scroll to the top.
            scrollSpring.snap(0)
            scrollTo(0)
            userDetached = false
        }

        if model.expanded != wasExpanded { beginMorph(model.expanded) }

        // Content (labels, capsule, answer length) may have changed — re-lay the plate.
        if lastPlateSize != .zero { layoutPlate(lastPlateSize) }
        applyLayout()
        updateFollow()
    }

    /// Rose tint by state — white at rest (no "camera-in-use" green dot), accent while working,
    /// red on error. Mirrors the original SwiftUI `roseColor`.
    private func roseTint() -> NSColor {
        switch model.status {
        case .running, .streaming: return NotchPalette.accent
        case .error: return NotchPalette.error
        default: return .white
        }
    }

    // MARK: Morph (one clock: frame + styling)

    private func beginMorph(_ on: Bool) {
        wasExpanded = on
        let current = window?.frame ?? .zero
        if on {
            if geoMorph.value <= 0.001, current.width > 0 { collapsedAnchor = current }
            else if collapsedAnchor.width <= 0 { collapsedAnchor = frameProvider(false) }
            expandedAnchor = frameProvider(true)
        } else {
            if geoMorph.value >= 0.999, current.width > 0 { expandedAnchor = current }
            collapsedAnchor = frameProvider(false)
        }
        // The morph owns the frame now — quiesce the streaming springs at today's reality.
        ticker.pause()
        heightSpring.snap(current.height)

        let target: CGFloat = on ? 1 : 0
        if reduceMotion {
            morph.set(target); geoMorph.set(target)
        } else {
            morph.animate(to: target, duration: NotchPalette.morphDuration)
            geoMorph.ease = on ? NotchMotion.springSettle : NotchMotion.outCubic
            geoMorph.animate(to: target, duration: NotchPalette.morphDuration)
        }
    }

    private func applyMorphFrame(_ g: CGFloat) {
        guard collapsedAnchor.width > 0, expandedAnchor.width > 0, let window else { return }
        window.setFrame(notchLerpRect(collapsedAnchor, expandedAnchor, max(0, g)), display: true)
    }

    /// The expanded target grew or shrank (answer streaming in, font/size change). While the
    /// morph is in flight the frame lerp retargets naturally; once settled, the height spring
    /// carries the frame — line-by-line growth becomes one continuous glide.
    func retargetExpandedFrame(_ f: NSRect) {
        expandedAnchor = f
        guard wasExpanded, !geoMorph.isAnimating, let window else { return }
        if reduceMotion {
            window.setFrame(f, display: true)
            return
        }
        if heightSpring.settled { heightSpring.snap(window.frame.height) }
        heightSpring.target = f.height
        if !heightSpring.settled { ticker.start() }
    }

    private func springTick(_ dt: CFTimeInterval) {
        var active = false
        if !heightSpring.settled {
            heightSpring.step(dt)
            if let window {
                let h = max(1, heightSpring.value)
                window.setFrame(NSRect(x: expandedAnchor.minX, y: expandedAnchor.maxY - h,
                                       width: expandedAnchor.width, height: h), display: true)
            }
            active = true
        }
        if followBottom && !userDetached { scrollSpring.target = maxScrollOffset() }
        if !scrollSpring.settled {
            scrollSpring.step(dt)
            scrollTo(scrollSpring.value)
            active = true
        }
        if !active { ticker.pause() }
    }

    // MARK: Follow-bottom scroll

    private func maxScrollOffset() -> CGFloat {
        max(0, answerStream.frame.height - answerScroll.contentView.bounds.height)
    }

    private func scrollTo(_ y: CGFloat) {
        answerScroll.contentView.setBoundsOrigin(NSPoint(x: 0, y: max(0, y)))
        answerScroll.reflectScrolledClipView(answerScroll.contentView)
        updateScrollFade()
    }

    private func updateScrollFade() {
        let h = answerScroll.frame.height
        guard h > 1 else { return }
        let off = answerScroll.contentView.bounds.origin.y
        let top = max(0, min(1, off / 12))                        // dissolved after 12pt of scroll
        // "More below" dissolve — suppressed while auto-following so newborn glyphs stay crisp
        // (the follow spring trails the tail by a few points; fading there would shimmer).
        let bottom = followBottom && !userDetached
            ? 0 : max(0, min(1, (maxScrollOffset() - off) / 12))
        let fade = NSNumber(value: Double(min(0.5, 16 / h)))
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        scrollFade.frame = answerScroll.bounds
        scrollFade.startPoint = CGPoint(x: 0.5, y: 0)
        scrollFade.endPoint = CGPoint(x: 0.5, y: 1)
        scrollFade.colors = [
            NSColor.white.withAlphaComponent(1 - top).cgColor,
            NSColor.white.cgColor,
            NSColor.white.cgColor,
            NSColor.white.withAlphaComponent(1 - bottom).cgColor,
        ]
        scrollFade.locations = [0, fade, NSNumber(value: 1 - fade.doubleValue), 1]
        CATransaction.commit()
    }

    private func updateFollow() {
        guard wasExpanded, followBottom, !userDetached else { return }
        let target = maxScrollOffset()
        if reduceMotion {
            scrollSpring.snap(target)
            scrollTo(target)
            return
        }
        if abs(target - scrollSpring.target) > 0.5 || !scrollSpring.settled {
            if scrollSpring.settled { scrollSpring.snap(answerScroll.contentView.bounds.origin.y) }
            scrollSpring.target = target
            if !scrollSpring.settled { ticker.start() }
        }
    }

    private func noteUserScroll() {
        let y = answerScroll.contentView.bounds.origin.y
        scrollSpring.snap(y)                             // never fight the user's hand
        userDetached = y < maxScrollOffset() - 12        // back at the tail → follow re-engages
        updateScrollFade()
    }

    // MARK: Layout (morph-driven)

    override func layout() {
        super.layout()
        applyLayout()
    }

    private func applyLayout() {
        let b = bounds
        guard b.width > 1 else { return }
        // p: opacity / staging — clamped (a reveal must never invert).
        // g: geometry — may overshoot past 1 (soft frame spring, ~4.7% peak).
        //    Radii re-amplify the overshoot (gr): 4.7% of an 8pt shoulder is invisible; ×6 makes
        //    the corners visibly soften-then-settle as the body lands.
        let p = max(0, min(1, morph.value))
        let g = max(0, geoMorph.value)
        let gr = g <= 1 ? g : 1 + (g - 1) * 6

        // Card inset: the transparent shadow margin grows in only as we expand (top stays flush).
        let mH = NotchMetrics.shadowMarginH * g
        let mB = NotchMetrics.shadowMarginBottom * g
        let card = CGRect(x: mH, y: 0, width: b.width - mH * 2, height: b.height - mB)

        surface.frame = b
        surface.cardRect = card
        surface.topRadius = notchLerp(6, 8, gr)
        surface.bottomRadius = notchLerp(14, 22, gr)
        surface.depth = p
        surface.shadowStrength = p

        luma.frame = b
        luma.setSlab(cardRect: card, topRadius: notchLerp(6, 8, gr),
                     bottomRadius: notchLerp(14, 22, gr), depth: p)

        layoutRose(card: card, g: g)
        layoutContentPlate(card: card, p: p)
    }

    /// The rose's two poses share a center-x of 24pt from the card's left edge, so the morph is a
    /// glide along the leading edge plus a gentle 20→16pt rescale and a 1.5pt vertical settle.
    private func layoutRose(card: CGRect, g: CGFloat) {
        let t = max(0, min(g, 1.1))
        let barH = collapsedAnchor.height > 0 ? collapsedAnchor.height : bounds.height
        let cy = notchLerp(barH / 2, NotchLayout.headerRowCenterY, t)
        let size = notchLerp(20, 16, t)
        rose.frame = CGRect(x: card.minX + 24 - size / 2, y: cy - size / 2, width: size, height: size)
    }

    private func layoutContentPlate(card: CGRect, p: CGFloat) {
        guard expandedAnchor.width > 0 else { expandedContent.isHidden = true; return }
        let plateSize = CGSize(width: expandedAnchor.width - NotchMetrics.shadowMarginH * 2,
                               height: expandedAnchor.height - NotchMetrics.shadowMarginBottom)
        if plateSize != lastPlateSize {
            lastPlateSize = plateSize
            layoutPlate(plateSize)
        }
        expandedContent.frame = CGRect(origin: card.origin, size: plateSize)

        // Staging: the slab leads, the content follows — in by ~half the morph on the way out of
        // the notch, and gone in the first exhale of a collapse.
        let ca = notchRamp(p, 0.38, 0.88)
        expandedContent.alphaValue = ca
        expandedContent.isHidden = ca <= 0.001

        // Clip the plate to the slab so mid-morph content ends at the obsidian's edge, never past it.
        if !expandedContent.isHidden {
            let path = NotchShape.cgPath(in: card, topRadius: surface.topRadius,
                                         bottomRadius: surface.bottomRadius)
            var shift = CGAffineTransform(translationX: -card.minX, y: -card.minY)
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            contentMask.path = path.copy(using: &shift)
            CATransaction.commit()
        }
    }

    /// Lay the plate at its FINAL size — called when the target size or the content changes,
    /// never per morph tick, so the CTFramesetter cache stays warm and nothing re-wraps.
    private func layoutPlate(_ size: CGSize) {
        let inset = NotchLayout.contentInsetH
        let cy = NotchLayout.headerRowCenterY

        let gearX = size.width - inset - 28
        gearButton.frame = CGRect(x: gearX, y: cy - 12, width: 28, height: 24)

        let cap = capsule.intrinsicContentSize
        let capX = gearX - 8 - cap.width
        capsule.frame = CGRect(x: capX, y: cy - cap.height / 2, width: cap.width, height: cap.height)

        var x = inset + 16 + 8   // leave the rose's slot clear (it floats above the plate)
        // Size the label by asking its cell (NSString measurement misses the cell's own
        // horizontal padding, which clipped "学习辅导" to "学习…" in the header).
        let modeW = ceil(modeLabel.sizeThatFits(
            NSSize(width: 300, height: 24)).width) + 4
        let modeH = modeLabel.intrinsicContentSize.height
        modeLabel.frame = CGRect(x: x, y: cy - modeH / 2, width: modeW, height: modeH)
        x += modeW + 6
        let statusW = max(0, capX - 8 - x)
        let statusH = statusText.intrinsicContentSize.height
        statusText.frame = CGRect(x: x, y: cy - statusH / 2, width: statusW, height: statusH)

        // Answer fills below the header; the panel height is sized by the controller, so a long
        // answer scrolls within this fixed region and a short one hugs it.
        let stripHeight: CGFloat = model.showMaterialStrip ? 74 : 0
        materialStrip.frame = CGRect(x: inset, y: NotchLayout.headerHeight, width: size.width - inset * 2, height: stripHeight)
        let top = NotchLayout.headerHeight + stripHeight
        let h = max(0, size.height - top - NotchLayout.answerBottomPad)
        let w = max(0, size.width - inset * 2)
        answerScroll.frame = CGRect(x: inset, y: top, width: w, height: h)

        // The streaming view is the scroll's documentView, sized to the FULL content height so a
        // long answer scrolls; the CTFramesetter measure matches what it draws.
        let docH = max(h, NotchType.answerHeight(model.renderedAnswer,
                                                 presentation: NotchType.presentation(for: model), width: w))
        answerStream.frame = CGRect(x: 0, y: 0, width: w, height: docH)
        updateScrollFade()
    }

    #if DEBUG
    /// Visual-QA: post a REAL mouse-down/up pair through the window at the reasoning toggle's
    /// center, so the whole event chain (panel hit-test → scroll view → StreamingAnswerView
    /// coordinate math) is exercised — not just the callback.
    func qaClickReasoningToggle() {
        guard let window, let rect = answerStream.qaReasoningToggleRect() else {
            fputs("[NotchSPI] QA: no reasoning toggle on screen\n", stderr)
            return
        }
        let inWindow = answerStream.convert(CGPoint(x: rect.midX, y: rect.midY), to: nil)
        fputs("[NotchSPI] QA: toggle rect \(rect) → window point \(inWindow), hit = "
              + String(describing: hitTest(convert(inWindow, from: nil))) + "\n", stderr)
        for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
            if let e = NSEvent.mouseEvent(
                with: type, location: inWindow, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) {
                window.sendEvent(e)
            }
        }
    }
    #endif

    // MARK: Hover

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let t = trackingAreaRef { removeTrackingArea(t) }
        let t = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                               owner: self, userInfo: nil)
        addTrackingArea(t)
        trackingAreaRef = t
    }

    override func mouseEntered(with event: NSEvent) { setHovering(true) }
    override func mouseExited(with event: NSEvent) { setHovering(false) }

    private func setHovering(_ on: Bool) {
        guard hovering != on else { return }
        hovering = on
        onHover(on)
    }

    // MARK: Factories

    private static func makeLabel(size: CGFloat, weight: NSFont.Weight, color: NSColor) -> NSTextField {
        let f = NSTextField(labelWithString: "")
        f.font = .systemFont(ofSize: size, weight: weight)
        f.textColor = color
        f.backgroundColor = .clear
        f.drawsBackground = false
        f.isBordered = false
        f.isEditable = false
        f.lineBreakMode = .byTruncatingTail
        f.cell?.truncatesLastVisibleLine = true
        return f
    }
}

// MARK: - Containers

/// A top-left-origin container so child frames laid out with `y` growing downward match the
/// flipped `NotchView` (a plain NSView is bottom-left, which would invert the stacked rows).
private final class FlippedContainer: NSView {
    override var isFlipped: Bool { true }
}

// MARK: - Follow scroll view

/// The answer scroller — reports user-initiated scrolls so the auto-follow can yield to a
/// reading user (scroll up to detach; return to the tail to re-engage).
private final class FollowScrollView: NSScrollView {
    var onUserScroll: (() -> Void)?
    override func scrollWheel(with event: NSEvent) {
        super.scrollWheel(with: event)
        onUserScroll?()
    }
}

// MARK: - Capsule button

/// The header pill — shows the depth (tutor mode) or the persona name (personality mode) and acts
/// on click. A soft white capsule that brightens on hover; first-mouse so it works inside the
/// non-activating panel.
private final class NotchCapsuleButton: NSControl {
    var onClick: (() -> Void)?
    var title: String = "" {
        didSet {
            guard title != oldValue else { return }
            let previous = attr
            attr = NSAttributedString(string: title, attributes: [
                .font: NSFont.systemFont(ofSize: 11),
                .foregroundColor: NotchPalette.secondary,
            ])
            setAccessibilityLabel(title)
            invalidateIntrinsicContentSize()
            // Cycling the depth rolls the label like a station indicator — old value yields
            // upward, the new one rises into place. First fill and Reduce Motion just repaint.
            if !oldValue.isEmpty, window != nil,
               !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
                prevAttr = previous
                if rollTween == nil {
                    rollTween = DisplayTween(host: self, value: 1)
                    rollTween?.onChange = { [weak self] t in
                        self?.needsDisplay = true
                        if t >= 1 { self?.prevAttr = nil }
                    }
                }
                rollTween?.set(0)
                rollTween?.animate(to: 1, duration: 0.28)
            } else {
                needsDisplay = true
            }
        }
    }

    private var attr = NSAttributedString()
    private var prevAttr: NSAttributedString?
    private var rollTween: DisplayTween?
    private let hPad: CGFloat = 8, vPad: CGFloat = 3
    private var hovering = false { didSet { if hovering != oldValue { needsDisplay = true } } }
    private var trackingAreaRef: NSTrackingArea?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var isFlipped: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override var intrinsicContentSize: NSSize {
        let s = attr.size()
        return NSSize(width: ceil(s.width) + hPad * 2, height: ceil(s.height) + vPad * 2)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let r = bounds
        let radius = r.height / 2
        let cap = NSBezierPath(roundedRect: r, xRadius: radius, yRadius: radius)
        NSColor(white: 1, alpha: hovering ? 0.16 : 0.10).setFill()
        cap.fill()

        // Text clipped to the capsule so the roll reads as a wheel inside the pill.
        ctx.saveGState()
        cap.addClip()
        let t = prevAttr != nil ? max(0, min(1, rollTween?.value ?? 1)) : 1
        let rise: CGFloat = 7
        let s = attr.size()
        let newOrigin = CGPoint(x: (r.width - s.width) / 2,
                                y: (r.height - s.height) / 2 + (1 - t) * rise)
        if let prev = prevAttr, t < 1 {
            let ps = prev.size()
            drawFaded(prev, at: CGPoint(x: (r.width - ps.width) / 2,
                                        y: (r.height - ps.height) / 2 - t * rise), alpha: 1 - t)
            drawFaded(attr, at: newOrigin, alpha: t)
        } else {
            attr.draw(at: newOrigin)
        }
        ctx.restoreGState()
    }

    private func drawFaded(_ string: NSAttributedString, at point: CGPoint, alpha: CGFloat) {
        let m = NSMutableAttributedString(attributedString: string)
        m.enumerateAttribute(.foregroundColor, in: NSRange(location: 0, length: m.length)) { v, range, _ in
            let c = (v as? NSColor) ?? NotchPalette.secondary
            m.addAttribute(.foregroundColor, value: c.withAlphaComponent(c.alphaComponent * alpha),
                           range: range)
        }
        m.draw(at: point)
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
        let p = convert(event.locationInWindow, from: nil)
        if bounds.contains(p) { onClick?() }
    }

    override func accessibilityPerformPress() -> Bool {
        onClick?()
        return true
    }
}
