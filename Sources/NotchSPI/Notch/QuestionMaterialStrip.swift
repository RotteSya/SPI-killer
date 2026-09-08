import AppKit

@MainActor
final class QuestionMaterialStrip: NSView {
    var onExplain: (() -> Void)?
    private var explanationAvailable = false
    var onAdd: (() -> Void)?
    var onClear: (() -> Void)?
    var onSelect: (() -> Void)?
    var onRemove: ((UUID) -> Void)?
    private var assets: [ContextAsset] = []
    private var buttons: [MaterialActionButton] = []
    override var isFlipped: Bool { true }

    func update(_ next: [ContextAsset], explanationAvailable: Bool) {
        guard next != assets || buttons.isEmpty || self.explanationAvailable != explanationAvailable else { return }
        self.explanationAvailable = explanationAvailable
        assets = next
        subviews.forEach { $0.removeFromSuperview() }
        buttons = []
        for (ordinal, asset) in next.enumerated() {
            let assetID = asset.id
            let button = MaterialActionButton(title: "\(ordinal + 1) ×") { [weak self] in self?.onRemove?(assetID) }
            button.image = NSImage(contentsOf: asset.file.url)
            button.imagePosition = .imageAbove
            button.imageScaling = .scaleProportionallyDown
            button.toolTip = L10n.t("删除第 \(ordinal + 1) 张材料", "資料 \(ordinal + 1) を削除", "Remove reference \(ordinal + 1)")
            button.setAccessibilityLabel(button.toolTip)
            buttons.append(button); addSubview(button)
        }
        var actions: [(String, () -> Void)] = [
            (L10n.t("补充材料", "資料を追加", "Add material"), { [weak self] in self?.onAdd?() }),
            (L10n.t("框选题目", "範囲を選択", "Select region"), { [weak self] in self?.onSelect?() }),
            (L10n.t("新题组", "新しいグループ", "New group"), { [weak self] in self?.onClear?() }),
        ]
        if explanationAvailable {
            actions.insert((L10n.t("查看解释", "解説を見る", "Explanation"), { [weak self] in self?.onExplain?() }), at: 0)
        }
        for (title, action) in actions {
            let button = MaterialActionButton(title: title, action: action)
            buttons.append(button); addSubview(button)
        }
        needsLayout = true
    }
    override func layout() {
        super.layout()
        var x: CGFloat = 0
        for (index, button) in buttons.enumerated() {
            let width: CGFloat = index < assets.count ? 56 : max(74, button.intrinsicContentSize.width + 4)
            button.frame = NSRect(x: x, y: index < assets.count ? 2 : 24,
                                  width: width, height: index < assets.count ? 66 : 26)
            x += width + 6
        }
    }
}

private final class MaterialActionButton: NSButton {
    private let actionBlock: () -> Void
    // The notch deliberately cannot become key; material actions must still accept clicks.
    override var needsPanelToBecomeKey: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func accessibilityPerformPress() -> Bool {
        guard isEnabled, !isHiddenOrHasHiddenAncestor else { return false }
        actionBlock()
        return true
    }
    init(title: String, action: @escaping () -> Void) {
        self.actionBlock = action
        super.init(frame: .zero)
        self.title = title
        self.target = self
        self.action = #selector(performAction)
        self.bezelStyle = .rounded
        self.controlSize = .small
        self.font = .systemFont(ofSize: 11)
        self.setAccessibilityLabel(title)
    }
    required init?(coder: NSCoder) { nil }
    @objc private func performAction() { actionBlock() }
}
