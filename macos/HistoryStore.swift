import Foundation
import SQLite3

struct ConversionRecord {
    let id: String
    let title: String
    let magnet: String
    let convertedAt: Int64

    var dictionary: [String: Any] {
        ["id": id, "title": title, "magnet": magnet, "convertedAt": convertedAt]
    }
}

struct HistoryCursor {
    let convertedAt: Int64
    let id: String

    var dictionary: [String: Any] { ["convertedAt": convertedAt, "id": id] }
}

struct HistoryPage {
    let records: [ConversionRecord]
    let nextCursor: HistoryCursor?

    var dictionary: [String: Any] {
        ["ok": true, "records": records.map(\.dictionary),
         "nextCursor": nextCursor.map { $0.dictionary as Any } ?? NSNull()]
    }
}

private struct HistoryStorageError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// All database access, including creation, pruning and shutdown, stays on one queue.
final class HistoryStore {
    private let queue = DispatchQueue(label: "com.local.candymagnet.history", qos: .utility)
    private let onChange: () -> Void
    private var database: OpaquePointer?
    private var cleanupTimer: DispatchSourceTimer?
    private var closed = false
    private let retentionMilliseconds: Int64 = 7 * 24 * 60 * 60 * 1000
    private let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    init(onChange: @escaping () -> Void) { self.onChange = onChange }

    func start() {
        queue.async { [self] in
            performMaintenance()
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline: .now() + 3600, repeating: 3600, leeway: .seconds(30))
            timer.setEventHandler { [weak self] in self?.performMaintenance() }
            cleanupTimer = timer
            timer.resume()
        }
    }

    func append(_ records: [ConversionRecord], completion: @escaping (Result<Void, Error>) -> Void) {
        queue.async { [self] in
            do {
                try openIfNeeded()
                let cutoff = currentMilliseconds() - retentionMilliseconds
                var changed = 0
                try transaction {
                    changed += try prune(before: cutoff)
                    let statement = try prepare("INSERT INTO conversion_history (id, title, magnet, converted_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING")
                    defer { sqlite3_finalize(statement) }
                    for record in records where record.convertedAt >= cutoff {
                        try bind(record.id, to: 1, statement: statement)
                        try bind(record.title, to: 2, statement: statement)
                        try bind(record.magnet, to: 3, statement: statement)
                        try check(sqlite3_bind_int64(statement, 4, record.convertedAt))
                        guard sqlite3_step(statement) == SQLITE_DONE else { throw databaseError("保存转换历史失败") }
                        changed += Int(sqlite3_changes(database))
                        try check(sqlite3_reset(statement))
                        try check(sqlite3_clear_bindings(statement))
                    }
                }
                completion(.success(()))
                if changed > 0 { onChange() }
            } catch {
                completion(.failure(error))
            }
        }
    }

    func list(before cursor: HistoryCursor?, limit: Int, completion: @escaping (Result<HistoryPage, Error>) -> Void) {
        queue.async { [self] in
            do {
                try openIfNeeded()
                let cutoff = currentMilliseconds() - retentionMilliseconds
                let removed = try prune(before: cutoff)
                let sql: String
                if cursor != nil {
                    sql = "SELECT id, title, magnet, converted_at FROM conversion_history WHERE converted_at >= ? AND (converted_at, id) < (?, ?) ORDER BY converted_at DESC, id DESC LIMIT ?"
                } else {
                    sql = "SELECT id, title, magnet, converted_at FROM conversion_history WHERE converted_at >= ? ORDER BY converted_at DESC, id DESC LIMIT ?"
                }
                let statement = try prepare(sql)
                defer { sqlite3_finalize(statement) }
                try check(sqlite3_bind_int64(statement, 1, cutoff))
                if let cursor {
                    try check(sqlite3_bind_int64(statement, 2, cursor.convertedAt))
                    try bind(cursor.id, to: 3, statement: statement)
                    try check(sqlite3_bind_int(statement, 4, Int32(limit + 1)))
                } else {
                    try check(sqlite3_bind_int(statement, 2, Int32(limit + 1)))
                }
                var records: [ConversionRecord] = []
                while true {
                    let step = sqlite3_step(statement)
                    if step == SQLITE_DONE { break }
                    guard step == SQLITE_ROW else { throw databaseError("读取转换历史失败") }
                    records.append(ConversionRecord(id: text(statement, column: 0), title: text(statement, column: 1),
                                                    magnet: text(statement, column: 2), convertedAt: sqlite3_column_int64(statement, 3)))
                }
                let hasMore = records.count > limit
                if hasMore { records.removeLast() }
                let next = hasMore ? records.last.map { HistoryCursor(convertedAt: $0.convertedAt, id: $0.id) } : nil
                completion(.success(HistoryPage(records: records, nextCursor: next)))
                if removed > 0 { onChange() }
            } catch {
                completion(.failure(error))
            }
        }
    }

    /// Waiting on the same queue lets already accepted writes finish before quit.
    func shutdown(completion: @escaping () -> Void) {
        queue.async { [self] in
            closed = true
            cleanupTimer?.cancel()
            cleanupTimer = nil
            if let database {
                sqlite3_close_v2(database)
                self.database = nil
            }
            completion()
        }
    }

    private func openIfNeeded() throws {
        guard !closed else { throw HistoryStorageError(message: "应用正在退出，无法继续保存历史记录。") }
        guard database == nil else { return }
        let support = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let directory = support.appendingPathComponent("糖果磁链", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let file = directory.appendingPathComponent("history.sqlite3")
        var opened: OpaquePointer?
        let status = sqlite3_open_v2(file.path, &opened, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_NOMUTEX, nil)
        guard status == SQLITE_OK, let opened else {
            let reason = opened.map { String(cString: sqlite3_errmsg($0)) } ?? "无法打开数据库文件"
            if let opened { sqlite3_close_v2(opened) }
            throw HistoryStorageError(message: "无法打开转换历史：\(reason)")
        }
        database = opened
        do {
            try check(sqlite3_busy_timeout(opened, 5000))
            try execute("PRAGMA journal_mode=WAL")
            try execute("PRAGMA synchronous=NORMAL")
            try execute("CREATE TABLE IF NOT EXISTS conversion_history (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, magnet TEXT NOT NULL, converted_at INTEGER NOT NULL) WITHOUT ROWID")
            try execute("CREATE INDEX IF NOT EXISTS conversion_history_time ON conversion_history (converted_at DESC, id DESC)")
        } catch {
            sqlite3_close_v2(opened)
            database = nil
            throw error
        }
    }

    private func performMaintenance() {
        guard !closed else { return }
        do {
            try openIfNeeded()
            if try prune(before: currentMilliseconds() - retentionMilliseconds) > 0 { onChange() }
        } catch {
            // Interactive append/list requests also retry pruning and return the error to the UI.
            NSLog("转换历史自动清理失败：%@", error.localizedDescription)
        }
    }

    private func prune(before cutoff: Int64) throws -> Int {
        let statement = try prepare("DELETE FROM conversion_history WHERE converted_at < ?")
        defer { sqlite3_finalize(statement) }
        try check(sqlite3_bind_int64(statement, 1, cutoff))
        guard sqlite3_step(statement) == SQLITE_DONE else { throw databaseError("清理过期转换历史失败") }
        return Int(sqlite3_changes(database))
    }

    private func transaction(_ work: () throws -> Void) throws {
        try execute("BEGIN IMMEDIATE")
        do {
            try work()
            try execute("COMMIT")
        } catch {
            let originalError = error
            do { try execute("ROLLBACK") }
            catch {
                if let database { sqlite3_close_v2(database) }
                database = nil
            }
            throw originalError
        }
    }

    private func execute(_ sql: String) throws {
        guard sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK else { throw databaseError("更新转换历史失败") }
    }

    private func prepare(_ sql: String) throws -> OpaquePointer {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw databaseError("读取转换历史失败")
        }
        return statement
    }

    private func bind(_ value: String, to column: Int32, statement: OpaquePointer) throws {
        let result = value.withCString { sqlite3_bind_text(statement, column, $0, -1, transient) }
        try check(result)
    }

    private func text(_ statement: OpaquePointer, column: Int32) -> String {
        guard let value = sqlite3_column_text(statement, column) else { return "" }
        return String(cString: value)
    }

    private func check(_ code: Int32) throws {
        guard code == SQLITE_OK else { throw databaseError("处理转换历史失败") }
    }

    private func databaseError(_ operation: String) -> HistoryStorageError {
        let reason = database.map { String(cString: sqlite3_errmsg($0)) } ?? "数据库未打开"
        return HistoryStorageError(message: "\(operation)：\(reason)")
    }

    private func currentMilliseconds() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}
