import Flutter
import UIKit
import UserNotifications

class SceneDelegate: FlutterSceneDelegate {
  override func scene(
    _ scene: UIScene, willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    super.scene(scene, willConnectTo: session, options: connectionOptions)
    if let response = connectionOptions.notificationResponse {
      MobileReminders.shared.capture(response)
    }
    for context in connectionOptions.urlContexts {
      MobileShareReceiver.shared.handleIncomingURL(context.url)
    }
  }

  override func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    super.scene(scene, openURLContexts: URLContexts)
    for context in URLContexts {
      MobileShareReceiver.shared.handleIncomingURL(context.url)
    }
  }
}
