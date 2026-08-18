package dev.phylliida.dsh;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

import androidx.core.app.NotificationCompat;

/**
 * Foreground service keeping the harness host process alive: Android reaps
 * plain background children quickly, and a long-running agent task needs CPU
 * for minutes. The notification doubles as the "node is running" indicator.
 *
 * Android 12+ phantom-process limits can still kill a backgrounded, busy child
 * on some devices — see mobile/README.md for the adb workaround.
 */
public class NodeRunnerService extends Service {

    public static final String EXTRA_DSH_HOME = "dshHome";
    public static final String EXTRA_WORKSPACE = "workspace";
    private static final String CHANNEL = "dsh.node";
    private static final int NOTIFICATION_ID = 1;

    private PowerManager.WakeLock wakeLock;

    public static void start(Context context, String dshHome, String workspace) {
        Intent intent = new Intent(context, NodeRunnerService.class);
        intent.putExtra(EXTRA_DSH_HOME, dshHome);
        intent.putExtra(EXTRA_WORKSPACE, workspace);
        context.startForegroundService(intent);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(new NotificationChannel(
                    CHANNEL, "Node runtime", NotificationManager.IMPORTANCE_LOW));
        }
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "dsh:node");
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NOTIFICATION_ID, buildNotification("Node runtime starting…"));
        wakeLock.acquire();
        String dshHome = intent != null ? intent.getStringExtra(EXTRA_DSH_HOME) : null;
        String workspace = intent != null ? intent.getStringExtra(EXTRA_WORKSPACE) : null;
        if (dshHome == null || workspace == null) {
            stopSelf();
            return START_NOT_STICKY;
        }
        NodeRuntime.get().ensureStarted(this, dshHome, workspace);
        NodeRuntime.get().addListener(this::updateNotification);
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        NodeRuntime.get().removeListener(this::updateNotification);
        NodeRuntime.get().stop();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    private void updateNotification() {
        String text = NodeRuntime.get().getStage() == NodeRuntime.Stage.RUNNING
                ? "Node runtime ready"
                : "Node runtime: " + NodeRuntime.get().getStage().name().toLowerCase();
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        manager.notify(NOTIFICATION_ID, buildNotification(text));
    }

    private Notification buildNotification(String text) {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pending = PendingIntent.getActivity(
                this, 0, open, PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle("DSH")
                .setContentText(text)
                .setContentIntent(pending)
                .setOngoing(true)
                .build();
    }
}
