import Foundation

struct CLIInfo {
    var installed: Bool
    var path: String?
    var version: String?
    var loggedIn: Bool? // nil = unknown
}

enum CLIRunner {
    private static let home = FileManager.default.homeDirectoryForCurrentUser.path

    // MARK: - Detection

    static func candidateDirs() -> [String] {
        var dirs = [
            "/opt/homebrew/bin", "/opt/homebrew/sbin",
            "/usr/local/bin", "/usr/local/sbin", "/usr/bin", "/bin",
            "\(home)/.local/bin", "\(home)/.npm-global/bin",
            "\(home)/.cargo/bin", "\(home)/.bun/bin", "\(home)/.deno/bin",
            "\(home)/.volta/bin", "\(home)/.asdf/shims",
            "/opt/homebrew/lib/node_modules/.bin", "/usr/local/lib/node_modules/.bin",
            // Desktop-app bundle that ships a usable macOS codex CLI:
            "/Applications/Codex.app/Contents/Resources",
            "\(home)/Applications/Codex.app/Contents/Resources",
            "\(home)/.claude/local",
        ]
        let nvm = "\(home)/.nvm/versions/node"
        if let vers = try? FileManager.default.contentsOfDirectory(atPath: nvm) {
            for v in vers { dirs.append("\(nvm)/\(v)/bin") }
        }
        return dirs
    }

    static func augmentedEnv() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        let extra = candidateDirs().joined(separator: ":")
        env["PATH"] = extra + ":" + (env["PATH"] ?? "")
        return env
    }

    /// An isolated empty dir to run the CLIs in, so the agentic tools never crawl
    /// the user's current project (e.g. a huge node_modules).
    static func workDir() -> String {
        let dir = NSTemporaryDirectory() + "notch-tutor-work"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        return dir
    }

    private static func findInDirs(_ bin: String) -> String? {
        let fm = FileManager.default
        for d in candidateDirs() {
            let p = "\(d)/\(bin)"
            if fm.isExecutableFile(atPath: p) { return p }
        }
        return nil
    }

    private static func findViaLoginShell(_ bins: [String]) -> [String: String] {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh")
        p.arguments = ["-lic", "command -v \(bins.joined(separator: " ")) 2>/dev/null"]
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return [:] }
        // Guard against a slow or hanging shell rc so detection never blocks indefinitely.
        // `-i` is intentional (PATH additions for nvm/asdf/etc. usually live in an interactive
        // `.zshrc`), but it also runs arbitrary user startup code — cap it at a few seconds.
        let killer = DispatchWorkItem { if p.isRunning { p.terminate() } }
        DispatchQueue.global().asyncAfter(deadline: .now() + 4, execute: killer)
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        killer.cancel()
        var map: [String: String] = [:]
        if let s = String(data: data, encoding: .utf8) {
            for line in s.split(separator: "\n") {
                let path = line.trimmingCharacters(in: .whitespaces)
                if path.hasPrefix("/") {
                    let base = (path as NSString).lastPathComponent
                    if map[base] == nil { map[base] = path }
                }
            }
        }
        return map
    }

    /// Run a short-lived probe (`--version`, `auth status`) and collect both streams.
    ///
    /// Both pipes are drained CONCURRENTLY and the child is given a deadline. Reading stdout to
    /// EOF first — the previous shape — deadlocks as soon as a child fills its 64 KB stderr
    /// buffer: it blocks writing stderr, so it never closes stdout, so neither side can move.
    /// This runs inside `detect()`'s `withCheckedContinuation`, so a deadlock meant the
    /// continuation never resumed and the capture path stayed wedged until the app was relaunched.
    @discardableResult
    private static func runCapture(
        _ binPath: String, _ args: [String], timeout: TimeInterval = 8
    ) -> (code: Int32, out: String, err: String) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: binPath)
        p.arguments = args
        p.environment = augmentedEnv()
        let o = Pipe()
        let e = Pipe()
        p.standardOutput = o
        p.standardError = e
        p.standardInput = FileHandle.nullDevice
        do { try p.run() } catch { return (-1, "", "\(error)") }

        let lock = NSLock()
        var outData = Data()
        var errData = Data()
        let group = DispatchGroup()
        group.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            let d = o.fileHandleForReading.readDataToEndOfFile()
            lock.lock(); outData = d; lock.unlock()
            group.leave()
        }
        group.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            let d = e.fileHandleForReading.readDataToEndOfFile()
            lock.lock(); errData = d; lock.unlock()
            group.leave()
        }

        if group.wait(timeout: .now() + timeout) == .timedOut {
            // Terminating closes the child's pipe ends, which unblocks both drains.
            p.terminate()
            if group.wait(timeout: .now() + 2) == .timedOut {
                kill(p.processIdentifier, SIGKILL)
                _ = group.wait(timeout: .now() + 2)
            }
        }
        p.waitUntilExit()
        lock.lock()
        defer { lock.unlock() }
        return (
            p.terminationStatus,
            String(data: outData, encoding: .utf8) ?? "",
            String(data: errData, encoding: .utf8) ?? ""
        )
    }

    private static func detectOne(bin: String, versionArgs: [String], auth: (String) -> Bool?) -> CLIInfo {
        var path = findInDirs(bin)
        if path == nil { path = findViaLoginShell([bin])[bin] }
        guard let p = path else { return CLIInfo(installed: false, path: nil, version: nil, loggedIn: nil) }
        let v = runCapture(p, versionArgs)
        let version = (v.out + "\n" + v.err).split(separator: "\n").first.map { String($0).trimmingCharacters(in: .whitespaces) }
        return CLIInfo(installed: true, path: p, version: version, loggedIn: auth(p))
    }

    private static func matches(_ text: String, _ pattern: String) -> Bool {
        text.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
    }

    /// Session cache for the capture hotpath: a full probe spawns a login shell plus several
    /// child processes (`--version`, auth status) and can take seconds. Entries are revalidated
    /// cheaply (the binary must still exist); the controller re-probes fresh when the cache
    /// doesn't yield a runnable CLI and drops it whenever a run fails, so an uninstall or
    /// logout never sticks.
    @MainActor private static var detectCache: [String: CLIInfo]?

    @MainActor static func detectCached() async -> [String: CLIInfo] {
        if let cached = detectCache,
           cached.values.allSatisfy({ $0.path == nil || FileManager.default.isExecutableFile(atPath: $0.path!) }) {
            return cached
        }
        return await detectFresh()
    }

    @MainActor static func detectFresh() async -> [String: CLIInfo] {
        let fresh = await detect()
        detectCache = fresh
        return fresh
    }

    @MainActor static func invalidateDetectCache() { detectCache = nil }

    static func detect() async -> [String: CLIInfo] {
        await withCheckedContinuation { cont in
            DispatchQueue.global(qos: .userInitiated).async {
                var result: [String: CLIInfo] = [:]
                result["claude"] = detectOne(bin: "claude", versionArgs: ["--version"]) { path in
                    let r = runCapture(path, ["auth", "status"])
                    let t = r.out + "\n" + r.err
                    if r.code == 0 && matches(t, "logged in|account|subscription|plan|@") { return true }
                    if matches(t, "not logged in|unauthenti|please (run )?log ?in") { return false }
                    return nil
                }
                result["codex"] = detectOne(bin: "codex", versionArgs: ["--version"]) { path in
                    let r = runCapture(path, ["login", "status"])
                    let t = r.out + "\n" + r.err
                    if r.code == 0 && matches(t, "logged in") { return true }
                    if matches(t, "not logged in") { return false }
                    return nil
                }
                cont.resume(returning: result)
            }
        }
    }

    // MARK: - Run (streaming)

    /// Final argv for one frozen prompt. Kept pure so channel parity and argument ordering are
    /// testable without spawning either CLI (`--image` is variadic in Codex, so prompt order is
    /// significant).
    static func makeArguments(
        cliId: String, prompt: CapturePrompt, imagePath: String
    ) -> [String] {
        if cliId == "claude" {
            let text = prompt.system
                + "\n\nThe screenshot is saved at this path: \(imagePath)\nOpen and read that image file, then "
                + prompt.task
            return [
                "-p", text,
                "--allowedTools", "Read",
                "--disallowedTools", "Edit,Write,Bash,WebFetch,WebSearch",
                "--permission-mode", "dontAsk",
                "--output-format", "stream-json", "--verbose", "--include-partial-messages",
            ]
        }
        let text = prompt.system + "\n\nAnalyze the attached screenshot image, then " + prompt.task
        return ["exec", "--sandbox", "read-only", "--skip-git-repo-check", text, "-i", imagePath]
    }

    /// Spawn the chosen CLI read-only and stream text via onDelta. Callbacks fire
    /// on the main queue. A safety timeout kills a stuck process after 120s.
    static func run(
        cliId: String,
        binPath: String,
        imagePath: String,
        prompt: CapturePrompt,
        onDelta: @escaping (String) -> Void,
        onDone: @escaping (_ ok: Bool, _ stderr: String) -> Void
    ) {
        let isClaude = (cliId == "claude")
        let args = makeArguments(cliId: cliId, prompt: prompt, imagePath: imagePath)

        let wd = workDir()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: binPath)
        p.arguments = args
        p.environment = augmentedEnv()
        p.currentDirectoryURL = URL(fileURLWithPath: wd) // isolated empty dir
        #if DEBUG
        print("[NotchSPI] run \(cliId) cwd=\(wd) argc=\(args.count)")
        #endif
        let o = Pipe()
        let e = Pipe()
        p.standardOutput = o
        p.standardError = e
        p.standardInput = FileHandle.nullDevice // immediate EOF — codex exec hangs otherwise

        var stderrBuf = ""
        var lineBuf = ""
        var sawText = false
        var resultText = ""
        var finished = false
        // All stream state above is confined to this serial queue, so the stdout, stderr, and
        // termination callbacks never mutate it concurrently. Each callback reads its pipe *inside*
        // a queued block, so pulling bytes and processing them is atomic and strictly ordered.
        let ioQueue = DispatchQueue(label: "com.rottesya.notchspi.cli-io")

        // Parse one line of Claude stream-json (delta → onDelta, result → resultText). On ioQueue.
        func handleClaudeLine(_ line: String) {
            if let t = parseClaudeDelta(line) {
                sawText = true
                DispatchQueue.main.async { onDelta(t) }
            } else if let r = parseClaudeResult(line) {
                resultText = r
            }
        }

        // Feed a chunk of stdout through the parser. On ioQueue.
        func ingest(_ chunk: String) {
            if isClaude {
                lineBuf += chunk
                while let nl = lineBuf.firstIndex(of: "\n") {
                    let line = String(lineBuf[..<nl])
                    lineBuf.removeSubrange(lineBuf.startIndex...nl)
                    handleClaudeLine(line)
                }
            } else {
                sawText = true
                DispatchQueue.main.async { onDelta(chunk) }
            }
        }

        // On ioQueue. Idempotent via `finished`.
        func finish(_ ok: Bool) {
            if finished { return }
            finished = true
            o.fileHandleForReading.readabilityHandler = nil
            e.fileHandleForReading.readabilityHandler = nil

            // Drain whatever is still buffered in the pipes: the process can exit before the last
            // readability callback fires, which would otherwise drop the tail — for Claude, the
            // final `result` line, surfacing as a spurious "（没有输出）" on a successful run.
            if let rest = try? o.fileHandleForReading.readToEnd(),
               let chunk = String(data: rest, encoding: .utf8), !chunk.isEmpty {
                ingest(chunk)
            }
            if let rest = try? e.fileHandleForReading.readToEnd(),
               let s = String(data: rest, encoding: .utf8), !s.isEmpty {
                stderrBuf += s
            }
            // A trailing Claude line with no newline terminator stays in lineBuf — flush it.
            if isClaude, !lineBuf.isEmpty {
                handleClaudeLine(lineBuf)
                lineBuf = ""
            }

            if !sawText, !resultText.isEmpty {
                let r = resultText
                DispatchQueue.main.async { onDelta(r) }
            }
            let errOut = stderrBuf
            DispatchQueue.main.async { onDone(ok, errOut) }
        }

        o.fileHandleForReading.readabilityHandler = { h in
            ioQueue.async {
                guard !finished else { return }
                let data = h.availableData
                if data.isEmpty { return }
                guard let chunk = String(data: data, encoding: .utf8) else { return }
                ingest(chunk)
            }
        }
        e.fileHandleForReading.readabilityHandler = { h in
            ioQueue.async {
                guard !finished else { return }
                let data = h.availableData
                if data.isEmpty { return }
                guard let s = String(data: data, encoding: .utf8) else { return }
                stderrBuf += s
            }
        }
        p.terminationHandler = { proc in
            ioQueue.async {
                let status = proc.terminationStatus
                #if DEBUG
                print("[NotchSPI] \(cliId) exited \(status) sawText=\(sawText) stderrLen=\(stderrBuf.count)")
                if status != 0 {
                    print("[NotchSPI] stderr tail: \(String(stderrBuf.suffix(500)))")
                }
                #endif
                finish(status == 0 || sawText)
            }
        }

        do {
            try p.run()
        } catch {
            DispatchQueue.main.async { onDone(false, "spawn failed: \(error)") }
            return
        }

        // Safety timeout: SIGTERM after 120s, then SIGKILL if the process ignores it.
        DispatchQueue.global().asyncAfter(deadline: .now() + 120) {
            guard p.isRunning else { return }
            p.terminate() // SIGTERM
            DispatchQueue.global().asyncAfter(deadline: .now() + 5) {
                if p.isRunning { kill(p.processIdentifier, SIGKILL) }
            }
        }
    }

    private static func parseClaudeDelta(_ line: String) -> String? {
        guard let data = line.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        if obj["type"] as? String == "stream_event",
           let event = obj["event"] as? [String: Any],
           let delta = event["delta"] as? [String: Any],
           delta["type"] as? String == "text_delta",
           let text = delta["text"] as? String {
            return text
        }
        return nil
    }

    private static func parseClaudeResult(_ line: String) -> String? {
        guard let data = line.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        if obj["type"] as? String == "result", let r = obj["result"] as? String { return r }
        return nil
    }
}
