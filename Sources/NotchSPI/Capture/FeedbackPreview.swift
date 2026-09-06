import AppKit

@MainActor
enum FeedbackPreview {
    struct Selection {
        let assetIDs: Set<UUID>
        let standardAnswer: String?
        let authorization: FeedbackAuthorization
    }

    static func run(snapshot: QuestionCaptureSnapshot, answer: String) -> Selection? {
        let alert = NSAlert()
        alert.messageText = L10n.t("检查反馈内容与授权", "内容と利用許諾を確認", "Review feedback and permission")
        alert.informativeText = L10n.t(
            "仅导出勾选图片、当前答案和可选标准答案，不会自动发送。授权有效 90 天，收取后仅授权审题成员可访问；到期或撤回时删除收取的材料。外部模型处理需另行同意。本机导出文件由你自行删除。\n支持及撤回：" + FeedbackAuthorization.contact,
            "選択した画像・現在の回答・任意の正解を本機へ保存し、自動送信はしません。許諾は 90 日間有効で、受領後は許可された審査担当者のみ利用します。期限または撤回時に受領資料を削除します。外部モデルでの処理は別の同意が必要です。本機のファイルは自分で削除してください。\n問い合わせ・撤回：" + FeedbackAuthorization.contact,
            "Exports checked images, the current answer and an optional reference answer locally. Nothing is sent automatically. Permission lasts 90 days; only authorized reviewers may access received material, which is deleted at expiry or withdrawal. External model processing needs separate permission. Delete your local exports yourself.\nSupport and withdrawal: " + FeedbackAuthorization.contact)
        let content = Content(snapshot: snapshot, answer: answer)
        let availableHeight = NSScreen.main?.visibleFrame.height ?? 768
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 560, height: min(418, max(180, availableHeight - 340))))
        scroll.documentView = content
        scroll.hasVerticalScroller = true; scroll.autohidesScrollers = true
        scroll.drawsBackground = false
        scroll.setAccessibilityLabel(L10n.t("反馈内容与用途", "内容と用途", "Feedback content and purpose"))
        alert.accessoryView = scroll
        alert.addButton(withTitle: L10n.t("导出到本机", "本機へエクスポート", "Export locally"))
        alert.addButton(withTitle: L10n.t("取消", "キャンセル", "Cancel"))
        alert.buttons[0].isEnabled = false
        content.onConsentChanged = { [weak alert] accepted in alert?.buttons.first?.isEnabled = accepted }
        guard alert.runModal() == .alertFirstButtonReturn, content.authorized else { return nil }
        let standard = content.standard.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return .init(assetIDs: content.selectedIDs, standardAnswer: standard.isEmpty ? nil : standard,
                     authorization: .init(purpose: content.selectedPurpose, rightsConfirmed: true))
    }

    private final class Content: NSView, NSTextFieldDelegate {
        override var isFlipped: Bool { true }
        let standard = NSTextField(string: "")
        private let snapshot: QuestionCaptureSnapshot
        private let image = NSImageView()
        private let selector: NSSegmentedControl
        private let purpose = NSPopUpButton(frame: .zero, pullsDown: false)
        private let permission = NSButton(checkboxWithTitle: "", target: nil, action: nil)
        private var included: [NSButton] = []
        var onConsentChanged: ((Bool) -> Void)?
        var authorized: Bool { permission.state == .on }
        var selectedPurpose: FeedbackPurpose { FeedbackPurpose.allCases[max(0, purpose.indexOfSelectedItem)] }
        var selectedIDs: Set<UUID> { Set(included.enumerated().compactMap { $0.element.state == .on ? snapshot.assets[$0.offset].id : nil }) }

        init(snapshot: QuestionCaptureSnapshot, answer: String) {
            self.snapshot = snapshot
            selector = NSSegmentedControl(labels: snapshot.assets.indices.map { String($0 + 1) }, trackingMode: .selectOne, target: nil, action: nil)
            super.init(frame: NSRect(x: 0, y: 0, width: 560, height: 418))
            image.frame = NSRect(x: 0, y: 0, width: 560, height: 160)
            image.imageScaling = .scaleProportionallyUpOrDown
            image.setAccessibilityLabel(L10n.t("当前图片预览", "現在の画像プレビュー", "Current image preview"))
            addSubview(image)
            selector.frame = NSRect(x: 0, y: 169, width: 360, height: 27)
            selector.selectedSegment = snapshot.assets.isEmpty ? -1 : 0
            selector.target = self; selector.action = #selector(changeImage)
            selector.setAccessibilityLabel(L10n.t("切换预览图片", "プレビュー画像を選択", "Choose preview image"))
            addSubview(selector)
            let full = NSButton(title: L10n.t("打开原图", "元画像を開く", "Open full image"), target: self, action: #selector(openImage))
            full.frame = NSRect(x: 385, y: 169, width: 175, height: 27); addSubview(full)
            for (index, asset) in snapshot.assets.enumerated() {
                let role = asset.id == snapshot.assets.last?.id ? L10n.t("题目", "問題", "Question") : L10n.t("参考", "参考", "Reference")
                let box = NSButton(checkboxWithTitle: "\(index + 1) · \(role)", target: self, action: #selector(permissionScopeChanged))
                box.frame = NSRect(x: CGFloat(index) * 140, y: 205, width: 138, height: 25)
                box.state = .on; included.append(box); addSubview(box)
            }
            let label = NSTextField(labelWithString: L10n.t("将导出的当前答案", "書き出す現在の回答", "Current answer to export"))
            label.frame = NSRect(x: 0, y: 237, width: 560, height: 20); addSubview(label)
            let scroll = NSScrollView(frame: NSRect(x: 0, y: 260, width: 560, height: 46))
            let text = NSTextView(frame: scroll.bounds)
            text.string = answer; text.isEditable = false; text.isSelectable = true
            text.font = .systemFont(ofSize: 12); text.textContainer?.widthTracksTextView = true
            text.isVerticallyResizable = true; text.isHorizontallyResizable = false
            text.setAccessibilityLabel(label.stringValue)
            scroll.documentView = text; scroll.hasVerticalScroller = true; scroll.borderType = .bezelBorder; addSubview(scroll)
            standard.placeholderString = L10n.t("可选：标准答案", "任意：正解", "Optional reference answer")
            standard.setAccessibilityLabel(standard.placeholderString)
            standard.delegate = self
            standard.frame = NSRect(x: 0, y: 317, width: 560, height: 24); addSubview(standard)
            purpose.addItems(withTitles: FeedbackPurpose.allCases.map(\.title)); purpose.selectItem(at: 0)
            purpose.target = self; purpose.action = #selector(permissionScopeChanged)
            purpose.setAccessibilityLabel(L10n.t("允许的用途", "許可する用途", "Allowed purpose"))
            purpose.frame = NSRect(x: 0, y: 350, width: 560, height: 27); addSubview(purpose)
            permission.title = L10n.t("我有权提供所选材料，并同意所选用途", "選択資料を提供する権利があり、選んだ用途に同意します", "I may share this material and authorize the selected purpose.")
            permission.target = self; permission.action = #selector(consentChanged)
            permission.frame = NSRect(x: 0, y: 385, width: 560, height: 30); addSubview(permission)
            changeImage()
        }
        required init?(coder: NSCoder) { nil }
        func controlTextDidChange(_ notification: Notification) { permissionScopeChanged() }
        @objc private func consentChanged() { onConsentChanged?(authorized) }
        @objc private func permissionScopeChanged() { permission.state = .off; onConsentChanged?(false) }
        @objc private func changeImage() {
            let index = selector.selectedSegment
            image.image = snapshot.assets.indices.contains(index) ? NSImage(contentsOf: snapshot.assets[index].file.url) : nil
        }
        @objc private func openImage() {
            let index = selector.selectedSegment
            if snapshot.assets.indices.contains(index) { NSWorkspace.shared.open(snapshot.assets[index].file.url) }
        }
    }
}
