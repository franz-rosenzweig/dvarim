using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Dvarim.Core;

/// <summary>
/// The few calls .NET doesn't make itself: where a path really leads, whether two
/// paths are one file, and a move that replaces a file in one step (or renames
/// one only by case) and says why when it can't.
/// </summary>
static class Win32
{
    public const int ERROR_FILE_NOT_FOUND = 2, ERROR_PATH_NOT_FOUND = 3, ERROR_ACCESS_DENIED = 5, ERROR_WRITE_PROTECT = 19,
        ERROR_SHARING_VIOLATION = 32, ERROR_LOCK_VIOLATION = 33, ERROR_HANDLE_DISK_FULL = 39, ERROR_FILE_EXISTS = 80,
        ERROR_DISK_FULL = 112, ERROR_ALREADY_EXISTS = 183;

    const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;   // lets a folder be opened too
    const uint MOVEFILE_REPLACE_EXISTING = 0x1;
    const uint INVALID_FILE_ATTRIBUTES = 0xFFFFFFFF;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafeFileHandle CreateFileW(string name, uint access, FileShare share, IntPtr security, FileMode mode, uint flags, IntPtr template);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle file, [Out] char[] path, uint length, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle file, out ByHandleFileInformation info);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool MoveFileExW(string from, string to, uint flags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern uint GetFileAttributesW(string name);

    [StructLayout(LayoutKind.Sequential)]
    struct ByHandleFileInformation
    {
        public uint FileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime, LastAccessTime, LastWriteTime;
        public uint VolumeSerialNumber, FileSizeHigh, FileSizeLow, NumberOfLinks, FileIndexHigh, FileIndexLow;
    }

    /// <summary>A path the Win32 calls take whatever its length (.NET's own calls do this themselves).</summary>
    static string Long(string path) =>
        path.Length < 248 || path.StartsWith(@"\\?\", StringComparison.Ordinal) ? path
        : path.StartsWith(@"\\", StringComparison.Ordinal) ? @"\\?\UNC\" + path[2..]
        : @"\\?\" + path;

    static SafeFileHandle Open(string path) =>
        CreateFileW(Long(path), 0, FileShare.ReadWrite | FileShare.Delete, IntPtr.Zero, FileMode.Open, FILE_FLAG_BACKUP_SEMANTICS, IntPtr.Zero);

    /// <summary>Something is there, a link to nowhere included.</summary>
    static bool Exists(string path) => GetFileAttributesW(Long(path)) != INVALID_FILE_ATTRIBUTES;

    /// <summary>Where a path that exists really is, every link and junction followed; null if it can't be opened.</summary>
    public static string? FinalPath(string path)
    {
        using var file = Open(path);
        if (file.IsInvalid) return null;
        var buffer = new char[512];
        var n = GetFinalPathNameByHandleW(file, buffer, (uint)buffer.Length, 0);
        if (n >= buffer.Length)
        {
            buffer = new char[n + 1];
            n = GetFinalPathNameByHandleW(file, buffer, (uint)buffer.Length, 0);
        }
        if (n == 0 || n >= buffer.Length) return null;
        var s = new string(buffer, 0, (int)n);
        return s.StartsWith(@"\\?\UNC\", StringComparison.Ordinal) ? @"\\" + s[8..]
            : s.StartsWith(@"\\?\", StringComparison.Ordinal) ? s[4..]
            : s;
    }

    /// <summary>
    /// The path with every link along it followed, as far as the disk has it, and
    /// the rest as given: how a path is checked to stay inside the folder.
    /// </summary>
    public static string Resolve(string path)
    {
        var rest = new List<string>();
        var at = path;
        while (true)
        {
            if (Exists(at))
            {
                var final = FinalPath(at)
                    ?? throw new FolderFiles.BridgeError("EINVAL", $"cannot follow {at}: a link that leads nowhere, or a place Dvarim may not look");
                if (rest.Count == 0) return final;
                rest.Reverse();
                return (final.EndsWith('\\') ? final : final + "\\") + string.Join('\\', rest);
            }
            var parent = Path.GetDirectoryName(at);
            if (parent == null) return path;           // not even the drive is there
            rest.Add(Path.GetFileName(at));
            at = parent;
        }
    }

    /// <summary>Two paths to one file or folder: on a disk that ignores case, "draft.md" and "Draft.md".</summary>
    public static bool SameFile(string a, string b) =>
        Identity(a) is { } x && Identity(b) is { } y && x.Equals(y);

    static (uint, uint, uint)? Identity(string path)
    {
        using var file = Open(path);
        if (file.IsInvalid || !GetFileInformationByHandle(file, out var info)) return null;
        return (info.VolumeSerialNumber, info.FileIndexHigh, info.FileIndexLow);
    }

    /// <summary>A move, or with <c>replace</c> a file swapped in for another in one step; 0, or the Win32 error.</summary>
    public static int Move(string from, string to, bool replace)
    {
        for (var i = 0; ; i++)
        {
            if (MoveFileExW(Long(from), Long(to), replace ? MOVEFILE_REPLACE_EXISTING : 0)) return 0;
            var error = Marshal.GetLastPInvokeError();
            if (i >= 5 || !Busy(error)) return error;
            Thread.Sleep(15 << i);
        }
    }

    /// <summary>Errors that another app holding the file for a moment gives, and that waiting can cure.</summary>
    public static bool Busy(int error) => error is ERROR_SHARING_VIOLATION or ERROR_LOCK_VIOLATION or ERROR_ACCESS_DENIED;

    public static string CodeFor(int error) => error switch
    {
        ERROR_ACCESS_DENIED or ERROR_SHARING_VIOLATION or ERROR_LOCK_VIOLATION or ERROR_WRITE_PROTECT => "EACCES",
        ERROR_DISK_FULL or ERROR_HANDLE_DISK_FULL => "ENOSPC",
        ERROR_FILE_NOT_FOUND or ERROR_PATH_NOT_FOUND => "ENOENT",
        ERROR_FILE_EXISTS or ERROR_ALREADY_EXISTS => "EEXIST",
        _ => "EIO",
    };

    public static string Message(int error) => new Win32Exception(error).Message.TrimEnd('.');
}
