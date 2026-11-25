import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

import 'composer/mention_editing_controller.dart';
import 'local_drafts.dart';
import 'offline_cache.dart';
import 'offline_sync_label.dart';
import 'run_composer.dart';
import 'run_changes_card.dart';
import 'run_diff_screen.dart';
import 'thread_read_receipt.dart';
import 'timeline/notice_line.dart';
import 'timeline/request_card.dart';
import 'timeline_view.dart';
import 'timeline_work.dart';

typedef _Selection = (MobileConnection, String, TimelineSnapshot?);

typedef _TimelineRead = ({TimelineSnapshot snapshot, Object? problem});
typedef RunChangesShortcut = ({int fileCount, bool hasMore, VoidCallback open});
typedef _RunChangesTarget = ({
  MobileConnection connection,
  String runId,
  int revision,
});

final _timelineProvider = AsyncNotifierProvider.autoDispose
    .family<_TimelineController, _TimelineRead, _Selection>(
      _TimelineController.new,
    );

class _TimelineController extends AsyncNotifier<_TimelineRead> {
  _TimelineController(this.selection);
  final _Selection selection;
  MobileTimeline? _timeline;

  @override
  Future<_TimelineRead> build() async {
    final (connection, threadId, previous) = selection;
    final timeline = await connection.openTimeline(
      threadId,
      resumeFrom: previous,
    );
    if (ref.mounted) {
      _timeline = timeline;
      final subscription = timeline.updates.listen((snapshot) {
        if (ref.mounted) state = AsyncData((snapshot: snapshot, problem: null));
      }, onError: (Object error, StackTrace stack) => _report(error, stack));
      ref.onDispose(() => unawaited(subscription.cancel()));
    }
    return (snapshot: timeline.snapshot!, problem: null);
  }

  void _report(Object error, StackTrace stack) {
    if (!ref.mounted) return;
    final snapshot = _timeline?.snapshot;
    state = snapshot == null
        ? AsyncError(error, stack)
        : AsyncData((snapshot: snapshot, problem: error));
  }

  Future<void> retry() async {
    final timeline = _timeline;
    if (timeline == null) {
      ref.invalidateSelf();
      return;
    }
    try {
      await timeline.refresh();
    } catch (error, stack) {
      _report(error, stack);
    }
  }

  Future<void> loadEarlier() async => _timeline?.loadEarlier();

  Future<MobileTimelineContentResult> content({
    int? seq,
    String? runId,
    String? toolId,
    required MobileTimelineContentField field,
    int? offset,
  }) => _timeline!.content(
    seq: seq,
    runId: runId,
    toolId: toolId,
    field: field,
    offset: offset,
  );
}

class TimelinePane extends ConsumerStatefulWidget {
  const TimelinePane({
    super.key,
    required this.connection,
    required this.threadId,
    required this.online,
    this.projectId,
    this.projects = const [],
    this.threads = const [],
    this.cache,
    this.computerKey,
    this.onSynced,
    this.onRunChangesChanged,
    this.reading,
  });

  final MobileConnection? connection;
  final String threadId;
  final String? projectId;
  final List<MobileProjectSummary> projects;
  final List<MobileThreadSummary> threads;
  final bool online;
  final ComputerOfflineCache? cache;
  final String? computerKey;
  final ValueChanged<bool>? onSynced;
  final ValueChanged<RunChangesShortcut?>? onRunChangesChanged;
  final ({
    bool visible,
    int visit,
    bool unread,
    MobileThreadReadTarget? target,
    MobileThreadReadTarget? manualUnread,
  })?
  reading;

  @override
  ConsumerState<TimelinePane> createState() => _TimelinePaneState();
}

class _TimelinePaneState extends ConsumerState<TimelinePane> {
  TimelineSnapshot? _latest;
  TimelineSnapshot? _resumeFrom;
  DateTime? _syncedAt;
  bool _historyReady = false;
  bool _draftReady = false;
  bool _draftError = false;
  bool _synced = false;
  _RunChangesTarget? _changesTarget;
  Future<MobileRunChangesPage>? _shortcutFiles;
  List<MobileTimelineEvent>? _changeEvents;
  MobileConnection? _changeConnection;
  bool _openingChanges = false;
  String _observedText = '';
  ThreadDraftStorage? _draftStore;
  final _text = ComposerTextEditingController();

  @override
  void initState() {
    super.initState();
    _restoreHistory();
    final key = widget.computerKey;
    if (key != null) _draftStore = ThreadDraftStorage(key, widget.threadId);
    _text.addListener(_saveEditedText);
    _restoreDraft();
  }

  @override
  void didUpdateWidget(covariant TimelinePane oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.cache, widget.cache)) {
      _latest = null;
      _resumeFrom = null;
      _syncedAt = null;
      _restoreHistory();
    } else if (!identical(oldWidget.connection, widget.connection)) {
      _resumeFrom = _latest;
    }
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  void _restoreHistory() {
    final cache = widget.cache;
    _historyReady = cache == null;
    if (cache == null) return;
    unawaited(
      cache.readTimeline(widget.threadId).catchError((Object _) => null).then((
        history,
      ) {
        if (!mounted || !identical(widget.cache, cache)) return;
        setState(() {
          _historyReady = true;
          _latest = history?.snapshot;
          _resumeFrom = _latest;
          _syncedAt = history?.syncedAt;
        });
      }),
    );
  }

  void _restoreDraft() {
    final store = _draftStore;
    if (store == null) {
      _draftReady = true;
      return;
    }
    unawaited(
      store.read().then(
        (value) {
          if (!mounted) return;
          setState(() {
            _observedText = value;
            _text.text = value;
            _draftReady = true;
            _draftError = false;
          });
        },
        onError: (Object _) {
          if (mounted) {
            setState(() {
              _draftReady = true;
              _draftError = true;
            });
          }
        },
      ),
    );
  }

  void _saveEditedText() {
    final store = _draftStore;
    final value = _text.text;
    if (store == null || value == _observedText) return;
    final previous = _observedText;
    _observedText = value;
    unawaited(
      store
          .save(value, previous: previous)
          .then<void>(
            (_) {
              if (mounted && _draftError && _observedText == value) {
                setState(() => _draftError = false);
              }
            },
            onError: (Object _) {
              if (mounted && _observedText == value) {
                setState(() => _draftError = true);
              }
            },
          ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final connection = widget.connection;
    final threadId = widget.threadId;
    final provider = connection != null && widget.online && _historyReady
        ? _timelineProvider((connection, threadId, _resumeFrom))
        : null;
    final selected = provider == null ? null : ref.watch(provider);
    final current = selected?.value;
    if (provider != null) {
      ref.listen(provider, (previous, next) {
        final snapshot = next.value?.snapshot;
        final cache = widget.cache;
        if (snapshot == null || !widget.online) return;
        if (!identical(snapshot.events, previous?.value?.snapshot.events)) {
          final now = DateTime.now();
          _syncedAt = now;
          if (cache != null) {
            unawaited(
              cache
                  .saveTimeline(threadId, snapshot, now)
                  .catchError((Object _) {}),
            );
          }
        }
      });
    }

    final online = current != null && widget.online;
    if (online) _latest = current.snapshot;
    final snapshot = _latest;
    final errors = current?.problem ?? selected?.error;
    final synced = online && errors == null && selected?.isLoading == false;
    _reportRunChanges(synced ? connection : null, snapshot);
    if (_synced != synced && widget.onSynced != null) {
      _synced = synced;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _synced == synced) widget.onSynced?.call(synced);
      });
    }
    final retry = provider == null
        ? null
        : () => ref.read(provider.notifier).retry();
    final Widget timeline;
    if (snapshot != null) {
      timeline = TimelineView(
        snapshot: snapshot,
        online: online,
        loadEarlier: provider == null
            ? () async {}
            : () => ref.read(provider.notifier).loadEarlier(),
        content: ({seq, runId, toolId, required field, offset}) {
          if (provider == null) throw const ConnectionFailure('offline');
          return ref
              .read(provider.notifier)
              .content(
                seq: seq,
                runId: runId,
                toolId: toolId,
                field: field,
                offset: offset,
              );
        },
        problem: errors == null ? null : _detail(errors),
        retry: retry,
        changesCard: online && connection?.supportsRunChanges == true
            ? (turn) => _changes(connection!, turn)
            : null,
        requestCard: online && connection != null
            ? (turn, request) {
                final runId = turn.runId;
                final id = request.itemId;
                final active = connection;
                if (runId == null || id == null) {
                  return TimelineNoticeLine(
                    text: request.kind == MobileTimelineKind.approvalRequested
                        ? '有待处理的审批'
                        : '有待回答的提问',
                  );
                }
                return InlineRequestCard(
                  connection: active,
                  threadId: threadId,
                  runId: runId,
                  requestId: id,
                  online: online,
                );
              }
            : null,
      );
    } else if (!_historyReady || (selected?.isLoading ?? false)) {
      timeline = const Center(child: CircularProgressIndicator.adaptive());
    } else {
      timeline = Center(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(errors == null ? '还没有可离线查看的会话记录。' : _detail(errors)),
              if (retry != null)
                TextButton(onPressed: retry, child: const Text('重试')),
            ],
          ),
        ),
      );
    }
    final input = online && connection != null && snapshot != null
        ? _onlineComposer(connection, snapshot)
        : _draftStore == null
        ? const SizedBox.shrink()
        : _offlineComposer();
    final syncedAt = _syncedAt;
    final reading = widget.reading;
    final shownResult = synced
        ? current.snapshot.events.reversed
              .where(
                (event) => switch (event.kind) {
                  MobileTimelineKind.runCompleted ||
                  MobileTimelineKind.runFailed ||
                  MobileTimelineKind.runInterrupted => true,
                  _ => false,
                },
              )
              .firstOrNull
              ?.runId
        : null;
    final content = LayoutBuilder(
      builder: (context, constraints) => Column(
        children: [
          Expanded(child: timeline),
          if (!online && syncedAt != null && snapshot != null)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Text(
                offlineSyncLabel(syncedAt),
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
          if (_draftError) const Text('暂时无法保存本机草稿。'),
          ConstrainedBox(
            constraints: BoxConstraints(maxHeight: constraints.maxHeight * .6),
            child: SingleChildScrollView(child: input),
          ),
        ],
      ),
    );
    return ThreadReadReceipt(
      visible:
          reading?.visible == true &&
          (ModalRoute.of(context)?.isCurrent ?? true),
      shownRunId: shownResult,
      target: reading?.target,
      manualUnread: reading?.manualUnread,
      connection: connection,
      unread: reading?.unread == true,
      visit: reading?.visit ?? 0,
      confirm: reading != null && connection?.supportsSidebarCommands == true
          ? (target) =>
                connection!.sidebarCommands.acknowledgeRead(threadId, target)
          : null,
      child: content,
    );
  }

  void _reportRunChanges(
    MobileConnection? connection,
    TimelineSnapshot? snapshot,
  ) {
    if (widget.onRunChangesChanged == null) return;
    final events = snapshot?.events;
    if (identical(_changeConnection, connection) &&
        identical(_changeEvents, events)) {
      return;
    }
    _changeConnection = connection;
    _changeEvents = events;
    _RunChangesTarget? target;
    if (connection?.supportsRunChanges == true && events != null) {
      final runEvents = events.reversed.where((event) => event.runId != null);
      final latest =
          runEvents
              .where(
                (event) =>
                    event.kind == MobileTimelineKind.changes ||
                    event.kind == MobileTimelineKind.file,
              )
              .firstOrNull ??
          // 编辑工具完成后也可以向 Host 读取这个 run 的文件清单。
          runEvents
              .where(
                (event) =>
                    event.kind == MobileTimelineKind.toolCompleted &&
                    event.failed != true &&
                    timelineToolKindForName(event.name) ==
                        TimelineToolKind.edit,
              )
              .firstOrNull;
      if (latest != null) {
        target = (
          connection: connection!,
          runId: latest.runId!,
          revision: latest.seq,
        );
      }
    }
    if (_changesTarget == target) return;
    _changesTarget = target;
    _shortcutFiles = null;
    _publishRunChanges(target, null);
    if (target != null) _loadShortcutFiles(target);
  }

  void _publishRunChanges(
    _RunChangesTarget? target,
    MobileRunChangesPage? page,
  ) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _changesTarget != target) return;
      widget.onRunChangesChanged?.call(
        target == null
            ? null
            : (
                fileCount: page?.files.length ?? 0,
                hasMore: page?.nextOffset != null,
                open: _openChanges,
              ),
      );
    });
    WidgetsBinding.instance.ensureVisualUpdate();
  }

  Future<MobileRunChangesPage> _loadShortcutFiles(_RunChangesTarget target) {
    if (_shortcutFiles case final request?) return request;
    final request = _changeLoaders(target.connection, target.runId).files(0);
    _shortcutFiles = request;
    unawaited(
      request.then<void>(
        (page) {
          if (mounted &&
              _changesTarget == target &&
              identical(_shortcutFiles, request)) {
            _publishRunChanges(target, page);
          }
        },
        onError: (Object _) {
          if (identical(_shortcutFiles, request)) _shortcutFiles = null;
        },
      ),
    );
    return request;
  }

  bool get _changesVisible =>
      widget.reading?.visible != false &&
      ModalRoute.of(context)?.isCurrent != false;

  Future<void> _openChanges() async {
    final target = _changesTarget;
    if (!mounted || target == null || _openingChanges || !_changesVisible) {
      return;
    }
    final visit = widget.reading?.visit;
    final loaders = _changeLoaders(target.connection, target.runId);
    _openingChanges = true;
    try {
      final initial = await _loadShortcutFiles(target);
      if (!mounted ||
          _changesTarget != target ||
          widget.reading?.visit != visit ||
          !_changesVisible) {
        return;
      }
      await RunDiffScreen.open(
        context,
        initial: initial,
        loadFiles: loaders.files,
        loadDiff: loaders.diff,
      );
    } catch (_) {
      if (mounted &&
          _changesTarget == target &&
          widget.reading?.visit == visit &&
          _changesVisible) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('暂时无法读取本轮改动。')));
      }
    } finally {
      _openingChanges = false;
    }
  }

  ({RunChangeListLoader files, RunPatchLoader diff}) _changeLoaders(
    MobileConnection connection,
    String runId,
  ) {
    final threadId = widget.threadId;
    return (
      files: (offset) => connection.changes.list(
        MobileRunChangesParams(
          threadId: threadId,
          runId: runId,
          offset: offset,
        ),
      ),
      diff: (path, offset) => connection.changes.diff(
        MobileRunDiffParams(
          threadId: threadId,
          runId: runId,
          path: path,
          offset: offset,
        ),
      ),
    );
  }

  Widget _changes(MobileConnection connection, TimelineTurn turn) {
    final runId = turn.runId;
    if (runId == null) return const SizedBox.shrink();
    final loaders = _changeLoaders(connection, runId);
    return RunChangesCard(
      key: ValueKey((connection, runId)),
      online: true,
      savedPaths: turn.files,
      checkpointRevision: turn.changes?.seq,
      loadFiles: (offset) {
        final target = _changesTarget;
        if (offset == 0 &&
            target?.runId == runId &&
            identical(target?.connection, connection)) {
          return _loadShortcutFiles(target!);
        }
        return loaders.files(offset);
      },
      loadDiff: loaders.diff,
    );
  }

  Widget _offlineComposer() {
    if (!_draftReady) return const SizedBox.shrink();
    return RunComposerView(
      draft: _text,
      online: false,
      state: null,
      storageError: false,
      onRetryLoad: () {},
      onSend: (_) {},
      onStop: (_) {},
      onCheck: (_) {},
      onRetry: (_) {},
    );
  }

  Widget _onlineComposer(
    MobileConnection connection,
    TimelineSnapshot snapshot,
  ) {
    if (!_draftReady) return const SizedBox.shrink();
    final threadId = widget.threadId;
    final runId = _stoppableRun(snapshot);
    final Widget composer;
    if (!connection.supportsRunCommands) {
      composer = _offlineComposer();
    } else {
      final revision =
          snapshot.events.reversed
              .where(
                (event) => const {
                  MobileTimelineKind.queueChanged,
                  MobileTimelineKind.runQueued,
                  MobileTimelineKind.runStarted,
                  MobileTimelineKind.runCompleted,
                  MobileTimelineKind.runFailed,
                  MobileTimelineKind.runInterrupted,
                }.contains(event.kind),
              )
              .firstOrNull
              ?.seq ??
          0;
      composer = RunComposer(
        connection: connection,
        threadId: threadId,
        projectId: widget.projectId,
        projects: widget.projects,
        threads: widget.threads,
        online: true,
        draft: _text,
        stoppableRunId: runId,
        queueRevision: revision,
        composer: snapshot.composer,
        wrapInput: (input) => input,
      );
    }
    final waiting =
        connection.supportsRequestCommands &&
        (snapshot.live?.pending.isNotEmpty ?? false);
    if (!waiting) return composer;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Padding(
          padding: EdgeInsets.fromLTRB(12, 4, 12, 4),
          child: TimelineNoticeLine(
            text: '上方有等待处理的审批或回答，处理后会自动恢复。',
            level: TimelineNoticeLevel.info,
          ),
        ),
        composer,
      ],
    );
  }

  String? _stoppableRun(TimelineSnapshot snapshot) {
    if (snapshot.live case final live?) return live.runId;
    for (final event in snapshot.events.reversed) {
      switch (event.kind) {
        case MobileTimelineKind.runQueued:
        case MobileTimelineKind.runStarted:
          return event.runId;
        case MobileTimelineKind.runCompleted:
        case MobileTimelineKind.runFailed:
        case MobileTimelineKind.runInterrupted:
          return null;
        default:
          break;
      }
    }
    return null;
  }

  String _detail(Object error) => switch (error) {
    MobileRpcFailure(:final problem) => problem.message,
    ConnectionFailure(code: 'update-desktop') => '请更新电脑上的 Pigcode 后查看时间线。',
    _ => '暂时无法读取这条会话。',
  };
}
