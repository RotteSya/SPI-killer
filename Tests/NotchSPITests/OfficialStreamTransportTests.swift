import XCTest
import Network
@testable import NotchSPI

/// Real loopback HTTP chunking exercises URLSession.AsyncBytes, with no app credentials or model calls.
private final class LocalStreamServer: @unchecked Sendable {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "test.official-stream.http")
    private var connections: [NWConnection] = []
    private let chunks: [Data]
    private let complete: Bool

    init(bytes: Data, complete: Bool) throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
        self.complete = complete
        chunks = stride(from: 0, to: bytes.count, by: 3).map { Data(bytes[$0..<min($0 + 3, bytes.count)]) }
    }
    func start() async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            listener.stateUpdateHandler = { [weak self] state in
                guard let self else { return }
                switch state {
                case .ready:
                    self.listener.stateUpdateHandler = nil
                    guard let port = self.listener.port else { continuation.resume(throwing: URLError(.cannotConnectToHost)); return }
                    continuation.resume(returning: URL(string: "http://127.0.0.1:\(port.rawValue)/v1/captures")!)
                case .failed(let error): self.listener.stateUpdateHandler = nil; continuation.resume(throwing: error)
                default: break
                }
            }
            listener.newConnectionHandler = { [weak self] connection in
                guard let self else { connection.cancel(); return }
                self.connections.append(connection); connection.start(queue: self.queue)
                self.receive(connection, accumulated: Data())
            }
            listener.start(queue: queue)
        }
    }
    private func receive(_ connection: NWConnection, accumulated: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] bytes, _, ended, error in
            guard let self, error == nil, let bytes else { connection.cancel(); return }
            let request = accumulated + bytes
            guard request.count <= 65_536 else { connection.cancel(); return }
            if request.range(of: Data("\r\n\r\n".utf8)) != nil {
                let header = Data("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n".utf8)
                connection.send(content: header, completion: .contentProcessed { [weak self] error in
                    if error != nil { connection.cancel() } else { self?.send(connection, index: 0) }
                })
            } else if ended { connection.cancel() }
            else { self.receive(connection, accumulated: request) }
        }
    }
    private func send(_ connection: NWConnection, index: Int) {
        if index == chunks.count {
            if complete {
                connection.send(content: Data("0\r\n\r\n".utf8), completion: .contentProcessed { _ in connection.cancel() })
            } else { connection.cancel() }
            return
        }
        let chunk = chunks[index], packet = Data((String(chunk.count, radix: 16) + "\r\n").utf8) + chunk + Data("\r\n".utf8)
        connection.send(content: packet, completion: .contentProcessed { [weak self] error in
            if error != nil { connection.cancel() } else { self?.send(connection, index: index + 1) }
        })
    }
    func stop() {
        queue.sync {
            listener.newConnectionHandler = nil; listener.stateUpdateHandler = nil
            connections.forEach { $0.cancel() }; connections.removeAll(); listener.cancel()
        }
    }
}

final class OfficialStreamTransportTests: XCTestCase {
    private func response(id: UUID, done: Bool) throws -> Data {
        let usage: [String: Any] = ["type": "usage", "input_tokens": 2, "output_tokens": 1, "questions_charged": 1,
            "capture_id": id.uuidString, "operation": "solve", "terminal_state": "usable", "settlement_status": "settled",
            "usable_result": true, "balance_questions": 29, "held_questions": 0, "balance_version": "2", "can_retry": false, "can_recover": true]
        let terminal = String(decoding: try JSONSerialization.data(withJSONObject: usage), as: UTF8.self)
        return Data(("data: {\"type\":\"delta\",\"text\":\"中文 🔎 FINAL: B\"}\n\ndata: " + terminal + "\n\n" + (done ? "data: [DONE]\n\n" : "")).utf8)
    }
    func testRealHTTPChunkBoundariesPreserveUnicodeAndOneSettlement() async throws {
        let id = UUID(), server = try LocalStreamServer(bytes: response(id: id, done: true), complete: true)
        defer { server.stop() }
        var request = URLRequest(url: try await server.start()); request.httpMethod = "POST"; request.httpBody = Data("{}".utf8); request.timeoutInterval = 5
        let session = URLSession(configuration: .ephemeral); defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        var text = "", receipts = 0
        let outcome = try await OfficialStreamDecoder.consume(bytes, captureID: id, screenQuery: true) { event in
            if case .delta(let chunk) = event { text += chunk }; if case .usage = event { receipts += 1 }
        }
        XCTAssertEqual(text, "中文 🔎 FINAL: B"); XCTAssertEqual(receipts, 1); XCTAssertTrue(outcome.hasContent)
    }
    func testRealSocketCloseAfterSettlementCannotCompleteAnswerDelivery() async throws {
        let id = UUID(), server = try LocalStreamServer(bytes: response(id: id, done: false), complete: false)
        defer { server.stop() }
        var request = URLRequest(url: try await server.start()); request.timeoutInterval = 5
        let session = URLSession(configuration: .ephemeral); defer { session.invalidateAndCancel() }
        let (bytes, _) = try await session.bytes(for: request)
        var receipts = 0
        do {
            _ = try await OfficialStreamDecoder.consume(bytes, captureID: id, screenQuery: true) { if case .usage = $0 { receipts += 1 } }
            XCTFail("An interrupted response was accepted")
        } catch { XCTAssertTrue(error is OfficialStreamDecoder.Failure || error is URLError) }
        XCTAssertEqual(receipts, 1)
    }
}
