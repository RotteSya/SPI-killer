import AppKit
import Carbon.HIToolbox

/// What a combo is bound to. Also the identity under which a failed registration is remembered,
/// so the UI can point at the row that is actually dead.
enum HotkeyRole: String {
    case capture, personality, toggle
}

/// Global hotkeys via Carbon RegisterEventHotKey (no Accessibility permission needed).
final class HotKeyCenter {
    static let shared = HotKeyCenter()

    /// Posted when the set of unavailable combos changes, so open UI can repaint.
    static let conflictsDidChange = Notification.Name("HotKeyCenter.conflictsDidChange")

    private var handlers: [UInt32: (role: HotkeyRole, run: () -> Void)] = [:]
    private var nextID: UInt32 = 1
    private var installed = false
    private var refs: [EventHotKeyRef?] = []

    /// Roles whose combo could not be claimed. VERIFIED SCOPE: `RegisterEventHotKey` reports
    /// `eventHotKeyExistsErr` only for a collision INSIDE this process — two of our own actions
    /// bound to the same combo. Two separate processes claiming the same combo both succeed and
    /// neither is told, so this set does NOT detect "another app owns it"; that case is invisible
    /// by design and is handled behaviorally instead (see `hasFired`).
    private(set) var conflicted: Set<HotkeyRole> = []

    /// Roles whose hotkey has actually been delivered at least once this session. The only
    /// trustworthy proof that a combo reaches us: registration success does not imply delivery
    /// when another app holds the same keys.
    private(set) var fired: Set<HotkeyRole> = []

    func hasFired(_ role: HotkeyRole) -> Bool { fired.contains(role) }

    /// keyCode: Carbon virtual key (e.g. kVK_ANSI_1, kVK_Space).
    /// modifiers: Carbon mask (cmdKey, shiftKey, …).
    /// Returns false when the combo could not be claimed (see `conflicted` for what that does
    /// and does not cover).
    @discardableResult
    func register(
        role: HotkeyRole, keyCode: UInt32, modifiers: UInt32, handler: @escaping () -> Void
    ) -> Bool {
        installHandlerIfNeeded()
        let id = nextID
        nextID += 1
        handlers[id] = (role, handler)
        var ref: EventHotKeyRef?
        let hotKeyID = EventHotKeyID(signature: OSType(0x4E544348), id: id) // 'NTCH'
        let status = RegisterEventHotKey(keyCode, modifiers, hotKeyID, GetApplicationEventTarget(), 0, &ref)
        let ok = status == noErr
        if !ok {
            NSLog("[NotchSPI] hotkey registration failed for \(role.rawValue) (status=\(status)); the combo is already claimed")
        }
        refs.append(ref)
        setConflicted(role, ok ? false : true)
        return ok
    }

    func unregisterAll() {
        for ref in refs where ref != nil {
            UnregisterEventHotKey(ref)
        }
        refs.removeAll()
        handlers.removeAll()
        fired.removeAll() // a freshly bound combo is unproven until it is actually delivered
        nextID = 1
        // The old verdicts describe combos we no longer hold; a re-registration republishes them.
        if !conflicted.isEmpty {
            conflicted.removeAll()
            NotificationCenter.default.post(name: Self.conflictsDidChange, object: nil)
        }
    }

    private func setConflicted(_ role: HotkeyRole, _ isConflicted: Bool) {
        let had = conflicted.contains(role)
        guard had != isConflicted else { return }
        if isConflicted { conflicted.insert(role) } else { conflicted.remove(role) }
        NotificationCenter.default.post(name: Self.conflictsDidChange, object: nil)
    }

    private func installHandlerIfNeeded() {
        guard !installed else { return }
        installed = true
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()
        InstallEventHandler(
            GetApplicationEventTarget(),
            { (_, event, userData) -> OSStatus in
                guard let event, let userData else { return noErr }
                var hkID = EventHotKeyID()
                GetEventParameter(
                    event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                    nil, MemoryLayout<EventHotKeyID>.size, nil, &hkID
                )
                let center = Unmanaged<HotKeyCenter>.fromOpaque(userData).takeUnretainedValue()
                if let h = center.handlers[hkID.id] {
                    center.fired.insert(h.role)
                    DispatchQueue.main.async { h.run() }
                }
                return noErr
            },
            1, &spec, selfPtr, nil
        )
    }
}
