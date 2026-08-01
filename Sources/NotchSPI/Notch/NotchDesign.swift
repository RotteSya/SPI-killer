import AppKit
import QuartzCore

// The notch design system, in pure AppKit (ported from the notchmeet reference). The notch is a
// single piece of machined obsidian that *lives* in the physical cutout and grows out of it.
// Collapsed, it fuses with the hardware notch (pure black at the top seam). Expanded, its lower
// face catches a whisper of the screen's light along a hairline edge, with a faint internal
// volume — never a flat black decal. The slab is drawn with Core Graphics inside a flipped
// `NotchSurfaceView`, so geometry math stays top-left (y down) exactly as the SwiftUI `Shape` was.

// MARK: - Palette

enum NotchPalette {
    /// Pure black at the seam so the slab fuses with the physical notch; volume is added by
    /// `NotchSurfaceView`, not by lightening this base.
    static let background = NSColor.black

    static let primary   = NSColor(white: 1, alpha: 0.96)
    static let secondary = NSColor(white: 1, alpha: 0.60)
    static let tertiary  = NSColor(white: 1, alpha: 0.34)

    /// The user's chosen accent theme (外观 → 强调色), flowing through the whole instrument.
    /// Reads a cached theme — safe to call from every draw.
    static var accent: NSColor { Appearance.theme.accent }
    static var accentHi: NSColor { Appearance.theme.accentHi }

    /// Warm red for the error state.
    static let error     = NSColor(srgbRed: 0.97, green: 0.32, blue: 0.29, alpha: 1)

    /// Cool, near-white with a breath of brand blue — screen light on glass, for the lower-face sheen.
    static let sheen     = NSColor(srgbRed: 0.80, green: 0.86, blue: 1.00, alpha: 1)

    static let rule      = NSColor(white: 1, alpha: 0.10)

    // Motion durations (s). The single morph time is shared by the controller's panel-frame
    // animation and the view's radius/content tween, so the whole instrument moves as one body.
    static let morphDuration: CFTimeInterval = {
        #if DEBUG
        // Visual QA: NSPI_SLOW_MORPH=1 stretches the morph to 2.4s for frame-by-frame inspection.
        if ProcessInfo.processInfo.environment["NSPI_SLOW_MORPH"] == "1" { return 2.4 }
        #endif
        return 0.32
    }()
    static let contentDuration: CFTimeInterval = 0.18
    static let controlDuration: CFTimeInterval = 0.13
}

/// Shared easing curves for the expand/collapse morph.
enum NotchMotion {
    /// Under-damped spring settle for EXPANDING. This curve now drives the PANEL FRAME itself
    /// (not just radii), so the overshoot is tuned soft — ~4.7% at t≈0.44, residual 0.12% at t=1
    /// (the tween snaps to the exact value when it ends, so the snap is imperceptible). On a
    /// ~380pt width delta that is a ~17pt breath past the target and a settle back — a soft body
    /// landing, never a wobble. Radii re-amplify it (see `applyLayout`) to keep corners lively.
    /// Only for expanding — collapsing is a quiet exhale where a bounce would read as flippant.
    static func springSettle(_ t: CGFloat) -> CGFloat { 1 - exp(-6.0 * t) * cos(5.2 * t) }

    /// The original quiet out-cubic (collapse direction, and the opacity channel).
    static func outCubic(_ t: CGFloat) -> CGFloat { 1 - pow(1 - t, 3) }
}

/// Layout metrics shared between the controller (panel frame) and the view (content inset), so
/// the transparent margin that lets the expanded card cast a soft shadow stays in sync on both
/// sides. The margin is applied **only when expanded** — collapsed keeps its exact menu-bar
/// geometry, so nothing transparent ever overhangs the menu bar.
enum NotchMetrics {
    static let shadowMarginH: CGFloat = 22       // each side
    static let shadowMarginBottom: CGFloat = 28
}

/// Vertical structure of the expanded card, shared by the controller (height math) and the view
/// (subview layout) so the measured panel height always matches the laid-out content.
/// `cardHeight = headerHeight + answerHeight + answerBottomPad`.
enum NotchLayout {
    static let headerHeight: CGFloat = 40     // rose + mode + status + controls row (incl. gap below)
    static let contentInsetH: CGFloat = 16    // horizontal padding for header & answer
    static let answerBottomPad: CGFloat = 14  // padding under the answer
    static let headerRowCenterY: CGFloat = 18 // vertical center of the header row within the card
}

// MARK: - Small helpers

@inline(__always) func notchLerp(_ a: CGFloat, _ b: CGFloat, _ t: CGFloat) -> CGFloat { a + (b - a) * t }

/// Rect lerp — extrapolates past t=1 so the frame spring can overshoot as one body.
@inline(__always) func notchLerpRect(_ a: CGRect, _ b: CGRect, _ t: CGFloat) -> CGRect {
    CGRect(x: notchLerp(a.minX, b.minX, t), y: notchLerp(a.minY, b.minY, t),
           width: notchLerp(a.width, b.width, t), height: notchLerp(a.height, b.height, t))
}

/// Smoothstep of `x` across [lo, hi] — the staging ramp for content alpha inside the morph.
@inline(__always) func notchRamp(_ x: CGFloat, _ lo: CGFloat, _ hi: CGFloat) -> CGFloat {
    guard hi > lo else { return x >= hi ? 1 : 0 }
    let t = max(0, min(1, (x - lo) / (hi - lo)))
    return t * t * (3 - 2 * t)
}

/// A vertical CGGradient from `(color, location)` stops in sRGB.
func notchGradient(_ stops: [(NSColor, CGFloat)]) -> CGGradient {
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    let colors = stops.map { ($0.0.usingColorSpace(.sRGB) ?? $0.0).cgColor } as CFArray
    let locations = stops.map { $0.1 }
    return CGGradient(colorsSpace: space, colors: colors, locations: locations)!
}

/// A solid-tinted copy of an SF Symbol (template images don't tint when drawn into an arbitrary
/// CGContext, so bake the colour in once).
func notchTintedSymbol(_ name: String, pointSize: CGFloat, weight: NSFont.Weight, color: NSColor) -> NSImage? {
    let cfg = NSImage.SymbolConfiguration(pointSize: pointSize, weight: weight)
    guard let base = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
        .withSymbolConfiguration(cfg) else { return nil }
    let size = base.size
    let img = NSImage(size: size)
    img.lockFocus()
    color.set()
    let r = NSRect(origin: .zero, size: size)
    base.draw(in: r)
    r.fill(using: .sourceAtop)
    img.unlockFocus()
    img.isTemplate = false
    return img
}

// MARK: - Answer typography

/// How the current answer should be presented — derived from the model on every refresh and
/// passed to BOTH the renderer and the height measurement, so they can never disagree.
struct AnswerPresentation: Equatable {
    var mode: String        // "tutor" | "personality"
    var depth: String       // depth this answer was CAPTURED with (frozen per run, not live)
    var finished: Bool      // the stream has ended (idle / error)
    var revealed: Bool      // the user unfolded the scratch work (brief depth, finished)
    var failed: Bool = false // the run ended in error — error prose, never answer ink
}

extension NSAttributedString.Key {
    /// Marks the answer-card range. Value: "label" (the small caption) or "answer" (the payload).
    /// The streaming view draws the glass chip behind this range.
    static let nspiAnswerCard = NSAttributedString.Key("nspiAnswerCard")
    /// Marks the clickable "▸ 推理过程" line that folds/unfolds the scratch work.
    static let nspiReasoningToggle = NSAttributedString.Key("nspiReasoningToggle")
    /// Marks one hotkey cap ("⇧", "⌘", "1") in the idle placeholder. The streaming view draws a
    /// mini glass keycap behind the range — the product's "press this" language, inline in text.
    static let nspiKeycap = NSAttributedString.Key("nspiKeycap")
}

/// Single source of truth for the answer's typography, used by BOTH the view (rendering) and the
/// controller (height measurement), so the measured panel height always matches what is drawn —
/// no last-line clip, no trailing gap. Non-empty answers render inline Markdown (bold / italic /
/// code). Answers under the FINAL contract (see `Prompts.finalLineClause`) are composed via
/// `AnswerComposer`: scratch work + ONE authoritative answer card — never two answers.
enum NotchType {
    /// User-adjustable in 设置 → 外观 (small / standard / large).
    static var answerFontSize: CGFloat { Appearance.answerFontSize }

    // Answer-card metrics, shared by the renderer (chip rect) and the measurer (extra height).
    static let cardCorner: CGFloat = 10
    static let cardPadV: CGFloat = 8       // chip inner padding above first / below last card line
    static let cardPadH: CGFloat = 12      // text indent inside the full-width chip
    static let cardGapAbove: CGFloat = 10  // clear air between the chip and what precedes it

    /// The idle hint, with the hotkey set as inline mini keycaps (the same "press this" language
    /// the onboarding and settings teach) instead of raw glyphs lost in a gray sentence. Each cap
    /// character carries `.nspiKeycap`; the streaming view draws the glass cap behind it, and the
    /// kerned separators reserve the air the caps need. One string drives measure AND render.
    static func placeholderLine(mode: String) -> NSAttributedString {
        let combo = mode == "personality" ? Settings.shared.personalityCombo
                                          : Settings.shared.captureCombo
        let caps = KeycapChipView.caps(from: combo)
        let (prefix, suffix) = mode == "personality"
            ? (L10n.t("按", "", "Press"),
               L10n.t("截屏作答 · 悬停展开", "で回答 · ホバーで展開", "to answer · hover to expand"))
            : (L10n.t("按", "", "Press"),
               L10n.t("截屏讲题 · 悬停展开", "で解説 · ホバーで展開", "for tutoring · hover to expand"))

        let para = NSMutableParagraphStyle()
        para.lineSpacing = 2
        para.paragraphSpacingBefore = 3          // headroom for the caps' vertical bleed
        para.firstLineHeadIndent = 5             // keeps a leading cap's chip clear of the clip edge
        let hint: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: answerFontSize),
            .foregroundColor: NotchPalette.secondary,
            .paragraphStyle: para,
        ]
        // Kerned spaces between caps: advance for the chips' horizontal bleed (±4.5pt each).
        let gap: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: answerFontSize),
            .kern: 8,
            .paragraphStyle: para,
        ]
        let cap: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: max(10.5, answerFontSize - 1.5), weight: .medium),
            .foregroundColor: NSColor(white: 1, alpha: 0.85),
            .paragraphStyle: para,
            .nspiKeycap: true,
        ]

        let out = NSMutableAttributedString()
        if !prefix.isEmpty { out.append(NSAttributedString(string: prefix, attributes: hint)) }
        for capText in caps {
            if out.length > 0 { out.append(NSAttributedString(string: " ", attributes: gap)) }
            out.append(NSAttributedString(string: capText, attributes: cap))
        }
        if !suffix.isEmpty {
            out.append(NSAttributedString(string: " ", attributes: gap))
            out.append(NSAttributedString(string: suffix, attributes: hint))
        }
        return out
    }

    /// Presentation snapshot for the model's CURRENT answer.
    @MainActor
    static func presentation(for model: TutorModel) -> AnswerPresentation {
        AnswerPresentation(
            mode: model.mode,
            depth: model.answerDepth,
            finished: !(model.status == .running || model.status == .streaming),
            revealed: model.reasoningRevealed,
            failed: model.status == .error)
    }

    static func answerString(_ answer: String, presentation p: AnswerPresentation) -> NSAttributedString {
        if answer.isEmpty {
            // Mid-run there is nothing to say yet: the light field and the status line carry
            // "thinking" — a hotkey hint here would contradict the capture the user just fired.
            guard p.finished else { return NSAttributedString() }
            return placeholderLine(mode: p.mode)
        }
        if p.failed {
            // Error prose is not an answer: quiet secondary ink; the red rose and the amber
            // light field already carry the state. Never the answer's bright primary white.
            let para = NSMutableParagraphStyle()
            para.lineSpacing = 3
            return NSAttributedString(string: answer, attributes: [
                .font: NSFont.systemFont(ofSize: answerFontSize),
                .foregroundColor: NotchPalette.secondary,
                .paragraphStyle: para,
            ])
        }
        if p.mode == "personality" {
            // Keep `TutorModel.answer` as the untouched protocol stream. Rendering and measuring
            // both pass through this exact composition call, so JSON/prose cannot leak and the
            // panel height always matches the visible choices (including a provisional last line).
            let composition = PersonalityAnswer.compose(raw: answer, streaming: !p.finished)
            return body(composition.visibleChoices, dim: false)
        }
        // Hint mode never carries a FINAL contract and renders exactly as before.
        guard p.depth != "hint" else { return body(answer, dim: false) }

        let parse = AnswerComposer.parse(answer, streaming: !p.finished)
        guard let final = parse.final, !(p.finished && final.isEmpty) else {
            // No marker (yet). A brief answer still streaming is scratch work — de-emphasize it.
            // A FINISHED reply without a marker (error text, contract violation) falls back to
            // the normal treatment, so nothing readable is ever hidden or folded away.
            let dim = p.depth == "brief" && !p.finished
            return body(parse.working, dim: dim)
        }

        let out = NSMutableAttributedString()
        let hasWorking = !parse.working.isEmpty
        if hasWorking {
            if p.depth == "brief" && p.finished {
                // The condensation moment: scratch folds into a quiet, reopenable line.
                out.append(toggleLine(expanded: p.revealed))
                if p.revealed {
                    out.append(NSAttributedString(string: "\n"))
                    out.append(body(parse.working, dim: true))
                }
            } else {
                out.append(body(parse.working, dim: p.depth == "brief"))
            }
        }
        if out.length > 0 { out.append(NSAttributedString(string: "\n")) }
        out.append(card(final, afterContent: out.length > 0))
        if !parse.overflow.isEmpty {
            // Contract-violating trailing scratch: quiet notes below the card, clear of the
            // chip's bottom inset (spacingBefore covers cardPadV plus breathing room).
            out.append(NSAttributedString(string: "\n"))
            out.append(body(parse.overflow, dim: true, spacingBefore: cardPadV + 6))
        }
        return out
    }

    static func answerHeight(_ answer: String, presentation: AnswerPresentation, width: CGFloat) -> CGFloat {
        guard width > 1 else { return 0 }
        // Measure with the SAME CTFramesetter the streaming view renders with, so the panel
        // height always matches what is drawn — no last-line clip, no trailing gap.
        let attr = answerString(answer, presentation: presentation)
        var h = StreamingAnswerView.measure(attr, width: width)
        // The chip's bottom inset extends below its last text line.
        if attr.length > 0, attr.attribute(.nspiAnswerCard, at: attr.length - 1, effectiveRange: nil) != nil {
            h += cardPadV
        }
        return h
    }

    // MARK: Composition pieces

    /// Body text: the pre-fix rendering, parameterized. `dim` is the scratch-work treatment —
    /// a touch smaller, secondary ink, tighter leading. Quiet, never competing with the card.
    private static func body(_ text: String, dim: Bool, spacingBefore: CGFloat = 0) -> NSAttributedString {
        let para = NSMutableParagraphStyle()
        para.lineSpacing = dim ? 2.5 : 3
        let size = dim ? max(10.5, answerFontSize - 2) : answerFontSize
        let out = inlineMarkdown(
            text,
            baseFont: .systemFont(ofSize: size),
            codeFont: .monospacedSystemFont(ofSize: size - 0.5, weight: .regular),
            color: dim ? NotchPalette.secondary : NotchPalette.primary,
            para: para)
        guard spacingBefore > 0, out.length > 0 else { return out }
        // Air before the FIRST paragraph only (e.g. overflow clearing the chip's bottom inset).
        let m = NSMutableAttributedString(attributedString: out)
        let first = (m.string as NSString).paragraphRange(for: NSRange(location: 0, length: 0))
        let spaced = para.mutableCopy() as! NSMutableParagraphStyle
        spaced.paragraphSpacingBefore = spacingBefore
        m.addAttribute(.paragraphStyle, value: spaced, range: first)
        return m
    }

    /// The authoritative answer card: a small accent caption + the answer itself, one size up
    /// and semibold. The whole range carries `.nspiAnswerCard` so the streaming view can draw
    /// the glass chip behind it; indents keep the text off the chip's rounded edges.
    private static func card(_ final: String, afterContent: Bool) -> NSAttributedString {
        let para = NSMutableParagraphStyle()
        para.lineSpacing = 3
        para.firstLineHeadIndent = cardPadH
        para.headIndent = cardPadH
        para.tailIndent = -cardPadH
        para.paragraphSpacingBefore = (afterContent ? cardGapAbove : 0) + cardPadV

        let out = NSMutableAttributedString()
        let labelFont = NSFont.systemFont(ofSize: 10.5, weight: .semibold)
        out.append(NSAttributedString(string: L10n.answerCardLabel + "  ", attributes: [
            .font: labelFont,
            .foregroundColor: NotchPalette.accentHi.withAlphaComponent(0.92),
            .kern: 1.4,
            .paragraphStyle: para,
            .nspiAnswerCard: "label",
        ]))
        // Inner newlines become line separators so a multi-line answer stays ONE paragraph
        // (paragraphSpacingBefore must not repeat inside the chip).
        let text = final.replacingOccurrences(of: "\n", with: "\u{2028}")
        out.append(inlineMarkdown(
            text,
            baseFont: .systemFont(ofSize: answerFontSize + 4, weight: .semibold),
            codeFont: .monospacedSystemFont(ofSize: answerFontSize + 3, weight: .medium),
            color: NotchPalette.primary,
            para: para,
            extra: [.nspiAnswerCard: "answer"]))
        return out
    }

    private static func toggleLine(expanded: Bool) -> NSAttributedString {
        let para = NSMutableParagraphStyle()
        para.lineSpacing = 2
        let title = L10n.t("推理过程", "考え方", "Reasoning")
        return NSAttributedString(string: "\(expanded ? "▾" : "▸") \(title)", attributes: [
            .font: NSFont.systemFont(ofSize: 11, weight: .medium),
            .foregroundColor: NotchPalette.secondary,
            .paragraphStyle: para,
            .nspiReasoningToggle: true,
        ])
    }

    /// Inline-Markdown → attributed runs with the given typography (the original `answerString`
    /// parse, factored so scratch, body and card can each bring their own fonts and extras).
    private static func inlineMarkdown(
        _ text: String, baseFont: NSFont, codeFont: NSFont, color: NSColor,
        para: NSParagraphStyle, extra: [NSAttributedString.Key: Any] = [:]
    ) -> NSAttributedString {
        var attrs: [NSAttributedString.Key: Any] = [
            .font: baseFont, .foregroundColor: color, .paragraphStyle: para,
        ]
        for (k, v) in extra { attrs[k] = v }
        let out = NSMutableAttributedString()
        if let attributed = try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            for run in attributed.runs {
                let piece = String(attributed[run.range].characters)
                var font = baseFont
                if let intent = run.inlinePresentationIntent {
                    if intent.contains(.code) {
                        font = codeFont
                    } else {
                        font = variant(baseFont,
                                       bold: intent.contains(.stronglyEmphasized),
                                       italic: intent.contains(.emphasized))
                    }
                }
                var a = attrs
                a[.font] = font
                out.append(NSAttributedString(string: piece, attributes: a))
            }
        } else {
            out.append(NSAttributedString(string: text, attributes: attrs))
        }
        return out
    }

    private static func variant(_ font: NSFont, bold: Bool, italic: Bool) -> NSFont {
        var f = font
        let fm = NSFontManager.shared
        if bold { f = fm.convert(f, toHaveTrait: .boldFontMask) }
        if italic { f = fm.convert(f, toHaveTrait: .italicFontMask) }
        return f
    }
}

// MARK: - Display-link tween

/// A 0…1 (or arbitrary) value tweened over a duration on the display clock. Drives the morph
/// (radii + content crossfade) so it stays glued to the controller's panel-frame animation. Uses
/// a weak proxy as the display-link target to avoid a retain cycle.
final class DisplayTween {
    private(set) var value: CGFloat
    private var from: CGFloat = 0
    private var to: CGFloat = 0
    private var startTime: CFTimeInterval = 0
    private var duration: CFTimeInterval = NotchPalette.morphDuration
    private var link: CADisplayLink?
    private var proxy: TweenProxy?
    private weak var host: NSView?

    var onChange: ((CGFloat) -> Void)?
    /// Out-cubic settle (the opacity channel's default).
    var ease: (CGFloat) -> CGFloat = { t in 1 - pow(1 - t, 3) }

    /// True while a tween is in flight (used to hand the panel frame between morph and growth).
    var isAnimating: Bool { link.map { !$0.isPaused } ?? false }

    init(host: NSView, value: CGFloat = 0) {
        self.host = host
        self.value = value
    }

    /// Jump to a value immediately (Reduce Motion).
    func set(_ v: CGFloat) {
        link?.isPaused = true
        value = v
        onChange?(v)
    }

    func animate(to target: CGFloat, duration: CFTimeInterval) {
        guard let host else { set(target); return }
        if value == target { return }
        from = value
        to = target
        self.duration = max(0.001, duration)
        startTime = CACurrentMediaTime()
        if link == nil {
            let p = TweenProxy(self)
            proxy = p
            link = host.displayLink(target: p, selector: #selector(TweenProxy.tick))
            link?.add(to: .main, forMode: .common)
        }
        link?.isPaused = false
    }

    fileprivate func step() {
        let elapsed = CACurrentMediaTime() - startTime
        let t = min(1, max(0, elapsed / duration))
        value = from + (to - from) * ease(CGFloat(t))
        onChange?(value)
        if t >= 1 {
            value = to
            onChange?(value)
            link?.isPaused = true
        }
    }

    deinit { link?.invalidate() }
}

private final class TweenProxy {
    weak var owner: DisplayTween?
    init(_ o: DisplayTween) { owner = o }
    @objc func tick() { owner?.step() }
}

// MARK: - Critically damped spring

/// A retargetable critically-damped spring on a scalar. Unlike a restarted tween, retargeting
/// mid-flight PRESERVES velocity — so a stream of moving targets (panel height growing line by
/// line, follow-bottom scroll chasing new text) glides as one continuous motion instead of a
/// staircase of eased hops. Semi-implicit Euler; stable at display rates for the ω used here.
struct CriticalSpring {
    private(set) var value: CGFloat = 0
    private var velocity: CGFloat = 0
    var target: CGFloat = 0
    /// ω² — 210 ⇒ ω≈14.5, settles in ~0.35s without overshoot.
    var stiffness: CGFloat = 210

    var settled: Bool { abs(value - target) < 0.25 && abs(velocity) < 4 }

    mutating func step(_ dt: CFTimeInterval) {
        let dt = CGFloat(min(max(dt, 0), 1.0 / 30))   // clamp runloop stalls; keep integration stable
        let damping = 2 * sqrt(stiffness)
        velocity += (stiffness * (target - value) - damping * velocity) * dt
        value += velocity * dt
        if settled { value = target; velocity = 0 }
    }

    /// Jump to a value with no motion (state resets, Reduce Motion).
    mutating func snap(_ v: CGFloat) { value = v; target = v; velocity = 0 }
}

// MARK: - Display ticker

/// A pausable display-link that reports the frame delta — the clock for the springs. Weak-proxy
/// target like `DisplayTween` so it never retains its host.
final class NotchTicker {
    private var link: CADisplayLink?
    private var proxy: TickerProxy?
    private var lastTime: CFTimeInterval = 0
    private weak var host: NSView?
    var onTick: ((CFTimeInterval) -> Void)?

    init(host: NSView) { self.host = host }

    var isRunning: Bool { link.map { !$0.isPaused } ?? false }

    func start() {
        guard let host else { return }
        if link == nil {
            let p = TickerProxy(self)
            proxy = p
            link = host.displayLink(target: p, selector: #selector(TickerProxy.tick))
            link?.add(to: .main, forMode: .common)
        }
        if link?.isPaused == true || lastTime == 0 { lastTime = CACurrentMediaTime() }
        link?.isPaused = false
    }

    func pause() { link?.isPaused = true }

    fileprivate func step() {
        let now = CACurrentMediaTime()
        let dt = now - lastTime
        lastTime = now
        onTick?(dt)
    }

    deinit { link?.invalidate() }
}

private final class TickerProxy {
    weak var owner: NotchTicker?
    init(_ o: NotchTicker) { owner = o }
    @objc func tick() { owner?.step() }
}

// MARK: - Obsidian surface

/// The material treatment applied to the notch slab, drawn entirely within the shape so it never
/// spills outside the card: a near-black body that stays pure black at the seam and lifts almost
/// imperceptibly toward the lower face; a soft inner shadow seating it under the menu bar; a cool
/// specular hairline along the lower edge; and a triangular-noise dither that keeps the gradients
/// glassy rather than stepped. Flipped so geometry is top-left (y down).
final class NotchSurfaceView: NSView {
    /// The rect (within `bounds`) the slab is drawn in. `bounds` is the full panel — including the
    /// transparent shadow margin — so the drop shadow has room to fall without clipping.
    var cardRect: CGRect = .zero { didSet { needsDisplay = true } }
    var topRadius: CGFloat = 8 { didSet { needsDisplay = true } }
    var bottomRadius: CGFloat = 11 { didSet { needsDisplay = true } }
    /// 0 = collapsed (seam-fused, minimal volume) … 1 = expanded (full lower-face volume).
    var depth: CGFloat = 0 { didSet { needsDisplay = true } }
    /// Drop-shadow strength 0…1, driven by the morph so the card's grounding fades in/out with
    /// its lift — a binary toggle here reads as a shadow popping on under the menu bar.
    var shadowStrength: CGFloat = 0 { didSet { needsDisplay = true } }

    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil } // never intercept clicks

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext, cardRect.width > 1 else { return }
        let rect = cardRect
        let path = NotchShape.cgPath(in: rect, topRadius: topRadius, bottomRadius: bottomRadius)

        // Grounded drop shadow (expanded only). Paint the opaque body twice with a CG shadow so it
        // falls below the card — a tight contact shadow plus a soft ambient one. Offsets are
        // positive-down because the flipped context has +y pointing toward the bottom of screen.
        if shadowStrength > 0.01 {
            let s = min(1, shadowStrength)
            ctx.saveGState()
            ctx.setShadow(offset: CGSize(width: 0, height: 9), blur: 16,
                          color: NSColor.black.withAlphaComponent(0.55 * s).cgColor)
            ctx.addPath(path); ctx.setFillColor(NSColor.black.cgColor); ctx.fillPath()
            ctx.restoreGState()
            ctx.saveGState()
            ctx.setShadow(offset: CGSize(width: 0, height: 2), blur: 5,
                          color: NSColor.black.withAlphaComponent(0.38 * s).cgColor)
            ctx.addPath(path); ctx.setFillColor(NSColor.black.cgColor); ctx.fillPath()
            ctx.restoreGState()
        }

        // Base fill.
        ctx.saveGState()
        ctx.addPath(path); ctx.setFillColor(NotchPalette.background.cgColor); ctx.fillPath()
        ctx.restoreGState()

        // Interior overlays, clipped to the slab.
        ctx.saveGState()
        ctx.addPath(path); ctx.clip()

        // bodyLight: a cool sheen reflecting screen light up onto the lower face — pure black at
        // the top seam, lifting to a graphite whisper below. Additive so it only lifts.
        ctx.saveGState()
        ctx.setBlendMode(.plusLighter)
        ctx.drawLinearGradient(
            notchGradient([
                (.clear, 0.0),
                (.clear, 0.24),
                (NotchPalette.sheen.withAlphaComponent(0.022 + 0.040 * depth), 1.0),
            ]),
            start: CGPoint(x: rect.midX, y: rect.minY),
            end: CGPoint(x: rect.midX, y: rect.maxY),
            options: []
        )
        ctx.restoreGState()

        // seamShadow: darken just under the top seam so the slab reads as tucked beneath the bar.
        ctx.drawLinearGradient(
            notchGradient([
                (NSColor.black.withAlphaComponent(0.55), 0.0),
                (.clear, 0.18),
                (.clear, 1.0),
            ]),
            start: CGPoint(x: rect.midX, y: rect.minY),
            end: CGPoint(x: rect.midX, y: rect.maxY),
            options: []
        )

        // dither: a fine static noise tile at very low opacity, additive, to break up banding.
        if let tile = NotchDither.tileImage {
            ctx.saveGState()
            ctx.setBlendMode(.plusLighter)
            ctx.setAlpha(0.025)
            ctx.draw(tile, in: CGRect(x: 0, y: 0, width: 96, height: 96), byTiling: true)
            ctx.restoreGState()
        }
        ctx.restoreGState() // end path clip

        // edgeLight: a cool specular hairline riding the lower edge — screen light on a machined
        // lip. Clip to the inner half of a thin stroke of the path so it reads as an inset border,
        // fading out toward the fused seam.
        ctx.saveGState()
        ctx.addPath(path); ctx.clip()
        let stroked = path.copy(strokingWithWidth: 1.5, lineCap: CGLineCap.round, lineJoin: CGLineJoin.round, miterLimit: 10)
        ctx.addPath(stroked); ctx.clip()
        ctx.setBlendMode(.plusLighter)
        ctx.drawLinearGradient(
            notchGradient([
                (NSColor(white: 1, alpha: 0.0), 0.0),
                (NSColor(white: 1, alpha: 0.0), 0.40),
                (NotchPalette.accentHi.withAlphaComponent(0.12 + 0.11 * depth), 0.78),
                (NSColor(white: 1, alpha: 0.22 + 0.16 * depth), 1.0),
            ]),
            start: CGPoint(x: rect.midX, y: rect.minY),
            end: CGPoint(x: rect.midX, y: rect.maxY),
            options: []
        )
        ctx.restoreGState()
    }
}

// MARK: - Dither tile

/// A static, cached fine-noise tile (a CGImage, generated once and tiled). Triangular-PDF-ish
/// white noise — the anti-banding device for the obsidian gradients.
enum NotchDither {
    static let tileImage: CGImage? = makeTile(side: 96)

    private static func makeTile(side: Int) -> CGImage? {
        let bytesPerPixel = 4
        let bytesPerRow = side * bytesPerPixel
        var data = [UInt8](repeating: 0, count: side * bytesPerRow)
        var seed: UInt64 = 0x9E3779B97F4A7C15
        func next() -> UInt8 {
            seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17
            return UInt8(truncatingIfNeeded: seed >> 24)
        }
        for i in stride(from: 0, to: data.count, by: bytesPerPixel) {
            let v = next()
            data[i] = v; data[i + 1] = v; data[i + 2] = v; data[i + 3] = 255
        }
        let cs = CGColorSpaceCreateDeviceRGB()
        guard let ctx = CGContext(data: &data, width: side, height: side, bitsPerComponent: 8,
                                  bytesPerRow: bytesPerRow, space: cs,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        return ctx.makeImage()
    }
}

// MARK: - Control button

/// A quiet hairline-glass control (the header gear). A soft chip fades in on hover; a small scale
/// + dim on press. Drawn entirely in `draw(_:)` so there is no layer/cell ordering to fight, and
/// it works as first-mouse inside the non-activating panel.
final class NotchControlButton: NSControl {
    private let onAction: () -> Void
    private var baseImage: NSImage?
    private var hovering = false { didSet { if hovering != oldValue { needsDisplay = true } } }
    private var pressed = false { didSet { if pressed != oldValue { needsDisplay = true } } }
    private var trackingAreaRef: NSTrackingArea?

    init(systemName: String, tint: NSColor, label: String, action: @escaping () -> Void) {
        self.onAction = action
        self.baseImage = notchTintedSymbol(systemName, pointSize: 12, weight: .semibold, color: tint)
        super.init(frame: NSRect(x: 0, y: 0, width: 28, height: 24))
        toolTip = label
        setAccessibilityElement(true)
        setAccessibilityLabel(label)
        setAccessibilityRole(.button)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var isFlipped: Bool { true }
    override var intrinsicContentSize: NSSize { NSSize(width: 28, height: 24) }
    override var acceptsFirstResponder: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        let b = bounds

        if hovering {
            let r = NSBezierPath(roundedRect: b, xRadius: 7, yRadius: 7)
            NSColor(white: 1, alpha: 0.10).setFill(); r.fill()
            r.lineWidth = 0.75
            NSColor(white: 1, alpha: 0.12).setStroke(); r.stroke()
        }

        guard let img = baseImage else { return }
        let scale: CGFloat = pressed ? 0.94 : 1
        let alpha: CGFloat = (pressed ? 0.72 : (hovering ? 1.0 : 0.82))
        let s = NSSize(width: img.size.width * scale, height: img.size.height * scale)
        let rect = NSRect(x: (b.width - s.width) / 2, y: (b.height - s.height) / 2,
                          width: s.width, height: s.height)
        img.draw(in: rect, from: .zero, operation: .sourceOver, fraction: alpha)
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
    override func mouseExited(with event: NSEvent) { hovering = false; pressed = false }

    override func mouseDown(with event: NSEvent) { pressed = true }
    override func mouseDragged(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        pressed = bounds.contains(p)
    }
    override func mouseUp(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        let inside = bounds.contains(p)
        pressed = false
        if inside { onAction() }
    }

    override func accessibilityPerformPress() -> Bool {
        onAction()
        return true
    }
}
