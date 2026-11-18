// Taskboard.app — the board in its own window, with a Dock icon and a menu-bar
// item that shows how many Claude sessions are waiting on you. It is a thin
// shell: everything it shows comes from the local board server.
import AppKit
import ServiceManagement
import WebKit

let boardURL = URL(string: "http://127.0.0.1:4780/")!
let home = FileManager.default.homeDirectoryForCurrentUser
let cliPath = home.appendingPathComponent(".local/bin/taskboard").path
let logURL = home.appendingPathComponent(".claude/taskboard/app.log")

func log(_ text: String) {
    let line = ISO8601DateFormatter().string(from: Date()) + " " + text + "\n"
    guard let data = line.data(using: .utf8) else { return }
    if let size = try? FileManager.default.attributesOfItem(atPath: logURL.path)[.size] as? Int, size > 200_000 {
        try? FileManager.default.removeItem(at: logURL)
    }
    if let handle = try? FileHandle(forWritingTo: logURL) {
        handle.seekToEndOfFile()
        handle.write(data)
        try? handle.close()
    } else {
        try? data.write(to: logURL)
    }
}

// `Taskboard --login-status` and `Taskboard --login on|off`, so the setting can
// be read and changed without clicking through the menu.
let arguments = CommandLine.arguments
if arguments.contains("--login-status") {
    print(SMAppService.mainApp.status == .enabled ? "on" : "off")
    exit(0)
}
if let i = arguments.firstIndex(of: "--login"), i + 1 < arguments.count {
    do {
        // "on" and "off" change it; anything else ("status") only reports
        if arguments[i + 1] == "on" { try SMAppService.mainApp.register() } else if arguments[i + 1] == "off" { try SMAppService.mainApp.unregister() }
        print(SMAppService.mainApp.status == .enabled ? "on" : "off")
        exit(0)
    } catch {
        print("failed: \(error.localizedDescription)")
        exit(1)
    }
}

struct Waiting: Decodable {
    let id: String
    let title: String
    let ask: String
    let card: String
}

struct Running: Decodable {
    let id: String
    let title: String
    let card: String
}

struct Summary: Decodable {
    let needs: [Waiting]
    let running: [Running]
    let review: Int
    let unsorted: Int
}

func short(_ text: String, _ max: Int) -> String {
    let flat = text.replacingOccurrences(of: "\n", with: " ")
    return flat.count > max ? String(flat.prefix(max - 1)) + "…" : flat
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, NSMenuDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var statusItem: NSStatusItem!
    private var summary: Summary?
    private var loadAttempts = 0
    private var pendingHash: String?
    private var loggedSummary = false

    // MARK: life cycle

    /// Started by macOS at login (or with --background) rather than opened by
    /// the user: come up as the menu-bar item only, and leave the window closed
    /// until it is asked for.
    private var startsInBackground: Bool {
        if CommandLine.arguments.contains("--background") { return true }
        let event = NSAppleEventManager.shared().currentAppleEvent
        return event?.eventID == kAEOpenApplication
            && event?.paramDescriptor(forKeyword: keyAEPropData)?.enumCodeValue == keyAELaunchedAsLogInItem
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let quiet = startsInBackground
        NSApp.mainMenu = makeMainMenu()
        makeWindow(show: !quiet)
        makeStatusItem()
        startServer { [weak self] in self?.loadBoard() }
        Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in self?.refreshSummary() }
        refreshSummary()
        if !quiet { NSApp.activate(ignoringOtherApps: true) }
        log(quiet ? "launched in the background, window \(window.isVisible ? "shown" : "closed")" : "launched")
    }

    // Closing the window leaves the menu-bar item and the Dock badge running.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    // taskboard://card/TB-3, taskboard://needs, taskboard://sessions, taskboard://graph, taskboard://diary
    func application(_ application: NSApplication, open urls: [URL]) {
        guard let url = urls.first, url.scheme == "taskboard" else { return }
        let place = url.host ?? ""
        let key = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let safe = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-_"))
        if place == "card", !key.isEmpty, key.unicodeScalars.allSatisfy({ safe.contains($0) }) {
            go("card=" + key)
        } else if ["needs", "sessions", "graph", "diary", "board"].contains(place) {
            go(place)
        } else if webView != nil {
            showWindow()
        }
    }

    // MARK: window

    private func makeWindow(show: Bool) {
        webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsMagnification = true
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "Taskboard"
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 760, height: 480)
        window.tabbingMode = .disallowed
        window.contentView = webView
        window.center()
        window.setFrameAutosaveName("TaskboardMain")
        webView.loadHTMLString(
            "<body style='font:15px -apple-system;color:#888;background:#16181d;display:flex;align-items:center;justify-content:center;height:100vh;margin:0'>Starting Taskboard…</body>",
            baseURL: nil)
        if show { window.makeKeyAndOrderFront(nil) }
    }

    private func showWindow() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private var onBoard: Bool { webView.url?.host == boardURL.host && webView.url?.port == boardURL.port }

    /// Show a place in the board: "needs", "card=TB-3", …
    private func go(_ hash: String) {
        guard webView != nil else {
            pendingHash = hash // opened by a link before the window exists
            return
        }
        showWindow()
        if onBoard {
            webView.evaluateJavaScript("location.hash = \(jsString(hash))", completionHandler: nil)
        } else {
            pendingHash = hash
            loadBoard()
        }
    }

    private func jsString(_ text: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [text])) ?? Data("[\"\"]".utf8)
        return String(String(decoding: data, as: UTF8.self).dropFirst().dropLast())
    }

    // MARK: server and loading

    private func startServer(then done: @escaping () -> Void) {
        guard FileManager.default.isExecutableFile(atPath: cliPath) else {
            log("no taskboard command at \(cliPath)")
            return done()
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: cliPath)
        process.arguments = ["start"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { _ in DispatchQueue.main.async { done() } }
        do { try process.run() } catch {
            log("could not run taskboard start: \(error.localizedDescription)")
            done()
        }
    }

    private func loadBoard() {
        var url = boardURL
        if let hash = pendingHash, var parts = URLComponents(url: boardURL, resolvingAgainstBaseURL: false) {
            parts.fragment = hash
            url = parts.url ?? boardURL
            pendingHash = nil
        }
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if onBoard {
            loadAttempts = 0
            log("loaded \(webView.url?.absoluteString ?? "")")
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        retry(after: error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        retry(after: error)
    }

    private func retry(after error: Error) {
        let e = error as NSError
        // links we hand to the browser are cancelled on purpose
        if e.domain == "WebKitErrorDomain" || e.code == NSURLErrorCancelled { return }
        loadAttempts += 1
        log("load failed (\(loadAttempts)): \(e.localizedDescription)")
        guard loadAttempts <= 8 else {
            webView.loadHTMLString(
                "<body style='font:15px -apple-system;color:#aaa;background:#16181d;padding:60px;line-height:1.6'><b>The board is not answering.</b><br>Run <code>taskboard doctor</code> in a terminal, then press ⌘R here.</body>",
                baseURL: nil)
            return
        }
        startServer { [weak self] in
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { self?.loadBoard() }
        }
    }

    // The board stays in this window; everything else opens where it belongs
    // (web links in the browser, claude:// links in Claude).
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.allow) }
        if url.scheme == "about" { return decisionHandler(.allow) }
        let local = (url.host == "127.0.0.1" || url.host == "localhost") && url.port == boardURL.port
        if local && url.path != "/api/export" { return decisionHandler(.allow) }
        if ["http", "https", "claude", "mailto"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, ["http", "https"].contains(url.scheme ?? "") { NSWorkspace.shared.open(url) }
        return nil
    }

    // MARK: what is waiting on you

    private func refreshSummary() {
        var request = URLRequest(url: boardURL.appendingPathComponent("api/summary"))
        request.timeoutInterval = 4
        request.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: request) { [weak self] data, _, _ in
            let summary = data.flatMap { try? JSONDecoder().decode(Summary.self, from: $0) }
            DispatchQueue.main.async { self?.apply(summary) }
        }.resume()
    }

    private func apply(_ new: Summary?) {
        summary = new
        let waiting = new?.needs.count ?? 0
        statusItem.button?.title = waiting > 0 ? " \(waiting)" : ""
        statusItem.button?.toolTip = new == nil ? "Taskboard (not running)" : "Taskboard: \(waiting) waiting on you, \(new!.running.count) running"
        NSApp.dockTile.badgeLabel = waiting > 0 ? "\(waiting)" : nil
        if new != nil && !loggedSummary {
            loggedSummary = true
            log("summary ok: \(waiting) waiting")
        }
    }

    private func post(_ path: String, _ body: [String: Any]) {
        var request = URLRequest(url: boardURL.appendingPathComponent(path))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: body)
        URLSession.shared.dataTask(with: request).resume()
    }

    // MARK: menu-bar item

    private func makeStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            let image = NSImage(systemSymbolName: "rectangle.split.3x1.fill", accessibilityDescription: "Taskboard")
            image?.isTemplate = true
            button.image = image
            button.imagePosition = .imageLeading
            button.toolTip = "Taskboard"
        }
        let menu = NSMenu()
        menu.delegate = self
        statusItem.menu = menu
    }

    private func entry(_ title: String, _ action: Selector?, key: String = "", represents: Any? = nil, tip: String? = nil) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = action == nil ? nil : self
        item.representedObject = represents
        item.toolTip = tip
        return item
    }

    private func heading(_ title: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.isEnabled = false
        return item
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        guard menu === statusItem.menu else { return }
        menu.removeAllItems()
        menu.addItem(entry("Open Taskboard", #selector(openBoard)))
        menu.addItem(entry("New Card…", #selector(newCard)))
        menu.addItem(.separator())
        guard let s = summary else {
            menu.addItem(heading("The board is not running"))
            menu.addItem(.separator())
            menu.addItem(entry("Quit Taskboard", #selector(quit)))
            return
        }
        menu.addItem(heading(s.needs.isEmpty ? "Nothing is waiting on you" : "Waiting on you (\(s.needs.count)) — click to open in Claude"))
        for w in s.needs.prefix(9) {
            let prefix = w.card.isEmpty ? "" : "\(w.card)  "
            menu.addItem(entry(short(prefix + w.title, 62), #selector(openSession(_:)), represents: w.id, tip: w.ask))
        }
        if s.needs.count > 9 {
            menu.addItem(entry("Show all \(s.needs.count)…", #selector(openNeeds)))
        }
        if !s.running.isEmpty {
            menu.addItem(.separator())
            menu.addItem(heading("Running now (\(s.running.count))"))
            for r in s.running.prefix(6) {
                let prefix = r.card.isEmpty ? "" : "\(r.card)  "
                menu.addItem(entry(short(prefix + r.title, 62), #selector(openSession(_:)), represents: r.id))
            }
        }
        menu.addItem(.separator())
        if s.review > 0 { menu.addItem(entry("\(s.review) ready for your review…", #selector(openNeeds))) }
        if s.unsorted > 0 { menu.addItem(entry("\(s.unsorted) sessions not on a card…", #selector(openSessions))) }
        if s.review > 0 || s.unsorted > 0 { menu.addItem(.separator()) }
        let login = entry("Open at Login", #selector(toggleLogin))
        login.state = SMAppService.mainApp.status == .enabled ? .on : .off
        menu.addItem(login)
        menu.addItem(entry("Quit Taskboard", #selector(quit)))
    }

    // MARK: actions

    @objc private func openBoard() { showWindow(); if !onBoard { loadBoard() } }
    @objc private func openNeeds() { go("needs") }
    @objc private func openSessions() { go("sessions") }
    @objc private func quit() { NSApp.terminate(nil) }

    @objc private func newCard() {
        showWindow()
        webView.evaluateJavaScript("ACTIONS['new-card']({ dataset: {} })", completionHandler: nil)
    }

    @objc private func openSession(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        post("api/open", ["sessionId": id])
    }

    @objc private func toggleLogin() {
        do {
            if SMAppService.mainApp.status == .enabled { try SMAppService.mainApp.unregister() } else { try SMAppService.mainApp.register() }
        } catch {
            let alert = NSAlert()
            alert.messageText = "Could not change Open at Login"
            alert.informativeText = error.localizedDescription + "\n\nYou can add Taskboard yourself in System Settings → General → Login Items."
            alert.runModal()
        }
    }

    @objc private func reload() { loadAttempts = 0; if onBoard { webView.reload() } else { loadBoard() } }
    @objc private func showView(_ sender: NSMenuItem) { go(["board", "needs", "sessions", "graph", "diary"][sender.tag]) }
    @objc private func zoomIn() { webView.pageZoom = min(2.0, webView.pageZoom + 0.1) }
    @objc private func zoomOut() { webView.pageZoom = max(0.6, webView.pageZoom - 0.1) }
    @objc private func zoomReset() { webView.pageZoom = 1 }

    // MARK: main menu (also what makes ⌘C, ⌘V and friends work in the page)

    private func makeMainMenu() -> NSMenu {
        let main = NSMenu()
        func add(_ title: String, _ items: [NSMenuItem]) {
            let menu = NSMenu(title: title)
            items.forEach { menu.addItem($0) }
            let top = NSMenuItem()
            top.submenu = menu
            main.addItem(top)
        }
        func system(_ title: String, _ action: Selector, _ key: String = "") -> NSMenuItem {
            NSMenuItem(title: title, action: action, keyEquivalent: key) // no target: goes to whatever has focus
        }
        func view(_ title: String, _ tag: Int) -> NSMenuItem {
            let item = entry(title, #selector(showView(_:)), key: "\(tag + 1)")
            item.tag = tag
            return item
        }
        add("Taskboard", [
            system("About Taskboard", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
            .separator(),
            system("Hide Taskboard", #selector(NSApplication.hide(_:)), "h"),
            system("Show All", #selector(NSApplication.unhideAllApplications(_:))),
            .separator(),
            system("Quit Taskboard", #selector(NSApplication.terminate(_:)), "q"),
        ])
        add("File", [
            entry("New Card", #selector(newCard), key: "n"),
            .separator(),
            system("Close Window", #selector(NSWindow.performClose(_:)), "w"),
        ])
        add("Edit", [
            system("Undo", Selector(("undo:")), "z"),
            system("Redo", Selector(("redo:")), "Z"),
            .separator(),
            system("Cut", #selector(NSText.cut(_:)), "x"),
            system("Copy", #selector(NSText.copy(_:)), "c"),
            system("Paste", #selector(NSText.paste(_:)), "v"),
            system("Select All", #selector(NSText.selectAll(_:)), "a"),
        ])
        add("View", [
            view("Board", 0), view("Needs Me", 1), view("Sessions", 2), view("Connections", 3), view("Diary", 4),
            .separator(),
            entry("Reload", #selector(reload), key: "r"),
            .separator(),
            entry("Zoom In", #selector(zoomIn), key: "+"),
            entry("Zoom Out", #selector(zoomOut), key: "-"),
            entry("Actual Size", #selector(zoomReset), key: "0"),
        ])
        add("Window", [
            system("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
            system("Zoom", #selector(NSWindow.performZoom(_:))),
        ])
        return main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
