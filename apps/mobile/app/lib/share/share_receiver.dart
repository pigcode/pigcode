import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// 原生层（Android `ACTION_SEND` / iOS `ShareExtension`）传入的一次系统分享图片批次。
@immutable
final class IncomingShareBatch {
  IncomingShareBatch({
    required this.batchId,
    required List<String> paths,
    this.truncatedCount = 0,
  }) : paths = List<String>.unmodifiable(paths);

  final String batchId;
  final List<String> paths;
  final int truncatedCount;

  static IncomingShareBatch? fromWire(Object? raw) {
    if (raw is! Map) return null;
    final batchId = raw['batchId'];
    final rawPaths = raw['paths'];
    if (batchId is! String || batchId.isEmpty || rawPaths is! List) {
      return null;
    }
    final paths = [
      for (final item in rawPaths)
        if (item is String && item.isNotEmpty) item,
    ];
    if (paths.isEmpty) return null;
    final rawTruncated = raw['truncatedCount'];
    final truncatedCount = rawTruncated is int && rawTruncated > 0
        ? rawTruncated
        : 0;
    return IncomingShareBatch(
      batchId: batchId,
      paths: paths,
      truncatedCount: truncatedCount,
    );
  }

  IncomingShareBatch removeAt(int index) {
    final next = [...paths]..removeAt(index);
    return IncomingShareBatch(
      batchId: batchId,
      paths: next,
      truncatedCount: truncatedCount,
    );
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is IncomingShareBatch &&
          batchId == other.batchId &&
          truncatedCount == other.truncatedCount &&
          listEquals(paths, other.paths);

  @override
  int get hashCode =>
      Object.hash(batchId, truncatedCount, Object.hashAll(paths));
}

/// 用户在「发送到 Pigcode」选择器中点选的目标位置。
@immutable
final class ShareTargetSelection {
  const ShareTargetSelection.existingThread({
    required this.computerKey,
    required this.threadId,
  }) : isNewThread = false;

  const ShareTargetSelection.newThread({required this.computerKey})
    : threadId = null,
      isNewThread = true;

  final String computerKey;
  final String? threadId;
  final bool isNewThread;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ShareTargetSelection &&
          computerKey == other.computerKey &&
          threadId == other.threadId &&
          isNewThread == other.isNewThread;

  @override
  int get hashCode => Object.hash(computerKey, threadId, isNewThread);
}

/// 通知 `WorkspaceView` 切换到分享目标会话或新会话草稿。
@immutable
final class ShareNavigationRequest {
  const ShareNavigationRequest({
    required this.id,
    this.threadId,
    this.openDraft = false,
  });

  final String id;
  final String? threadId;
  final bool openDraft;
}

/// 向已挂载的 `TimelinePane` 或 `NewThreadDraft` 实时注入待发分享图片的句柄。
final class LiveShareInjection {
  LiveShareInjection({
    required this.id,
    required List<String> paths,
    this.threadId,
    this.forNewThread = false,
  }) : paths = List<String>.unmodifiable(paths);

  final String id;
  final List<String> paths;
  final String? threadId;
  final bool forNewThread;
  final Completer<void> done = Completer<void>();

  void complete() {
    if (!done.isCompleted) done.complete();
  }
}

/// 原生分享通道抽象（`pigcode/share`），支持测试注入桩实现。
abstract interface class MobileShareChannel {
  Stream<IncomingShareBatch> get batches;
  Future<IncomingShareBatch?> consumePendingBatch();
  Future<void> cleanupBatch(String batchId);
  void dispose();
}

/// 基于 `MethodChannel('pigcode/share')` 的默认双端原生通道实现。
class MethodChannelMobileShareChannel implements MobileShareChannel {
  MethodChannelMobileShareChannel({MethodChannel? channel})
    : _channel = channel ?? const MethodChannel(channelName) {
    _channel.setMethodCallHandler(_handleCall);
  }

  static const channelName = 'pigcode/share';

  final MethodChannel _channel;
  final _batches = StreamController<IncomingShareBatch>.broadcast();
  bool _disposed = false;

  @override
  Stream<IncomingShareBatch> get batches => _batches.stream;

  Future<Object?> _handleCall(MethodCall call) async {
    if (_disposed) return null;
    if (call.method == 'onShareBatch') {
      final batch = IncomingShareBatch.fromWire(call.arguments);
      if (batch != null && !_batches.isClosed) {
        _batches.add(batch);
      }
    }
    return null;
  }

  @override
  Future<IncomingShareBatch?> consumePendingBatch() async {
    if (_disposed) return null;
    try {
      final raw = await _channel.invokeMethod<Object?>('consumePendingBatch');
      return IncomingShareBatch.fromWire(raw);
    } on MissingPluginException {
      return null;
    } on PlatformException {
      return null;
    } on TypeError {
      return null;
    }
  }

  @override
  Future<void> cleanupBatch(String batchId) async {
    if (_disposed || batchId.isEmpty) return;
    try {
      await _channel.invokeMethod<void>('cleanupBatch', {'batchId': batchId});
    } on MissingPluginException {
      // 非移动平台或单测无原生宿主时静默忽略。
    } on PlatformException {
      // 原生启动时也会按 24 小时 TTL 兜底清理孤儿目录。
    }
  }

  @override
  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _channel.setMethodCallHandler(null);
    unawaited(_batches.close());
  }
}

final mobileShareChannelProvider = Provider<MobileShareChannel>((ref) {
  final channel = MethodChannelMobileShareChannel();
  ref.onDispose(channel.dispose);
  return channel;
});

final shareReceiverProvider =
    NotifierProvider<ShareReceiverController, IncomingShareBatch?>(
      ShareReceiverController.new,
    );

final pendingShareBatchProvider = Provider<IncomingShareBatch?>(
  (ref) => ref.watch(shareReceiverProvider),
);

/// 统一管理冷启动拉取、热启动推送、图片删减与临时目录清理的分享控制器。
class ShareReceiverController extends Notifier<IncomingShareBatch?> {
  late MobileShareChannel _channel;
  StreamSubscription<IncomingShareBatch>? _subscription;
  final _seenBatchIds = <String>{};
  final _cleanedBatchIds = <String>{};

  @override
  IncomingShareBatch? build() {
    _channel = ref.watch(mobileShareChannelProvider);
    _subscription = _channel.batches.listen(
      _acceptBatch,
      onError: (Object _) {},
    );
    ref.onDispose(() => unawaited(_subscription?.cancel()));
    unawaited(Future<void>.microtask(checkPending));
    return null;
  }

  /// 首帧或应用恢复前台时拉取冷启动/暂存批次。
  Future<void> checkPending() async {
    final batch = await _channel.consumePendingBatch();
    if (!ref.mounted || batch == null) return;
    _acceptBatch(batch);
  }

  void _acceptBatch(IncomingShareBatch batch) {
    if (!ref.mounted || batch.paths.isEmpty) return;
    if (!_seenBatchIds.add(batch.batchId)) return;
    if (_seenBatchIds.length > 128) {
      _seenBatchIds.remove(_seenBatchIds.first);
    }
    final previous = state;
    if (previous != null && previous.batchId != batch.batchId) {
      unawaited(_cleanupOnce(previous.batchId));
    }
    state = batch;
  }

  /// 在「发送到 Pigcode」选择器中移除误选的单张图片；全删完后自动关闭并清理原生临时目录。
  void removeImageAt(int index) {
    final current = state;
    if (!ref.mounted ||
        current == null ||
        index < 0 ||
        index >= current.paths.length) {
      return;
    }
    if (current.paths.length <= 1) {
      unawaited(dismiss());
      return;
    }
    state = current.removeAt(index);
  }

  /// 取消分享选择器或因未配对/旧版电脑关闭提示时调用，彻底清理该批次临时目录。
  Future<void> dismiss() async {
    final current = state;
    if (current == null) return;
    if (ref.mounted) state = null;
    await _cleanupOnce(current.batchId);
  }

  /// 合入目标输入框完毕后调用，确保原生 `shared_incoming/<batchId>/` 被立即清理。
  Future<void> completeBatch(String batchId) async {
    if (ref.mounted && state?.batchId == batchId) {
      state = null;
    }
    await _cleanupOnce(batchId);
  }

  Future<void> _cleanupOnce(String batchId) async {
    if (batchId.isEmpty || !_cleanedBatchIds.add(batchId)) return;
    if (_cleanedBatchIds.length > 128) {
      _cleanedBatchIds.remove(_cleanedBatchIds.first);
    }
    await _channel.cleanupBatch(batchId);
  }
}
