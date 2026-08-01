import Foundation
import CoreGraphics

/// Why an auto session ended — drives the status message the user sees.
enum AutoStopReason: Equatable {
    case userToggled       // auto-mode hotkey pressed again
    case captureHotkey     // capture hotkey pressed during an active session
    case stopButton        // capsule tap on the notch panel
    case questionCap(Int)  // hit the per-session question cap
    case runFailed         // an answer run ended in error (incl. mid-run 401/402, watchdog)
    case quotaExhausted    // balance ≤ 0 or credential rejected after a success
    case idleTimeout       // watched with no trigger for too long
    case hashFailures      // consecutive hash captures failed (screen locked/asleep)
}

/// Downsampled grayscale change detection. Pure byte math — no AppKit, fully unit-tested.
enum ScreenHasher {
    static let gridW = 32
    static let gridH = 20
    /// Per-cell luma delta below this is noise (JPEG-ish shimmer, AA, cursor blink residue).
    static let perPixelTolerance: UInt8 = 10
    /// Fraction of grid cells that must move beyond tolerance for the screen to count as changed.
    static let changedFraction: Double = 0.02

    /// Fraction (0…1) of cells whose |a−b| exceeds the tolerance.
    /// Mismatched or empty inputs count as fully changed (defensive).
    static func difference(_ a: [UInt8], _ b: [UInt8], tolerance: UInt8 = perPixelTolerance) -> Double {
        guard !a.isEmpty, a.count == b.count else { return 1 }
        var moved = 0
        for i in a.indices {
            let d = a[i] > b[i] ? a[i] - b[i] : b[i] - a[i]
            if d > tolerance { moved += 1 }
        }
        return Double(moved) / Double(a.count)
    }

    static func changed(_ a: [UInt8], _ b: [UInt8], threshold: Double = changedFraction) -> Bool {
        difference(a, b) >= threshold
    }

    /// CGImage (any size) → gridW×gridH luma bytes via a DeviceGray context draw.
    static func lumaGrid(from image: CGImage) -> [UInt8]? {
        var buffer = [UInt8](repeating: 0, count: gridW * gridH)
        let drawn: Bool = buffer.withUnsafeMutableBytes { raw in
            guard let ctx = CGContext(
                data: raw.baseAddress, width: gridW, height: gridH,
                bitsPerComponent: 8, bytesPerRow: gridW,
                space: CGColorSpaceCreateDeviceGray(),
                bitmapInfo: CGImageAlphaInfo.none.rawValue
            ) else { return false }
            ctx.interpolationQuality = .medium
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: gridW, height: gridH))
            return true
        }
        return drawn ? buffer : nil
    }
}

/// The auto-session brain. Owns no timers and does no capture — NotchController feeds it
/// explicit events (run finished, poll tick) and acts on the returned outcome, so every
/// transition is deterministic under test. Modeled on PersonalitySession (injected clock).
@MainActor
final class AutoSessionEngine {
    struct Config: Equatable {
        var maxQuestions: Int
        var stableTicksRequired = 2       // 0.5 s polls → changed-then-2-stable ≈ 1 s settle
        var maxHashFailures = 3
        var idleTimeout: TimeInterval = 15 * 60
    }

    enum State: Equatable {
        case inactive
        case running          // the capture pipeline owns the moment (trigger → onDone/finishError)
        case baselinePending  // answer done; the next successful hash becomes the baseline
        case watching
    }

    enum TickOutcome: Equatable {
        case none
        case trigger          // fire the next capture; engine is now .running
        case stop(AutoStopReason)
    }

    private let now: () -> Date

    private(set) var state: State = .inactive
    private(set) var questionsAsked = 0
    private(set) var config = Config(maxQuestions: 20)
    private(set) var lastStopReason: AutoStopReason?

    private var baseline: [UInt8]?
    private var lastHash: [UInt8]?
    private var changedSeen = false
    private var stableCount = 0
    private var hashFailureStreak = 0
    private var watchStart: Date?

    var isActive: Bool { state != .inactive }

    init(now: @escaping () -> Date = Date.init) {
        self.now = now
    }

    /// 0 (UserDefaults "unset") → default 20; anything else clamped to 1…50.
    nonisolated static func clampMaxQuestions(_ n: Int) -> Int {
        guard n != 0 else { return 20 }
        return min(max(n, 1), 50)
    }

    func start(config: Config) {
        self.config = config
        questionsAsked = 0
        lastStopReason = nil
        resetWatchState()
        state = .running
    }

    /// From onDone(ok: true). Counts the question, then decides watch vs stop.
    /// The quota check here also covers the 401 trap: a rejected credential wipes the
    /// cached balance to nil, which the preflight gate would wave through forever.
    func noteRunSucceeded(balanceQuestions: Int?, credentialRejected: Bool) -> TickOutcome {
        guard state != .inactive else { return .none }
        questionsAsked += 1
        if questionsAsked >= config.maxQuestions {
            return stopped(.questionCap(config.maxQuestions))
        }
        if credentialRejected || balanceQuestions.map({ $0 <= 0 }) == true {
            return stopped(.quotaExhausted)
        }
        resetWatchState()
        watchStart = now()
        state = .baselinePending
        return .none
    }

    /// From onDone(ok: false) and finishError. Never re-triggers after a failed run.
    func noteRunFailed() -> TickOutcome {
        guard state != .inactive else { return .none }
        return stopped(.runFailed)
    }

    /// A poll tick while triggering is paused (the locked target app isn't frontmost).
    /// Only the idle timeout advances; watch state (baseline, stability, failure streak)
    /// is frozen so returning to an unchanged page settles back onto the baseline
    /// instead of firing on the app switch itself.
    func tickPaused() -> TickOutcome {
        switch state {
        case .inactive, .running:
            return .none
        case .baselinePending, .watching:
            break
        }
        if let start = watchStart, now().timeIntervalSince(start) >= config.idleTimeout {
            return stopped(.idleTimeout)
        }
        return .none
    }

    /// One poll tick; nil hash means the capture failed.
    func tick(hash: [UInt8]?) -> TickOutcome {
        switch state {
        case .inactive, .running:
            return .none   // stray timer tick after a stop or trigger is harmless
        case .baselinePending, .watching:
            break
        }
        if let start = watchStart, now().timeIntervalSince(start) >= config.idleTimeout {
            return stopped(.idleTimeout)
        }
        guard let hash else {
            hashFailureStreak += 1
            if hashFailureStreak >= config.maxHashFailures {
                return stopped(.hashFailures)
            }
            return .none
        }
        hashFailureStreak = 0

        if state == .baselinePending {
            baseline = hash
            lastHash = hash
            changedSeen = false
            stableCount = 0
            state = .watching
            return .none
        }

        guard let baseline, let previous = lastHash else {
            self.baseline = hash   // defensive; both are set when .watching is entered
            lastHash = hash
            return .none
        }
        defer { lastHash = hash }

        if !changedSeen {
            if ScreenHasher.changed(hash, baseline) {
                changedSeen = true
                stableCount = 0
            }
            return .none
        }

        // Changed already — stability is measured against the previous tick, not the
        // baseline, so continuous scrolling keeps resetting instead of triggering.
        if ScreenHasher.changed(hash, previous) {
            stableCount = 0
            return .none
        }
        stableCount += 1
        guard stableCount >= config.stableTicksRequired else { return .none }

        // Settled — but if the screen settled back onto the baseline (notification
        // banner, volume HUD), rearm instead of burning a question on the same screen.
        if !ScreenHasher.changed(hash, baseline) {
            changedSeen = false
            stableCount = 0
            return .none
        }
        state = .running
        return .trigger
    }

    /// Idempotent; the first reason wins so a late hook can't overwrite what the user did.
    func stop(reason: AutoStopReason) {
        guard state != .inactive else { return }
        state = .inactive
        lastStopReason = reason
        resetWatchState()
    }

    private func stopped(_ reason: AutoStopReason) -> TickOutcome {
        stop(reason: reason)
        return .stop(reason)
    }

    private func resetWatchState() {
        baseline = nil
        lastHash = nil
        changedSeen = false
        stableCount = 0
        hashFailureStreak = 0
        watchStart = nil
    }
}
