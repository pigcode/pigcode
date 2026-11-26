import 'dart:async';
import 'dart:collection';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

import 'offline_cache.dart';

enum ComputerSummarySyncState { idle, syncing, error, revoked }

enum CrossComputerFilter { all, attention, error, unread }

final class ComputerSummaryEntry {
  const ComputerSummaryEntry({
    required this.profile,
    required this.isActive,
    required this.activeConnected,
    this.relayStatus,
    this.summary,
    this.syncState = ComputerSummarySyncState.idle,
    this.lastError,
    this.lastAttemptAt,
  });

  final ComputerProfile profile;
  final bool isActive;
  final bool activeConnected;
  final RelayComputerStatus? relayStatus;
  final MobileComputerSummary? summary;
  final ComputerSummarySyncState syncState;
  final String? lastError;
  final DateTime? lastAttemptAt;

  bool get isOnline => isActive
      ? (activeConnected || relayStatus?.state == RelayComputerState.online)
      : relayStatus?.state == RelayComputerState.online;

  bool get isRevoked => syncState == ComputerSummarySyncState.revoked;

  MobileSummaryCounts get counts => summary?.counts ?? MobileSummaryCounts.zero;

  DateTime? get syncedAt => summary?.syncedAt;

  ComputerSummaryEntry copyWith({
    ComputerProfile? profile,
    bool? isActive,
    bool? activeConnected,
    RelayComputerStatus? relayStatus,
    bool clearRelayStatus = false,
    MobileComputerSummary? summary,
    bool clearSummary = false,
    ComputerSummarySyncState? syncState,
    String? lastError,
    bool clearLastError = false,
    DateTime? lastAttemptAt,
  }) => ComputerSummaryEntry(
    profile: profile ?? this.profile,
    isActive: isActive ?? this.isActive,
    activeConnected: activeConnected ?? this.activeConnected,
    relayStatus: clearRelayStatus ? null : (relayStatus ?? this.relayStatus),
    summary: clearSummary ? null : (summary ?? this.summary),
    syncState: syncState ?? this.syncState,
    lastError: clearLastError ? null : (lastError ?? this.lastError),
    lastAttemptAt: lastAttemptAt ?? this.lastAttemptAt,
  );
}

final class CrossComputerInboxItem {
  const CrossComputerInboxItem({
    required this.computer,
    required this.item,
    required this.syncedAt,
    required this.computerOnline,
    required this.isActiveComputer,
    this.relayState,
  });

  final ComputerProfile computer;
  final MobileSummaryItem item;
  final DateTime syncedAt;
  final bool computerOnline;
  final bool isActiveComputer;
  final RelayComputerState? relayState;

  int get urgencyRank {
    if (item.isAttention) return 0;
    if (item.isError) return 1;
    return 2;
  }

  bool matchesFilter(CrossComputerFilter filter) => switch (filter) {
    CrossComputerFilter.all =>
      item.isAttention || item.isError || item.isUnread,
    CrossComputerFilter.attention => item.isAttention,
    CrossComputerFilter.error => item.isError,
    CrossComputerFilter.unread => item.isUnread,
  };
}

typedef ComputerSummaryFetcher =
    Future<MobileComputerSummary> Function(
      ComputerProfile computer,
      NoiseIdentity identity,
    );

typedef RelayStatusObserver =
    Future<RelayStatusWatch> Function(ComputerProfile computer);

typedef MultiComputerCoordinatorFactory =
    MultiComputerCoordinator Function(OfflineCacheStore cacheStore);

final multiComputerCoordinatorFactoryProvider =
    Provider<MultiComputerCoordinatorFactory>(
      (_) =>
          (cacheStore) => MultiComputerCoordinator(cacheStore: cacheStore),
    );

Future<MobileComputerSummary> defaultFetchComputerSummary(
  ComputerProfile computer,
  NoiseIdentity identity, {
  Duration timeout = const Duration(seconds: 8),
}) async {
  final connection = await MobileConnection.resume(
    computer,
    identity,
  ).timeout(timeout);
  try {
    return await connection.summary.fetch().timeout(timeout);
  } finally {
    await connection.close();
  }
}

/// 跨电脑汇总调度器：
/// - 并发监听非当前电脑的中继状态（不改中继、退后台自动暂停）
/// - 按需对在线非当前电脑以受控并发短连接拉取轻量摘要并写入按机隔离的加密缓存
/// - 当前电脑直接复用实时侧栏/主连接，零重复建连
class MultiComputerCoordinator extends ChangeNotifier {
  MultiComputerCoordinator({
    required this.cacheStore,
    ComputerSummaryFetcher? fetchSummary,
    RelayStatusObserver? observeStatus,
    DateTime Function()? now,
    this.syncTimeout = const Duration(seconds: 8),
    this.autoCooldown = const Duration(seconds: 20),
    this.maxConcurrency = 3,
  }) : _fetchSummary = fetchSummary ?? defaultFetchComputerSummary,
       _observeStatus = observeStatus ?? RelayStatusWatch.open,
       _now = now ?? DateTime.now;

  final OfflineCacheStore cacheStore;
  final ComputerSummaryFetcher _fetchSummary;
  final RelayStatusObserver _observeStatus;
  final DateTime Function() _now;
  final Duration syncTimeout;
  final Duration autoCooldown;
  final int maxConcurrency;

  final Map<String, ComputerSummaryEntry> _entries = {};
  final List<String> _order = [];
  final Map<String, RelayStatusWatch> _watchers = {};
  final Map<String, StreamSubscription<RelayComputerStatus>> _watchSubs = {};
  final Map<String, Timer> _rewatchTimers = {};
  final Set<String> _loadedCacheKeys = {};
  final Set<String> _inFlightKeys = {};
  final Queue<String> _queue = Queue<String>();
  final Map<String, List<Completer<void>>> _waiters = {};
  final Map<String, int> _probeGenerations = {};

  NoiseIdentity? _identity;
  String? _activeKey;
  bool _foreground = true;
  bool _disposed = false;
  int _activeProbes = 0;

  List<ComputerSummaryEntry> get entries =>
      List<ComputerSummaryEntry>.unmodifiable(
        _order.map((key) => _entries[key]).whereType<ComputerSummaryEntry>(),
      );

  ComputerSummaryEntry? entryFor(String computerKey) => _entries[computerKey];

  bool get isSyncing => _entries.values.any(
    (entry) => entry.syncState == ComputerSummarySyncState.syncing,
  );

  int get onlineCount =>
      _entries.values.where((entry) => entry.isOnline).length;

  int get otherComputersUrgentCount {
    var total = 0;
    for (final entry in _entries.values) {
      if (entry.isActive || entry.isRevoked) continue;
      total += entry.counts.urgent;
    }
    return total;
  }

  MobileSummaryCounts get totalCounts {
    var attention = 0;
    var error = 0;
    var unread = 0;
    var working = 0;
    var total = 0;
    for (final entry in _entries.values) {
      if (entry.isRevoked) continue;
      final counts = entry.counts;
      attention += counts.attention;
      error += counts.error;
      unread += counts.unread;
      working += counts.working;
      total += counts.total;
    }
    return MobileSummaryCounts(
      attention: attention,
      error: error,
      unread: unread,
      working: working,
      total: total,
    );
  }

  DateTime? get latestSyncedAt {
    DateTime? latest;
    for (final entry in _entries.values) {
      final synced = entry.syncedAt;
      if (synced == null) continue;
      if (latest == null || synced.isAfter(latest)) latest = synced;
    }
    return latest;
  }

  List<CrossComputerInboxItem> inboxItems({
    CrossComputerFilter filter = CrossComputerFilter.all,
    String? computerKey,
  }) {
    final result = <CrossComputerInboxItem>[];
    for (final entry in entries) {
      if (entry.isRevoked) continue;
      if (computerKey != null && entry.profile.computerKey != computerKey) {
        continue;
      }
      final summary = entry.summary;
      if (summary == null) continue;
      for (final item in summary.items) {
        final wrapped = CrossComputerInboxItem(
          computer: entry.profile,
          item: item,
          syncedAt: summary.syncedAt,
          computerOnline: entry.isOnline,
          isActiveComputer: entry.isActive,
          relayState: entry.relayStatus?.state,
        );
        if (wrapped.matchesFilter(filter)) result.add(wrapped);
      }
    }
    result.sort((a, b) {
      final rankCmp = a.urgencyRank.compareTo(b.urgencyRank);
      if (rankCmp != 0) return rankCmp;
      final timeCmp = b.item.updatedAt.compareTo(a.item.updatedAt);
      if (timeCmp != 0) return timeCmp;
      final compCmp = a.computer.computerKey.compareTo(b.computer.computerKey);
      if (compCmp != 0) return compCmp;
      return a.item.threadId.compareTo(b.item.threadId);
    });
    return List<CrossComputerInboxItem>.unmodifiable(result);
  }

  void updateComputers(
    List<ComputerProfile> computers, {
    required NoiseIdentity identity,
  }) {
    if (_disposed) return;
    _identity = identity;
    final nextKeys = computers.map((c) => c.computerKey).toSet();
    final removed = _entries.keys.where((k) => !nextKeys.contains(k)).toList();
    var changed = removed.isNotEmpty;

    for (final key in removed) {
      _stopWatcher(key);
      _entries.remove(key);
      _loadedCacheKeys.remove(key);
      _inFlightKeys.remove(key);
      _queue.remove(key);
      _probeGenerations[key] = (_probeGenerations[key] ?? 0) + 1;
      _completeWaiters(key);
    }

    final nextOrder = computers.map((c) => c.computerKey).toList();
    if (!listEquals(_order, nextOrder)) {
      _order
        ..clear()
        ..addAll(nextOrder);
      changed = true;
    }

    for (final profile in computers) {
      final key = profile.computerKey;
      final existing = _entries[key];
      if (existing == null) {
        _entries[key] = ComputerSummaryEntry(
          profile: profile,
          isActive: key == _activeKey,
          activeConnected: false,
        );
        changed = true;
        unawaited(_loadCachedSummary(profile));
      } else if (existing.profile.name != profile.name ||
          existing.profile.address != profile.address ||
          existing.profile.token != profile.token) {
        final relayChanged =
            existing.profile.address != profile.address ||
            existing.profile.token != profile.token;
        _entries[key] = existing.copyWith(
          profile: profile,
          syncState: relayChanged && existing.isRevoked
              ? ComputerSummarySyncState.idle
              : existing.syncState,
          clearLastError: relayChanged,
        );
        changed = true;
        if (relayChanged) _stopWatcher(key);
      }
    }

    if (changed) notifyListeners();
    _syncWatchers();
  }

  void setActiveComputer({
    required String? computerKey,
    required bool connected,
    RelayComputerStatus? status,
    SidebarSnapshot? sidebar,
    MobileComputerSummary? summary,
  }) {
    if (_disposed) return;
    final previousActive = _activeKey;
    _activeKey = computerKey;
    var changed = previousActive != computerKey;

    if (previousActive != null && previousActive != computerKey) {
      final prev = _entries[previousActive];
      if (prev != null) {
        _entries[previousActive] = prev.copyWith(
          isActive: false,
          activeConnected: false,
        );
        changed = true;
      }
    }

    if (computerKey != null) {
      // 切到该电脑后，取消任何针对它的后台短连接探针，避免抢占或旧数据覆盖。
      _probeGenerations[computerKey] =
          (_probeGenerations[computerKey] ?? 0) + 1;
      _queue.remove(computerKey);
      _stopWatcher(computerKey);

      final existing = _entries[computerKey];
      if (existing != null) {
        MobileComputerSummary? nextSummary = summary ?? existing.summary;
        if (summary == null && sidebar != null) {
          final derived = _summaryFromSidebar(
            existing.profile,
            sidebar,
            previous: existing.summary,
          );
          if (derived != null) {
            nextSummary = derived;
            unawaited(
              cacheStore
                  .open(computerKey)
                  .saveSummary(derived)
                  .catchError((Object _) {}),
            );
          }
        } else if (summary != null) {
          unawaited(
            cacheStore
                .open(computerKey)
                .saveSummary(summary)
                .catchError((Object _) {}),
          );
        }
        final next = existing.copyWith(
          isActive: true,
          activeConnected: connected,
          relayStatus: status ?? existing.relayStatus,
          summary: nextSummary,
          syncState:
              connected && existing.syncState != ComputerSummarySyncState.idle
              ? ComputerSummarySyncState.idle
              : existing.syncState,
          clearLastError: connected,
        );
        if (!_sameEntry(existing, next)) {
          _entries[computerKey] = next;
          changed = true;
        }
      }
    }

    if (changed) notifyListeners();
    if (previousActive != computerKey) _syncWatchers();
  }

  /// 更新当前已连接电脑通过主连接拉取到的带 `pendingPreview` 的完整摘要。
  void recordActiveSummary(String computerKey, MobileComputerSummary summary) {
    if (_disposed || _activeKey != computerKey) return;
    final existing = _entries[computerKey];
    if (existing == null) return;
    _entries[computerKey] = existing.copyWith(
      summary: summary,
      syncState: ComputerSummarySyncState.idle,
      clearLastError: true,
    );
    unawaited(
      cacheStore
          .open(computerKey)
          .saveSummary(summary)
          .catchError((Object _) {}),
    );
    notifyListeners();
  }

  void setForeground(bool foreground) {
    if (_disposed || _foreground == foreground) return;
    _foreground = foreground;
    if (!foreground) {
      for (final key in _watchers.keys.toList()) {
        _stopWatcher(key);
      }
      for (final key in _rewatchTimers.keys.toList()) {
        _rewatchTimers.remove(key)?.cancel();
      }
      return;
    }
    _syncWatchers();
    unawaited(refreshAll(force: false));
  }

  Future<void> refreshAll({bool force = false}) {
    if (_disposed || !_foreground || _identity == null) {
      return Future.value();
    }
    final futures = <Future<void>>[];
    for (final key in _order) {
      if (key == _activeKey) continue;
      final entry = _entries[key];
      if (entry == null || entry.isRevoked) continue;
      final state = entry.relayStatus?.state;
      final canProbe = force
          ? (state == null || state == RelayComputerState.online)
          : state == RelayComputerState.online;
      if (!canProbe) continue;
      futures.add(_scheduleProbe(key, force: force));
    }
    return futures.isEmpty ? Future.value() : Future.wait(futures);
  }

  Future<void> refreshComputer(String computerKey, {bool force = true}) {
    if (_disposed || !_foreground || _identity == null) {
      return Future.value();
    }
    if (computerKey == _activeKey) return Future.value();
    final entry = _entries[computerKey];
    if (entry == null) return Future.value();
    if (entry.isRevoked && !force) return Future.value();
    return _scheduleProbe(computerKey, force: force);
  }

  Future<void> _loadCachedSummary(ComputerProfile profile) async {
    final key = profile.computerKey;
    if (!_loadedCacheKeys.add(key)) return;
    try {
      final cache = cacheStore.open(key);
      var summary = await cache.readSummary();
      if (summary == null) {
        final sidebar = await cache.readSidebar();
        if (sidebar != null) {
          summary = _summaryFromSidebar(profile, sidebar);
        }
      }
      if (_disposed || summary == null) return;
      final existing = _entries[key];
      if (existing == null) return;
      if (existing.summary != null &&
          !summary.syncedAt.isAfter(existing.summary!.syncedAt)) {
        return;
      }
      _entries[key] = existing.copyWith(summary: summary);
      notifyListeners();
    } catch (_) {
      // 加密缓存异常时静默忽略，后续在线同步会重建缓存。
    }
  }

  void _syncWatchers() {
    if (_disposed || !_foreground) return;
    for (final key in _order) {
      if (key == _activeKey) {
        _stopWatcher(key);
        continue;
      }
      final entry = _entries[key];
      if (entry == null || entry.isRevoked) {
        _stopWatcher(key);
        continue;
      }
      if (!_watchers.containsKey(key) && !_rewatchTimers.containsKey(key)) {
        unawaited(_startWatcher(entry.profile));
      }
    }
  }

  Future<void> _startWatcher(ComputerProfile profile) async {
    final key = profile.computerKey;
    try {
      final watch = await _observeStatus(profile);
      if (_disposed ||
          !_foreground ||
          key == _activeKey ||
          !_entries.containsKey(key) ||
          _entries[key]?.isRevoked == true) {
        await watch.close();
        return;
      }
      _watchers[key] = watch;
      _watchSubs[key] = watch.updates.listen(
        (status) => _onRelayStatus(key, status),
        onError: (Object _) => _onWatcherClosed(key, watch),
        onDone: () => _onWatcherClosed(key, watch),
      );
      _onRelayStatus(key, watch.initial);
    } catch (error) {
      if (_disposed || !_foreground || key == _activeKey) return;
      if (error is ConnectionFailure &&
          const {'incompatible', 'token-rejected'}.contains(error.code)) {
        final existing = _entries[key];
        if (existing != null) {
          _entries[key] = existing.copyWith(
            syncState: ComputerSummarySyncState.error,
            lastError: error.code,
          );
          notifyListeners();
        }
        return;
      }
      _scheduleRewatch(key);
    }
  }

  void _onRelayStatus(String key, RelayComputerStatus status) {
    if (_disposed || key == _activeKey) return;
    final existing = _entries[key];
    if (existing == null) return;
    final wasOnline = existing.relayStatus?.state == RelayComputerState.online;
    final isOnline = status.state == RelayComputerState.online;
    _entries[key] = existing.copyWith(
      relayStatus: status,
      clearLastError: isOnline && existing.lastError == 'offline',
    );
    notifyListeners();
    if (isOnline && (!wasOnline || existing.summary == null)) {
      unawaited(_scheduleProbe(key, force: !wasOnline));
    }
  }

  void _onWatcherClosed(String key, RelayStatusWatch watch) {
    if (!identical(_watchers[key], watch)) return;
    _watchers.remove(key);
    _watchSubs.remove(key);
    unawaited(watch.close());
    _scheduleRewatch(key);
  }

  void _scheduleRewatch(String key) {
    if (_disposed ||
        !_foreground ||
        key == _activeKey ||
        !_entries.containsKey(key) ||
        _entries[key]?.isRevoked == true) {
      return;
    }
    _rewatchTimers[key]?.cancel();
    _rewatchTimers[key] = Timer(const Duration(seconds: 4), () {
      _rewatchTimers.remove(key);
      final profile = _entries[key]?.profile;
      if (profile != null && _foreground && key != _activeKey) {
        unawaited(_startWatcher(profile));
      }
    });
  }

  void _stopWatcher(String key) {
    _rewatchTimers.remove(key)?.cancel();
    final sub = _watchSubs.remove(key);
    if (sub != null) unawaited(sub.cancel());
    final watch = _watchers.remove(key);
    if (watch != null) unawaited(watch.close());
  }

  Future<void> _scheduleProbe(String key, {required bool force}) {
    final entry = _entries[key];
    if (entry == null || _identity == null) return Future.value();
    if (!force && entry.lastAttemptAt != null) {
      final elapsed = _now().difference(entry.lastAttemptAt!);
      if (elapsed < autoCooldown) return Future.value();
    }
    final completer = Completer<void>();
    _waiters.putIfAbsent(key, () => []).add(completer);
    if (!_inFlightKeys.contains(key) && !_queue.contains(key)) {
      _queue.addLast(key);
      _drainQueue();
    }
    return completer.future;
  }

  void _drainQueue() {
    while (!_disposed &&
        _foreground &&
        _activeProbes < maxConcurrency &&
        _queue.isNotEmpty) {
      final key = _queue.removeFirst();
      if (key == _activeKey || !_entries.containsKey(key)) {
        _completeWaiters(key);
        continue;
      }
      _activeProbes++;
      _inFlightKeys.add(key);
      unawaited(_runProbe(key));
    }
  }

  Future<void> _runProbe(String key) async {
    final identity = _identity;
    final entry = _entries[key];
    if (_disposed || identity == null || entry == null || key == _activeKey) {
      _finishProbe(key);
      return;
    }
    final generation = (_probeGenerations[key] ?? 0) + 1;
    _probeGenerations[key] = generation;
    final attemptTime = _now();
    _entries[key] = entry.copyWith(
      syncState: ComputerSummarySyncState.syncing,
      lastAttemptAt: attemptTime,
      clearLastError: true,
    );
    notifyListeners();

    try {
      final summary = await _fetchSummary(
        entry.profile,
        identity,
      ).timeout(syncTimeout);
      if (_disposed ||
          _probeGenerations[key] != generation ||
          key == _activeKey) {
        return;
      }
      final current = _entries[key];
      if (current == null) return;
      _entries[key] = current.copyWith(
        summary: summary,
        syncState: ComputerSummarySyncState.idle,
        clearLastError: true,
      );
      unawaited(
        cacheStore.open(key).saveSummary(summary).catchError((Object _) {}),
      );
      notifyListeners();
    } catch (error) {
      if (_disposed ||
          _probeGenerations[key] != generation ||
          key == _activeKey) {
        return;
      }
      final current = _entries[key];
      if (current == null) return;
      final code = switch (error) {
        ConnectionFailure(:final code) => code,
        MobileRpcFailure(:final problem)
            when problem.code == 'DEVICE_REVOKED' =>
          'device-revoked',
        TimeoutException() => 'timeout',
        _ => 'unreachable',
      };
      if (code == 'device-revoked') {
        _stopWatcher(key);
        _entries[key] = current.copyWith(
          syncState: ComputerSummarySyncState.revoked,
          lastError: 'device-revoked',
        );
      } else {
        _entries[key] = current.copyWith(
          syncState: ComputerSummarySyncState.error,
          lastError: code,
        );
      }
      notifyListeners();
    } finally {
      _finishProbe(key);
    }
  }

  void _finishProbe(String key) {
    _inFlightKeys.remove(key);
    if (_activeProbes > 0) _activeProbes--;
    _completeWaiters(key);
    _drainQueue();
  }

  void _completeWaiters(String key) {
    final waiting = _waiters.remove(key);
    if (waiting == null) return;
    for (final completer in waiting) {
      if (!completer.isCompleted) completer.complete();
    }
  }

  MobileComputerSummary? _summaryFromSidebar(
    ComputerProfile profile,
    SidebarSnapshot snapshot, {
    MobileComputerSummary? previous,
  }) {
    final computerId = previous?.computerId ?? _fallbackComputerId(profile);
    final base = summarizeSidebarSnapshot(
      computerId: computerId,
      computerName: profile.name,
      snapshot: snapshot,
    );
    if (previous == null || previous.items.isEmpty) return base;
    // 若先前主连接曾拉取到同会话的 pendingPreview，在侧栏快照即时更新时尽量保留预览，
    // 待下一次主连接摘要刷新覆盖。
    final previews = <String, String>{};
    for (final item in previous.items) {
      final preview = item.pendingPreview;
      if (item.isAttention && preview != null) {
        previews[item.threadId] = preview;
      }
    }
    if (previews.isEmpty) return base;
    return MobileComputerSummary(
      computerId: base.computerId,
      computerName: base.computerName,
      syncedAt: base.syncedAt,
      counts: base.counts,
      truncated: base.truncated,
      items: base.items
          .map(
            (item) =>
                item.isAttention &&
                    item.pendingPreview == null &&
                    previews.containsKey(item.threadId)
                ? MobileSummaryItem(
                    threadId: item.threadId,
                    projectId: item.projectId,
                    projectName: item.projectName,
                    title: item.title,
                    updatedAt: item.updatedAt,
                    status: item.status,
                    pendingKind: item.pendingKind,
                    pendingPreview: previews[item.threadId],
                    unread: item.unread,
                    pinned: item.pinned,
                    agentName: item.agentName,
                  )
                : item,
          )
          .toList(growable: false),
    );
  }

  /// 当本机仅从离线缓存派生摘要而尚无 SHA-256 `computerId` 时，基于公钥字节构造确定性 64 位十六进制占位。
  String _fallbackComputerId(ComputerProfile profile) {
    final raw = utf8.encode(profile.computerKey);
    final buf = StringBuffer();
    for (var i = 0; i < 32; i++) {
      final byte = raw[i % raw.length] ^ ((i * 31) & 0xff);
      buf.write(byte.toRadixString(16).padLeft(2, '0'));
    }
    return buf.toString();
  }

  bool _sameEntry(ComputerSummaryEntry a, ComputerSummaryEntry b) =>
      a.profile.computerKey == b.profile.computerKey &&
      a.profile.name == b.profile.name &&
      a.isActive == b.isActive &&
      a.activeConnected == b.activeConnected &&
      a.relayStatus?.state == b.relayStatus?.state &&
      a.relayStatus?.lastOnlineAt == b.relayStatus?.lastOnlineAt &&
      a.summary == b.summary &&
      a.syncState == b.syncState &&
      a.lastError == b.lastError;

  @override
  void dispose() {
    _disposed = true;
    for (final key in _watchers.keys.toList()) {
      _stopWatcher(key);
    }
    for (final key in _rewatchTimers.keys.toList()) {
      _rewatchTimers.remove(key)?.cancel();
    }
    for (final key in _waiters.keys.toList()) {
      _completeWaiters(key);
    }
    _queue.clear();
    super.dispose();
  }
}
