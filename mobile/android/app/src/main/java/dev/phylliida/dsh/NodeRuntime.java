package dev.phylliida.dsh;

import android.content.Context;
import android.system.Os;
import android.system.ErrnoException;

import java.io.BufferedInputStream;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.GZIPInputStream;

/**
 * Owns the on-device harness host process: extracts the bundled runtime.tgz
 * (Termux Node + deployed web-host closure) into app-private storage on first
 * run or version change, then spawns `dsh --profile web --port 0` and watches
 * stdout for the readiness line `dsh web: http://127.0.0.1:<port>`.
 *
 * Extraction lands in getFilesDir()/runtime — ext4/f2fs, so symlinks and
 * exec work (targetSdk 28 keeps exec from app-private storage legal). The
 * DSH_HOME the user picks lives on shared storage and is passed as cwd for
 * the agent workspace; the harness home itself stays internal because the
 * profile fallback requires symlink support that sdcardfs cannot give.
 */
public final class NodeRuntime {

    public enum Stage { IDLE, EXTRACTING, STARTING, RUNNING, FAILED }

    public interface Listener { void onChanged(); }

    private static final NodeRuntime INSTANCE = new NodeRuntime();
    public static NodeRuntime get() { return INSTANCE; }

    private static final Pattern READY = Pattern.compile("dsh web: http://127\\.0\\.0\\.1:(\\d+)");
    private static final int LOG_LINES = 200;

    private Stage stage = Stage.IDLE;
    private Integer port = null;
    private String error = null;
    private final ArrayDeque<String> log = new ArrayDeque<>();
    private final List<Listener> listeners = new ArrayList<>();
    private Process process = null;

    private NodeRuntime() {}

    public synchronized void addListener(Listener l) { listeners.add(l); }
    public synchronized void removeListener(Listener l) { listeners.remove(l); }
    public synchronized Stage getStage() { return stage; }
    public synchronized Integer getPort() { return port; }
    public synchronized String getError() { return error; }

    public synchronized String getLogTail() {
        StringBuilder sb = new StringBuilder();
        for (String line : log) sb.append(line).append('\n');
        return sb.toString();
    }

    private synchronized void set(Stage s, String err) {
        stage = s;
        error = err;
        for (Listener l : new ArrayList<>(listeners)) l.onChanged();
    }

    private synchronized void appendLog(String line) {
        log.addLast(line);
        while (log.size() > LOG_LINES) log.removeFirst();
        Matcher m = READY.matcher(line);
        if (m.find()) {
            port = Integer.valueOf(m.group(1));
            set(Stage.RUNNING, null);
        } else {
            for (Listener l : new ArrayList<>(listeners)) l.onChanged();
        }
    }

    /** Start extraction (if needed) + node spawn on a worker thread. Idempotent. */
    public synchronized void ensureStarted(Context context, String dshHome, String workspace) {
        if (stage == Stage.EXTRACTING || stage == Stage.STARTING || stage == Stage.RUNNING) return;
        final Context app = context.getApplicationContext();
        final String home = dshHome;
        final String cwd = workspace;
        set(Stage.STARTING, null);
        Thread t = new Thread(() -> runNode(app, home, cwd), "dsh-node");
        t.start();
    }

    public synchronized void stop() {
        if (process != null) process.destroy();
        process = null;
        port = null;
        set(Stage.IDLE, null);
    }

    private void runNode(Context app, String dshHome, String workspace) {
        try {
            File runtimeDir = new File(app.getFilesDir(), "runtime");
            ensureExtracted(app, runtimeDir);
            File rootfsUsr = new File(runtimeDir, "rootfs/data/data/com.termux/files/usr");
            File deploy = new File(runtimeDir, "deploy");
            File node = new File(rootfsUsr, "bin/node");
            if (!node.isFile()) throw new IOException("node binary missing: " + node);

            File homeDir = new File(app.getFilesDir(), "home");
            File tmpDir = new File(app.getFilesDir(), "tmp");
            File dshHomeDir = new File(dshHome);
            File workDir = new File(workspace);
            //noinspection ResultOfMethodCallIgnored
            homeDir.mkdirs(); tmpDir.mkdirs(); dshHomeDir.mkdirs(); workDir.mkdirs();

            File binJs = new File(deploy, "node_modules/@deepseek-ai/dsh/lib/bin.js");
            killStaleHosts(binJs.getAbsolutePath());

            List<String> cmd = new ArrayList<>();
            cmd.add(node.getAbsolutePath());
            // Required by the vendored cordis loader: profile-plugin names resolve
            // through Node's internal module loader against the profile baseUrl.
            cmd.add("--expose-internals");
            cmd.add(binJs.getAbsolutePath());
            // --patch is a launcher flag and must precede the first unknown
            // token; everything after --port passes through to the web app.
            cmd.add("--profile");
            cmd.add("web");
            cmd.add("--patch");
            cmd.add(new File(deploy, "mobile.cordis.patch.yml").getAbsolutePath());
            cmd.add("--port");
            cmd.add("0");

            ProcessBuilder pb = new ProcessBuilder(cmd);
            Map<String, String> env = pb.environment();
            env.clear();
            env.put("HOME", homeDir.getAbsolutePath());
            env.put("TMPDIR", tmpDir.getAbsolutePath());
            env.put("DSH_HOME", dshHomeDir.getAbsolutePath());
            env.put("LD_LIBRARY_PATH", new File(rootfsUsr, "lib").getAbsolutePath());
            env.put("PATH", "/system/bin:/system/xbin");
            env.put("SHELL", "/system/bin/sh");
            env.put("LANG", "en_US.UTF-8");
            // Belt-and-braces next to the mobile patch layer; telemetry is off by default already.
            env.put("DSH_TELEMETRY_DISABLED", "1");
            pb.directory(workDir);
            pb.redirectErrorStream(true);

            synchronized (this) { process = pb.start(); }
            set(Stage.STARTING, null);

            try (BufferedReader reader = new BufferedReader(
                    new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) appendLog(line);
            }
            int code;
            synchronized (this) { code = process != null ? process.exitValue() : -1; }
            if (port == null) set(Stage.FAILED, "node exited with code " + code + " before reporting a port");
            else set(Stage.FAILED, "node exited with code " + code);
        } catch (Exception e) {
            // Chain causes into the message: the ErrnoException errno is the
            // only signal that pinpoints extraction/link failures on device.
            StringBuilder msg = new StringBuilder("node start failed: ").append(e);
            for (Throwable c = e.getCause(); c != null; c = c.getCause()) {
                msg.append(" ← ").append(c);
            }
            android.util.Log.e("dsh-node", msg.toString(), e);
            appendLog(msg.toString());
            set(Stage.FAILED, msg.toString());
        }
    }

    // ---- extraction ----

    /**
     * SIGKILL node hosts orphaned by earlier app instances before spawning a
     * fresh one. An orphaned host keeps its announced loopback port LISTENing
     * but wedged — it accepts connections and never answers, so any UI surface
     * still holding its URL stalls every RPC past the client's abort deadline
     * ("signal timed out"). Matches the deployed bin.js path in
     * /proc/<pid>/cmdline; only same-uid processes are visible and killable, so
     * a zombie from a previous install (different uid) clears only on reboot.
     */
    private static void killStaleHosts(String binJsPath) {
        File[] procs = new File("/proc").listFiles();
        if (procs == null) return;
        int self = android.os.Process.myPid();
        for (File procEntry : procs) {
            String name = procEntry.getName();
            int pid = -1;
            try { pid = Integer.parseInt(name); }
            catch (NumberFormatException notAPidDir) { continue; }
            if (pid == self) continue;
            String cmdline;
            try (FileInputStream in = new FileInputStream(new File(procEntry, "cmdline"))) {
                byte[] buf = new byte[4096];
                int n = in.read(buf);
                cmdline = n > 0 ? new String(buf, 0, n, StandardCharsets.UTF_8) : "";
            } catch (IOException unreadable) {
                continue; // another uid's process: neither readable nor killable
            }
            if (!cmdline.contains(binJsPath)) continue;
            android.util.Log.w("dsh-node", "killing stale node host pid " + pid);
            android.os.Process.sendSignal(pid, android.system.OsConstants.SIGKILL);
        }
    }

    private void ensureExtracted(Context app, File runtimeDir) throws IOException {
        String version = BuildConfig.VERSION_NAME;
        File marker = new File(runtimeDir, ".extracted-" + version);
        if (marker.isFile()) return;
        set(Stage.EXTRACTING, null);
        deleteRecursively(runtimeDir);
        //noinspection ResultOfMethodCallIgnored
        runtimeDir.mkdirs();
        try (InputStream in = new GZIPInputStream(new BufferedInputStream(
                app.getAssets().open("runtime.tgz")))) {
            untar(in, runtimeDir);
        }
        try (FileOutputStream out = new FileOutputStream(marker)) {
            out.write(version.getBytes(StandardCharsets.UTF_8));
        }
    }

    private static void deleteRecursively(File f) {
        if (!f.exists()) return;
        File[] children = f.listFiles();
        if (children != null) for (File c : children) deleteRecursively(c);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    /** Minimal ustar extractor with GNU long name/linkname ('L'/'K') and pax path ('x') support. */
    private static void untar(InputStream in, File dest) throws IOException {
        byte[] header = new byte[512];
        String longName = null;
        String longLink = null;
        while (true) {
            if (readFully(in, header, 0, 512) < 512) return;
            if (header[0] == 0) return; // zero block: end of archive
            String name = longName != null ? longName : parseString(header, 0, 100);
            long size = parseOctal(header, 124, 12);
            int mode = (int) parseOctal(header, 100, 8);
            char type = (char) header[156];
            String prefix = parseString(header, 345, 155);
            if (longName == null && !prefix.isEmpty()) name = prefix + "/" + name;
            String linkTarget = longLink != null ? longLink : parseString(header, 157, 100);
            longName = null;
            longLink = null;

            if (type == 'L' || type == 'K') {
                String longField = new String(readData(in, size), StandardCharsets.UTF_8).trim();
                if (type == 'L') longName = longField; else longLink = longField;
                continue;
            }
            if (type == 'x') {
                String pax = new String(readData(in, size), StandardCharsets.UTF_8);
                for (String record : pax.split("\n")) {
                    int eq = record.indexOf('=');
                    if (eq <= 0) continue;
                    String key = record.substring(0, eq);
                    if (key.endsWith(" path")) longName = record.substring(eq + 1);
                    else if (key.endsWith(" linkpath")) longLink = record.substring(eq + 1);
                }
                continue;
            }

            File out = new File(dest, name);
            if (type == '5' || name.endsWith("/")) {
                //noinspection ResultOfMethodCallIgnored
                out.mkdirs();
            } else if (type == '1' || type == '2') {
                try {
                    File parent = out.getParentFile();
                    if (parent != null) parent.mkdirs();
                    // A prior interrupted extraction may have left this entry
                    // behind; delete-before-create turns a guaranteed EEXIST
                    // into a fresh write.
                    if (out.delete() && BuildConfig.DEBUG) {
                        android.util.Log.d("dsh-node", "untar replaced leftover " + out);
                    }
                    if (type == '1') Os.link(new File(dest, linkTarget).getAbsolutePath(), out.getAbsolutePath());
                    else Os.symlink(linkTarget, out.getAbsolutePath());
                } catch (ErrnoException e) {
                    throw new IOException("link failed for " + out + ": " + e.getMessage(), e);
                }
                continue;
            } else {
                File parent = out.getParentFile();
                if (parent != null) parent.mkdirs();
                try (FileOutputStream fos = new FileOutputStream(out)) {
                    long remaining = size;
                    byte[] buf = new byte[64 * 1024];
                    while (remaining > 0) {
                        int n = in.read(buf, 0, (int) Math.min(buf.length, remaining));
                        if (n < 0) throw new IOException("truncated tar member " + name);
                        fos.write(buf, 0, n);
                        remaining -= n;
                    }
                }
                skipToBlock(in, size);
                try { Os.chmod(out.getAbsolutePath(), mode); }
                catch (ErrnoException | UnsupportedOperationException ignored) { /* vfat-style fs: no modes */ }
            }
        }
    }

    private static byte[] readData(InputStream in, long size) throws IOException {
        byte[] data = new byte[(int) size];
        if (readFully(in, data, 0, data.length) < data.length) throw new IOException("truncated tar data");
        skipToBlock(in, size);
        return data;
    }

    private static void skipToBlock(InputStream in, long size) throws IOException {
        long pad = (512 - (size % 512)) % 512;
        while (pad > 0) pad -= in.skip(pad);
    }

    private static int readFully(InputStream in, byte[] buf, int off, int len) throws IOException {
        int read = 0;
        while (read < len) {
            int n = in.read(buf, off + read, len - read);
            if (n < 0) break;
            read += n;
        }
        return read;
    }

    private static String parseString(byte[] buf, int off, int len) {
        int end = off;
        int limit = off + len;
        while (end < limit && buf[end] != 0) end++;
        return new String(buf, off, end - off, StandardCharsets.UTF_8);
    }

    private static long parseOctal(byte[] buf, int off, int len) {
        long value = 0;
        for (int i = off; i < off + len; i++) {
            byte b = buf[i];
            if (b >= '0' && b <= '7') value = (value << 3) + (b - '0');
        }
        return value;
    }
}
