import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

import 'run_composer.dart';
import 'run_composer_state.dart';
import 'request_input.dart';
import 'run_changes_card.dart';
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
  });

  final MobileConnection connection;
  final String threadId;
  final bool online;

  @override
  ConsumerState<TimelinePane> createState() => _TimelinePaneState();
}

class _TimelinePaneState extends ConsumerState<TimelinePane> {
  TimelineSnapshot? _latest;
  TimelineSnapshot? _resumeFrom;

  @override
  void didUpdateWidget(covariant TimelinePane oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.connection, widget.connection)) {
      _resumeFrom = _latest;
    }
  }

  @override
  Widget build(BuildContext context) {
    final connection = widget.connection;
    final threadId = widget.threadId;
    final provider = _timelineProvider((connection, threadId, _resumeFrom));
    final selected = ref.watch(provider);
    final current = selected.value;
    if (widget.online && current != null) _latest = current.snapshot;
    final online = widget.online && current != null;
    final previous = _latest;
    final visible = online || previous == null
        ? selected
        : AsyncData<_TimelineRead>((
            snapshot: previous,
            problem: selected.error,
          ));
    return visible.when(
      data: (data) {
        final timeline = TimelineView(
          snapshot: data.snapshot,
          online: online,
          loadEarlier: () => ref.read(provider.notifier).loadEarlier(),
          content: ref.read(provider.notifier).content,
          problem: data.problem == null ? null : _detail(data.problem!),
          retry: widget.online
              ? () => ref.read(provider.notifier).retry()
              : null,
          changesCard: connection.supportsRunChanges
              ? (turn) {
                  final runId = turn.runId;
                  if (runId == null) return const SizedBox.shrink();
                  return RunChangesCard(
                    key: ValueKey((connection, runId)),
                    online: online,
                    savedPaths: turn.files,
                    checkpointRevision: turn.changes?.seq,
                    loadFiles: (offset) => connection.changes.list(
                      MobileRunChangesParams(
                        threadId: threadId,
                        runId: runId,
                        offset: offset,
                      ),
                    ),
                    loadDiff: (path, offset) => connection.changes.diff(
                      MobileRunDiffParams(
                        threadId: threadId,
                        runId: runId,
                        path: path,
                        offset: offset,
                      ),
                    ),
                  );
                }
              : null,
        );
        if (!connection.supportsRunCommands &&
            !connection.supportsRequestCommands) {
          return timeline;
        }
        final runId = _stoppableRun(data.snapshot);
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
            live: data.snapshot.live,
            online: online,
            composer: composer,
            onStop: canStop
                ? () => ref.read(runProvider.notifier).stop(runId)
                : null,
          );
        }
        final revision =
            data.snapshot.events.reversed
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
        final input = connection.supportsRunCommands
            ? RunComposer(
                connection: connection,
                threadId: threadId,
                online: online,
                stoppableRunId: runId,
                queueRevision: revision,
                wrapInput: wrapInput,
              )
            : wrapInput?.call(const SizedBox.shrink()) ??
                  const SizedBox.shrink();
        return LayoutBuilder(
          builder: (context, constraints) {
            return Column(
              children: [
                Expanded(child: timeline),
                ConstrainedBox(
                  constraints: BoxConstraints(
                    maxHeight: constraints.maxHeight * .6,
                  ),
                  child: SingleChildScrollView(child: input),
                ),
              ],
            );
          },
        );
      },
      loading: () => const Center(child: CircularProgressIndicator.adaptive()),
      error: (error, _) {
        return Center(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(_detail(error)),
                if (widget.online && connection.supportsTimeline)
                  TextButton(
                    onPressed: () => ref.read(provider.notifier).retry(),
                    child: const Text('重试'),
                  ),
              ],
            ),
          ),
        );
      },
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
