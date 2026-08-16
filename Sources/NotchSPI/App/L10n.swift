import Foundation

/// The app's display language. `auto` follows the system's preferred language, resolved to one
/// of the three supported languages (falling back to English).
enum AppLanguage: String, CaseIterable {
    case auto
    case zhHans = "zh-Hans"
    case ja = "ja"
    case en = "en"

    /// Name of each choice in ITS OWN language (a language picker must be readable to someone
    /// who can't read the currently selected language).
    var pickerLabel: String {
        switch self {
        case .auto: return L10n.t("跟随系统", "システムに合わせる", "Match System")
        case .zhHans: return "简体中文"
        case .ja: return "日本語"
        case .en: return "English"
        }
    }
}

/// Lightweight runtime-switchable localization (zh-Hans / ja / en).
///
/// Strings live in code as `L10n.t("中文", "日本語", "English")` triples — the compiler enforces
/// that every string exists in all three languages, and everything is greppable. Common
/// vocabulary shared across screens lives here; screen-specific strings sit inline at their
/// point of use. No .lproj: the onboarding's first screen offers a language choice that must
/// apply instantly, which bundle-based localization can't do without a relaunch.
enum L10n {
    /// Posted after the language setting changes so open windows re-render their labels.
    static let languageDidChange = Notification.Name("L10n.languageDidChange")

    enum Lang { case zh, ja, en }

    /// The persisted choice (defaults to `auto`).
    static var setting: AppLanguage {
        get { AppLanguage(rawValue: UserDefaults.standard.string(forKey: "appLanguage") ?? "") ?? .auto }
        set {
            UserDefaults.standard.set(newValue.rawValue, forKey: "appLanguage")
            cachedResolved = nil
            NotificationCenter.default.post(name: languageDidChange, object: nil)
        }
    }

    /// Resolved display language. Cached because `t(_:_:_:)` runs on every label of every
    /// redraw; invalidated when the setting changes.
    private static var cachedResolved: Lang?

    static var lang: Lang {
        if let c = cachedResolved { return c }
        let r = resolve(setting: setting, preferred: Locale.preferredLanguages)
        cachedResolved = r
        return r
    }

    /// Pure resolution (unit-testable): manual choice wins; `auto` maps the first system
    /// language we support (zh* → simplified Chinese, ja* → Japanese), defaulting to English.
    static func resolve(setting: AppLanguage, preferred: [String]) -> Lang {
        switch setting {
        case .zhHans: return .zh
        case .ja: return .ja
        case .en: return .en
        case .auto:
            for code in preferred {
                let c = code.lowercased()
                if c.hasPrefix("zh") { return .zh }
                if c.hasPrefix("ja") { return .ja }
                if c.hasPrefix("en") { return .en }
            }
            return .en
        }
    }

    /// The workhorse: pick the current language's variant.
    @inline(__always)
    static func t(_ zh: String, _ ja: String, _ en: String) -> String {
        switch lang {
        case .zh: return zh
        case .ja: return ja
        case .en: return en
        }
    }

    // MARK: - Common vocabulary (shared across screens)

    static var ok: String { t("好", "OK", "OK") }
    static var cancel: String { t("取消", "キャンセル", "Cancel") }
    static var delete: String { t("删除", "削除", "Delete") }
    static var next: String { t("继续", "次へ", "Continue") }
    static var back: String { t("上一步", "戻る", "Back") }
    static var skip: String { t("跳过", "スキップ", "Skip") }
    static var done: String { t("完成", "完了", "Done") }
    static var retry: String { t("重试", "再試行", "Retry") }
    static var refresh: String { t("刷新", "更新", "Refresh") }
    static var settingsTitle: String { t("设置", "設定", "Settings") }
    static var openSettings: String { t("设置…", "設定…", "Settings…") }
    static var quitApp: String { t("退出 NotchSPI", "NotchSPI を終了", "Quit NotchSPI") }
    static var topUp: String { t("充值…", "チャージ…", "Top Up…") }

    // MARK: - Modes & depths

    static var modeTutor: String { t("学习辅导", "学習チューター", "Study Tutor") }
    static var modePersonality: String { t("性格测试", "性格検査", "Personality Test") }

    static var depthBrief: String { t("简略", "簡潔", "Brief") }
    static var depthHint: String { t("提示", "ヒント", "Hints") }
    static var depthGuided: String { t("引导", "ガイド", "Guided") }
    static var depthFull: String { t("完整", "詳細", "Full") }

    static func depthLabel(_ depth: String) -> String {
        switch depth {
        case "brief": return depthBrief
        case "hint": return depthHint
        case "full": return depthFull
        default: return depthGuided
        }
    }

    // MARK: - Service modes

    static var serviceOfficial: String { t("官方服务", "公式サービス", "Official Service") }
    static var serviceCustomKey: String { t("自定义 API Key", "カスタム API キー", "Custom API Key") }
    static var serviceCLI: String { t("本机 CLI", "ローカル CLI", "Local CLI") }

    static func serviceModeLabel(_ mode: String) -> String {
        switch mode {
        case ServiceMode.customKey: return serviceCustomKey
        case ServiceMode.cli: return serviceCLI
        default: return serviceOfficial
        }
    }

    // MARK: - Quota (题数额度)

    /// "180 题" / "180問" / "180 questions" — the unit for balances and grants.
    static func questions(_ n: Int) -> String {
        t("\(n) 题", "\(n)問", n == 1 ? "1 question" : "\(n) questions")
    }

    /// "剩余 179 题" / "残り179問" / "179 questions left"
    static func questionsLeft(_ n: Int) -> String {
        t("剩余 \(n) 题", "残り\(n)問", n == 1 ? "1 question left" : "\(n) questions left")
    }

    static var quotaUnknown: String { t("额度未同步", "残高未同期", "Quota not synced") }

    // MARK: - Notch status line

    static var statusReady: String { t("就绪", "準備完了", "Ready") }
    static var statusPreparing: String { t("正在准备…", "準備中…", "Preparing…") }
    static var statusDone: String { t("完成", "完了", "Done") }
    static var statusError: String { t("出错", "エラー", "Error") }
    static var statusExplaining: String { t("讲解中…", "解説中…", "Explaining…") }
    static var statusAnswering: String { t("作答中…", "回答中…", "Answering…") }
    static var statusReasoning: String { t("推理中…", "思考中…", "Thinking…") }
    static var statusContextCleared: String {
        t("连续题上下文已清空", "連続質問のコンテキストを消去しました", "Questionnaire context cleared")
    }
    static var statusContextAttached: String {
        t("已附上次截图", "前回のキャプチャを添付", "Previous shot attached")
    }
    static var statusContextNotSaved: String {
        t("连续题上下文未保存", "連続質問のコンテキストを保存できませんでした", "Questionnaire context wasn't saved")
    }
    static var statusUnreadable: String {
        t("截图或选项无法辨认", "画像または選択肢を読み取れません", "Screenshot or choices unreadable")
    }
    static var statusPartialUnreadable: String {
        t("部分题目无法辨认", "一部の質問を読み取れません", "Some questions were unreadable")
    }
    static var statusMissingPrevious: String {
        t("上一题上下文不可用", "前の質問のコンテキストがありません", "Previous-question context unavailable")
    }
    static var statusDependsOnMissingPrevious: String {
        t("本页依赖缺失的上一题", "このページには前の質問が必要です", "This page depends on the missing previous question")
    }
    static var statusPartialMissingPrevious: String {
        t("部分题目缺少上一题上下文", "一部の質問に前の質問が必要です", "Some questions need the previous-question context")
    }
    static var statusNoValidChoices: String {
        t("未收到有效选项", "有効な選択肢を受信できませんでした", "No valid choices received")
    }
    static var statusTransportFailure: String {
        t("回答传输中断", "回答の受信が中断されました", "Answer transport interrupted")
    }
    static var statusQuotaRunningLow: String {
        t("额度即将用完", "残りわずか", "Running low")
    }

    static var startNewQuestionnaire: String {
        t("开始新问卷 / 清空连续题上下文",
          "新しい質問票を開始 / 連続コンテキストを消去",
          "Start new questionnaire / clear context")
    }

    // MARK: - Auto mode (连续自动截图作答)

    /// Suffix on the answer's status line while the session watches for the next question.
    static var statusAutoWatching: String {
        t("自动模式：等待画面变化", "自動モード：画面の変化を待機中", "Auto: watching for changes")
    }
    /// Capsule title during an auto session — the capsule IS the stop button.
    static func autoStopCapsule(_ progress: String) -> String {
        t("停止自动 · \(progress)", "自動を停止 · \(progress)", "Stop auto · \(progress)")
    }
    static var statusAutoStopped: String {
        t("自动模式已停止", "自動モードを停止しました", "Auto mode stopped")
    }
    static func statusAutoCapReached(_ cap: Int) -> String {
        t("已连答 \(cap) 题，自动模式结束", "\(cap)問に達したため自動モードを終了",
          "Reached \(cap) questions — auto mode ended")
    }
    static var statusAutoStoppedError: String {
        t("出错，自动模式已停止", "エラーのため自動モードを停止", "Auto mode stopped after an error")
    }
    static var statusAutoStoppedQuota: String {
        t("额度用完，自动模式已停止", "残高がないため自動モードを停止", "Out of questions — auto mode stopped")
    }
    static var statusAutoStoppedIdle: String {
        t("画面长时间无变化，自动模式已停止", "画面に変化がないため自動モードを停止",
          "No changes for a while — auto mode stopped")
    }
    static var statusAutoStoppedScreen: String {
        t("无法读取屏幕，自动模式已停止", "画面を取得できないため自動モードを停止",
          "Can't read the screen — auto mode stopped")
    }

    /// Caption on the answer card (see NotchType.card).
    static var answerCardLabel: String { t("答案", "答え", "ANSWER") }
    static var noOutput: String { t("（没有输出）", "（出力なし）", "(no output)") }
    static var statusCopied: String { t("已复制", "コピー済み", "Copied") }
}
