import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:uuid/uuid.dart';

import 'attachment_cache.dart';
import 'draft_attachment.dart';
import 'image_compressor.dart';

/// 输入框单张待发图片的状态。
enum ComposerAttachmentStatus {
  /// 正在读取、校验魔数并压缩缩放。
  preparing,

  /// 正在后台分片上传至电脑。
  uploading,

  /// 已完成上传并持有电脑端签发的 `MobileAttachmentRef`。
  uploaded,

  /// 电脑离线时暂存在本地隔离草稿目录，待恢复在线后自动补传。
  localOffline,

  /// 上传失败，可点击缩略图重试或点击右上角移除。
  failed,
}

/// 供输入框缩略图条与全屏预览使用的不可变附件条目视图。
@immutable
final class ComposerAttachmentItem {
  const ComposerAttachmentItem({
    required this.localId,
    required this.fileName,
    required this.status,
    this.mimeType,
    this.sizeBytes,
    this.width,
    this.height,
    this.previewBytes,
    this.draftFileName,
    this.progress = 0,
    this.remoteRef,
    this.errorMessage,
  });

  final String localId;
  final String fileName;
  final ComposerAttachmentStatus status;
  final String? mimeType;
  final int? sizeBytes;
  final int? width;
  final int? height;
  final Uint8List? previewBytes;
  final String? draftFileName;
  final double progress;
  final MobileAttachmentRef? remoteRef;
  final String? errorMessage;
}

class _AttachmentEntry {
  _AttachmentEntry({
    required this.localId,
    required this.fileName,
    required this.status,
    this.mimeType,
    this.sizeBytes,
    this.width,
    this.height,
    this.previewBytes,
    this.draftFileName,
    this.progress = 0,
    this.remoteRef,
    this.errorMessage,
  });

  final String localId;
  String fileName;
  ComposerAttachmentStatus status;
  String? mimeType;
  int? sizeBytes;
  int? width;
  int? height;
  Uint8List? previewBytes;
  String? draftFileName;
  double progress;
  MobileAttachmentRef? remoteRef;
  String? errorMessage;

  MobileAttachmentCancelToken? cancelToken;
  Future<void>? prepareTask;
  Future<void>? uploadTask;
  bool removed = false;

  ComposerAttachmentItem snapshot() => ComposerAttachmentItem(
    localId: localId,
    fileName: fileName,
    status: status,
    mimeType: mimeType,
    sizeBytes: sizeBytes,
    width: width,
    height: height,
    previewBytes: previewBytes,
    draftFileName: draftFileName,
    progress: progress,
    remoteRef: remoteRef,
    errorMessage: errorMessage,
  );

  DraftAttachmentRecord? toDraftRecord() {
    if (status == ComposerAttachmentStatus.preparing) return null;
    final resolvedMime = mimeType ?? remoteRef?.mimeType;
    final resolvedSize = sizeBytes ?? remoteRef?.sizeBytes;
    if (resolvedMime == null || resolvedSize == null) return null;
    final persistedStatus = switch (status) {
      ComposerAttachmentStatus.uploaded => 'uploaded',
      ComposerAttachmentStatus.failed => 'failed',
      ComposerAttachmentStatus.localOffline ||
      ComposerAttachmentStatus.uploading => 'localOffline',
      ComposerAttachmentStatus.preparing => 'localOffline',
    };
    return DraftAttachmentRecord(
      localId: localId,
      fileName: fileName,
      mimeType: resolvedMime,
      sizeBytes: resolvedSize,
      width: width ?? remoteRef?.width,
      height: height ?? remoteRef?.height,
      draftFileName: draftFileName,
      remoteRef: remoteRef,
      status: persistedStatus,
    );
  }
}

/// 供 `#147` 系统分享扩展/后台分享入口直接复用的预处理与离线草稿落地函数：
/// 校验魔数、后台压缩并写入 `<attachment_cache>/<computerHash>/drafts/`，
/// 返回可直接合并进 `ThreadDraftStorage` 或 `NewThreadForm` 的附件记录列表。
Future<({List<DraftAttachmentRecord> records, String? error})>
stageSharedImagesToDraft({
  required String computerKey,
  required List<String> paths,
  AttachmentCacheStore? cache,
  ImageCompressor? compressor,
  int existingCount = 0,
}) async {
  if (paths.isEmpty) {
    return (records: const <DraftAttachmentRecord>[], error: null);
  }
  final store = cache ?? AttachmentCacheStore.defaultInstance;
  final processor = compressor ?? const ImageCompressor();
  final remaining = mobileMaxMessageAttachments - existingCount;
  if (remaining <= 0) {
    return (
      records: const <DraftAttachmentRecord>[],
      error: '每条消息最多添加 $mobileMaxMessageAttachments 张图片。',
    );
  }
  String? error;
  final accepted = paths.length > remaining
      ? paths.sublist(0, remaining)
      : paths;
  if (paths.length > remaining) {
    error = '每条消息最多添加 $mobileMaxMessageAttachments 张图片，已忽略超出部分。';
  }
  final records = <DraftAttachmentRecord>[];
  for (final path in accepted) {
    try {
      final processed = await processor.compressFile(path);
      final localId = const Uuid().v4();
      final draftFileName = await store.writeDraftFile(
        computerKey,
        localId,
        processed.extension,
        processed.bytes,
      );
      records.add(
        DraftAttachmentRecord(
          localId: localId,
          fileName: processed.fileName,
          mimeType: processed.mimeType,
          sizeBytes: processed.sizeBytes,
          width: processed.width,
          height: processed.height,
          draftFileName: draftFileName,
          status: 'localOffline',
        ),
      );
    } on ImageProcessingException catch (failure) {
      error ??= failure.message;
    } catch (_) {
      error ??= '部分图片无法读取或处理失败。';
    }
  }
  return (
    records: List<DraftAttachmentRecord>.unmodifiable(records),
    error: error,
  );
}

/// 管理单个输入框（已有会话或新会话草稿）的待发图片列表、后台上传、取消、重试与离线草稿同步。
class ComposerAttachmentsController extends ChangeNotifier {
  ComposerAttachmentsController({
    required this.computerKey,
    required this._cache,
    this._compressor = const ImageCompressor(),
    this._connection,
    this._online = false,
    this.onDraftChanged,
  });

  final String computerKey;
  final AttachmentCacheStore _cache;
  final ImageCompressor _compressor;
  final void Function(List<DraftAttachmentRecord> records)? onDraftChanged;

  MobileConnection? _connection;
  bool _online;
  final _entries = <_AttachmentEntry>[];
  String? _bannerError;
  bool _disposed = false;

  List<ComposerAttachmentItem> get items =>
      List<ComposerAttachmentItem>.unmodifiable(
        _entries.map((entry) => entry.snapshot()),
      );

  String? get bannerError => _bannerError;
  int get count => _entries.length;
  int get remainingSlots => (mobileMaxMessageAttachments - _entries.length)
      .clamp(0, mobileMaxMessageAttachments);
  bool get isFull => _entries.length >= mobileMaxMessageAttachments;
  bool get hasItems => _entries.isNotEmpty;
  bool get hasSendableItems => _entries.any(
    (entry) =>
        entry.status == ComposerAttachmentStatus.uploaded ||
        entry.status == ComposerAttachmentStatus.uploading ||
        entry.status == ComposerAttachmentStatus.preparing ||
        entry.status == ComposerAttachmentStatus.localOffline,
  );
  bool get isBusy => _entries.any(
    (entry) =>
        entry.status == ComposerAttachmentStatus.preparing ||
        entry.status == ComposerAttachmentStatus.uploading,
  );

  bool get _canUploadNow =>
      _online && connectionSupportsAttachments(_connection);

  void dismissBannerError() {
    if (_bannerError == null || _disposed) return;
    _bannerError = null;
    _notify();
  }

  /// 更新电脑连接与在线状态；当从离线恢复在线且电脑支持附件时，自动为所有离线暂存图片补传。
  void updateConnection(MobileConnection? connection, {required bool online}) {
    if (_disposed) return;
    final changed = !identical(_connection, connection) || _online != online;
    _connection = connection;
    _online = online;
    if (!changed) return;
    if (_canUploadNow) {
      for (final entry in _entries) {
        if (entry.status == ComposerAttachmentStatus.localOffline) {
          _startUpload(entry);
        }
      }
    }
  }

  /// 供相册选图、拍照与 `#147` 系统分享统一调用的本地图片添加入口。
  Future<void> addLocalFiles(List<String> paths) async {
    if (_disposed || paths.isEmpty) return;
    final available = remainingSlots;
    if (available <= 0) {
      _bannerError = '每条消息最多添加 $mobileMaxMessageAttachments 张图片。';
      _notify();
      return;
    }
    String? overflowNotice;
    final accepted = paths.length > available
        ? paths.sublist(0, available)
        : paths;
    if (paths.length > available) {
      overflowNotice = '每条消息最多添加 $mobileMaxMessageAttachments 张图片，已忽略超出部分。';
    }
    _bannerError = overflowNotice;

    final tasks = <Future<void>>[];
    for (final path in accepted) {
      final entry = _AttachmentEntry(
        localId: const Uuid().v4(),
        fileName: _fileBaseName(path),
        status: ComposerAttachmentStatus.preparing,
      );
      _entries.add(entry);
      final task = _prepareEntry(entry, () => _compressor.compressFile(path));
      entry.prepareTask = task;
      tasks.add(task);
    }
    _notify();
    await Future.wait(tasks);
  }

  /// 为 `#147` 系统分享预留的语义化别名，复用同一条压缩、草稿与上传流水线。
  Future<void> stageSharedImages(List<String> paths) => addLocalFiles(paths);

  /// 直接从内存字节添加图片（供剪贴板、分享字节流与测试共用）。
  Future<void> addImageBytes(
    List<({Uint8List bytes, String? fileName})> images,
  ) async {
    if (_disposed || images.isEmpty) return;
    final available = remainingSlots;
    if (available <= 0) {
      _bannerError = '每条消息最多添加 $mobileMaxMessageAttachments 张图片。';
      _notify();
      return;
    }
    String? overflowNotice;
    final accepted = images.length > available
        ? images.sublist(0, available)
        : images;
    if (images.length > available) {
      overflowNotice = '每条消息最多添加 $mobileMaxMessageAttachments 张图片，已忽略超出部分。';
    }
    _bannerError = overflowNotice;

    final tasks = <Future<void>>[];
    for (final item in accepted) {
      final entry = _AttachmentEntry(
        localId: const Uuid().v4(),
        fileName: item.fileName ?? 'image.jpg',
        status: ComposerAttachmentStatus.preparing,
      );
      _entries.add(entry);
      final task = _prepareEntry(
        entry,
        () => _compressor.compressBytes(item.bytes, fileName: item.fileName),
      );
      entry.prepareTask = task;
      tasks.add(task);
    }
    _notify();
    await Future.wait(tasks);
  }

  Future<void> _prepareEntry(
    _AttachmentEntry entry,
    Future<ProcessedImage> Function() compress,
  ) async {
    try {
      final processed = await compress();
      if (_disposed || entry.removed) return;
      final draftFileName = await _cache.writeDraftFile(
        computerKey,
        entry.localId,
        processed.extension,
        processed.bytes,
      );
      if (_disposed || entry.removed) {
        unawaited(_cache.deleteDraftFile(computerKey, draftFileName));
        return;
      }
      entry
        ..fileName = processed.fileName
        ..mimeType = processed.mimeType
        ..sizeBytes = processed.sizeBytes
        ..width = processed.width
        ..height = processed.height
        ..previewBytes = processed.bytes
        ..draftFileName = draftFileName
        ..errorMessage = null;

      if (_canUploadNow) {
        _startUpload(entry);
      } else {
        entry.status = ComposerAttachmentStatus.localOffline;
        _notify();
        _emitDraft();
      }
    } on ImageProcessingException catch (error) {
      if (_disposed || entry.removed) return;
      _entries.remove(entry);
      _bannerError = error.message;
      _notify();
      _emitDraft();
    } catch (_) {
      if (_disposed || entry.removed) return;
      _entries.remove(entry);
      _bannerError = '无法读取所选图片，请重试。';
      _notify();
      _emitDraft();
    } finally {
      entry.prepareTask = null;
    }
  }

  void _startUpload(_AttachmentEntry entry) {
    if (_disposed || entry.removed) return;
    final connection = _connection;
    if (!_online || !connectionSupportsAttachments(connection)) {
      entry
        ..status = ComposerAttachmentStatus.localOffline
        ..errorMessage = null;
      _notify();
      _emitDraft();
      return;
    }

    entry.cancelToken?.cancel();
    final token = MobileAttachmentCancelToken();
    entry
      ..cancelToken = token
      ..status = ComposerAttachmentStatus.uploading
      ..progress = 0
      ..errorMessage = null;
    _notify();
    _emitDraft();

    final future = _runUpload(entry, connection!, token);
    entry.uploadTask = future;
    unawaited(future);
  }

  Future<void> _runUpload(
    _AttachmentEntry entry,
    MobileConnection connection,
    MobileAttachmentCancelToken token,
  ) async {
    try {
      var bytes = entry.previewBytes;
      if (bytes == null && entry.draftFileName != null) {
        bytes = await _cache.readDraftFile(computerKey, entry.draftFileName!);
        entry.previewBytes = bytes;
      }
      if (_disposed || entry.removed || token.isCancelled) return;
      if (bytes == null || bytes.isEmpty) {
        throw const ImageProcessingException('本地图片副本已丢失，请重新选择。');
      }
      final mimeType =
          entry.mimeType ?? detectImageMimeType(bytes) ?? 'image/jpeg';
      final ref = await connection.uploadAttachment(
        bytes: bytes,
        mimeType: mimeType,
        fileName: entry.fileName,
        width: entry.width,
        height: entry.height,
        cancelToken: token,
        onProgress: (progress) {
          if (_disposed || entry.removed || token.isCancelled) return;
          final clamped = progress.fraction.clamp(0.0, 1.0);
          if ((clamped - entry.progress).abs() >= 0.01 || clamped >= 1.0) {
            entry.progress = clamped;
            _notify();
          }
        },
      );
      if (_disposed || entry.removed || token.isCancelled) return;
      entry
        ..remoteRef = ref
        ..mimeType = ref.mimeType
        ..fileName = ref.fileName
        ..sizeBytes = ref.sizeBytes
        ..width = ref.width ?? entry.width
        ..height = ref.height ?? entry.height
        ..status = ComposerAttachmentStatus.uploaded
        ..progress = 1.0
        ..errorMessage = null;
      if (bytes.isNotEmpty) {
        unawaited(_cache.writeThumb(computerKey, ref.id, bytes));
      }
      _notify();
      _emitDraft();
    } on MobileAttachmentUploadCancelled {
      // 用户主动取消，静默结束。
    } catch (error) {
      if (_disposed || entry.removed || token.isCancelled) return;
      final message = _uploadErrorMessage(error);
      entry
        ..status = ComposerAttachmentStatus.failed
        ..errorMessage = message;
      _bannerError = message;
      _notify();
      _emitDraft();
    } finally {
      if (identical(entry.cancelToken, token)) {
        entry.cancelToken = null;
      }
      entry.uploadTask = null;
    }
  }

  String _uploadErrorMessage(Object error) {
    if (error is MobileRpcFailure) return error.problem.message;
    if (error is ImageProcessingException) return error.message;
    return '图片上传失败，请点按失败图片重试。';
  }

  /// 移除单张图片：正在上传时立即中止分片传输，并删除本地草稿副本。
  Future<void> remove(String localId) async {
    if (_disposed) return;
    final index = _entries.indexWhere((entry) => entry.localId == localId);
    if (index < 0) return;
    final entry = _entries.removeAt(index);
    entry.removed = true;
    entry.cancelToken?.cancel();
    final draftFileName = entry.draftFileName;
    if (_entries.isEmpty && _bannerError != null) {
      _bannerError = null;
    }
    _notify();
    _emitDraft();
    if (draftFileName != null) {
      await _cache.deleteDraftFile(computerKey, draftFileName);
    }
  }

  /// 重试失败或离线待传的图片。
  void retry(String localId) {
    if (_disposed) return;
    final entry = _entries.where((e) => e.localId == localId).firstOrNull;
    if (entry == null) return;
    if (entry.status != ComposerAttachmentStatus.failed &&
        entry.status != ComposerAttachmentStatus.localOffline) {
      return;
    }
    if (!_canUploadNow) {
      _bannerError = '电脑离线，恢复连接后再试。';
      _notify();
      return;
    }
    _bannerError = null;
    _startUpload(entry);
  }

  /// 发送前等待全部图片压缩与上传完毕，返回按顺序排列的 `attachmentIds`。
  /// 任一张失败或仍处于离线状态时返回 `null` 并提示用户重试，绝不清空文本与已传图片。
  Future<List<String>?> ensureAllUploaded() async {
    if (_disposed) return null;
    if (_entries.isEmpty) return const [];

    final prepareTasks = [for (final entry in _entries) ?entry.prepareTask];
    if (prepareTasks.isNotEmpty) {
      await Future.wait(prepareTasks);
    }
    if (_disposed) return null;

    if (_canUploadNow) {
      for (final entry in _entries) {
        if (entry.status == ComposerAttachmentStatus.localOffline) {
          _startUpload(entry);
        }
      }
    }

    final uploadTasks = [for (final entry in _entries) ?entry.uploadTask];
    if (uploadTasks.isNotEmpty) {
      await Future.wait(uploadTasks);
    }
    if (_disposed) return null;

    if (_entries.any(
      (entry) => entry.status == ComposerAttachmentStatus.failed,
    )) {
      _bannerError = '有图片上传失败，请点按失败图片重试或移除后再发送。';
      _notify();
      return null;
    }
    if (_entries.any(
      (entry) =>
          entry.status != ComposerAttachmentStatus.uploaded ||
          entry.remoteRef == null,
    )) {
      _bannerError = '有图片尚未上传完成，请等待电脑恢复在线后再发送。';
      _notify();
      return null;
    }
    return List<String>.unmodifiable(
      _entries.map((entry) => entry.remoteRef!.id),
    );
  }

  /// 清空输入框中的所有待发图片（发送成功后调用，默认同步删除本地草稿副本）。
  Future<void> clear({bool deleteDraftFiles = true}) async {
    if (_disposed) return;
    final removed = List<_AttachmentEntry>.of(_entries);
    _entries.clear();
    _bannerError = null;
    for (final entry in removed) {
      entry.removed = true;
      entry.cancelToken?.cancel();
    }
    _notify();
    _emitDraft();
    if (deleteDraftFiles) {
      for (final entry in removed) {
        if (entry.draftFileName case final fileName?) {
          await _cache.deleteDraftFile(computerKey, fileName);
        }
      }
    }
  }

  /// 仅清空与本次已提交 `attachmentIds` 完全匹配的条目（防止用户在发送确认期间新加了图被误删）。
  Future<void> clearCommittedIds(List<String> attachmentIds) async {
    if (_disposed || attachmentIds.isEmpty) return;
    final idSet = attachmentIds.toSet();
    final removed = <_AttachmentEntry>[];
    _entries.removeWhere((entry) {
      final match =
          entry.remoteRef != null && idSet.contains(entry.remoteRef!.id);
      if (match) removed.add(entry);
      return match;
    });
    if (removed.isEmpty) return;
    for (final entry in removed) {
      entry.removed = true;
      entry.cancelToken?.cancel();
    }
    _notify();
    _emitDraft();
    for (final entry in removed) {
      if (entry.draftFileName case final fileName?) {
        await _cache.deleteDraftFile(computerKey, fileName);
      }
    }
  }

  /// 待发消息撤回后，将已提交的 `MobileAttachmentRef` 列表还原到输入框（无需重新上传）。
  Future<void> restoreCommittedRefs(
    List<MobileAttachmentRef> refs, {
    String? threadId,
  }) async {
    if (_disposed || refs.isEmpty) return;
    final existingIds = {
      for (final entry in _entries)
        if (entry.remoteRef case final ref?) ref.id,
    };
    final added = <_AttachmentEntry>[];
    var truncated = false;
    for (final ref in refs) {
      if (existingIds.contains(ref.id)) continue;
      if (_entries.length >= mobileMaxMessageAttachments) {
        truncated = true;
        break;
      }
      final entry = _AttachmentEntry(
        localId: const Uuid().v4(),
        fileName: ref.fileName,
        mimeType: ref.mimeType,
        sizeBytes: ref.sizeBytes,
        width: ref.width,
        height: ref.height,
        remoteRef: ref,
        status: ComposerAttachmentStatus.uploaded,
        progress: 1.0,
        previewBytes: _cache.peekThumbMemory(computerKey, ref.id),
      );
      _entries.add(entry);
      existingIds.add(ref.id);
      added.add(entry);
    }
    if (truncated) {
      _bannerError =
          '撤回的附件超出 $mobileMaxMessageAttachments 张上限，已保留前 $mobileMaxMessageAttachments 张。';
    }
    if (added.isEmpty && !truncated) return;
    _notify();
    _emitDraft();

    for (final entry in added) {
      if (entry.previewBytes != null) continue;
      unawaited(_hydrateRemotePreview(entry, threadId: threadId));
    }
  }

  Future<void> _hydrateRemotePreview(
    _AttachmentEntry entry, {
    String? threadId,
  }) async {
    final ref = entry.remoteRef;
    if (ref == null || _disposed || entry.removed) return;
    final cached = await _cache.readThumb(computerKey, ref.id);
    if (_disposed || entry.removed) return;
    if (cached != null) {
      entry.previewBytes = cached;
      _notify();
      return;
    }
    final connection = _connection;
    if (!_online || !connectionSupportsAttachments(connection)) return;
    try {
      final data = await connection!.readAttachmentThumb(
        ref.id,
        threadId: threadId,
      );
      if (_disposed || entry.removed) return;
      entry.previewBytes = data.bytes;
      unawaited(_cache.writeThumb(computerKey, ref.id, data.bytes));
      _notify();
    } catch (_) {
      // 缩略图暂时不可用时保留占位显示，不影响重新发送。
    }
  }

  /// 导出可持久化进本地草稿的附件元数据列表。
  List<DraftAttachmentRecord> serializeForDraft() =>
      List<DraftAttachmentRecord>.unmodifiable([
        for (final entry in _entries) ?entry.toDraftRecord(),
      ]);

  /// 从持久化的本地草稿记录恢复待发图片；缺失副本文件的离线记录会被自动过滤。
  Future<void> restoreFromDraft(
    List<DraftAttachmentRecord> records, {
    String? threadId,
  }) async {
    if (_disposed || records.isEmpty) return;
    final existingLocalIds = _entries.map((entry) => entry.localId).toSet();
    final existingRemoteIds = {
      for (final entry in _entries)
        if (entry.remoteRef case final ref?) ref.id,
    };
    var dropped = false;
    var addedAny = false;
    final toHydrate = <_AttachmentEntry>[];
    final toUpload = <_AttachmentEntry>[];

    for (final record in records) {
      if (_entries.length >= mobileMaxMessageAttachments) break;
      if (existingLocalIds.contains(record.localId)) continue;
      if (record.remoteRef != null &&
          existingRemoteIds.contains(record.remoteRef!.id)) {
        continue;
      }

      Uint8List? bytes;
      if (record.draftFileName case final fileName?) {
        bytes = await _cache.readDraftFile(computerKey, fileName);
      }
      if (_disposed) return;

      if (record.remoteRef != null && record.status == 'uploaded') {
        final entry = _AttachmentEntry(
          localId: record.localId,
          fileName: record.fileName,
          mimeType: record.mimeType,
          sizeBytes: record.sizeBytes,
          width: record.width,
          height: record.height,
          draftFileName: bytes != null ? record.draftFileName : null,
          previewBytes:
              bytes ??
              _cache.peekThumbMemory(computerKey, record.remoteRef!.id),
          remoteRef: record.remoteRef,
          status: ComposerAttachmentStatus.uploaded,
          progress: 1.0,
        );
        _entries.add(entry);
        existingLocalIds.add(entry.localId);
        existingRemoteIds.add(record.remoteRef!.id);
        addedAny = true;
        if (entry.previewBytes == null) toHydrate.add(entry);
      } else if (bytes != null) {
        final status = record.status == 'failed'
            ? ComposerAttachmentStatus.failed
            : ComposerAttachmentStatus.localOffline;
        final entry = _AttachmentEntry(
          localId: record.localId,
          fileName: record.fileName,
          mimeType: record.mimeType,
          sizeBytes: record.sizeBytes,
          width: record.width,
          height: record.height,
          draftFileName: record.draftFileName,
          previewBytes: bytes,
          status: status,
          errorMessage: status == ComposerAttachmentStatus.failed
              ? '上传失败，点按重试'
              : null,
        );
        _entries.add(entry);
        existingLocalIds.add(entry.localId);
        addedAny = true;
        if (status == ComposerAttachmentStatus.localOffline && _canUploadNow) {
          toUpload.add(entry);
        }
      } else {
        dropped = true;
      }
    }

    if (addedAny) _notify();
    if (dropped) _emitDraft();
    for (final entry in toHydrate) {
      unawaited(_hydrateRemotePreview(entry, threadId: threadId));
    }
    for (final entry in toUpload) {
      _startUpload(entry);
    }
  }

  void _emitDraft() {
    if (_disposed) return;
    onDraftChanged?.call(serializeForDraft());
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    for (final entry in _entries) {
      entry.cancelToken?.cancel();
    }
    super.dispose();
  }
}

String _fileBaseName(String path) {
  final normalized = path.replaceAll('\\', '/');
  final index = normalized.lastIndexOf('/');
  final name = index >= 0 ? normalized.substring(index + 1) : normalized;
  return name.isEmpty ? 'image.jpg' : name;
}
