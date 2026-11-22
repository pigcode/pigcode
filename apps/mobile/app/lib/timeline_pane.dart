import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

import 'run_composer.dart';
import 'timeline_view.dart';

typedef _Selection = (MobileConnection, String);

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
    final (connection, threadId) = selection;
    final timeline = await connection.openTimeline(threadId);
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

class TimelinePane extends ConsumerWidget {
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
  Widget build(BuildContext context, WidgetRef ref) {
    final provider = _timelineProvider((connection, threadId));
    final selected = ref.watch(provider);
    return selected.when(
      data: (data) {
        final timeline = TimelineView(
          snapshot: data.snapshot,
          online: online,
          loadEarlier: () => ref.read(provider.notifier).loadEarlier(),
          content: ref.read(provider.notifier).content,
          problem: data.problem == null ? null : _detail(data.problem!),
          retry: online ? () => ref.read(provider.notifier).retry() : null,
        );
        if (!connection.supportsRunCommands) return timeline;
        return LayoutBuilder(
          builder: (context, constraints) {
            return Column(
              children: [
                Expanded(child: timeline),
                ConstrainedBox(
                  constraints: BoxConstraints(
                    maxHeight: constraints.maxHeight * .6,
                  ),
                  child: SingleChildScrollView(
                    child: RunComposer(
                      connection: connection,
                      threadId: threadId,
                      online: online,
                      stoppableRunId: _stoppableRun(data.snapshot),
                    ),
                  ),
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
                if (online && connection.supportsTimeline)
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
