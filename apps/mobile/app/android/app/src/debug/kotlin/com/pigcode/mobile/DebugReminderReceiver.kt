package com.pigcode.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build

/** Posts the same payload through the system shade during development. */
class DebugReminderReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val raw = intent.getStringExtra(MobileReminders.contentExtra)
        val reminder = MobileReminder.parse(raw) ?: return
        val manager = context.getSystemService(NotificationManager::class.java)
        if (!MobileReminders.enabled(context) || !manager.areNotificationsEnabled() ||
            MobileReminders.isVisible(reminder)) return

        val open = Intent(context, MainActivity::class.java).apply {
            action = MobileReminders.openAction
            flags = Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP
            data = Uri.Builder().scheme("pigcode-reminder").authority(reminder.computerId)
                .appendPath(reminder.eventId).build()
            putExtra(MobileReminders.contentExtra, raw)
        }
        val tap = PendingIntent.getActivity(context, 0, open,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

        @Suppress("DEPRECATION")
        val builder = if (Build.VERSION.SDK_INT >= 26) {
            manager.createNotificationChannel(
                NotificationChannel(MobileReminders.channelId, "会话提醒", NotificationManager.IMPORTANCE_DEFAULT),
            )
            Notification.Builder(context, MobileReminders.channelId)
        } else {
            Notification.Builder(context)
        }
        val body = when (reminder.kind) {
            "completed" -> "已完成"
            "failed" -> "运行失败"
            else -> "等你处理"
        }
        val notification = builder
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentTitle("Pigcode")
            .setContentText(body)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setContentIntent(tap)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .build()
        manager.notify("reminder:" + reminder.computerId + ":" + reminder.eventId, 1, notification)
    }
}
