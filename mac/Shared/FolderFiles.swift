import Foundation

/// The folder itself: every op of docs/BRIDGE.md, 2, on FileManager. No state
/// but the root, so it is safe on the bridge's queue.
struct FolderFiles {
    let root: URL
    private let realRoot: String

    static let ignored: Set<String> = [".obsidian", ".trash", ".git", ".stfolder", ".stversions", "node_modules"]
    static let tempSuffix = ".dvarim-tmp"

    init(root: URL) {
        self.root = root.standardizedFileURL
        realRoot = root.resolvingSymlinksInPath().path
    }

    struct BridgeError: Error {
        let code: String
        let message: String
    }

    static func failure(_ code: String, _ message: String) -> [String: Any] {
        ["error": ["code": code, "message": message]]
    }

    func answer(op: String, args: [String: Any]) -> [String: Any] {
        do {
            switch op {
            case "list": return ["ok": try list()]
            case "read": return ["ok": orNull(try read(string(args, "path")))]
            case "readMany":
                guard let paths = args["paths"] as? [String] else { throw BridgeError(code: "EINVAL", message: "paths must be a list") }
                return ["ok": try paths.map { orNull(try read($0)) }]
            case "write":
                guard let text = args["text"] as? String else { throw BridgeError(code: "EINVAL", message: "text must be a string") }
                return ["ok": try write(string(args, "path"), text)]
            case "remove": try remove(string(args, "path")); return ["ok": NSNull()]
            case "move": try move(string(args, "from"), string(args, "to")); return ["ok": NSNull()]
            case "mkdir": try mkdir(string(args, "path")); return ["ok": NSNull()]
            case "removeDir": return ["ok": try removeDir(string(args, "path"))]
            default: throw BridgeError(code: "ENOSYS", message: "no such operation: \(op)")
            }
        } catch let e as BridgeError {
            return Self.failure(e.code, e.message)
        } catch let e as CocoaError where e.code == .fileWriteOutOfSpace {
            return Self.failure("ENOSPC", "the disk is full")
        } catch let e as CocoaError where [.fileReadNoPermission, .fileWriteNoPermission].contains(e.code) {
            return Self.failure("EACCES", "Dvarim may not write to \(root.lastPathComponent): \(e.localizedDescription)")
        } catch {
            return Self.failure("EIO", error.localizedDescription)
        }
    }

    private func orNull(_ value: [String: Any]?) -> Any {
        if let value { return value }
        return NSNull()
    }

    private func string(_ args: [String: Any], _ key: String) throws -> String {
        guard let s = args[key] as? String else { throw BridgeError(code: "EINVAL", message: "\(key) must be a string") }
        return s
    }

    /// A vault path as a URL inside the root, or EINVAL (docs/BRIDGE.md, Paths).
    func url(_ path: String) throws -> URL {
        let segments = path.split(separator: "/", omittingEmptySubsequences: false)
        if path.isEmpty || path.hasPrefix("/") || path.contains("\\") || path.contains("\0")
            || segments.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) {
            throw BridgeError(code: "EINVAL", message: "not a path inside the vault: \(path)")
        }
        let url = root.appendingPathComponent(path)
        let real = url.resolvingSymlinksInPath().path
        guard real == realRoot || real.hasPrefix(realRoot + "/") else {
            throw BridgeError(code: "EINVAL", message: "outside the vault: \(path)")
        }
        return url
    }

    private func isDirectory(_ url: URL) -> Bool? {
        var isDir: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir) ? isDir.boolValue : nil
    }

    func list() throws -> [String: Any] {
        var files: [String] = [], dirs: [String] = []
        // Relative paths as the disk has them. A URL's standardizedFileURL
        // decomposes Café.md on the way out, as creating it would on the way in.
        guard let walk = FileManager.default.enumerator(atPath: root.path) else {
            throw BridgeError(code: "EACCES", message: "cannot read \(root.lastPathComponent)")
        }
        while let rel = walk.nextObject() as? String {
            if walk.fileAttributes?[.type] as? FileAttributeType == .typeDirectory {
                dirs.append(rel)
                if Self.ignored.contains((rel as NSString).lastPathComponent) { walk.skipDescendants() }   // listed, not looked inside
            } else if !rel.hasSuffix(Self.tempSuffix) {
                files.append(rel)
            }
        }
        return ["files": files, "dirs": dirs]
    }

    func read(_ path: String) throws -> [String: Any]? {
        let url = try url(path)
        guard isDirectory(url) == false else { return nil }
        let data = try Data(contentsOf: url)
        // decoding: invalid bytes become U+FFFD; a BOM and \r\n are kept as they are
        return ["text": String(decoding: data, as: UTF8.self), "mtime": mtime(url)]
    }

    // Names go to disk exactly as the page wrote them. When Foundation creates
    // something it goes through the path's "file system representation", which
    // decomposes: Café.md, written with é as one code point, landed on disk as
    // e plus a combining accent — another name to Syncthing, to the server on
    // the far side of it, and to the page's own next listing. rename(2) and
    // mkdir(2) take the bytes as they are, so whatever creates a name goes
    // through them. Reading, statting and removing may stay with Foundation:
    // APFS finds a name however it is composed.

    func write(_ path: String, _ text: String) throws -> [String: Any] {
        let url = try url(path)
        try makeDirectories(parent(of: path))
        // exactly these bytes, atomically: written beside it under a name of
        // our own, then renamed over it
        let temp = url.deletingLastPathComponent().appendingPathComponent(".\(UUID().uuidString)\(Self.tempSuffix)")
        try Data(text.utf8).write(to: temp)
        do {
            try posix("save", rename(temp.path, full(path)), path)
        } catch {
            try? FileManager.default.removeItem(at: temp)
            throw error
        }
        return ["mtime": mtime(url)]
    }

    func remove(_ path: String) throws {
        let url = try url(path)
        if isDirectory(url) == false { try FileManager.default.removeItem(at: url) }
    }

    func move(_ from: String, _ to: String) throws {
        let a = try url(from), b = try url(to)
        guard let fromIsDir = isDirectory(a) else { throw BridgeError(code: "ENOENT", message: "not there: \(from)") }
        if let toIsDir = isDirectory(b) {
            // a folder may take an empty folder's place, as rename(2) lets it; nothing else is replaced
            let empty = toIsDir && ((try? FileManager.default.contentsOfDirectory(atPath: b.path).isEmpty) ?? false)
            guard fromIsDir && empty else { throw BridgeError(code: "EEXIST", message: "already there: \(to)") }
            try FileManager.default.removeItem(at: b)
        }
        try makeDirectories(parent(of: to))
        try posix("move", rename(full(from), full(to)), to)
    }

    func mkdir(_ path: String) throws {
        _ = try url(path)
        try makeDirectories(path)
    }

    /// The path on disk, as a string whose bytes are the ones the page sent.
    private func full(_ path: String) -> String { root.path + "/" + path }

    private func parent(of path: String) -> String {
        path.split(separator: "/").dropLast().joined(separator: "/")
    }

    /// Every directory along `path`, made where missing, each under its name as given.
    private func makeDirectories(_ path: String) throws {
        var so = ""
        for part in path.split(separator: "/") {
            so = so.isEmpty ? String(part) : so + "/" + part
            switch isDirectory(root.appendingPathComponent(so)) {
            case true?: continue
            case false?: throw BridgeError(code: "EEXIST", message: "a file is where a folder should be: \(so)")
            case nil: try posix("make the folder", Darwin.mkdir(full(so), 0o755), so)
            }
        }
    }

    /// A POSIX call's result, as the bridge's errors.
    private func posix(_ what: String, _ result: Int32, _ path: String) throws {
        guard result != 0 else { return }
        let e = errno
        switch e {
        case EACCES, EPERM, EROFS:
            throw BridgeError(code: "EACCES", message: "Dvarim may not \(what) \(path) in \(root.lastPathComponent)")
        case ENOSPC, EDQUOT:
            throw BridgeError(code: "ENOSPC", message: "the disk is full")
        default:
            throw BridgeError(code: "EIO", message: "could not \(what) \(path): \(String(cString: strerror(e)))")
        }
    }

    func removeDir(_ path: String) throws -> Bool {
        let url = try url(path)
        guard isDirectory(url) == true else { return true }
        if !(try FileManager.default.contentsOfDirectory(atPath: url.path)).isEmpty { return false }
        try FileManager.default.removeItem(at: url)
        return true
    }

    private func mtime(_ url: URL) -> Double {
        let date = (try? FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate]) as? Date
        return (date ?? Date()).timeIntervalSince1970 * 1000
    }
}
