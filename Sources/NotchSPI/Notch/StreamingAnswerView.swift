import AppKit
import CoreText

// The hero moment of a tutor is the explanation ARRIVING — so it deserves better than an
// NSTextView repainting whole. This view renders the answer with CoreText and gives every glyph
// a *birth*: new characters fade in and settle upward over ~180 ms, staggered a few milliseconds
// apart, so streamed tokens pour onto the slab like ink meeting glass instead of teleporting.
// It honours the Markdown styling NotchType produces (bold / italic / inline code) by drawing
// each glyph with its own run's font + colour. Layout, measurement, and render all flow from ONE
// attributed string, so the panel height always matches what is drawn.
//
// It is the scroll view's documentView: NotchView sizes it to the measured content height and the
// scroll shows a window onto it; while streaming, NotchView keeps it pinned to the bottom. Reduce
// Motion births instantly. Selection is traded for the animation; a right-click menu copies.
final class StreamingAnswerView: NSView {
    private var attributed = NSAttributedString()
    private var plain = ""
    private var births: [CFTimeInterval] = []   // one per Character of `plain`
    private var isPlaceholder = true
    private var link: CADisplayLink?
    private var proxy: StreamProxy?
    private var frameCache: (key: String, width: CGFloat, frame: CTFrame)?

    /// Fires when the "▸ 推理过程" line is clicked (brief mode's folded scratch work).
    var onToggleReasoning: (() -> Void)?
    // UTF-16 ranges (on `attributed`) extracted from the composer's custom attributes.
    private var cardRange: NSRange?         // whole card: chip is drawn behind this
    private var toggleRange: NSRange?

    private static let birthDuration: CFTimeInterval = 0.18
    private static let stagger: CFTimeInterval = 0.012
    private static let staggerCap: CFTimeInterval = 0.22   // long paste doesn't queue forever
    private static let rise: CGFloat = 3
    private static let layoutHeight: CGFloat = 100_000

    private var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

    override var isFlipped: Bool { true }   // top-aligned text inside the scroll view

    // MARK: - Content (diff → births)

    /// Streaming contract: the answer grows by suffix during a turn and is replaced wholesale on a
    /// new one. Common prefix keeps its births; everything after is born now, staggered. The diff
    /// is on the PARSED string, so an in-progress Markdown token only re-births the streaming tail.
    func setAnswer(_ attr: NSAttributedString, isPlaceholder: Bool) {
        let new = attr.string
        self.isPlaceholder = isPlaceholder
        attributed = attr
        frameCache = nil
        extractRanges()

        if isPlaceholder {
            plain = new
            births = []                    // placeholder never animates
            needsDisplay = true
            return
        }
        guard new != plain else { needsDisplay = true; return }
        let now = CACurrentMediaTime()
        let newChars = Array(new), oldChars = Array(plain)
        var common = 0
        let limit = min(newChars.count, oldChars.count)
        while common < limit && newChars[common] == oldChars[common] { common += 1 }
        var next = Array(births.prefix(min(common, births.count)))
        if reduceMotion {
            next.append(contentsOf: Array(repeating: now - 10, count: newChars.count - next.count))
        } else {
            for i in next.count..<newChars.count {
                next.append(now + min(Self.staggerCap, Double(i - common) * Self.stagger))
            }
        }
        plain = new
        births = next
        needsDisplay = true
        updateLink()
    }

    /// Pull the composer's semantic ranges out of the attributed string — the string itself is
    /// the only contract between NotchType and this view, so nothing can drift out of sync.
    private func extractRanges() {
        cardRange = nil; toggleRange = nil
        let full = NSRange(location: 0, length: attributed.length)
        attributed.enumerateAttribute(.nspiAnswerCard, in: full) { value, range, _ in
            guard value != nil else { return }
            cardRange = cardRange.map { NSUnionRange($0, range) } ?? range
        }
        attributed.enumerateAttribute(.nspiReasoningToggle, in: full) { value, range, _ in
            guard value != nil else { return }
            toggleRange = toggleRange.map { NSUnionRange($0, range) } ?? range
        }
        window?.invalidateCursorRects(for: self)
    }

    // MARK: - Shared framesetter (measure == render)

    static func measure(_ attr: NSAttributedString, width: CGFloat) -> CGFloat {
        guard attr.length > 0, width > 1 else { return 0 }
        let setter = CTFramesetterCreateWithAttributedString(attr)
        let size = CTFramesetterSuggestFrameSizeWithConstraints(
            setter, CFRange(location: 0, length: 0), nil,
            CGSize(width: width, height: .greatestFiniteMagnitude), nil)
        return ceil(size.height)
    }

    private func currentFrame() -> CTFrame? {
        guard attributed.length > 0, bounds.width > 1 else { return nil }
        let key = attributed.string
        if let c = frameCache, c.key == key, c.width == bounds.width { return c.frame }
        let setter = CTFramesetterCreateWithAttributedString(attributed)
        let path = CGPath(rect: CGRect(x: 0, y: 0, width: bounds.width, height: Self.layoutHeight), transform: nil)
        let frame = CTFramesetterCreateFrame(setter, CFRange(location: 0, length: 0), path, nil)
        frameCache = (key, bounds.width, frame)
        return frame
    }

    // MARK: - Draw (per-glyph alpha + rise; per-run font + colour for Markdown)

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext, let frame = currentFrame() else { return }
        let now = CACurrentMediaTime()
        let utf16Births = isPlaceholder ? [] : Self.utf16BirthTable(plain: plain, births: births)

        // CT lays out y-up; the view is flipped (y-down). Flip once, then shift the tall layout
        // path so the first line sits at the view's top.
        ctx.saveGState()
        ctx.translateBy(x: 0, y: bounds.height)
        ctx.scaleBy(x: 1, y: -1)
        let shift = Self.layoutHeight - bounds.height

        let lines = CTFrameGetLines(frame) as! [CTLine]
        var origins = [CGPoint](repeating: .zero, count: lines.count)
        CTFrameGetLineOrigins(frame, CFRange(location: 0, length: 0), &origins)

        // The answer card's glass chip — behind the glyphs, born with its first glyph.
        if let chip = cardRange, chip.length > 0 {
            drawCardChip(chip, lines: lines, origins: origins, shift: shift,
                         ctx: ctx, now: now, utf16Births: utf16Births)
        }

        for (li, line) in lines.enumerated() {
            let originX = origins[li].x
            let originY = origins[li].y - shift
            for run in CTLineGetGlyphRuns(line) as! [CTRun] {
                let count = CTRunGetGlyphCount(run)
                guard count > 0 else { continue }
                var glyphs = [CGGlyph](repeating: 0, count: count)
                var positions = [CGPoint](repeating: .zero, count: count)
                var indices = [CFIndex](repeating: 0, count: count)
                CTRunGetGlyphs(run, CFRange(location: 0, length: 0), &glyphs)
                CTRunGetPositions(run, CFRange(location: 0, length: 0), &positions)
                CTRunGetStringIndices(run, CFRange(location: 0, length: 0), &indices)
                let attrs = CTRunGetAttributes(run) as NSDictionary
                let runFont = (attrs[kCTFontAttributeName] as! CTFont?)
                    ?? (NSFont.systemFont(ofSize: NotchType.answerFontSize) as CTFont)
                let runColor = (attrs[NSAttributedString.Key.foregroundColor.rawValue as NSString] as? NSColor)
                    ?? NotchPalette.primary

                // A hotkey cap in the placeholder: seat a mini glass keycap under this run —
                // the world's "press this" material, at text scale. Chip before glyphs, so the
                // symbol prints on the cap face.
                if attrs[NSAttributedString.Key.nspiKeycap.rawValue as NSString] != nil {
                    var ascent: CGFloat = 0, descent: CGFloat = 0
                    let w = CGFloat(CTRunGetTypographicBounds(run, CFRange(location: 0, length: 0),
                                                              &ascent, &descent, nil))
                    let rect = CGRect(x: originX + positions[0].x - 4.5,
                                      y: originY - descent - 2,
                                      width: w + 9, height: ascent + descent + 4)
                    let capPath = CGPath(roundedRect: rect, cornerWidth: 4.5, cornerHeight: 4.5,
                                         transform: nil)
                    ctx.addPath(capPath)
                    ctx.setFillColor(NSColor(white: 1, alpha: 0.085).cgColor)
                    ctx.fillPath()
                    ctx.addPath(capPath)
                    ctx.setStrokeColor(NSColor(white: 1, alpha: 0.20).cgColor)
                    ctx.setLineWidth(1)
                    ctx.strokePath()
                }

                for g in 0..<count {
                    let a: CGFloat
                    if isPlaceholder {
                        a = 1
                    } else {
                        let birth = indices[g] < utf16Births.count ? utf16Births[indices[g]] : -10
                        a = reduceMotion ? 1 : easeOut(min(1, max(0, (now - birth) / Self.birthDuration)))
                    }
                    guard a > 0.001 else { continue }
                    ctx.setFillColor(runColor.withAlphaComponent(runColor.alphaComponent * a).cgColor)
                    var pos = CGPoint(x: originX + positions[g].x,
                                      y: originY + positions[g].y - (1 - a) * Self.rise)
                    var glyph = glyphs[g]
                    CTFontDrawGlyphs(runFont, &glyph, &pos, 1, ctx)
                }
            }
        }
        ctx.restoreGState()
    }

    private func easeOut(_ t: CFTimeInterval) -> CGFloat { CGFloat(1 - pow(1 - t, 2.4)) }

    /// The chip behind the answer card: a full-width rounded row, accent-tinted glass with a
    /// hairline — quiet, never a loud color block. Drawn in the flipped (y-up) text context, so
    /// it shares the glyphs' coordinate space exactly. Its alpha rides the FIRST card glyph's
    /// birth, so chip and text condense into view together.
    private func drawCardChip(_ chip: NSRange, lines: [CTLine], origins: [CGPoint],
                              shift: CGFloat, ctx: CGContext, now: CFTimeInterval,
                              utf16Births: [CFTimeInterval]) {
        var top = -CGFloat.greatestFiniteMagnitude    // y-up context coords
        var bottom = CGFloat.greatestFiniteMagnitude
        for (li, line) in lines.enumerated() {
            let r = CTLineGetStringRange(line)
            guard NSIntersectionRange(NSRange(location: r.location, length: r.length), chip).length > 0
            else { continue }
            var ascent: CGFloat = 0, descent: CGFloat = 0, leading: CGFloat = 0
            _ = CTLineGetTypographicBounds(line, &ascent, &descent, &leading)
            let oy = origins[li].y - shift
            top = max(top, oy + ascent)
            bottom = min(bottom, oy - descent)
        }
        guard top > -CGFloat.greatestFiniteMagnitude else { return }

        var a: CGFloat = 1
        if !isPlaceholder && !reduceMotion, chip.location < utf16Births.count {
            let birth = utf16Births[chip.location]
            a = easeOut(min(1, max(0, (now - birth) / Self.birthDuration)))
        }
        guard a > 0.001 else { return }

        let rect = CGRect(x: 0, y: bottom - NotchType.cardPadV,
                          width: bounds.width, height: (top - bottom) + NotchType.cardPadV * 2)
        let path = CGPath(roundedRect: rect, cornerWidth: NotchType.cardCorner,
                          cornerHeight: NotchType.cardCorner, transform: nil)
        ctx.saveGState()
        ctx.addPath(path)
        ctx.setFillColor(NotchPalette.accent.withAlphaComponent(0.10 * a).cgColor)
        ctx.fillPath()
        ctx.addPath(path)
        ctx.setStrokeColor(NotchPalette.accentHi.withAlphaComponent(0.22 * a).cgColor)
        ctx.setLineWidth(1)
        ctx.strokePath()
        ctx.restoreGState()
    }

    /// View-space rects of the lines that intersect `range` (for cursor + click on the toggle).
    private func lineRects(for range: NSRange) -> [CGRect] {
        guard let frame = currentFrame() else { return [] }
        let lines = CTFrameGetLines(frame) as! [CTLine]
        var origins = [CGPoint](repeating: .zero, count: lines.count)
        CTFrameGetLineOrigins(frame, CFRange(location: 0, length: 0), &origins)
        var rects: [CGRect] = []
        for (li, line) in lines.enumerated() {
            let r = CTLineGetStringRange(line)
            guard NSIntersectionRange(NSRange(location: r.location, length: r.length), range).length > 0
            else { continue }
            var ascent: CGFloat = 0, descent: CGFloat = 0, leading: CGFloat = 0
            let w = CTLineGetTypographicBounds(line, &ascent, &descent, &leading)
            // Flipped-view y of the baseline (see draw(): view y = layoutHeight - origin.y).
            let baseline = Self.layoutHeight - origins[li].y
            rects.append(CGRect(x: origins[li].x, y: baseline - ascent,
                                width: CGFloat(w), height: ascent + descent))
        }
        return rects
    }

    override func resetCursorRects() {
        super.resetCursorRects()
        guard let toggle = toggleRange else { return }
        for r in lineRects(for: toggle) {
            addCursorRect(r.insetBy(dx: -6, dy: -4).intersection(bounds), cursor: .pointingHand)
        }
    }

    #if DEBUG
    /// Visual-QA: where the toggle currently sits (view coords), for the synthetic click hook.
    func qaReasoningToggleRect() -> CGRect? { toggleRange.flatMap { lineRects(for: $0).first } }
    #endif

    override func mouseDown(with event: NSEvent) {
        if let toggle = toggleRange {
            let p = convert(event.locationInWindow, from: nil)
            if lineRects(for: toggle).contains(where: { $0.insetBy(dx: -6, dy: -4).contains(p) }) {
                onToggleReasoning?()
                return
            }
        }
        super.mouseDown(with: event)
    }

    private static func utf16BirthTable(plain: String, births: [CFTimeInterval]) -> [CFTimeInterval] {
        var table: [CFTimeInterval] = []
        table.reserveCapacity(plain.utf16.count)
        for (i, ch) in plain.enumerated() {
            let b = i < births.count ? births[i] : -10
            for _ in 0..<String(ch).utf16.count { table.append(b) }
        }
        return table
    }

    // MARK: - Animation clock (runs only while glyphs are being born)

    private func updateLink() {
        guard !reduceMotion else { return }
        let now = CACurrentMediaTime()
        let animating = births.contains { now - $0 < Self.birthDuration + Self.staggerCap }
        guard animating else { return }
        if link == nil {
            let p = StreamProxy(self)
            proxy = p
            link = displayLink(target: p, selector: #selector(StreamProxy.tick))
            link?.add(to: .main, forMode: .common)
        }
        link?.isPaused = false
    }

    fileprivate func step() {
        needsDisplay = true
        let now = CACurrentMediaTime()
        if !births.contains(where: { now - $0 < Self.birthDuration + 0.05 }) { link?.isPaused = true }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { link?.isPaused = true } else { updateLink() }
    }

    deinit { link?.invalidate() }
}

private final class StreamProxy {
    weak var owner: StreamingAnswerView?
    init(_ o: StreamingAnswerView) { owner = o }
    @objc func tick() { owner?.step() }
}
