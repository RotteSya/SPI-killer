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

// MARK: - Hotkey settings

/// AppKit replacement for the SwiftUI `HotkeySettingsView`: two recordable hotkey rows. Clicking a
/// row's button arms a local key monitor that captures the next modifier+key combo and persists it.
final class HotkeySettingsViewController: NSViewController {
    var onChange: (() -> Void)?

    private var capture = Settings.shared.captureCombo
    private var personality = Settings.shared.personalityCombo
    private var toggle = Settings.shared.toggleCombo
    private var autoMode = Settings.shared.autoModeCombo
    private var recording: String?          // "capture" | "personality" | "toggle" | "autoMode" | nil
    private var monitor: Any?

    private let captureButton = HotkeySettingsViewController.makeRecordButton()
    private let personalityButton = HotkeySettingsViewController.makeRecordButton()
    private let toggleButton = HotkeySettingsViewController.makeRecordButton()
    private let autoButton = HotkeySettingsViewController.makeRecordButton()
    private let hint = HotkeySettingsViewController.makeLabel(
        "", size: 11, weight: .regular, color: .secondaryLabelColor)
    private var conflictObserver: Any?

    override func loadView() {
        let root = FlippedView(frame: NSRect(x: 0, y: 0, width: 420, height: 228))

        addRow(into: root, y: 8,
               title: L10n.t("截屏讲题（学习辅导）", "解説キャプチャ（学習）", "Capture & tutor"),
               button: captureButton, action: #selector(recordCapture))
        addRow(into: root, y: 46,
               title: L10n.t("截屏作答（性格测试）", "回答キャプチャ（性格検査）", "Capture & answer (personality)"),
               button: personalityButton, action: #selector(recordPersonality))
        addRow(into: root, y: 84,
               title: L10n.t("显示 / 隐藏", "表示 / 非表示", "Show / hide"),
               button: toggleButton, action: #selector(recordToggle))
        addRow(into: root, y: 122,
               title: L10n.t("自动连答（开始 / 停止）", "自動連続回答（開始 / 停止）", "Auto session (start / stop)"),
               button: autoButton, action: #selector(recordAutoMode))

        hint.frame = NSRect(x: 20, y: 166, width: 380, height: 40)
        hint.maximumNumberOfLines = 2
        hint.lineBreakMode = .byWordWrapping
        root.addSubview(hint)

        // A combo another app already owns is dead silently — repaint the moment that verdict
        // changes (re-registration happens whenever any combo is edited).
        conflictObserver = NotificationCenter.default.addObserver(
            forName: HotKeyCenter.conflictsDidChange, object: nil, queue: .main
        ) { [weak self] _ in self?.updateButtons() }

        view = root
        updateButtons()
    }

    private func addRow(into root: NSView, y: CGFloat, title: String, button: NSButton, action: Selector) {
        let label = Self.makeLabel(title, size: 13, weight: .regular, color: .labelColor)
        label.frame = NSRect(x: 20, y: y + 4, width: 220, height: 18)
        root.addSubview(label)

        button.target = self
        button.action = action
        button.frame = NSRect(x: 420 - 20 - 150, y: y, width: 150, height: 28)
        root.addSubview(button)
    }

    @objc private func recordCapture() { record("capture") }
    @objc private func recordPersonality() { record("personality") }
    @objc private func recordToggle() { record("toggle") }
    @objc private func recordAutoMode() { record("autoMode") }

    private func record(_ which: String) {
        stop()
        recording = which
        updateButtons()
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self else { return event }
            let mods = carbonModifiers(from: event.modifierFlags)
            if mods == 0 { return nil } // need at least one modifier; swallow bare keys
            let combo = HotkeyCombo(keyCode: UInt32(event.keyCode), modifiers: mods, label: keyLabel(for: event))
            switch which {
            case "capture":
                self.capture = combo
                Settings.shared.captureCombo = combo
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
            self.updateButtons()
            self.onChange?()
            return nil // consume
        }
    }

    private func stop() {
        if let m = monitor { NSEvent.removeMonitor(m); monitor = nil }
    }

    private func updateButtons() {
        let recordingLabel = L10n.t("按下快捷键…", "キーを押す…", "Press keys…")
        let taken = HotKeyCenter.shared.conflicted
        func paint(_ button: NSButton, _ role: HotkeyRole, _ combo: HotkeyCombo) {
            if recording == role.rawValue {
                button.attributedTitle = NSAttributedString(
                    string: recordingLabel, attributes: [.font: button.font as Any])
                return
            }
            // A taken combo reads in red: the row itself says which keystroke is going nowhere.
            let color: NSColor = taken.contains(role) ? .systemRed : .labelColor
            button.attributedTitle = NSAttributedString(
                string: Settings.displayString(combo),
                attributes: [.font: button.font as Any, .foregroundColor: color])
        }
        paint(captureButton, .capture, capture)
        paint(personalityButton, .personality, personality)
        paint(toggleButton, .toggle, toggle)
        paint(autoButton, .autoMode, autoMode)
        hint.stringValue = taken.isEmpty
            ? L10n.t("点击右侧按钮，然后按下新的组合键（需包含 ⌘/⇧/⌥/⌃ 至少一个）。",
                     "右のボタンをクリックし、新しいキーの組み合わせを押してください（⌘/⇧/⌥/⌃ のいずれかが必要）。",
                     "Click a button, then press the new combo (must include at least one of ⌘/⇧/⌥/⌃).")
            : L10n.t("红色的组合键没能注册成功（和另一行重复，或被其他 App 占用），按下它不会有反应——点右侧按钮换一个。",
                     "赤いキーの組み合わせは登録できませんでした（他の行と重複、または他のアプリが使用中）。押しても反応しません — 右のボタンで変更してください。",
                     "The combo in red could not be registered (it duplicates another row, or another app holds it) — pressing it does nothing. Click the button to pick another.")
        hint.textColor = taken.isEmpty ? .secondaryLabelColor : .systemRed
    }

    deinit {
        stop()
        if let conflictObserver { NotificationCenter.default.removeObserver(conflictObserver) }
    }

    private static func makeRecordButton() -> NSButton {
        let b = NSButton(title: "", target: nil, action: nil)
        b.bezelStyle = .rounded
        b.font = .monospacedSystemFont(ofSize: 13, weight: .medium)
        return b
    }

    private static func makeLabel(_ text: String, size: CGFloat, weight: NSFont.Weight, color: NSColor) -> NSTextField {
        let f = NSTextField(labelWithString: text)
        f.font = .systemFont(ofSize: size, weight: weight)
        f.textColor = color
        return f
    }
}

// MARK: - Persona manager (人物像 library)

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
    private let listScroll = NSScrollView()
    private let addButton = NSButton()
    private let deleteButton = NSButton()

    private let nameField = NSTextField()
    private let descTextView = NSTextView()
    private let descScroll = NSScrollView()
    private let setActiveButton = NSButton()
    private let emptyHint = NSTextField(labelWithString: "")
    private var editorViews: [NSView] = []   // hidden together when nothing is selected

    private static let cellID = NSUserInterfaceItemIdentifier("personaCell")

    override func loadView() {
        let root = FlippedView(frame: NSRect(x: 0, y: 0, width: 640, height: 450))

        // Left: list + add/delete.
        configureList()
        listScroll.frame = NSRect(x: 20, y: 46, width: 196, height: 344)
        root.addSubview(listScroll)

        configureBarButton(addButton, title: "＋", action: #selector(addPersona))
        addButton.frame = NSRect(x: 20, y: 396, width: 30, height: 24)
        addButton.toolTip = L10n.t("新建人物像", "人物像を新規作成", "New persona")
        root.addSubview(addButton)

        configureBarButton(deleteButton, title: "－", action: #selector(deletePersona))
        deleteButton.frame = NSRect(x: 52, y: 396, width: 30, height: 24)
        deleteButton.toolTip = L10n.t("删除所选人物像", "選択した人物像を削除", "Delete selected persona")
        root.addSubview(deleteButton)

        // Divider.
        let divider = NSBox(frame: NSRect(x: 232, y: 16, width: 1, height: 418))
        divider.boxType = .separator
        root.addSubview(divider)

        // Right: editor for the selected persona.
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

        editorViews = [nameCaption, nameField, descCaption, descScroll, setActiveButton, example]

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
        listScroll.borderType = .bezelBorder
        listScroll.hasVerticalScroller = true
        listScroll.drawsBackground = true

        table.headerView = nil
        table.rowHeight = 26
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
        let cell: NSTableCellView
        if let reused = tableView.makeView(withIdentifier: Self.cellID, owner: self) as? NSTableCellView {
            cell = reused
        } else {
            cell = NSTableCellView()
            cell.identifier = Self.cellID
            let tf = NSTextField(labelWithString: "")
            tf.lineBreakMode = .byTruncatingTail
            tf.translatesAutoresizingMaskIntoConstraints = false
            cell.addSubview(tf)
            cell.textField = tf
            NSLayoutConstraint.activate([
                tf.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 6),
                tf.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -6),
                tf.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
            ])
        }
        let isActive = persona.id == store.activeID
        let name = persona.name.isEmpty ? L10n.t("未命名人物像", "無題の人物像", "Untitled persona") : persona.name
        cell.textField?.stringValue = (isActive ? "✓ " : "") + name
        cell.textField?.font = .systemFont(ofSize: 13, weight: isActive ? .semibold : .regular)
        return cell
    }

    func tableViewSelectionDidChange(_ notification: Notification) {
        let row = table.selectedRow
        selectedID = (row >= 0 && row < store.all.count) ? store.all[row].id : nil
        loadEditor()
    }

    // MARK: - Editor

    private func configureDescEditor() {
        descScroll.borderType = .bezelBorder
        descScroll.hasVerticalScroller = true
        descScroll.drawsBackground = true

        descTextView.font = .systemFont(ofSize: 12.5)
        descTextView.isEditable = true
        descTextView.isSelectable = true
        descTextView.isRichText = false
        descTextView.textContainerInset = NSSize(width: 6, height: 6)
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
