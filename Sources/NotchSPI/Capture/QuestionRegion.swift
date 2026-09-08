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
    private let canvas: SelectionCanvas
    private let confirmButton = NSButton()
    init(image: NSImage, completion: @escaping (QuestionRegion?) -> Void) {
        self.completion = completion
        canvas = SelectionCanvas(image: image)
        let screen = NSScreen.main?.visibleFrame.size ?? NSSize(width: 1000, height: 700)
        let available = NSSize(width: max(100, screen.width - 80), height: max(100, screen.height - 180))
        let ratio = min(available.width / max(image.size.width, 1), available.height / max(image.size.height, 1), 1)
        let size = NSSize(width: min(available.width, max(360, image.size.width * ratio)),
                          height: min(available.height, max(200, image.size.height * ratio)))
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = L10n.t("选择一个题目", "問題を1つ選択", "Select one question")
        window.isReleasedWhenClosed = false
        window.level = .floating
        window.sharingType = ScreenShareGuard.windowSharingType
        window.setContentSize(NSSize(width: size.width, height: size.height + 100))
        let root = NSView(frame: NSRect(x: 0, y: 0, width: size.width, height: size.height + 100))
        canvas.frame = NSRect(x: 0, y: 100, width: size.width, height: size.height)
        root.addSubview(canvas)
        let help = NSTextField(wrappingLabelWithString: SelectionCanvas.instructions)
        help.font = .systemFont(ofSize: 12)
        help.frame = NSRect(x: 16, y: 46, width: size.width - 32, height: 46)
        root.addSubview(help)
        let cancel = NSButton(title: L10n.t("取消", "キャンセル", "Cancel"), target: nil, action: nil)
        cancel.frame = NSRect(x: size.width - 212, y: 10, width: 90, height: 28)
        cancel.keyEquivalent = "\u{1b}"
        root.addSubview(cancel)
        confirmButton.title = L10n.t("使用选区", "選択範囲を使用", "Use selection")
        confirmButton.bezelStyle = .rounded
        confirmButton.frame = NSRect(x: size.width - 116, y: 10, width: 104, height: 28)
        confirmButton.keyEquivalent = "\r"
        confirmButton.isEnabled = false
        root.addSubview(confirmButton)
        window.contentView = root
        super.init(window: window)
        canvas.selected = { [weak self] rect in self?.finish(rect) }
        canvas.changed = { [weak self] in self?.confirmButton.isEnabled = self?.canvas.hasSelection == true }
        cancel.target = self; cancel.action = #selector(cancelSelection)
        confirmButton.target = self; confirmButton.action = #selector(confirmSelection)
        window.initialFirstResponder = canvas
        window.makeFirstResponder(canvas)
        window.delegate = self
        window.center()
    }
    required init?(coder: NSCoder) { nil }
    @objc private func cancelSelection() { finish(nil) }
    @objc private func confirmSelection() { canvas.confirm() }
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
    var changed: (() -> Void)?
    static var instructions: String {
        L10n.t("拖动框选；或用方向键移动、Shift + 方向键调整大小，回车确认，Esc 取消。",
               "ドラッグで選択。矢印キーで移動、Shift＋矢印でサイズ変更、Returnで確定、Escで取消。",
               "Drag to select, or use arrow keys to move and Shift + arrows to resize. Return confirms; Esc cancels.")
    }
    private var imageRect: NSRect {
        guard image.size.width > 0, image.size.height > 0 else { return .zero }
        let scale = min(bounds.width / image.size.width, bounds.height / image.size.height)
        let size = NSSize(width: image.size.width * scale, height: image.size.height * scale)
        return NSRect(x: bounds.midX - size.width / 2, y: bounds.midY - size.height / 2,
                      width: size.width, height: size.height)
    }
    var hasSelection: Bool { selection.width >= 8 && selection.height >= 8 }
    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { true }
    override var canBecomeKeyView: Bool { true }
    override func becomeFirstResponder() -> Bool { needsDisplay = true; return super.becomeFirstResponder() }
    override func resignFirstResponder() -> Bool { needsDisplay = true; return super.resignFirstResponder() }
    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .group }
    override func accessibilityLabel() -> String? { L10n.t("题目选区", "問題の選択範囲", "Question selection") }
    override func accessibilityHelp() -> String? { Self.instructions }
    override func accessibilityValue() -> Any? {
        guard let region = region else { return L10n.t("尚未选择", "未選択", "No selection") }
        let x = Int((region.x * 100).rounded()), y = Int((region.y * 100).rounded())
        let w = Int((region.width * 100).rounded()), h = Int((region.height * 100).rounded())
        return L10n.t("左 \(x)%，上 \(y)%，宽 \(w)%，高 \(h)%", "左 \(x)%、上 \(y)%、幅 \(w)%、高さ \(h)%", "Left \(x)%, top \(y)%, width \(w)%, height \(h)%")
    }
    override func accessibilityPerformPress() -> Bool {
        guard hasSelection else { return false }
        confirm(); return true
    }
    init(image: NSImage) { self.image = image; super.init(frame: .zero) }
    required init?(coder: NSCoder) { nil }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.windowBackgroundColor.setFill(); bounds.fill()
        image.draw(in: imageRect, from: .zero, operation: .copy, fraction: 1, respectFlipped: true, hints: nil)
        if window?.firstResponder === self {
            NSColor.keyboardFocusIndicatorColor.setStroke()
            let focus = NSBezierPath(rect: imageRect.insetBy(dx: 1, dy: 1))
            focus.lineWidth = 2; focus.stroke()
        }
        if !selection.isEmpty {
            NSColor.controlAccentColor.withAlphaComponent(0.15).setFill()
            selection.fill()
            NSColor.controlAccentColor.setStroke()
            let outline = NSBezierPath(rect: selection); outline.lineWidth = 2; outline.stroke()
        }
    }
    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        let point = convert(event.locationInWindow, from: nil)
        origin = imageRect.contains(point) ? point : nil
        selection = .zero
        notifyChange()
    }
    override func mouseDragged(with event: NSEvent) {
        guard let origin else { return }
        let end = convert(event.locationInWindow, from: nil)
        selection = NSRect(x: min(origin.x, end.x), y: min(origin.y, end.y), width: abs(end.x - origin.x), height: abs(end.y - origin.y)).intersection(imageRect)
        notifyChange()
    }
    override func mouseUp(with event: NSEvent) {
        mouseDragged(with: event)
        origin = nil
        confirm()
    }
    private var region: QuestionRegion? {
        let rect = imageRect
        guard hasSelection, rect.width > 0, rect.height > 0 else { return nil }
        let x = max(0, (selection.minX - rect.minX) / rect.width)
        let y = max(0, (selection.minY - rect.minY) / rect.height)
        let value = QuestionRegion(x: x, y: y, width: min(1 - x, selection.width / rect.width),
                                   height: min(1 - y, selection.height / rect.height))
        return value.isValid ? value : nil
    }
    func confirm() { if let region { selected?(region) } }
    private func notifyChange() {
        needsDisplay = true; changed?()
        NSAccessibility.post(element: self, notification: .valueChanged)
    }
    override func cancelOperation(_ sender: Any?) { selected?(nil) }
    override func keyDown(with event: NSEvent) {
        switch event.keyCode {
        case 53: selected?(nil)
        case 36, 76: confirm()
        case 123...126:
            let rect = imageRect
            guard rect.width >= 8, rect.height >= 8 else { return }
            if !hasSelection { selection = rect.insetBy(dx: rect.width / 4, dy: rect.height / 4) }
            let dx: CGFloat = event.keyCode == 123 ? -1 : event.keyCode == 124 ? 1 : 0
            let dy: CGFloat = event.keyCode == 126 ? -1 : event.keyCode == 125 ? 1 : 0
            if event.modifierFlags.contains(.shift) {
                selection.size.width = min(rect.maxX - selection.minX, max(8, selection.width + dx * rect.width / 100))
                selection.size.height = min(rect.maxY - selection.minY, max(8, selection.height + dy * rect.height / 100))
            } else {
                selection.origin.x = min(rect.maxX - selection.width, max(rect.minX, selection.minX + dx * rect.width / 100))
                selection.origin.y = min(rect.maxY - selection.height, max(rect.minY, selection.minY + dy * rect.height / 100))
            }
            notifyChange()
        default: super.keyDown(with: event)
        }
    }
}
