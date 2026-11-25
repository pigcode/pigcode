import Flutter
import UIKit

/// iOS 26+ 原生 Liquid Glass（`UIGlassEffect`）桥接：
/// - 编译期 `#if compiler(>=6.2)` + 运行期 `if #available(iOS 26.0, *)` 双重门控；
/// - 旧版 iOS（13~18）、Xcode 16 编译产物或开启「降低透明度」时，`isSupported` 返回 false，
///   由 Flutter 侧自动回退至半透毛玻璃，确保全版本零风险。
final class MobileLiquidGlass: NSObject {
  static let channelName = "pigcode/liquid-glass"
  static let viewType = "pigcode/liquid-glass-surface"
  static let shared = MobileLiquidGlass()

  private var channel: FlutterMethodChannel?
  private var observer: NSObjectProtocol?

  static var isNativeGlassSupported: Bool {
    #if compiler(>=6.2)
    if #available(iOS 26.0, *) {
      return !UIAccessibility.isReduceTransparencyEnabled
    }
    #endif
    return false
  }

  func attach(to registrar: FlutterPluginRegistrar) {
    let messenger = registrar.messenger()
    let methodChannel = FlutterMethodChannel(name: Self.channelName, binaryMessenger: messenger)
    channel = methodChannel
    methodChannel.setMethodCallHandler { call, result in
      switch call.method {
      case "isSupported":
        result(Self.isNativeGlassSupported)
      default:
        result(FlutterMethodNotImplemented)
      }
    }

    if let existing = observer {
      NotificationCenter.default.removeObserver(existing)
    }
    observer = NotificationCenter.default.addObserver(
      forName: UIAccessibility.reduceTransparencyStatusDidChangeNotification,
      object: nil,
      queue: .main
    ) { [weak self] _ in
      self?.channel?.invokeMethod("availabilityChanged", arguments: Self.isNativeGlassSupported)
    }

    registrar.register(
      PigcodeGlassPlatformViewFactory(messenger: messenger),
      withId: Self.viewType
    )
  }
}

private final class PigcodeGlassPlatformViewFactory: NSObject, FlutterPlatformViewFactory {
  private let messenger: FlutterBinaryMessenger

  init(messenger: FlutterBinaryMessenger) {
    self.messenger = messenger
    super.init()
  }

  func createArgsCodec() -> FlutterMessageCodec & NSObjectProtocol {
    FlutterStandardMessageCodec.sharedInstance()
  }

  func create(
    withFrame frame: CGRect,
    viewIdentifier viewId: Int64,
    arguments args: Any?
  ) -> FlutterPlatformView {
    PigcodeGlassPlatformView(
      frame: frame,
      viewId: viewId,
      args: args as? [String: Any],
      messenger: messenger
    )
  }
}

private final class PigcodeGlassPlatformView: NSObject, FlutterPlatformView {
  private let containerView: UIView
  private let effectView: UIVisualEffectView
  private let channel: FlutterMethodChannel

  init(
    frame: CGRect,
    viewId: Int64,
    args: [String: Any]?,
    messenger: FlutterBinaryMessenger
  ) {
    containerView = UIView(frame: frame)
    containerView.backgroundColor = .clear
    containerView.isOpaque = false
    containerView.clipsToBounds = false
    containerView.isUserInteractionEnabled = false

    effectView = UIVisualEffectView(effect: nil)
    effectView.translatesAutoresizingMaskIntoConstraints = false
    effectView.isUserInteractionEnabled = false

    containerView.addSubview(effectView)
    NSLayoutConstraint.activate([
      effectView.leadingAnchor.constraint(equalTo: containerView.leadingAnchor),
      effectView.trailingAnchor.constraint(equalTo: containerView.trailingAnchor),
      effectView.topAnchor.constraint(equalTo: containerView.topAnchor),
      effectView.bottomAnchor.constraint(equalTo: containerView.bottomAnchor),
    ])

    channel = FlutterMethodChannel(
      name: "\(MobileLiquidGlass.viewType)/\(viewId)",
      binaryMessenger: messenger
    )
    super.init()

    apply(args: args)
    channel.setMethodCallHandler { [weak self] call, result in
      if call.method == "update", let params = call.arguments as? [String: Any] {
        self?.apply(args: params)
        result(nil)
      } else {
        result(FlutterMethodNotImplemented)
      }
    }
  }

  deinit {
    channel.setMethodCallHandler(nil)
  }

  private func apply(args: [String: Any]?) {
    let shape = args?["shape"] as? String ?? "capsule"
    let radius = (args?["radius"] as? NSNumber)?.doubleValue ?? 20.0
    let dark = args?["dark"] as? Bool ?? false
    let styleName = args?["style"] as? String ?? "regular"

    let uiStyle: UIUserInterfaceStyle = dark ? .dark : .light
    containerView.overrideUserInterfaceStyle = uiStyle
    effectView.overrideUserInterfaceStyle = uiStyle

    #if compiler(>=6.2)
    if #available(iOS 26.0, *) {
      let glass = UIGlassEffect(style: styleName == "clear" ? .clear : .regular)
      glass.isInteractive = false
      effectView.effect = glass
      if shape == "capsule" {
        effectView.cornerConfiguration = .capsule()
      } else {
        effectView.cornerConfiguration = .corners(radius: .fixed(radius))
      }
      return
    }
    #endif

    effectView.effect = UIBlurEffect(style: .systemChromeMaterial)
    effectView.clipsToBounds = true
    effectView.layer.cornerCurve = .continuous
    effectView.layer.cornerRadius = shape == "capsule"
      ? max(0, min(containerView.bounds.width, containerView.bounds.height) / 2)
      : CGFloat(radius)
  }

  func view() -> UIView {
    containerView
  }
}
