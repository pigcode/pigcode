import ImageIO
import UIKit

/// 极轻量系统分享扩展：仅将系统传入的最多 6 张图片流式写入 App Group 临时批次目录，
/// 随后通过 `pigcode://share?batch=<batchId>` 唤起主 App 并立刻退出扩展进程，避免触发 120 MB 内存限制。
final class ShareViewController: UIViewController {
  private static let maxSharedImages = 6
  private static let maxSingleFileBytes: Int64 = 30 * 1024 * 1024
  private static let maxTranscodePixelSize = 2048
  private static let staleBatchTtl: TimeInterval = 24 * 60 * 60
  private static let imageTypeIdentifier = "public.image"
  private static let sharedIncomingDirName = "shared_incoming"

  private var started = false

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .clear
  }

  override func viewDidAppear(_ animated: Bool) {
    super.viewDidAppear(animated)
    guard !started else { return }
    started = true
    processIncomingItems()
  }

  private var appGroupId: String {
    if let configured = Bundle.main.object(forInfoDictionaryKey: "PigcodeAppGroup") as? String,
       !configured.isEmpty,
       !configured.hasPrefix("$(") {
      return configured
    }
    return "group.com.pigcode.mobile"
  }

  private func processIncomingItems() {
    let providers = collectImageProviders()
    guard !providers.isEmpty,
          let containerURL = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroupId
          ) else {
      finishExtension()
      return
    }

    let totalCount = providers.count
    let selected = Array(providers.prefix(Self.maxSharedImages))
    let truncatedCount = max(0, totalCount - Self.maxSharedImages)

    let batchId = UUID().uuidString.lowercased()
    let incomingRoot = containerURL.appendingPathComponent(
      Self.sharedIncomingDirName,
      isDirectory: true
    )
    let batchDir = incomingRoot.appendingPathComponent(batchId, isDirectory: true)

    DispatchQueue.global(qos: .userInitiated).async { [weak self] in
      guard let self = self else { return }
      self.cleanupStaleBatches(in: incomingRoot)

      do {
        try FileManager.default.createDirectory(
          at: batchDir,
          withIntermediateDirectories: true
        )
      } catch {
        self.finishExtension()
        return
      }

      let group = DispatchGroup()
      let lock = NSLock()
      var results = [String?](repeating: nil, count: selected.count)

      for (index, provider) in selected.enumerated() {
        group.enter()
        self.copyProvider(provider, index: index, to: batchDir) { savedName in
          lock.lock()
          results[index] = savedName
          lock.unlock()
          group.leave()
        }
      }

      group.notify(queue: DispatchQueue.global(qos: .userInitiated)) { [weak self] in
        guard let self = self else { return }
        let files = results.compactMap { $0 }
        guard !files.isEmpty else {
          try? FileManager.default.removeItem(at: batchDir)
          self.finishExtension()
          return
        }

        let manifest: [String: Any] = [
          "batchId": batchId,
          "files": files,
          "truncatedCount": truncatedCount,
          "createdAt": Int64(Date().timeIntervalSince1970 * 1000),
        ]
        let manifestURL = batchDir.appendingPathComponent("manifest.json")
        guard let data = try? JSONSerialization.data(withJSONObject: manifest, options: []),
              (try? data.write(to: manifestURL, options: .atomic)) != nil,
              let handoffURL = URL(string: "pigcode://share?batch=\(batchId)") else {
          try? FileManager.default.removeItem(at: batchDir)
          self.finishExtension()
          return
        }

        self.openHostApp(url: handoffURL) {
          self.finishExtension()
        }
      }
    }
  }

  private func collectImageProviders() -> [NSItemProvider] {
    guard let items = extensionContext?.inputItems as? [NSExtensionItem] else {
      return []
    }
    var providers: [NSItemProvider] = []
    for item in items {
      guard let attachments = item.attachments else { continue }
      for provider in attachments {
        if provider.hasItemConformingToTypeIdentifier(Self.imageTypeIdentifier) {
          providers.append(provider)
        }
      }
    }
    return providers
  }

  private func copyProvider(
    _ provider: NSItemProvider,
    index: Int,
    to batchDir: URL,
    completion: @escaping (String?) -> Void
  ) {
    provider.loadFileRepresentation(forTypeIdentifier: Self.imageTypeIdentifier) { [weak self] url, _ in
      guard let self = self else {
        completion(nil)
        return
      }
      if let fileURL = url,
         let saved = self.persistFile(at: fileURL, suggestedName: provider.suggestedName, index: index, to: batchDir) {
        completion(saved)
        return
      }
      provider.loadDataRepresentation(forTypeIdentifier: Self.imageTypeIdentifier) { [weak self] data, _ in
        guard let self = self else {
          completion(nil)
          return
        }
        if let data = data,
           !data.isEmpty,
           Int64(data.count) <= Self.maxSingleFileBytes,
           let saved = self.persistData(data, suggestedName: provider.suggestedName, index: index, to: batchDir) {
          completion(saved)
          return
        }
        completion(nil)
      }
    }
  }

  private func persistFile(
    at sourceURL: URL,
    suggestedName: String?,
    index: Int,
    to batchDir: URL
  ) -> String? {
    guard let attrs = try? FileManager.default.attributesOfItem(atPath: sourceURL.path),
          let fileSize = (attrs[.size] as? NSNumber)?.int64Value,
          fileSize > 0,
          fileSize <= Self.maxSingleFileBytes else {
      return nil
    }

    let rawName = suggestedName ?? sourceURL.lastPathComponent
    if let directExt = detectSupportedMagicExtension(at: sourceURL) {
      let safeName = sanitizeFileName(rawName, preferredExtension: directExt)
      let fileName = "\(index)_\(safeName)"
      let destination = batchDir.appendingPathComponent(fileName)
      do {
        if FileManager.default.fileExists(atPath: destination.path) {
          try FileManager.default.removeItem(at: destination)
        }
        try FileManager.default.copyItem(at: sourceURL, to: destination)
        return fileName
      } catch {
        return nil
      }
    }

    // HEIC / HEIF 等格式通过 ImageIO 低内存下采样转码为 JPEG，保证主 App 与压缩器可直接处理。
    let safeName = sanitizeFileName(rawName, preferredExtension: "jpg", forceExtension: true)
    let fileName = "\(index)_\(safeName)"
    let destination = batchDir.appendingPathComponent(fileName)
    guard transcodeToJpeg(sourceURL: sourceURL, destinationURL: destination) else {
      return nil
    }
    return fileName
  }

  private func persistData(
    _ data: Data,
    suggestedName: String?,
    index: Int,
    to batchDir: URL
  ) -> String? {
    if let directExt = detectSupportedMagicExtension(data: data) {
      let safeName = sanitizeFileName(suggestedName, preferredExtension: directExt)
      let fileName = "\(index)_\(safeName)"
      let destination = batchDir.appendingPathComponent(fileName)
      do {
        try data.write(to: destination, options: .atomic)
        return fileName
      } catch {
        return nil
      }
    }

    let safeName = sanitizeFileName(suggestedName, preferredExtension: "jpg", forceExtension: true)
    let fileName = "\(index)_\(safeName)"
    let destination = batchDir.appendingPathComponent(fileName)
    guard transcodeDataToJpeg(data: data, destinationURL: destination) else {
      return nil
    }
    return fileName
  }

  private func detectSupportedMagicExtension(at url: URL) -> String? {
    guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
    defer { handle.closeFile() }
    let header = handle.readData(ofLength: 12)
    return detectSupportedMagicExtension(data: header)
  }

  private func detectSupportedMagicExtension(data: Data) -> String? {
    let bytes = [UInt8](data.prefix(12))
    if bytes.count >= 8 &&
      bytes[0] == 0x89 && bytes[1] == 0x50 && bytes[2] == 0x4E && bytes[3] == 0x47 &&
      bytes[4] == 0x0D && bytes[5] == 0x0A && bytes[6] == 0x1A && bytes[7] == 0x0A {
      return "png"
    }
    if bytes.count >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
      return "jpg"
    }
    if bytes.count >= 6 &&
      bytes[0] == 0x47 && bytes[1] == 0x49 && bytes[2] == 0x46 && bytes[3] == 0x38 &&
      (bytes[4] == 0x37 || bytes[4] == 0x39) && bytes[5] == 0x61 {
      return "gif"
    }
    if bytes.count >= 12 &&
      bytes[0] == 0x52 && bytes[1] == 0x49 && bytes[2] == 0x46 && bytes[3] == 0x46 &&
      bytes[8] == 0x57 && bytes[9] == 0x45 && bytes[10] == 0x42 && bytes[11] == 0x50 {
      return "webp"
    }
    return nil
  }

  private func transcodeToJpeg(sourceURL: URL, destinationURL: URL) -> Bool {
    guard let source = CGImageSourceCreateWithURL(sourceURL as CFURL, nil) else {
      return false
    }
    return writeThumbnailJpeg(from: source, to: destinationURL)
  }

  private func transcodeDataToJpeg(data: Data, destinationURL: URL) -> Bool {
    guard let source = CGImageSourceCreateWithData(data as CFData, nil) else {
      return false
    }
    return writeThumbnailJpeg(from: source, to: destinationURL)
  }

  private func writeThumbnailJpeg(from source: CGImageSource, to destinationURL: URL) -> Bool {
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: false,
      kCGImageSourceThumbnailMaxPixelSize: Self.maxTranscodePixelSize,
    ]
    guard let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
      return false
    }
    guard let destination = CGImageDestinationCreateWithURL(
      destinationURL as CFURL,
      "public.jpeg" as CFString,
      1,
      nil
    ) else {
      return false
    }
    let destinationOptions: [CFString: Any] = [
      kCGImageDestinationLossyCompressionQuality: 0.88,
    ]
    CGImageDestinationAddImage(destination, cgImage, destinationOptions as CFDictionary)
    return CGImageDestinationFinalize(destination)
  }

  private func sanitizeFileName(
    _ rawName: String?,
    preferredExtension: String,
    forceExtension: Bool = false
  ) -> String {
    let leaf = (rawName ?? "")
      .components(separatedBy: CharacterSet(charactersIn: "/\\"))
      .last?
      .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let allowed = CharacterSet(
      charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-"
    )
    let cleaned = String(
      leaf.unicodeScalars.map { allowed.contains($0) ? Character($0) : "_" }
    ).trimmingCharacters(in: CharacterSet(charactersIn: "."))
    let clipped = String(cleaned.prefix(80))
    guard !clipped.isEmpty else {
      return "image.\(preferredExtension)"
    }
    if forceExtension {
      let stem = (clipped as NSString).deletingPathExtension
      let safeStem = stem.isEmpty ? "image" : stem
      return "\(safeStem).\(preferredExtension)"
    }
    if clipped.contains(".") {
      return clipped
    }
    return "\(clipped).\(preferredExtension)"
  }

  private func cleanupStaleBatches(in root: URL) {
    guard let entries = try? FileManager.default.contentsOfDirectory(
      at: root,
      includingPropertiesForKeys: [.contentModificationDateKey],
      options: [.skipsHiddenFiles]
    ) else {
      return
    }
    let cutoff = Date().addingTimeInterval(-Self.staleBatchTtl)
    for entry in entries {
      let modified = (try? entry.resourceValues(forKeys: [.contentModificationDateKey]))?
        .contentModificationDate
      if let modified = modified, modified < cutoff {
        try? FileManager.default.removeItem(at: entry)
      }
    }
  }

  private func openHostApp(url: URL, completion: @escaping () -> Void) {
    DispatchQueue.main.async {
      var responder: UIResponder? = self
      while let current = responder {
        if current.isKind(of: UIApplication.self) {
          let modernSelector = NSSelectorFromString("openURL:options:completionHandler:")
          if current.responds(to: modernSelector),
             let method = class_getInstanceMethod(type(of: current), modernSelector) {
            typealias OpenURLWithOptions = @convention(c) (
              AnyObject,
              Selector,
              NSURL,
              NSDictionary,
              ((Bool) -> Void)?
            ) -> Void
            let impl = unsafeBitCast(method_getImplementation(method), to: OpenURLWithOptions.self)
            impl(current, modernSelector, url as NSURL, [:]) { _ in
              completion()
            }
            return
          }
          let legacySelector = NSSelectorFromString("openURL:")
          if current.responds(to: legacySelector) {
            _ = current.perform(legacySelector, with: url)
            completion()
            return
          }
        }
        responder = current.next
      }
      self.extensionContext?.open(url) { _ in
        completion()
      }
    }
  }

  private func finishExtension() {
    DispatchQueue.main.async {
      self.extensionContext?.completeRequest(returningItems: nil, completionHandler: nil)
    }
  }
}
