import XCTest
@testable import NotchSPI

final class OfficialStreamDecoderTests: XCTestCase {
    private let id = UUID(uuidString: "6d559174-c118-4891-aec1-b486bfaa0bdb")!
    private func frame(_ object: [String: Any]) throws -> String {
        "data: " + String(decoding: try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), as: UTF8.self) + "\n\n"
    }
    private func delta(_ text: String = "FINAL: B") throws -> String { try frame(["type": "delta", "text": text]) }
    private func usage(_ changes: [String: Any] = [:], screen: Bool = true) -> [String: Any] {
        var value: [String: Any] = ["type": "usage", "input_tokens": 12, "output_tokens": 4, "questions_charged": 1, "balance_questions": 29]
        if screen {
            value.merge(["capture_id": id.uuidString, "operation": "solve", "terminal_state": "usable", "settlement_status": "settled",
                         "usable_result": true, "held_questions": 0, "balance_version": "9007199254740993", "can_retry": false, "can_recover": true]) { _, new in new }
        }
        value.merge(changes) { _, new in new }; return value
    }
    private func consume(_ data: Data, screen: Bool = true, operation: String = "solve") throws -> ([OfficialStreamDecoder.Event], OfficialStreamDecoder.Outcome) {
        var decoder = OfficialStreamDecoder(captureID: id, screenQuery: screen, operation: operation)
        var events: [OfficialStreamDecoder.Event] = []
        for byte in data {
            if let event = try decoder.append(byte) { events.append(event) }
            if decoder.isDone { break }
        }
        return (events, try decoder.finish())
    }
    private func consume(_ text: String, screen: Bool = true, operation: String = "solve") throws -> ([OfficialStreamDecoder.Event], OfficialStreamDecoder.Outcome) {
        try consume(Data(text.utf8), screen: screen, operation: operation)
    }

    func testByteFramingPreservesUnicodeBOMCommentsAndMultilineDataAcrossCRLF() throws {
        let beginning = "\u{FEFF}: keepalive\r\nid: unused\r\n\r\ndata: {\"type\":\"delta\",\r\ndata: \"text\":\"日本語 中文 🔎\\nFINAL: B\"}\r\n\r\n"
        let (events, outcome) = try consume(beginning + frame(usage()) + "data: [DONE]\n\n")
        XCTAssertEqual(events.count, 3); XCTAssertEqual(events.first, .delta("日本語 中文 🔎\nFINAL: B"))
        XCTAssertTrue(outcome.hasContent); XCTAssertNil(outcome.serviceError)
        if case .usage(let receipt) = events[1] { XCTAssertEqual(receipt.balanceVersion, "9007199254740993") }
        else { XCTFail("Missing receipt") }
    }

    func testCumulativeTotalsAreStrictAndRequireTheBalanceVersion() throws {
        let totals: [String: Any] = ["questions": 100, "input_tokens": 2000, "output_tokens": 300]
        let (events, _) = try consume(delta() + frame(usage(["account_totals": totals])) + "data: [DONE]\n\n")
        guard case .usage(let receipt) = events[1] else { return XCTFail("Missing receipt") }
        XCTAssertEqual(receipt.accountTotals, .init(questions: 100, inputTokens: 2000, outputTokens: 300))
        for key in ["questions", "input_tokens", "output_tokens"] {
            for bad in [true, -1, 1.5, "1", NSNull(), NSNumber(value: UInt64.max)] as [Any] {
                var invalid = totals; invalid[key] = bad
                XCTAssertThrowsError(try consume(delta() + frame(usage(["account_totals": invalid])) + "data: [DONE]\n\n"))
            }
            var missing = totals; missing.removeValue(forKey: key)
            XCTAssertThrowsError(try consume(delta() + frame(usage(["account_totals": missing])) + "data: [DONE]\n\n"))
        }
        XCTAssertThrowsError(try consume(delta() + frame(usage(["account_totals": totals], screen: false)) + "data: [DONE]\n\n", screen: false))
        var negative = usage(["account_totals": ["questions": -1, "input_tokens": 0, "output_tokens": 0]])
        let status = try JSONDecoder().decode(SettlementSnapshot.self, from: JSONSerialization.data(withJSONObject: negative))
        XCTAssertFalse(status.isTerminal)
        negative["account_totals"] = totals
        XCTAssertTrue(try JSONDecoder().decode(SettlementSnapshot.self, from: JSONSerialization.data(withJSONObject: negative)).isTerminal)
    }

    func testExplanationCapabilityRequiresAUsableSolveOrRecoveryReceipt() throws {
        for value in ["true", 1, [:]] as [Any] {
            XCTAssertThrowsError(try consume(delta() + frame(usage(["explanation_available": value])) + "data: [DONE]\n\n"))
        }
        let (events, _) = try consume(delta() + frame(usage(["explanation_available": true])) + "data: [DONE]\n\n")
        guard case .usage(let receipt) = events[1] else { return XCTFail("Missing receipt") }
        XCTAssertEqual(receipt.explanationAvailable, true)
        XCTAssertThrowsError(try consume(delta() + frame(usage(["explanation_available": true], screen: false)) + "data: [DONE]\n\n", screen: false))
        let auxiliary = usage(["operation": "explain", "questions_charged": 0, "settlement_status": "not_required", "explanation_available": true])
        XCTAssertThrowsError(try consume(delta() + frame(auxiliary) + "data: [DONE]\n\n", operation: "explain"))
        let released = usage(["terminal_state": "retake", "usable_result": false, "questions_charged": 0,
                              "settlement_status": "released", "explanation_available": true])
        XCTAssertThrowsError(try consume(frame(released) + "data: [DONE]\n\n"))
    }

    func testEveryTruncatedPrefixIncludingAfterSettlementFailsToComplete() throws {
        let bytes = Data((try delta() + frame(usage()) + "data: [DONE]\n\n").utf8)
        for end in 0..<bytes.count { XCTAssertThrowsError(try consume(bytes.prefix(end)), "prefix \(end)") }
        XCTAssertNoThrow(try consume(bytes))
    }

    func testMalformedJSONUnknownEventsAndBrokenUTF8CannotBeSkipped() throws {
        for broken in ["data: {broken}\n\n", "data: []\n\n", "data: {\"type\":\"unknown\"}\n\n", "data: {\"type\":\"delta\",\"text\":true}\n\n"] {
            XCTAssertThrowsError(try consume(delta() + broken + frame(usage()) + "data: [DONE]\n\n"))
        }
        XCTAssertThrowsError(try consume(Data("data: ".utf8) + Data([0xff, 0xfe, 10, 10])))
    }

    func testReceiptNumbersCannotBeMissingNullBooleanNegativeFractionalOrOverflowing() throws {
        let replacements: [[String: Any]] = [
            ["input_tokens": NSNull()], ["input_tokens": true], ["input_tokens": -1], ["input_tokens": 1.5],
            ["output_tokens": "4"], ["output_tokens": NSNumber(value: UInt64.max)],
            ["questions_charged": true], ["questions_charged": 2], ["balance_questions": -1], ["balance_questions": NSNull()],
            ["balance_version": "1e10"], ["balance_version": NSNull()]
        ]
        for replacement in replacements { XCTAssertThrowsError(try consume(delta() + frame(usage(replacement)) + "data: [DONE]\n\n")) }
        for key in ["input_tokens", "output_tokens", "questions_charged", "balance_questions"] {
            var missing = usage(); missing.removeValue(forKey: key)
            XCTAssertThrowsError(try consume(delta() + frame(missing) + "data: [DONE]\n\n"))
        }
    }

    func testDuplicateReceiptAndOutOfOrderContentErrorOrDoneAreRejected() throws {
        let content = try delta(), receipt = try frame(usage()), done = "data: [DONE]\n\n"
        let error = try frame(["type": "error", "error": ["message": "failed", "code": "upstream_error"]])
        for text in [content + receipt + receipt + done, content + receipt + content + done,
                     content + receipt + error + done, content + done, error + content + receipt + done,
                     error + error + receipt + done, error + receipt + done, receipt + done] {
            XCTAssertThrowsError(try consume(text))
        }
    }

    func testReceiptMustMatchTheRequestOperationAndCommittedTerminalState() throws {
        for changes: [String: Any] in [["capture_id": UUID().uuidString], ["capture_id": "bad"], ["operation": "recover"],
            ["terminal_state": "pending"], ["settlement_status": "held"], ["usable_result": false], ["held_questions": -1]] {
            XCTAssertThrowsError(try consume(delta() + frame(usage(changes)) + "data: [DONE]\n\n"))
        }
        XCTAssertThrowsError(try consume(delta() + frame(usage(["operation": "recover"])) + "data: [DONE]\n\n", operation: "recover"))
    }

    func testRetakeNoResultAndAuxiliarySuccessRemainDistinctWithoutAnExtraCharge() throws {
        let released: [String: Any] = ["terminal_state": "retake", "settlement_status": "released", "questions_charged": 0, "usable_result": false, "balance_questions": 30]
        let retake = try consume(delta("NSPI_RESULT_V1: {\"v\":1,\"kind\":\"single_choice\",\"state\":\"retake\",\"answer\":null,\"reason\":\"cropped\"}") + frame(usage(released)) + "data: [DONE]\n\n")
        XCTAssertTrue(retake.1.hasContent); XCTAssertNil(retake.1.serviceError)
        var noResult = released; noResult["terminal_state"] = "no_result"
        let diagnostic = try frame(["type": "error", "error": ["message": "Select one question", "code": "multiple_targets"]])
        let result = try consume(diagnostic + frame(usage(noResult)) + "data: [DONE]\n\n")
        XCTAssertFalse(result.1.hasContent); XCTAssertEqual(result.1.serviceError?.code, "multiple_targets")
        let auxiliary = try consume(delta("A short explanation") + frame(usage(["operation": "explain", "settlement_status": "not_required", "questions_charged": 0])) + "data: [DONE]\n\n", operation: "explain")
        XCTAssertTrue(auxiliary.1.hasContent); XCTAssertNil(auxiliary.1.serviceError)
    }

    func testLegacyReceiptDoesNotRequireTheNewContractButStillNeedsACompleteStream() throws {
        let stream = try delta() + frame(usage(screen: false)) + "data: [DONE]\n\n"
        XCTAssertTrue(try consume(stream, screen: false).1.hasContent)
        XCTAssertThrowsError(try consume(stream, screen: true))
    }

    func testEventAndDecodedTextLimitsRejectWithoutTruncatingIntoAUsableAnswer() throws {
        XCTAssertThrowsError(try consume("data: " + String(repeating: "x", count: 512 * 1024) + "\n\n"))
        XCTAssertThrowsError(try consume(delta(String(repeating: "x", count: 32 * 1024)) + delta(String(repeating: "x", count: 32 * 1024 + 1))))
        var decoder = OfficialStreamDecoder(captureID: id, screenQuery: true)
        let comment = Array((":" + String(repeating: "x", count: 1022) + "\n").utf8)
        for _ in 0..<4096 { for byte in comment { _ = try decoder.append(byte) } }
        XCTAssertThrowsError(try decoder.append(10))
    }

    func testTransportErrorAfterAValidReceiptNeverBecomesDeliverySuccess() async throws {
        let data = Data((try delta() + frame(usage())).utf8)
        let bytes = AsyncThrowingStream<UInt8, Error> { continuation in
            for byte in data { continuation.yield(byte) }
            continuation.finish(throwing: URLError(.networkConnectionLost))
        }
        var receipts = 0
        do {
            _ = try await OfficialStreamDecoder.consume(bytes, captureID: id, screenQuery: true) { event in if case .usage = event { receipts += 1 } }
            XCTFail("A partial transfer must not finish successfully")
        } catch { XCTAssertEqual((error as? URLError)?.code, .networkConnectionLost) }
        XCTAssertEqual(receipts, 1, "A received settlement remains valid even when delivery is incomplete")
    }

    func testCancellationStopsBeforeDeliveringBufferedEvents() async throws {
        let data = Data((try delta() + frame(usage()) + "data: [DONE]\n\n").utf8), id = id
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            let bytes = AsyncStream<UInt8> { continuation in for byte in data { continuation.yield(byte) }; continuation.finish() }
            do {
                _ = try await OfficialStreamDecoder.consume(bytes, captureID: id, screenQuery: true) { _ in XCTFail("Canceled content delivered") }
                XCTFail("Canceled stream completed")
            } catch { XCTAssertTrue(error is CancellationError || error is OfficialStreamDecoder.Failure) }
        }
        await task.value
    }

    func testExtremeValidCountersCannotOverflowTheLocalUsageMirror() {
        XCTAssertEqual(OfficialAPI.accumulateUsage(Int.max, 1), Int.max)
        XCTAssertEqual(OfficialAPI.accumulateUsage(1, Int.max), Int.max)
        XCTAssertEqual(OfficialAPI.accumulateUsage(-10, 4), 4)
        XCTAssertEqual(OfficialAPI.accumulateUsage(12, 4), 16)
    }
}
