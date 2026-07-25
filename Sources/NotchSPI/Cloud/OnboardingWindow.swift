import AppKit
import CoreGraphics

// First-launch onboarding v2 — the product's opening scene. A borderless obsidian window over a
// live aurora shader, five pages, zero technical vocabulary (no API / CLI / Key / Token):
//
//   1. Welcome        — brand moment + language choice (applies live)
//   2. How it works   — hotkey → screen → answer, in three illustrated beats
//   3. Screen access  — why we need it, one-click grant, live green check
//   4. The gift       — tap the sealed medallion to claim a randomly-granted free balance (reveal)
//   5. Try it         — a printed sample question + the hotkey as physical keycaps; finish
//
// Every step is skippable and failure never blocks: registration re-runs on first capture, and
// the capture path already explains a missing screen-recording permission. Power users find the
// custom-key / CLI channels later in 设置 → 高级.
//
// Motion language (shared by every page): elements enter on one cascade — a soft rise with a
// whisper of overshoot — pages hand off with a springed slide + parallax, and state changes
// morph instead of teleporting. Reduce Motion collapses all of it to settled poses.

// DEBUG visual-QA: when a gift number is seeded (NSPI_QA_GIFT), keep the whole flow offline — no
// registration network calls — so screenshots are deterministic and QA never creates throwaway
// rows in the production device DB. Always false in release.
private var onboardingQAOffline: Bool {
    #if DEBUG
    return ProcessInfo.processInfo.environment["NSPI_QA_GIFT"] != nil
    #else
    return false
    #endif
}

// MARK: - Window

/// Borderless, rounded, draggable panel that can become key (buttons + pills need clicks).
final class OnboardingWindow: NSWindow {
    init(contentViewController: NSViewController) {
        super.init(
            contentRect: NSRect(origin: .zero, size: OnboardingViewController.contentSize),
            styleMask: [.borderless, .fullSizeContentView],
            backing: .buffered, defer: false)
        self.contentViewController = contentViewController
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        isMovableByWindowBackground = true
        isReleasedWhenClosed = false
        sharingType = ScreenShareGuard.windowSharingType
        level = .floating
    }

    override var canBecomeKey: Bool { true }

    override func cancelOperation(_ sender: Any?) {
        // Esc = "let me out" — close without blocking; onboarding won't nag again.
        (contentViewController as? OnboardingViewController)?.finish()
    }
}

// MARK: - Shared motion helpers

/// A soft scale-up-and-rise entrance with a whisper of overshoot, scaling around the view's own
/// center (baked into the matrix so the default AppKit anchor point can't drift it sideways).
private func springIn(_ view: NSView, delay: CFTimeInterval) {
    guard let layer = view.layer else { return }
    layer.removeAnimation(forKey: "springIn-t")
    layer.removeAnimation(forKey: "springIn-o")
    let c = CGPoint(x: view.bounds.midX, y: view.bounds.midY)
    var from = CATransform3DIdentity
    from = CATransform3DTranslate(from, 0, -14, 0)          // start a touch low (rises up)
    from = CATransform3DTranslate(from, c.x, c.y, 0)
    from = CATransform3DScale(from, 0.955, 0.955, 1)
    from = CATransform3DTranslate(from, -c.x, -c.y, 0)

    let now = CACurrentMediaTime()
    let t = CABasicAnimation(keyPath: "transform")
    t.fromValue = NSValue(caTransform3D: from)
    t.toValue = NSValue(caTransform3D: CATransform3DIdentity)
    t.duration = 0.62
    t.timingFunction = CAMediaTimingFunction(controlPoints: 0.22, 1.32, 0.36, 1) // ease-out-back
    t.beginTime = now + delay
    t.fillMode = .backwards
    layer.add(t, forKey: "springIn-t")

    let o = CABasicAnimation(keyPath: "opacity")
    o.fromValue = 0
    o.toValue = 1
    o.duration = 0.42
    o.timingFunction = CAMediaTimingFunction(name: .easeOut)
    o.beginTime = now + delay
    o.fillMode = .backwards
    layer.opacity = 1
    layer.add(o, forKey: "springIn-o")
}

/// Stagger `springIn` across a list — the one entrance choreography every page shares.
private func cascadeIn(_ views: [NSView], base: Double = 0.05, step: Double = 0.075) {
    for (i, v) in views.enumerated() { springIn(v, delay: base + Double(i) * step) }
}

/// Leave cleanly so a re-entry replays from a blank slate (no half-finished springs).
private func clearEntrance(_ views: [NSView]) {
    for v in views {
        v.layer?.removeAnimation(forKey: "springIn-t")
        v.layer?.removeAnimation(forKey: "springIn-o")
        v.alphaValue = 1
    }
}

/// A small contented pop (used when a state lands: permission granted, etc.).
private func popLayer(of view: NSView) {
    guard !onboardingReduceMotion(), let layer = view.layer else { return }
    let c = CGPoint(x: view.bounds.midX, y: view.bounds.midY)
    var up = CATransform3DIdentity
    up = CATransform3DTranslate(up, c.x, c.y, 0)
    up = CATransform3DScale(up, 1.05, 1.05, 1)
    up = CATransform3DTranslate(up, -c.x, -c.y, 0)
    let k = CAKeyframeAnimation(keyPath: "transform")
    k.values = [NSValue(caTransform3D: CATransform3DIdentity),
                NSValue(caTransform3D: up),
                NSValue(caTransform3D: CATransform3DIdentity)]
    k.keyTimes = [0, 0.4, 1]
    k.duration = 0.34
    k.timingFunctions = [CAMediaTimingFunction(name: .easeOut), CAMediaTimingFunction(name: .easeInEaseOut)]
    layer.add(k, forKey: "statePop")
}

// MARK: - Page base

/// One onboarding page. Subclasses lay out in a flipped coordinate space sized to `pageSize`.
private class OnboardingPage: NSView {
    override var isFlipped: Bool { true }
    /// Called each time the page becomes the visible one.
    func pageDidAppear() {}
    /// Called when the page is being left (stop timers etc.).
    func pageWillDisappear() {}
    /// Re-render all strings after a language switch.
    func rebuildStrings() {}
    /// Whether the "continue" affordance should be offered yet. A page can withhold it until the
    /// user performs a required action (the gift page requires the claim tap). Never a hard trap:
    /// Back and Esc always work, and the gate flips on the *gesture*, not on network success.
    var allowsAdvance: Bool { true }
    /// Set by the controller; a page calls it when `allowsAdvance` changes so the chrome refreshes.
    var onStateChange: (() -> Void)?
}

private func onboardingLabel(_ text: String = "", size: CGFloat, weight: NSFont.Weight,
                             color: NSColor, align: NSTextAlignment = .center) -> NSTextField {
    let f = NSTextField(wrappingLabelWithString: text)
    f.font = .systemFont(ofSize: size, weight: weight)
    f.textColor = color
    f.alignment = align
    f.isSelectable = false
    return f
}

// MARK: - Panel rim light

/// The hairline of light that makes the panel read as a physical sheet of glass: a 1px ring plus
/// a 2px top bevel where the aurora catches the upper edge. Purely decorative, never intercepts.
private final class PanelRimView: NSView {
    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let rr: CGFloat = 22
        let ring = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5),
                                xRadius: rr - 0.5, yRadius: rr - 0.5)
        ring.lineWidth = 1
        NSColor(white: 1, alpha: 0.09).setStroke()
        ring.stroke()

        ctx.saveGState()
        NSBezierPath(roundedRect: bounds, xRadius: rr, yRadius: rr).addClip()
        let grad = notchGradient([
            (NSColor(white: 1, alpha: 0.13), 0),
            (NSColor(white: 1, alpha: 0.0), 1),
        ])
        ctx.drawLinearGradient(grad, start: CGPoint(x: bounds.midX, y: 0),
                               end: CGPoint(x: bounds.midX, y: 2.5), options: [])
        ctx.restoreGState()
    }
}

// MARK: - View controller

final class OnboardingViewController: NSViewController {
    /// Called after onboarding completes (refresh header labels, drop the window).
    var onFinished: (() -> Void)?

    static let contentSize = NSSize(width: 580, height: 470)
    fileprivate static let pageSize = NSSize(width: 580, height: 386)

    private let aurora = AuroraBackgroundView()
    private let pageHost = OnboardingFlippedView()
    private let rim = PanelRimView()
    private let dots = StepDotsView()
    private let backButton = GlowButton(title: "", style: .ghost)
    private let nextButton = GlowButton(title: "", style: .primary)

    private var pages: [OnboardingPage] = []
    private var index = 0
    private var animating = false
    private weak var currentPageView: OnboardingPage?
    private var didAppearOnce = false
    private var langObserver: NSObjectProtocol?
    #if DEBUG
    private var autoplayTimer: Timer?
    #endif

    private var reduceMotion: Bool { onboardingReduceMotion() }

    override func loadView() {
        let root = OnboardingFlippedView(frame: NSRect(origin: .zero, size: Self.contentSize))
        root.wantsLayer = true
        root.layer?.cornerRadius = 22
        root.layer?.masksToBounds = true
        root.layer?.backgroundColor = NSColor(srgbRed: 0.02, green: 0.02, blue: 0.05, alpha: 1).cgColor

        aurora.frame = root.bounds
        aurora.autoresizingMask = [.width, .height]
        root.addSubview(aurora)

        pageHost.frame = NSRect(x: 0, y: 0, width: Self.pageSize.width, height: Self.pageSize.height)
        root.addSubview(pageHost)

        pages = [WelcomePage(), HowItWorksPage(), PermissionPage(), GiftPage(), TryItPage()]
        dots.count = pages.count

        // Bottom bar: [back ghost] [dots] [continue primary]
        let barY = Self.contentSize.height - 34 - 26
        backButton.onClick = { [weak self] in self?.go(-1) }
        backButton.frame = NSRect(x: 28, y: barY, width: 90, height: 34)
        root.addSubview(backButton)

        dots.frame = NSRect(x: (Self.contentSize.width - dots.intrinsicContentSize.width) / 2,
                            y: barY + 14, width: dots.intrinsicContentSize.width, height: 6)
        root.addSubview(dots)

        nextButton.onClick = { [weak self] in self?.advance() }
        root.addSubview(nextButton)

        rim.frame = root.bounds
        rim.autoresizingMask = [.width, .height]
        root.addSubview(rim)

        view = root

        var startPage = 0
        #if DEBUG
        // Visual-QA hook: `--qa-onboarding-page N` jumps straight to page N for screenshots.
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "--qa-onboarding-page"), i + 1 < args.count,
           let n = Int(args[i + 1]), (0..<pages.count).contains(n) {
            startPage = n
        }
        #endif
        showPage(startPage, direction: 0)

        // Warm up the account in the background so the gift page usually has the number ready.
        if Settings.shared.serviceMode == ServiceMode.official, !onboardingQAOffline {
            Task { await OfficialAPI.registerIfNeeded() }
        }

        langObserver = NotificationCenter.default.addObserver(
            forName: L10n.languageDidChange, object: nil, queue: .main
        ) { [weak self] _ in
            self?.pages.forEach { $0.rebuildStrings() }
            self?.updateChrome()
        }
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        guard !didAppearOnce else { return }
        didAppearOnce = true
        // The start page's entrance plays only once the window is actually on screen — running
        // it during loadView would burn the choreography before anyone can see it.
        pages[index].pageDidAppear()
        #if DEBUG
        // Visual-QA hook: NSPI_QA_AUTOPLAY=1 walks forward through the pages on a fixed beat so
        // transitions can be captured as a burst without simulating pointer clicks.
        if ProcessInfo.processInfo.environment["NSPI_QA_AUTOPLAY"] == "1", autoplayTimer == nil {
            autoplayTimer = Timer.scheduledTimer(withTimeInterval: 1.6, repeats: true) { [weak self] t in
                guard let self else { t.invalidate(); return }
                if self.index < self.pages.count - 1 { self.go(+1) } else { t.invalidate() }
            }
        }
        #endif
    }

    deinit {
        if let langObserver { NotificationCenter.default.removeObserver(langObserver) }
        #if DEBUG
        autoplayTimer?.invalidate()
        #endif
    }

    // MARK: Navigation

    private func advance() {
        guard pages[index].allowsAdvance else { return } // page is withholding "continue" (e.g. claim)
        if index == pages.count - 1 { finish() } else { go(+1) }
    }

    private func go(_ delta: Int) {
        let target = index + delta
        guard !animating, target >= 0, target < pages.count else { return }
        showPage(target, direction: delta)
    }

    /// Pages hand off with depth: the incoming page slides in on a spring and settles while the
    /// outgoing one yields with a shorter parallax drift — two planes, one gesture. All of it is
    /// layer-transform work (no frame animation), so there is nothing to tear or gap.
    private func showPage(_ newIndex: Int, direction: Int) {
        let old = currentPageView
        let page = pages[newIndex]
        index = newIndex
        currentPageView = page
        page.onStateChange = { [weak self] in self?.updateChrome() }
        updateChrome()

        page.frame = pageHost.bounds
        old?.pageWillDisappear()

        guard let old, direction != 0, !reduceMotion else {
            old?.removeFromSuperview()
            pageHost.addSubview(page)
            if view.window != nil { page.pageDidAppear() } // initial appear is driven by viewDidAppear
            return
        }

        animating = true
        pageHost.addSubview(page)
        let w = pageHost.bounds.width
        let dir = CGFloat(direction)
        guard let inLayer = page.layer, let outLayer = old.layer else {
            old.removeFromSuperview()
            animating = false
            page.pageDidAppear()
            return
        }

        CATransaction.begin()
        CATransaction.setCompletionBlock { [weak old] in
            old?.removeFromSuperview()
            old?.layer?.removeAllAnimations()
            old?.alphaValue = 1
        }

        let slideIn = CASpringAnimation(keyPath: "transform.translation.x")
        slideIn.fromValue = dir * w * 0.42
        slideIn.toValue = 0
        slideIn.mass = 1
        slideIn.stiffness = 240
        slideIn.damping = 28
        slideIn.duration = min(slideIn.settlingDuration, 0.85)
        inLayer.add(slideIn, forKey: "slideIn")

        let fadeIn = CABasicAnimation(keyPath: "opacity")
        fadeIn.fromValue = 0
        fadeIn.toValue = 1
        fadeIn.duration = 0.30
        fadeIn.timingFunction = CAMediaTimingFunction(name: .easeOut)
        inLayer.add(fadeIn, forKey: "fadeIn")

        let slideOut = CABasicAnimation(keyPath: "transform.translation.x")
        slideOut.fromValue = 0
        slideOut.toValue = -dir * w * 0.30
        slideOut.duration = 0.32
        slideOut.timingFunction = CAMediaTimingFunction(controlPoints: 0.3, 0, 0.4, 1)
        slideOut.fillMode = .forwards
        slideOut.isRemovedOnCompletion = false
        outLayer.add(slideOut, forKey: "slideOut")

        let fadeOut = CABasicAnimation(keyPath: "opacity")
        fadeOut.fromValue = 1
        fadeOut.toValue = 0
        fadeOut.duration = 0.26
        fadeOut.timingFunction = CAMediaTimingFunction(name: .easeIn)
        fadeOut.fillMode = .forwards
        fadeOut.isRemovedOnCompletion = false
        outLayer.add(fadeOut, forKey: "fadeOut")

        CATransaction.commit()

        // The new page starts its own entrance cascade while it is still gliding in — layered
        // choreography, not queued steps. Re-arm the tap guard once the hand-off reads as done.
        page.pageDidAppear()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.38) { [weak self] in self?.animating = false }
    }

    /// Bottom-bar state for the current page (labels follow the live language).
    private func updateChrome() {
        dots.current = index
        backButton.title = L10n.back
        backButton.isHidden = index == 0
        let last = index == pages.count - 1
        nextButton.title = last
            ? L10n.t("开始使用", "使いはじめる", "Start Using")
            : (index == 0 ? L10n.t("开始", "はじめる", "Get Started") : L10n.next)
        // A page can withhold "continue" until a required action is done (the gift claim). Hide it
        // rather than show a dead, dimmed control — the page's own primary CTA carries the flow.
        nextButton.isHidden = !pages[index].allowsAdvance
        let size = nextButton.intrinsicContentSize
        let barY = Self.contentSize.height - 34 - 26
        nextButton.frame = NSRect(x: Self.contentSize.width - 28 - size.width, y: barY,
                                  width: size.width, height: 34)
        nextButton.needsDisplay = true
        backButton.needsDisplay = true
    }

    fileprivate func finish() {
        Settings.shared.onboardingDone = true
        onFinished?()
        view.window?.close()
    }
}

private final class OnboardingFlippedView: NSView {
    override var isFlipped: Bool { true }
}

// MARK: - Page 1 · Welcome

private final class WelcomePage: OnboardingPage {
    private let rose = RoseLoaderView()
    private let title = onboardingLabel(size: 32, weight: .bold, color: .white)
    private let tagline = onboardingLabel(size: 13.5, weight: .regular, color: NSColor(white: 1, alpha: 0.68))
    private var pills: [LanguagePill] = []

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        let size = OnboardingViewController.pageSize

        rose.hero = true
        rose.frame = NSRect(x: size.width / 2 - 48, y: 56, width: 96, height: 96)
        addSubview(rose)

        title.frame = NSRect(x: 40, y: 192, width: size.width - 80, height: 42)
        addSubview(title)

        tagline.frame = NSRect(x: 56, y: 246, width: size.width - 112, height: 24)
        addSubview(tagline)

        // Language pills — preselected from the system, applied live on click.
        let choices: [AppLanguage] = [.zhHans, .ja, .en]
        var totalW: CGFloat = 0
        for lang in choices {
            let pill = LanguagePill(language: lang)
            pill.onPick = { [weak self] picked in
                L10n.setting = picked // fires languageDidChange → whole flow re-renders
                self?.refreshPills()
            }
            pills.append(pill)
            totalW += pill.intrinsicContentSize.width
        }
        totalW += CGFloat(pills.count - 1) * 10
        var x = (size.width - totalW) / 2
        for pill in pills {
            let w = pill.intrinsicContentSize.width
            pill.frame = NSRect(x: x, y: 300, width: w, height: 28)
            addSubview(pill)
            x += w + 10
        }

        rebuildStrings()
        refreshPills()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private var entranceViews: [NSView] { [rose, title, tagline] + pills }

    override func pageDidAppear() {
        guard !onboardingReduceMotion() else { return }
        cascadeIn(entranceViews, base: 0.04, step: 0.06)
    }

    override func pageWillDisappear() {
        clearEntrance(entranceViews)
    }

    private func refreshPills() {
        let resolved = L10n.lang
        for pill in pills {
            let matches: Bool
            switch (pill.language, resolved) {
            case (.zhHans, .zh), (.ja, .ja), (.en, .en): matches = true
            default: matches = false
            }
            pill.isChosen = matches
        }
    }

    override func rebuildStrings() {
        // The wordmark: crisp white with a touch of air between letters — typography, not lettering.
        let para = NSMutableParagraphStyle()
        para.alignment = .center
        title.attributedStringValue = NSAttributedString(
            string: "NotchSPI",
            attributes: [
                .font: NSFont.systemFont(ofSize: 32, weight: .bold),
                .foregroundColor: NSColor.white,
                .kern: 0.6,
                .paragraphStyle: para,
            ])
        tagline.stringValue = L10n.t(
            "藏在刘海里的解题助手 — 一按快捷键，答案悄悄浮现。",
            "ノッチにひそむ解答アシスタント — ショートカットひとつで、答えがそっと現れる。",
            "The answer assistant hiding in your notch — one hotkey, and the answer quietly appears.")
        refreshPills()
    }
}

// MARK: - Page 2 · How it works

private final class HowItWorksPage: OnboardingPage {
    private let heading = onboardingLabel(size: 21, weight: .bold, color: .white)
    private var rowContainers: [NSView] = []
    private var titleLabels: [NSTextField] = []       // rows 2 & 3 (row 1 composes the hotkey)
    private var descLabels: [NSTextField] = []

    // Row 1's title is text + real (mini) keycaps, matching the "Try it" page — one visual
    // language for "press this" everywhere. Word order differs per language (按下 ⌘1 / ⌘1 を押す),
    // hence prefix + caps + suffix. Single-line labels: a wrapping label would fold at a tight
    // measured width and silently swallow characters.
    private static func hotkeyLabel() -> NSTextField {
        let f = NSTextField(labelWithString: "")
        f.font = .systemFont(ofSize: 14.5, weight: .semibold)
        f.textColor = .white
        f.alignment = .left
        f.isSelectable = false
        return f
    }
    private let hotkeyPrefix = HowItWorksPage.hotkeyLabel()
    private let hotkeyCaps = KeycapChipView(keys: [], capSize: 20)
    private let hotkeySuffix = HowItWorksPage.hotkeyLabel()

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        let size = OnboardingViewController.pageSize

        heading.wantsLayer = true
        heading.frame = NSRect(x: 40, y: 42, width: size.width - 80, height: 30)
        addSubview(heading)

        // Three numbered beats — the heading promises "three steps", so the steps carry their
        // numbers. Typography does the structure: an accent numeral in the gutter, title, one
        // line of body. No icon chrome, no containers.
        let rowX: CGFloat = 104
        let rowStep: CGFloat = 86
        var y: CGFloat = 118
        for i in 0..<3 {
            let container = OnboardingFlippedView(frame: NSRect(x: rowX, y: y, width: size.width - rowX - 84, height: 70))
            container.wantsLayer = true

            let numeral = NSTextField(labelWithString: "\(i + 1)")
            numeral.font = .monospacedDigitSystemFont(ofSize: 15, weight: .semibold)
            numeral.textColor = NotchPalette.accentHi
            numeral.alignment = .left
            numeral.frame = NSRect(x: 8, y: i == 0 ? 4 : 3, width: 24, height: 20)
            container.addSubview(numeral)

            if i == 0 {
                // Composite hotkey title: [prefix][keycaps][suffix], laid out in rebuildStrings.
                let strip = OnboardingFlippedView(frame: NSRect(x: 40, y: 0, width: container.bounds.width - 40, height: 28))
                strip.addSubview(hotkeyPrefix)
                strip.addSubview(hotkeyCaps)
                strip.addSubview(hotkeySuffix)
                container.addSubview(strip)
            } else {
                let t = onboardingLabel(size: 14.5, weight: .semibold, color: .white, align: .left)
                t.frame = NSRect(x: 40, y: 4, width: container.bounds.width - 40, height: 20)
                container.addSubview(t)
                titleLabels.append(t)
            }

            let d = onboardingLabel(size: 12, weight: .regular, color: NSColor(white: 1, alpha: 0.6), align: .left)
            d.frame = NSRect(x: 40, y: i == 0 ? 32 : 28, width: container.bounds.width - 40, height: 34)
            container.addSubview(d)
            descLabels.append(d)

            addSubview(container)
            rowContainers.append(container)
            y += rowStep
        }
        rebuildStrings()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func rebuildStrings() {
        heading.stringValue = L10n.t("三步，答案到手", "3ステップで答えが手に入る", "Three beats to an answer")

        // Row 1: the hotkey as real keycaps inside the sentence.
        let prefix = L10n.t("按下", "", "Press")
        let suffix = L10n.t("", "を押す", "")
        hotkeyPrefix.stringValue = prefix
        hotkeySuffix.stringValue = suffix
        hotkeyCaps.keys = KeycapChipView.caps(from: Settings.shared.captureCombo)
        layoutHotkeyStrip()

        let texts: [(String, String)] = [
            ("", L10n.t("在任何题目界面按下快捷键 — 网页、PDF、题库软件都可以。",
                        "問題が表示されている画面ならどこでも — Web、PDF、テストアプリでもOK。",
                        "On any screen with a question — web pages, PDFs, quiz apps, anything.")),
            (L10n.t("屏幕被轻轻读取", "画面をそっと読み取る", "Your screen is read, gently"),
             L10n.t("NotchSPI 截取当前画面并识别其中的题目，全程无需复制粘贴。",
                    "NotchSPI が画面を読み取り問題を認識。コピー&ペーストは不要。",
                    "NotchSPI captures the screen and reads the question — no copy-paste, ever.")),
            (L10n.t("答案从刘海流出", "ノッチから答えが流れ出す", "The answer flows from the notch"),
             L10n.t("讲解在刘海下方逐字浮现，且不会出现在录屏和共享画面里。",
                    "解説がノッチの下に少しずつ現れます。画面録画や共有には映りません。",
                    "The explanation streams in below the notch — invisible to recordings and screen shares.")),
        ]
        for (i, d) in descLabels.enumerated() { d.stringValue = texts[i].1 }
        for (i, t) in titleLabels.enumerated() { t.stringValue = texts[i + 1].0 }
    }

    /// Position [prefix][caps][suffix] as one text line, caps optically centered on the cap line.
    private func layoutHotkeyStrip() {
        let gap: CGFloat = 7
        let stripH: CGFloat = 28
        var x: CGFloat = 0
        hotkeyPrefix.sizeToFit()
        if !hotkeyPrefix.stringValue.isEmpty {
            hotkeyPrefix.frame.origin = NSPoint(x: 0, y: (stripH - hotkeyPrefix.frame.height) / 2)
            x = hotkeyPrefix.frame.maxX + gap
        } else {
            hotkeyPrefix.frame = .zero
        }
        let capsSize = hotkeyCaps.intrinsicContentSize
        hotkeyCaps.frame = NSRect(x: x, y: (stripH - capsSize.height) / 2,
                                  width: capsSize.width, height: capsSize.height)
        x += capsSize.width
        hotkeySuffix.sizeToFit()
        if !hotkeySuffix.stringValue.isEmpty {
            hotkeySuffix.frame.origin = NSPoint(x: x + gap, y: (stripH - hotkeySuffix.frame.height) / 2)
        } else {
            hotkeySuffix.frame = .zero
        }
    }

    override func pageDidAppear() {
        guard !onboardingReduceMotion() else {
            clearEntrance([heading] + rowContainers)
            return
        }
        // Choreographed cascade: heading leads, the three beats settle in on a soft spring.
        springIn(heading, delay: 0)
        for (i, container) in rowContainers.enumerated() {
            springIn(container, delay: 0.10 + Double(i) * 0.11)
        }
    }

    override func pageWillDisappear() {
        clearEntrance([heading] + rowContainers)
    }
}

// MARK: - Page 3 · Screen access

private final class PermissionPage: OnboardingPage {
    // A bare tinted symbol — the system's own iconography, no decorative container.
    private let icon: NSImageView = {
        let iv = NSImageView()
        iv.image = notchTintedSymbol("rectangle.inset.filled.badge.record", pointSize: 44,
                                     weight: .regular, color: NotchPalette.accentHi)
        iv.imageScaling = .scaleNone
        iv.wantsLayer = true
        return iv
    }()
    private let heading = onboardingLabel(size: 21, weight: .bold, color: .white)
    private let body = onboardingLabel(size: 13, weight: .regular, color: NSColor(white: 1, alpha: 0.65))
    private let grantButton = GlowButton(title: "", style: .primary)
    private let statusLabel = onboardingLabel(size: 13, weight: .medium, color: NSColor(white: 1, alpha: 0.45))
    private var pollTimer: Timer?
    private var wasGranted = false

    private var granted: Bool { CGPreflightScreenCaptureAccess() }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        let size = OnboardingViewController.pageSize

        icon.frame = NSRect(x: size.width / 2 - 36, y: 64, width: 72, height: 72)
        addSubview(icon)

        heading.frame = NSRect(x: 40, y: 158, width: size.width - 80, height: 30)
        addSubview(heading)

        body.frame = NSRect(x: 75, y: 196, width: size.width - 150, height: 62)
        addSubview(body)

        grantButton.onClick = { [weak self] in self?.grantTapped() }
        addSubview(grantButton)

        statusLabel.frame = NSRect(x: 40, y: 332, width: size.width - 80, height: 22)
        addSubview(statusLabel)

        wasGranted = granted
        rebuildStrings()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private var entranceViews: [NSView] { [icon, heading, body, grantButton, statusLabel] }

    override func rebuildStrings() {
        heading.stringValue = L10n.t("允许 NotchSPI 看到屏幕", "画面へのアクセスを許可", "Let NotchSPI see your screen")
        body.stringValue = L10n.t(
            "为了读取屏幕上的题目，需要你在系统设置里勾选「屏幕录制」权限。截图只在按下快捷键的那一刻发生，用完即删。",
            "画面上の問題を読み取るために、システム設定で「画面収録」の許可が必要です。撮影はショートカットを押した瞬間だけ。使用後は即座に削除されます。",
            "To read questions on your screen, macOS asks you to allow Screen Recording. A capture happens only at the moment you press the hotkey, and is deleted right after use.")
        refreshStatus(animated: false)
    }

    /// One control tells the whole story: a primary "grant" action before, a quiet green settled
    /// chip after — never a bright button that no longer does anything.
    private func refreshStatus(animated: Bool) {
        if granted {
            grantButton.style = .confirm
            grantButton.title = L10n.t("✓ 已授权，一切就绪", "✓ 許可されました。準備完了", "✓ Granted — all set")
            statusLabel.isHidden = true
            pollTimer?.invalidate()
            pollTimer = nil
        } else {
            grantButton.style = .primary
            grantButton.title = L10n.t("去授权", "許可する", "Grant Access")
            statusLabel.isHidden = false
            statusLabel.stringValue = L10n.t("尚未授权 — 也可以稍后在需要时再开",
                                             "未許可 — あとで必要になったときでもOK",
                                             "Not granted yet — you can also do this later")
        }
        layoutButton()
        if animated, granted, !wasGranted {
            // The grant lands live (user returns from System Settings): the chip morph gets a
            // contented pop — the moment is acknowledged, not just repainted.
            popLayer(of: grantButton)
            popLayer(of: icon)
        }
        wasGranted = granted
    }

    private func layoutButton() {
        let w = grantButton.intrinsicContentSize.width
        grantButton.frame = NSRect(x: (OnboardingViewController.pageSize.width - w) / 2, y: 276, width: w, height: 34)
        grantButton.needsDisplay = true
    }

    private func grantTapped() {
        guard !granted else { return }
        // First call triggers the system prompt; later calls open System Settings directly.
        if !CGRequestScreenCaptureAccess() {
            let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!
            NSWorkspace.shared.open(url)
        }
    }

    override func pageDidAppear() {
        refreshStatus(animated: false)
        if !onboardingReduceMotion() {
            cascadeIn(entranceViews, base: 0.04, step: 0.07)
        }
        guard !granted, pollTimer == nil else { return }
        // Live-poll while the user is off in System Settings; the green chip appears by itself.
        pollTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            if self.granted { self.refreshStatus(animated: true) }
        }
    }

    override func pageWillDisappear() {
        pollTimer?.invalidate()
        pollTimer = nil
        clearEntrance(entranceViews)
    }

    deinit { pollTimer?.invalidate() }
}

// MARK: - Page 4 · The gift  (claim-to-reveal)

/// The welcome gift is *earned by a tap*: a sealed brand medallion the player opens to reveal a
/// randomly-granted free balance (100–180, decided server-side at registration — see OfficialAPI /
/// the register route). Opening plays a charge→break→count-up→burst sequence; the odometer lands on
/// the real granted number. "Continue" stays hidden until the claim gesture, so the step can't be
/// skipped past — but Back and Esc always work, and the gate flips on the tap, never on the network.
/// The medallion itself is the hero and the button; the capsule below is a quiet secondary path.
private final class GiftPage: OnboardingPage {
    private enum Phase { case sealed, revealing, revealed }

    private let heading = onboardingLabel(size: 21, weight: .bold, color: .white)
    private let seal = GiftSealView()
    private let odometer = DigitOdometerView()
    private let burst = RewardBurstView()
    private let caption = onboardingLabel(size: 12.5, weight: .regular, color: NSColor(white: 1, alpha: 0.5))
    private let claimButton = GlowButton(title: "", style: .secondary)
    private let note = onboardingLabel(size: 13, weight: .regular, color: NSColor(white: 1, alpha: 0.66))

    private var phase: Phase = .sealed
    private var hasClaimed = false

    private var reduceMotion: Bool { onboardingReduceMotion() }
    override var allowsAdvance: Bool { hasClaimed }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        let size = OnboardingViewController.pageSize
        let cx = size.width / 2

        heading.frame = NSRect(x: 40, y: 38, width: size.width - 80, height: 30)
        addSubview(heading)

        // Seal + odometer share the same optical center so the number emerges where the seal broke.
        let sealSide: CGFloat = 148
        let sealCenterY: CGFloat = 168
        seal.frame = NSRect(x: cx - sealSide / 2, y: sealCenterY - sealSide / 2, width: sealSide, height: sealSide)
        seal.onClick = { [weak self] in self?.claim() }
        addSubview(seal)

        odometer.color = .white
        odometer.fontSize = 58
        odometer.frame = NSRect(x: 40, y: sealCenterY - 58, width: size.width - 80, height: 116)
        odometer.isHidden = true
        addSubview(odometer)

        caption.alignment = .center
        caption.frame = NSRect(x: 40, y: 258, width: size.width - 80, height: 20)
        addSubview(caption)

        claimButton.onClick = { [weak self] in self?.claim() }
        addSubview(claimButton) // framed in rebuildStrings once its title width is known

        note.frame = NSRect(x: 66, y: 254, width: size.width - 132, height: 56)
        note.alphaValue = 0
        addSubview(note)

        // The burst sits on top (sparks overlay everything) but never intercepts clicks; sized
        // generously around the seal center so streaks have room before the card clips them.
        burst.frame = NSRect(x: cx - 260, y: sealCenterY - 180, width: 520, height: 360)
        addSubview(burst)

        rebuildStrings()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func rebuildStrings() {
        heading.stringValue = phase == .sealed
            ? L10n.t("你的见面礼", "はじめましての贈りもの", "A little welcome gift")
            : L10n.t("见面礼已到账", "贈りもの、届きました", "Your gift has arrived")
        odometer.suffix = L10n.t("题", "問", "questions")
        caption.stringValue = L10n.t("轻点领取 · 随机 100–180 题",
                                     "タップして受け取る · 100–180問からランダム",
                                     "Tap to claim · a random 100–180 questions")
        claimButton.title = L10n.t("领取见面礼", "受け取る", "Claim gift")
        layoutClaimButton()
        if phase == .revealed { note.stringValue = noteText() }
    }

    private func layoutClaimButton() {
        let w = claimButton.intrinsicContentSize.width
        claimButton.frame = NSRect(x: (OnboardingViewController.pageSize.width - w) / 2, y: 290, width: w, height: 34)
        claimButton.needsDisplay = true
    }

    // MARK: Claim → reveal

    /// The real granted balance, or nil if registration hasn't landed yet. A DEBUG hook lets QA
    /// seed a deterministic number so the reveal can be screenshotted offline.
    private func resolvedNumber() -> Int? {
        #if DEBUG
        if let raw = ProcessInfo.processInfo.environment["NSPI_QA_GIFT"], let n = Int(raw) { return n }
        #endif
        if OfficialAPI.deviceToken != nil, let b = OfficialAPI.balanceQuestions { return b }
        return nil
    }

    private func claim() {
        guard phase == .sealed else { return }
        phase = .revealing
        hasClaimed = true
        onStateChange?()          // let the chrome reveal "continue"
        heading.stringValue = L10n.t("见面礼已到账", "贈りもの、届きました", "Your gift has arrived")
        fade(caption, to: 0)
        fade(claimButton, to: 0)

        let known = resolvedNumber()
        guard !reduceMotion else {
            seal.isHidden = true
            reveal(number: known, animated: false)
            return
        }
        seal.onBreakComplete = { [weak self] in self?.reveal(number: known, animated: true) }
        seal.breakOpen()
    }

    /// Hand-off from the broken seal: show the number (rolling it up), or a gentle "arriving" state
    /// while registration finishes. Idempotent guards keep a late async result from double-firing.
    private func reveal(number known: Int?, animated: Bool) {
        if let n = known {
            odometer.isHidden = false
            if animated {
                burst.burst(intensity: burstIntensity(for: n))
                odometer.onFinished = { [weak self] in self?.fadeInNote(success: true) }
                odometer.roll(to: n, duration: 1.4)
            } else {
                odometer.setImmediate(n)
                note.stringValue = noteText(success: true)
                note.alphaValue = 1
            }
            phase = .revealed
        } else {
            // Number not ready (offline / registration in flight). Break already played; show a
            // calm "arriving" line, then resolve when the network answers.
            odometer.isHidden = true
            note.stringValue = arrivingText()
            note.alphaValue = 1
            Task { @MainActor in
                _ = await OfficialAPI.registerIfNeeded()
                guard self.phase == .revealing else { return }
                if let n = self.resolvedNumber() {
                    self.odometer.isHidden = false
                    if animated {
                        self.burst.burst(intensity: self.burstIntensity(for: n))
                        self.odometer.roll(to: n, duration: 1.2)
                    } else {
                        self.odometer.setImmediate(n)
                    }
                    self.note.stringValue = self.noteText(success: true)
                } else {
                    self.note.stringValue = self.noteText(success: false) // "arrives on first use"
                }
                self.phase = .revealed
            }
        }
    }

    private func fadeInNote(success: Bool) {
        note.stringValue = noteText(success: success)
        guard !reduceMotion else { note.alphaValue = 1; return }
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.5
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            note.animator().alphaValue = 1
        }
    }

    /// Bigger gift, bigger celebration — a small, honest delight (100 ⇒ ~0.7, 180 ⇒ ~1.2).
    private func burstIntensity(for n: Int) -> CGFloat {
        let t = max(0, min(1, CGFloat(n - 100) / 80))
        return 0.72 + t * 0.5
    }

    private func noteText(success: Bool = true) -> String {
        success
            ? L10n.t("免费额度已到账。每答一题消耗 1 题，失败不扣。",
                     "無料枠が届きました。1回の回答につき1問消費。失敗時は消費されません。",
                     "Your free questions have arrived. Each answer costs one; failures are never charged.")
            : L10n.t("免费额度将在首次使用时自动到账（需要联网）。",
                     "無料枠は初回利用時に自動で届きます(ネット接続が必要)。",
                     "Your free questions will arrive automatically on first use (network required).")
    }

    private func arrivingText() -> String {
        L10n.t("正在为你准备额度…", "残高を準備しています…", "Preparing your questions…")
    }

    private func fade(_ view: NSView, to alpha: CGFloat) {
        guard !reduceMotion else { view.alphaValue = alpha; view.isHidden = alpha == 0; return }
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.22
            view.animator().alphaValue = alpha
        }, completionHandler: { if alpha == 0 { view.isHidden = true } })
    }

    // MARK: Appearance

    override func pageDidAppear() {
        if phase != .sealed {
            // Returning to an already-claimed gift: show the settled state, no re-animation.
            seal.isHidden = true
            caption.isHidden = true
            claimButton.isHidden = true
            odometer.isHidden = false
            note.alphaValue = 1
            return
        }
        // Make sure the account is warming up so the number is ready by the time they tap.
        if OfficialAPI.deviceToken == nil, Settings.shared.serviceMode == ServiceMode.official,
           !onboardingQAOffline {
            Task { await OfficialAPI.registerIfNeeded() }
        }
        #if DEBUG
        // Visual-QA: NSPI_QA_AUTOCLAIM=1 fires the claim automatically (pair with NSPI_QA_GIFT=N)
        // so the reveal sequence can be screenshotted without simulating a pointer click.
        if ProcessInfo.processInfo.environment["NSPI_QA_AUTOCLAIM"] == "1" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in self?.claim() }
        }
        #endif

        guard !reduceMotion else { return }
        cascadeIn([heading, seal, caption, claimButton], base: 0.04, step: 0.08)
    }

    override func pageWillDisappear() {
        clearEntrance([heading, seal, caption, claimButton])
    }
}

// MARK: - Page 5 · Try it

private final class TryItPage: OnboardingPage {
    private let heading = onboardingLabel(size: 21, weight: .bold, color: .white)
    private let card = DemoQuestionCard(frame: NSRect(x: 0, y: 0, width: 440, height: 72))
    private let keycaps = KeycapChipView(keys: [], capSize: 44)
    private let hint = onboardingLabel(size: 13, weight: .regular, color: NSColor(white: 1, alpha: 0.65))
    private let subHint = onboardingLabel(size: 12, weight: .regular, color: NSColor(white: 1, alpha: 0.45))
    private var stuckTimer: Timer?
    /// Set once the page has waited without the capture hotkey ever being delivered.
    private var stuck = false

    /// How long to let the page sit before assuming the keystroke is not arriving. Long enough
    /// that a reader who is simply taking their time is never nagged.
    private static let stuckAfter: TimeInterval = 15

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        let size = OnboardingViewController.pageSize

        heading.frame = NSRect(x: 40, y: 36, width: size.width - 80, height: 30)
        addSubview(heading)

        card.frame.origin = NSPoint(x: (size.width - 440) / 2, y: 96)
        addSubview(card)

        keycaps.wantsLayer = true
        addSubview(keycaps)

        hint.frame = NSRect(x: 56, y: 284, width: size.width - 112, height: 20)
        addSubview(hint)

        subHint.frame = NSRect(x: 56, y: 318, width: size.width - 112, height: 48)
        addSubview(subHint)

        rebuildStrings()
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    private var entranceViews: [NSView] { [heading, card, keycaps, hint, subHint] }

    override func rebuildStrings() {
        heading.stringValue = L10n.t("现在就试一题", "さっそく1問解いてみよう", "Try one right now")
        card.setQuestion(L10n.t("解方程：x² − 5x + 6 = 0",
                                "解きなさい：x² − 5x + 6 = 0",
                                "Solve: x² − 5x + 6 = 0"))
        keycaps.keys = KeycapChipView.caps(from: Settings.shared.captureCombo)
        let w = keycaps.intrinsicContentSize.width
        keycaps.frame = NSRect(x: (OnboardingViewController.pageSize.width - w) / 2, y: 214,
                               width: w, height: keycaps.intrinsicContentSize.height)
        // One instruction, one line. The notch demonstrates the rest itself.
        hint.stringValue = stuck
            ? L10n.t("按了没反应？这个组合键多半被其他 App 占用了。",
                     "反応がありませんか？このキーの組み合わせは他のアプリが使用中の可能性があります。",
                     "Nothing happening? Another app is probably holding this combo.")
            : L10n.t("按下组合键。",
                     "このキーを押すだけ。",
                     "Press these keys.")
        hint.textColor = stuck ? NSColor.systemOrange : NSColor(white: 1, alpha: 0.65)
        subHint.stringValue = stuck
            ? L10n.t("在刘海右侧的 ⚙ 设置 →「快捷键」里换一个组合键，然后回来再试。",
                     "ノッチ右側の ⚙ 設定 →「ショートカット」で別の組み合わせに変更してから、もう一度お試しください。",
                     "Pick another combo in ⚙ Settings → Hotkeys, at the right edge of the notch, then come back and try again.")
            : L10n.t("之后在任何题目界面都能这样用。\n快捷键、语言、外观，都在刘海右侧的 ⚙ 设置里。",
                     "この先はどんな問題画面でも同じように使えます。\nショートカットや言語、外観はノッチ右側の ⚙ 設定から。",
                     "From now on this works on any question, anywhere. Hotkeys, language,\nappearance — all in ⚙ Settings, at the right edge of the notch.")
    }

    // The hotkey capture must SEE the sample question: SCScreenshotManager honors sharingType
    // and drops `.none` windows from the shot (verified empirically), so this page — and only
    // this page — opts the onboarding window back into capture. Both hooks are needed: when
    // this is the START page, pageDidAppear runs during loadView where `window` is still nil,
    // and viewDidMoveToWindow covers that moment.
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if superview != nil { window?.sharingType = .readWrite }
    }

    override func pageDidAppear() {
        window?.sharingType = .readWrite
        rebuildStrings()
        // A dead hotkey cannot be detected up front: RegisterEventHotKey happily succeeds while
        // another app keeps the keystroke, and macOS offers no way to ask who won. So this page
        // watches instead — if nothing has been delivered by the time a willing user would have
        // pressed, it stops repeating the instruction and says what is probably wrong.
        stuckTimer?.invalidate()
        stuckTimer = Timer.scheduledTimer(withTimeInterval: Self.stuckAfter, repeats: false) {
            [weak self] _ in
            guard let self, !HotKeyCenter.shared.hasFired(.capture) else { return }
            self.stuck = true
            self.rebuildStrings()
        }
        guard !onboardingReduceMotion() else { return }
        cascadeIn(entranceViews, base: 0.04, step: 0.07)
    }

    override func pageWillDisappear() {
        window?.sharingType = ScreenShareGuard.windowSharingType
        stuckTimer?.invalidate()
        stuckTimer = nil
        clearEntrance(entranceViews)
    }

    deinit { stuckTimer?.invalidate() }
}

/// A quiet surface printing a real sample question on the page, so the very first hotkey press
/// has something to answer. Pairs with TryItPage.pageDidAppear flipping the window to
/// `.readWrite`: without that, SCK would drop the (normally capture-hidden) onboarding window
/// from the shot and the model would never see this question.
private final class DemoQuestionCard: NSView {
    override var isFlipped: Bool { true }
    private let question = onboardingLabel(size: 22, weight: .semibold, color: .white)

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        question.frame = NSRect(x: 20, y: (frameRect.height - 32) / 2, width: frameRect.width - 40, height: 32)
        addSubview(question)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func setQuestion(_ text: String) {
        question.stringValue = text
    }

    override func draw(_ dirtyRect: NSRect) {
        // A quiet document surface — this is the exhibit the capture will read, not a feature
        // card. One elevated fill, one hairline; the typography carries it.
        let r = bounds.insetBy(dx: 1, dy: 1)
        let path = NSBezierPath(roundedRect: r, xRadius: 14, yRadius: 14)
        NSColor(white: 1, alpha: 0.045).setFill()
        path.fill()
        path.lineWidth = 1
        NSColor(white: 1, alpha: 0.11).setStroke()
        path.stroke()
    }
}
