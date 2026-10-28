using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace Dvarim.Core;

/// <summary>
/// Windows Credential Manager, for the copy's device token: a generic credential
/// for this user on this PC (Control Panel › Credential Manager › Windows
/// Credentials lists it), never in the copy, which syncs, and never in the
/// settings file. The Mac keeps its token in a file only its account can read,
/// Android in the app's private storage.
/// </summary>
public static class Credentials
{
    const uint CRED_TYPE_GENERIC = 1;
    const uint CRED_PERSIST_LOCAL_MACHINE = 2;      // this user, this PC: not carried to other PCs
    const int ERROR_NOT_FOUND = 1168;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct Credential
    {
        public uint Flags;
        public uint Type;
        public string TargetName;
        public string? Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        public string? TargetAlias;
        public string? UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredWrite(ref Credential credential, uint flags);

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CredDelete(string target, uint type, uint flags);

    [DllImport("advapi32.dll")]
    static extern void CredFree(IntPtr buffer);

    /// <summary>Keep a secret under a name; an error says why if Windows won't.</summary>
    public static void Write(string target, string user, string secret)
    {
        var bytes = Encoding.Unicode.GetBytes(secret);
        var blob = Marshal.AllocHGlobal(Math.Max(bytes.Length, 1));
        try
        {
            Marshal.Copy(bytes, 0, blob, bytes.Length);
            var credential = new Credential
            {
                Type = CRED_TYPE_GENERIC,
                TargetName = target,
                UserName = user,
                Comment = "Dvarim for Windows: this PC's token for syncing with the server",
                CredentialBlob = blob,
                CredentialBlobSize = (uint)bytes.Length,
                Persist = CRED_PERSIST_LOCAL_MACHINE,
            };
            if (!CredWrite(ref credential, 0)) throw new Win32Exception(Marshal.GetLastPInvokeError());
        }
        finally
        {
            Marshal.FreeHGlobal(blob);
        }
    }

    /// <summary>The secret kept under a name, or null if there is none.</summary>
    public static string? Read(string target)
    {
        if (!CredRead(target, CRED_TYPE_GENERIC, 0, out var found)) return null;
        try
        {
            var credential = Marshal.PtrToStructure<Credential>(found);
            if (credential.CredentialBlob == IntPtr.Zero || credential.CredentialBlobSize == 0) return "";
            var bytes = new byte[credential.CredentialBlobSize];
            Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
            return Encoding.Unicode.GetString(bytes);
        }
        finally
        {
            CredFree(found);
        }
    }

    /// <summary>Forget it. Quiet if there was none.</summary>
    public static void Delete(string target)
    {
        if (!CredDelete(target, CRED_TYPE_GENERIC, 0) && Marshal.GetLastPInvokeError() is var error && error != ERROR_NOT_FOUND)
            throw new Win32Exception(error);
    }
}
