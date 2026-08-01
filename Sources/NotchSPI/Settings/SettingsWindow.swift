import AppKit
import Carbon.HIToolbox

func carbonModifiers(from flags: NSEvent.ModifierFlags) -> UInt32 {
    var m: UInt32 = 0
    if flags.contains(.command) { m |= UInt32(cmdKey) }
    if flags.contains(.shift) { m |= UInt32(shiftKey) }
    if flags.contains(.option) { m |= UInt32(optionKey) }
    if flags.contains(.control) { m |= UInt32(controlKey) }
    return m
}

func keyLabel(for event: NSEvent) -> String {
    let special: [UInt16: String] = [
        49: "Space", 36: "↩", 48: "⇥", 53: "⎋", 51: "⌫",
        123: "←", 124: "→", 125: "↓", 126: "↑",
        122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5", 97: "F6",
    ]
    if let s = special[event.keyCode] { return s }
    if let ch = event.charactersIgnoringModifiers, let first = ch.first,
       first.isLetter || first.isNumber || first.isPunctuation || first.isSymbol {
        return ch.uppercased()
    }
    return "Key\(event.keyCode)"
}

/// A top-left-origin container so settings rows lay out with y growing downward.
private final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

// MARK: - Hotkey recorder control

/// A recordable hotkey rendered as physical keycaps — the same "press this" visual language the
/// onboarding teaches, translated into the settings window's native light/dark material. Click to
/// arm; while recording the caps yield to a prompt inside a softly pulsing accent ring; a combo
/// that failed to register (conflict) reads in red on the caps themselves.
final class HotkeyRecorderControl: NSControl {
    var combo: HotkeyCombo {
        didSet { invalidateIntrinsicContentSize(); needsDisplay = true }
    }
    var isRecording = false {
        didSet {
            guard isRecording != oldValue else { return }
            invalidateIntrinsicContentSize()
            updateRecordingChrome()
            needsDisplay = true
        }
    }
    var isConflicted = false { didSet { if isConflicted != oldValue { needsDisplay = true } } }
    var onBeginRecord: (() -> Void)?

    private let capSize: CGFloat = 24
    private var gap: CGFloat { capSize * 0.20 }
    private let recordingRing = CALayer()
    private var hovering = false { didSet { if hovering != oldValue { needsDisplay = true } } }
    private var trackingAreaRef: NSTrackingArea?

    init(combo: HotkeyCombo) {
        self.combo = combo
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = 9
        recordingRing.cornerRadius = 9
        recordingRing.borderWidth = 1.5
        recordingRing.opacity = 0
        layer?.addSublayer(recordingRing)
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .pointingHand) }

    private var promptText: String { L10n.t("按下快捷键…", "キーを押す…", "Press keys…") }
    private var promptFont: NSFont { .systemFont(ofSize: 12, weight: .medium) }
    private var capFont: NSFont { .systemFont(ofSize: capSize * 0.46, weight: .medium) }

    /// Per-cap widths: modifier glyphs are square, a text key ("Space", "F5") grows to fit.
    private func capWidths(_ keys: [String]) -> [CGFloat] {
        keys.map { key in
            let w = ceil((key as NSString).size(withAttributes: [.font: capFont]).width)
            return max(capSize, w + 12)
        }
    }

    override var intrinsicContentSize: NSSize {
        if isRecording {
            let w = ceil((promptText as NSString).size(withAttributes: [.font: promptFont]).width)
            return NSSize(width: max(150, w + 36), height: 34)
        }
        let keys = KeycapChipView.caps(from: combo)
        let widths = capWidths(keys)
        let total = widths.reduce(0, +) + gap * CGFloat(max(0, keys.count - 1))
        return NSSize(width: max(150, total + 20), height: 34)
    }

    override func layout() {
        super.layout()
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        recordingRing.frame = bounds
        CATransaction.commit()
    }

    // MARK: Recording chrome (pulsing accent ring)

    private func updateRecordingChrome() {
        recordingRing.borderColor = NotchPalette.accent.cgColor
        recordingRing.removeAnimation(forKey: "pulse")
        guard isRecording else {
            recordingRing.opacity = 0
            return
        }
        recordingRing.opacity = 1
        guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { return }
        let pulse = CABasicAnimation(keyPath: "opacity")
        pulse.fromValue = 1.0
        pulse.toValue = 0.35
        pulse.duration = 0.7
        pulse.autoreverses = true
        pulse.repeatCount = .infinity
        pulse.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        recordingRing.add(pulse, forKey: "pulse")
    }

    // MARK: Drawing

    private var isDarkAppearance: Bool {
        effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let b = bounds

        // Hover / recording backdrop: a quiet chip so the click target reads as one control.
        if hovering || isRecording {
            let chip = NSBezierPath(roundedRect: b, xRadius: 9, yRadius: 9)
            NSColor.labelColor.withAlphaComponent(isRecording ? 0.045 : 0.06).setFill()
            chip.fill()
        }

        if isRecording {
            let attrs: [NSAttributedString.Key: Any] = [
                .font: promptFont, .foregroundColor: NSColor.secondaryLabelColor,
            ]
            let s = (promptText as NSString).size(withAttributes: attrs)
            (promptText as NSString).draw(
                at: NSPoint(x: b.midX - s.width / 2, y: b.midY - s.height / 2), withAttributes: attrs)
            return
        }

        let keys = KeycapChipView.caps(from: combo)
        let widths = capWidths(keys)
        let total = widths.reduce(0, +) + gap * CGFloat(max(0, keys.count - 1))
        var x = b.midX - total / 2
        let dark = isDarkAppearance
        let radius = capSize * 0.24

        for (i, key) in keys.enumerated() {
            let w = widths[i]
            let r = NSRect(x: x, y: b.midY - capSize / 2, width: w, height: capSize)
            let path = NSBezierPath(roundedRect: r, xRadius: radius, yRadius: radius)

            // Seat shadow below the cap, then a top-lit face, an upper highlight, a hairline rim.
            ctx.saveGState()
            ctx.setShadow(offset: CGSize(width: 0, height: -1.5), blur: 3,
                          color: NSColor.black.withAlphaComponent(dark ? 0.45 : 0.18).cgColor)
            (dark ? NSColor(srgbRed: 0.10, green: 0.12, blue: 0.22, alpha: 1)
                  : NSColor(white: 0.99, alpha: 1)).setFill()
            path.fill()
            ctx.restoreGState()

            if dark {
                NSGradient(starting: NSColor(srgbRed: 0.21, green: 0.24, blue: 0.40, alpha: 1),
                           ending: NSColor(srgbRed: 0.11, green: 0.13, blue: 0.25, alpha: 1))?
                    .draw(in: path, angle: -90)
            } else {
                NSGradient(starting: NSColor(white: 1.0, alpha: 1),
                           ending: NSColor(white: 0.93, alpha: 1))?
                    .draw(in: path, angle: -90)
            }
            if isConflicted {
                NSColor.systemRed.withAlphaComponent(dark ? 0.16 : 0.10).setFill()
                path.fill()
            }

            ctx.saveGState()
            path.addClip()
            let hi = notchGradient([
                (NSColor(white: 1, alpha: dark ? 0.20 : 0.85), 0),
                (NSColor(white: 1, alpha: 0.0), 1),
            ])
            ctx.drawLinearGradient(hi, start: CGPoint(x: r.midX, y: r.maxY),
                                   end: CGPoint(x: r.midX, y: r.maxY - capSize * 0.45), options: [])
            ctx.restoreGState()

            path.lineWidth = 1
            (isConflicted
                ? NSColor.systemRed.withAlphaComponent(0.55)
                : (dark ? NSColor(white: 1, alpha: 0.17) : NSColor(white: 0, alpha: 0.14))).setStroke()
            path.stroke()

            let labelColor: NSColor = isConflicted
                ? .systemRed
                : (dark ? NSColor(white: 1, alpha: 0.95) : NSColor(white: 0.13, alpha: 1))
            let attrs: [NSAttributedString.Key: Any] = [.font: capFont, .foregroundColor: labelColor]
            let ts = (key as NSString).size(withAttributes: attrs)
            (key as NSString).draw(
                at: NSPoint(x: r.midX - ts.width / 2, y: r.midY - ts.height / 2), withAttributes: attrs)
            x += w + gap
        }
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
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

    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }
    override func mouseUp(with event: NSEvent) {
        if bounds.contains(convert(event.locationInWindow, from: nil)), !isRecording { onBeginRecord?() }
    }

    override func accessibilityPerformPress() -> Bool {
        if !isRecording { onBeginRecord?() }
        return true
    }
}

// MARK: - Hotkey settings

/// The recordable hotkey rows. Clicking a row's keycaps arms a local key monitor that captures
/// the next modifier+key combo and persists it; Esc cancels a recording.
final class HotkeySettingsViewController: NSViewController {
    var onChange: (() -> Void)?

    private var capture = Settings.shared.captureCombo
    private var context = Settings.shared.contextCombo
    private var personality = Settings.shared.personalityCombo
    private var toggle = Settings.shared.toggleCombo
    private var autoMode = Settings.shared.autoModeCombo
    private var recording: String?          // "capture" | "context" | "personality" | "toggle" | "autoMode" | nil
    private var monitor: Any?

    private let captureControl = HotkeyRecorderControl(combo: Settings.shared.captureCombo)
    private let contextControl = HotkeyRecorderControl(combo: Settings.shared.contextCombo)
    private let personalityControl = HotkeyRecorderControl(combo: Settings.shared.personalityCombo)
    private let toggleControl = HotkeyRecorderControl(combo: Settings.shared.toggleCombo)
    private let autoControl = HotkeyRecorderControl(combo: Settings.shared.autoModeCombo)
    private let rowYs: [CGFloat] = [8, 46, 84, 122, 160]
    private let hint = HotkeySettingsViewController.makeLabel(
        "", size: 11, weight: .regular, color: .secondaryLabelColor)
    private var conflictObserver: Any?

    override func loadView() {
        let root = FlippedView(frame: NSRect(x: 0, y: 0, width: 420, height: 266))

        let rows: [(String, HotkeyRecorderControl, String)] = [
            (L10n.t("截屏讲题（学习辅导）", "解説キャプチャ（学習）", "Capture & tutor"),
             captureControl, "capture"),
            (L10n.t("上下文追问（附上次截图）", "文脈つき質問（前回のキャプチャを添付）", "Ask with context (last shot attached)"),
             contextControl, "context"),
            (L10n.t("截屏作答（性格测试）", "回答キャプチャ（性格検査）", "Capture & answer (personality)"),
             personalityControl, "personality"),
            (L10n.t("显示 / 隐藏", "表示 / 非表示", "Show / hide"),
             toggleControl, "toggle"),
            (L10n.t("自动连答（开始 / 停止）", "自動連続回答（開始 / 停止）", "Auto session (start / stop)"),
             autoControl, "autoMode"),
        ]
        for (i, (title, control, which)) in rows.enumerated() {
            let label = Self.makeLabel(title, size: 13, weight: .regular, color: .labelColor)
            label.frame = NSRect(x: 20, y: rowYs[i] + 8, width: 214, height: 18)
            root.addSubview(label)
            control.setAccessibilityLabel(title)
            control.onBeginRecord = { [weak self] in self?.record(which) }
            root.addSubview(control)
        }

        hint.frame = NSRect(x: 20, y: 204, width: 380, height: 40)
        hint.maximumNumberOfLines = 2
        hint.lineBreakMode = .byWordWrapping
        root.addSubview(hint)

        // A combo another app already owns is dead silently — repaint the moment that verdict
        // changes (re-registration happens whenever any combo is edited).
        conflictObserver = NotificationCenter.default.addObserver(
            forName: HotKeyCenter.conflictsDidChange, object: nil, queue: .main
        ) { [weak self] _ in self?.updateControls() }

        view = root
        updateControls()

        #if DEBUG
        // Visual-QA: NSPI_QA_RECORDING=<role> opens the page mid-recording so the pulsing ring
        // and prompt state can be screenshotted without a pointer click.
        if let role = ProcessInfo.processInfo.environment["NSPI_QA_RECORDING"], !role.isEmpty {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in self?.record(role) }
        }
        #endif
    }

    private func record(_ which: String) {
        stop()
        recording = which
        updateControls()
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self else { return event }
            if event.keyCode == 53 { // Esc backs out of the recording, leaving the combo as-is
                self.recording = nil
                self.stop()
                self.updateControls()
                return nil
            }
            let mods = carbonModifiers(from: event.modifierFlags)
            if mods == 0 { return nil } // need at least one modifier; swallow bare keys
            let combo = HotkeyCombo(keyCode: UInt32(event.keyCode), modifiers: mods, label: keyLabel(for: event))
            switch which {
            case "capture":
                self.capture = combo
                Settings.shared.captureCombo = combo
            case "context":
                self.context = combo
                Settings.shared.contextCombo = combo
            case "personality":
                self.personality = combo
                Settings.shared.personalityCombo = combo
            case "autoMode":
                self.autoMode = combo
                Settings.shared.autoModeCombo = combo
            default:
                self.toggle = combo
                Settings.shared.toggleCombo = combo
            }
            self.recording = nil
            self.stop()
            self.updateControls()
            self.onChange?()
            return nil // consume
        }
    }

    private func stop() {
        if let m = monitor { NSEvent.removeMonitor(m); monitor = nil }
    }

    private func updateControls() {
        let taken = HotKeyCenter.shared.conflicted
        let rows: [(HotkeyRecorderControl, HotkeyRole, HotkeyCombo, CGFloat)] = [
            (captureControl, .capture, capture, rowYs[0]),
            (contextControl, .context, context, rowYs[1]),
            (personalityControl, .personality, personality, rowYs[2]),
            (toggleControl, .toggle, toggle, rowYs[3]),
            (autoControl, .autoMode, autoMode, rowYs[4]),
        ]
        for (control, role, combo, y) in rows {
            control.combo = combo
            control.isConflicted = taken.contains(role)
            control.isRecording = recording == role.rawValue
            // Keycap rows are content-sized and right-aligned; re-seat after every state change.
            let w = control.intrinsicContentSize.width
            control.frame = NSRect(x: 420 - 20 - w, y: y, width: w, height: 34)
        }
        hint.stringValue = taken.isEmpty
            ? L10n.t("点击右侧键帽，然后按下新的组合键（需包含 ⌘/⇧/⌥/⌃ 至少一个）。",
                     "右のキーをクリックし、新しいキーの組み合わせを押してください（⌘/⇧/⌥/⌃ のいずれかが必要）。",
                     "Click the keycaps, then press the new combo (must include at least one of ⌘/⇧/⌥/⌃).")
            : L10n.t("红色的组合键没能注册成功（和另一行重复，或被其他 App 占用），按下它不会有反应——点它换一个。",
                     "赤いキーの組み合わせは登録できませんでした（他の行と重複、または他のアプリが使用中）。押しても反応しません — クリックして変更してください。",
                     "The combo in red could not be registered (it duplicates another row, or another app holds it) — pressing it does nothing. Click it to pick another.")
        hint.textColor = taken.isEmpty ? .secondaryLabelColor : .systemRed
    }

    deinit {
        stop()
        if let conflictObserver { NotificationCenter.default.removeObserver(conflictObserver) }
    }

    private static func makeLabel(_ text: String, size: CGFloat, weight: NSFont.Weight, color: NSColor) -> NSTextField {
        let f = NSTextField(labelWithString: text)
        f.font = .systemFont(ofSize: size, weight: weight)
        f.textColor = color
        return f
    }
}

// MARK: - Persona manager (人物像 library)

/// A transparent, borderless scroll — the rounded hairline card behind it (see `cardBox`)
/// provides the surface, replacing the dated bezel border.
private final class HairlineCardScrollView: NSScrollView {
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        borderType = .noBorder
        drawsBackground = false
        contentView.drawsBackground = false   // the clip view too, or light mode paints it white
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    /// Swapping the documentView installs a fresh clip view configuration — keep it transparent.
    override var documentView: NSView? {
        didSet { contentView.drawsBackground = false }
    }
}

/// A faintly elevated rounded card with a hairline rim, drawn in draw(_:) so the dynamic colors
/// resolve per appearance on every repaint (layer/box styling proved unreliable here). Purely
/// decorative — never intercepts the scroll view sitting on top of it.
private final class CardSurfaceView: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func draw(_ dirtyRect: NSRect) {
        let r = bounds.insetBy(dx: 0.5, dy: 0.5)
        let path = NSBezierPath(roundedRect: r, xRadius: 10, yRadius: 10)
        NSColor.labelColor.withAlphaComponent(0.045).setFill()
        path.fill()
        path.lineWidth = 1
        NSColor.labelColor.withAlphaComponent(0.12).setStroke()
        path.stroke()
    }
}

private func cardBox(frame: NSRect) -> NSView {
    CardSurfaceView(frame: frame)
}

/// One persona row: an accent presence dot marks the active persona (the one captures follow),
/// replacing the old "✓ " text prefix.
private final class PersonaCellView: NSTableCellView {
    private let dot = NSView()
    private let name = NSTextField(labelWithString: "")

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        dot.translatesAutoresizingMaskIntoConstraints = false
        dot.wantsLayer = true
        dot.layer?.cornerRadius = 3
        addSubview(dot)
        name.translatesAutoresizingMaskIntoConstraints = false
        name.lineBreakMode = .byTruncatingTail
        addSubview(name)
        textField = name
        NSLayoutConstraint.activate([
            dot.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 6),
            dot.centerYAnchor.constraint(equalTo: centerYAnchor),
            dot.widthAnchor.constraint(equalToConstant: 6),
            dot.heightAnchor.constraint(equalToConstant: 6),
            name.leadingAnchor.constraint(equalTo: dot.trailingAnchor, constant: 8),
            name.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -6),
            name.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func configure(name text: String, isActive: Bool) {
        name.stringValue = text
        name.font = .systemFont(ofSize: 13, weight: isActive ? .semibold : .regular)
        dot.layer?.backgroundColor = NotchPalette.accent.cgColor
        dot.isHidden = !isActive
    }
}

/// Manage and switch between multiple target personas (人物像): a list on the left (with the
/// active one checked) plus a name + description editor on the right. Every edit commits live to
/// `PersonaStore`, which mirrors the active persona into `Settings` so the next 性格测试 capture
/// uses it. Modeled on notchmeet's script library (list ↔ editor, one active item), in NotchSPI's
/// plain-AppKit settings style.
final class PersonaManagerViewController: NSViewController, NSTableViewDataSource, NSTableViewDelegate,
                                          NSTextFieldDelegate, NSTextViewDelegate {
    var onChange: (() -> Void)?

    private let store = PersonaStore.shared
    private var selectedID: String?

    private let table = NSTableView()
    private let listScroll = HairlineCardScrollView()
    private let addButton = NSButton()
    private let deleteButton = NSButton()

    private let nameField = NSTextField()
    private let descTextView = NSTextView()
    private let descScroll = HairlineCardScrollView()
    private let setActiveButton = NSButton()
    private let emptyHint = NSTextField(labelWithString: "")
    private var editorViews: [NSView] = []   // hidden together when nothing is selected

    private static let cellID = NSUserInterfaceItemIdentifier("personaCell")

    override func loadView() {
        let root = FlippedView(frame: NSRect(x: 0, y: 0, width: 640, height: 450))

        // Left: list + add/delete.
        configureList()
        listScroll.frame = NSRect(x: 20, y: 46, width: 196, height: 344)
        root.addSubview(cardBox(frame: listScroll.frame))
        root.addSubview(listScroll)

        configureBarButton(addButton, title: "＋", action: #selector(addPersona))
        addButton.frame = NSRect(x: 20, y: 396, width: 30, height: 24)
        addButton.toolTip = L10n.t("新建人物像", "人物像を新規作成", "New persona")
        root.addSubview(addButton)

        configureBarButton(deleteButton, title: "－", action: #selector(deletePersona))
        deleteButton.frame = NSRect(x: 52, y: 396, width: 30, height: 24)
        deleteButton.toolTip = L10n.t("删除所选人物像", "選択した人物像を削除", "Delete selected persona")
        root.addSubview(deleteButton)

        // Right: editor for the selected persona (the two cards carry the split; no divider).
        let nameCaption = Self.makeLabel(L10n.t("名称", "名前", "Name"), size: 11, weight: .regular, color: .secondaryLabelColor)
        nameCaption.frame = NSRect(x: 252, y: 16, width: 368, height: 16)
        root.addSubview(nameCaption)

        nameField.frame = NSRect(x: 252, y: 36, width: 368, height: 24)
        nameField.placeholderString = L10n.t("例如：A社 求める人物像", "例：A社 求める人物像", "e.g. Company A ideal candidate")
        nameField.font = .systemFont(ofSize: 13)
        nameField.delegate = self
        root.addSubview(nameField)

        let descCaption = Self.makeLabel(
            L10n.t("人物像描述（截图作答时答案会尽量贴合）",
                   "人物像の説明（回答はこの像に沿うよう選ばれます）",
                   "Persona description (answers will lean toward this profile)"),
            size: 11, weight: .regular, color: .secondaryLabelColor)
        descCaption.frame = NSRect(x: 252, y: 72, width: 368, height: 16)
        root.addSubview(descCaption)

        configureDescEditor()
        descScroll.frame = NSRect(x: 252, y: 94, width: 368, height: 236)
        let descCard = cardBox(frame: descScroll.frame)
        root.addSubview(descCard)
        root.addSubview(descScroll)

        setActiveButton.title = L10n.t("设为当前人物像", "この人物像を使用", "Use this persona")
        setActiveButton.bezelStyle = .rounded
        setActiveButton.target = self
        setActiveButton.action = #selector(setActiveTapped)
        setActiveButton.frame = NSRect(x: 252, y: 342, width: 200, height: 28)
        root.addSubview(setActiveButton)

        let example = Self.makeLabel(
            L10n.t("例：", "例：", "e.g. ") + "●創意と挑戦心を持ち、主体的に行動できる方 ●変化を常とし、外的変化へ柔軟に適応できる方 ●チームワークを重要視し、協調性を発揮できる方",
            size: 10.5, weight: .regular, color: .tertiaryLabelColor)
        example.frame = NSRect(x: 252, y: 382, width: 368, height: 52)
        example.maximumNumberOfLines = 3
        example.lineBreakMode = .byWordWrapping
        root.addSubview(example)

        editorViews = [nameCaption, nameField, descCaption, descCard, descScroll, setActiveButton, example]

        emptyHint.stringValue = L10n.t("还没有人物像。\n点击左下「＋」新建一个。",
                                       "人物像がまだありません。\n左下の「＋」で作成できます。",
                                       "No personas yet.\nCreate one with + below.")
        emptyHint.font = .systemFont(ofSize: 12.5)
        emptyHint.textColor = .tertiaryLabelColor
        emptyHint.alignment = .center
        emptyHint.maximumNumberOfLines = 2
        emptyHint.frame = NSRect(x: 252, y: 190, width: 368, height: 44)
        root.addSubview(emptyHint)

        view = root

        selectedID = store.activeID ?? store.all.first?.id
        reselectRow()
        loadEditor()
    }

    // MARK: - List

    private func configureList() {
        listScroll.hasVerticalScroller = true

        table.backgroundColor = .clear   // the hairline card behind provides the surface
        table.headerView = nil
        table.rowHeight = 28
        table.style = .inset   // modern rounded selection inside the hairline card
        table.intercellSpacing = NSSize(width: 0, height: 2)
        table.selectionHighlightStyle = .regular
        table.allowsEmptySelection = true
        table.allowsMultipleSelection = false
        table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle // single column fills the width
        let col = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("name"))
        col.width = 192
        table.addTableColumn(col)
        table.dataSource = self
        table.delegate = self
        table.target = self
        table.doubleAction = #selector(setActiveTapped)
        listScroll.documentView = table
    }

    func numberOfRows(in tableView: NSTableView) -> Int { store.all.count }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard row < store.all.count else { return nil }
        let persona = store.all[row]
        let cell: PersonaCellView
        if let reused = tableView.makeView(withIdentifier: Self.cellID, owner: self) as? PersonaCellView {
            cell = reused
        } else {
            cell = PersonaCellView()
            cell.identifier = Self.cellID
        }
        let name = persona.name.isEmpty ? L10n.t("未命名人物像", "無題の人物像", "Untitled persona") : persona.name
        cell.configure(name: name, isActive: persona.id == store.activeID)
        return cell
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        let row = table.selectedRow
        selectedID = (row >= 0 && row < store.all.count) ? store.all[row].id : nil
        loadEditor()
    }

    // MARK: - Editor

    private func configureDescEditor() {
        descScroll.hasVerticalScroller = true

        descTextView.drawsBackground = false   // the hairline card behind provides the surface
        descTextView.font = .systemFont(ofSize: 12.5)
        descTextView.isEditable = true
        descTextView.isSelectable = true
        descTextView.isRichText = false
        descTextView.textContainerInset = NSSize(width: 8, height: 8)
        descTextView.isVerticallyResizable = true
        descTextView.isHorizontallyResizable = false
        descTextView.textContainer?.widthTracksTextView = true
        descTextView.minSize = .zero
        descTextView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        descTextView.autoresizingMask = [.width]
        descTextView.delegate = self
        descScroll.documentView = descTextView
    }

    /// Reflect the selected persona into the editor, or hide the editor and show a hint when
    /// nothing is selected (no personas yet).
    private func loadEditor() {
        let persona = selectedID.flatMap { id in store.all.first { $0.id == id } }
        let hasSelection = persona != nil
        editorViews.forEach { $0.isHidden = !hasSelection }
        emptyHint.isHidden = hasSelection
        nameField.stringValue = persona?.name ?? ""
        descTextView.string = persona?.text ?? ""
        updateActiveButton()
    }

    private func updateActiveButton() {
        let isActive = selectedID != nil && selectedID == store.activeID
        setActiveButton.title = isActive
            ? L10n.t("✓ 当前人物像", "✓ 使用中", "✓ In use")
            : L10n.t("设为当前人物像", "この人物像を使用", "Use this persona")
        setActiveButton.isEnabled = selectedID != nil && !isActive
    }

    // Live commit so the next ⌘⇧2 uses the latest text — programmatic `stringValue`/`string`
    // assignments in `loadEditor` don't fire these, so there's no feedback loop.
    func controlTextDidChange(_ obj: Notification) {
        guard let id = selectedID else { return }
        store.update(id: id, name: nameField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines))
        if let row = store.all.firstIndex(where: { $0.id == id }) {
            table.reloadData(forRowIndexes: IndexSet(integer: row), columnIndexes: IndexSet(integer: 0))
        }
        onChange?()
    }

    func textDidChange(_ notification: Notification) {
        guard let id = selectedID else { return }
        store.update(id: id, text: descTextView.string)
        onChange?()
    }

    // MARK: - Actions

    @objc private func addPersona() {
        let id = store.add(name: L10n.t("新的人物像", "新しい人物像", "New persona"), text: "")
        selectedID = id
        table.reloadData()
        reselectRow()
        loadEditor()
        view.window?.makeFirstResponder(nameField)
        nameField.selectText(nil)
        onChange?()
    }

    @objc private func deletePersona() {
        guard let id = selectedID, let persona = store.all.first(where: { $0.id == id }) else { return }
        let alert = NSAlert()
        let shownName = persona.name.isEmpty ? L10n.t("未命名", "無題", "Untitled") : persona.name
        alert.messageText = L10n.t("删除人物像「\(shownName)」？", "人物像「\(shownName)」を削除しますか？", "Delete persona \"\(shownName)\"?")
        alert.informativeText = L10n.t("删除后无法恢复。", "この操作は取り消せません。", "This cannot be undone.")
        alert.alertStyle = .warning
        alert.addButton(withTitle: L10n.delete)
        alert.addButton(withTitle: L10n.cancel)
        let perform = { [weak self] in
            guard let self else { return }
            self.store.remove(id: id)
            self.selectedID = self.store.all.first?.id
            self.table.reloadData()
            self.reselectRow()
            self.loadEditor()
            self.onChange?()
        }
        if let window = view.window {
            alert.beginSheetModal(for: window) { if $0 == .alertFirstButtonReturn { perform() } }
        } else if alert.runModal() == .alertFirstButtonReturn {
            perform()
        }
    }

    @objc private func setActiveTapped() {
        guard let id = selectedID, id != store.activeID else { return }
        store.setActive(id)
        table.reloadData()
        reselectRow()
        updateActiveButton()
        onChange?()
    }

    /// Re-sync table + editor with the store (e.g. after the gear menu switched the active persona).
    func reloadFromStore() {
        if selectedID == nil || !store.all.contains(where: { $0.id == selectedID }) {
            selectedID = store.activeID ?? store.all.first?.id
        }
        table.reloadData()
        reselectRow()
        loadEditor()
    }

    private func reselectRow() {
        if let id = selectedID, let row = store.all.firstIndex(where: { $0.id == id }) {
            table.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
        } else {
            table.deselectAll(nil)
        }
    }

    private func configureBarButton(_ button: NSButton, title: String, action: Selector) {
        button.title = title
        button.bezelStyle = .rounded
        button.font = .systemFont(ofSize: 15, weight: .medium)
        button.target = self
        button.action = action
    }

    private static func makeLabel(_ text: String, size: CGFloat, weight: NSFont.Weight, color: NSColor) -> NSTextField {
        let f = NSTextField(labelWithString: text)
        f.font = .systemFont(ofSize: size, weight: weight)
        f.textColor = color
        return f
    }
}
