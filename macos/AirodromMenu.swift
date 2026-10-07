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
    struct Product: Codable {
        struct Mission: Codable { let id: String?; let label: String; let state: String; let phase: String; let progress: String }
        let model: String?; let routing: String?; let connectors: String?; let control: String?; let status: String; let runtime: String; let runtimeReason: String?; let memory: String; let provider: String
        let approvals: Int?; let mission: Mission?; let diagnostic: String
        let quarantined_leases: Int?
    }
    let product: Product?
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
private enum ControlAction: String { case status, start, stop, restart, open, cli, doctor, requalify; case openMission = "open-mission", cancelMission = "cancel-mission" }
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
    let localHome: String?
    init() throws {
        let info = Bundle.main.infoDictionary ?? [:]
        guard let node = info["AirodromNode"] as? String,
              let control = info["AirodromControl"] as? String,
              let directory = info["AirodromDataDir"] as? String,
              [node, control, directory].allSatisfy({ $0.hasPrefix("/") }),
              FileManager.default.isExecutableFile(atPath: node),
              FileManager.default.isReadableFile(atPath: control) else { throw HelperError.configuration }
        self.node = node; self.control = control; self.dataDirectory = directory
        self.localHome = info["AirodromHome"] as? String
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
    func perform(_ action: ControlAction, missionId: String? = nil, completion: @escaping (Result<BridgeStatus, HelperError>) -> Void) {
        DispatchQueue.global(qos: .utility).async { [configuration] in
            let mutation = action == .start || action == .stop || action == .restart || action == .requalify
            let controlLock = mutation ? acquirePrivateLock(configuration.dataDirectory, name: "macos-control.lock") : nil
            if mutation && controlLock == nil { completion(.failure(.busy)); return }
            defer { if let controlLock { Darwin.close(controlLock) } }
            let invocation = Invocation(), output = Pipe()
            let process = invocation.process
            process.executableURL = URL(fileURLWithPath: configuration.node)
            process.arguments = [configuration.control, action.rawValue, "--control-locked"]
            if action == .openMission || action == .cancelMission {
                guard let missionId, UUID(uuidString: missionId) != nil else { completion(.failure(.response)); return }
                process.arguments?.append(missionId)
            }
            process.currentDirectoryURL = URL(fileURLWithPath: configuration.control).deletingLastPathComponent()
            process.environment = ["HOME": NSHomeDirectory(), "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8"]
            if let home = configuration.localHome { process.environment?["AIRODROM_HOME"] = home }
            process.standardOutput = output
            process.standardError = FileHandle.nullDevice
            process.standardInput = FileHandle.nullDevice
            do { try process.run() } catch { completion(.failure(.command)); return }
            let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
            timer.schedule(deadline: .now() + ([ControlAction.start, .restart, .requalify].contains(action) ? 160 : 25))
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
private func brandImage() -> NSImage {
    let polygons: [[CGPoint]] = [[CGPoint(x: 12.000, y: 223.348),CGPoint(x: 106.431, y: 32.652),CGPoint(x: 152.323, y: 136.423),CGPoint(x: 162.203, y: 136.423),CGPoint(x: 131.860, y: 70.607),CGPoint(x: 149.893, y: 32.706),CGPoint(x: 244.000, y: 223.348),CGPoint(x: 180.020, y: 223.348),CGPoint(x: 163.175, y: 189.334),CGPoint(x: 92.825, y: 189.334),CGPoint(x: 76.465, y: 223.348),CGPoint(x: 12.000, y: 223.348)],[CGPoint(x: 150.109, y: 62.617),CGPoint(x: 145.304, y: 72.281),CGPoint(x: 182.234, y: 148.301),CGPoint(x: 97.738, y: 148.301),CGPoint(x: 121.386, y: 99.709),CGPoint(x: 105.837, y: 62.509),CGPoint(x: 33.057, y: 210.930),CGPoint(x: 42.667, y: 210.930),CGPoint(x: 106.970, y: 81.352),CGPoint(x: 113.395, y: 97.225),CGPoint(x: 84.294, y: 156.399),CGPoint(x: 186.121, y: 156.399),CGPoint(x: 213.171, y: 210.930),CGPoint(x: 223.429, y: 210.930),CGPoint(x: 150.109, y: 62.617)],[CGPoint(x: 128.459, y: 113.692),CGPoint(x: 118.147, y: 136.423),CGPoint(x: 139.095, y: 136.423),CGPoint(x: 128.459, y: 113.692)],[CGPoint(x: 78.355, y: 168.817),CGPoint(x: 57.677, y: 210.930),CGPoint(x: 68.043, y: 210.930),CGPoint(x: 84.834, y: 176.916),CGPoint(x: 171.760, y: 176.916),CGPoint(x: 188.389, y: 210.930),CGPoint(x: 198.701, y: 210.930),CGPoint(x: 178.023, y: 168.817),CGPoint(x: 78.355, y: 168.817)]]
    let image = NSImage(size: NSSize(width: 20, height: 20), flipped: false) { rect in
        NSColor.black.setFill()
        let path = NSBezierPath(); path.windingRule = .evenOdd
        for polygon in polygons {
            for (index, point) in polygon.enumerated() {
                let p = CGPoint(x: point.x / 256 * rect.width, y: (256 - point.y) / 256 * rect.height)
                if index == 0 { path.move(to: p) } else { path.line(to: p) }
            }
            path.close()
        }
        path.fill(); return true
    }
    image.isTemplate = true
    image.accessibilityDescription = "Airodrom connected A mark"
    return image
}
private final class MenuApplication: NSObject, NSApplicationDelegate {
    private let controller: Controller
    private let helperLock: Int32
    private var statusItem: NSStatusItem!
    private let menu = NSMenu()
    private let stateRow = NSMenuItem(title: "Status: Waiting", action: nil, keyEquivalent: "")
    private let modelRow = NSMenuItem(title: "Model: Unavailable", action: nil, keyEquivalent: "")
    private let connectorsRow = NSMenuItem(title: "Connectors: Unavailable", action: nil, keyEquivalent: "")
    private let runtimeRow = NSMenuItem(title: "OpenCode: Unavailable · Primary", action: nil, keyEquivalent: "")
    private let memoryRow = NSMenuItem(title: "Memory V2: Unavailable · Local", action: nil, keyEquivalent: "")
    private let missionRow = NSMenuItem(title: "Active Mission: none observed", action: nil, keyEquivalent: "")
    private let approvalsRow = NSMenuItem(title: "Approvals: unavailable", action: nil, keyEquivalent: "")
    private let detailRow = NSMenuItem(title: "Checking local observations…", action: nil, keyEquivalent: "")
    private var startItem: NSMenuItem!, stopItem: NSMenuItem!, restartItem: NSMenuItem!, openItem: NSMenuItem!, qualifyItem: NSMenuItem!
    private var cliItem: NSMenuItem!, doctorItem: NSMenuItem!, copyItem: NSMenuItem!
    private var openMissionItem: NSMenuItem!, cancelMissionItem: NSMenuItem!
    private var timer: Timer?, status: BridgeStatus?, currentAction: ControlAction?
    private var checkedAt: Date?, lastError: String?, failures = 0
    private var quitAfterAction = false
    init(controller: Controller, helperLock: Int32) { self.controller = controller; self.helperLock = helperLock; super.init() }
    func inspectMenu(_ value: BridgeStatus) -> [String: Any] {
        // Native fixture inspection renders the actual menu, without activating
        // a window or executing an item. The process exits after its snapshot.
        applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        status = value; currentAction = nil; render()
        func entries(_ source: NSMenu) -> [[String: Any]] {
            source.items.filter { !$0.isSeparatorItem }.map { item in
                var row: [String: Any] = ["title": item.title, "enabled": item.isEnabled, "key": item.keyEquivalent]
                if let sub = item.submenu { row["items"] = entries(sub) }
                return row
            }
        }
        return ["template_icon": statusItem.button?.image?.isTemplate == true, "items": entries(menu)]
    }
    private func item(_ title: String, _ selector: Selector, in target: NSMenu, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: selector, keyEquivalent: key); item.target = self; target.addItem(item); return item
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = brandImage(); statusItem.button?.setAccessibilityLabel("Airodrom")
        statusItem.menu = menu; menu.autoenablesItems = false
        menu.addItem(NSMenuItem(title: "AIRODROM · PRE-RELEASE", action: nil, keyEquivalent: ""))
        [stateRow, runtimeRow, modelRow, memoryRow, connectorsRow].forEach { menu.addItem($0) }; menu.addItem(.separator())
        openItem = item("Open Control Center", #selector(openCenter), in: menu, key: "o")
        cliItem = item("New Mission / Open CLI", #selector(openCLI), in: menu)
        menu.addItem(.separator()); menu.addItem(missionRow); menu.addItem(approvalsRow)
        openMissionItem = item("Open Mission", #selector(openMission), in: menu)
        cancelMissionItem = item("Cancel Mission", #selector(cancelMission), in: menu)
        _ = item("Review Missions & Approvals", #selector(openCenter), in: menu)
        menu.addItem(.separator())
        let health = NSMenu(); health.autoenablesItems = false
        ["Control Plane", "OpenCode", "Memory V2", "Local provider"].forEach { health.addItem(NSMenuItem(title: $0 + ": unavailable", action: nil, keyEquivalent: "")) }
        let healthRow = NSMenuItem(title: "System Health", action: nil, keyEquivalent: ""); healthRow.submenu = health; menu.addItem(healthRow)
        let diagnostics = NSMenu(); diagnostics.autoenablesItems = false
        doctorItem = item("Run Doctor", #selector(runDoctor), in: diagnostics)
        qualifyItem = item("Requalify OpenCode (service must be stopped)", #selector(requalifyRuntime), in: diagnostics)
        copyItem = item("Copy Safe Diagnostic Summary", #selector(copyDiagnostic), in: diagnostics)
        let diagnosticsRow = NSMenuItem(title: "Diagnostics", action: nil, keyEquivalent: ""); diagnosticsRow.submenu = diagnostics; menu.addItem(diagnosticsRow)
        let service = NSMenu(); service.autoenablesItems = false
        startItem = item("Start Service", #selector(startBridge), in: service)
        stopItem = item("Stop Service", #selector(stopBridge), in: service)
        restartItem = item("Restart Service", #selector(restartBridge), in: service)
        service.addItem(NSMenuItem(title: "Launch at Login: managed by optional macOS installer", action: nil, keyEquivalent: ""))
        let serviceRow = NSMenuItem(title: "Service", action: nil, keyEquivalent: ""); serviceRow.submenu = service; menu.addItem(serviceRow)
        menu.addItem(.separator()); menu.addItem(detailRow)
        _ = item("Help / Documentation", #selector(documentation), in: menu)
        _ = item("About Airodrom", #selector(about), in: menu)
        _ = item("Quit Menu Bar (service stays running)", #selector(quitHelper), in: menu, key: "q")
        request(.status)
        timer = Timer(timeInterval: 5, repeats: true) { [weak self] _ in
            guard let self, self.currentAction == nil else { return }
            self.request(.status)
        }
        if let timer { RunLoop.main.add(timer, forMode: .common) }
    }
    private func request(_ action: ControlAction) {
        guard currentAction == nil, !quitAfterAction else { return }
        currentAction = action; render()
        controller.perform(action, missionId: status?.product?.mission?.id) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }; self.currentAction = nil; self.checkedAt = Date()
                switch result {
                case .success(let value): self.status = value; self.lastError = nil; self.failures = 0
                case .failure(let error): self.status = nil; self.lastError = error.message; self.failures += 1
                }
                self.render()
                if self.quitAfterAction { NSApp.terminate(nil); return }
                if action == .doctor { self.show("Airodrom Doctor", self.status?.product?.diagnostic ?? "Safe diagnostics unavailable.") }
            }
        }
    }
    private func render() {
        let changing = currentAction != nil && currentAction != .status
        let p = status?.product, state = status?.state
        let visible = changing ? "Waiting" : p?.status ?? "Unavailable"
        stateRow.title = "Status: " + visible
        modelRow.title = "Model: " + (p?.model ?? "Unavailable") + " · " + (p?.routing ?? "Unavailable")
        connectorsRow.title = "Connectors: " + (p?.connectors ?? "Unavailable")
        runtimeRow.title = "OpenCode: " + (p?.runtime ?? "Unavailable") + " · Primary"
        if p?.runtimeReason == "opencode_runtime_pins_changed" { runtimeRow.title += " · Requalification required" }
        memoryRow.title = "Memory V2: " + (p?.memory ?? "Unavailable") + " · Local"
        missionRow.title = p?.mission.map { $0.label + " · " + $0.phase } ?? "Active Mission: none observed"
        approvalsRow.title = p?.approvals.map { "Approvals: " + String($0) + " waiting" } ?? "Approvals: unavailable"
        statusItem.button?.title = (p?.approvals ?? 0) > 0 ? String(p!.approvals!) : ""
        statusItem.button?.toolTip = "Airodrom — " + visible + ". " + approvalsRow.title
        statusItem.button?.setAccessibilityValue(visible + ". " + approvalsRow.title)
        detailRow.title = lastError ?? (checkedAt == nil ? "Checking local observations…" : "Local observations checked just now")
        let available = currentAction == nil
        startItem.isEnabled = available && state == .stopped
        stopItem.isEnabled = available && state == .connected && status?.managed == true && status?.tasks.active == 0 && (p?.quarantined_leases ?? 0) == 0
        restartItem.isEnabled = stopItem.isEnabled
        openItem.isEnabled = available && state == .connected
        cliItem.isEnabled = available && controller.configuration.localHome != nil
        doctorItem.isEnabled = available && status?.product != nil
        qualifyItem.isEnabled = available && state == .stopped && controller.configuration.localHome != nil
        copyItem.isEnabled = available && p != nil
        openMissionItem.isEnabled = available && p?.mission?.id != nil && controller.configuration.localHome != nil
        cancelMissionItem.isEnabled = openMissionItem.isEnabled && ["dispatching", "running", "verifying", "awaiting_acceptance", "waiting_for_operator"].contains(p?.mission?.state ?? "")
        if let health = menu.items.first(where: { $0.title == "System Health" })?.submenu {
            let values = [p?.control, p?.runtime, p?.memory, p?.provider]
            for (index, item) in health.items.enumerated() { item.title = ["Control Plane", "OpenCode", "Memory V2", "Local provider"][index] + ": " + (values[index] ?? "Unavailable") }
        }
    }
    private func show(_ title: String, _ message: String) { let alert = NSAlert(); alert.messageText = title; alert.informativeText = message; alert.runModal() }
    @objc private func openCenter() { request(.open) }
    @objc private func openCLI() { request(.cli) }
    @objc private func openMission() { request(.openMission) }
    @objc private func cancelMission() { request(.cancelMission) }
    @objc private func runDoctor() { request(.doctor) }
    @objc private func requalifyRuntime() { request(.requalify) }
    @objc private func startBridge() { request(.start) }
    @objc private func restartBridge() { request(.restart) }
    @objc private func stopBridge() { request(.stop) }
    @objc private func copyDiagnostic() { guard let text = status?.product?.diagnostic else { return }; NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string) }
    @objc private func documentation() { if let url = URL(string: "https://github.com/airodrom/airodrom#readme") { NSWorkspace.shared.open(url) } }
    @objc private func about() { show("AIRODROM", "AI operating platform\n\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "Version unavailable") · PRE-RELEASE\nOpenCode executes. Airodrom governs.\nLocal Memory V2 · independent verification · Acceptance · Settlement") }
    @objc private func quitHelper() { if currentAction != nil { quitAfterAction = true } else { NSApp.terminate(nil) } }
    func applicationWillTerminate(_ notification: Notification) { timer?.invalidate(); Darwin.close(helperLock) }
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
        let inspecting = arguments.count == 2 && arguments[1] == "--inspect-menu"
        guard inspecting || (arguments.count == 3 && arguments[1] == "--action" && ControlAction(rawValue: arguments[2]) != nil) else {
            fputs("Usage: AirodromMenu [--action status|start|stop|restart|open|cli|doctor|requalify]\n", stderr); return 2
        }
        let action = inspecting ? ControlAction.status : ControlAction(rawValue: arguments[2])!
        let done = DispatchSemaphore(value: 0)
        var exitCode: Int32 = 1
        controller.perform(action) { result in
            switch result {
            case .success(let status):
                if inspecting {
                    DispatchQueue.main.async {
                        let delegate = MenuApplication(controller: controller, helperLock: -1)
                        if let data = try? JSONSerialization.data(withJSONObject: delegate.inspectMenu(status)) {
                            FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([0x0a])); Darwin.exit(0)
                        }
                        Darwin.exit(1)
                    }
                    return
                } else if let data = try? JSONEncoder().encode(status) {
                    FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([0x0a]))
                    exitCode = status.state == .error ? 1 : 0
                }
            case .failure(let error):
                if let data = try? JSONSerialization.data(withJSONObject: ["state": "Error", "message": error.message]) {
                    FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([0x0a]))
                }
            }
            if inspecting { Darwin.exit(exitCode) }
            done.signal()
        }
        if inspecting { NSApplication.shared.setActivationPolicy(.accessory); NSApplication.shared.run() }
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
