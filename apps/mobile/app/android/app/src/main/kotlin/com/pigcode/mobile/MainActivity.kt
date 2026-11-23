package com.pigcode.mobile

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private var reminders: MethodChannel? = null
    private var pending: MobileReminder? = null
    private var permissionResult: MethodChannel.Result? = null

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        reminders = MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger, MobileReminders.channelName,
        ).also { channel ->
            channel.setMethodCallHandler { call, result ->
                when (call.method) {
                    "takeTap" -> {
                        result.success(pending?.toWire())
                        pending = null
                    }
                    "settings" -> result.success(MobileReminders.settings(this))
                    "setEnabled" -> {
                        val enabled = call.arguments as? Boolean
                        if (enabled == null) {
                            result.error("invalid-setting", null, null)
                        } else {
                            MobileReminders.setEnabled(this, enabled)
                            result.success(MobileReminders.settings(this))
                        }
                    }
                    "requestPermission" -> requestReminderPermission(result)
                    "openSystemSettings" -> {
                        val settings = if (Build.VERSION.SDK_INT >= 26) {
                            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                                .putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                        } else {
                            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null))
                        }
                        startActivity(settings)
                        result.success(null)
                    }
                    "setVisible" -> {
                        MobileReminders.setVisible(call.argument<String>("computerId"), call.argument<String>("threadId"))
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            }
        }
        capture(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        capture(intent)
    }

    private fun capture(intent: Intent?) {
        if (intent?.action != MobileReminders.openAction) return
        val reminder = MobileReminder.parse(intent.getStringExtra(MobileReminders.contentExtra)) ?: return
        intent.removeExtra(MobileReminders.contentExtra)
        pending = reminder
        reminders?.invokeMethod("tapReady", null)
    }

    override fun onPause() {
        MobileReminders.setVisible(null, null)
        super.onPause()
    }

    private fun requestReminderPermission(result: MethodChannel.Result) {
        if (Build.VERSION.SDK_INT < 33 || MobileReminders.settings(this)["permission"] == "granted" ||
            permissionResult != null) {
            result.success(MobileReminders.settings(this))
            return
        }
        permissionResult = result
        MobileReminders.markAsked(this)
        requestPermissions(
            arrayOf(Manifest.permission.POST_NOTIFICATIONS), MobileReminders.requestPermissionCode,
        )
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == MobileReminders.requestPermissionCode) {
            permissionResult?.success(MobileReminders.settings(this))
            permissionResult = null
        }
    }
}
