import Foundation
import SQLite3

struct ConversionRecord {
    let id: String
    let title: String
    let magnet: String
    let convertedAt: Int64
    let batchId: String
    let position: Int64

    var dictionary: [String: Any] {
        ["id": id, "title": title, "magnet": magnet, "convertedAt": convertedAt,
         "batchId": batchId, "position": position]
    }
}

struct ConversionBatch {
    let id: String
    let startedAt: Int64
    let completedAt: Int64
    let totalFiles: Int64
    let successCount: Int64
    let failedCount: Int64
    let status: String
}

struct HistoryOperation {
    let id: String
    let action: String
    let detail: String
    let count: Int64
    let createdAt: Int64
    let success: Bool
    let batchId: String?
}

struct HistoryCursor {
    let convertedAt: Int64
    let id: String
    var dictionary: [String: Any] { ["convertedAt": convertedAt, "id": id] }
}

struct HistoryPage {
    let dictionary: [String: Any]
}

private struct HistoryStorageError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// All database access, including schema migration, pruning and shutdown, stays on one queue.
final class HistoryStore {
    static let legacyBatchID = "legacy-unbatched-v1"
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

    func append(_ records: [ConversionRecord], batch: ConversionBatch, completion: @escaping (Result<Void, Error>) -> Void) {
        queue.async { [self] in
            do {
                try openIfNeeded()
                let cutoff = currentMilliseconds() - retentionMilliseconds
                var changed = 0
                try transaction {
                    changed += try prune(before: cutoff)
                    guard batch.startedAt >= cutoff else { return }
                    changed += try saveBatch(batch)
                    let statement = try prepare("INSERT INTO batch_records (id, batch_id, position, title, magnet, converted_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING")
                    defer { sqlite3_finalize(statement) }
                    for record in records {
                        try bind(record.id, to: 1, statement: statement)
                        try bind(record.batchId, to: 2, statement: statement)
                        try check(sqlite3_bind_int64(statement, 3, record.position))
                        try bind(record.title, to: 4, statement: statement)
                        try bind(record.magnet, to: 5, statement: statement)
                        try check(sqlite3_bind_int64(statement, 6, record.convertedAt))
                        try finish(statement, message: "保存转换批次失败")
                        let inserted = Int(sqlite3_changes(database))
                        if inserted == 0 { try requireIdenticalRecord(record) }
                        changed += inserted
                        try check(sqlite3_reset(statement))
                        try check(sqlite3_clear_bindings(statement))
                    }
                }
                completion(.success(()))
                if changed > 0 { onChange() }
            } catch { completion(.failure(error)) }
        }
    }

    func list(before cursor: HistoryCursor?, limit requestedLimit: Int, completion: @escaping (Result<HistoryPage, Error>) -> Void) {
        queue.async { [self] in
            do {
                try openIfNeeded()
                let removed = try pruneTransaction()
                let limit = max(1, min(200, requestedLimit))
                // Legacy entries have no reliable batch identity. Present one explicitly marked collection.
                let source = """
                    SELECT b.id, b.started_at, b.completed_at, b.total_files, b.success_count, b.failed_count,
                           b.status, (SELECT COUNT(*) FROM batch_records r WHERE r.batch_id = b.id) AS record_count, 0 AS legacy
                    FROM conversion_batches b
                    UNION ALL
                    SELECT 'legacy-unbatched-v1', MAX(converted_at), 0, COUNT(*), COUNT(*), 0, 'completed', COUNT(*), 1
                    FROM conversion_history HAVING COUNT(*) > 0
                    """
                let filter = cursor == nil ? "" : " WHERE (started_at, id) < (?, ?)"
                let statement = try prepare("SELECT * FROM (\(source))\(filter) ORDER BY started_at DESC, id DESC LIMIT ?")
                defer { sqlite3_finalize(statement) }
                let limitColumn: Int32
                if let cursor {
                    try check(sqlite3_bind_int64(statement, 1, cursor.convertedAt))
                    try bind(cursor.id, to: 2, statement: statement)
                    limitColumn = 3
                } else { limitColumn = 1 }
                try check(sqlite3_bind_int(statement, limitColumn, Int32(limit + 1)))
                var batches: [[String: Any]] = []
                while try next(statement, message: "读取转换批次失败") {
                    batches.append([
                        "id": text(statement, column: 0), "startedAt": sqlite3_column_int64(statement, 1),
                        "completedAt": sqlite3_column_int64(statement, 2), "totalFiles": sqlite3_column_int64(statement, 3),
                        "successCount": sqlite3_column_int64(statement, 4), "failedCount": sqlite3_column_int64(statement, 5),
                        "status": text(statement, column: 6), "recordCount": sqlite3_column_int64(statement, 7),
                        "legacy": sqlite3_column_int(statement, 8) != 0
                    ])
                }
                let hasMore = batches.count > limit
                if hasMore { batches.removeLast() }
                let nextCursor = hasMore ? batches.last.map { ["convertedAt": $0["startedAt"]!, "id": $0["id"]!] } : nil
                completion(.success(HistoryPage(dictionary: ["ok": true, "batches": batches, "nextCursor": nextCursor.map { $0 as Any } ?? NSNull()])))
                if removed > 0 { onChange() }
            } catch { completion(.failure(error)) }
        }
    }

    func listRecords(batchId: String, offset: Int64, limit requestedLimit: Int, completion: @escaping (Result<HistoryPage, Error>) -> Void) {
        queue.async { [self] in
            do {
                try openIfNeeded()
                let removed = try pruneTransaction()
                let limit = max(1, min(200, requestedLimit))
                let legacy = batchId == Self.legacyBatchID
                let sql = legacy
                    ? "SELECT id, title, magnet, converted_at FROM conversion_history ORDER BY converted_at DESC, id DESC LIMIT ? OFFSET ?"
                    : "SELECT id, title, magnet, converted_at, position FROM batch_records WHERE batch_id = ? ORDER BY position ASC, id ASC LIMIT ? OFFSET ?"
                let statement = try prepare(sql)
                defer { sqlite3_finalize(statement) }
                let limitColumn: Int32 = legacy ? 1 : 2
                if !legacy { try bind(batchId, to: 1, statement: statement) }
                try check(sqlite3_bind_int(statement, limitColumn, Int32(limit + 1)))
                try check(sqlite3_bind_int64(statement, limitColumn + 1, offset))
                var records: [ConversionRecord] = []
                while try next(statement, message: "读取批次链接失败") {
                    records.append(ConversionRecord(id: text(statement, column: 0), title: text(statement, column: 1),
                                                    magnet: text(statement, column: 2), convertedAt: sqlite3_column_int64(statement, 3),
                                                    batchId: batchId, position: legacy ? offset + Int64(records.count) : sqlite3_column_int64(statement, 4)))
                }
                let hasMore = records.count > limit
                if hasMore { records.removeLast() }
                let nextOffset: Any = hasMore ? (offset + Int64(records.count)) as Any : NSNull()
                completion(.success(HistoryPage(dictionary: ["ok": true, "records": records.map(\.dictionary), "nextOffset": nextOffset])))
                if removed > 0 { onChange() }
            } catch { completion(.failure(error)) }
        }
    }

    func appendOperations(_ operations: [HistoryOperation], completion: @escaping (Result<Void, Error>) -> Void) {
        queue.async { [self] in
            do {
                try openIfNeeded()
                let cutoff = currentMilliseconds() - retentionMilliseconds
                var changed = 0
                try transaction {
                    changed += try prune(before: cutoff)
                    let statement = try prepare("INSERT INTO operation_history (id, action, detail, item_count, created_at, success, batch_id) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING")
                    defer { sqlite3_finalize(statement) }
                    for operation in operations where operation.createdAt >= cutoff {
                        try bind(operation.id, to: 1, statement: statement)
                        try bind(operation.action, to: 2, statement: statement)
                        try bind(operation.detail, to: 3, statement: statement)
                        try check(sqlite3_bind_int64(statement, 4, operation.count))
                        try check(sqlite3_bind_int64(statement, 5, operation.createdAt))
                        try check(sqlite3_bind_int(statement, 6, operation.success ? 1 : 0))
                        if let batchId = operation.batchId { try bind(batchId, to: 7, statement: statement) }
                        else { try check(sqlite3_bind_null(statement, 7)) }
                        try finish(statement, message: "保存操作记录失败")
                        let inserted = Int(sqlite3_changes(database))
                        if inserted == 0 { try requireIdenticalOperation(operation) }
                        changed += inserted
                        try check(sqlite3_reset(statement))
                        try check(sqlite3_clear_bindings(statement))
                    }
                }
                completion(.success(()))
                if changed > 0 { onChange() }
            } catch { completion(.failure(error)) }
        }
    }

    func listOperations(before cursor: HistoryCursor?, limit requestedLimit: Int, completion: @escaping (Result<HistoryPage, Error>) -> Void) {
        queue.async { [self] in
            do {
                try openIfNeeded()
                let removed = try pruneTransaction()
                let limit = max(1, min(200, requestedLimit))
                let filter = cursor == nil ? "" : " WHERE (o.created_at, o.id) < (?, ?)"
                let statement = try prepare("SELECT o.id, o.action, o.detail, o.item_count, o.created_at, o.success, o.batch_id, b.started_at FROM operation_history o LEFT JOIN conversion_batches b ON b.id = o.batch_id\(filter) ORDER BY o.created_at DESC, o.id DESC LIMIT ?")
                defer { sqlite3_finalize(statement) }
                let limitColumn: Int32
                if let cursor {
                    try check(sqlite3_bind_int64(statement, 1, cursor.convertedAt))
                    try bind(cursor.id, to: 2, statement: statement)
                    limitColumn = 3
                } else { limitColumn = 1 }
                try check(sqlite3_bind_int(statement, limitColumn, Int32(limit + 1)))
                var operations: [[String: Any]] = []
                while try next(statement, message: "读取操作记录失败") {
                    operations.append([
                        "id": text(statement, column: 0), "action": text(statement, column: 1), "detail": text(statement, column: 2),
                        "count": sqlite3_column_int64(statement, 3), "createdAt": sqlite3_column_int64(statement, 4),
                        "success": sqlite3_column_int(statement, 5) != 0,
                        "batchId": sqlite3_column_type(statement, 6) == SQLITE_NULL ? NSNull() as Any : text(statement, column: 6) as Any,
                        "batchStartedAt": sqlite3_column_type(statement, 7) == SQLITE_NULL ? NSNull() as Any : sqlite3_column_int64(statement, 7) as Any
                    ])
                }
                let hasMore = operations.count > limit
                if hasMore { operations.removeLast() }
                let nextCursor = hasMore ? operations.last.map { ["convertedAt": $0["createdAt"]!, "id": $0["id"]!] } : nil
                completion(.success(HistoryPage(dictionary: ["ok": true, "operations": operations, "nextCursor": nextCursor.map { $0 as Any } ?? NSNull()])))
                if removed > 0 { onChange() }
            } catch { completion(.failure(error)) }
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

    private func saveBatch(_ batch: ConversionBatch) throws -> Int {
        let existing = try prepare("SELECT started_at, total_files, success_count, failed_count, status FROM conversion_batches WHERE id = ?")
        defer { sqlite3_finalize(existing) }
        try bind(batch.id, to: 1, statement: existing)
        if try next(existing, message: "读取转换批次失败") {
            guard sqlite3_column_int64(existing, 0) == batch.startedAt,
                  sqlite3_column_int64(existing, 1) == batch.totalFiles else {
                throw HistoryStorageError(message: "批次标识重复且内容不一致，未写入该批记录。")
            }
            // A retry of an earlier progress snapshot must never undo completion.
            if text(existing, column: 4) == "completed" { return 0 }
            guard max(sqlite3_column_int64(existing, 2), batch.successCount) + max(sqlite3_column_int64(existing, 3), batch.failedCount) <= batch.totalFiles else {
                throw HistoryStorageError(message: "批次进度不一致，未写入该批记录。")
            }
        }
        let statement = try prepare("""
            INSERT INTO conversion_batches (id, started_at, completed_at, total_files, success_count, failed_count, status)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                completed_at = MAX(conversion_batches.completed_at, excluded.completed_at),
                success_count = MAX(conversion_batches.success_count, excluded.success_count),
                failed_count = MAX(conversion_batches.failed_count, excluded.failed_count),
                status = excluded.status
            """)
        defer { sqlite3_finalize(statement) }
        try bind(batch.id, to: 1, statement: statement)
        try check(sqlite3_bind_int64(statement, 2, batch.startedAt))
        try check(sqlite3_bind_int64(statement, 3, batch.completedAt))
        try check(sqlite3_bind_int64(statement, 4, batch.totalFiles))
        try check(sqlite3_bind_int64(statement, 5, batch.successCount))
        try check(sqlite3_bind_int64(statement, 6, batch.failedCount))
        try bind(batch.status, to: 7, statement: statement)
        try finish(statement, message: "保存转换批次失败")
        return Int(sqlite3_changes(database))
    }

    private func requireIdenticalRecord(_ record: ConversionRecord) throws {
        let statement = try prepare("SELECT batch_id, position, title, magnet, converted_at FROM batch_records WHERE id = ?")
        defer { sqlite3_finalize(statement) }
        try bind(record.id, to: 1, statement: statement)
        guard try next(statement, message: "读取转换记录失败"),
              text(statement, column: 0) == record.batchId, sqlite3_column_int64(statement, 1) == record.position,
              text(statement, column: 2) == record.title, text(statement, column: 3) == record.magnet,
              sqlite3_column_int64(statement, 4) == record.convertedAt else {
            throw HistoryStorageError(message: "转换记录标识重复且内容不一致，未写入该批记录。")
        }
    }

    private func requireIdenticalOperation(_ operation: HistoryOperation) throws {
        let statement = try prepare("SELECT action, detail, item_count, created_at, success, batch_id FROM operation_history WHERE id = ?")
        defer { sqlite3_finalize(statement) }
        try bind(operation.id, to: 1, statement: statement)
        guard try next(statement, message: "读取操作记录失败") else {
            throw HistoryStorageError(message: "操作记录标识冲突。")
        }
        let batchId: String? = sqlite3_column_type(statement, 5) == SQLITE_NULL ? nil : text(statement, column: 5)
        guard text(statement, column: 0) == operation.action, text(statement, column: 1) == operation.detail,
              sqlite3_column_int64(statement, 2) == operation.count, sqlite3_column_int64(statement, 3) == operation.createdAt,
              (sqlite3_column_int(statement, 4) != 0) == operation.success, batchId == operation.batchId else {
            throw HistoryStorageError(message: "操作记录标识重复且内容不一致，未写入该批操作。")
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
            try execute("PRAGMA foreign_keys=ON")
            // Additive migration: keep original timestamps and never infer batches for old records.
            try transaction {
                try execute("CREATE TABLE IF NOT EXISTS conversion_history (id TEXT PRIMARY KEY NOT NULL, title TEXT NOT NULL, magnet TEXT NOT NULL, converted_at INTEGER NOT NULL) WITHOUT ROWID")
                try execute("CREATE INDEX IF NOT EXISTS conversion_history_time ON conversion_history (converted_at DESC, id DESC)")
                try execute("CREATE TABLE IF NOT EXISTS conversion_batches (id TEXT PRIMARY KEY NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER NOT NULL, total_files INTEGER NOT NULL, success_count INTEGER NOT NULL, failed_count INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('running', 'completed'))) WITHOUT ROWID")
                try execute("CREATE INDEX IF NOT EXISTS conversion_batches_time ON conversion_batches (started_at DESC, id DESC)")
                try execute("CREATE TABLE IF NOT EXISTS batch_records (id TEXT PRIMARY KEY NOT NULL, batch_id TEXT NOT NULL REFERENCES conversion_batches(id) ON DELETE CASCADE, position INTEGER NOT NULL, title TEXT NOT NULL, magnet TEXT NOT NULL, converted_at INTEGER NOT NULL, UNIQUE(batch_id, position)) WITHOUT ROWID")
                try execute("CREATE TABLE IF NOT EXISTS operation_history (id TEXT PRIMARY KEY NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL, item_count INTEGER NOT NULL, created_at INTEGER NOT NULL, success INTEGER NOT NULL CHECK(success IN (0, 1)), batch_id TEXT) WITHOUT ROWID")
                try execute("CREATE INDEX IF NOT EXISTS operation_history_time ON operation_history (created_at DESC, id DESC)")
            }
        } catch {
            // A failed rollback may already have closed the connection.
            if let database { sqlite3_close_v2(database) }
            database = nil
            throw error
        }
    }

    private func performMaintenance() {
        guard !closed else { return }
        do {
            try openIfNeeded()
            if try pruneTransaction() > 0 { onChange() }
        } catch {
            // Interactive requests retry maintenance and return the error to the UI.
            NSLog("转换历史自动清理失败：%@", error.localizedDescription)
        }
    }

    private func pruneTransaction() throws -> Int {
        var removed = 0
        try transaction { removed = try prune(before: currentMilliseconds() - retentionMilliseconds) }
        return removed
    }

    private func prune(before cutoff: Int64) throws -> Int {
        var removed = 0
        // Batch records cascade with their parent; a batch is never split by individual timestamps.
        for sql in ["DELETE FROM conversion_batches WHERE started_at < ?", "DELETE FROM conversion_history WHERE converted_at < ?", "DELETE FROM operation_history WHERE created_at < ?"] {
            let statement = try prepare(sql)
            defer { sqlite3_finalize(statement) }
            try check(sqlite3_bind_int64(statement, 1, cutoff))
            try finish(statement, message: "清理过期历史记录失败")
            removed += Int(sqlite3_changes(database))
        }
        return removed
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
        guard sqlite3_exec(database, sql, nil, nil, nil) == SQLITE_OK else { throw databaseError("更新历史记录失败") }
    }

    private func prepare(_ sql: String) throws -> OpaquePointer {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
            throw databaseError("读取历史记录失败")
        }
        return statement
    }

    private func next(_ statement: OpaquePointer, message: String) throws -> Bool {
        let status = sqlite3_step(statement)
        if status == SQLITE_DONE { return false }
        guard status == SQLITE_ROW else { throw databaseError(message) }
        return true
    }

    private func finish(_ statement: OpaquePointer, message: String) throws {
        guard sqlite3_step(statement) == SQLITE_DONE else { throw databaseError(message) }
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
        guard code == SQLITE_OK else { throw databaseError("处理历史记录失败") }
    }

    private func databaseError(_ operation: String) -> HistoryStorageError {
        let reason = database.map { String(cString: sqlite3_errmsg($0)) } ?? "数据库未打开"
        return HistoryStorageError(message: "\(operation)：\(reason)")
    }

    private func currentMilliseconds() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}
