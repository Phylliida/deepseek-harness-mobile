// Capacitor plugin backing the launcher page (mobile/www): reports the node
// runtime state, owns the SharedPreferences folder choice, and starts the
// foreground NodeRunnerService.
//
// Folder model: the picked shared-storage folder is the agent workspace.
// DSH_HOME is probed: if the picked folder can hold symlinks (the profile
// module fallback needs them) it becomes DSH_HOME, otherwise DSH_HOME falls
// back to app-private storage — sdcardfs rejects symlink creation.
//
// Registered from MainActivity.onCreate via registerPlugin(...).

package dev.phylliida.dsh;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Environment;
import android.system.ErrnoException;
import android.system.Os;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;

@CapacitorPlugin(
        name = "DshMobile",
        permissions = {
                @Permission(strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE }, alias = DshMobilePlugin.STORAGE_ALIAS),
        })
public class DshMobilePlugin extends Plugin {

    static final String STORAGE_ALIAS = "storage";
    private static final String PREFS = "DshMobilePrefs";
    private static final String KEY_WORKSPACE = "workspacePath";
    private static final String KEY_DSH_HOME_MODE = "dshHomeMode"; // "picked" | "internal"

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, 0);
    }

    @Override
    public void load() {
        // Returning to the app re-attaches to a live runtime; after a process
        // death the runtime is started again as soon as the launcher loads and
        // both the folder and the storage permission are present.
        if (getPermissionState(STORAGE_ALIAS) == PermissionState.GRANTED
                && workspace() != null
                && NodeRuntime.get().getStage() == NodeRuntime.Stage.IDLE) {
            startServiceWithWorkspace();
        }
    }

    @PluginMethod
    public void getState(PluginCall call) {
        NodeRuntime runtime = NodeRuntime.get();
        JSObject ret = new JSObject();
        ret.put("stage", runtime.getStage().name().toLowerCase());
        ret.put("port", runtime.getPort() != null ? runtime.getPort() : JSObject.NULL);
        ret.put("error", runtime.getError() != null ? runtime.getError() : JSObject.NULL);
        ret.put("folder", workspace() != null ? workspace() : JSObject.NULL);
        ret.put("dshHomeMode", prefs().getString(KEY_DSH_HOME_MODE, null));
        ret.put("permission", getPermissionState(STORAGE_ALIAS) == PermissionState.GRANTED ? "granted" : "prompt");
        ret.put("logTail", runtime.getLogTail());
        call.resolve(ret);
    }

    @PluginMethod
    public void requestStoragePermission(PluginCall call) {
        if (getPermissionState(STORAGE_ALIAS) == PermissionState.GRANTED) {
            call.resolve();
            return;
        }
        requestPermissionForAlias(STORAGE_ALIAS, call, "storagePermissionResult");
    }

    @PermissionCallback
    private void storagePermissionResult(PluginCall call) {
        if (getPermissionState(STORAGE_ALIAS) == PermissionState.GRANTED) call.resolve();
        else call.reject("storage permission denied", "STORAGE_PERMISSION");
    }

    @PluginMethod
    public void pickDataFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        startActivityForResult(call, intent, "pickFolderResult");
    }

    @ActivityCallback
    private void pickFolderResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        Uri uri = data != null ? data.getData() : null;
        if (uri == null) {
            call.reject("Folder pick cancelled", "CANCELLED");
            return;
        }
        String path = decodeTreePath(uri);
        if (path == null) {
            call.reject("Only folders on the primary shared storage can be used (SD-card volumes are blocked by Android)", "UNSUPPORTED_VOLUME");
            return;
        }
        prefs().edit().putString(KEY_WORKSPACE, path).apply();
        JSObject ret = new JSObject();
        ret.put("path", path);
        call.resolve(ret);
    }

    /** content://…/tree/primary:Documents/dsh → /storage/emulated/0/Documents/dsh; other volumes → null. */
    private static String decodeTreePath(Uri uri) {
        String docId = uri.getLastPathSegment();
        if (docId == null || !docId.startsWith("primary:")) return null;
        return new File(Environment.getExternalStorageDirectory(), docId.substring("primary:".length())).getAbsolutePath();
    }

    @PluginMethod
    public void startNode(PluginCall call) {
        if (getPermissionState(STORAGE_ALIAS) != PermissionState.GRANTED) {
            call.reject("storage permission not granted", "STORAGE_PERMISSION");
            return;
        }
        if (workspace() == null) {
            call.reject("no data folder picked", "NO_FOLDER");
            return;
        }
        startServiceWithWorkspace();
        call.resolve();
    }

    @PluginMethod
    public void stopNode(PluginCall call) {
        NodeRuntime.get().stop();
        call.resolve();
    }

    private String workspace() {
        return prefs().getString(KEY_WORKSPACE, null);
    }

    private void startServiceWithWorkspace() {
        Context context = getContext();
        String workspace = workspace();
        String dshHome;
        if (canSymlink(workspace)) {
            dshHome = new File(workspace, ".dsh").getAbsolutePath();
            prefs().edit().putString(KEY_DSH_HOME_MODE, "picked").apply();
        } else {
            dshHome = new File(context.getFilesDir(), "dsh").getAbsolutePath();
            prefs().edit().putString(KEY_DSH_HOME_MODE, "internal").apply();
        }
        NodeRunnerService.start(context, dshHome, workspace);
    }

    /** The profile module fallback writes symlinks; sdcardfs (shared storage) usually cannot. */
    private static boolean canSymlink(String dir) {
        File link = new File(dir, ".dsh-symlink-probe");
        try {
            link.delete();
            Os.symlink("target", link.getAbsolutePath());
            link.delete();
            return true;
        } catch (ErrnoException | UnsupportedOperationException | SecurityException e) {
            return false;
        }
    }
}
