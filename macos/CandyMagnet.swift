import AppKit
import CoreFoundation
import WebKit
import UniformTypeIdentifiers

@main
struct CandyMagnetApplication {
    @MainActor static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        application.run()
        withExtendedLifetime(delegate) {}
    }
}

@MainActor
private final class TitlebarDragRegion: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = convert(point, from: superview)
        return local.x >= 90 && bounds.contains(local) ? self : nil
    }
    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2 { window?.zoom(nil) }
        else { window?.performDrag(with: event) }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandlerWithReply {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var historyWindow: NSWindow?
    private var historyWebView: WKWebView?
    private var historyStore: HistoryStore?
    private var assetServer: LocalAssetServer?
    private var origin: URL?
    private var openPanel: NSOpenPanel?
    private var showingStartupError = false
    private var terminating = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.appearance = NSAppearance(named: .aqua)
        createMenus()
        (window, webView) = makeWindow(title: "糖果磁链", size: NSSize(width: 620, height: 740), minimumSize: NSSize(width: 520, height: 640))
        let history = HistoryStore { [weak self] in
            DispatchQueue.main.async { self?.notifyHistoryChanged() }
        }
        historyStore = history
        history.start()
        guard let resources = Bundle.main.resourceURL else {
            showStartupError("应用资源缺失，请重新打开完整的应用。")
            return
        }
        let server = LocalAssetServer(root: resources.appendingPathComponent("Web"))
        assetServer = server
        server.start { [weak self] result in
            DispatchQueue.main.async {
                guard let self else { return }
                switch result {
                case .success(let url):
                    self.origin = url
                    self.webView.load(URLRequest(url: url))
                case .failure:
                    self.showStartupError("本地界面未能启动，请退出后重新打开应用。")
                }
            }
        }
    }

    private func makeWindow(title: String, size: NSSize, minimumSize: NSSize) -> (NSWindow, WKWebView) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "desktop")
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.setValue(false, forKey: "drawsBackground")
        webView.underPageBackgroundColor = .clear
        webView.translatesAutoresizingMaskIntoConstraints = false

        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = title
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.isReleasedWhenClosed = false
        window.minSize = minimumSize
        window.maxSize = NSSize(width: 1000, height: 1100)
        window.collectionBehavior = [.fullScreenNone]
        window.tabbingMode = .disallowed

        let backdrop = NSVisualEffectView(frame: .zero)
        backdrop.material = .underWindowBackground
        backdrop.blendingMode = .behindWindow
        backdrop.state = .active
        window.contentView = backdrop
        backdrop.addSubview(webView)
        let dragRegion = TitlebarDragRegion(frame: .zero)
        dragRegion.translatesAutoresizingMaskIntoConstraints = false
        backdrop.addSubview(dragRegion)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: backdrop.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: backdrop.trailingAnchor),
            webView.topAnchor.constraint(equalTo: backdrop.topAnchor),
            webView.bottomAnchor.constraint(equalTo: backdrop.bottomAnchor),
            dragRegion.leadingAnchor.constraint(equalTo: backdrop.leadingAnchor),
            dragRegion.trailingAnchor.constraint(equalTo: backdrop.trailingAnchor),
            dragRegion.topAnchor.constraint(equalTo: backdrop.topAnchor),
            dragRegion.heightAnchor.constraint(equalToConstant: 38)
        ])
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        return (window, webView)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        window?.makeKeyAndOrderFront(nil)
        return true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if terminating { return .terminateLater }
        guard let historyStore else { return .terminateNow }
        terminating = true
        historyStore.shutdown {
            DispatchQueue.main.async { sender.reply(toApplicationShouldTerminate: true) }
        }
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        openPanel?.cancel(nil)
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "desktop", contentWorld: .page)
        historyWebView?.configuration.userContentController.removeScriptMessageHandler(forName: "desktop", contentWorld: .page)
        assetServer?.stop()
    }

    private func isLocal(_ url: URL?) -> Bool {
        guard let url, let origin else { return false }
        return url.scheme == origin.scheme && url.host == origin.host && url.port == origin.port
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(isLocal(navigationAction.request.url) ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code != NSURLErrorCancelled {
            if webView === historyWebView, let historyWindow {
                let alert = NSAlert()
                alert.messageText = "转换历史无法打开"
                alert.informativeText = "请关闭此窗口后重新打开转换历史。"
                alert.addButton(withTitle: "关闭")
                alert.beginSheetModal(for: historyWindow) { _ in historyWindow.close() }
            } else {
                showStartupError("应用界面无法读取，请退出后重新打开应用。")
            }
        }
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        guard frame.isMainFrame, isLocal(frame.request.url), openPanel == nil else {
            completionHandler(nil)
            return
        }
        let panel = NSOpenPanel()
        panel.title = parameters.allowsDirectories ? "选择种子文件夹" : "选择种子文件"
        panel.prompt = "添加"
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = !parameters.allowsDirectories
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canCreateDirectories = false
        panel.resolvesAliases = true
        if !parameters.allowsDirectories, let torrentType = UTType(filenameExtension: "torrent") {
            panel.allowedContentTypes = [torrentType]
        }
        openPanel = panel
        panel.beginSheetModal(for: webView.window ?? window) { [weak self] response in
            self?.openPanel = nil
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, isLocal(message.frameInfo.request.url),
              let body = message.body as? [String: Any],
              let action = body["action"] as? String else {
            replyHandler(nil, "无法处理此操作")
            return
        }
        switch action {
        case "copy":
            guard let text = body["text"] as? String else { replyHandler(nil, "复制内容格式无效"); return }
            NSPasteboard.general.clearContents()
            let copied = NSPasteboard.general.setString(text, forType: .string)
            replyHandler(["ok": copied], copied ? nil : "未能写入剪贴板")
        case "history.open":
            guard !terminating else { replyHandler(nil, "应用正在退出"); return }
            openHistoryWindow()
            replyHandler(["ok": true], nil)
        case "history.append":
            guard !terminating, let historyStore else { replyHandler(nil, "历史记录暂时无法保存"); return }
            do {
                let records = try parseRecords(body["records"])
                historyStore.append(records) { result in
                    DispatchQueue.main.async {
                        switch result {
                        case .success: replyHandler(["ok": true], nil)
                        case .failure(let error): replyHandler(nil, error.localizedDescription)
                        }
                    }
                }
            } catch { replyHandler(nil, error.localizedDescription) }
        case "history.list":
            guard !terminating, let historyStore else { replyHandler(nil, "历史记录暂时无法读取"); return }
            do {
                let cursor = try parseCursor(body["before"])
                var limit = 100
                if let value = body["limit"] {
                    guard let number = integer(value), number >= 1 else { throw protocolError("分页数量必须为正整数") }
                    limit = Int(min(number, 200))
                }
                historyStore.list(before: cursor, limit: limit) { result in
                    DispatchQueue.main.async {
                        switch result {
                        case .success(let page): replyHandler(page.dictionary, nil)
                        case .failure(let error): replyHandler(nil, error.localizedDescription)
                        }
                    }
                }
            } catch { replyHandler(nil, error.localizedDescription) }
        default:
            replyHandler(nil, "不支持此操作")
        }
    }

    private func parseRecords(_ value: Any?) throws -> [ConversionRecord] {
        guard let rows = value as? [[String: Any]] else { throw protocolError("历史记录必须是记录数组") }
        return try rows.map { row in
            guard let id = row["id"] as? String, !id.isEmpty, id.utf8.count <= 128, !id.contains("\0"),
                  let title = row["title"] as? String, !title.contains("\0"),
                  let magnet = row["magnet"] as? String, magnet.hasPrefix("magnet:?"), !magnet.contains("\0"),
                  let convertedAt = integer(row["convertedAt"]), convertedAt >= 0 else {
                throw protocolError("历史记录字段格式无效，未写入该批记录")
            }
            return ConversionRecord(id: id, title: title, magnet: magnet, convertedAt: convertedAt)
        }
    }

    private func parseCursor(_ value: Any?) throws -> HistoryCursor? {
        guard let value, !(value is NSNull) else { return nil }
        guard let cursor = value as? [String: Any], let convertedAt = integer(cursor["convertedAt"]), convertedAt >= 0,
              let id = cursor["id"] as? String, !id.isEmpty, id.utf8.count <= 128, !id.contains("\0") else {
            throw protocolError("历史分页游标格式无效")
        }
        return HistoryCursor(convertedAt: convertedAt, id: id)
    }

    private func integer(_ value: Any?) -> Int64? {
        guard let value = value as? NSNumber, CFGetTypeID(value) != CFBooleanGetTypeID() else { return nil }
        let number = value.doubleValue
        guard number.isFinite, number.rounded() == number, abs(number) <= 9007199254740991 else { return nil }
        return Int64(number)
    }

    private func protocolError(_ message: String) -> NSError {
        NSError(domain: "com.local.candymagnet.history", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
    }

    @objc private func openHistoryWindow() {
        guard let origin, !terminating else { return }
        if let historyWindow {
            historyWindow.makeKeyAndOrderFront(nil)
            if historyWebView?.url == nil {
                historyWebView?.load(URLRequest(url: origin.appendingPathComponent("history.html")))
            } else {
                notifyHistoryChanged()
            }
            return
        }
        let (historyWindow, historyWebView) = makeWindow(title: "转换历史 · 糖果磁链", size: NSSize(width: 620, height: 660), minimumSize: NSSize(width: 520, height: 540))
        self.historyWindow = historyWindow
        self.historyWebView = historyWebView
        historyWebView.load(URLRequest(url: origin.appendingPathComponent("history.html")))
    }

    private func notifyHistoryChanged() {
        guard historyWindow?.isVisible == true else { return }
        historyWebView?.evaluateJavaScript("window.dispatchEvent(new Event('history-updated'))", completionHandler: nil)
    }

    @objc private func showMainWindow() { window?.makeKeyAndOrderFront(nil) }

    private func showStartupError(_ message: String) {
        guard !showingStartupError else { return }
        showingStartupError = true
        let alert = NSAlert()
        alert.messageText = "糖果磁链"
        alert.informativeText = message
        alert.addButton(withTitle: "退出")
        alert.beginSheetModal(for: window) { _ in NSApp.terminate(nil) }
    }

    private func createMenus() {
        let menu = NSMenu()
        let appItem = NSMenuItem(title: "糖果磁链", action: nil, keyEquivalent: "")
        menu.addItem(appItem)
        let appMenu = NSMenu(title: "糖果磁链")
        appMenu.addItem(withTitle: "关于糖果磁链", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        let services = NSMenu(title: "服务")
        let servicesItem = NSMenuItem(title: "服务", action: nil, keyEquivalent: "")
        servicesItem.submenu = services
        appMenu.addItem(servicesItem)
        NSApp.servicesMenu = services
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏糖果磁链", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "隐藏其他", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "显示全部", action: #selector(NSApplication.unhideAllApplications(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出糖果磁链", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem(title: "编辑", action: nil, keyEquivalent: "")
        let editMenu = NSMenu(title: "编辑")
        editMenu.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "复制", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        menu.addItem(editItem)

        let windowItem = NSMenuItem(title: "窗口", action: nil, keyEquivalent: "")
        let windowMenu = NSMenu(title: "窗口")
        let converterItem = windowMenu.addItem(withTitle: "转换工具", action: #selector(showMainWindow), keyEquivalent: "1")
        converterItem.target = self
        let historyItem = windowMenu.addItem(withTitle: "转换历史", action: #selector(openHistoryWindow), keyEquivalent: "y")
        historyItem.target = self
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "缩放", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "前置全部窗口", action: #selector(NSApplication.arrangeInFront(_:)), keyEquivalent: "")
        windowItem.submenu = windowMenu
        menu.addItem(windowItem)
        NSApp.windowsMenu = windowMenu
        NSApp.mainMenu = menu
    }
}
