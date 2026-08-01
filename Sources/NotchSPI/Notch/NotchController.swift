import AppKit
import Carbon.HIToolbox

@MainActor
final class NotchController: NSObject {
    let model = TutorModel()
    private let personalitySession = PersonalitySession()
    private let panel: NotchPanel
    private var notchView: NotchView!
    private var hovering = false
    private var pinned = false
    private var running = false
    /// Guarantees `running` always comes back — see `beginRun()`.
    private var runWatchdog: Timer?
    /// Bumped for every capture, so a run abandoned by the watchdog can't reach back in and
    /// clobber the state of the one the user started afterwards.
    private var runGeneration: UInt64 = 0
    private var visible = true
    private var collapseWork: DispatchWorkItem?
    /// Auto-session brain (pure state machine); the controller owns the timer + capture I/O.
    private let autoEngine = AutoSessionEngine()
    private var autoPollTimer: Timer?
    private var autoHashInFlight = false
    /// 截图目标锁定: the session only triggers while this app is frontmost. Derived at
    /// session start (explicit capture-target app, else the then-frontmost app); nil = no lock.
    private var autoLockedBundleID: String?
    private var autoPaused = false // edge-transition tracking for the DEBUG log only
    private var settingsController: MainSettingsWindowController?
    private var onboardingWindow: NSWindow?
    private var observers: [NSObjectProtocol] = []
    private var observedPersonalityScope: PersonalitySessionScope?

    private let expandedWidth: CGFloat = 600

    private struct RunSnapshot {
        let mode: String
        let depth: String
        let personaID: String
        let personaName: String
        let personaText: String
        let captureTarget: CaptureTarget
        let channel: ServiceChannel
        let cliID: String
        let provider: APIProvider
        let apiEndpoint: String
        let apiModel: String

        var captureTargetID: String {
            switch captureTarget {
            case .fullScreen: return "full-screen"
            case .app(let bundleID): return "app:\(bundleID)"
            }
        }

        var channelID: String {
            switch channel {
            case .official:
                return "official:\(OfficialAPI.baseURL)"
            case .customKey:
                return "custom:\(provider.id):\(apiEndpoint):\(apiModel)"
            case .cli:
                return "cli:\(cliID)"
            }
        }

        var personalityScope: PersonalitySessionScope {
            PersonalitySessionScope(
                personaID: personaID,
                personaName: personaName,
                personaText: personaText,
                captureTargetID: captureTargetID,
                channelID: channelID
            )
        }
    }

    override init() {
        panel = NotchPanel(contentRect: .zero)
        super.init()
        refreshCLILabel()
        model.statusText = L10n.statusReady
        model.depthLabel = L10n.depthLabel(Settings.shared.depth)

        let view = NotchView(
            model: model,
            frameProvider: { [weak self] expanded in self?.frame(expanded: expanded) ?? .zero },
            onHover: { [weak self] in self?.hover($0) },
            onCycleDepth: { [weak self] in self?.cycleDepth() },
            onEditPersona: { [weak self] in self?.openSettings(page: .personas) },
            onSettings: { [weak self] in self?.showSettings() },
            onToggleReasoning: { [weak self] in
                guard let self else { return }
                self.model.reasoningRevealed.toggle()
                self.resizeToFit() // the height spring glides the fold/unfold
            },
            onStopAuto: { [weak self] in self?.stopAutoSession(.stopButton) }
        )
        view.autoresizingMask = [.width, .height]
        notchView = view
        panel.contentView = view
        panel.setFrame(frame(expanded: false), display: true)

        refreshModeLabels()
        registerHotkeys()

        // Language / theme switches re-render the always-visible notch immediately.
        observers.append(NotificationCenter.default.addObserver(
            forName: L10n.languageDidChange, object: nil, queue: .main
        ) { [weak self] _ in Task { @MainActor in self?.refreshAfterLanguageChange() } })
        observers.append(NotificationCenter.default.addObserver(
            forName: Appearance.themeDidChange, object: nil, queue: .main
        ) { [weak self] _ in Task { @MainActor in self?.refreshAppearance() } })

        // Pre-enumerate shareable content so the first hotkey press skips the ~100–300ms
        // window-server enumeration; kept fresh after each shot and across display changes.
        Task { @MainActor in ScreenCapture.prefetchShareableContent() }
        observers.append(NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { _ in
            Task { @MainActor in
                ScreenCapture.invalidateShareableContent()
                ScreenCapture.prefetchShareableContent()
            }
        })
    }

    deinit { observers.forEach(NotificationCenter.default.removeObserver) }

    /// The channel the NEXT capture will use, resolved from the current settings. Custom-key mode
    /// reads the key of the active third-party provider.
    private func currentChannel() -> ServiceChannel {
        ServiceRouting.resolve(
            mode: Settings.shared.serviceMode,
            customKey: Settings.shared.apiKey(for: Settings.shared.activeProvider.storageKey),
            cliAllowed: OfficialAPI.cliEnabled
        )
    }

    /// Reflect the active channel (官方服务 / 自定义 Key / CLI) in the notch header.
    private func refreshCLILabel() {
        model.cliLabel = ServiceRouting.headerLabel(
            channel: currentChannel(),
            cliBackend: Settings.shared.cli,
            customProviderName: Settings.shared.activeProvider.name)
    }

    private func refreshAfterLanguageChange() {
        refreshCLILabel()
        refreshModeLabels()
        model.depthLabel = L10n.depthLabel(Settings.shared.depth)
        if !running { model.statusText = L10n.statusReady }
    }

    private func refreshAppearance() {
        model.depthLabel = L10n.depthLabel(Settings.shared.depth) // depth may change from settings too
        panel.contentView?.needsDisplay = true
        panel.contentView?.subviews.forEach { $0.needsDisplay = true }
        // Poke the model so NotchView re-reads fonts/colors for the answer text.
        model.objectWillChange.send()
        // A font-size change alters the measured answer height — reflow the expanded panel so
        // the card resizes live under the slider instead of waiting for the next stream/hover.
        resizeToFit()
    }

    // MARK: - Onboarding (first launch only)

    /// Present the first-launch onboarding. `bootstrapFirstRunState()` (run at the very top of
    /// launch, before PersonaStore's migration can write keys) already marked existing installs
    /// as done — so reaching here with `onboardingDone == false` means a genuinely fresh install.
    func showOnboardingIfNeeded() {
        Settings.shared.bootstrapFirstRunState() // defensive; no-op after AppDelegate ran it
        var forceForQA = false
        #if DEBUG
        // Visual-QA hook: `--qa-onboarding` shows the flow regardless of onboardingDone (pair
        // with NSPI_QA_EPHEMERAL=1 so no real account state is touched).
        forceForQA = ProcessInfo.processInfo.arguments.contains("--qa-onboarding")
        #endif
        guard !Settings.shared.onboardingDone || forceForQA else { return }
        let vc = OnboardingViewController()
        vc.onFinished = { [weak self] in
            self?.refreshCLILabel()
            self?.onboardingWindow = nil // one-shot window; don't keep it retained for the app's lifetime
        }
        let w = OnboardingWindow(contentViewController: vc)
        w.center()
        onboardingWindow = w
        w.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// Push the active mode + persona name into the model so the notch header reflects them.
    /// Reads the active persona from `PersonaStore` (which also keeps `Settings` mirrored for the
    /// capture pipeline). Touching the store here on launch performs the one-time legacy migration.
    private func refreshModeLabels() {
        let m = Settings.shared.mode
        model.mode = m
        model.modeLabel = L10n.modeLabel(m)
        model.personaLabel = PersonaStore.shared.active?.name.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    func show() { panel.orderFrontRegardless() }

    #if DEBUG
    /// Visual-QA hook: drive one full capture programmatically (same path as the hotkey),
    /// so the whole pipeline — screenshot → official channel → stream → quota status line —
    /// can be exercised and screenshotted without pressing keys.
    func qaTriggerCapture() { runTapped(mode: "tutor") }

    /// Visual-QA hook: toggle an auto session through the production start/stop path.
    func qaStartAutoMode() { autoModeTapped() }

    /// Visual-QA hook: drive the notch into a specific presentation state with FIXTURE content
    /// (no capture, no server), so the light field / streaming text / morph can be screenshotted
    /// deterministically. States: idle · running · streaming · presenting · error.
    private var qaStreamWork: DispatchWorkItem?
    func qaDriveNotch(_ state: String) {
        qaStreamWork?.cancel()
        // Optional: force an accent theme so the light field's tint can be verified across themes.
        if let theme = ProcessInfo.processInfo.environment["NSPI_QA_THEME"] { Appearance.setTheme(theme) }
        pinned = true
        if !visible { visible = true; panel.orderFrontRegardless() }
        model.mode = "tutor"
        model.answerDepth = "guided"
        model.reasoningRevealed = false
        let fixture = """
        **思路**　这道题考查二次函数的最小值。先把 `f(x) = x² − 4x + 3` 配方成顶点式，最值一眼可见。

        **配方**　`f(x) = (x − 2)² − 1`，所以抛物线的顶点在 `(2, −1)`。

        **结论**　开口向上，当 `x = 2` 时取得最小值 **−1**；没有最大值。
        """
        // The FINAL-contract fixture mirrors the real-world bug report: a wrong early
        // conclusion, a corrected one — the card must show ONLY the last (ADBCE).
        let finalFixture = """
        C=0：エ→D=−20、オ→E=B+30、ウ→D−E=±40 → E=20、B=−10
        ア→A=B±20 → A=10 or −30、イ→C−A=±30 → A=−30
        FINAL: BDECA
        検算：A=−30 < D=−20 < B=−10 < C=0 < E=20 ✓ 最小は A
        FINAL: **ADBCE**（A=−30 が最小）
        """
        let personalityFixture = """
        1. やや当てはまる
        2. Bに近い
        NSPI_CONTEXT_V1: {"last":{"ordinal":"2","summary":"二つの行動傾向から近い方を選ぶ項目","choice":"Bに近い"},"referenceable":[{"ordinal":"1","summary":"新しい役割を自分から引き受ける傾向","choice":"やや当てはまる"}]}
        """
        switch state {
        case "ready":  // hover-expanded idle: the keycap placeholder line, no answer yet
            model.answer = ""; model.status = .ready; model.statusText = L10n.statusReady
            setExpanded(true); resizeToFit()
        case "running":
            model.answer = ""; model.status = .running; model.statusText = L10n.statusPreparing
            setExpanded(true)
        case "presenting":
            model.answer = fixture; model.status = .idle
            model.statusText = L10n.statusDone + " · " + L10n.questionsLeft(179)
            setExpanded(true); resizeToFit()
        case "long":  // exceeds maxExpandedHeight → must scroll, pinned to the tail
            model.answer = Array(repeating: fixture, count: 4).joined(separator: "\n\n")
            model.status = .idle; model.statusText = L10n.statusDone + " · " + L10n.questionsLeft(178)
            setExpanded(true); resizeToFit()
        case "error":
            model.answer = L10n.t("截屏失败，目标窗口可能刚被关闭，请重试。",
                                  "キャプチャに失敗しました。再試行してください。",
                                  "Capture failed — the target window may have just closed. Please try again.")
            model.status = .error; model.statusText = L10n.statusError
            setExpanded(true); resizeToFit()
        case "final":  // brief answer, folded scratch + answer card (the post-fix hero state)
            model.answerDepth = "brief"
            model.answer = finalFixture; model.status = .idle
            model.statusText = L10n.statusDone + " · " + L10n.questionsLeft(179)
            if autoCopyAnswerIfEnabled() { model.statusText += " · " + L10n.statusCopied }
            setExpanded(true); resizeToFit()
            fputs("[NotchSPI] QA: notch windowNumber \(panel.windowNumber)\n", stderr)
        case "final-open":  // scratch work unfolded via the ▸ toggle
            model.answerDepth = "brief"; model.reasoningRevealed = true
            model.answer = finalFixture; model.status = .idle
            model.statusText = L10n.statusDone + " · " + L10n.questionsLeft(179)
            setExpanded(true); resizeToFit()
        case "final-click":  // real-event toggle test: fold → unfold (2s) → fold again (4s)
            model.answerDepth = "brief"
            model.answer = finalFixture; model.status = .idle
            model.statusText = L10n.statusDone + " · " + L10n.questionsLeft(179)
            setExpanded(true); resizeToFit()
            for delay in [2.0, 4.0] {
                let w = DispatchWorkItem { [weak self] in self?.notchView.qaClickReasoningToggle() }
                qaStreamWork = w
                DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: w)
            }
        case "final-guided":  // guided depth keeps the walkthrough and ends in the card
            model.answer = fixture + "\nFINAL: **−1**（`x = 2` 时取得）"
            model.status = .idle
            model.statusText = L10n.statusDone + " · " + L10n.questionsLeft(179)
            setExpanded(true); resizeToFit()
        case "personality", "personality-menu":
            // Repeatable end-to-end QA for the session reset affordance. This seeds one real,
            // parser-validated in-memory record, renders the untouched raw protocol stream, and
            // optionally opens the same gear menu used in production. `--visual-qa` only changes
            // window sharing in DEBUG; menu construction, action dispatch, and reset semantics
            // stay on the production path.
            Settings.shared.mode = "personality"
            Settings.shared.personaName = "QA Persona"
            Settings.shared.personaText = "慎重だが一貫し、必要な場面では明確に判断する。"
            model.mode = "personality"
            model.modeLabel = L10n.modePersonality
            model.personaLabel = "QA Persona"
            model.answer = personalityFixture
            model.status = .idle
            model.statusText = L10n.statusDone + " · " + L10n.questionsLeft(179)

            let scope = makeRunSnapshot(mode: "personality").personalityScope
            personalitySession.reset(reason: .manual)
            let token = personalitySession.begin(scope: scope)
            if let context = PersonalityAnswer.compose(
                raw: personalityFixture, streaming: false
            ).context {
                _ = personalitySession.record(context, token: token)
            }
            observedPersonalityScope = scope
            setExpanded(true); resizeToFit()
            if state == "personality-menu" {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) { [weak self] in
                    self?.showSettings()
                }
            }
        case "cycle":  // expand ⇄ collapse forever — for filming both morph directions
            model.answer = fixture; model.status = .idle
            model.statusText = L10n.statusDone + " · " + L10n.questionsLeft(179)
            setExpanded(true); resizeToFit()
            var next = false
            func flip() {
                let w = DispatchWorkItem { [weak self] in
                    guard let self else { return }
                    self.setExpanded(next)
                    next.toggle()
                    flip()
                }
                qaStreamWork = w
                // Rest long enough for the morph to settle even under NSPI_SLOW_MORPH.
                DispatchQueue.main.asyncAfter(deadline: .now() + NotchPalette.morphDuration + 1.4, execute: w)
            }
            flip()
        default: // "streaming" — run the real birth animation by appending in chunks
                 // ("streaming-long" streams 4× the fixture, far past maxExpandedHeight, so the
                 //  height spring hits its clamp and the follow-bottom scroll takes over;
                 //  "streaming-final" streams the FINAL-contract fixture as a brief run: dim
                 //  scratch → chip birth → the fold-away condensation on completion)
            let isFinal = state == "streaming-final"
            if isFinal { model.answerDepth = "brief" }
            model.answer = ""; model.status = .running; model.statusText = L10n.statusPreparing
            setExpanded(true)
            let text = isFinal ? finalFixture
                : state == "streaming-long"
                    ? Array(repeating: fixture, count: 4).joined(separator: "\n\n") : fixture
            let chars = Array(text)
            var i = 0
            func pump() {
                guard i < chars.count else {
                    model.status = .idle
                    model.statusText = L10n.statusDone + " · " + L10n.questionsLeft(179)
                    resizeToFit(); return
                }
                let step = min(chars.count - i, Int.random(in: 2...4))
                model.answer += String(chars[i..<i+step]); i += step
                model.status = .streaming
                model.statusText = isFinal
                    ? (AnswerComposer.hasMarker(model.answer) ? L10n.statusAnswering : L10n.statusReasoning)
                    : L10n.statusExplaining
                resizeToFit()
                let w = DispatchWorkItem { pump() }
                qaStreamWork = w
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.045, execute: w)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: DispatchWorkItem { pump() })
        }
    }
    #endif

    private func registerHotkeys() {
        HotKeyCenter.shared.unregisterAll()
        let cap = Settings.shared.captureCombo
        let ctx = Settings.shared.contextCombo
        let persona = Settings.shared.personalityCombo
        let tog = Settings.shared.toggleCombo
        let auto = Settings.shared.autoModeCombo
        // During an auto session the capture hotkey becomes "stop": the user's reflex key
        // must never fire an extra quota-costing capture on top of the automation.
        HotKeyCenter.shared.register(role: .capture, keyCode: cap.keyCode, modifiers: cap.modifiers) { [weak self] in
            guard let self else { return }
            if self.autoEngine.isActive { self.stopAutoSession(.captureHotkey) }
            else { self.runTapped(mode: "tutor") }
        }
        // Personality registers BEFORE context: a user who explicitly recorded personality on
        // ⌘⇧2 (its pre-remap default, now context's default) keeps their working combo, and the
        // context row shows the in-process conflict in red until they pick another.
        HotKeyCenter.shared.register(role: .personality, keyCode: persona.keyCode, modifiers: persona.modifiers) { [weak self] in
            guard let self else { return }
            if self.autoEngine.isActive { self.stopAutoSession(.captureHotkey) }
            self.runTapped(mode: "personality")
        }
        HotKeyCenter.shared.register(role: .context, keyCode: ctx.keyCode, modifiers: ctx.modifiers) { [weak self] in
            guard let self else { return }
            if self.autoEngine.isActive { self.stopAutoSession(.captureHotkey) }
            self.runTapped(mode: "tutor", withContext: true)
        }
        HotKeyCenter.shared.register(role: .toggle, keyCode: tog.keyCode, modifiers: tog.modifiers) { [weak self] in
            self?.toggleVisibility()
        }
        HotKeyCenter.shared.register(role: .autoMode, keyCode: auto.keyCode, modifiers: auto.modifiers) { [weak self] in
            self?.autoModeTapped()
        }
    }

    private func toggleVisibility() {
        visible.toggle()
        if visible { panel.orderFrontRegardless() } else { panel.orderOut(nil) }
    }

    private func cycleDepth() {
        let cur = Settings.shared.depth
        let idx = Settings.depthCycle.firstIndex(of: cur) ?? 1
        let next = Settings.depthCycle[(idx + 1) % Settings.depthCycle.count]
        Settings.shared.depth = next
        model.depthLabel = L10n.depthLabel(next)
    }

    // MARK: - Gear menu (quick actions only — everything else lives in 设置)

    private func showSettings() {
        buildQuickMenu().popUp(positioning: nil, at: NSEvent.mouseLocation, in: nil)
    }

    private func buildQuickMenu() -> NSMenu {
        let menu = NSMenu()

        // Quota at a glance + one-tap top-up (official channel only).
        if Settings.shared.serviceMode == ServiceMode.official {
            let balanceTitle = OfficialAPI.balanceQuestions.map { L10n.questionsLeft($0) } ?? L10n.quotaUnknown
            let balance = NSMenuItem(title: balanceTitle, action: #selector(openAccount), keyEquivalent: "")
            balance.target = self
            if let img = NSImage(systemSymbolName: "circle.dotted.circle", accessibilityDescription: nil) {
                balance.image = img
            }
            menu.addItem(balance)
            let topUp = NSMenuItem(title: L10n.topUp, action: #selector(topUpTapped), keyEquivalent: "")
            topUp.target = self
            menu.addItem(topUp)
            menu.addItem(.separator())
        }

        // Depth only applies to tutor mode; hide it in personality mode.
        if Settings.shared.mode != "personality" {
            let depthHeader = NSMenuItem(title: L10n.t("讲解深度", "解説の詳しさ", "Explanation Depth"),
                                         action: nil, keyEquivalent: "")
            depthHeader.isEnabled = false
            menu.addItem(depthHeader)
            for id in Settings.depthCycle {
                let item = NSMenuItem(title: L10n.depthLabel(id), action: #selector(pickDepth(_:)), keyEquivalent: "")
                item.target = self
                item.representedObject = id
                item.state = (Settings.shared.depth == id) ? .on : .off
                menu.addItem(item)
            }
            menu.addItem(.separator())
        }

        if Settings.shared.mode == "personality" {
            let fresh = NSMenuItem(
                title: L10n.startNewQuestionnaire,
                action: #selector(startNewQuestionnaire),
                keyEquivalent: ""
            )
            fresh.target = self
            menu.addItem(fresh)
            menu.addItem(.separator())
        }

        let savedID = Settings.shared.captureTargetBundleID
        let savedName = Settings.shared.captureTargetName ?? savedID ?? ""
        let targetItem = NSMenuItem(
            title: L10n.t("截图目标：", "キャプチャ対象：", "Capture target: ")
                + (savedID == nil ? L10n.t("整个屏幕", "画面全体", "Entire screen") : savedName),
            action: nil, keyEquivalent: ""
        )
        // Submenu fills lazily in menuNeedsUpdate when it opens, keeping window
        // enumeration off the popUp path entirely.
        let targetMenu = NSMenu()
        targetMenu.delegate = self
        targetItem.submenu = targetMenu
        menu.addItem(targetItem)

        // Persona quick-switch (only when personas exist).
        let personas = PersonaStore.shared.all
        if !personas.isEmpty {
            let switchItem = NSMenuItem(title: L10n.t("切换人物像", "人物像を切替", "Switch Persona"),
                                        action: nil, keyEquivalent: "")
            let sub = NSMenu()
            for p in personas {
                let it = NSMenuItem(
                    title: p.name.isEmpty ? L10n.t("未命名人物像", "無題の人物像", "Untitled persona") : p.name,
                    action: #selector(pickPersona(_:)), keyEquivalent: "")
                it.target = self
                it.representedObject = p.id
                it.state = (PersonaStore.shared.activeID == p.id) ? .on : .off
                sub.addItem(it)
            }
            switchItem.submenu = sub
            menu.addItem(switchItem)
        }

        menu.addItem(.separator())

        let settings = NSMenuItem(title: L10n.openSettings, action: #selector(openSettingsGeneral), keyEquivalent: ",")
        settings.target = self
        menu.addItem(settings)

        let quit = NSMenuItem(title: L10n.quitApp, action: #selector(quitApp), keyEquivalent: "")
        quit.target = self
        menu.addItem(quit)

        return menu
    }

    @objc private func pickTarget(_ sender: NSMenuItem) {
        if let app = sender.representedObject as? ScreenCapture.AppInfo {
            Settings.shared.captureTargetBundleID = app.bundleID
            Settings.shared.captureTargetName = app.name
        } else {
            Settings.shared.captureTargetBundleID = nil
            Settings.shared.captureTargetName = nil
        }
        invalidatePersonalitySessionIfScopeChanged()
    }

    @objc private func pickDepth(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        Settings.shared.depth = id
        model.depthLabel = L10n.depthLabel(id)
    }

    @objc private func pickPersona(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        PersonaStore.shared.setActive(id)
        refreshModeLabels()
        invalidatePersonalitySessionIfScopeChanged()
    }

    @objc private func startNewQuestionnaire() {
        personalitySession.reset(reason: .manual)
        observedPersonalityScope = currentPersonalityScope()
        model.statusText = L10n.statusContextCleared
    }

    @objc private func openAccount() { openSettings(page: .account) }
    @objc private func openSettingsGeneral() { openSettings(page: .general) }

    @objc private func topUpTapped() {
        guard let url = OfficialAPI.topUpURL(
            baseURL: OfficialAPI.baseURL, deviceToken: OfficialAPI.deviceToken,
            lang: OfficialAPI.topUpLang) else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func quitApp() {
        NSApp.terminate(nil)
    }

    // MARK: - Settings window

    func openSettings(page: MainSettingsWindowController.Page) {
        if settingsController == nil {
            let c = MainSettingsWindowController()
            c.onHotkeysChanged = { [weak self] in self?.registerHotkeys() }
            c.onAnythingChanged = { [weak self] in
                self?.refreshCLILabel()
                self?.refreshModeLabels()
                self?.model.depthLabel = L10n.depthLabel(Settings.shared.depth)
                self?.invalidatePersonalitySessionIfScopeChanged()
            }
            settingsController = c
        }
        settingsController?.open(page: page)
    }

    // MARK: - Geometry (NSScreen coords are bottom-left origin)

    /// Prefer the built-in display that actually HAS the physical notch (non-zero safe-area top), so
    /// the slab is never placed at the top-center of a notchless external monitor. Falls back to the
    /// main screen, then any screen.
    private var screen: NSScreen? {
        NSScreen.screens.first(where: { $0.safeAreaInsets.top > 0 })
            ?? NSScreen.main ?? NSScreen.screens.first
    }

    private var notchWidth: CGFloat {
        guard let s = screen else { return 200 }
        if let l = s.auxiliaryTopLeftArea?.width, let r = s.auxiliaryTopRightArea?.width, l > 0, r > 0 {
            return max(150, s.frame.width - l - r)
        }
        return 200
    }

    /// Height of the slab in the collapsed (fused) state. The physical notch cutout's bottom aligns
    /// with the **menu-bar bottom**, which on a notched display can be a point taller than the
    /// notch-safe inset (measured here: 33pt chrome vs 32pt `safeAreaInsets.top`). Using the safe
    /// inset left the slab's lower edge a hair (2px) above the real cutout — a visible "short bottom".
    /// So take the true top-chrome height; never shorter than the safe inset, and guard the
    /// menu-bar-auto-hide case (where `frame.maxY - visibleFrame.maxY` collapses toward 0).
    private var notchHeight: CGFloat {
        guard let s = screen else { return 28 }
        let safe = s.safeAreaInsets.top
        guard safe > 0 else { return max(28, safe) }         // notchless display → 28 floor
        let menuBar = s.frame.maxY - s.visibleFrame.maxY     // true top chrome (0 if auto-hidden)
        return max(safe, menuBar)
    }

    /// Points-per-pixel of the target display; every panel edge is snapped to this grid so the
    /// software slab fuses with the hardware notch instead of straddling a physical pixel.
    private var backingScale: CGFloat { screen?.backingScaleFactor ?? 2 }

    /// The transparent left extension (collapsed) that puts the Rose in the menu bar beside the cutout.
    private let collapsedSideExtension: CGFloat = 60

    private func frame(expanded: Bool) -> NSRect {
        // No display (truly headless) — nothing sensible to place; a harmless default avoids a crash.
        guard let s = screen?.frame else { return NSRect(x: 0, y: 0, width: expandedWidth, height: 100) }
        let m = NotchGeometry.Metrics(screenFrame: s, scale: backingScale,
                                      notchWidth: notchWidth, notchHeight: notchHeight)
        if expanded {
            // The visible card is `expandedWidth × expandedCardHeight`; the panel is grown by a
            // transparent margin (sides + bottom, never the top) so the obsidian card can cast a
            // soft drop shadow without it being clipped at the panel edge.
            return NotchGeometry.expanded(m, cardWidth: expandedWidth, cardHeight: expandedCardHeight(),
                                          marginH: NotchMetrics.shadowMarginH,
                                          marginBottom: NotchMetrics.shadowMarginBottom)
        }
        // Collapsed: within the menu-bar height; right wall fused with the notch, extended LEFT so
        // the rose shows in the visible menu-bar space beside the (non-display) notch cutout.
        return NotchGeometry.collapsed(m, sideExtension: collapsedSideExtension)
    }

    // Auto-size the expanded panel to its content (clamped), so a short answer
    // doesn't leave a big empty blob and a long one scrolls.
    private let minExpandedHeight: CGFloat = 76
    private let maxExpandedHeight: CGFloat = 460

    private func expandedCardHeight() -> CGFloat {
        // Measure the SAME string the view renders, with the SAME typography (NotchType), so the
        // panel height always matches the drawn answer — no last-line clip, no trailing gap.
        let width = expandedWidth - NotchLayout.contentInsetH * 2
        let answerH = NotchType.answerHeight(model.answer,
                                             presentation: NotchType.presentation(for: model), width: width)
        let total = NotchLayout.headerHeight + answerH + NotchLayout.answerBottomPad
        return min(max(total, minExpandedHeight), maxExpandedHeight)
    }

    private func resizeToFit() {
        guard model.expanded else { return }
        let target = frame(expanded: true)
        if abs(panel.frame.height - target.height) >= 2 {
            // The view's height spring carries the frame — streamed growth glides, never steps.
            notchView.retargetExpandedFrame(target)
        }
    }

    // MARK: - Expand / collapse

    func setExpanded(_ on: Bool) {
        guard model.expanded != on else { return }
        // NotchView observes this and drives the whole morph — panel frame included — on one
        // display-link clock, so frame, radii, light field and content can never drift apart.
        model.expanded = on
    }

    private func hover(_ inside: Bool) {
        hovering = inside
        if inside {
            collapseWork?.cancel()
            setExpanded(true)
        } else if !pinned {
            scheduleCollapse(after: 0.45)
        }
    }

    private func scheduleCollapse(after delay: TimeInterval) {
        collapseWork?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            if !self.pinned && !self.hovering { self.setExpanded(false) }
        }
        collapseWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    /// Post-answer linger from 设置 → 外观. 0 = stay expanded until the mouse leaves.
    private func scheduleCollapseAfterAnswer() {
        guard !hovering else { return }
        let delay = Appearance.collapseDelay
        guard delay > 0 else { return }
        scheduleCollapse(after: delay)
    }

    private func makeRunSnapshot(mode: String) -> RunSnapshot {
        let settings = Settings.shared
        let provider = settings.activeProvider
        return RunSnapshot(
            mode: mode,
            depth: settings.depth,
            personaID: PersonaStore.shared.activeID ?? "unsaved-persona",
            personaName: settings.personaName,
            personaText: settings.personaText,
            captureTarget: settings.captureTarget,
            channel: currentChannel(),
            cliID: settings.cli,
            provider: provider,
            apiEndpoint: settings.endpoint(for: provider),
            apiModel: settings.apiModel(for: provider.storageKey)
        )
    }

    private func currentPersonalityScope() -> PersonalitySessionScope? {
        guard Settings.shared.mode == "personality" else { return nil }
        return makeRunSnapshot(mode: "personality").personalityScope
    }

    private func invalidatePersonalitySessionIfScopeChanged() {
        guard let current = currentPersonalityScope() else {
            if observedPersonalityScope != nil {
                let cleared = personalitySession.hasContinuity
                personalitySession.reset(reason: .tutorMode)
                observedPersonalityScope = nil
                if cleared { model.statusText = L10n.statusContextCleared }
            }
            return
        }
        guard let observed = observedPersonalityScope else {
            observedPersonalityScope = current
            return
        }
        guard observed != current else { return }
        let cleared = personalitySession.hasContinuity
        personalitySession.reset(reason: .scopeChanged)
        observedPersonalityScope = current
        if cleared { model.statusText = L10n.statusContextCleared }
    }

    // MARK: - Auto mode (连续自动截图作答)

    private static let autoPollInterval: TimeInterval = 0.5

    private func autoModeTapped() {
        if autoEngine.isActive {
            stopAutoSession(.userToggled)
            return
        }
        guard !running else { return } // a manual run owns the moment; same spirit as runTapped's gate
        startAutoSession()
    }

    private func startAutoSession() {
        // Fail fast on the one precondition the pipeline only discovers mid-capture: an
        // unattended session must not start blind. Quota preflight is NOT duplicated here —
        // runTapped runs the real QuotaGate moments later and a denial stops the session
        // through the completion hook with the right reason.
        guard CGPreflightScreenCaptureAccess() else {
            if !visible { visible = true; panel.orderFrontRegardless() }
            setExpanded(true)
            finishError(Self.message(for: .noPermission))
            return
        }
        // 截图目标锁定: an explicit app target wins; a full-screen target locks to whatever
        // the user is looking at right now — the app they started the session FOR. Switching
        // away (chat, docs) pauses triggering instead of burning a question on the switch.
        switch Settings.shared.captureTarget {
        case .app(let bundleID):
            autoLockedBundleID = bundleID
        case .fullScreen:
            autoLockedBundleID = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        }
        autoPaused = false
        autoEngine.start(config: .init(maxQuestions: Settings.shared.autoModeMaxQuestions))
        model.autoActive = true
        model.autoProgress = "0/\(autoEngine.config.maxQuestions)"
        #if DEBUG
        print("[NotchSPI] auto: locked to \(autoLockedBundleID ?? "none")")
        #endif
        runTapped(mode: "tutor")
    }

    /// Called from BOTH terminal points of a run (onDone, finishError) — the only places
    /// "one question is finished" exists. No-ops unless an auto session is live.
    private func autoRunCompleted(ok: Bool) {
        guard autoEngine.isActive else { return }
        guard ok else {
            // A failed run never re-arms the watch. Distinguish "out of quota" so the
            // status says why — including the 401 path that wipes the cached balance.
            let quotaDead = OfficialAPI.credentialRejected
                || OfficialAPI.balanceQuestions.map({ $0 <= 0 }) == true
            stopAutoSession(quotaDead ? .quotaExhausted : .runFailed)
            return
        }
        switch autoEngine.noteRunSucceeded(
            balanceQuestions: OfficialAPI.balanceQuestions,
            credentialRejected: OfficialAPI.credentialRejected
        ) {
        case .stop(let reason):
            stopAutoSession(reason)
        default:
            model.autoProgress = "\(autoEngine.questionsAsked)/\(autoEngine.config.maxQuestions)"
            model.statusText += " · " + L10n.statusAutoWatching
            #if DEBUG
            print("[NotchSPI] auto: watching (\(model.autoProgress))")
            #endif
            startAutoPolling()
        }
    }

    private func startAutoPolling() {
        stopAutoPolling()
        autoPollTimer = Timer.scheduledTimer(withTimeInterval: Self.autoPollInterval, repeats: true) {
            [weak self] _ in
            MainActor.assumeIsolated { self?.autoPollTick() }
        }
    }

    private func stopAutoPolling() {
        autoPollTimer?.invalidate()
        autoPollTimer = nil
        autoHashInFlight = false
    }

    private func autoPollTick() {
        guard autoEngine.isActive, !running, !autoHashInFlight else { return }
        // Locked-target gate: while another app is frontmost, don't even sample the screen —
        // the idle timeout still advances so a session parked elsewhere dies after 15 min.
        if let locked = autoLockedBundleID,
           NSWorkspace.shared.frontmostApplication?.bundleIdentifier != locked {
            #if DEBUG
            if !autoPaused { print("[NotchSPI] auto: paused (target not frontmost)") }
            #endif
            autoPaused = true
            if case .stop(let reason) = autoEngine.tickPaused() { stopAutoSession(reason) }
            return
        }
        #if DEBUG
        if autoPaused { print("[NotchSPI] auto: resumed (target frontmost)") }
        #endif
        autoPaused = false
        autoHashInFlight = true // the hash IPC can straddle a 0.5 s tick; never overlap captures
        Task { @MainActor in
            let id = panel.windowNumber > 0 ? CGWindowID(panel.windowNumber) : nil
            let hash = await ScreenCapture.captureHashGrid(excludingWindowID: id)
            autoHashInFlight = false
            switch autoEngine.tick(hash: hash) {
            case .none:
                break
            case .stop(let reason):
                stopAutoSession(reason)
            case .trigger:
                stopAutoPolling()
                #if DEBUG
                print("[NotchSPI] auto: change settled → capture \(autoEngine.questionsAsked + 1)")
                #endif
                if running { stopAutoSession(.runFailed) } // defensive; hotkeys stop the session first
                else { runTapped(mode: "tutor") }
            }
        }
    }

    /// Idempotent. During an in-flight run only the auto chrome is cleared — the pipeline
    /// owns the status line and the answer finishes normally (its completion hook then
    /// no-ops because the engine is already inactive).
    ///
    /// The cleanup latch is `model.autoActive`, NOT the engine's state: engine-initiated
    /// stops (question cap, tick outcomes) arrive here with the engine ALREADY inactive,
    /// and gating on it would skip the timer/chrome/status teardown (2026-08-01 真机 bug).
    private func stopAutoSession(_ reason: AutoStopReason) {
        autoEngine.stop(reason: reason) // no-op if the engine already stopped itself
        guard model.autoActive else { return }
        stopAutoPolling()
        autoLockedBundleID = nil
        autoPaused = false
        #if DEBUG
        print("[NotchSPI] auto: stopped (\(reason))")
        #endif
        model.autoActive = false
        model.autoProgress = ""
        if !running {
            switch reason {
            case .userToggled, .captureHotkey, .stopButton:
                model.statusText = L10n.statusAutoStopped
            case .questionCap(let cap):
                model.statusText = L10n.statusAutoCapReached(cap)
            case .quotaExhausted:
                model.statusText = L10n.statusAutoStoppedQuota
            case .runFailed:
                model.statusText = L10n.statusAutoStoppedError
            case .idleTimeout:
                model.statusText = L10n.statusAutoStoppedIdle
            case .hashFailures:
                model.statusText = L10n.statusAutoStoppedScreen
            }
        }
    }

    // MARK: - Pipeline: capture → channel → stream

    /// `withContext` (tutor mode only): send the remembered ⌘⇧1 shot together with the fresh
    /// capture, so a question whose passage has scrolled away still gets its context.
    private func runTapped(mode: String, withContext: Bool = false) {
        guard !running else { return }
        // The hotkey selects the mode for this capture, so the user never switches modes by hand:
        // ⌘⇧1/⌘⇧2 → tutor, ⌘⇧9 → personality. Set it first so every downstream read agrees.
        if Settings.shared.mode != mode {
            Settings.shared.mode = mode
            refreshModeLabels()
        }
        // 上下文追问 needs a remembered shot; refuse BEFORE capturing so a doomed run costs
        // neither a screenshot flash nor a question. The message names the CURRENT combos —
        // the user may have rebound either row.
        let contextImagePath = withContext ? ScreenshotCacheManager.shared.contextPath : nil
        if withContext, contextImagePath == nil {
            if !visible { visible = true; panel.orderFrontRegardless() }
            setExpanded(true)
            let capKey = Settings.displayString(Settings.shared.captureCombo)
            let ctxKey = Settings.displayString(Settings.shared.contextCombo)
            finishError(L10n.t(
                "还没有可引用的上下文截图。请先用 \(capKey) 截取包含正文的画面，再按 \(ctxKey) 追问。",
                "参照できるコンテキストのスクリーンショットがまだありません。先に \(capKey) で本文を含む画面をキャプチャしてから、\(ctxKey) で質問してください。",
                "No context screenshot to attach yet. Capture the passage with \(capKey) first, then press \(ctxKey) to ask with context."))
            return
        }
        var contextClearedForRun = false
        if mode != "personality" {
            contextClearedForRun = personalitySession.hasContinuity
            personalitySession.reset(reason: .tutorMode)
            observedPersonalityScope = nil
        }
        // Personality mode needs a target persona to answer toward.
        if Settings.shared.mode == "personality",
           Settings.shared.personaText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            if !visible { visible = true; panel.orderFrontRegardless() }
            setExpanded(true)
            finishError(L10n.t(
                "性格测试模式还没有人物像。请在设置 →「人物像」里写下这次要贴合的形象。",
                "性格検査モードにはまだ人物像がありません。設定→「人物像」で目指す人物像を書いてください。",
                "Personality mode needs a target persona. Describe one in Settings → Personas."))
            openSettings(page: .personas)
            return
        }

        // Freeze every request input before the Task's first await. From here on, settings edits
        // may change the NEXT capture only; they cannot create a mixed prompt/channel/target run.
        let snapshot = makeRunSnapshot(mode: mode)
        let sessionToken: PersonalitySessionToken?
        if mode == "personality" {
            let token = personalitySession.begin(scope: snapshot.personalityScope)
            sessionToken = token
            observedPersonalityScope = snapshot.personalityScope
            contextClearedForRun = contextClearedForRun || personalitySession.lastBeginClearedContext
        } else {
            sessionToken = nil
        }
        var prompt = Prompts.capturePrompt(
            mode: snapshot.mode,
            depth: snapshot.depth,
            personaName: snapshot.personaName,
            personaText: snapshot.personaText,
            sessionContext: sessionToken?.contextBlock ?? ""
        )
        // Context runs keep the tutor system prompt (depth contract, FINAL line) and swap only
        // the task line, which explains the two-image order to the model.
        if contextImagePath != nil {
            prompt = CapturePrompt(system: prompt.system, task: Prompts.contextTask)
        }
        let personalityRun = sessionToken.map { PersonalityCaptureRun(token: $0, prompt: prompt) }

        beginRun()
        let generation = runGeneration
        pinned = true
        if !visible { visible = true; panel.orderFrontRegardless() }
        model.answer = ""
        // Freeze this answer's presentation inputs: cycling the depth mid-stream must not
        // restyle an answer that was captured under another contract.
        model.answerDepth = snapshot.depth
        model.reasoningRevealed = Appearance.revealReasoningByDefault
        model.status = .running
        model.statusText = L10n.statusPreparing
        refreshCLILabel()
        setExpanded(true) // expands to a small empty panel; grows as the answer streams

        Task { @MainActor in
            // The screenshot takes a few hundred ms — use that window to warm the network path
            // (DNS + TLS + serverless cold start + DB wake for official; vendor TLS for custom
            // key) so the capture POST rides a hot connection. Fire-and-forget.
            switch snapshot.channel {
            case .official: OfficialAPI.warmUp()
            case .customKey: APIKeyRunner.warmUp(endpoint: snapshot.apiEndpoint)
            case .cli: break
            }

            // Custom provider needs a Base URL + model before it can answer; a preset always has
            // both, so this only bites the "custom" entry left half-filled. Guide the user there
            // rather than firing a doomed request after spending a capture.
            if case .customKey = snapshot.channel,
               snapshot.apiEndpoint.isEmpty || snapshot.apiModel.isEmpty {
                self.finishError(L10n.t(
                    "请先在设置 →「高级」填好该厂商的 Base URL 和模型名。",
                    "設定→「詳細」でこのプロバイダの Base URL とモデル名を入力してください。",
                    "Fill in this provider's Base URL and model name in Settings → Advanced first."))
                self.openSettings(page: .advanced)
                return
            }

            // 额度鉴权拦截：QuotaGate 只可能拦下官方通道 —— 自定义 Key / CLI 直接放行，
            // 不读取任何账户或额度状态（见 QuotaGate.preflight 的第一行守卫）。
            if case .official = snapshot.channel {
                if OfficialAPI.deviceToken == nil {
                    self.model.statusText = L10n.t("正在准备服务…", "サービスを準備中…", "Getting things ready…")
                    _ = await OfficialAPI.registerIfNeeded()
                }
                let verdict = QuotaGate.preflight(
                    channel: snapshot.channel,
                    hasDeviceToken: OfficialAPI.deviceToken != nil,
                    balanceQuestions: OfficialAPI.balanceQuestions
                )
                if case .deny(let reason) = verdict {
                    self.finishError(reason)
                    self.openSettings(page: .account)
                    return
                }
            }

            // CLI mode is the only channel that needs a local binary. Detection results are
            // cached for the session (a fresh probe spawns a login shell and can take seconds);
            // when the cache doesn't yield a runnable CLI — including after an uninstall or
            // logout went stale — re-probe fresh once before surfacing an error.
            var binPath: String?
            if case .cli = snapshot.channel {
                var det = await CLIRunner.detectCached()
                if !(det[snapshot.cliID]?.installed == true && det[snapshot.cliID]?.loggedIn != false) {
                    det = await CLIRunner.detectFresh()
                }
                guard let info = det[snapshot.cliID], info.installed, let path = info.path else {
                    self.finishError(L10n.t(
                        "未找到 \(snapshot.cliID) 命令行。请安装并登录后重试，或在设置 →「高级」切换回官方服务。",
                        "\(snapshot.cliID) CLI が見つかりません。インストール後に再試行するか、設定→「詳細」で公式サービスに切り替えてください。",
                        "The \(snapshot.cliID) CLI wasn't found. Install and sign in, or switch back to the official service in Settings → Advanced."))
                    return
                }
                if info.loggedIn == false {
                    let cmd = snapshot.cliID == "codex" ? "`codex login`" : "`claude`"
                    self.finishError(L10n.t(
                        "\(snapshot.cliID) 未登录。请在终端运行 \(cmd) 后重试，或在设置 →「高级」切换回官方服务。",
                        "\(snapshot.cliID) が未ログインです。ターミナルで \(cmd) を実行後に再試行するか、設定→「詳細」で公式サービスへ。",
                        "\(snapshot.cliID) isn't signed in. Run \(cmd) in a terminal and retry, or switch back to the official service in Settings → Advanced."))
                    return
                }
                binPath = path
            }

            // Full-screen shots must not contain our own panel. Fast path: exclude the panel
            // window from the capture filter, so it never has to be hidden (no blink, no
            // settle delay). A target window can't contain our panel, so it needs neither.
            #if DEBUG
            let captureStart = Date()
            #endif
            let result: Result<ScreenCapture.Shot, CaptureError>
            if snapshot.captureTarget == .fullScreen {
                result = await self.captureFullScreenExcludingPanel()
            } else {
                result = await ScreenCapture.capture(target: snapshot.captureTarget)
            }
            #if DEBUG
            print("[NotchSPI] capture took \(Int(Date().timeIntervalSince(captureStart) * 1000))ms")
            #endif

            let shot: ScreenCapture.Shot
            switch result {
            case .success(let s):
                if s.blank {
                    try? FileManager.default.removeItem(atPath: s.path)
                    self.finishError(L10n.t(
                        "画面为空，通常是缺少屏幕录制权限。请在「系统设置 → 隐私与安全性 → 屏幕录制」勾选 NotchSPI 并重启应用。",
                        "画面が空です。多くの場合、画面収録の許可がありません。「システム設定→プライバシーとセキュリティ→画面収録」で NotchSPI を有効にして再起動してください。",
                        "The capture came back empty — usually missing Screen Recording permission. Enable NotchSPI under System Settings → Privacy & Security → Screen Recording, then relaunch."))
                    return
                }
                shot = s
            case .failure(let error):
                self.finishError(Self.message(for: error))
                return
            }

            // Order is the transport contract everywhere: context shot first, fresh capture last.
            let imagePaths = (contextImagePath.map { [$0] } ?? []) + [shot.path]

            let statusVerb = snapshot.mode == "personality" ? L10n.statusAnswering : L10n.statusExplaining
            // Brief runs narrate their two phases: scratch work streams as 推理中…, and the
            // moment the FINAL marker lands the line flips to 作答中… — the status text tells
            // the same story the de-emphasized text + answer card are telling.
            let briefRun = snapshot.mode != "personality" && snapshot.depth == "brief"
            // Shared by both channels so CLI mode and direct-API mode render identically.
            let onDelta: (String) -> Void = { [weak self] delta in
                // A run the watchdog gave up on may still be streaming; its output must not land
                // in the panel the user is now watching.
                guard let self, self.runGeneration == generation else { return }
                if let personalityRun { personalityRun.append(delta, to: self.model) }
                else { self.model.answer += delta }
                self.model.status = .streaming
                self.model.statusText = briefRun
                    ? (AnswerComposer.hasMarker(self.model.answer) ? L10n.statusAnswering : L10n.statusReasoning)
                    : statusVerb
                self.resizeToFit()
            }
            let onDone: (Bool, String) -> Void = { [weak self] ok, stderr in
                // Same guard as onDelta: a timed-out run must not reset `running` or overwrite the
                // status of the capture the user started after it.
                guard let self, self.runGeneration == generation else { return }
                if !ok, case .cli = snapshot.channel {
                    // The failure may mean the CLI was uninstalled or logged out since the
                    // cached probe — drop the cache so the next press re-checks.
                    Task { @MainActor in CLIRunner.invalidateDetectCache() }
                }
                if snapshot.mode == "personality" {
                    guard let personalityRun else {
                        self.finishError("internal error: personality run missing")
                        return
                    }
                    let currentScope = self.currentPersonalityScope()
                    let outcome = personalityRun.complete(
                        session: self.personalitySession,
                        currentScope: currentScope,
                        transportOK: ok
                    )
                    self.model.status = outcome.isError ? .error : .idle
                    var suffixes = PersonalityCompletionSuffixes(
                        contextWasCleared: contextClearedForRun
                            || currentScope != personalityRun.token.scope
                            || outcome.sessionMutation == .discardedStaleResult
                    )
                    if case .official = snapshot.channel, ok,
                       let balance = OfficialAPI.balanceQuestions {
                        suffixes.questionsRemaining = balance
                        suffixes.quotaRunningLow = balance <= OfficialAPI.lowQuotaThreshold
                    }
                    self.model.statusText = outcome.statusText(suffixes: suffixes)
                } else {
                    if self.model.answer.isEmpty {
                        self.model.answer = ok
                            ? L10n.noOutput
                            : L10n.t("出错了：", "エラー：", "Something went wrong:") + "\n\n```\n\(String(stderr.suffix(600)))\n```"
                        self.model.status = ok ? .idle : .error
                    } else {
                        self.model.status = .idle
                    }
                    self.model.statusText = ok ? L10n.statusDone : L10n.statusError
                    if ok, contextImagePath != nil {
                        self.model.statusText += " · " + L10n.statusContextAttached
                    }
                    if contextClearedForRun {
                        self.model.statusText += " · " + L10n.statusContextCleared
                    }
                    if case .official = snapshot.channel, ok,
                       let balance = OfficialAPI.balanceQuestions {
                        self.model.statusText += " · " + L10n.questionsLeft(balance)
                        if balance <= OfficialAPI.lowQuotaThreshold {
                            self.model.statusText += " · " + L10n.statusQuotaRunningLow
                        }
                    }
                }
                if case .official = snapshot.channel, !ok,
                   let balance = OfficialAPI.balanceQuestions, balance <= 0 {
                    // 截屏中途遇到 402：直接打开账户页引导充值，而不是让用户自己找入口。
                    self.openSettings(page: .account)
                }
                // Auto-copy the answer card's payload the moment it's ready (opt-in). No marker
                // (personality lists, hints, error text) → nothing to copy, so it stays silent.
                if snapshot.mode != "personality", ok, self.autoCopyAnswerIfEnabled() {
                    self.model.statusText += " · " + L10n.statusCopied
                }
                self.resizeToFit()
                self.endRun()
                self.pinned = false
                if snapshot.mode == "tutor", contextImagePath == nil {
                    // A plain tutor shot becomes the next 上下文追问's context instead of being
                    // deleted — even after a transport failure, the image itself is valid context.
                    ScreenshotCacheManager.shared.store(shot.path)
                } else {
                    try? FileManager.default.removeItem(atPath: shot.path)
                }
                self.scheduleCollapseAfterAnswer()
                self.autoRunCompleted(ok: ok)
            }

            switch snapshot.channel {
            case .cli:
                guard let binPath else {
                    onDone(false, "internal error: CLI path missing")
                    return
                }
                CLIRunner.run(
                    cliId: snapshot.cliID, binPath: binPath, imagePaths: imagePaths, prompt: prompt,
                    onDelta: onDelta, onDone: onDone
                )
            case .customKey(let apiKey):
                APIKeyRunner.run(
                    proto: snapshot.provider.proto, endpoint: snapshot.apiEndpoint,
                    apiKey: apiKey, model: snapshot.apiModel,
                    imagePaths: imagePaths, prompt: prompt,
                    onDelta: onDelta, onDone: onDone
                )
            case .official:
                OfficialAPI.run(
                    imagePaths: imagePaths, prompt: prompt,
                    onDelta: onDelta, onDone: onDone
                )
            }
        }
    }

    /// Full-screen capture without hiding the panel: the panel window is excluded from the
    /// capture filter. If the panel can't be identified in the shareable content (no valid
    /// window number, or SCK doesn't list it), fall back to the legacy hide → settle → shoot.
    @MainActor
    private func captureFullScreenExcludingPanel() async -> Result<ScreenCapture.Shot, CaptureError> {
        if panel.windowNumber > 0 {
            let r = await ScreenCapture.capture(target: .fullScreen,
                                                excludingWindowID: CGWindowID(panel.windowNumber))
            if case .failure(.panelNotExcludable) = r {} else { return r }
        }
        #if DEBUG
        print("[NotchSPI] panel exclusion unavailable; falling back to hide+capture")
        #endif
        panel.orderOut(nil)
        try? await Task.sleep(nanoseconds: 130_000_000)
        let r = await ScreenCapture.capture(target: .fullScreen)
        panel.orderFrontRegardless()
        return r
    }

    private static func message(for error: CaptureError) -> String {
        switch error {
        case .noPermission:
            return L10n.t(
                "截屏失败。请在「系统设置 → 隐私与安全性 → 屏幕录制」勾选 NotchSPI，然后重启应用。",
                "キャプチャに失敗しました。「システム設定→プライバシーとセキュリティ→画面収録」で NotchSPI を有効にして再起動してください。",
                "Capture failed. Enable NotchSPI under System Settings → Privacy & Security → Screen Recording, then relaunch.")
        case .appNotRunning(let name):
            return L10n.t(
                "截图目标「\(name)」未在运行。请先打开它，或在设置中切回「整个屏幕」。",
                "キャプチャ対象「\(name)」が起動していません。先に起動するか、設定で「画面全体」に戻してください。",
                "The capture target \"\(name)\" isn't running. Open it first, or switch back to \"Entire screen\" in Settings.")
        case .noCapturableWindow(let name):
            return L10n.t("「\(name)」当前没有可截取的窗口。",
                          "「\(name)」にキャプチャ可能なウィンドウがありません。",
                          "\"\(name)\" has no capturable window right now.")
        case .captureFailed, .panelNotExcludable:
            return L10n.t("截屏失败，目标窗口可能刚被关闭，请重试。",
                          "キャプチャに失敗しました。対象ウィンドウが閉じられた可能性があります。再試行してください。",
                          "Capture failed — the target window may have just closed. Please try again.")
        }
    }

    /// Copy the answer card's payload to the clipboard when 自动复制 is on. Returns whether it
    /// copied, so the caller can annotate the status line. Shared by the live completion path and
    /// the QA fixtures so both behave identically. Silent (no copy) when the reply carries no
    /// answer card (personality lists, hints, error text — `clipboardAnswer` returns nil).
    @discardableResult
    private func autoCopyAnswerIfEnabled() -> Bool {
        guard Appearance.autoCopyAnswer, model.mode != "personality",
              let answer = AnswerComposer.clipboardAnswer(model.answer) else { return false }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(answer, forType: .string)
        return true
    }

    /// Hard deadline for one capture, comfortably past the 120 s request timeout.
    ///
    /// `running` makes the hotkey a deliberate no-op while a capture is in flight, so any await
    /// in the pipeline that never returns — a ScreenCaptureKit enumeration blocked on a busy
    /// WindowServer, a CLI probe, a stream held open by URLSession's week-long resource timeout —
    /// used to disable the app silently and permanently. The user sees nothing at all: no panel,
    /// no error, no log. This timer is what makes that state impossible.
    private static let runDeadline: TimeInterval = 150

    private func beginRun() {
        running = true
        runGeneration &+= 1
        runWatchdog?.invalidate()
        runWatchdog = Timer.scheduledTimer(withTimeInterval: Self.runDeadline, repeats: false) {
            [weak self] _ in
            // Scheduled from the main actor, so it fires on the main run loop; assumeIsolated
            // states that rather than deferring the recovery by a hop.
            MainActor.assumeIsolated {
                guard let self, self.running else { return }
                self.runGeneration &+= 1 // orphan the stuck run's callbacks
                self.finishError(L10n.t(
                    "这次讲题超时了，没有消耗额度。请再按一次快捷键重试。",
                    "今回はタイムアウトしました(質問数は消費されていません)。もう一度ショートカットを押してください。",
                    "That attempt timed out and wasn't charged. Press the hotkey again to retry."))
            }
        }
    }

    private func endRun() {
        runWatchdog?.invalidate()
        runWatchdog = nil
        running = false
    }

    private func finishError(_ msg: String) {
        // Personality answer storage is reserved for the untouched model protocol stream. Local
        // capture/preflight errors belong in status, never in the choice body or future context.
        if model.mode == "personality" { model.answer = "" }
        else { model.answer = msg }
        model.status = .error
        model.statusText = model.mode == "personality" ? msg : L10n.statusError
        resizeToFit()
        endRun()
        pinned = false
        if !hovering {
            let delay = Appearance.collapseDelay
            scheduleCollapse(after: delay > 0 ? max(delay, 14) : 14) // errors always linger long enough to read
        }
        autoRunCompleted(ok: false)
    }
}

// MARK: - Capture-target submenu (lazily populated as it opens)

extension NotchController: NSMenuDelegate {
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let savedID = Settings.shared.captureTargetBundleID

        let full = NSMenuItem(title: L10n.t("整个屏幕", "画面全体", "Entire screen"),
                              action: #selector(pickTarget(_:)), keyEquivalent: "")
        full.target = self
        full.state = savedID == nil ? .on : .off
        menu.addItem(full)
        menu.addItem(.separator())

        let apps = ScreenCapture.capturableApps()
        for app in apps {
            let item = NSMenuItem(title: app.name, action: #selector(pickTarget(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = app
            item.state = (app.bundleID == savedID) ? .on : .off
            if let icon = app.icon?.copy() as? NSImage {
                icon.size = NSSize(width: 16, height: 16)
                item.image = icon
            }
            menu.addItem(item)
        }
        if let savedID, !apps.contains(where: { $0.bundleID == savedID }) {
            let gone = NSMenuItem(
                title: (Settings.shared.captureTargetName ?? savedID) + L10n.t("（未运行）", "（未起動）", " (not running)"),
                action: nil, keyEquivalent: ""
            )
            gone.isEnabled = false
            gone.state = .on
            menu.addItem(gone)
        }
    }
}
