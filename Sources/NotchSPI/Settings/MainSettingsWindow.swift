import AppKit
import ServiceManagement

// The unified settings window (统一设置): a sidebar of six pages replacing what used to be four
// scattered mini-windows plus an overstuffed gear menu. Native styling (system light/dark),
// fixed-frame layout in flipped containers, live-commit controls — the codebase's house style.
//
//   通用 General    — language, default depth, capture target, launch at login
//   快捷键 Hotkeys  — the three recordable combos (embedded HotkeySettingsViewController)
//   外观 Appearance — accent theme, answer text size, auto-collapse delay
//   账户 Account    — quota ring, top-up, lifetime usage, device id
//   人物像 Personas — the persona library (embedded PersonaManagerViewController)
//   高级 Advanced   — service channel, custom API keys, updates

// MARK: - Window controller

final class MainSettingsWindowController: NSWindowController, NSWindowDelegate {
    enum Page: Int, CaseIterable {
        case general, hotkeys, appearance, account, personas, advanced

        var symbolName: String {
            switch self {
            case .general: return "gearshape"
            case .hotkeys: return "keyboard"
            case .appearance: return "paintpalette"
            case .account: return "creditcard"
            case .personas: return "person.text.rectangle"
            case .advanced: return "wrench.and.screwdriver"
            }
        }

        var localizedTitle: String {
            switch self {
            case .general: return L10n.t("通用", "一般", "General")
            case .hotkeys: return L10n.t("快捷键", "ショートカット", "Hotkeys")
            case .appearance: return L10n.t("外观", "外観", "Appearance")
            case .account: return L10n.t("账户与额度", "アカウントと残高", "Account")
            case .personas: return L10n.t("人物像", "人物像", "Personas")
            case .advanced: return L10n.t("高级", "詳細", "Advanced")
            }
        }
    }

    static let contentSize = NSSize(width: 830, height: 540)
    static let sidebarWidth: CGFloat = 190
    static var pageSize: NSSize { NSSize(width: contentSize.width - sidebarWidth, height: contentSize.height) }

    /// Wired by NotchController so hotkey edits re-register and menu labels refresh.
    var onHotkeysChanged: (() -> Void)?
    var onAnythingChanged: (() -> Void)?

    private let sidebar = SettingsFlippedView()
    private let contentHost = SettingsFlippedView()
    private var rowButtons: [SidebarRowButton] = []
    private var pageControllers: [Page: NSViewController] = [:]
    private var current: Page = .general
    private var observers: [NSObjectProtocol] = []
    /// The sliding selection lozenge behind the sidebar rows — one shared element that glides
    /// from row to row instead of each row repainting its own chosen state.
    private let selectionPill = CALayer()
    /// The page view currently on screen (kept during a transition so an interrupted hand-off
    /// can be cleaned up deterministically).
    private weak var displayedPageView: NSView?

    private var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

    /// Navigation timing. DEBUG-only NSPI_QA_SLOW_NAV=1 stretches it for frame-by-frame QA.
    private static var navTimeScale: CFTimeInterval {
        #if DEBUG
        if ProcessInfo.processInfo.environment["NSPI_QA_SLOW_NAV"] == "1" { return 6 }
        #endif
        return 1
    }

    init() {
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: Self.contentSize),
            styleMask: [.titled, .closable, .miniaturizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.sharingType = ScreenShareGuard.windowSharingType
        window.isReleasedWhenClosed = false
        window.autorecalculatesKeyViewLoop = true
        super.init(window: window)
        window.delegate = self
        buildChrome()
        show(page: .general)

        observers.append(NotificationCenter.default.addObserver(
            forName: L10n.languageDidChange, object: nil, queue: .main
        ) { [weak self] _ in self?.rebuildAfterLanguageChange() })
        // Accent theme switches restyle the live chrome (pill tint, row icons) immediately.
        observers.append(NotificationCenter.default.addObserver(
            forName: Appearance.themeDidChange, object: nil, queue: .main
        ) { [weak self] _ in self?.restyleChrome() })
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    deinit { observers.forEach(NotificationCenter.default.removeObserver) }

    private func buildChrome() {
        guard let window, let root = window.contentView else { return }

        // Sidebar with the standard translucent material.
        let effect = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: Self.sidebarWidth,
                                                      height: Self.contentSize.height))
        effect.material = .sidebar
        effect.blendingMode = .behindWindow
        effect.state = .active
        effect.autoresizingMask = [.height]
        root.addSubview(effect)

        sidebar.frame = effect.bounds
        sidebar.autoresizingMask = [.width, .height]
        effect.addSubview(sidebar)

        contentHost.frame = NSRect(x: Self.sidebarWidth, y: 0,
                                   width: Self.pageSize.width, height: Self.pageSize.height)
        contentHost.autoresizingMask = [.width, .height]
        root.addSubview(contentHost)

        buildSidebarRows()
    }

    private func buildSidebarRows() {
        rowButtons.forEach { $0.removeFromSuperview() }
        rowButtons = []
        // The pill lives on the sidebar's own layer, added before any row subview so it stays
        // beneath every row's hover chip and content.
        sidebar.wantsLayer = true
        if selectionPill.superlayer == nil {
            selectionPill.cornerRadius = 8
            sidebar.layer?.addSublayer(selectionPill)
        }
        var y: CGFloat = 52 // clear the (hidden-title) titlebar / traffic lights
        for page in Page.allCases {
            let row = SidebarRowButton(page: page) { [weak self] in self?.show(page: $0) }
            row.onNavigate = { [weak self] direction in
                guard let self else { return }
                let index = page.rawValue + direction
                guard let next = Page(rawValue: index),
                      let target = self.rowButtons.first(where: { $0.page == next }) else { return }
                self.window?.makeFirstResponder(target)
                self.show(page: next)
            }
            row.frame = NSRect(x: 10, y: y, width: Self.sidebarWidth - 20, height: 34)
            sidebar.addSubview(row)
            rowButtons.append(row)
            y += 38
        }
        restyleChrome()
        movePill(to: current, animated: false)
        highlightRows()
        window?.initialFirstResponder = rowButtons.first(where: { $0.page == current })
    }

    private func highlightRows() {
        for row in rowButtons { row.isChosen = row.page == current }
    }

    /// Re-tint the accent-following chrome after a theme switch (rows redraw; the pill re-fills).
    private func restyleChrome() {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        selectionPill.backgroundColor = NotchPalette.accent.withAlphaComponent(0.22).cgColor
        CATransaction.commit()
        rowButtons.forEach { $0.needsDisplay = true }
    }

    /// Glide the selection lozenge to the given row — the one shared element of the sidebar.
    private func movePill(to page: Page, animated: Bool) {
        guard let row = rowButtons.first(where: { $0.page == page }) else { return }
        let target = row.frame
        guard animated, !reduceMotion, selectionPill.frame.height > 0 else {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            selectionPill.frame = target
            CATransaction.commit()
            return
        }
        let from = selectionPill.presentation()?.position ?? selectionPill.position
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        selectionPill.frame = target
        CATransaction.commit()
        let spring = CASpringAnimation(keyPath: "position")
        spring.fromValue = NSValue(point: NSPoint(x: from.x, y: from.y))
        spring.toValue = NSValue(point: NSPoint(x: selectionPill.position.x, y: selectionPill.position.y))
        spring.mass = 1
        spring.stiffness = 380
        spring.damping = 30
        spring.duration = spring.settlingDuration * Self.navTimeScale
        spring.speed = Float(1 / Self.navTimeScale)
        selectionPill.add(spring, forKey: "glide")
    }

    /// Page hand-off with depth (the onboarding's two-plane language, turned vertical to match
    /// the sidebar's axis): the incoming page springs in from the direction of travel while the
    /// outgoing one yields with a shorter parallax drift. Never a hard cut.
    func show(page: Page) {
        let delta = page.rawValue - current.rawValue
        let vc = pageControllers[page] ?? makeController(for: page)
        pageControllers[page] = vc

        // Already the visible page (a re-click on the current row): just settle the chrome.
        if vc.view === displayedPageView, vc.view.superview != nil {
            current = page
            movePill(to: page, animated: true)
            highlightRows()
            window?.title = page.localizedTitle
            return
        }

        let isInitial = displayedPageView == nil
        current = page
        movePill(to: page, animated: !isInitial)
        highlightRows()
        window?.title = page.localizedTitle

        let incoming = vc.view
        incoming.frame = contentHost.bounds
        let outgoing = displayedPageView
        // An interrupted hand-off may have left a mid-flight page behind — clear it instantly.
        for v in contentHost.subviews where v !== outgoing && v !== incoming { v.removeFromSuperview() }
        displayedPageView = incoming
        contentHost.addSubview(incoming)
        (vc as? SettingsPage)?.pageDidShow()

        guard let outgoing, !isInitial, !reduceMotion else {
            outgoing?.removeFromSuperview()
            return
        }
        incoming.wantsLayer = true
        outgoing.wantsLayer = true
        guard let inLayer = incoming.layer, let outLayer = outgoing.layer else {
            outgoing.removeFromSuperview()
            return
        }

        let dir: CGFloat = delta == 0 ? 0 : (delta > 0 ? 1 : -1)
        let scale = Self.navTimeScale
        CATransaction.begin()
        CATransaction.setCompletionBlock { [weak self, weak outgoing] in
            guard let outgoing, outgoing !== self?.displayedPageView else { return }
            outgoing.removeFromSuperview()
            outgoing.layer?.removeAllAnimations()
            outgoing.alphaValue = 1
        }

        if dir != 0 {
            // Travel axis follows the sidebar: going down the list, content rises from below.
            let slideIn = CASpringAnimation(keyPath: "transform.translation.y")
            slideIn.fromValue = dir * 26
            slideIn.toValue = 0
            slideIn.mass = 1
            slideIn.stiffness = 260
            slideIn.damping = 30
            slideIn.duration = min(slideIn.settlingDuration, 0.7) * scale
            slideIn.speed = Float(1 / scale)
            inLayer.add(slideIn, forKey: "slideIn")

            let slideOut = CABasicAnimation(keyPath: "transform.translation.y")
            slideOut.fromValue = 0
            slideOut.toValue = -dir * 18
            slideOut.duration = 0.26 * scale
            slideOut.timingFunction = CAMediaTimingFunction(controlPoints: 0.3, 0, 0.4, 1)
            slideOut.fillMode = .forwards
            slideOut.isRemovedOnCompletion = false
            outLayer.add(slideOut, forKey: "slideOut")
        }

        let fadeIn = CABasicAnimation(keyPath: "opacity")
        fadeIn.fromValue = 0
        fadeIn.toValue = 1
        fadeIn.duration = 0.24 * scale
        fadeIn.timingFunction = CAMediaTimingFunction(name: .easeOut)
        inLayer.add(fadeIn, forKey: "fadeIn")

        let fadeOut = CABasicAnimation(keyPath: "opacity")
        fadeOut.fromValue = 1
        fadeOut.toValue = 0
        fadeOut.duration = 0.20 * scale
        fadeOut.timingFunction = CAMediaTimingFunction(name: .easeIn)
        fadeOut.fillMode = .forwards
        fadeOut.isRemovedOnCompletion = false
        outLayer.add(fadeOut, forKey: "fadeOut")

        CATransaction.commit()
    }

    private func makeController(for page: Page) -> NSViewController {
        switch page {
        case .general: return GeneralPageController()
        case .hotkeys:
            let vc = HotkeysPageController()
            vc.onChange = { [weak self] in self?.onHotkeysChanged?() }
            return vc
        case .appearance: return AppearancePageController()
        case .account: return AccountPageController()
        case .personas: return PersonasPageController(onChange: { [weak self] in self?.onAnythingChanged?() })
        case .advanced:
            let vc = AdvancedPageController()
            vc.onChange = { [weak self] in self?.onAnythingChanged?() }
            return vc
        }
    }

    /// Language switch: throw away every built page (they hold baked-in strings) and rebuild.
    private func rebuildAfterLanguageChange() {
        pageControllers.removeAll()
        buildSidebarRows()
        show(page: current)
        onAnythingChanged?()
    }

    func open(page: Page) {
        show(page: page)
        if let row = rowButtons.first(where: { $0.page == page }) { window?.makeFirstResponder(row) }
        window?.center()
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        #if DEBUG
        // Visual-QA: print the window number so a shot can target THIS window by id
        // (screencapture -l <id>), grabbing only the app's own pixels — never the whole screen.
        if let n = window?.windowNumber { fputs("[NotchSPI] QA: settings windowNumber \(n)\n", stderr) }
        #endif
    }
}

// MARK: - Sidebar row

private final class SidebarRowButton: NSControl {
    let page: MainSettingsWindowController.Page
    var isChosen = false {
        didSet {
            needsDisplay = true
            if isChosen != oldValue { NSAccessibility.post(element: self, notification: .valueChanged) }
        }
    }
    var onNavigate: ((Int) -> Void)?
    private let onPick: (MainSettingsWindowController.Page) -> Void
    private var hovering = false { didSet { needsDisplay = true } }
    private var trackingAreaRef: NSTrackingArea?

    init(page: MainSettingsWindowController.Page, onPick: @escaping (MainSettingsWindowController.Page) -> Void) {
        self.page = page
        self.onPick = onPick
        super.init(frame: .zero)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var isFlipped: Bool { true }
    override var acceptsFirstResponder: Bool { isEnabled && !isHiddenOrHasHiddenAncestor }
    override var canBecomeKeyView: Bool { acceptsFirstResponder }
    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .radioButton }
    override func accessibilityLabel() -> String? { page.localizedTitle }
    override func accessibilityValue() -> Any? { isChosen ? 1 : 0 }
    override func isAccessibilityEnabled() -> Bool { isEnabled }
    override func accessibilityPerformPress() -> Bool {
        guard acceptsFirstResponder else { return false }
        window?.makeFirstResponder(self)
        onPick(page)
        return true
    }
    override func keyDown(with event: NSEvent) {
        guard acceptsFirstResponder else { return }
        switch event.keyCode {
        case 36, 49, 76: _ = accessibilityPerformPress()
        case 125: onNavigate?(1)
        case 126: onNavigate?(-1)
        default: super.keyDown(with: event)
        }
    }
    override func becomeFirstResponder() -> Bool { needsDisplay = true; return super.becomeFirstResponder() }
    override func resignFirstResponder() -> Bool { needsDisplay = true; return super.resignFirstResponder() }

    override func draw(_ dirtyRect: NSRect) {
        // The chosen backdrop is the window's shared selection pill (it glides between rows);
        // a row only paints its own transient hover chip.
        if hovering && !isChosen {
            let path = NSBezierPath(roundedRect: bounds, xRadius: 8, yRadius: 8)
            NSColor.labelColor.withAlphaComponent(0.06).setFill()
            path.fill()
        }
        let tint: NSColor = isChosen ? NotchPalette.accent : .secondaryLabelColor
        if let img = notchTintedSymbol(page.symbolName, pointSize: 14, weight: .medium, color: tint) {
            let s = img.size
            img.draw(in: NSRect(x: 12, y: bounds.midY - s.height / 2, width: s.width, height: s.height))
        }
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 13, weight: isChosen ? .semibold : .regular),
            .foregroundColor: isChosen ? NSColor.labelColor : NSColor.labelColor.withAlphaComponent(0.85),
        ]
        let title = page.localizedTitle as NSString
        let ts = title.size(withAttributes: attrs)
        title.draw(at: NSPoint(x: 38, y: bounds.midY - ts.height / 2), withAttributes: attrs)
        if window?.firstResponder === self {
            NSColor.keyboardFocusIndicatorColor.setStroke()
            let ring = NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 8, yRadius: 8)
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

// MARK: - Page plumbing

final class SettingsFlippedView: NSView {
    override var isFlipped: Bool { true }
}

private protocol SettingsPage {
    func pageDidShow()
}

private func pageTitleLabel(_ text: String) -> NSTextField {
    let f = NSTextField(labelWithString: text)
    f.font = .systemFont(ofSize: 20, weight: .bold)
    f.textColor = .labelColor
    return f
}

private func captionLabel(_ text: String, size: CGFloat = 11) -> NSTextField {
    let f = NSTextField(wrappingLabelWithString: text)
    f.font = .systemFont(ofSize: size)
    f.textColor = .secondaryLabelColor
    f.isSelectable = false
    return f
}

private func rowLabel(_ text: String) -> NSTextField {
    let f = NSTextField(labelWithString: text)
    f.font = .systemFont(ofSize: 13)
    f.textColor = .labelColor
    return f
}

// MARK: - 通用 General

private final class GeneralPageController: NSViewController, SettingsPage {
    private let languagePopup = NSPopUpButton()
    private let depthPopup = NSPopUpButton()
    private let targetPopup = NSPopUpButton()
    private let autoCapPopup = NSPopUpButton()
    private let loginCheckbox = NSButton(checkboxWithTitle: "", target: nil, action: nil)
    private let loginCaption = captionLabel("")
    private let telemetryCheckbox = NSButton(checkboxWithTitle: "", target: nil, action: nil)

    private static let autoCapChoices = [5, 10, 20, 30, 50]

    private let contentWidth: CGFloat = 560

    override func loadView() {
        let root = SettingsFlippedView(frame: NSRect(origin: .zero, size: MainSettingsWindowController.pageSize))

        let title = pageTitleLabel(L10n.t("通用", "一般", "General"))
        title.frame = NSRect(x: 36, y: 46, width: 300, height: 26)
        root.addSubview(title)

        var y: CGFloat = 100

        // 语言
        addRow(root, y: y, label: L10n.t("语言", "言語", "Language"), control: languagePopup, controlWidth: 200)
        for lang in AppLanguage.allCases {
            languagePopup.addItem(withTitle: lang.pickerLabel)
            languagePopup.lastItem?.representedObject = lang.rawValue
        }
        languagePopup.selectItem(at: AppLanguage.allCases.firstIndex(of: L10n.setting) ?? 0)
        languagePopup.target = self
        languagePopup.action = #selector(languagePicked)
        y += 44

        // 讲解深度
        addRow(root, y: y, label: L10n.t("讲解深度", "解説の詳しさ", "Explanation depth"),
               control: depthPopup, controlWidth: 200)
        for id in Settings.depthCycle {
            depthPopup.addItem(withTitle: L10n.depthLabel(id))
            depthPopup.lastItem?.representedObject = id
        }
        depthPopup.selectItem(at: Settings.depthCycle.firstIndex(of: Settings.shared.depth) ?? 2)
        depthPopup.target = self
        depthPopup.action = #selector(depthPicked)
        let depthHint = captionLabel(L10n.t(
            "简略只给答案；提示不剧透；引导带你一步步走；完整包含全部推导。也可以在刘海上点击胶囊快速切换。",
            "「簡潔」は答えのみ、「ヒント」はネタバレなし、「ガイド」は一歩ずつ、「詳細」は全過程つき。ノッチのカプセルからも切替可能。",
            "Brief gives just the answer; Hints avoid spoilers; Guided walks you through; Full shows every step. You can also cycle via the capsule on the notch."))
        depthHint.frame = NSRect(x: 36 + 160, y: y + 30, width: contentWidth - 160, height: 42)
        root.addSubview(depthHint)
        y += 86

        // 截图目标
        addRow(root, y: y, label: L10n.t("截图目标", "キャプチャ対象", "Capture target"),
               control: targetPopup, controlWidth: 260)
        targetPopup.target = self
        targetPopup.action = #selector(targetPicked)
        y += 44

        // 自动连答上限
        addRow(root, y: y, label: L10n.t("自动连答上限", "自動連続回答の上限", "Auto session cap"),
               control: autoCapPopup, controlWidth: 200)
        for cap in Self.autoCapChoices {
            autoCapPopup.addItem(withTitle: L10n.questions(cap))
            autoCapPopup.lastItem?.representedObject = cap
        }
        autoCapPopup.selectItem(
            at: Self.autoCapChoices.firstIndex(of: Settings.shared.autoModeMaxQuestions) ?? 2)
        autoCapPopup.target = self
        autoCapPopup.action = #selector(autoCapPicked)
        let autoCapHint = captionLabel(L10n.t(
            "自动模式单次会话最多连答的题数，达到后自动停止。下次开启会话时生效。",
            "自動モード1セッションで回答する最大数。上限に達すると自動停止します。次回セッションから有効。",
            "Max questions one auto session will answer before stopping. Applies from the next session."))
        autoCapHint.frame = NSRect(x: 36 + 160, y: y + 30, width: contentWidth - 160, height: 30)
        root.addSubview(autoCapHint)
        y += 72

        // 开机自启
        loginCheckbox.title = L10n.t("登录时自动启动", "ログイン時に自動起動", "Launch at login")
        loginCheckbox.target = self
        loginCheckbox.action = #selector(loginToggled)
        loginCheckbox.frame = NSRect(x: 36 + 160, y: y, width: 300, height: 20)
        root.addSubview(loginCheckbox)
        loginCaption.frame = NSRect(x: 36 + 160, y: y + 24, width: contentWidth - 160, height: 30)
        root.addSubview(loginCaption)
        y += 62

        let privacyLabel = rowLabel(L10n.t("隐私与诊断", "プライバシーと診断", "Privacy & diagnostics"))
        privacyLabel.alignment = .right
        privacyLabel.frame = NSRect(x: 36, y: y + 1, width: 148, height: 18)
        root.addSubview(privacyLabel)
        telemetryCheckbox.title = L10n.t("共享匿名可靠性数据", "匿名の信頼性データを共有", "Share anonymous reliability data")
        telemetryCheckbox.state = ProductTelemetry.shared.sharingEnabled ? .on : .off
        telemetryCheckbox.target = self
        telemetryCheckbox.action = #selector(telemetryToggled)
        telemetryCheckbox.frame = NSRect(x: 36 + 160, y: y, width: 350, height: 20)
        root.addSubview(telemetryCheckbox)
        let telemetryCaption = captionLabel(L10n.t(
            "共享完成状态、场景、耗时、操作和数据缺失记录。关闭后清空待传数据，仅同步共享偏好；必要的计费记录仍会保留。不会上传截图、题目、答案或提示词。",
            "完了状態・用途・時間・操作とデータ欠落を共有します。停止すると送信待ちデータを削除し、共有設定のみ同期します。必要な課金記録は保持します。画像・問題・回答・プロンプトは送信しません。",
            "Shares completion states, profiles, timings, actions, and data gaps. Turning this off clears pending data and syncs only the preference; required billing records remain. Screenshots, questions, answers, and prompts are excluded."))
        telemetryCaption.frame = NSRect(x: 36 + 160, y: y + 24, width: contentWidth - 160, height: 88)
        root.addSubview(telemetryCaption)

        view = root
    }

    private func addRow(_ root: NSView, y: CGFloat, label: String, control: NSControl, controlWidth: CGFloat) {
        let l = rowLabel(label)
        l.alignment = .right
        l.frame = NSRect(x: 36, y: y + 3, width: 148, height: 18)
        root.addSubview(l)
        control.frame = NSRect(x: 36 + 160, y: y, width: controlWidth, height: 26)
        root.addSubview(control)
    }

    func pageDidShow() {
        reloadTargets()
        reloadLoginState()
        telemetryCheckbox.state = ProductTelemetry.shared.sharingEnabled ? .on : .off
    }

    private func reloadTargets() {
        targetPopup.removeAllItems()
        targetPopup.addItem(withTitle: L10n.t("整个屏幕", "画面全体", "Entire screen"))
        targetPopup.lastItem?.representedObject = nil as String?
        let savedID = Settings.shared.captureTargetBundleID
        var matched = savedID == nil
        for app in ScreenCapture.capturableApps() {
            targetPopup.addItem(withTitle: app.name)
            targetPopup.lastItem?.representedObject = app
            if app.bundleID == savedID {
                targetPopup.select(targetPopup.lastItem)
                matched = true
            }
        }
        if !matched, let savedID {
            let gone = Settings.shared.captureTargetName ?? savedID
            targetPopup.addItem(withTitle: gone + L10n.t("（未运行）", "（未起動）", " (not running)"))
            targetPopup.select(targetPopup.lastItem)
        }
    }

    private func reloadLoginState() {
        if Bundle.main.bundleIdentifier != nil {
            loginCheckbox.isEnabled = true
            loginCheckbox.state = SMAppService.mainApp.status == .enabled ? .on : .off
            loginCaption.stringValue = L10n.t("开机后 NotchSPI 安静地待在刘海旁。",
                                              "起動後、NotchSPI はノッチの横で静かに待機します。",
                                              "After login, NotchSPI waits quietly beside the notch.")
        } else {
            // Unbundled `swift run` dev binary — SMAppService needs a real .app.
            loginCheckbox.isEnabled = false
            loginCaption.stringValue = L10n.t("（开发版不支持；打包后的 App 可用）",
                                              "（開発ビルドでは利用不可）",
                                              "(Unavailable in the dev build)")
        }
    }

    @objc private func languagePicked() {
        guard let raw = languagePopup.selectedItem?.representedObject as? String,
              let lang = AppLanguage(rawValue: raw) else { return }
        L10n.setting = lang
    }

    @objc private func depthPicked() {
        guard let id = depthPopup.selectedItem?.representedObject as? String else { return }
        Settings.shared.depth = id
        NotificationCenter.default.post(name: Appearance.themeDidChange, object: nil)
    }

    @objc private func targetPicked() {
        if let app = targetPopup.selectedItem?.representedObject as? ScreenCapture.AppInfo {
            Settings.shared.captureTargetBundleID = app.bundleID
            Settings.shared.captureTargetName = app.name
        } else {
            Settings.shared.captureTargetBundleID = nil
            Settings.shared.captureTargetName = nil
        }
    }

    @objc private func autoCapPicked() {
        guard let cap = autoCapPopup.selectedItem?.representedObject as? Int else { return }
        Settings.shared.autoModeMaxQuestions = cap
    }

    @objc private func loginToggled() {
        do {
            if loginCheckbox.state == .on {
                try SMAppService.mainApp.register()
            } else {
                try SMAppService.mainApp.unregister()
            }
        } catch {
            reloadLoginState() // revert the checkbox; the OS said no
        }
    }

    @objc private func telemetryToggled() {
        ProductTelemetry.shared.sharingEnabled = telemetryCheckbox.state == .on
    }
}

// MARK: - 快捷键 Hotkeys (embeds the recorder rows)

private final class HotkeysPageController: NSViewController, SettingsPage {
    var onChange: (() -> Void)?
    private let embedded = HotkeySettingsViewController()

    override func loadView() {
        let root = SettingsFlippedView(frame: NSRect(origin: .zero, size: MainSettingsWindowController.pageSize))

        let title = pageTitleLabel(L10n.t("快捷键", "ショートカット", "Hotkeys"))
        title.frame = NSRect(x: 36, y: 46, width: 300, height: 26)
        root.addSubview(title)

        embedded.onChange = { [weak self] in self?.onChange?() }
        addChild(embedded)
        embedded.view.frame = NSRect(x: 36, y: 92, width: 420, height: 266)
        root.addSubview(embedded.view)

        view = root
    }

    func pageDidShow() {}
}

// MARK: - 外观 Appearance

private final class AppearancePageController: NSViewController, SettingsPage {
    private var swatches: [AccentSwatch] = []
    private let sizeSlider = NSSlider()
    private let sizeReadout = NSTextField(labelWithString: "")
    private let sizeSample = NSTextField(labelWithString: "")
    private let delaySlider = NSSlider()
    private let delayReadout = NSTextField(labelWithString: "")
    private let stayCheckbox = NSButton(checkboxWithTitle: "", target: nil, action: nil)
    private let revealCheckbox = NSButton(checkboxWithTitle: "", target: nil, action: nil)
    private let autoCopyCheckbox = NSButton(checkboxWithTitle: "", target: nil, action: nil)

    private let labelW: CGFloat = 148
    private let fieldX: CGFloat = 36 + 160

    override func loadView() {
        let root = SettingsFlippedView(frame: NSRect(origin: .zero, size: MainSettingsWindowController.pageSize))

        let title = pageTitleLabel(L10n.t("外观", "外観", "Appearance"))
        title.frame = NSRect(x: 36, y: 46, width: 300, height: 26)
        root.addSubview(title)

        var y: CGFloat = 100

        // 强调色 swatches
        let accentLabel = rowLabel(L10n.t("强调色", "アクセントカラー", "Accent color"))
        accentLabel.alignment = .right
        accentLabel.frame = NSRect(x: 36, y: y + 12, width: labelW, height: 18)
        root.addSubview(accentLabel)
        var x: CGFloat = fieldX
        for theme in AccentTheme.all {
            let swatch = AccentSwatch(theme: theme) { [weak self] picked in
                Appearance.setTheme(picked.id)
                self?.refreshSwatches()
                self?.restyleSample()
            }
            swatch.frame = NSRect(x: x, y: y, width: 56, height: 56)
            root.addSubview(swatch)
            swatches.append(swatch)
            x += 64
        }
        let accentHint = captionLabel(L10n.t("Rose 指示器、刘海边缘的光、按钮都会跟随这个颜色。",
                                             "Rose インジケーター、ノッチの光、ボタンがこの色に染まります。",
                                             "The Rose, the notch's edge light, and every button follow this color."))
        accentHint.frame = NSRect(x: fieldX, y: y + 62, width: 380, height: 32)
        root.addSubview(accentHint)
        y += 112

        // 答案字号 — continuous slider with a live px readout and a WYSIWYG sample chip.
        let sizeLabel = rowLabel(L10n.t("答案字号", "回答の文字サイズ", "Answer text size"))
        sizeLabel.alignment = .right
        sizeLabel.frame = NSRect(x: 36, y: y + 6, width: labelW, height: 18)
        root.addSubview(sizeLabel)
        sizeSlider.minValue = Double(Appearance.answerFontRange.lowerBound)
        sizeSlider.maxValue = Double(Appearance.answerFontRange.upperBound)
        sizeSlider.doubleValue = Double(Appearance.answerFontSize)
        sizeSlider.numberOfTickMarks = Int(Appearance.answerFontRange.upperBound - Appearance.answerFontRange.lowerBound) + 1
        sizeSlider.allowsTickMarkValuesOnly = true
        sizeSlider.target = self
        sizeSlider.action = #selector(sizeChanged)
        sizeSlider.frame = NSRect(x: fieldX, y: y + 2, width: 220, height: 24)
        root.addSubview(sizeSlider)
        sizeReadout.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        sizeReadout.textColor = .secondaryLabelColor
        sizeReadout.frame = NSRect(x: fieldX + 230, y: y + 6, width: 56, height: 18)
        root.addSubview(sizeReadout)
        // The sample renders the answer-card headline at the chosen size so users see the exact
        // result without leaving Settings (the notch may well be collapsed).
        sizeSample.frame = NSRect(x: fieldX, y: y + 30, width: 320, height: 30)
        sizeSample.lineBreakMode = .byTruncatingTail
        root.addSubview(sizeSample)
        y += 74

        // 答完后收起 — a seconds slider, disabled while "keep expanded" is on.
        let delayLabel = rowLabel(L10n.t("答完后收起", "回答後にたたむ", "Fold after answering"))
        delayLabel.alignment = .right
        delayLabel.frame = NSRect(x: 36, y: y + 6, width: labelW, height: 18)
        root.addSubview(delayLabel)
        delaySlider.minValue = Appearance.collapseSecondsRange.lowerBound
        delaySlider.maxValue = Appearance.collapseSecondsRange.upperBound
        delaySlider.doubleValue = Appearance.collapseSeconds
        delaySlider.target = self
        delaySlider.action = #selector(delayChanged)
        delaySlider.frame = NSRect(x: fieldX, y: y + 2, width: 220, height: 24)
        root.addSubview(delaySlider)
        delayReadout.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        delayReadout.textColor = .secondaryLabelColor
        delayReadout.frame = NSRect(x: fieldX + 230, y: y + 6, width: 90, height: 18)
        root.addSubview(delayReadout)
        y += 34

        stayCheckbox.title = L10n.t("保持展开，直到移开鼠标", "マウスを離すまで開いたまま", "Keep expanded until the mouse leaves")
        stayCheckbox.target = self
        stayCheckbox.action = #selector(stayToggled)
        stayCheckbox.state = Appearance.stayExpanded ? .on : .off
        stayCheckbox.frame = NSRect(x: fieldX, y: y, width: 340, height: 20)
        root.addSubview(stayCheckbox)
        y += 44

        // 简略模式默认展开推理
        let reasonLabel = rowLabel(L10n.t("简略模式", "簡潔モード", "Brief mode"))
        reasonLabel.alignment = .right
        reasonLabel.frame = NSRect(x: 36, y: y + 1, width: labelW, height: 18)
        root.addSubview(reasonLabel)
        revealCheckbox.title = L10n.t("答完后默认展开「推理过程」", "回答後に「考え方」を最初から開く", "Show the reasoning unfolded by default")
        revealCheckbox.target = self
        revealCheckbox.action = #selector(revealToggled)
        revealCheckbox.state = Appearance.revealReasoningByDefault ? .on : .off
        revealCheckbox.frame = NSRect(x: fieldX, y: y, width: 360, height: 20)
        root.addSubview(revealCheckbox)
        y += 36

        // 剪贴板：答完后自动复制答案
        let copyLabel = rowLabel(L10n.t("剪贴板", "クリップボード", "Clipboard"))
        copyLabel.alignment = .right
        copyLabel.frame = NSRect(x: 36, y: y + 1, width: labelW, height: 18)
        root.addSubview(copyLabel)
        autoCopyCheckbox.title = L10n.t("答完后自动复制答案到剪贴板",
                                        "回答後に答えをクリップボードへ自動コピー",
                                        "Copy the answer to the clipboard when done")
        autoCopyCheckbox.target = self
        autoCopyCheckbox.action = #selector(autoCopyToggled)
        autoCopyCheckbox.state = Appearance.autoCopyAnswer ? .on : .off
        autoCopyCheckbox.frame = NSRect(x: fieldX, y: y, width: 400, height: 20)
        root.addSubview(autoCopyCheckbox)
        y += 40

        let liveHint = captionLabel(L10n.t("所有更改即时生效 — 抬头看看刘海。",
                                           "変更はすぐ反映されます — ノッチを見てみて。",
                                           "Everything applies instantly — glance up at the notch."))
        liveHint.frame = NSRect(x: fieldX, y: y, width: 380, height: 20)
        root.addSubview(liveHint)

        view = root
        refreshSwatches()
        syncSizeUI()
        syncDelayUI()
    }

    private func refreshSwatches() {
        for s in swatches { s.isChosen = s.theme.id == Appearance.theme.id }
    }

    // MARK: Answer size

    @objc private func sizeChanged() {
        Appearance.answerFontSize = CGFloat(sizeSlider.doubleValue)
        syncSizeUI()
    }

    private func syncSizeUI() {
        sizeReadout.stringValue = Appearance.fontSizeReadout(Appearance.answerFontSize)
        restyleSample()
    }

    /// Mirror the notch's answer-card headline (body size + 4, semibold) at the chosen accent.
    private func restyleSample() {
        let pt = Appearance.answerFontSize
        sizeSample.font = .systemFont(ofSize: pt + 4, weight: .semibold)
        sizeSample.textColor = .labelColor
        sizeSample.stringValue = L10n.t("答案 A = −30", "答え A = −30", "Answer  A = −30")
    }

    // MARK: Collapse

    @objc private func delayChanged() {
        Appearance.collapseSeconds = delaySlider.doubleValue
        syncDelayUI()
    }

    @objc private func stayToggled() {
        Appearance.stayExpanded = (stayCheckbox.state == .on)
        syncDelayUI()
    }

    private func syncDelayUI() {
        let stay = Appearance.stayExpanded
        delaySlider.isEnabled = !stay
        delaySlider.doubleValue = Appearance.collapseSeconds
        delayReadout.textColor = stay ? .tertiaryLabelColor : .secondaryLabelColor
        delayReadout.stringValue = Appearance.collapseReadout(stay: stay, seconds: Appearance.collapseSeconds)
    }

    @objc private func revealToggled() {
        Appearance.revealReasoningByDefault = (revealCheckbox.state == .on)
    }

    @objc private func autoCopyToggled() {
        Appearance.autoCopyAnswer = (autoCopyCheckbox.state == .on)
    }

    func pageDidShow() { refreshSwatches(); syncSizeUI(); syncDelayUI() }
}

/// One accent color dot with its name beneath; a ring marks the chosen one.
private final class AccentSwatch: NSControl {
    let theme: AccentTheme
    var isChosen = false {
        didSet {
            needsDisplay = true
            if isChosen != oldValue { NSAccessibility.post(element: self, notification: .valueChanged) }
        }
    }
    private let onPick: (AccentTheme) -> Void
    private var hovering = false { didSet { needsDisplay = true } }
    private var trackingAreaRef: NSTrackingArea?

    init(theme: AccentTheme, onPick: @escaping (AccentTheme) -> Void) {
        self.theme = theme
        self.onPick = onPick
        super.init(frame: .zero)
        toolTip = theme.localizedName
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override var isFlipped: Bool { true }

    override var acceptsFirstResponder: Bool { isEnabled && !isHiddenOrHasHiddenAncestor }
    override var canBecomeKeyView: Bool { acceptsFirstResponder }
    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .radioButton }
    override func accessibilityLabel() -> String? { theme.localizedName }
    override func accessibilityValue() -> Any? { isChosen ? 1 : 0 }
    override func isAccessibilityEnabled() -> Bool { isEnabled }
    override func accessibilityPerformPress() -> Bool {
        guard acceptsFirstResponder else { return false }
        window?.makeFirstResponder(self)
        onPick(theme)
        return true
    }
    override func keyDown(with event: NSEvent) {
        if [UInt16(36), 49, 76].contains(event.keyCode) { _ = accessibilityPerformPress() }
        else { super.keyDown(with: event) }
    }
    override func becomeFirstResponder() -> Bool { needsDisplay = true; return super.becomeFirstResponder() }
    override func resignFirstResponder() -> Bool { needsDisplay = true; return super.resignFirstResponder() }

    override func draw(_ dirtyRect: NSRect) {
        let dotRect = NSRect(x: bounds.midX - 14, y: 2, width: 28, height: 28)
        if isChosen || hovering {
            let ring = NSBezierPath(ovalIn: dotRect.insetBy(dx: -4, dy: -4))
            ring.lineWidth = 2
            (isChosen ? theme.accent : NSColor.tertiaryLabelColor).setStroke()
            ring.stroke()
        }
        NSGradient(starting: theme.accentHi, ending: theme.accent)?
            .draw(in: NSBezierPath(ovalIn: dotRect), angle: -90)

        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 10),
            .foregroundColor: isChosen ? NSColor.labelColor : NSColor.secondaryLabelColor,
        ]
        let name = theme.localizedName as NSString
        let ts = name.size(withAttributes: attrs)
        name.draw(at: NSPoint(x: bounds.midX - ts.width / 2, y: 40), withAttributes: attrs)
        if window?.firstResponder === self {
            NSColor.keyboardFocusIndicatorColor.setStroke()
            let ring = NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 6, yRadius: 6)
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

// MARK: - 账户 Account

private final class AccountPageController: NSViewController, SettingsPage {
    private let ring = QuotaRingView()
    private let usageLabel = captionLabel("", size: 12)
    private let tokensLabel = captionLabel("")
    private let deviceLabel = captionLabel("")
    private let statusLabel = captionLabel("", size: 12)
    private let topUpButton = NSButton()
    private let refreshButton = NSButton()
    private let claimButton = NSButton()
    private let resetButton = NSButton()
    private let copyCodeButton = NSButton()
    private var observer: NSObjectProtocol?

    override func loadView() {
        let root = SettingsFlippedView(frame: NSRect(origin: .zero, size: MainSettingsWindowController.pageSize))

        let title = pageTitleLabel(L10n.t("账户与额度", "アカウントと残高", "Account"))
        title.frame = NSRect(x: 36, y: 46, width: 300, height: 26)
        root.addSubview(title)

        ring.frame = NSRect(x: 60, y: 104, width: 170, height: 170)
        root.addSubview(ring)

        var y: CGFloat = 116
        usageLabel.frame = NSRect(x: 270, y: y, width: 320, height: 20)
        root.addSubview(usageLabel)
        y += 26
        tokensLabel.frame = NSRect(x: 270, y: y, width: 320, height: 18)
        root.addSubview(tokensLabel)
        y += 30

        topUpButton.title = L10n.topUp
        topUpButton.bezelStyle = .rounded
        topUpButton.keyEquivalent = "\r"
        topUpButton.target = self
        topUpButton.action = #selector(topUpTapped)
        topUpButton.frame = NSRect(x: 268, y: y, width: 110, height: 30)
        root.addSubview(topUpButton)

        refreshButton.title = L10n.refresh
        refreshButton.bezelStyle = .rounded
        refreshButton.target = self
        refreshButton.action = #selector(refreshTapped)
        refreshButton.frame = NSRect(x: 384, y: y, width: 84, height: 30)
        root.addSubview(refreshButton)
        y += 40

        claimButton.title = L10n.t("领取免费额度", "無料枠を受け取る", "Claim free questions")
        claimButton.bezelStyle = .rounded
        claimButton.target = self
        claimButton.action = #selector(claimTapped)
        claimButton.frame = NSRect(x: 268, y: y, width: 220, height: 30)
        root.addSubview(claimButton)

        // Shown only when the server rejected this device's credential (401). Resetting is
        // destructive (see OfficialAPI.resetCredential), so it's confirmed and never automatic.
        resetButton.title = L10n.t("重置服务凭证", "認証情報をリセット", "Reset credential")
        resetButton.bezelStyle = .rounded
        resetButton.target = self
        resetButton.action = #selector(resetTapped)
        resetButton.frame = NSRect(x: 268, y: y, width: 220, height: 30)
        resetButton.isHidden = true
        root.addSubview(resetButton)

        statusLabel.frame = NSRect(x: 270, y: y + 40, width: 320, height: 40)
        root.addSubview(statusLabel)

        deviceLabel.frame = NSRect(x: 36, y: 300, width: 380, height: 18)
        root.addSubview(deviceLabel)

        // Copy the full device code so a user can send it to support for a manual quota grant.
        // (The label only ever shows a masked form; this is the deliberate way to reveal it.)
        copyCodeButton.title = L10n.t("复制设备码", "デバイスコードをコピー", "Copy device code")
        copyCodeButton.bezelStyle = .rounded
        copyCodeButton.controlSize = .small
        copyCodeButton.target = self
        copyCodeButton.action = #selector(copyCodeTapped)
        copyCodeButton.frame = NSRect(x: 424, y: 296, width: 172, height: 24)
        root.addSubview(copyCodeButton)

        let note = captionLabel(L10n.t(
            "每成功答一题消耗 1 题；出错不扣。额度与本机绑定，无需注册账号。",
            "回答が成功するたびに1問消費。エラー時は消費されません。残高はこのMacに紐づき、アカウント登録は不要です。",
            "Each successful answer costs one question; errors are free. Credits are tied to this Mac — no account needed."))
        note.frame = NSRect(x: 36, y: 330, width: 560, height: 36)
        root.addSubview(note)

        view = root
        reload()

        observer = NotificationCenter.default.addObserver(
            forName: OfficialAPI.accountDidChange, object: nil, queue: .main
        ) { [weak self] _ in self?.reload() }
    }

    deinit {
        if let observer { NotificationCenter.default.removeObserver(observer) }
    }

    /// Visual-QA: NSPI_QA_BALANCE=N renders the page as a registered device holding N questions
    /// — no Keychain, no network (pair with NSPI_QA_EPHEMERAL). Always nil in release.
    private static var qaBalance: Int? {
        #if DEBUG
        return ProcessInfo.processInfo.environment["NSPI_QA_BALANCE"].flatMap(Int.init)
        #else
        return nil
        #endif
    }

    func pageDidShow() {
        reload()
        if OfficialAPI.deviceToken != nil, Self.qaBalance == nil { refreshTapped() }
    }

    private func reload() {
        #if DEBUG
        if let n = Self.qaBalance {
            ring.setBalance(n, animated: true)
            usageLabel.stringValue = L10n.t("累计已答 \(OfficialAPI.totalQuestions) 题",
                                            "これまでに\(OfficialAPI.totalQuestions)問回答",
                                            "\(OfficialAPI.totalQuestions) questions answered so far")
            tokensLabel.stringValue = "· 128650 tokens"
            deviceLabel.stringValue = L10n.t("设备 ID：", "デバイスID：", "Device ID: ") + "nspi-••••••••Q4"
            claimButton.isHidden = true
            resetButton.isHidden = true
            copyCodeButton.isHidden = false
            topUpButton.isEnabled = true
            refreshButton.isEnabled = true
            return
        }
        #endif
        let registered = OfficialAPI.deviceToken != nil
        // Credential kept but rejected by the server (401): a distinct state from "not registered".
        let rejected = registered && OfficialAPI.credentialRejected
        // A cached balance without a live/accepted token is stale — show the empty ring, not a
        // number nobody can spend.
        let balance = (registered && !rejected) ? OfficialAPI.balanceQuestions : nil
        ring.setBalance(balance, animated: true)
        usageLabel.stringValue = L10n.t("累计已答 \(OfficialAPI.totalQuestions) 题",
                                        "これまでに\(OfficialAPI.totalQuestions)問回答",
                                        "\(OfficialAPI.totalQuestions) questions answered so far")
        let tk = OfficialAPI.accumulateUsage(OfficialAPI.totalInputTokens, OfficialAPI.totalOutputTokens)
        tokensLabel.stringValue = tk > 0 ? "· \(tk) tokens" : ""
        deviceLabel.stringValue = registered
            ? L10n.t("设备 ID：", "デバイスID：", "Device ID: ") + OfficialAPI.truncatedToken(OfficialAPI.deviceToken ?? "")
            : L10n.t("尚未领取免费额度。", "まだ無料枠を受け取っていません。", "Free questions not claimed yet.")
        claimButton.isHidden = registered
        resetButton.isHidden = !rejected
        copyCodeButton.isHidden = !registered
        // A rejected credential can't be spent or topped up until it's reset or re-accepted.
        topUpButton.isEnabled = registered && !rejected
        refreshButton.isEnabled = registered
        // Surface the rejection without clobbering a transient status message already on screen.
        if rejected && statusLabel.stringValue.isEmpty {
            statusLabel.stringValue = L10n.t(
                "本机服务凭证已失效。若只是临时网络/服务波动，请先点「刷新」重试；确认失效后再「重置服务凭证」（不影响已购买的题数入账记录）。",
                "このデバイスの認証情報が無効になりました。一時的な不具合の場合はまず「更新」を試し、無効が確実な場合のみ「認証情報をリセット」してください(購入済みの記録には影響しません)。",
                "This device's credential was rejected. If it's just a temporary hiccup, hit Refresh first; only Reset once you're sure — your purchase records are unaffected.")
        }
    }

    @objc private func topUpTapped() {
        if let payments = ClientConfigService.shared.current.payments,
           payments.purchaseSessions,
           let pack = payments.packs.sorted(by: { $0.questions < $1.questions }).dropFirst().first ?? payments.packs.first {
            statusLabel.stringValue = L10n.t("正在准备购买页面…", "購入ページを準備中…", "Preparing the purchase page…")
            Task { @MainActor in
                do {
                    let handoff = try await OfficialAPI.createPurchaseSession(packID: pack.id, catalogVersion: payments.catalogVersion)
                    guard handoff.belongs() else {
                        statusLabel.stringValue = OfficialAPI.accountChangedMessage
                        return
                    }
                    NSWorkspace.shared.open(handoff.purchaseURL)
                    statusLabel.stringValue = L10n.t("已在浏览器打开购买页面。支付完成后点「刷新」。", "ブラウザで購入ページを開きました。完了後「更新」を押してください。", "Purchase page opened in your browser — hit Refresh after payment.")
                } catch let error as OfficialAPIError {
                    statusLabel.stringValue = error.message
                } catch {
                    statusLabel.stringValue = L10n.t("支付暂时不可用，请稍后重试。", "決済は一時的に利用できません。", "Payments are temporarily unavailable.")
                }
            }
            return
        }
        guard let url = OfficialAPI.topUpURL(
            baseURL: OfficialAPI.baseURL, deviceToken: OfficialAPI.deviceToken,
            lang: OfficialAPI.topUpLang) else { return }
        NSWorkspace.shared.open(url)
        statusLabel.stringValue = L10n.t("已在浏览器打开充值页面，完成后点「刷新」。",
                                         "ブラウザでチャージページを開きました。完了後「更新」を押してください。",
                                         "Top-up page opened in your browser — hit Refresh when done.")
    }

    @objc private func refreshTapped() {
        statusLabel.stringValue = L10n.t("正在同步…", "同期中…", "Syncing…")
        Task { @MainActor in
            switch await OfficialAPI.refreshAccount() {
            case .success:
                self.statusLabel.stringValue = ""
            case .failure(let error):
                self.statusLabel.stringValue = error.message
            }
            self.reload()
        }
    }

    @objc private func claimTapped() {
        claimButton.isEnabled = false
        statusLabel.stringValue = L10n.t("正在领取…", "受け取り中…", "Claiming…")
        Task { @MainActor in
            switch await OfficialAPI.registerIfNeeded() {
            case .success:
                self.statusLabel.stringValue = L10n.t("已到账 🎉", "受け取りました 🎉", "Arrived 🎉")
            case .failure(let error):
                self.statusLabel.stringValue = error.message
                self.claimButton.isEnabled = true
            }
            self.reload()
        }
    }

    @objc private func copyCodeTapped() {
        guard let token = OfficialAPI.deviceToken else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(token, forType: .string)
        statusLabel.stringValue = L10n.t("设备码已复制，可发给客服用于补充额度。",
                                         "デバイスコードをコピーしました。サポートへの残高追加依頼にお使いください。",
                                         "Device code copied — send it to support to get credits added.")
    }

    @objc private func resetTapped() {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = L10n.t("重置服务凭证？", "認証情報をリセットしますか？",
                                   "Reset service credential?")
        alert.informativeText = L10n.t(
            "仅在确认本机凭证确实失效时才重置。重置会丢弃当前设备码并领取一份新的免费额度；如果只是临时网络或服务波动，请改点「刷新」。已购买的题数请先复制设备码联系客服再重置。",
            "認証情報が確実に無効な場合のみリセットしてください。現在のデバイスコードを破棄して新しい無料枠を取得します。一時的な不具合の場合は「更新」をお使いください。購入済みの質問数がある場合は、先にデバイスコードをコピーしてサポートにご連絡ください。",
            "Only reset if you're sure the credential is truly invalid. This discards the current device code and claims a fresh free allowance. If it's a temporary hiccup, use Refresh instead. If you have purchased questions, copy the device code and contact support before resetting.")
        alert.addButton(withTitle: L10n.t("重置并重新领取", "リセットして再取得", "Reset & re-claim"))
        alert.addButton(withTitle: L10n.cancel)
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        guard OfficialAPI.resetCredential() else {
            statusLabel.stringValue = L10n.t("凭证未能重置，请解锁钥匙串后重试。", "リセットできません。キーチェーンを解除して再試行してください。",
                                            "The credential could not be reset. Unlock Keychain and retry.")
            return
        }
        statusLabel.stringValue = ""
        reload()
        claimTapped() // mint and register a fresh device token
    }
}

/// The quota at a glance: a true conic-gradient arc (proportion of the fixed 30-question grant,
/// capped at full) around a live rolling number. The arc lands on a soft spring and the number
/// counts to its new value — one glance says both "how much" and "which way it just moved".
/// Amber when running low, so "time to top up" is felt before it's read.
final class QuotaRingView: NSView {
    private var displayedFraction: CGFloat = 0   // 0…1 arc sweep currently drawn
    private var displayedNumber: CGFloat = 0     // rolling count-up value
    private var balance: Int?
    private var arcTween: DisplayTween?
    private var numberTween: DisplayTween?

    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .staticText }
    override func accessibilityLabel() -> String? {
        guard let balance else { return L10n.t("剩余额度尚未获取", "残りの利用枠は未取得です", "Remaining quota unavailable") }
        return L10n.t("\(balance) 题可用", "\(balance)問利用可能", "\(balance) questions left")
    }

    /// The progress ring: a conic gradient sheet masked to a round-capped arc whose strokeEnd is
    /// the live sweep. CG has no conic API, so the gradient rides a CAGradientLayer above the
    /// view's own drawing (track + number), which is exactly the right stacking anyway.
    private let conic = CAGradientLayer()
    private let arcMask = CAShapeLayer()

    private var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        wantsLayer = true
        conic.type = .conic
        conic.startPoint = CGPoint(x: 0.5, y: 0.5)
        conic.endPoint = CGPoint(x: 0.5, y: 1)     // gradient's 0-angle points at the arc's top start
        arcMask.fillColor = nil
        arcMask.strokeColor = NSColor.black.cgColor
        arcMask.lineWidth = 12
        arcMask.lineCap = .round
        arcMask.strokeEnd = 0
        conic.mask = arcMask
        layer?.addSublayer(conic)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func setBalance(_ newBalance: Int?, animated: Bool) {
        let changed = balance != newBalance
        balance = newBalance
        if changed { NSAccessibility.post(element: self, notification: .valueChanged) }
        let target = CGFloat(min(1, max(0, Double(newBalance ?? 0) / 30.0)))
        if arcTween == nil {
            arcTween = DisplayTween(host: self, value: 0)
            arcTween?.ease = NotchMotion.springSettle   // the arc lands with a soft breath past target
            arcTween?.onChange = { [weak self] v in
                self?.displayedFraction = v
                self?.applyRing()
            }
            numberTween = DisplayTween(host: self, value: 0)
            numberTween?.onChange = { [weak self] v in
                self?.displayedNumber = v
                self?.needsDisplay = true
            }
        }
        let number = CGFloat(newBalance ?? 0)
        if animated && !reduceMotion {
            arcTween?.animate(to: target, duration: 0.9)
            numberTween?.animate(to: number, duration: 0.9)
        } else {
            arcTween?.set(target)
            numberTween?.set(number)
        }
        applyRing()
    }

    override func layout() {
        super.layout()
        let center = CGPoint(x: bounds.midX, y: bounds.midY)
        let radius = min(bounds.width, bounds.height) / 2 - 10
        // One full clockwise-from-top turn; strokeEnd exposes the live sweep.
        let arc = CGMutablePath()
        arc.addArc(center: center, radius: radius,
                   startAngle: .pi / 2, endAngle: .pi / 2 - 2 * .pi, clockwise: true)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        conic.frame = bounds
        arcMask.frame = bounds
        arcMask.path = arc
        CATransaction.commit()
        applyRing()
    }

    /// Push the tweened sweep into the layers: strokeEnd plus gradient stops pinned so the
    /// accent sits at the arc's start and the highlight rides its head. The conic sweep runs
    /// counterclockwise in this y-up geometry while the arc runs clockwise, so arc position s
    /// samples the gradient at location 1 − s.
    private func applyRing() {
        let low = (balance ?? Int.max) <= OfficialAPI.lowQuotaThreshold
        let accent = low ? AccentTheme.amber.accent : NotchPalette.accent
        let accentHi = low ? AccentTheme.amber.accentHi : NotchPalette.accentHi
        let f = min(1, max(0, displayedFraction))
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        arcMask.strokeEnd = f
        conic.colors = [accentHi.cgColor, accentHi.cgColor, accent.cgColor]
        conic.locations = [0, NSNumber(value: Double(1 - f)), 1]
        conic.isHidden = f <= 0.004
        CATransaction.commit()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let low = (balance ?? Int.max) <= OfficialAPI.lowQuotaThreshold

        let center = CGPoint(x: bounds.midX, y: bounds.midY)
        let radius = min(bounds.width, bounds.height) / 2 - 10
        let lineWidth: CGFloat = 12

        // Track (the conic progress rides above as a sublayer).
        ctx.setStrokeColor(NSColor.labelColor.withAlphaComponent(0.10).cgColor)
        ctx.setLineWidth(lineWidth)
        ctx.setLineCap(.round)
        ctx.addArc(center: center, radius: radius, startAngle: 0, endAngle: 2 * .pi, clockwise: false)
        ctx.strokePath()

        // Number + unit in the middle. The number itself goes amber when the quota is low —
        // at zero there is no arc left to carry the warning color.
        let numberText = balance == nil ? "—" : String(Int(displayedNumber.rounded()))
        let numberAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 34, weight: .bold),
            .foregroundColor: (low && balance != nil) ? AccentTheme.amber.accent : NSColor.labelColor,
        ]
        let unitAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12, weight: .medium),
            .foregroundColor: NSColor.secondaryLabelColor,
        ]
        let n = numberText as NSString
        let ns = n.size(withAttributes: numberAttrs)
        n.draw(at: NSPoint(x: center.x - ns.width / 2, y: center.y - ns.height / 2 + 7), withAttributes: numberAttrs)
        let unit = L10n.t("题可用", "問利用可能", "questions left") as NSString
        let us = unit.size(withAttributes: unitAttrs)
        unit.draw(at: NSPoint(x: center.x - us.width / 2, y: center.y - ns.height / 2 - us.height + 4), withAttributes: unitAttrs)
    }
}

// MARK: - 人物像 Personas (embeds the library manager)

private final class PersonasPageController: NSViewController, SettingsPage {
    private let embedded = PersonaManagerViewController()
    private let onChange: () -> Void

    init(onChange: @escaping () -> Void) {
        self.onChange = onChange
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func loadView() {
        let root = SettingsFlippedView(frame: NSRect(origin: .zero, size: MainSettingsWindowController.pageSize))
        let title = pageTitleLabel(L10n.t("人物像", "人物像", "Personas"))
        title.frame = NSRect(x: 36, y: 46, width: 300, height: 26)
        root.addSubview(title)
        let hint = captionLabel(L10n.t("性格测试作答时，答案会尽量贴合当前选中的人物像。",
                                       "性格検査の回答は、選択中の人物像に沿うように選ばれます。",
                                       "Personality-test answers lean toward the selected persona."))
        hint.frame = NSRect(x: 36, y: 74, width: 560, height: 18)
        root.addSubview(hint)
        embedded.onChange = { [weak self] in self?.onChange() }
        addChild(embedded)
        embedded.view.frame = NSRect(x: 0, y: 96, width: 640, height: 440)
        root.addSubview(embedded.view)
        view = root
    }

    func pageDidShow() { embedded.reloadFromStore() }
}

// MARK: - 高级 Advanced

private final class AdvancedPageController: NSViewController, SettingsPage, NSTextFieldDelegate {
    var onChange: (() -> Void)?

    private var modeRadios: [NSButton] = []
    private let backendPopup = NSPopUpButton()   // CLI-mode engine (codex / claude)
    private let providerPopup = NSPopUpButton()  // custom-key third-party provider
    private let apiKeyField = NSSecureTextField()
    private let apiModelField = NSTextField()
    private let baseURLField = NSTextField()      // custom provider only
    private let versionLabel = captionLabel("")
    /// The CLI-switch state the page was last built with; a mismatch (客服 flipped it and an
    /// account sync landed) triggers a rebuild so the CLI radio appears/disappears live.
    private var builtWithCLIEnabled = false
    private var accountObserver: NSObjectProtocol?

    deinit {
        if let o = accountObserver { NotificationCenter.default.removeObserver(o) }
    }

    override func loadView() {
        view = SettingsFlippedView(frame: NSRect(origin: .zero, size: MainSettingsWindowController.pageSize))
        populate()
        accountObserver = NotificationCenter.default.addObserver(
            forName: OfficialAPI.accountDidChange, object: nil, queue: .main
        ) { [weak self] _ in self?.rebuildIfCLISwitchChanged() }
    }

    private func rebuildIfCLISwitchChanged() {
        guard isViewLoaded, builtWithCLIEnabled != OfficialAPI.cliEnabled else { return }
        populate()
    }

    /// (Re)build the whole page. Idempotent so the CLI-switch observer can call it again.
    private func populate() {
        let root = view
        root.subviews.forEach { $0.removeFromSuperview() }
        modeRadios.removeAll()
        let cliEnabled = OfficialAPI.cliEnabled
        builtWithCLIEnabled = cliEnabled

        let title = pageTitleLabel(L10n.t("高级", "詳細", "Advanced"))
        title.frame = NSRect(x: 36, y: 46, width: 300, height: 26)
        root.addSubview(title)

        var y: CGFloat = 92

        // 答题通道 (service channel). The CLI radio exists only on devices where the operator
        // has flipped the per-device switch (镜像自官方服务的 cli_enabled) — everyone else sees
        // just official / custom key, and routing reroutes any stale cli mode to official.
        let channelLabel = rowLabel(L10n.t("答题通道", "回答チャネル", "Answering channel"))
        channelLabel.frame = NSRect(x: 36, y: y, width: 200, height: 18)
        root.addSubview(channelLabel)
        y += 26

        let descs: [String: String] = [
            ServiceMode.official: L10n.t("默认。开箱即用，按题数额度计费。", "デフォルト。設定不要、質問数制。", "Default. Zero setup, question-quota billing."),
            ServiceMode.customKey: L10n.t("用你自己的第三方 API Key 直连，费用走你的账户。", "自分の外部 API キーで直接接続。", "Use your own third-party API key; costs go to your account."),
            ServiceMode.cli: L10n.t("驱动本机已登录的 codex / claude 命令行。", "ローカルの codex / claude CLI を利用。", "Drive the locally installed codex / claude CLIs."),
        ]
        let visibleModes = cliEnabled ? ServiceMode.all : ServiceMode.all.filter { $0 != ServiceMode.cli }
        // With the CLI hidden, a stored cli mode resolves to official — show that honestly.
        var selectedMode = Settings.shared.serviceMode
        if !cliEnabled && selectedMode == ServiceMode.cli { selectedMode = ServiceMode.official }
        for mode in visibleModes {
            let radio = NSButton(radioButtonWithTitle: L10n.serviceModeLabel(mode), target: self,
                                 action: #selector(modePicked(_:)))
            radio.frame = NSRect(x: 40, y: y, width: 220, height: 18)
            radio.identifier = NSUserInterfaceItemIdentifier(mode)
            radio.state = selectedMode == mode ? .on : .off
            root.addSubview(radio)
            modeRadios.append(radio)
            let d = captionLabel(descs[mode] ?? "")
            d.frame = NSRect(x: 262, y: y + 1, width: 330, height: 30)
            root.addSubview(d)
            y += 30
        }
        y += 8

        // Custom-key mode: pick a third-party provider, then paste that vendor's key + (optionally)
        // a model. Everything routes through APIProvider — presets fill endpoint/model, and the
        // "Custom" entry exposes a Base URL field for any OpenAI-compatible service.
        if selectedMode == ServiceMode.customKey {
            let provider = Settings.shared.activeProvider

            // 厂商
            let providerLabel = rowLabel(L10n.t("厂商", "プロバイダ", "Provider"))
            providerLabel.frame = NSRect(x: 40, y: y + 4, width: 100, height: 18)
            root.addSubview(providerLabel)
            providerPopup.removeAllItems()
            for p in APIProvider.all {
                providerPopup.addItem(withTitle: p.isCustom
                    ? L10n.t("自定义 · OpenAI 兼容", "カスタム · OpenAI 互換", "Custom · OpenAI-compatible")
                    : p.name)
                providerPopup.lastItem?.representedObject = p.id
            }
            providerPopup.selectItem(at: APIProvider.all.firstIndex { $0.id == provider.id } ?? 0)
            providerPopup.target = self
            providerPopup.action = #selector(providerPicked)
            providerPopup.frame = NSRect(x: 150, y: y, width: 230, height: 26)
            root.addSubview(providerPopup)
            if provider.consoleURL != nil {
                let getKey = NSButton(title: L10n.t("获取 Key ↗", "キーを取得 ↗", "Get key ↗"),
                                      target: self, action: #selector(openConsole))
                getKey.bezelStyle = .recessed
                getKey.controlSize = .small
                getKey.frame = NSRect(x: 392, y: y + 2, width: 110, height: 22)
                root.addSubview(getKey)
            }
            y += 40

            // Base URL — custom provider only.
            if provider.isCustom {
                let urlLabel = rowLabel("Base URL")
                urlLabel.frame = NSRect(x: 40, y: y + 4, width: 100, height: 18)
                root.addSubview(urlLabel)
                baseURLField.placeholderString = "https://api.example.com/v1"
                baseURLField.font = .monospacedSystemFont(ofSize: 11.5, weight: .regular)
                baseURLField.frame = NSRect(x: 150, y: y, width: 442, height: 24)
                baseURLField.delegate = self
                baseURLField.identifier = NSUserInterfaceItemIdentifier("apiBaseURL")
                root.addSubview(baseURLField)
                y += 34
            }

            // API Key
            let keyLabel = rowLabel("API Key")
            keyLabel.frame = NSRect(x: 40, y: y + 4, width: 100, height: 18)
            root.addSubview(keyLabel)
            apiKeyField.placeholderString = provider.keyPlaceholder
            apiKeyField.font = .monospacedSystemFont(ofSize: 11.5, weight: .regular)
            apiKeyField.frame = NSRect(x: 150, y: y, width: 442, height: 24)
            apiKeyField.delegate = self
            apiKeyField.identifier = NSUserInterfaceItemIdentifier("apiKey")
            root.addSubview(apiKeyField)
            y += 34

            // 模型
            let modelLabel = rowLabel(L10n.t("模型", "モデル", "Model"))
            modelLabel.frame = NSRect(x: 40, y: y + 4, width: 100, height: 18)
            root.addSubview(modelLabel)
            apiModelField.placeholderString = provider.defaultModel.isEmpty
                ? L10n.t("必填（需支持视觉）", "必須（視覚対応）", "required (vision-capable)")
                : provider.defaultModel
            apiModelField.font = .monospacedSystemFont(ofSize: 11.5, weight: .regular)
            apiModelField.frame = NSRect(x: 150, y: y, width: 300, height: 24)
            apiModelField.delegate = self
            apiModelField.identifier = NSUserInterfaceItemIdentifier("apiModel")
            root.addSubview(apiModelField)
            y += 38

            // The empty-key fallback differs with the CLI switch: unlocked → CLI (the pre-official
            // behavior), locked → the official service. Say the truth for this device.
            let keyHint = captionLabel(cliEnabled
                ? L10n.t("Key 只存本机钥匙串；截图会直接发给所选厂商（模型需支持视觉）。留空则回退到 CLI。",
                         "キーはこのMacのキーチェーンにのみ保存。スクショは選択したプロバイダに送信（視覚対応モデルが必要）。空欄ならCLIへフォールバック。",
                         "Keys stay in your local Keychain; the screenshot goes straight to the chosen provider (model must support vision). Empty → CLI fallback.")
                : L10n.t("Key 只存本机钥匙串；截图会直接发给所选厂商（模型需支持视觉）。留空则使用官方服务。",
                         "キーはこのMacのキーチェーンにのみ保存。スクショは選択したプロバイダに送信（視覚対応モデルが必要）。空欄なら公式サービスを利用。",
                         "Keys stay in your local Keychain; the screenshot goes straight to the chosen provider (model must support vision). Empty → the official service."))
            keyHint.frame = NSRect(x: 40, y: y, width: 552, height: 44)
            root.addSubview(keyHint)
            y += 52
        } else if selectedMode == ServiceMode.cli {
            // 引擎 — which locally-installed CLI to drive. Only reachable when the operator has
            // unlocked the CLI channel for this device (cliEnabled); there's no key to infer it
            // from, so the picker stays here (persistent popup ⇒ clear it before repopulating).
            let backendLabel = rowLabel(L10n.t("引擎", "エンジン", "Engine"))
            backendLabel.frame = NSRect(x: 40, y: y + 4, width: 100, height: 18)
            root.addSubview(backendLabel)
            backendPopup.removeAllItems()
            for (id, label) in [("codex", "Codex"), ("claude", "Claude")] {
                backendPopup.addItem(withTitle: label)
                backendPopup.lastItem?.representedObject = id
            }
            backendPopup.selectItem(at: Settings.shared.cli == "claude" ? 1 : 0)
            backendPopup.target = self
            backendPopup.action = #selector(backendPicked)
            backendPopup.frame = NSRect(x: 150, y: y, width: 140, height: 26)
            root.addSubview(backendPopup)
            y += 42

            let cliHint = captionLabel(L10n.t(
                "驱动本机已安装并登录的对应命令行。",
                "ローカルにインストール・ログイン済みの対応 CLI を利用します。",
                "Drives the matching local CLI (must be installed and signed in)."))
            cliHint.frame = NSRect(x: 40, y: y, width: 552, height: 20)
            root.addSubview(cliHint)
            y += 28
        }

        // Updates + version
        let updateButton = NSButton(title: L10n.t("检查更新…", "アップデートを確認…", "Check for Updates…"),
                                    target: self, action: #selector(checkUpdates))
        updateButton.bezelStyle = .rounded
        updateButton.frame = NSRect(x: 36, y: y, width: 170, height: 30)
        root.addSubview(updateButton)
        versionLabel.stringValue = "NotchSPI \(UpdateChecker.currentVersion)"
        versionLabel.frame = NSRect(x: 216, y: y + 7, width: 200, height: 16)
        root.addSubview(versionLabel)

        reloadKeys()
    }

    /// Fill the custom-key fields from the active provider's stored key / model / base URL. A model
    /// equal to the provider's default shows blank so the placeholder carries the default.
    private func reloadKeys() {
        let p = Settings.shared.activeProvider
        apiKeyField.stringValue = Settings.shared.apiKey(for: p.storageKey)
        let m = Settings.shared.apiModel(for: p.storageKey)
        apiModelField.stringValue = (!p.defaultModel.isEmpty && m == p.defaultModel) ? "" : m
        baseURLField.stringValue = Settings.shared.apiCustomBaseURL
    }

    func controlTextDidChange(_ obj: Notification) {
        guard let field = obj.object as? NSTextField,
              let id = field.identifier?.rawValue else { return }
        let storageKey = Settings.shared.activeProvider.storageKey
        switch id {
        case "apiKey": Settings.shared.setAPIKey(field.stringValue, for: storageKey)
        case "apiModel": Settings.shared.setAPIModel(field.stringValue, for: storageKey)
        case "apiBaseURL": Settings.shared.apiCustomBaseURL = field.stringValue
        default: return
        }
        onChange?()
    }

    /// Custom-key provider picker: switch the active third-party provider, then rebuild so the
    /// key/model placeholders and the Base URL row (custom only) match.
    @objc private func providerPicked() {
        guard let id = providerPopup.selectedItem?.representedObject as? String else { return }
        Settings.shared.apiProvider = id
        populate()
        onChange?()
    }

    /// Open the active provider's API-key console in the browser.
    @objc private func openConsole() {
        guard let url = Settings.shared.activeProvider.consoleURL.flatMap(URL.init(string:)) else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func modePicked(_ sender: NSButton) {
        guard let mode = sender.identifier?.rawValue else { return }
        Settings.shared.serviceMode = mode
        // Rebuild so the per-channel fields (custom-key rows, or the CLI engine picker) appear/
        // disappear to match the chosen channel; populate() recreates the radios selected right.
        populate()
        onChange?()
    }

    /// CLI-mode engine picker: choose which local CLI (codex / claude) captures drive.
    @objc private func backendPicked() {
        guard let id = backendPopup.selectedItem?.representedObject as? String else { return }
        Settings.shared.cli = id
        onChange?()
    }

    @objc private func checkUpdates() { UpdateChecker.checkForUpdatesManually() }

    func pageDidShow() {
        rebuildIfCLISwitchChanged()
        reloadKeys()
        // Pull the authoritative account so a just-flipped server-side CLI switch shows up the
        // moment 高级 opens — without the user having to visit 账户与额度 first. A successful
        // refresh whose cli_enabled differs posts accountDidChange, and the observer above
        // rebuilds the page. Only meaningful for the official channel (needs a device token).
        if OfficialAPI.deviceToken != nil {
            Task { @MainActor in _ = await OfficialAPI.refreshAccount() }
        }
    }
}
