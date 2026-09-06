import AppKit

struct QuestionRegion: Codable, Equatable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    var isValid: Bool {
        [x, y, width, height].allSatisfy(\.isFinite) && x >= 0 && y >= 0
            && width > 0 && height > 0 && x + width <= 1 && y + height <= 1
    }
}

/// Selection uses the actual captured target image; coordinates cannot drift across displays.
@MainActor
final class QuestionRegionPicker: NSWindowController {
    private var completion: ((QuestionRegion?) -> Void)?
    init(image: NSImage, completion: @escaping (QuestionRegion?) -> Void) {
        self.completion = completion
        let screen = NSScreen.main?.visibleFrame.size ?? NSSize(width: 1000, height: 700)
        let ratio = min((screen.width - 100) / max(image.size.width, 1), (screen.height - 160) / max(image.size.height, 1), 1)
        let size = NSSize(width: max(300, image.size.width * ratio), height: max(200, image.size.height * ratio))
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = L10n.t("拖动框选一个题目 · Esc 取消", "問題を1つドラッグで選択 · Escで取消", "Drag around one question · Esc to cancel")
        window.isReleasedWhenClosed = false
        window.level = .floating
        let canvas = SelectionCanvas(image: image)
        window.contentView = canvas
        super.init(window: window)
        canvas.selected = { [weak self] rect in self?.finish(rect) }
        window.delegate = self
        window.center()
    }
    required init?(coder: NSCoder) { nil }
    private func finish(_ rect: QuestionRegion?) {
        guard let callback = completion else { return }
        completion = nil
        close()
        callback(rect)
    }
}
extension QuestionRegionPicker: NSWindowDelegate {
    func windowWillClose(_ notification: Notification) { finish(nil) }
}

private final class SelectionCanvas: NSView {
    private let image: NSImage
    private var origin: NSPoint?
    private var selection = NSRect.zero
    var selected: ((QuestionRegion?) -> Void)?
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    init(image: NSImage) { self.image = image; super.init(frame: .zero) }
    required init?(coder: NSCoder) { nil }
    override func draw(_ dirtyRect: NSRect) {
        image.draw(in: bounds, from: .zero, operation: .copy, fraction: 1, respectFlipped: true, hints: nil)
        if !selection.isEmpty {
            NSColor.controlAccentColor.withAlphaComponent(0.15).setFill()
            selection.fill()
            NSColor.controlAccentColor.setStroke()
            let outline = NSBezierPath(rect: selection); outline.lineWidth = 2; outline.stroke()
        }
    }
    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        origin = convert(event.locationInWindow, from: nil)
        selection = .zero
    }
    override func mouseDragged(with event: NSEvent) {
        guard let origin else { return }
        let end = convert(event.locationInWindow, from: nil)
        selection = NSRect(x: min(origin.x, end.x), y: min(origin.y, end.y), width: abs(end.x - origin.x), height: abs(end.y - origin.y)).intersection(bounds)
        needsDisplay = true
    }
    override func mouseUp(with event: NSEvent) {
        guard selection.width >= 8, selection.height >= 8 else { return }
        selected?(.init(x: selection.minX / bounds.width, y: selection.minY / bounds.height,
                        width: selection.width / bounds.width, height: selection.height / bounds.height))
    }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { selected?(nil) } else { super.keyDown(with: event) }
    }
}
