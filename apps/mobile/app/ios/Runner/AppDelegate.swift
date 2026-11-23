import Flutter
import UIKit
import UserNotifications

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    let started = super.application(application, didFinishLaunchingWithOptions: launchOptions)
    UNUserNotificationCenter.current().delegate = MobileReminders.shared
    return started
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    MobileReminders.shared.attach(engineBridge.applicationRegistrar.messenger())
  }
}

final class MobileReminders: NSObject, UNUserNotificationCenterDelegate {
  static let shared = MobileReminders()
  private let enabledKey = "pigcode.mobile.reminders.enabled"
  private var pending: [String: Any]?
  private var visible: [String: String] = [:]
  private var channel: FlutterMethodChannel?

  private var enabled: Bool {
    return UserDefaults.standard.object(forKey: enabledKey) as? Bool ?? true
  }

  func attach(_ messenger: FlutterBinaryMessenger) {
    let bridge = FlutterMethodChannel(name: "pigcode/mobile-reminders", binaryMessenger: messenger)
    channel = bridge
    bridge.setMethodCallHandler { [weak self] call, result in
      guard let self = self else { result(nil); return }
      switch call.method {
      case "takeTap":
        result(self.pending)
        self.pending = nil
      case "settings":
        self.settings(result)
      case "setEnabled":
        guard let enabled = call.arguments as? Bool else {
          result(FlutterError(code: "invalid-setting", message: nil, details: nil))
          return
        }
        UserDefaults.standard.set(enabled, forKey: self.enabledKey)
        self.settings(result)
      case "requestPermission":
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
          self.settings(result)
        }
      case "openSystemSettings":
        if let url = URL(string: UIApplication.openSettingsURLString) {
          UIApplication.shared.open(url) { opened in
            if opened { result(nil) }
            else { result(FlutterError(code: "settings-unavailable", message: nil, details: nil)) }
          }
        } else {
          result(FlutterError(code: "settings-unavailable", message: nil, details: nil))
        }
      case "setVisible":
        self.visible = call.arguments as? [String: String] ?? [:]
        result(nil)
      default:
        result(FlutterMethodNotImplemented)
      }
    }
  }

  private func settings(_ result: @escaping FlutterResult) {
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      let permission: String
      switch settings.authorizationStatus {
      case .authorized, .provisional: permission = "granted"
      case .denied: permission = "denied"
      default:
        if #available(iOS 14.0, *), settings.authorizationStatus == .ephemeral {
          permission = "granted"
        } else {
          permission = "undetermined"
        }
      }
      DispatchQueue.main.async {
        result(["enabled": self.enabled, "permission": permission])
      }
    }
  }

  func capture(_ response: UNNotificationResponse) {
    guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
          let payload = response.notification.request.content.userInfo["pigcode"] as? [String: Any] else { return }
    DispatchQueue.main.async {
      self.pending = payload
      self.channel?.invokeMethod("tapReady", arguments: nil)
    }
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    capture(response)
    completionHandler()
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    let payload = notification.request.content.userInfo["pigcode"] as? [String: Any]
    DispatchQueue.main.async {
      let current = self.visible["computerId"] != nil &&
        payload?["computerId"] as? String == self.visible["computerId"] &&
        payload?["threadId"] as? String == self.visible["threadId"]
      if !self.enabled || current {
        completionHandler([])
      } else if #available(iOS 14.0, *) {
        completionHandler([.banner, .list])
      } else {
        completionHandler([.alert])
      }
    }
  }
}
