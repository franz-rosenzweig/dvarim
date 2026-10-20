import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.KeyStore;
import java.util.*;

/**
 * Says what is wrong with keystore.properties without ever saying what is in it.
 *
 *     ./shell/check-keystore.sh
 *
 * It loads the file the way Gradle does (java.util.Properties, where a backslash
 * is an escape and a trailing space is part of the value), tries what it finds
 * against the keystore, and prints a diagnosis: never a password, nor its length.
 */
public class CheckKeystore {
    public static void main(String[] a) throws Exception {
        Path file = Paths.get("keystore.properties");
        if (!Files.exists(file)) { System.out.println("no keystore.properties here: copy keystore.properties.example"); return; }
        Properties p = new Properties();
        try (InputStream in = Files.newInputStream(file)) { p.load(in); }

        // The raw lines, for the traps that Properties.load() falls into silently.
        for (String line : Files.readAllLines(file, StandardCharsets.ISO_8859_1)) {
            for (String k : new String[]{"storePassword", "keyPassword"}) {
                if (!line.startsWith(k)) continue;
                String raw = line.substring(k.length()).replaceFirst("^\\s*[=:]\\s*", "");
                List<String> odd = new ArrayList<>();
                // Present but empty is not the same as absent: Gradle's fallback to
                // storePassword only applies when the line is not there at all.
                if (raw.isEmpty()) odd.add(k.equals("keyPassword")
                    ? "it is EMPTY, which means an empty password, not \"same as the store's\" — delete the line"
                    : "it is EMPTY");
                if (!raw.equals(raw.stripTrailing())) odd.add("it ends with a space or tab, which becomes part of the password");
                if (raw.contains("\\")) odd.add("it contains a backslash, which Java reads as an escape: write each one as \\\\");
                if (raw.matches("^[\"'].*[\"']$")) odd.add("it is wrapped in quotes, which become part of the password: remove them");
                if (line.endsWith("\r")) odd.add("the line ends in a Windows carriage return");
                if (!raw.chars().allMatch(c -> c < 128)) odd.add("it has non-ASCII characters; the file is read as ISO-8859-1, so write them as \\uXXXX");
                System.out.println(k + ": " + (odd.isEmpty() ? "nothing odd about how it is written" : String.join("; ", odd)));
            }
        }

        Path store = Paths.get(p.getProperty("storeFile", "android.keystore"));
        String alias = p.getProperty("keyAlias", "dvarim");
        System.out.println("storeFile: " + store + (Files.exists(store) ? "" : "  <-- NOT FOUND"));
        if (!Files.exists(store)) return;

        String sp = p.getProperty("storePassword"), kp = p.getProperty("keyPassword", sp);
        if (sp == null) { System.out.println("storePassword is missing"); return; }
        boolean same = sp.equals(kp);

        KeyStore ks = open(store, sp);
        String how = "storePassword";
        if (ks == null && !same) { ks = open(store, kp); how = "keyPassword"; }
        if (ks == null) {
            System.out.println("RESULT: neither value in the file opens the keystore. The store password itself is wrong:");
            System.out.println("        it is whatever you typed when the keystore was made (bubblewrap init), not a new one.");
            return;
        }
        if (how.equals("keyPassword")) System.out.println("the keystore opens with the value given as keyPassword, not storePassword");
        else System.out.println("storePassword: opens the keystore");

        List<String> aliases = Collections.list(ks.aliases());
        if (!ks.containsAlias(alias)) { System.out.println("RESULT: no key called '" + alias + "' in it; it has: " + aliases); return; }

        String keyHow = null;
        for (String[] c : new String[][]{{"keyPassword", kp}, {"storePassword", sp}}) {
            try { if (ks.getKey(alias, c[1].toCharArray()) != null) { keyHow = c[0]; break; } } catch (Exception e) { /* wrong one */ }
        }
        if (keyHow == null) System.out.println("RESULT: the keystore opens, but neither value unlocks the key '" + alias + "'. The key password is wrong.");
        else if (how.equals("storePassword") && keyHow.equals("keyPassword")) System.out.println("RESULT: both are right. Signing should work.");
        else if (how.equals("keyPassword") && keyHow.equals("storePassword")) System.out.println("RESULT: the two values are SWAPPED: exchange them and it will sign.");
        else System.out.println("RESULT: the store opens with '" + how + "' and the key unlocks with '" + keyHow
                + "': both passwords are that same value. Put it on both lines (or delete the keyPassword line).");
    }

    static KeyStore open(Path store, String password) {
        for (String type : new String[]{"PKCS12", "JKS"}) {
            try (InputStream in = Files.newInputStream(store)) {
                KeyStore ks = KeyStore.getInstance(type);
                ks.load(in, password.toCharArray());
                return ks;
            } catch (Exception e) { /* wrong password, or the other format */ }
        }
        return null;
    }
}
