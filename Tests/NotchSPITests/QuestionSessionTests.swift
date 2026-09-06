import XCTest
@testable import NotchSPI

final class QuestionSessionTests: XCTestCase {
    private let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGaQAAAAASUVORK5CYII=")!

    @MainActor
    func testReferenceOrderLimitAndSnapshotLeaseSurviveClearing() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let session = QuestionSessionStore(directory: root.appendingPathComponent("materials"))
        session.begin(scope: "reader:official", newQuestionGroup: true)
        var referenceIDs: [UUID] = []
        for index in 0..<4 {
            let source = root.appendingPathComponent("source-\(index).png")
            try png.write(to: source)
            let asset = try await session.adopt(path: source.path, targetFingerprint: "reader-window", asReference: index < 3)
            if index < 3 { referenceIDs.append(asset.id) }
        }
        let snapshot = try session.snapshot(captureID: UUID(), includeReferences: true)
        XCTAssertEqual(snapshot.assets.count, 4)
        XCTAssertEqual(Array(snapshot.assets.prefix(3).map(\.id)), referenceIDs)
        XCTAssertEqual(snapshot.assets.last?.id, session.currentQuestion?.id)
        XCTAssertThrowsError(try session.saveCurrentAsReference())
        XCTAssertEqual(session.references.map(\.id), referenceIDs)
        session.clear()
        XCTAssertTrue(session.references.isEmpty)
        XCTAssertNil(session.currentQuestion)
        XCTAssertNotEqual(session.sessionID, snapshot.sessionID)
        for asset in snapshot.assets {
            XCTAssertTrue(FileManager.default.fileExists(atPath: asset.file.url.path), "in-flight snapshot retains its files")
            let permissions = try FileManager.default.attributesOfItem(atPath: asset.file.url.path)[.posixPermissions] as? NSNumber
            XCTAssertEqual(permissions?.intValue, 0o600)
        }
    }

    @MainActor
    func testExpiryAndChannelChangesCreateNewSessionIdentities() {
        var now = Date(timeIntervalSince1970: 1_000_000)
        let session = QuestionSessionStore(now: { now })
        session.begin(scope: "reader:official", newQuestionGroup: true)
        let id = session.sessionID
        now.addTimeInterval(899)
        XCTAssertFalse(session.expireIfNeeded())
        XCTAssertEqual(session.sessionID, id)
        now.addTimeInterval(1)
        XCTAssertTrue(session.expireIfNeeded())
        XCTAssertNotEqual(session.sessionID, id)
        let expired = session.sessionID
        session.begin(scope: "reader:custom", newQuestionGroup: false)
        XCTAssertNotEqual(session.sessionID, expired)
    }

    @MainActor
    func testChangingTargetCannotAppendAnotherWindowsMaterial() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let session = QuestionSessionStore(directory: root.appendingPathComponent("materials"))
        session.begin(scope: "reader", newQuestionGroup: true)
        for (index, target) in ["first-window", "second-window"].enumerated() {
            let source = root.appendingPathComponent("\(index).png")
            try png.write(to: source)
            do {
                _ = try await session.adopt(path: source.path, targetFingerprint: target, asReference: true)
                XCTAssertEqual(index, 0)
            } catch QuestionSessionStore.SessionError.changedTarget {
                XCTAssertEqual(index, 1)
            }
        }
        XCTAssertTrue(session.references.isEmpty)
    }
}

final class ScreenQueryContractTests: XCTestCase {
    func testNoResultMarkersStayHiddenAtEveryCharacterBoundary() {
        let raw = "NSPI_NO_RESULT_V1: {\"v\":1,\"reason\":\"multiple_targets\"}"
        var stream = ObjectiveResultStreamFilter()
        for character in raw { XCTAssertEqual(stream.append(String(character)), "") }
        XCTAssertEqual(stream.finish().noResultReason, "multiple_targets")
        XCTAssertNil(stream.finish().finalAnswer)
        for invalid in [
            "NSPI_NO_RESULT_V1: {\"v\":true,\"reason\":\"multiple_targets\"}",
            "NSPI_NO_RESULT_V1: {\"v\":1,\"v\":1,\"reason\":\"multiple_targets\"}",
            "NSPI_NO_RESULT_V1: {\"v\":1,\"reason\":[\"multiple_targets\"]}",
            "FINAL: B\n" + raw,
        ] {
            XCTAssertNil(ScreenQueryDiagnostic.parse(invalid))
            XCTAssertNil(ObjectiveResultParser.compose(raw: invalid).finalAnswer)
        }
    }

    func testNegotiatedRequestKeepsTheQuestionLastAndLegacyCompatibilityField() throws {
        let id = UUID(), parent = UUID()
        let request = OfficialAPI.makeCaptureRequest(baseURL: "https://example.com", deviceToken: "dev_test",
            prompt: .init(system: "s", task: "t"), imagesBase64: ["reference1", "reference2", "reference3", "question"],
            resultProtocol: "objective_v1", captureID: id,
            screenQuery: .init(profileID: "reading_practice", language: "en", parentCaptureID: parent))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as? [String: Any])
        XCTAssertEqual(json["image_base64"] as? String, "question")
        XCTAssertEqual(json["images_base64"] as? [String], ["reference1", "reference2", "reference3", "question"])
        XCTAssertEqual(json["response_contract"] as? String, "screen_query_v1")
        XCTAssertEqual(json["parent_capture_id"] as? String, parent.uuidString.lowercased())
        XCTAssertEqual((json["scope"] as? [String: Any])?["question_image_index"] as? Int, 3)
    }

    func testBalanceVersionsCompareAsDecimalIntegersWithoutRounding() {
        XCTAssertTrue(BalanceVersion.accepts(incoming: "9007199254740993", current: "9007199254740992"))
        XCTAssertFalse(BalanceVersion.accepts(incoming: "9007199254740992", current: "9007199254740993"))
        XCTAssertTrue(BalanceVersion.accepts(incoming: "00010", current: "9"))
        for invalid in ["", "-1", "1.0", "1e2", " 12", "１２"] {
            XCTAssertFalse(BalanceVersion.accepts(incoming: invalid, current: "1"))
        }
    }

    func testSettlementRequiresConsistentStatusChargeAndResult() throws {
        func decode(_ state: String, _ settlement: String, _ charge: Int?, _ usable: Bool) throws -> SettlementSnapshot {
            let json: [String: Any] = ["capture_id": UUID().uuidString, "terminal_state": state,
                "settlement_status": settlement, "questions_charged": charge as Any? ?? NSNull(),
                "usable_result": usable, "balance_questions": 29, "held_questions": 0,
                "balance_version": "3", "can_retry": false, "can_recover": false]
            return try JSONDecoder().decode(SettlementSnapshot.self, from: JSONSerialization.data(withJSONObject: json))
        }
        XCTAssertTrue(try decode("usable", "settled", 1, true).isTerminal)
        XCTAssertTrue(try decode("retake", "released", 0, false).isTerminal)
        XCTAssertTrue(try decode("usable", "not_required", 0, true).isTerminal)
        XCTAssertFalse(try decode("retake", "settled", 1, true).isTerminal)
        XCTAssertFalse(try decode("pending", "released", 0, false).isTerminal)
        XCTAssertFalse(try decode("usable", "settled", 1, false).isTerminal)
        XCTAssertFalse(try decode("pending", "held", nil, false).isTerminal)
    }
}
