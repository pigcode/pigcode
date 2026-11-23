package com.pigcode.mobile

import android.app.NotificationManager
import android.content.Context
import android.os.Build
import org.json.JSONObject

data class MobileReminder(
    val computerId: String,
    val threadId: String,
    val eventId: String,
    val kind: String,
) {
    fun toWire(): Map<String, Any> = mapOf(
        "version" to 1, "computerId" to computerId, "threadId" to threadId,
        "eventId" to eventId, "kind" to kind,
    )

    companion object {
        private val fingerprint = Regex("[0-9a-f]{64}")
        private val kinds = setOf("approval", "question", "completed", "failed")

        fun parse(raw: String?): MobileReminder? {
            if (raw == null || raw.length > 2048) return null
            return runCatching {
                val data = JSONObject(raw)
                val computer = data.getString("computerId")
                val thread = data.getString("threadId")
                val event = data.getString("eventId")
                val kind = data.getString("kind")
                require(data.getInt("version") == 1 && data.length() == 5)
                require(fingerprint.matches(computer) && thread.length in 1..128 &&
                    event.length in 1..256 && kind in kinds)
                MobileReminder(computer, thread, event, kind)
            }.getOrNull()
        }
    }
}

object MobileReminders {
    const val channelName = "pigcode/mobile-reminders"
    const val contentExtra = "com.pigcode.mobile.REMINDER"
    const val openAction = "com.pigcode.mobile.OPEN_REMINDER"
    const val channelId = "pigcode-reminders"
    const val requestPermissionCode = 410
    private var visibleTarget: Pair<String, String>? = null

    private fun prefs(context: Context) =
        context.getSharedPreferences("pigcode-reminders", Context.MODE_PRIVATE)

    fun setEnabled(context: Context, enabled: Boolean) {
        prefs(context).edit().putBoolean("enabled", enabled).apply()
    }

    fun markAsked(context: Context) {
        prefs(context).edit().putBoolean("asked", true).apply()
    }

    fun setVisible(computer: String?, thread: String?) {
        visibleTarget = if (computer != null && thread != null) computer to thread else null
    }

    fun isVisible(reminder: MobileReminder): Boolean =
        visibleTarget == (reminder.computerId to reminder.threadId)

    fun enabled(context: Context): Boolean = prefs(context).getBoolean("enabled", true)

    fun settings(context: Context): Map<String, Any> {
        val manager = context.getSystemService(NotificationManager::class.java)
        val permission = when {
            manager.areNotificationsEnabled() -> "granted"
            Build.VERSION.SDK_INT >= 33 &&
                !prefs(context).getBoolean("asked", false) -> "undetermined"
            else -> "denied"
        }
        return mapOf("enabled" to enabled(context), "permission" to permission)
    }
}
