import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

import 'local_drafts.dart';
import 'offline_cache.dart';
import 'offline_sync_label.dart';
import 'run_composer.dart';
import 'run_composer_state.dart';
import 'request_input.dart';
import 'run_changes_card.dart';
import 'thread_read_receipt.dart';
import 'timeline_view.dart';

typedef _Selection = (MobileConnection, String, TimelineSnapshot?);

typedef _TimelineRead = ({TimelineSnapshot snapshot, Object? problem});

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
    this.cache,
    this.computerKey,
    this.onSynced,
    this.reading,
  });

  final MobileConnection? connection;
  final String threadId;
  final bool online;
  final ComputerOfflineCache? cache;
  final String? computerKey;
  final ValueChanged<bool>? onSynced;
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
  String _observedText = '';
  ThreadDraftStorage? _draftStore;
  final _text = TextEditingController();

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
          if (!online && syncedAt != null && snapshot != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 6, 16, 4),
              child: Text(
                offlineSyncLabel(context, syncedAt),
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
          Expanded(child: timeline),
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

  Widget _changes(MobileConnection connection, TimelineTurn turn) {
    final runId = turn.runId;
    if (runId == null) return const SizedBox.shrink();
    return RunChangesCard(
      key: ValueKey((connection, runId)),
      online: true,
      savedPaths: turn.files,
      checkpointRevision: turn.changes?.seq,
      loadFiles: (offset) => connection.changes.list(
        MobileRunChangesParams(
          threadId: widget.threadId,
          runId: runId,
          offset: offset,
        ),
      ),
      loadDiff: (path, offset) => connection.changes.diff(
        MobileRunDiffParams(
          threadId: widget.threadId,
          runId: runId,
          path: path,
          offset: offset,
        ),
      ),
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
    Widget Function(Widget)? wrapInput;
    if (connection.supportsRequestCommands) {
      final runProvider = runComposerProvider((connection, threadId));
      final stopState = connection.supportsRunCommands
          ? ref.watch(runProvider).value
          : null;
      final canStop =
          runId != null &&
          stopState != null &&
          !stopState.working.contains(MobileRunMethod.runInterrupt) &&
          !stopState.pending.containsKey(MobileRunMethod.runInterrupt);
      wrapInput = (composer) => RequestInput(
        connection: connection,
        threadId: threadId,
        live: snapshot.live,
        online: true,
        composer: composer,
        onStop: canStop
            ? () => ref.read(runProvider.notifier).stop(runId)
            : null,
      );
    }
    if (!connection.supportsRunCommands) {
      return wrapInput?.call(_offlineComposer()) ?? _offlineComposer();
    }
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
    return RunComposer(
      connection: connection,
      threadId: threadId,
      online: true,
      draft: _text,
      stoppableRunId: runId,
      queueRevision: revision,
      wrapInput: wrapInput,
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
