import AppKit
import Foundation
import Darwin

// Only allowlisted aggregate status reaches the menu. The helper never reads
// task content, SQLite, or the bridge lock. The opener uses a token in memory.
private let platformName = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "Airodrom"

private enum BridgeState: String, Codable {
    case connected = "Connected", stopped = "Stopped", starting = "Starting", error = "Error"
}
private struct BridgeStatus: Codable {
    struct MCP: Codable { let ready: Bool; let lastCallAt: Double? }
    struct Tasks: Codable { let active: Int; let connected: Int; let total: Int; let counts: [String: Int] }
    let state: BridgeState
    let message: String?
    let pid: Int?
    let endpoint: String?
    let mcp: MCP
    let tasks: Tasks
    let lastActivityAt: Double?
    let lastHeartbeatAt: Double?
    let now: Double
    let managed: Bool
    var valid: Bool {
        tasks.active >= 0 && tasks.connected >= 0 && tasks.total >= 0 &&
        tasks.counts.values.allSatisfy { $0 >= 0 && $0 <= 1_000_000 } && (pid == nil || pid! > 0)
    }
    var localEndpoint: String? {
        guard let endpoint, let url = URLComponents(string: endpoint),
              url.scheme == "http", url.host == "127.0.0.1", let port = url.port, (1...65535).contains(port),
              url.user == nil, url.password == nil, url.query == nil,
              url.fragment == nil, url.path.isEmpty || url.path == "/" else { return nil }
        return "http://127.0.0.1:\(port)"
    }
}
private enum ControlAction: String { case status, start, stop, restart, open }
private enum HelperError: Error {
    case configuration, timeout, command, response, busy
    var message: String {
        switch self {
        case .busy: return "Another control request is active, or the private control lock is unavailable."
        case .configuration: return "Helper configuration is unavailable. Reinstall the macOS helper."
        case .timeout: return "Control request timed out. Check the Control Center before retrying."
        case .command: return "Control request failed. Check the Control Center."
        case .response: return "Bridge status is unavailable. Check the Control Center."
        }
    }
}
private struct Configuration {
    let node: String
    let control: String
    let dataDirectory: String
    init() throws {
        let info = Bundle.main.infoDictionary ?? [:]
        guard let node = info["PiBridgeNode"] as? String,
              let control = info["PiBridgeControl"] as? String,
              let directory = info["PiBridgeDataDir"] as? String,
              [node, control, directory].allSatisfy({ $0.hasPrefix("/") }),
              FileManager.default.isExecutableFile(atPath: node),
              FileManager.default.isReadableFile(atPath: control) else { throw HelperError.configuration }
        self.node = node; self.control = control; self.dataDirectory = directory
    }
}
private final class Invocation: @unchecked Sendable {
    let process = Process()
    private let lock = NSLock()
    private var didTimeOut = false
    private var finished = false
    var timedOut: Bool { lock.lock(); defer { lock.unlock() }; return didTimeOut }
    func expire() {
        lock.lock(); defer { lock.unlock() }
        guard !finished, process.isRunning else { return }
        didTimeOut = true
        // This is only our own bounded control request. The controller alone
        // validates and signals the bridge; the helper never guesses its PID.
        process.terminate()
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 1) { [self] in
            lock.lock(); defer { lock.unlock() }
            if !finished, process.isRunning { Darwin.kill(process.processIdentifier, SIGKILL) }
        }
    }
    func complete() { lock.lock(); finished = true; lock.unlock() }
}
private final class Controller {
    let configuration: Configuration
    init(configuration: Configuration) { self.configuration = configuration }
    func perform(_ action: ControlAction, completion: @escaping (Result<BridgeStatus, HelperError>) -> Void) {
        DispatchQueue.global(qos: .utility).async { [configuration] in
            let mutation = action == .start || action == .stop || action == .restart
            let controlLock = mutation ? acquirePrivateLock(configuration.dataDirectory, name: "macos-control.lock") : nil
            if mutation && controlLock == nil { completion(.failure(.busy)); return }
            defer { if let controlLock { Darwin.close(controlLock) } }
            let invocation = Invocation(), output = Pipe()
            let process = invocation.process
            process.executableURL = URL(fileURLWithPath: configuration.node)
            process.arguments = [configuration.control, action.rawValue, "--control-locked"]
            process.currentDirectoryURL = URL(fileURLWithPath: configuration.control).deletingLastPathComponent()
            process.environment = ["HOME": NSHomeDirectory(), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8"]
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            process.standardInput = FileHandle.nullDevice
            do { try process.run() } catch { completion(.failure(.command)); return }
            let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
            timer.schedule(deadline: .now() + 25)
            timer.setEventHandler { invocation.expire() }
            timer.resume()
            let data = output.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit(); invocation.complete(); timer.cancel()
            if invocation.timedOut { completion(.failure(.timeout)); return }
            guard data.count <= 65_536,
                  let status = try? JSONDecoder().decode(BridgeStatus.self, from: data), status.valid else {
                completion(.failure(process.terminationStatus == 0 ? .response : .command)); return
            }
            completion(.success(status))
        }
    }
}
private final class MenuApplication: NSObject, NSApplicationDelegate {
    private let controller: Controller
    private let helperLock: Int32
    private var statusItem: NSStatusItem!
    private let menu = NSMenu()
    private let stateRow = NSMenuItem(title: "Status: Starting", action: nil, keyEquivalent: "")
    private let detailRow = NSMenuItem(title: "Checking bridge…", action: nil, keyEquivalent: "")
    private let endpointRow = NSMenuItem(title: "Control Center: checking…", action: nil, keyEquivalent: "")
    private let pidRow = NSMenuItem(title: "Bridge process: checking…", action: nil, keyEquivalent: "")
    private let mcpRow = NSMenuItem(title: "MCP: checking…", action: nil, keyEquivalent: "")
    private let mcpActivityRow = NSMenuItem(title: "Last MCP request: checking…", action: nil, keyEquivalent: "")
    private let tasksRow = NSMenuItem(title: "Tasks: checking…", action: nil, keyEquivalent: "")
    private let taskStatesRow = NSMenuItem(title: "Task states", action: nil, keyEquivalent: "")
    private let activityRow = NSMenuItem(title: "Last activity: checking…", action: nil, keyEquivalent: "")
    private let heartbeatRow = NSMenuItem(title: "Last heartbeat: checking…", action: nil, keyEquivalent: "")
    private let checkedRow = NSMenuItem(title: "Last checked: not yet", action: nil, keyEquivalent: "")
    private var startItem: NSMenuItem!, restartItem: NSMenuItem!, stopItem: NSMenuItem!, openItem: NSMenuItem!, quitItem: NSMenuItem!
    private var timer: Timer?
    private var status: BridgeStatus?
    private var checkedAt: Date?
    private var lastError: String?
    private var currentAction: ControlAction?
    private var pendingAction: ControlAction?
    private var quitAfterAction = false
    init(controller: Controller, helperLock: Int32) { self.controller = controller; self.helperLock = helperLock; super.init() }
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "A"
        statusItem.button?.font = NSFont.systemFont(ofSize: 18, weight: .semibold)
        statusItem.button?.setAccessibilityLabel(platformName)
        statusItem.menu = menu
        menu.autoenablesItems = false
        menu.addItem(NSMenuItem(title: platformName, action: nil, keyEquivalent: ""))
        [stateRow, detailRow, endpointRow, pidRow].forEach { menu.addItem($0) }
        menu.addItem(.separator())
        [mcpRow, mcpActivityRow].forEach { menu.addItem($0) }
        menu.addItem(NSMenuItem(title: "ChatGPT: end-to-end connection unverified", action: nil, keyEquivalent: ""))
        menu.addItem(.separator())
        [tasksRow, taskStatesRow, activityRow, heartbeatRow, checkedRow].forEach { menu.addItem($0) }
        menu.addItem(.separator())
        openItem = actionItem("Open Control Center", #selector(openCenter))
        startItem = actionItem("Start Bridge", #selector(startBridge))
        restartItem = actionItem("Restart Bridge", #selector(restartBridge))
        stopItem = actionItem("Stop Bridge", #selector(stopBridge))
        menu.addItem(.separator())
        quitItem = actionItem("Quit Menu-Bar Helper", #selector(quitHelper))
        render(); request(.status)
        let timer = Timer(timeInterval: 5, repeats: true) { [weak self] _ in
            guard let self else { return }; self.render(); self.request(.status)
        }
        self.timer = timer
        // Common modes keep polling while the menu is open.
        RunLoop.main.add(timer, forMode: .common)
    }
    private func actionItem(_ title: String, _ selector: Selector) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: selector, keyEquivalent: "")
        item.target = self; menu.addItem(item); return item
    }
    private func request(_ action: ControlAction) {
        guard !quitAfterAction else { return }
        if currentAction != nil {
            if action != .status, currentAction == .status, pendingAction == nil { pendingAction = action; render() }
            return
        }
        currentAction = action
        if action != .status { lastError = nil }
        render()
        controller.perform(action) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                self.currentAction = nil; self.checkedAt = Date()
                switch result {
                case .success(let status): self.status = status; self.lastError = nil
                case .failure(let error): self.lastError = error.message
                }
                if self.quitAfterAction { NSApp.terminate(nil); return }
                if let pending = self.pendingAction { self.pendingAction = nil; self.request(pending) }
                else { self.render() }
            }
        }
    }
    private static func relative(_ milliseconds: Double?) -> String {
        guard let milliseconds, milliseconds.isFinite, milliseconds > 0,
              milliseconds < 253_402_300_800_000 else { return "not reported" }
        let seconds = max(0, Int((Date().timeIntervalSince1970 * 1000 - milliseconds) / 1000))
        if seconds < 5 { return "just now" }
        if seconds < 60 { return "\(seconds)s ago" }
        if seconds < 3_600 { return "\(seconds / 60)m ago" }
        if seconds < 86_400 { return "\(seconds / 3_600)h ago" }
        return "\(seconds / 86_400)d ago"
    }
    private func render() {
        guard statusItem != nil else { return }
        let action = pendingAction ?? currentAction
        let changing = action != nil && action != .status && action != .open
        let state = lastError != nil ? BridgeState.error : (status?.state ?? .starting)
        let visibleState = action == .start || action == .restart ? "Starting" : action == .stop ? "Stopping" : state.rawValue
        stateRow.title = "Status: \(visibleState)"
        // control.cjs owns the fixed operator-message allowlist. No raw stderr,
        // task error, token URL, or remote/model content is ever displayed.
        detailRow.title = lastError ?? status?.message.map { String($0.prefix(200)) } ?? (status?.managed == true ? "Managed by macOS login startup" : "Bridge startup is not managed")
        endpointRow.title = "Control Center: \(status?.localEndpoint ?? "unavailable")"
        pidRow.title = status?.pid.map { "Bridge process: \($0)" } ?? "Bridge process: not running"
        mcpRow.title = status?.mcp.ready == true ? "MCP: local endpoint ready" : "MCP: local endpoint unavailable"
        mcpActivityRow.title = "Last MCP request: \(Self.relative(status?.mcp.lastCallAt))"
        if let tasks = status?.tasks {
            tasksRow.title = "Tasks: \(tasks.active) active · \(tasks.connected) connected · \(tasks.total) total"
            let submenu = NSMenu()
            let labels = ["starting": "Starting", "thinking": "Thinking", "running_tool": "Running tool", "compacting": "Compacting", "approval_required": "Approval required", "blocked": "Blocked", "idle": "Idle", "completed": "Completed", "cancelled": "Cancelled", "error": "Error", "interrupted": "Interrupted"]
            var shown = 0
            for key in labels.keys.sorted() {
                if let count = tasks.counts[key], count > 0 {
                    submenu.addItem(NSMenuItem(title: "\(labels[key]!): \(count)", action: nil, keyEquivalent: "")); shown += 1
                }
            }
            let other = tasks.counts.filter { labels[$0.key] == nil }.values.reduce(0, +)
            if other > 0 { submenu.addItem(NSMenuItem(title: "Other: \(other)", action: nil, keyEquivalent: "")); shown += 1 }
            if shown == 0 { submenu.addItem(NSMenuItem(title: "No saved tasks", action: nil, keyEquivalent: "")) }
            taskStatesRow.submenu = submenu
        } else { tasksRow.title = "Tasks: unavailable"; taskStatesRow.submenu = nil }
        activityRow.title = "Last activity: \(Self.relative(status?.lastActivityAt))"
        heartbeatRow.title = "Last heartbeat: \(Self.relative(status?.lastHeartbeatAt))"
        checkedRow.title = "Last checked: \(Self.relative(checkedAt.map { $0.timeIntervalSince1970 * 1000 }))"
        let color: NSColor = changing || state == .starting ? .systemOrange : state == .connected ? .systemGreen : state == .error ? .systemRed : .secondaryLabelColor
        if let dot = NSImage(systemSymbolName: "circle.fill", accessibilityDescription: visibleState) {
            let config = NSImage.SymbolConfiguration(pointSize: 7, weight: .regular).applying(.init(paletteColors: [color]))
            statusItem.button?.image = dot.withSymbolConfiguration(config)
            statusItem.button?.imagePosition = .imageLeading
        }
        statusItem.button?.toolTip = "\(platformName) — \(visibleState)"
        statusItem.button?.setAccessibilityValue(visibleState)
        let busy = quitAfterAction || (action != nil && action != .status)
        quitItem.isEnabled = !quitAfterAction
        if quitAfterAction { detailRow.title = "Quitting after the current control request finishes…" }
        openItem.isEnabled = !busy
        startItem.isEnabled = !busy && state != .connected && state != .starting
        restartItem.isEnabled = !busy && status?.pid != nil
        stopItem.isEnabled = !busy && status?.pid != nil
    }
    @objc private func openCenter() { request(.open) }
    @objc private func startBridge() { request(.start) }
    @objc private func restartBridge() { request(.restart) }
    @objc private func stopBridge() { request(.stop) }
    @objc private func quitHelper() {
        if currentAction != nil {
            quitAfterAction = true; pendingAction = nil; render()
        } else { NSApp.terminate(nil) }
    }
    func applicationWillTerminate(_ notification: Notification) {
        timer?.invalidate(); Darwin.close(helperLock)
        // Quit only this helper; leave the bridge and its LaunchAgent alone.
    }
}
private func acquirePrivateLock(_ directory: String, name: String) -> Int32? {
    var directoryInfo = stat()
    guard Darwin.lstat(directory, &directoryInfo) == 0, directoryInfo.st_mode & S_IFMT == S_IFDIR,
          directoryInfo.st_uid == getuid(), directoryInfo.st_mode & 0o077 == 0 else { return nil }
    let fd = Darwin.open(directory + "/" + name, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard fd >= 0 else { return nil }
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG,
          info.st_uid == getuid(), info.st_mode & 0o077 == 0,
          flock(fd, LOCK_EX | LOCK_NB) == 0 else { Darwin.close(fd); return nil }
    // A persistent file is safe: closing the descriptor releases flock.
    return fd
}
private func openControlCenter(_ directory: String) -> Int32 {
    // Open the private file without following a symlink. Tokens stay in memory
    // and go directly to Launch Services, never shell arguments or logs.
    let fd = Darwin.open(directory + "/ui.json", O_RDONLY | O_NOFOLLOW)
    guard fd >= 0 else { return 1 }
    var info = stat()
    guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(),
          info.st_mode & 0o077 == 0, info.st_size > 0, info.st_size <= 16_384 else { Darwin.close(fd); return 1 }
    let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    let data: Data
    do { data = try handle.readToEnd() ?? Data(); try handle.close() } catch { return 1 }
    guard let record = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let rawURL = record["url"] as? String, let url = URLComponents(string: rawURL),
          let port = record["port"] as? Int, port > 0, port <= 65535,
          url.scheme == "http", url.host == "127.0.0.1", url.port == port,
          url.user == nil, url.password == nil, url.query == nil, url.path == "/",
          let fragment = url.fragment, fragment.count == 70, fragment.range(of: "^token=[a-f0-9]{64}$", options: .regularExpression) != nil,
          let safeURL = URL(string: "http://127.0.0.1:\(port)/#\(fragment)") else { return 1 }
    return NSWorkspace.shared.open(safeURL) ? 0 : 1
}
private func main() -> Int32 {
    let configuration: Configuration
    do { configuration = try Configuration() }
    catch { fputs("Airodrom helper configuration is unavailable.\n", stderr); return 1 }
    let controller = Controller(configuration: configuration), arguments = CommandLine.arguments
    if arguments.count == 2 && arguments[1] == "--open-control-center" { return openControlCenter(configuration.dataDirectory) }
    if arguments.count > 1 {
        guard arguments.count == 3, arguments[1] == "--action", let action = ControlAction(rawValue: arguments[2]) else {
            fputs("Usage: PiBridgeMenu [--action status|start|stop|restart|open]\n", stderr); return 2
        }
        let done = DispatchSemaphore(value: 0)
        var exitCode: Int32 = 1
        controller.perform(action) { result in
            switch result {
            case .success(let status):
                if let data = try? JSONEncoder().encode(status) {
                    FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([0x0a]))
                    exitCode = status.state == .error ? 1 : 0
                }
            case .failure(let error):
                if let data = try? JSONSerialization.data(withJSONObject: ["state": "Error", "message": error.message]) {
                    FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([0x0a]))
                }
            }
            done.signal()
        }
        done.wait(); return exitCode
    }
    guard let lock = acquirePrivateLock(configuration.dataDirectory, name: "menu.lock") else {
        fputs("Airodrom helper is already running or its private lock is unavailable.\n", stderr); return 0
    }
    let app = NSApplication.shared, delegate = MenuApplication(controller: controller, helperLock: lock)
    app.delegate = delegate
    withExtendedLifetime(delegate) { app.run() }
    return 0
}
Darwin.exit(main())
