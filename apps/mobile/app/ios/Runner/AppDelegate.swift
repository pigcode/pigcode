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
    MobileShareReceiver.shared.attach(engineBridge.applicationRegistrar.messenger())
  }

  override func application(
    _ app: UIApplication,
    open url: URL,
    options: [UIApplication.OpenURLOptionsKey: Any] = [:]
  ) -> Bool {
    if MobileShareReceiver.shared.handleIncomingURL(url) {
      return true
    }
    return super.application(app, open: url, options: options)
  }

  override func application(
    _ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
  ) {
    MobileReminders.shared.registered(deviceToken)
    super.application(application, didRegisterForRemoteNotificationsWithDeviceToken: deviceToken)
  }

  override func application(
    _ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error
  ) {
    MobileReminders.shared.registrationFailed()
    super.application(application, didFailToRegisterForRemoteNotificationsWithError: error)
  }
}

final class MobileReminders: NSObject, UNUserNotificationCenterDelegate {
  static let shared = MobileReminders()
  private let enabledKey = "pigcode.mobile.reminders.enabled"
  private var pending: [String: Any]?
  private var visible: [String: String] = [:]
  private var channel: FlutterMethodChannel?
  private var registrationRequested = false
  private var nextRegistrationAttempt = Date.distantPast
  private var apns: [String: String]?

  private var apnsEnvironment: String? {
    #if targetEnvironment(simulator)
    return nil
    #else
    switch Bundle.main.object(forInfoDictionaryKey: "PigcodeAPNSEnvironment") as? String {
    case "development": return "sandbox"
    case "production": return "production"
    default: return nil
    }
    #endif
  }

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
        if !enabled { self.unregister() }
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
        if self.enabled && permission == "granted" &&
          self.apnsEnvironment != nil && !self.registrationRequested &&
          Date() >= self.nextRegistrationAttempt {
          self.registrationRequested = true
          UIApplication.shared.registerForRemoteNotifications()
        }
        var settings: [String: Any] = ["enabled": self.enabled, "permission": permission]
        if let registration = self.apns { settings["apns"] = registration }
        result(settings)
      }
    }
  }

  func registered(_ deviceToken: Data) {
    guard let environment = apnsEnvironment, !deviceToken.isEmpty else { return }
    if !enabled {
      unregister()
      return
    }
    let token = deviceToken.map { String(format: "%02x", $0) }.joined()
    apns = [
      "token": token, "environment": environment, "observationId": UUID().uuidString.lowercased()
    ]
    channel?.invokeMethod("settingsChanged", arguments: nil)
  }

  func registrationFailed() {
    registrationRequested = false
    let retryDelay: TimeInterval = 60
    let retryAt = Date().addingTimeInterval(retryDelay)
    nextRegistrationAttempt = retryAt
    DispatchQueue.main.asyncAfter(deadline: .now() + retryDelay) { [weak self] in
      guard let self = self, self.nextRegistrationAttempt == retryAt,
        UIApplication.shared.applicationState == .active else { return }
      self.settings { _ in }
    }
  }

  private func unregister() {
    if apnsEnvironment != nil {
      UIApplication.shared.unregisterForRemoteNotifications()
    }
    registrationRequested = false
    nextRegistrationAttempt = .distantPast
    apns = nil
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
