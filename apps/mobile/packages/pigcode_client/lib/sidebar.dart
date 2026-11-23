import 'dart:async';

import 'host_rpc.dart';
import 'sidebar_models.dart';

class SidebarSnapshot {
  SidebarSnapshot({
    required List<MobileProjectSummary> projects,
    required List<MobileThreadSummary> threads,
    required this.syncedAt,
  }) : projects = List.unmodifiable(projects),
       threads = List.unmodifiable(threads);

  final List<MobileProjectSummary> projects;
  final List<MobileThreadSummary> threads;
  final DateTime syncedAt;
}

/// Sidebar changes are published by Host on its shared sidebar subscription.
class MobileSidebarCommands {
  const MobileSidebarCommands(this._rpc);

  final HostRequests _rpc;

  Future<void> setPinned(String threadId, bool pinned) async {
    await _rpc.call(MobileSidebarMethods.setPinned, {
      'threadId': threadId,
      'pinned': pinned,
    });
  }

  Future<void> archive(String threadId, bool archived) async {
    await _rpc.call(
      archived ? MobileSidebarMethods.archive : MobileSidebarMethods.unarchive,
      {'threadId': threadId},
    );
  }

  Future<void> markRead(String threadId, bool read) async {
    await _rpc.call(MobileSidebarMethods.markRead, {
      'threadId': threadId,
      'read': read,
    });
  }

  Future<void> markAllRead() async {
    await _rpc.call(MobileSidebarMethods.markAllRead, {});
  }

  Future<void> acknowledgeRead(
    String threadId,
    MobileThreadReadTarget target,
  ) async {
    await _rpc.call(MobileSidebarMethods.acknowledgeRead, {
      'threadId': threadId,
      ...target.toJson(),
    });
  }
}

/// A sidebar belongs to one authenticated connection. Invalidations arriving
/// during a paged load cause a fresh load before a newer snapshot is published.
class MobileSidebar {
  MobileSidebar._(this._rpc);

  final HostRpc _rpc;
  final _updates = StreamController<SidebarSnapshot>.broadcast();
  late StreamSubscription<Map<String, dynamic>> _subscription;
  bool _started = false;
  bool _loading = false;
  int _revision = 0;
  SidebarSnapshot? _snapshot;

  SidebarSnapshot? get snapshot => _snapshot;
  Stream<SidebarSnapshot> get updates => _updates.stream;

  static Future<MobileSidebar> open(HostRpc rpc) async {
    final sidebar = MobileSidebar._(rpc);
    sidebar._subscription = rpc.notifications.listen(
      sidebar._notified,
      onDone: () => unawaited(sidebar._updates.close()),
    );
    try {
      final result = await rpc.call(
        MobileSidebarMethods.subscribe,
        const MobileSidebarSubscribeParams().toJson(),
      );
      MobileSidebarSubscribeResult.fromJson(result as Map<String, dynamic>);
      sidebar._started = true;
      await sidebar._load();
      return sidebar;
    } catch (_) {
      await sidebar._subscription.cancel();
      unawaited(sidebar._updates.close());
      rethrow;
    }
  }

  Future<MobileProjectList> listProjects([
    MobileProjectListParams params = const MobileProjectListParams(),
  ]) async => decodeMobileProjectList(
    await _rpc.call(MobileSidebarMethods.projectList, params.toJson()),
  );

  Future<MobileThreadList> listThreads([
    MobileThreadListParams params = const MobileThreadListParams(),
  ]) async => decodeMobileThreadList(
    await _rpc.call(MobileSidebarMethods.threadList, params.toJson()),
  );

  Future<void> refresh() async {
    if (!_loading) await _load();
  }

  void _notified(Map<String, dynamic> message) {
    if (message['method'] != MobileSidebarMethods.changed) return;
    try {
      MobileSidebarChanged.fromJson(message['params'] as Map<String, dynamic>);
    } catch (_) {
      return;
    }
    _revision++;
    if (_started && !_loading) {
      unawaited(
        _load().catchError((Object error, StackTrace stack) {
          if (!_updates.isClosed) _updates.addError(error, stack);
        }),
      );
    }
  }

  Future<void> _load() async {
    _loading = true;
    try {
      while (!_updates.isClosed) {
        final revision = _revision;
        final projects = await _allPages(
          (offset) => listProjects(
            MobileProjectListParams(
              offset: offset,
              limit: mobileSidebarPageSize,
            ),
          ),
        );
        final threads = await _allPages(
          (offset) => listThreads(
            MobileThreadListParams(
              offset: offset,
              limit: mobileSidebarPageSize,
            ),
          ),
        );
        if (revision != _revision) continue;
        if (_updates.isClosed) return;
        final snapshot = SidebarSnapshot(
          projects: projects,
          threads: threads,
          syncedAt: DateTime.now(),
        );
        _snapshot = snapshot;
        _updates.add(snapshot);
        return;
      }
    } finally {
      _loading = false;
    }
  }
}

Future<List<T>> _allPages<T>(Future<List<T>> Function(int) request) async {
  final result = <T>[];
  while (true) {
    final page = await request(result.length);
    if (page.isEmpty) return result;
    result.addAll(page);
  }
}
