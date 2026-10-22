import Foundation
import Network

/// The app serves only bundled UI assets over the loopback interface.
/// Files chosen by the user stay in WebKit's File API and never reach this server.
final class LocalAssetServer {
    private let root: URL
    private let queue = DispatchQueue(label: "com.local.candymagnet.assets", qos: .userInitiated)
    private var listener: NWListener?
    private var connections: [ObjectIdentifier: NWConnection] = [:]

    private let assets: [String: (String, String)] = [
        "/": ("index.html", "text/html; charset=utf-8"),
        "/index.html": ("index.html", "text/html; charset=utf-8"),
        "/styles.css": ("styles.css", "text/css; charset=utf-8"),
        "/app.js": ("app.js", "text/javascript; charset=utf-8"),
        "/torrent.js": ("torrent.js", "text/javascript; charset=utf-8"),
        "/converter-worker.js": ("converter-worker.js", "text/javascript; charset=utf-8"),
        "/history.html": ("history.html", "text/html; charset=utf-8"),
        "/history.css": ("history.css", "text/css; charset=utf-8"),
        "/history.js": ("history.js", "text/javascript; charset=utf-8"),
        "/history-store.js": ("history-store.js", "text/javascript; charset=utf-8"),
        "/assets/app-icon.png": ("assets/app-icon.png", "image/png"),
        "/assets/zenicon.woff": ("assets/zenicon.woff", "font/woff")
    ]

    init(root: URL) { self.root = root }

    func start(completion: @escaping (Result<URL, Error>) -> Void) {
        do {
            let parameters = NWParameters.tcp
            parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
            let listener = try NWListener(using: parameters)
            self.listener = listener
            var deliveredInitialState = false
            listener.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    guard !deliveredInitialState, let port = listener.port,
                          let url = URL(string: "http://127.0.0.1:\(port.rawValue)/") else { return }
                    deliveredInitialState = true
                    completion(.success(url))
                case .failed(let error):
                    if !deliveredInitialState {
                        deliveredInitialState = true
                        completion(.failure(error))
                    }
                default: break
                }
            }
            listener.newConnectionHandler = { [weak self] connection in
                guard let self else { connection.cancel(); return }
                guard case .hostPort(let host, _) = connection.endpoint,
                      case .ipv4(let address) = host,
                      address == IPv4Address.loopback else {
                    connection.cancel()
                    return
                }
                let id = ObjectIdentifier(connection)
                self.connections[id] = connection
                connection.stateUpdateHandler = { [weak self] state in
                    switch state {
                    case .failed, .cancelled: self?.connections.removeValue(forKey: id)
                    default: break
                    }
                }
                connection.start(queue: self.queue)
                self.queue.asyncAfter(deadline: .now() + 15) { [weak connection] in connection?.cancel() }
                self.readRequest(connection, data: Data())
            }
            listener.start(queue: queue)
        } catch {
            completion(.failure(error))
        }
    }

    func stop() {
        queue.async { [weak self] in
            guard let self else { return }
            self.listener?.cancel()
            for connection in self.connections.values { connection.cancel() }
            self.connections.removeAll()
        }
    }

    private func readRequest(_ connection: NWConnection, data: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 16384) { [weak self] chunk, _, complete, error in
            guard let self else { connection.cancel(); return }
            var received = data
            if let chunk { received.append(chunk) }
            guard received.count <= 16384 else {
                self.respond(connection, code: "431 Request Header Fields Too Large", body: Data())
                return
            }
            if let headerEnd = received.range(of: Data("\r\n\r\n".utf8)) {
                self.serve(connection, header: received.subdata(in: 0..<headerEnd.lowerBound))
            } else if complete || error != nil {
                connection.cancel()
            } else {
                self.readRequest(connection, data: received)
            }
        }
    }

    private func serve(_ connection: NWConnection, header: Data) {
        guard let request = String(data: header, encoding: .utf8) else {
            respond(connection, code: "400 Bad Request", body: Data())
            return
        }
        let lines = request.components(separatedBy: "\r\n")
        let parts = (lines.first ?? "").split(separator: " ")
        guard parts.count == 3, parts[0] == "GET" else {
            respond(connection, code: "405 Method Not Allowed", body: Data())
            return
        }
        guard let port = listener?.port else { connection.cancel(); return }
        let expectedHost = "127.0.0.1:\(port.rawValue)"
        let host = lines.dropFirst().first(where: { $0.lowercased().hasPrefix("host:") })?
            .dropFirst(5).trimmingCharacters(in: .whitespacesAndNewlines)
        guard host == expectedHost else {
            respond(connection, code: "403 Forbidden", body: Data())
            return
        }
        let route = String(parts[1].split(separator: "?", maxSplits: 1).first ?? "")
        if route == "/favicon.ico" {
            respond(connection, code: "204 No Content", body: Data())
            return
        }
        guard let asset = assets[route] else {
            respond(connection, code: "404 Not Found", body: Data())
            return
        }
        do {
            let body = try Data(contentsOf: root.appendingPathComponent(asset.0), options: .mappedIfSafe)
            respond(connection, code: "200 OK", type: asset.1, body: body)
        } catch {
            respond(connection, code: "500 Internal Server Error", body: Data("应用资源无法读取".utf8))
        }
    }

    private func respond(_ connection: NWConnection, code: String, type: String = "text/plain; charset=utf-8", body: Data) {
        let policy = "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
        let headers = "HTTP/1.1 \(code)\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: \(policy)\r\n\r\n"
        var response = Data(headers.utf8)
        response.append(body)
        connection.send(content: response, completion: .contentProcessed { _ in connection.cancel() })
    }
}
