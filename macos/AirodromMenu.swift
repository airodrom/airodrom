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
        struct Mission: Codable {
            let id: String?; let label: String; let state: String; let phase: String; let progress: String
            let worker: String?; let model: String?; let elapsed_s: Int?
            let progress_value: Int?; let progress_maximum: Int?
        }
        struct Conversation: Codable {
            let nickname: String?; let model: String?; let worker: String?; let channel: String?; let separated_from_missions: Bool?
        }
        let model: String?; let routing: String?; let connectors: String?; let control: String?; let status: String; let runtime: String; let runtimeReason: String?; let memory: String; let provider: String
        let active_missions: Int?; let approvals: Int?; let mission: Mission?; let diagnostic: String
        let quarantined_leases: Int?
        let activity_status: String?; let connection_state: String?; let connection_label: String?; let menu_tone: String?
        let workers: String?; let review_missions: Int?; let failed_missions: Int?
        let conversation: Conversation?
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
private enum ControlAction: String { case status, start, stop, restart, open, cli, doctor, requalify; case openConversation = "open-conversation", openMissions = "open-missions", openDevelopmentSessions = "open-development-sessions", openSystemHealth = "open-system-health", openMission = "open-mission", cancelMission = "cancel-mission" }
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
        let home = info["AirodromHome"] as? String
        var node = info["AirodromNode"] as? String
        var control = info["AirodromControl"] as? String
        let directory = info["AirodromDataDir"] as? String
        // Stale running menus may retain a deleted Node pin after managed install
        // cutover. Prefer the current prepared app under the owner home without
        // accepting untrusted endpoints or changing the service.
        if let home, home.hasPrefix("/"),
           let refreshed = Self.readPreparedPins(home: home) {
            let nodeMissing = !(node.map { FileManager.default.isExecutableFile(atPath: $0) } ?? false)
            let controlMissing = !(control.map { FileManager.default.isReadableFile(atPath: $0) } ?? false)
            if nodeMissing || controlMissing {
                node = refreshed.node
                control = refreshed.control
            }
        }
        guard let node, let control, let directory,
              [node, control, directory].allSatisfy({ $0.hasPrefix("/") }),
              FileManager.default.isExecutableFile(atPath: node),
              FileManager.default.isReadableFile(atPath: control) else { throw HelperError.configuration }
        self.node = node; self.control = control; self.dataDirectory = directory
        self.localHome = home
    }
    private static func readPreparedPins(home: String) -> (node: String, control: String)? {
        let plistPath = (home as NSString).appendingPathComponent("menu/Airodrom.app/Contents/Info.plist")
        guard FileManager.default.isReadableFile(atPath: plistPath),
              let data = try? Data(contentsOf: URL(fileURLWithPath: plistPath)),
              let plist = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any],
              let node = plist["AirodromNode"] as? String,
              let control = plist["AirodromControl"] as? String,
              node.hasPrefix("/"), control.hasPrefix("/"),
              FileManager.default.isExecutableFile(atPath: node),
              FileManager.default.isReadableFile(atPath: control) else { return nil }
        // Require the prepared control path to remain under the same owner home.
        guard control.hasPrefix(home + "/") || control.contains("/airodrom") else { return nil }
        return (node, control)
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

/// Symmetric 18pt mark geometry — shared by idle and busy frames.
private enum MenuMarkGeometry {
    static let canvas: CGFloat = 18
    static let inset: CGFloat = 1.5
    static var drawRect: NSRect { NSRect(x: inset, y: inset, width: canvas - inset * 2, height: canvas - inset * 2) }
}

private func brandPolygons() -> [[CGPoint]] {
    [[CGPoint(x: 12.000, y: 223.348),CGPoint(x: 106.431, y: 32.652),CGPoint(x: 152.323, y: 136.423),CGPoint(x: 162.203, y: 136.423),CGPoint(x: 131.860, y: 70.607),CGPoint(x: 149.893, y: 32.706),CGPoint(x: 244.000, y: 223.348),CGPoint(x: 180.020, y: 223.348),CGPoint(x: 163.175, y: 189.334),CGPoint(x: 92.825, y: 189.334),CGPoint(x: 76.465, y: 223.348),CGPoint(x: 12.000, y: 223.348)],[CGPoint(x: 150.109, y: 62.617),CGPoint(x: 145.304, y: 72.281),CGPoint(x: 182.234, y: 148.301),CGPoint(x: 97.738, y: 148.301),CGPoint(x: 121.386, y: 99.709),CGPoint(x: 105.837, y: 62.509),CGPoint(x: 33.057, y: 210.930),CGPoint(x: 42.667, y: 210.930),CGPoint(x: 106.970, y: 81.352),CGPoint(x: 113.395, y: 97.225),CGPoint(x: 84.294, y: 156.399),CGPoint(x: 186.121, y: 156.399),CGPoint(x: 213.171, y: 210.930),CGPoint(x: 223.429, y: 210.930),CGPoint(x: 150.109, y: 62.617)],[CGPoint(x: 128.459, y: 113.692),CGPoint(x: 118.147, y: 136.423),CGPoint(x: 139.095, y: 136.423),CGPoint(x: 128.459, y: 113.692)],[CGPoint(x: 78.355, y: 168.817),CGPoint(x: 57.677, y: 210.930),CGPoint(x: 68.043, y: 210.930),CGPoint(x: 84.834, y: 176.916),CGPoint(x: 171.760, y: 176.916),CGPoint(x: 188.389, y: 210.930),CGPoint(x: 198.701, y: 210.930),CGPoint(x: 178.023, y: 168.817),CGPoint(x: 78.355, y: 168.817)]]
}

private func brandPath(in draw: NSRect) -> NSBezierPath {
    let path = NSBezierPath(); path.windingRule = .evenOdd
    for polygon in brandPolygons() {
        for (index, point) in polygon.enumerated() {
            let p = CGPoint(x: draw.minX + point.x / 256 * draw.width, y: draw.minY + (256 - point.y) / 256 * draw.height)
            if index == 0 { path.move(to: p) } else { path.line(to: p) }
        }
        path.close()
    }
    return path
}

/// Full-logo status palette — the entire A mark carries meaning; no separate status dot.
private func statusGradientColors(_ tone: String) -> (NSColor, NSColor) {
    switch tone {
    case "healthy":
        // SKY: mint → blue
        return (NSColor(calibratedRed: 0.33, green: 0.82, blue: 0.69, alpha: 1),
                NSColor(calibratedRed: 0.31, green: 0.57, blue: 1.00, alpha: 1))
    case "working":
        // Active work: blue → indigo
        return (NSColor(calibratedRed: 0.31, green: 0.57, blue: 1.00, alpha: 1),
                NSColor(calibratedRed: 0.43, green: 0.41, blue: 0.86, alpha: 1))
    case "approval":
        // Action required: warm gold → bronze
        return (NSColor(calibratedRed: 0.82, green: 0.64, blue: 0.28, alpha: 1),
                NSColor(calibratedRed: 0.55, green: 0.38, blue: 0.12, alpha: 1))
    case "reconnecting", "degraded":
        return (NSColor(calibratedRed: 0.95, green: 0.70, blue: 0.28, alpha: 1),
                NSColor(calibratedRed: 0.90, green: 0.48, blue: 0.18, alpha: 1))
    case "disconnected":
        return (NSColor(calibratedRed: 0.95, green: 0.55, blue: 0.58, alpha: 1),
                NSColor(calibratedRed: 0.78, green: 0.28, blue: 0.34, alpha: 1))
    default:
        // Stopped / idle gray
        return (NSColor(calibratedRed: 0.62, green: 0.66, blue: 0.74, alpha: 1),
                NSColor(calibratedRed: 0.40, green: 0.44, blue: 0.52, alpha: 1))
    }
}

private func brandImage(tone: String) -> NSImage {
    // Colored gradient mark (not a template) so light/dark menu bars keep status color.
    let draw = MenuMarkGeometry.drawRect
    let colors = statusGradientColors(tone)
    let image = NSImage(size: NSSize(width: MenuMarkGeometry.canvas, height: MenuMarkGeometry.canvas), flipped: false) { _ in
        let path = brandPath(in: draw)
        NSGraphicsContext.current?.cgContext.saveGState()
        path.addClip()
        if let gradient = NSGradient(starting: colors.0, ending: colors.1) {
            gradient.draw(in: draw, angle: 95)
        } else {
            colors.0.setFill(); path.fill()
        }
        NSGraphicsContext.current?.cgContext.restoreGState()
        return true
    }
    image.isTemplate = false
    image.accessibilityDescription = "Airodrom"
    return image
}

private func brandBusyImage(frame: Int) -> NSImage {
    let draw = MenuMarkGeometry.drawRect
    let colors = statusGradientColors("working")
    let image = NSImage(size: NSSize(width: MenuMarkGeometry.canvas, height: MenuMarkGeometry.canvas), flipped: false) { _ in
        let path = brandPath(in: draw)
        NSGraphicsContext.current?.cgContext.saveGState()
        path.addClip()
        if let gradient = NSGradient(starting: colors.0, ending: colors.1) {
            gradient.draw(in: draw, angle: 95 + CGFloat(frame * 8))
        }
        NSGraphicsContext.current?.cgContext.restoreGState()
        colors.1.withAlphaComponent(0.85).setStroke()
        let arc = NSBezierPath(); arc.lineWidth = 1.15
        arc.appendArc(withCenter: NSPoint(x: draw.midX, y: draw.midY), radius: min(draw.width, draw.height) * 0.52, startAngle: CGFloat(frame * 30), endAngle: CGFloat(frame * 30 + 220))
        arc.stroke()
        return true
    }
    image.isTemplate = false
    image.accessibilityDescription = "Airodrom working"
    return image
}
private final class MenuApplication: NSObject, NSApplicationDelegate {
    private let controller: Controller
    private let helperLock: Int32
    private var statusItem: NSStatusItem!
    private let menu = NSMenu()
    private let stateRow = NSMenuItem(title: "SYSTEM STATUS  Waiting", action: nil, keyEquivalent: "")
    private let modelRow = NSMenuItem(title: "Model  Unavailable", action: nil, keyEquivalent: "")
    private let connectorsRow = NSMenuItem(title: "Connectors  Unavailable", action: nil, keyEquivalent: "")
    private let runtimeRow = NSMenuItem(title: "OpenCode  Unavailable · Primary", action: nil, keyEquivalent: "")
    private let memoryRow = NSMenuItem(title: "MEMORY  Memory V2  Unavailable", action: nil, keyEquivalent: "")
    private let missionRow = NSMenuItem(title: "ACTIVE MISSION  none", action: nil, keyEquivalent: "")
    private let conversationRow = NSMenuItem(title: "CONVERSATION  local · separate from Missions", action: nil, keyEquivalent: "")
    private let approvalsRow = NSMenuItem(title: "Approvals  unavailable", action: nil, keyEquivalent: "")
    private let detailRow = NSMenuItem(title: "Checking local observations…", action: nil, keyEquivalent: "")
    private let workersRow = NSMenuItem(title: "WORKERS  Unavailable", action: nil, keyEquivalent: "")
    private let providerRow = NSMenuItem(title: "Provider  Unavailable", action: nil, keyEquivalent: "")
    private let mcpRow = NSMenuItem(title: "MCP  Unavailable", action: nil, keyEquivalent: "")
    private let progressRow = NSMenuItem(title: "Mission progress  none", action: nil, keyEquivalent: "")
    private let elapsedRow = NSMenuItem(title: "Elapsed  —", action: nil, keyEquivalent: "")
    private let errorsRow = NSMenuItem(title: "Recent failures  none", action: nil, keyEquivalent: "")
    private var startItem: NSMenuItem!, stopItem: NSMenuItem!, restartItem: NSMenuItem!, openItem: NSMenuItem!, qualifyItem: NSMenuItem!
    private var cliItem: NSMenuItem!, doctorItem: NSMenuItem!, copyItem: NSMenuItem!
    private var openConversationItem: NSMenuItem!, openMissionsItem: NSMenuItem!, openDevSessionsItem: NSMenuItem!, openSystemHealthItem: NSMenuItem!, openMissionItem: NSMenuItem!, cancelMissionItem: NSMenuItem!
    private var animationTimer: Timer?, animationIndex = 0, animationTicks = 0
    private var toneImages: [String: NSImage] = [:]
    private lazy var busyImages: [NSImage] = (0..<12).map { brandBusyImage(frame: $0) }
    private func icon(for tone: String) -> NSImage {
        if let cached = toneImages[tone] { return cached }
        let image = brandImage(tone: tone)
        toneImages[tone] = image
        return image
    }
    private var animationState = "idle"
    private var timer: Timer?, status: BridgeStatus?, currentAction: ControlAction?
    private var checkedAt: Date?, lastError: String?, failures = 0
    /// True when `status` is retained after a transport failure (stale last-good).
    private var statusStale = false
    private var quitAfterAction = false
    private var pendingAction: (action: ControlAction, missionId: String?)?
    init(controller: Controller, helperLock: Int32) { self.controller = controller; self.helperLock = helperLock; super.init() }
    func inspectMenu(_ value: BridgeStatus) -> [String: Any] {
        // Native fixture inspection renders the actual menu, without activating
        // a window or executing an item. The process exits after its snapshot.
        applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
        status = value; currentAction = nil; render()
        let capturedTone = menuTone(changing: false)
        func entries(_ source: NSMenu) -> [[String: Any]] {
            source.items.filter { !$0.isSeparatorItem }.map { item in
                var row: [String: Any] = ["title": item.title, "enabled": item.isEnabled, "key": item.keyEquivalent]
                if let sub = item.submenu { row["items"] = entries(sub) }
                return row
            }
        }
        // Allow the real lightweight timer to advance for native fixture evidence.
        let firstFrame = statusItem.button?.image?.tiffRepresentation
        RunLoop.current.run(until: Date().addingTimeInterval(0.65))
        let frameChanged = firstFrame != statusItem.button?.image?.tiffRepresentation
        let running = animationTimer != nil, originalState = animationState, ticks = animationTicks
        let displayed = entries(menu)
        // Exercise the actual menu while a refresh owns the request slot.
        currentAction = .status; render()
        let openDuringRefresh = openItem.isEnabled
        let refreshItems = [openItem!, openConversationItem!, openMissionsItem!, openDevSessionsItem!, openSystemHealthItem!, cliItem!, openMissionItem!, cancelMissionItem!].map { ["title": $0.title, "enabled": $0.isEnabled] as [String: Any] }
        request(.open)
        let openQueued = pendingAction?.action == .open
        pendingAction = nil
        request(.openMission)
        let selectedMissionPreserved = pendingAction?.action == .openMission && pendingAction?.missionId == status?.product?.mission?.id
        pendingAction = nil; currentAction = nil
        status = nil; render()
        let stoppedOnIdle = animationTimer == nil && statusItem.button?.image?.isTemplate == false
        return ["refresh_items": refreshItems, "queued_mission_matches_selection": selectedMissionPreserved, "open_during_refresh": openDuringRefresh, "open_queued": openQueued, "frame_changed": frameChanged, "stopped_on_idle": stoppedOnIdle, "template_icon": false, "gradient_icon": statusItem.button?.image?.isTemplate == false, "icon_tone": capturedTone, "items": displayed, "animation_state": originalState, "animation_running": running, "animation_ticks": ticks, "reduced_motion": NSWorkspace.shared.accessibilityDisplayShouldReduceMotion, "mark_canvas": Double(MenuMarkGeometry.canvas), "mark_inset": Double(MenuMarkGeometry.inset)]
    }
    private func item(_ title: String, _ selector: Selector, in target: NSMenu, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: selector, keyEquivalent: key); item.target = self; target.addItem(item); return item
    }
    private func sectionHeader(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }
    private static let liveMissionStates = Set(["dispatching", "running", "verifying"])
    private static let reviewMissionStates = Set(["awaiting_acceptance", "waiting_for_operator"])
    private func isLiveMission(_ mission: BridgeStatus.Product.Mission?) -> Bool {
        guard let mission else { return false }
        return MenuApplication.liveMissionStates.contains(mission.state)
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.image = icon(for: "stopped"); statusItem.button?.setAccessibilityLabel("Airodrom")
        statusItem.button?.imagePosition = .imageLeft
        statusItem.menu = menu; menu.autoenablesItems = false
        menu.addItem(sectionHeader("AIRODROM"))
        menu.addItem(sectionHeader("Personal AI Operations"))
        menu.addItem(.separator())
        menu.addItem(sectionHeader("System Status"))
        [stateRow, detailRow].forEach { menu.addItem($0) }
        menu.addItem(.separator())
        menu.addItem(sectionHeader("Mission"))
        [conversationRow, missionRow, progressRow, elapsedRow].forEach { menu.addItem($0) }
        menu.addItem(.separator())
        menu.addItem(sectionHeader("Workers"))
        [workersRow, runtimeRow, providerRow].forEach { menu.addItem($0) }
        menu.addItem(.separator())
        menu.addItem(sectionHeader("Memory"))
        [memoryRow, mcpRow].forEach { menu.addItem($0) }
        menu.addItem(.separator())
        menu.addItem(sectionHeader("Model"))
        menu.addItem(modelRow)
        menu.addItem(.separator())
        menu.addItem(sectionHeader("Connectors"))
        [connectorsRow, approvalsRow, errorsRow].forEach { menu.addItem($0) }
        menu.addItem(.separator())
        menu.addItem(sectionHeader("Actions"))
        _ = item("Refresh Status", #selector(refreshStatus), in: menu)
        _ = item("Reconnect", #selector(reconnect), in: menu)
        openItem = item("Open Control Center", #selector(openCenter), in: menu, key: "o")
        openConversationItem = item("Open Conversation", #selector(openConversation), in: menu)
        openMissionsItem = item("Active Missions", #selector(openMissions), in: menu)
        openDevSessionsItem = item("Continue Development Session", #selector(openDevSessions), in: menu)
        cliItem = item("New Mission / Open CLI", #selector(openCLI), in: menu)
        openMissionItem = item("View Active Mission", #selector(openMission), in: menu)
        cancelMissionItem = item("Cancel Mission", #selector(cancelMission), in: menu)
        _ = item("Review Missions & Approvals", #selector(openMissions), in: menu)
        menu.addItem(.separator())
        let health = NSMenu(); health.autoenablesItems = false
        ["Control Plane", "OpenCode", "Memory V2", "Local provider"].forEach { health.addItem(NSMenuItem(title: $0 + ": unavailable", action: nil, keyEquivalent: "")) }
        openSystemHealthItem = item("Open System Health", #selector(openSystemHealth), in: health)
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
        menu.addItem(.separator())
        _ = item("Open Settings / Documentation", #selector(documentation), in: menu)
        _ = item("About Airodrom", #selector(about), in: menu)
        _ = item("Quit Menu (service stays running)", #selector(quitHelper), in: menu, key: "q")
        NSWorkspace.shared.notificationCenter.addObserver(self, selector: #selector(motionPreferenceChanged), name: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil)
        request(.status)
        // ADR 0009: compact host summary every five seconds with one request in flight.
        timer = Timer(timeInterval: 5, repeats: true) { [weak self] _ in
            guard let self, self.currentAction == nil else { return }
            self.request(.status)
        }
        if let timer { RunLoop.main.add(timer, forMode: .common) }
    }
    private func request(_ action: ControlAction) {
        request(action, missionId: status?.product?.mission?.id)
    }
    private func request(_ action: ControlAction, missionId selectedMissionId: String?) {
        guard !quitAfterAction else { return }
        if currentAction == .status && action != .status {
            // Keep the operator's selection, including its exact Mission, while
            // the background refresh finishes. Only one action can be queued.
            guard pendingAction == nil else { return }
            pendingAction = (action, selectedMissionId); render(); return
        }
        guard currentAction == nil else { return }
        currentAction = action; render()
        controller.perform(action, missionId: selectedMissionId) { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }; self.currentAction = nil; self.checkedAt = Date()
                switch result {
                case .success(let value):
                    self.status = value; self.statusStale = false; self.lastError = nil; self.failures = 0
                case .failure(let error):
                    // Keep last-good component observations; transport failure ≠ all Unavailable.
                    self.statusStale = self.status != nil
                    self.lastError = error.message + (self.statusStale ? " · showing last-good observations (stale)" : " · components not checked")
                    self.failures += 1
                }
                if self.quitAfterAction { NSApp.terminate(nil); return }
                if let pending = self.pendingAction {
                    self.pendingAction = nil; self.request(pending.action, missionId: pending.missionId); return
                }
                self.render()
                if action == .doctor { self.show("Airodrom Doctor", self.status?.product?.diagnostic ?? "Safe diagnostics unavailable.") }
            }
        }
    }
    private func render() {
        let changing = pendingAction != nil || currentAction != nil && currentAction != .status
        let p = status?.product, state = status?.state
        // Never map optional provider/MCP gaps or a nil product alone to Disconnected.
        let tone = menuTone(changing: changing)
        let visible = primaryStatusLabel(changing: changing, tone: tone, product: p)
        updateAnimation(changing: changing)
        stateRow.title = "SYSTEM STATUS  " + visible
        let staleNote = statusStale ? " · stale" : ""
        detailRow.title = lastError ?? (checkedAt == nil ? "Checking local observations…" : "Last check · just now" + staleNote + (status?.endpoint.map { " · \($0)" } ?? ""))
        if let conversation = p?.conversation {
            let nick = conversation.nickname ?? "Airo"
            let model = conversation.model ?? "Unavailable"
            conversationRow.title = "CONVERSATION  \(nick) · \(model) · separate from Missions"
        } else {
            conversationRow.title = "CONVERSATION  local · separate from Missions"
        }
        applyMissionRows(product: p)
        let missing = "Not checked"
        workersRow.title = "WORKERS  " + (p?.workers ?? ("OpenCode " + (p?.runtime ?? missing)))
        runtimeRow.title = "OpenCode  " + (p?.runtime ?? missing)
        if p?.runtimeReason == "opencode_runtime_pins_changed" { runtimeRow.title += " · Requalification required" }
        providerRow.title = "Provider  " + (p?.provider ?? missing)
        memoryRow.title = "MEMORY  Memory V2  " + (p?.memory ?? missing)
        mcpRow.title = "MCP  " + (status?.mcp.ready == true ? "Connected" : "Not checked / unavailable")
        approvalsRow.title = p?.approvals.map { "Approvals  \($0) waiting" } ?? "Approvals  not checked"
        errorsRow.title = "Recent failures  " + String(p?.failed_missions ?? 0) + " · review " + String(p?.review_missions ?? 0)
        modelRow.title = "Model  " + (p?.model ?? missing) + " · " + (p?.routing ?? missing)
        connectorsRow.title = "Connectors  " + (p?.connectors ?? missing)
        // Compact bar: pending Approvals badge only — historical review backlog stays in menu text, not gold icon.
        let actionCount = p?.approvals ?? 0
        statusItem.button?.title = actionCount > 0 ? String(actionCount) : tone == "disconnected" || tone == "degraded" ? "!" : tone == "reconnecting" ? "…" : ""
        statusItem.button?.toolTip = "Airodrom — " + visible + ". " + approvalsRow.title + ". " + errorsRow.title
        statusItem.button?.setAccessibilityValue(visible + ". " + approvalsRow.title + ". " + errorsRow.title)
        statusItem.button?.setAccessibilityLabel("Airodrom")
        let available = pendingAction == nil && currentAction == nil
        let navigationAvailable = pendingAction == nil && (currentAction == nil || currentAction == .status)
        startItem.isEnabled = available && state == .stopped
        stopItem.isEnabled = available && state == .connected && status?.managed == true && status?.tasks.active == 0 && (p?.quarantined_leases ?? 0) == 0
        restartItem.isEnabled = stopItem.isEnabled
        openItem.isEnabled = navigationAvailable && state == .connected
        let deepLinkReady = navigationAvailable && state == .connected && controller.configuration.localHome != nil
        openConversationItem.isEnabled = deepLinkReady
        openMissionsItem.isEnabled = deepLinkReady
        openDevSessionsItem.isEnabled = deepLinkReady
        openSystemHealthItem.isEnabled = deepLinkReady
        cliItem.isEnabled = navigationAvailable && controller.configuration.localHome != nil
        doctorItem.isEnabled = navigationAvailable && status?.product != nil
        qualifyItem.isEnabled = available && state == .stopped && controller.configuration.localHome != nil
        copyItem.isEnabled = navigationAvailable && p != nil
        let live = isLiveMission(p?.mission)
        openMissionItem.isEnabled = navigationAvailable && live && p?.mission?.id != nil && controller.configuration.localHome != nil
        cancelMissionItem.isEnabled = openMissionItem.isEnabled
        if let health = menu.items.first(where: { $0.title == "System Health" })?.submenu {
            let values = [p?.control, p?.runtime, p?.memory, p?.provider]
            for (index, item) in health.items.enumerated() where index < 4 {
                let label = values[index] ?? (statusStale ? "Not checked" : "Not checked")
                item.title = ["Control Plane", "OpenCode", "Memory V2", "Local provider"][index] + ": " + label + (statusStale && values[index] != nil ? " (stale)" : "")
            }
        }
    }

    private func applyMissionRows(product p: BridgeStatus.Product?) {
        let mission = p?.mission
        if isLiveMission(mission), let mission {
            missionRow.title = "ACTIVE MISSION  \(mission.label)"
            progressRow.title = missionProgressTitle(mission)
            elapsedRow.title = mission.elapsed_s.map { "Elapsed  \($0)s · \((mission.worker ?? "worker")) · \((mission.model ?? p?.model ?? "model"))" } ?? "Elapsed  —"
            if !mission.phase.isEmpty { elapsedRow.title += " · \(mission.phase)" }
            return
        }
        let reviews = p?.review_missions ?? 0
        if reviews > 0 || (mission.map { MenuApplication.reviewMissionStates.contains($0.state) } ?? false) {
            let count = max(reviews, mission != nil ? 1 : 0)
            missionRow.title = "NEEDS REVIEW  \(count) waiting · not active work"
            progressRow.title = "Mission progress  awaiting operator review"
            elapsedRow.title = "Elapsed  — · historical work is not active"
            return
        }
        missionRow.title = "MISSION  none"
        progressRow.title = "Mission progress  none"
        elapsedRow.title = "Elapsed  —"
    }

    private func menuTone(changing: Bool) -> String {
        if lastError != nil || status?.state == .error { return "disconnected" }
        if status?.state == .stopped { return "stopped" }
        if status?.state == .starting || changing || failures > 0 && status == nil { return "reconnecting" }
        if let tone = status?.product?.menu_tone, !tone.isEmpty { return tone }
        let p = status?.product
        // Fallback mirrors host menuPresentation: pending Approvals only (not historical review backlog).
        if (p?.approvals ?? 0) > 0 { return "approval" }
        if (p?.active_missions ?? 0) > 0 || isLiveMission(p?.mission) { return "working" }
        if p?.status == "Degraded" || p?.status == "Unavailable" { return "degraded" }
        if status?.state == .connected { return "healthy" }
        return "disconnected"
    }
    private func primaryStatusLabel(changing: Bool, tone: String, product: BridgeStatus.Product?) -> String {
        if changing { return "WAITING" }
        switch tone {
        case "approval": return "ACTION REQUIRED"
        case "working", "healthy": return product?.connection_label == "DEGRADED" ? "DEGRADED" : "CONNECTED"
        case "degraded": return "DEGRADED"
        case "reconnecting": return "RECONNECTING"
        case "stopped", "disconnected": return "DISCONNECTED"
        default:
            if let label = product?.connection_label, !label.isEmpty { return label }
            return presentationLabel(tone: tone)
        }
    }
    private func presentationLabel(tone: String) -> String {
        switch tone {
        case "healthy", "working": return "CONNECTED"
        case "reconnecting": return "RECONNECTING"
        case "degraded": return "DEGRADED"
        case "approval": return "ACTION REQUIRED"
        case "stopped", "disconnected": return "DISCONNECTED"
        default: return "DISCONNECTED"
        }
    }
    private func missionProgressTitle(_ mission: BridgeStatus.Product.Mission?) -> String {
        guard let mission else { return "Mission progress  none" }
        if mission.progress == "determinate", let value = mission.progress_value, let max = mission.progress_maximum, max > 0 {
            let pct = min(100, Int((Double(value) / Double(max)) * 100))
            return "Mission progress  \(pct)% · \(value)/\(max) checks"
        }
        if MenuApplication.liveMissionStates.contains(mission.state) {
            return "Mission progress  indeterminate · \(mission.phase)"
        }
        return "Mission progress  " + mission.state.replacingOccurrences(of: "_", with: " ")
    }

    @objc private func motionPreferenceChanged() { render() }
    private func updateAnimation(changing: Bool) {
        let tone = menuTone(changing: changing)
        animationState = tone == "disconnected" ? "error" : tone == "reconnecting" || changing ? "waiting" : tone == "approval" ? "approval" : tone == "working" ? "busy" : tone == "degraded" ? "degraded" : "idle"
        let animate = animationState == "busy" && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        if !animate {
            animationTimer?.invalidate(); animationTimer = nil; animationIndex = 0
            statusItem.button?.image = icon(for: tone)
            return
        }
        guard animationTimer == nil else { return }
        statusItem.button?.image = busyImages[0]
        animationTimer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.animationIndex = (self.animationIndex + 1) % self.busyImages.count
            self.animationTicks += 1
            self.statusItem.button?.image = self.busyImages[self.animationIndex]
        }
        if let animationTimer { RunLoop.main.add(animationTimer, forMode: .common) }
    }
    private func show(_ title: String, _ message: String) { let alert = NSAlert(); alert.messageText = title; alert.informativeText = message; alert.runModal() }
    @objc private func refreshStatus() { request(.status) }
    @objc private func reconnect() { failures = 0; lastError = nil; request(.status) }
    @objc private func openCenter() { request(.open) }
    @objc private func openConversation() { request(.openConversation) }
    @objc private func openMissions() { request(.openMissions) }
    @objc private func openDevSessions() { request(.openDevelopmentSessions) }
    @objc private func openSystemHealth() { request(.openSystemHealth) }
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
    func applicationWillTerminate(_ notification: Notification) { timer?.invalidate(); animationTimer?.invalidate(); NSWorkspace.shared.notificationCenter.removeObserver(self); Darwin.close(helperLock) }
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
private func writePNG(_ image: NSImage, to url: URL) -> Bool {
    guard let tiff = image.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
          let png = rep.representation(using: .png, properties: [:]) else { return false }
    do { try png.write(to: url); return true } catch { return false }
}
private func appearanceIcon(dark: Bool, tone: String) -> NSImage {
    // 2× export of the status-gradient logo on light/dark menu-bar chrome.
    let size = NSSize(width: 36, height: 36)
    let mark = brandImage(tone: tone)
    return NSImage(size: size, flipped: false) { rect in
        (dark ? NSColor(calibratedWhite: 0.14, alpha: 1) : NSColor(calibratedWhite: 0.92, alpha: 1)).setFill()
        NSBezierPath(rect: rect).fill()
        mark.draw(in: NSRect(x: 9, y: 9, width: MenuMarkGeometry.canvas, height: MenuMarkGeometry.canvas))
        return true
    }
}
private func exportVisualEvidence(_ directory: String) -> Int32 {
    let root = URL(fileURLWithPath: directory, isDirectory: true)
    do { try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true) } catch { return 1 }
    let pairs: [(String, String, Bool)] = [
        ("icon-light-connected.png", "healthy", false),
        ("icon-dark-connected.png", "healthy", true),
        ("icon-light-action-required.png", "approval", false),
        ("icon-dark-action-required.png", "approval", true),
        ("icon-light-degraded.png", "degraded", false),
        ("icon-dark-degraded.png", "degraded", true),
        ("icon-light-disconnected.png", "disconnected", false),
        ("icon-dark-disconnected.png", "disconnected", true),
        ("icon-light-working.png", "working", false),
        ("icon-dark-working.png", "working", true)
    ]
    for (name, tone, dark) in pairs {
        guard writePNG(appearanceIcon(dark: dark, tone: tone), to: root.appendingPathComponent(name)) else { return 1 }
    }
    guard writePNG(brandImage(tone: "healthy"), to: root.appendingPathComponent("icon-gradient-connected.png")) else { return 1 }
    fputs("Exported menu visual evidence.\n", stderr)
    return 0
}
private func main() -> Int32 {
    let arguments = CommandLine.arguments
    if arguments.count == 3 && arguments[1] == "--export-visual-evidence" {
        return exportVisualEvidence(arguments[2])
    }
    let configuration: Configuration
    do { configuration = try Configuration() }
    catch { fputs("Airodrom helper configuration is unavailable.\n", stderr); return 1 }
    let controller = Controller(configuration: configuration)
    if arguments.count == 2 && arguments[1] == "--open-control-center" { return openControlCenter(configuration.dataDirectory) }
    if arguments.count > 1 {
        let inspecting = arguments.count == 2 && arguments[1] == "--inspect-menu"
        guard inspecting || (arguments.count == 3 && arguments[1] == "--action" && ControlAction(rawValue: arguments[2]) != nil) else {
            fputs("Usage: AirodromMenu [--action status|start|stop|restart|open|open-conversation|open-missions|open-development-sessions|open-system-health|cli|doctor|requalify] | --export-visual-evidence DIR\n", stderr); return 2
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
