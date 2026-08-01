import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var controller: NotchController?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // MUST run before NotchController init: PersonaStore's migration writes persona keys
        // during controller construction, which would misclassify a fresh install as existing
        // (skipping onboarding and mis-defaulting the service mode to CLI).
        Settings.shared.bootstrapFirstRunState()

        // Even though this is an accessory app with no persistent menu bar, AppKit dispatches the
        // standard editing shortcuts (⌘X/⌘C/⌘V/⌘A/⌘Z) through the main menu's key equivalents. Without
        // a main menu, the text fields in the settings / 人物像 windows can't cut, copy, or paste.
        NSApp.mainMenu = Self.makeMainMenu()

        let controller = NotchController()
        controller.show()
        self.controller = controller

        // First-launch onboarding: fresh installs get the five-page flow; existing installs
        // are skipped silently inside.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
            controller.showOnboardingIfNeeded()
        }

        #if DEBUG
        // Visual-QA hooks: `--qa-settings-page N` opens the settings window at page N;
        // `--qa-capture` fires one full capture as if the hotkey were pressed.
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "--qa-settings-page"), i + 1 < args.count,
           let n = Int(args[i + 1]),
           let page = MainSettingsWindowController.Page(rawValue: n) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                controller.openSettings(page: page)
            }
        }
        let qaNotchState: String? = {
            if let i = args.firstIndex(of: "--qa-notch"), i + 1 < args.count {
                return args[i + 1]
            }
            return ProcessInfo.processInfo.environment["NSPI_QA_NOTCH"]
        }()
        if let state = qaNotchState, !state.isEmpty {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                controller.qaDriveNotch(state)
            }
        }
        if let i = args.firstIndex(of: "--qa-capture") {
            // Optional count after the flag (`--qa-capture 4`) fires that many captures 6s
            // apart — enough to drain a small trial quota and hit the deny path in one session.
            var count = 1
            if i + 1 < args.count, let n = Int(args[i + 1]) { count = n }
            for n in 0..<max(1, count) {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2 + Double(n) * 6.0) {
                    controller.qaTriggerCapture()
                }
            }
        }
        if args.contains("--qa-auto-mode") {
            // Starts an auto session through the production toggle path (hotkey-equivalent).
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                controller.qaStartAutoMode()
            }
        }
        #endif

        // Quietly ask the service for a newer release (≤ once/day; only surfaces if one exists).
        // Delayed so the notch UI settles first and the alert never races app launch.
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
            UpdateChecker.autoCheckIfDue()
        }
    }

    private static func makeMainMenu() -> NSMenu {
        let mainMenu = NSMenu()

        // The first submenu is treated as the application menu regardless of title.
        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: L10n.quitApp, action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        // Edit menu — routes clipboard / selection / undo to whichever text field is first responder.
        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: L10n.t("编辑", "編集", "Edit"))
        editMenu.addItem(withTitle: L10n.t("撤销", "取り消す", "Undo"), action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: L10n.t("重做", "やり直す", "Redo"), action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: L10n.t("剪切", "カット", "Cut"), action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: L10n.t("拷贝", "コピー", "Copy"), action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: L10n.t("粘贴", "ペースト", "Paste"), action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: L10n.t("全选", "すべて選択", "Select All"), action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu

        return mainMenu
    }
}
