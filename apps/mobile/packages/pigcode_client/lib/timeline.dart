import 'dart:async';

import 'host_rpc.dart';
import 'timeline_models.dart';

class TimelineSnapshot {
  TimelineSnapshot({
    required List<MobileTimelineEvent> events,
    required this.through,
    required this.cursor,
    required this.nextBefore,
    required this.live,
  }) : events = List.unmodifiable(events);

  TimelineSnapshot._withLive(TimelineSnapshot previous, this.live)
    : events = previous.events,
      through = previous.through,
      cursor = previous.cursor,
      nextBefore = previous.nextBefore;

  final List<MobileTimelineEvent> events;
  final int through;
  final int cursor;
  final int? nextBefore;
  final MobileActiveRun? live;
}

/// One selected conversation has its own history anchor, event cursor and
/// transient run revision. None of these belong to the sidebar subscription.
class MobileTimeline {
  MobileTimeline._(this._rpc, this.threadId, this._canResume, this._snapshot);

  final HostRequests _rpc;
  final String threadId;
  final bool _canResume;
  final _updates = StreamController<TimelineSnapshot>.broadcast();
  final _buffer = <Map<String, dynamic>>[];
  late final StreamSubscription<Map<String, dynamic>> _subscription;
  TimelineSnapshot? _snapshot;
  bool _loading = false;
  bool _loadingHistory = false;
  bool _missedNotifications = false;
  bool _closed = false;
  int _window = 0;
  bool _recoveringLive = false;
  bool _missedLive = false;
  final _liveBuffer = <MobileRunDelta>[];

  TimelineSnapshot? get snapshot => _snapshot;
  Stream<TimelineSnapshot> get updates => _updates.stream;

  static Future<MobileTimeline> open(
    HostRequests rpc,
    String threadId, {
    TimelineSnapshot? previous,
    bool canResume = false,
  }) async {
    final timeline = MobileTimeline._(rpc, threadId, canResume, previous);
    timeline._subscription = rpc.notifications.listen(
      timeline._notification,
      onDone: () => unawaited(timeline._updates.close()),
    );
    try {
      await timeline.refresh();
      return timeline;
    } catch (_) {
      await timeline.close();
      rethrow;
    }
  }

  Future<void> refresh() async {
    if (_loading || _closed) return;
    _loading = true;
    _window++;
    final previous = _snapshot;
    try {
      final result = await _rpc.call(
        MobileTimelineMethods.subscribe,
        MobileTimelineSubscribeParams(
          threadId: threadId,
          after: _canResume ? previous?.cursor : null,
        ).toJson(),
      );
      final view = MobileTimelineSubscription.fromJson(
        result as Map<String, dynamic>,
      );
      final resumed = view.resumed == true;
      if (resumed &&
          (!_canResume ||
              previous == null ||
              view.page.through < previous.cursor)) {
        throw const FormatException('Unexpected continuation of timeline');
      }
      _replace(
        resumed
            ? await _fillGap(previous!, view)
            : TimelineSnapshot(
                events: view.page.events,
                through: view.page.through,
                cursor: view.page.through,
                nextBefore: view.page.nextBefore,
                live: view.live,
              ),
      );
    } finally {
      _loading = false;
    }

    if (_missedNotifications) {
      _missedNotifications = false;
      _buffer.clear();
      _recover();
      return;
    }
    final queued = [..._buffer];
    _buffer.clear();
    for (final message in queued) {
      _notification(message);
    }
  }

  Future<TimelineSnapshot> _fillGap(
    TimelineSnapshot previous,
    MobileTimelineSubscription view,
  ) async {
    final boundary = view.page.through;
    final events = <int, MobileTimelineEvent>{
      for (final event in previous.events) event.seq: event,
    };
    void applyPage(MobileTimelinePage page) {
      for (final event in page.events) {
        if (event.seq > previous.cursor && event.seq <= boundary) {
          events.putIfAbsent(event.seq, () => event);
        }
      }
    }

    applyPage(view.page);
    var after = previous.cursor;
    var next = view.page.nextAfter;
    while (next != null && !_closed) {
      if (next <= after || next >= boundary) {
        throw const FormatException('Timeline cursor did not advance');
      }
      after = next;
      final result = await _rpc.call(
        MobileTimelineMethods.catchUp,
        MobileTimelineCatchUpParams(
          threadId: threadId,
          after: after,
          through: boundary,
        ).toJson(),
      );
      final page = MobileTimelinePage.fromJson(result as Map<String, dynamic>);
      if (page.through != boundary) {
        throw const FormatException(
          'Timeline boundary changed during catch-up',
        );
      }
      applyPage(page);
      next = page.nextAfter;
    }
    return TimelineSnapshot(
      events: events.values.toList()..sort((a, b) => a.seq.compareTo(b.seq)),
      through: previous.through,
      cursor: boundary,
      nextBefore: previous.nextBefore,
      live: view.live,
    );
  }

  Future<void> loadEarlier() async {
    final previous = _snapshot;
    final before = previous?.nextBefore;
    if (_loadingHistory ||
        _loading ||
        _closed ||
        previous == null ||
        before == null) {
      return;
    }
    _loadingHistory = true;
    final window = _window;
    try {
      final result = await _rpc.call(
        MobileTimelineMethods.history,
        MobileTimelineHistoryParams(
          threadId: threadId,
          through: previous.through,
          before: before,
        ).toJson(),
      );
      final page = MobileTimelinePage.fromJson(result as Map<String, dynamic>);
      final current = _snapshot;
      if (window != _window || current == null || _closed) return;
      final seen = current.events.map((event) => event.seq).toSet();
      _replace(
        TimelineSnapshot(
          events: [
            ...page.events.where((event) => !seen.contains(event.seq)),
            ...current.events,
          ],
          through: current.through,
          cursor: current.cursor,
          nextBefore: page.nextBefore,
          live: current.live,
        ),
      );
    } finally {
      _loadingHistory = false;
    }
  }

  Future<MobileTimelineContentResult> content({
    int? seq,
    String? runId,
    String? toolId,
    required MobileTimelineContentField field,
    int? offset,
  }) async {
    final result = await _rpc.call(
      MobileTimelineMethods.content,
      MobileTimelineContentParams(
        threadId: threadId,
        seq: seq,
        runId: runId,
        toolId: toolId,
        field: field,
        offset: offset,
      ).toJson(),
    );
    return MobileTimelineContentResult.fromJson(result as Map<String, dynamic>);
  }

  void _notification(Map<String, dynamic> message) {
    final method = message['method'];
    if (_closed ||
        (method != MobileTimelineMethods.event &&
            method != MobileTimelineMethods.delta)) {
      return;
    }
    final params = message['params'];
    if (params is! Map<String, dynamic> || params['threadId'] != threadId) {
      return;
    }
    if (_loading) {
      if (_buffer.length >= 512) {
        _missedNotifications = true;
      } else {
        _buffer.add(message);
      }
      return;
    }
    final current = _snapshot;
    if (current == null) return;
    try {
      if (method == MobileTimelineMethods.event) {
        final notice = MobileTimelineNotice.fromJson(params);
        if (notice.event.seq <= current.cursor) return;
        if (notice.previousSeq != current.cursor) {
          _recover();
          return;
        }
        _replace(
          TimelineSnapshot(
            events: [...current.events, notice.event],
            through: current.through,
            cursor: notice.event.seq,
            nextBefore: current.nextBefore,
            live: _applyEvent(current.live, notice.event),
          ),
        );
      } else {
        final delta = MobileRunDelta.fromJson(params);
        if (_recoveringLive) {
          if (_liveBuffer.length < 512) {
            _liveBuffer.add(delta);
          } else {
            _missedLive = true;
          }
        } else if (!_acceptDelta(delta)) {
          unawaited(_recoverLive());
        }
      }
    } catch (error, stack) {
      if (!_updates.isClosed) _updates.addError(error, stack);
    }
  }

  bool _acceptDelta(MobileRunDelta delta) {
    final current = _snapshot;
    final live = current?.live;
    if (current == null) return false;
    if (live == null || live.runId != delta.runId) {
      return current.events.reversed.any(
        (event) =>
            event.runId == delta.runId &&
            const {
              MobileTimelineKind.runCompleted,
              MobileTimelineKind.runFailed,
              MobileTimelineKind.runInterrupted,
            }.contains(event.kind),
      );
    }
    if (delta.revision <= live.revision) return true;
    if (delta.revision != live.revision + 1) return false;
    _replace(TimelineSnapshot._withLive(current, _applyDelta(live, delta)));
    return true;
  }

  Future<void> _recoverLive() async {
    if (_loading || _closed || _recoveringLive) return;
    _recoveringLive = true;
    final window = _window;
    try {
      while (!_closed && window == _window) {
        final result = await _rpc.call(
          MobileTimelineMethods.live,
          MobileTimelineThreadParams(threadId: threadId).toJson(),
        );
        final recovered = MobileTimelineLiveResult.fromJson(
          result as Map<String, dynamic>,
        );
        final current = _snapshot;
        if (current == null || _closed || window != _window) return;
        final queued = [..._liveBuffer];
        _liveBuffer.clear();
        final missed = _missedLive;
        _missedLive = false;
        if (missed || current.cursor > recovered.through) continue;
        _replace(TimelineSnapshot._withLive(current, recovered.live));
        if (queued.every(_acceptDelta)) return;
      }
    } catch (error, stack) {
      if (!_updates.isClosed) _updates.addError(error, stack);
    } finally {
      _recoveringLive = false;
      _liveBuffer.clear();
      _missedLive = false;
    }
  }

  void _recover() {
    if (_loading || _closed) return;
    unawaited(
      refresh().catchError((Object error, StackTrace stack) {
        if (!_updates.isClosed) _updates.addError(error, stack);
      }),
    );
  }

  void _replace(TimelineSnapshot next) {
    if (_closed || _updates.isClosed) return;
    _snapshot = next;
    _updates.add(next);
  }

  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    await _subscription.cancel();
    try {
      await _rpc.call(
        MobileTimelineMethods.unsubscribe,
        MobileTimelineThreadParams(threadId: threadId).toJson(),
      );
    } catch (_) {
      // The Host releases its subscription when the connection is closed.
    } finally {
      if (!_updates.isClosed) unawaited(_updates.close());
    }
  }
}

MobileActiveRun? _applyEvent(MobileActiveRun? live, MobileTimelineEvent event) {
  if (event.kind == MobileTimelineKind.runStarted && event.runId != null) {
    return MobileActiveRun(
      runId: event.runId!,
      startedAt: event.createdAt,
      revision: 0,
      text: '',
      textTruncated: false,
      reasoning: '',
      reasoningTruncated: false,
      tools: const [],
      pending: const [],
    );
  }
  if (live == null || live.runId != event.runId) return live;
  if (const {
    MobileTimelineKind.runCompleted,
    MobileTimelineKind.runFailed,
    MobileTimelineKind.runInterrupted,
  }.contains(event.kind)) {
    return null;
  }
  var tools = live.tools;
  var pending = live.pending;
  final itemId = event.itemId;
  final kind = event.kind;
  if (itemId != null) {
    if (kind == MobileTimelineKind.toolCompleted) {
      tools = tools.where((tool) => tool.id != itemId).toList();
    }
    if (kind == MobileTimelineKind.approvalRequested ||
        kind == MobileTimelineKind.questionRequested) {
      pending = [
        ...pending.where((item) => item.id != itemId),
        MobileTimelinePending(
          id: itemId,
          kind: kind == MobileTimelineKind.approvalRequested
              ? MobileTimelinePendingKind.approval
              : MobileTimelinePendingKind.question,
        ),
      ];
    }
    if (kind == MobileTimelineKind.approvalResolved ||
        kind == MobileTimelineKind.questionAnswered) {
      pending = pending.where((item) => item.id != itemId).toList();
    }
  }

  final clearText = kind == MobileTimelineKind.messageAssistant;
  final clearReasoning = kind == MobileTimelineKind.reasoning;
  return MobileActiveRun(
    runId: live.runId,
    startedAt: live.startedAt,
    revision: live.revision,
    text: clearText ? '' : live.text,
    textTruncated: !clearText && live.textTruncated,
    reasoning: clearReasoning ? '' : live.reasoning,
    reasoningTruncated: !clearReasoning && live.reasoningTruncated,
    tools: List.unmodifiable(tools),
    pending: List.unmodifiable(pending),
    step: kind == MobileTimelineKind.toolStarted ? event.name : live.step,
    finishedSteps: event.finishedSteps ?? live.finishedSteps,
    totalSteps: event.totalSteps ?? live.totalSteps,
  );
}

({String text, bool truncated}) _append(
  String before,
  bool truncated,
  MobileRunDelta delta,
  int limit,
) {
  if (truncated) return (text: before, truncated: true);
  final text = before + delta.text;
  if (text.length <= limit) {
    return (text: text, truncated: delta.truncated ?? false);
  }
  final preview = String.fromCharCodes(text.runes.take(limit));
  return (
    text: preview,
    truncated: preview.length < text.length || (delta.truncated ?? false),
  );
}

MobileActiveRun _applyDelta(MobileActiveRun live, MobileRunDelta delta) {
  var answer = (text: live.text, truncated: live.textTruncated);
  var reasoning = (text: live.reasoning, truncated: live.reasoningTruncated);
  var tools = live.tools;
  var step = live.step;
  switch (delta.kind) {
    case MobileRunDeltaKind.text:
      answer = _append(
        live.text,
        live.textTruncated,
        delta,
        timelineTextPreviewLength,
      );
      step = '正在回答';
    case MobileRunDeltaKind.reasoning:
      reasoning = _append(
        live.reasoning,
        live.reasoningTruncated,
        delta,
        timelineTextPreviewLength,
      );
      step = '正在思考';
    case MobileRunDeltaKind.tool:
      if (delta.toolId case final id?) {
        final old = tools.where((item) => item.id == id).firstOrNull;
        final part = _append(
          old?.text ?? '',
          old?.truncated ?? false,
          delta,
          timelineToolPreviewLength,
        );
        tools = List.unmodifiable([
          ...tools.where((item) => item.id != id),
          MobileTimelineToolPreview(
            id: id,
            text: part.text,
            truncated: part.truncated,
          ),
        ]);
      }
  }
  return MobileActiveRun(
    runId: live.runId,
    startedAt: live.startedAt,
    revision: delta.revision,
    text: answer.text,
    textTruncated: answer.truncated,
    reasoning: reasoning.text,
    reasoningTruncated: reasoning.truncated,
    tools: tools,
    pending: live.pending,
    step: step,
    finishedSteps: live.finishedSteps,
    totalSteps: live.totalSteps,
  );
}
