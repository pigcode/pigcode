import Flutter
import Foundation
import UIKit

/// 主 App 侧系统分享接收器：
/// - 处理来自 ShareExtension 的 `pigcode://share?batch=<batchId>` 唤起；
/// - 将图片从 App Group 共享容器迁移到主 App 私有缓存目录 `cachesDirectory/shared_incoming/<batchId>/`；
/// - 迁移后立刻删除 App Group 共享容器中的批次目录，避免残留用户截图；
/// - 通过 `pigcode/share` MethodChannel 与 Android 保持完全一致的契约。
final class MobileShareReceiver {
  static let shared = MobileShareReceiver()

  private static let channelName = "pigcode/share"
  private static let sharedIncomingDirName = "shared_incoming"
  private static let staleBatchTtl: TimeInterval = 24 * 60 * 60
  private static let maxSharedImages = 6
  private static let batchIdRegex = try! NSRegularExpression(pattern: "^[A-Za-z0-9-]{1,128}$")

  private struct ShareBatch {
    let batchId: String
    let paths: [String]
    let truncatedCount: Int

    func toWire() -> [String: Any] {
      return [
        "batchId": batchId,
        "paths": paths,
        "truncatedCount": truncatedCount,
      ]
    }
  }

  private let ioQueue = DispatchQueue(label: "com.pigcode.mobile.share-receiver", qos: .userInitiated)
  private var channel: FlutterMethodChannel?
  private var pendingBatch: ShareBatch?
  private var activeMigrationCount = 0
  private var pendingConsumeResults: [FlutterResult] = []

  private init() {}

  private var appGroupId: String {
    if let configured = Bundle.main.object(forInfoDictionaryKey: "PigcodeAppGroup") as? String,
       !configured.isEmpty,
       !configured.hasPrefix("$(") {
      return configured
    }
    return "group.com.pigcode.mobile"
  }

  func attach(_ messenger: FlutterBinaryMessenger) {
    let bridge = FlutterMethodChannel(name: Self.channelName, binaryMessenger: messenger)
    channel = bridge
    bridge.setMethodCallHandler { [weak self] call, result in
      guard let self = self else {
        result(nil)
        return
      }
      switch call.method {
      case "consumePendingBatch":
        self.handleConsumePendingBatch(result)
      case "cleanupBatch":
        if let args = call.arguments as? [String: Any],
           let batchId = args["batchId"] as? String,
           self.isValidBatchId(batchId) {
          if self.pendingBatch?.batchId == batchId {
            self.pendingBatch = nil
          }
          self.scheduleDeletePrivateBatch(batchId)
        }
        result(nil)
      default:
        result(FlutterMethodNotImplemented)
      }
    }
    ioQueue.async { [weak self] in
      self?.cleanupStaleBatches()
    }
  }

  @discardableResult
  func handleIncomingURL(_ url: URL) -> Bool {
    guard url.scheme?.lowercased() == "pigcode",
          url.host?.lowercased() == "share" else {
      return false
    }
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
          let batchId = components.queryItems?.first(where: { $0.name == "batch" })?.value,
          isValidBatchId(batchId) else {
      return true
    }

    DispatchQueue.main.async { [weak self] in
      guard let self = self else { return }
      self.activeMigrationCount += 1
      self.ioQueue.async { [weak self] in
        guard let self = self else { return }
        let batch = self.migrateBatchFromAppGroup(batchId: batchId)
        DispatchQueue.main.async { [weak self] in
          self?.onMigrationFinished(batch)
        }
      }
    }
    return true
  }

  private func handleConsumePendingBatch(_ result: @escaping FlutterResult) {
    if let current = pendingBatch {
      pendingBatch = nil
      result(current.toWire())
      return
    }
    if activeMigrationCount > 0 {
      pendingConsumeResults.append(result)
      return
    }
    result(nil)
  }

  private func onMigrationFinished(_ batch: ShareBatch?) {
    activeMigrationCount = max(0, activeMigrationCount - 1)
    if !pendingConsumeResults.isEmpty {
      if let batch = batch {
        let waiters = pendingConsumeResults
        pendingConsumeResults.removeAll()
        waiters.first?(batch.toWire())
        for extra in waiters.dropFirst() {
          extra(nil)
        }
        return
      }
      if activeMigrationCount == 0 {
        let waiters = pendingConsumeResults
        pendingConsumeResults.removeAll()
        let existing = pendingBatch
        pendingBatch = nil
        waiters.first?(existing?.toWire())
        for extra in waiters.dropFirst() {
          extra(nil)
        }
      }
      return
    }

    guard let batch = batch else { return }
    if let previous = pendingBatch, previous.batchId != batch.batchId {
      scheduleDeletePrivateBatch(previous.batchId)
    }
    pendingBatch = batch

    channel?.invokeMethod("onShareBatch", arguments: batch.toWire()) { [weak self] response in
      guard let self = self else { return }
      if response is FlutterError || (response as? NSObject) === FlutterMethodNotImplemented {
        return
      }
      if self.pendingBatch?.batchId == batch.batchId {
        self.pendingBatch = nil
      }
    }
  }

  private func migrateBatchFromAppGroup(batchId: String) -> ShareBatch? {
    guard let groupURL = FileManager.default.containerURL(
      forSecurityApplicationGroupIdentifier: appGroupId
    ) else {
      return nil
    }
    let sourceBatchDir = groupURL
      .appendingPathComponent(Self.sharedIncomingDirName, isDirectory: true)
      .appendingPathComponent(batchId, isDirectory: true)

    // 无论成功或失败，迁移结束后立即清除 App Group 共享容器中的批次目录，防止残留用户截图。
    defer {
      try? FileManager.default.removeItem(at: sourceBatchDir)
    }

    let manifestURL = sourceBatchDir.appendingPathComponent("manifest.json")
    guard let manifestData = try? Data(contentsOf: manifestURL),
          let manifest = try? JSONSerialization.jsonObject(with: manifestData) as? [String: Any],
          let rawFiles = manifest["files"] as? [String],
          !rawFiles.isEmpty else {
      return nil
    }
    let truncatedCount = max(0, (manifest["truncatedCount"] as? Int) ?? 0)

    guard let privateRoot = privateIncomingRootURL() else {
      return nil
    }
    let destBatchDir = privateRoot.appendingPathComponent(batchId, isDirectory: true)
    do {
      if FileManager.default.fileExists(atPath: destBatchDir.path) {
        try FileManager.default.removeItem(at: destBatchDir)
      }
      try FileManager.default.createDirectory(
        at: destBatchDir,
        withIntermediateDirectories: true
      )
    } catch {
      return nil
    }

    var migratedPaths: [String] = []
    for fileName in rawFiles.prefix(Self.maxSharedImages) {
      guard isSafeFileName(fileName) else { continue }
      let sourceFile = sourceBatchDir.appendingPathComponent(fileName)
      let destFile = destBatchDir.appendingPathComponent(fileName)
      guard FileManager.default.fileExists(atPath: sourceFile.path) else { continue }
      do {
        try FileManager.default.moveItem(at: sourceFile, to: destFile)
        migratedPaths.append(destFile.path)
      } catch {
        if (try? FileManager.default.copyItem(at: sourceFile, to: destFile)) != nil {
          migratedPaths.append(destFile.path)
        }
      }
    }

    guard !migratedPaths.isEmpty else {
      try? FileManager.default.removeItem(at: destBatchDir)
      return nil
    }
    return ShareBatch(
      batchId: batchId,
      paths: migratedPaths,
      truncatedCount: truncatedCount
    )
  }

  private func privateIncomingRootURL() -> URL? {
    FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)
      .first?
      .appendingPathComponent(Self.sharedIncomingDirName, isDirectory: true)
  }

  private func scheduleDeletePrivateBatch(_ batchId: String) {
    guard isValidBatchId(batchId) else { return }
    ioQueue.async { [weak self] in
      guard let root = self?.privateIncomingRootURL() else { return }
      let batchDir = root.appendingPathComponent(batchId, isDirectory: true)
      try? FileManager.default.removeItem(at: batchDir)
    }
  }

  private func cleanupStaleBatches() {
    let cutoff = Date().addingTimeInterval(-Self.staleBatchTtl)
    if let privateRoot = privateIncomingRootURL() {
      removeStaleDirectories(in: privateRoot, olderThan: cutoff)
    }
    if let groupURL = FileManager.default.containerURL(
      forSecurityApplicationGroupIdentifier: appGroupId
    ) {
      let groupIncoming = groupURL.appendingPathComponent(
        Self.sharedIncomingDirName,
        isDirectory: true
      )
      removeStaleDirectories(in: groupIncoming, olderThan: cutoff)
    }
  }

  private func removeStaleDirectories(in root: URL, olderThan cutoff: Date) {
    guard let entries = try? FileManager.default.contentsOfDirectory(
      at: root,
      includingPropertiesForKeys: [.contentModificationDateKey],
      options: [.skipsHiddenFiles]
    ) else {
      return
    }
    for entry in entries {
      let modified = (try? entry.resourceValues(forKeys: [.contentModificationDateKey]))?
        .contentModificationDate
      if let modified = modified, modified < cutoff {
        try? FileManager.default.removeItem(at: entry)
      }
    }
  }

  private func isValidBatchId(_ value: String) -> Bool {
    let range = NSRange(location: 0, length: value.utf16.count)
    return Self.batchIdRegex.firstMatch(in: value, options: [], range: range) != nil
  }

  private func isSafeFileName(_ name: String) -> Bool {
    guard !name.isEmpty,
          name != ".",
          name != "..",
          !name.contains("/"),
          !name.contains("\\") else {
      return false
    }
    return true
  }
}
