import XCTest
@testable import NotchSPI

final class CaptureRequestBindingTests: XCTestCase {
    private let owner = OfficialAPI.CaptureAccount(token: "dev_binding_original_123456", baseURL: "https://original.invalid", generation: 7)

    private func binding(mode: String = "tutor", target: String = "app:reader", selected: String = "official",
                         channel: ServiceChannel = .official, account: OfficialAPI.CaptureAccount? = nil,
                         base: String = "https://original.invalid", endpoint: String = "https://custom.invalid",
                         model: String = "model-a", cli: String = "codex") -> CaptureRequestBinding {
        .init(mode: mode, targetID: target, selectedService: selected, channel: channel,
            officialBaseURL: base, officialAccount: account, providerID: "custom", endpoint: endpoint, model: model, cliID: cli)
    }

    func testOfficialIdentityIncludesCredentialServiceAndGenerationWithoutExposingSecrets() {
        let frozen = binding(account: owner)
        XCTAssertEqual(frozen, binding(account: owner))
        for changed in [binding(), binding(account: .init(token: "dev_replacement_123456", baseURL: owner.baseURL, generation: 7)),
                        binding(account: .init(token: owner.token, baseURL: "https://new.invalid", generation: 7), base: "https://new.invalid"),
                        binding(account: .init(token: owner.token, baseURL: owner.baseURL, generation: 8))] {
            XCTAssertNotEqual(frozen.scopeID, changed.scopeID)
            XCTAssertNotEqual(frozen.channelID, changed.channelID)
        }
        XCTAssertFalse(frozen.scopeID.contains(owner.token))
        XCTAssertFalse(frozen.channelID.contains(owner.baseURL))
        XCTAssertEqual(frozen.scopeID.count, 64)
    }

    func testRegistrationCanOnlyKeepItsExactSelection() {
        let pending = binding(), registered = binding(account: owner)
        XCTAssertEqual(pending.selectionID, registered.selectionID)
        XCTAssertNotEqual(pending.scopeID, registered.scopeID)
        for changed in [binding(mode: "personality"), binding(target: "app:other"), binding(base: "https://new.invalid"),
                        binding(selected: "cli"), binding(selected: "customKey", channel: .customKey("key"))] {
            XCTAssertNotEqual(pending.selectionID, changed.selectionID)
        }
    }

    func testCustomKeyAndCLISelectionChangesCannotReuseMaterials() {
        let custom = binding(selected: "customKey", channel: .customKey("old-key"))
        for changed in [binding(selected: "customKey", channel: .customKey("new-key")),
                        binding(selected: "customKey", channel: .customKey("old-key"), endpoint: "https://other.invalid"),
                        binding(selected: "customKey", channel: .customKey("old-key"), model: "model-b")] {
            XCTAssertNotEqual(custom.scopeID, changed.scopeID)
        }
        XCTAssertEqual(custom, binding(selected: "customKey", channel: .customKey("old-key"), account: owner))
        XCTAssertNil(custom.officialAccount)
        XCTAssertNotEqual(binding(selected: "cli", channel: .cli), binding(selected: "cli", channel: .cli, cli: "claude"))
        XCTAssertNotEqual(binding(selected: "cli", channel: .cli), binding(selected: "cli", channel: .official, account: owner))
        XCTAssertNotEqual(binding(channel: .customKey("key"), endpoint: "a:b", model: "c"),
                          binding(channel: .customKey("key"), endpoint: "a", model: "b:c"))
    }

    @MainActor
    func testSameHostAccountReplacementClearsMaterialSessionEvenWhenContextIsRequested() {
        let session = QuestionSessionStore()
        let original = binding(account: owner)
        session.begin(scope: original.scopeID, newQuestionGroup: false)
        let id = session.sessionID, generation = session.generation
        session.begin(scope: binding(account: owner).scopeID, newQuestionGroup: false)
        XCTAssertEqual(session.sessionID, id)
        let replacement = binding(account: .init(token: "dev_new_material_owner_123456", baseURL: owner.baseURL, generation: 8))
        session.begin(scope: replacement.scopeID, newQuestionGroup: false)
        XCTAssertNotEqual(session.sessionID, id)
        XCTAssertGreaterThan(session.generation, generation)
        XCTAssertTrue(session.references.isEmpty)
        XCTAssertNil(session.currentQuestion)
    }

    @MainActor
    func testSavingMaterialBeforeFirstRegistrationPreservesTheContextJourney() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("registration-material-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let session = QuestionSessionStore(directory: root.appendingPathComponent("private-materials"))
        let pending = binding(), registered = binding(account: owner)
        session.begin(scope: pending.scopeID, newQuestionGroup: false)
        let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGaQAAAAASUVORK5CYII=")!
        let passage = root.appendingPathComponent("passage.png")
        try png.write(to: passage)
        let reference = try await session.adopt(path: passage.path, targetFingerprint: "reader-window", asReference: true)
        let id = session.sessionID
        XCTAssertFalse(session.bindRegisteredAccount(from: pending, to: binding(account: owner, base: "https://different.invalid")))
        XCTAssertTrue(session.bindRegisteredAccount(from: pending, to: registered))
        session.begin(scope: registered.scopeID, newQuestionGroup: false)
        XCTAssertEqual(session.sessionID, id)
        XCTAssertEqual(session.references.map(\.id), [reference.id])
        let question = root.appendingPathComponent("question.png")
        try png.write(to: question)
        _ = try await session.adopt(path: question.path, targetFingerprint: "reader-window", asReference: false)
        let snapshot = try session.snapshot(captureID: UUID(), includeReferences: true)
        XCTAssertEqual(snapshot.assets.count, 2)
        XCTAssertEqual(snapshot.assets.first?.id, reference.id)
        XCTAssertEqual(snapshot.assets.last?.id, session.currentQuestion?.id)
        XCTAssertFalse(session.bindRegisteredAccount(from: registered,
            to: binding(account: .init(token: "dev_another_owner_123456", baseURL: owner.baseURL, generation: 8))))
        XCTAssertEqual(session.sessionID, id)
    }

    @MainActor
    func testExpiredUnregisteredMaterialCannotTransferToARegisteredAccount() {
        var now = Date(timeIntervalSince1970: 1000)
        let session = QuestionSessionStore(now: { now })
        let pending = binding(), registered = binding(account: owner)
        session.begin(scope: pending.scopeID, newQuestionGroup: false)
        let id = session.sessionID
        now.addTimeInterval(QuestionSessionStore.lifetime)
        XCTAssertFalse(session.bindRegisteredAccount(from: pending, to: registered))
        XCTAssertNotEqual(session.sessionID, id)
    }
}
