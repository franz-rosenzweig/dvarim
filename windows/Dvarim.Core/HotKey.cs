using System.Globalization;

namespace Dvarim.Core;

/// <summary>
/// Quick Entry's shortcut, as RegisterHotKey takes it and as Settings writes it:
/// "Ctrl+Alt+Space". It needs Ctrl, Alt or the Windows key, as the Mac's needs ⌃,
/// ⌥ or ⌘, so that it never takes a key someone types with.
/// </summary>
public readonly record struct HotKey(uint Modifiers, uint Key)
{
    public const uint Alt = 0x1, Control = 0x2, Shift = 0x4, Win = 0x8;

    /// <summary>Ctrl+Alt+Space. The Mac's ⌃Space is Ctrl+Space here, which switches the keyboard's language on Chinese, Japanese and Korean layouts.</summary>
    public static readonly HotKey Default = new(Control | Alt, 0x20);

    public bool IsUsable => (Modifiers & (Control | Alt | Win)) != 0 && Name(Key) != null;

    public static HotKey? Parse(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        uint modifiers = 0;
        uint? key = null;
        foreach (var part in text.Split('+', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
        {
            switch (part.ToLowerInvariant())
            {
                case "ctrl" or "control": modifiers |= Control; break;
                case "alt": modifiers |= Alt; break;
                case "shift": modifiers |= Shift; break;
                case "win" or "windows": modifiers |= Win; break;
                default:
                    if (key != null) return null;
                    key = KeyOf(part);
                    if (key == null) return null;
                    break;
            }
        }
        if (key == null) return null;
        var hotKey = new HotKey(modifiers, key.Value);
        return hotKey.IsUsable ? hotKey : null;
    }

    public override string ToString()
    {
        var parts = new List<string>();
        if ((Modifiers & Control) != 0) parts.Add("Ctrl");
        if ((Modifiers & Alt) != 0) parts.Add("Alt");
        if ((Modifiers & Shift) != 0) parts.Add("Shift");
        if ((Modifiers & Win) != 0) parts.Add("Win");
        parts.Add(Name(Key) ?? $"0x{Key:X2}");
        return string.Join('+', parts);
    }

    /// <summary>A key's name, for the keys a shortcut may end in; null for any other.</summary>
    public static string? Name(uint key) => key switch
    {
        0x20 => "Space",
        >= 0x30 and <= 0x39 => ((char)key).ToString(),
        >= 0x41 and <= 0x5A => ((char)key).ToString(),
        >= 0x70 and <= 0x7B => "F" + (key - 0x6F).ToString(CultureInfo.InvariantCulture),
        0x0D => "Enter",
        0x2D => "Insert",
        0x24 => "Home",
        0x23 => "End",
        0x21 => "PageUp",
        0x22 => "PageDown",
        _ => null,
    };

    static uint? KeyOf(string name)
    {
        var n = name.ToUpperInvariant();
        if (n.Length == 1 && (char.IsAsciiLetterUpper(n[0]) || char.IsAsciiDigit(n[0]))) return n[0];
        if (n.Length is 2 or 3 && n[0] == 'F' && int.TryParse(n[1..], NumberStyles.None, CultureInfo.InvariantCulture, out var f) && f is >= 1 and <= 12)
            return (uint)(0x6F + f);
        return n switch
        {
            "SPACE" => 0x20,
            "ENTER" or "RETURN" => 0x0D,
            "INSERT" => 0x2D,
            "HOME" => 0x24,
            "END" => 0x23,
            "PAGEUP" => 0x21,
            "PAGEDOWN" => 0x22,
            _ => null,
        };
    }
}
