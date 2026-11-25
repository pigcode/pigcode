import 'timeline_models.dart';

enum TimelineTurnStatus {
  queued,
  running,
  waiting,
  completed,
  failed,
  interrupted,
}

enum TimelineWorkKind { message, reasoning, tool, question }

class TimelineWork {
  const TimelineWork(this.kind, this.event, {this.result});

  final TimelineWorkKind kind;
  final MobileTimelineEvent event;
  final MobileTimelineEvent? result;

  MobileTimelineEvent? get input =>
      event.kind == MobileTimelineKind.toolStarted ? event : null;
  MobileTimelineEvent? get output =>
      result ?? (event.kind == MobileTimelineKind.toolCompleted ? event : null);
}

class TimelineTurn {
  TimelineTurn._(_Draft draft)
    : key = draft.key,
      runId = draft.runId,
      firstSeq = draft.firstSeq,
      startedAt = draft.startedAt,
      terminal = draft.terminal,
      status = draft.status,
      user = draft.user,
      answer = draft.answer,
      work = List.unmodifiable(draft.work),
      notices = List.unmodifiable(draft.notices),
      pendingRequests = List.unmodifiable(draft.requestEvents.values),
      requestHistory = List.unmodifiable(draft.requestHistory),
      files = List.unmodifiable(draft.files),
      changes = draft.changes;

  final String key;
  final String? runId;
  final int firstSeq;
  final String startedAt;
  final MobileTimelineEvent? terminal;
  final TimelineTurnStatus status;
  final MobileTimelineEvent? user;
  final MobileTimelineEvent? answer;
  final List<TimelineWork> work;
  final List<MobileTimelineEvent> notices;
  final List<MobileTimelineEvent> pendingRequests;
  final List<MobileTimelineEvent> requestHistory;
  final List<String> files;
  final MobileTimelineEvent? changes;

  bool get folded =>
      status == TimelineTurnStatus.completed &&
      work.isNotEmpty &&
      answer != null;

  bool isPendingRequest(String? id) =>
      id != null && pendingRequests.any((event) => event.itemId == id);
}

List<TimelineTurn> timelineTurns(List<MobileTimelineEvent> events) {
  final sorted = [...events]..sort((a, b) => a.seq.compareTo(b.seq));
  final turns = <String, _Draft>{};
  for (final event in sorted) {
    final key = event.runId ?? 'seq-${event.seq}';
    final turn = turns.putIfAbsent(key, () => _Draft(key, event));
    turn.add(event);
  }
  return List.unmodifiable(turns.values.map((turn) => turn.finish()));
}

class _Draft {
  _Draft(this.key, MobileTimelineEvent event)
    : runId = event.runId,
      firstSeq = event.seq,
      startedAt = event.createdAt,
      status = event.runId == null
          ? TimelineTurnStatus.completed
          : TimelineTurnStatus.running;

  final String key;
  final String? runId;
  final int firstSeq;
  String startedAt;
  TimelineTurnStatus status;
  MobileTimelineEvent? user;
  MobileTimelineEvent? answer;
  MobileTimelineEvent? terminal;
  final work = <TimelineWork>[];
  final notices = <MobileTimelineEvent>[];
  final requestHistory = <MobileTimelineEvent>[];
  final requestEvents = <String, MobileTimelineEvent>{};
  final files = <String>{};
  MobileTimelineEvent? changes;
  final _tools = <String, int>{};
  final _questions = <String, int>{};
  final _requests = <String>{};
  bool _hasQuestionEvents = false;

  void add(MobileTimelineEvent event) {
    switch (event.kind) {
      case MobileTimelineKind.runQueued:
        status = TimelineTurnStatus.queued;
      case MobileTimelineKind.runStarted:
        status = TimelineTurnStatus.running;
        startedAt = event.createdAt;
        if ((event.text ?? '').isNotEmpty) user = event;
      case MobileTimelineKind.runCompleted:
      case MobileTimelineKind.runFailed:
      case MobileTimelineKind.runInterrupted:
        terminal = event;
        status = switch (event.kind) {
          MobileTimelineKind.runCompleted => TimelineTurnStatus.completed,
          MobileTimelineKind.runFailed => TimelineTurnStatus.failed,
          _ => TimelineTurnStatus.interrupted,
        };
        // 运行结束后未处理的请求已经失效，不再显示内联卡。
        requestEvents.clear();
        _requests.clear();
      case MobileTimelineKind.messageUser:
        if ((event.text ?? '').isNotEmpty) user = event;
      case MobileTimelineKind.messageAssistant:
        if ((event.text ?? '').isNotEmpty) {
          work.add(TimelineWork(TimelineWorkKind.message, event));
        }
      case MobileTimelineKind.reasoning:
        if ((event.text ?? '').trim().isNotEmpty) {
          work.add(TimelineWork(TimelineWorkKind.reasoning, event));
        }
      case MobileTimelineKind.toolStarted:
      case MobileTimelineKind.toolCompleted:
        final id = event.itemId;
        if (id == null) return;
        final index = _tools[id];
        if (index == null) {
          _tools[id] = work.length;
          work.add(TimelineWork(TimelineWorkKind.tool, event));
        } else if (event.kind == MobileTimelineKind.toolCompleted) {
          work[index] = TimelineWork(
            TimelineWorkKind.tool,
            work[index].event,
            result: event,
          );
        }
      case MobileTimelineKind.questionRequested:
        _hasQuestionEvents = true;
        if (event.itemId case final id?) {
          _questions[id] = work.length;
          requestEvents[id] = event;
        }
        work.add(TimelineWork(TimelineWorkKind.question, event));
        _wait(event.itemId);
      case MobileTimelineKind.approvalRequested:
        if (event.itemId case final id?) requestEvents[id] = event;
        _wait(event.itemId);
      case MobileTimelineKind.approvalResolved:
      case MobileTimelineKind.questionAnswered:
        if (_questions[event.itemId] case final index?
            when event.kind == MobileTimelineKind.questionAnswered) {
          work[index] = TimelineWork(
            TimelineWorkKind.question,
            work[index].event,
            result: event,
          );
        }
        if (event.text?.isNotEmpty ?? false) {
          notices.add(event);
        }
        if (event.itemId case final id?) requestEvents.remove(id);
        requestHistory.add(event);
        _requests.remove(event.itemId);
        if (_requests.isEmpty && status == TimelineTurnStatus.waiting) {
          status = TimelineTurnStatus.running;
        }
      case MobileTimelineKind.file:
        if (event.name case final name?) files.add(name);
      case MobileTimelineKind.changes:
        changes = event;
      case MobileTimelineKind.notice:
        notices.add(event);
      case MobileTimelineKind.plan:
      case MobileTimelineKind.queueChanged:
        break;
    }
  }

  void _wait(String? id) {
    if (id != null && status == TimelineTurnStatus.running) {
      _requests.add(id);
      status = TimelineTurnStatus.waiting;
    } else if (id != null && status == TimelineTurnStatus.waiting) {
      _requests.add(id);
    }
  }

  TimelineTurn finish() {
    work.removeWhere((item) {
      if (item.kind != TimelineWorkKind.tool) return false;
      final name = (item.output?.name ?? item.event.name ?? '')
          .trim()
          .toLowerCase();
      return const {
            'todowrite',
            'todoread',
            'update_plan',
            'taskcreate',
            'taskupdate',
            'tasklist',
            'taskget',
            'enterplanmode',
          }.contains(name) ||
          (_hasQuestionEvents && name == 'askuserquestion');
    });
    if ((terminal != null || runId == null) &&
        work.lastOrNull?.kind == TimelineWorkKind.message) {
      answer = work.removeLast().event;
    }
    return TimelineTurn._(this);
  }
}
