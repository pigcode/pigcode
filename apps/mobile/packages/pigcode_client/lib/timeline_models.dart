// 由 generate-mobile-contracts.ts 从 Zod 的 JSON Schema 生成。

abstract final class MobileTimelineMethods {
  static const subscribe = 'thread.subscribe';
  static const unsubscribe = 'thread.unsubscribe';
  static const history = 'thread.history';
  static const content = 'thread.content';
  static const live = 'thread.live';
  static const event = 'thread.event';
  static const delta = 'thread.delta';
}

const timelineTextPreviewLength = 8192;
const timelineToolPreviewLength = 512;

final class MobileTimelineThreadParams {
  const MobileTimelineThreadParams({required this.threadId});
  final String threadId;

  factory MobileTimelineThreadParams.fromJson(Map<String, dynamic> json) {
    if (json.keys.any((key) => !const {'threadId'}.contains(key))) {
      throw const FormatException(
        'MobileTimelineThreadParams contains an unknown field',
      );
    }
    final threadId = json['threadId'] as String;
    if (threadId.isEmpty) {
      throw const FormatException('Invalid threadId');
    }
    return MobileTimelineThreadParams(threadId: threadId);
  }

  Map<String, Object?> toJson() => {'threadId': threadId};
}

final class MobileTimelineHistoryParams {
  const MobileTimelineHistoryParams({
    required this.threadId,
    required this.through,
    required this.before,
  });
  final String threadId;
  final int through;
  final int before;

  factory MobileTimelineHistoryParams.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {'threadId', 'through', 'before'}.contains(key),
    )) {
      throw const FormatException(
        'MobileTimelineHistoryParams contains an unknown field',
      );
    }
    final threadId = json['threadId'] as String;
    if (threadId.isEmpty) {
      throw const FormatException('Invalid threadId');
    }
    final through = json['through'] as int;
    if (through < 0 || through > 9007199254740991) {
      throw const FormatException('Invalid through');
    }
    final before = json['before'] as int;
    if (before > 9007199254740991) {
      throw const FormatException('Invalid before');
    }
    return MobileTimelineHistoryParams(
      threadId: threadId,
      through: through,
      before: before,
    );
  }

  Map<String, Object?> toJson() => {
    'threadId': threadId,
    'through': through,
    'before': before,
  };
}

final class MobileTimelineContentParams {
  const MobileTimelineContentParams({
    required this.threadId,
    this.seq,
    this.runId,
    this.toolId,
    required this.field,
    this.offset,
  });
  final String threadId;
  final int? seq;
  final String? runId;
  final String? toolId;
  final MobileTimelineContentField field;
  final int? offset;

  factory MobileTimelineContentParams.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {
        'threadId',
        'seq',
        'runId',
        'toolId',
        'field',
        'offset',
      }.contains(key),
    )) {
      throw const FormatException(
        'MobileTimelineContentParams contains an unknown field',
      );
    }
    final threadId = json['threadId'] as String;
    if (threadId.isEmpty) {
      throw const FormatException('Invalid threadId');
    }
    final seq = json.containsKey('seq') ? json['seq'] as int : null;
    if (seq != null && (seq > 9007199254740991)) {
      throw const FormatException('Invalid seq');
    }
    final runId = json.containsKey('runId') ? json['runId'] as String : null;
    if (runId != null && (runId.isEmpty)) {
      throw const FormatException('Invalid runId');
    }
    final toolId = json.containsKey('toolId') ? json['toolId'] as String : null;
    if (toolId != null && (toolId.isEmpty)) {
      throw const FormatException('Invalid toolId');
    }
    final field = MobileTimelineContentField.fromWire(json['field'] as String);
    final offset = json.containsKey('offset') ? json['offset'] as int : null;
    if (offset != null && (offset < 0 || offset > 9007199254740991)) {
      throw const FormatException('Invalid offset');
    }
    return MobileTimelineContentParams(
      threadId: threadId,
      seq: seq,
      runId: runId,
      toolId: toolId,
      field: field,
      offset: offset,
    );
  }

  Map<String, Object?> toJson() => {
    'threadId': threadId,
    'seq': ?seq,
    'runId': ?runId,
    'toolId': ?toolId,
    'field': field.wire,
    'offset': ?offset,
  };
}

enum MobileTimelineContentField {
  text('text'),
  input('input'),
  output('output'),
  reasoning('reasoning');

  const MobileTimelineContentField(this.wire);
  final String wire;

  factory MobileTimelineContentField.fromWire(String wire) {
    for (final value in values) {
      if (value.wire == wire) return value;
    }
    throw const FormatException('Invalid MobileTimelineContentField');
  }
}

enum MobileTimelineKind {
  runQueued('run.queued'),
  runStarted('run.started'),
  runCompleted('run.completed'),
  runFailed('run.failed'),
  runInterrupted('run.interrupted'),
  messageUser('message.user'),
  messageAssistant('message.assistant'),
  reasoning('reasoning'),
  toolStarted('tool.started'),
  toolCompleted('tool.completed'),
  file('file'),
  plan('plan'),
  notice('notice'),
  approvalRequested('approval.requested'),
  approvalResolved('approval.resolved'),
  questionRequested('question.requested'),
  questionAnswered('question.answered');

  const MobileTimelineKind(this.wire);
  final String wire;

  factory MobileTimelineKind.fromWire(String wire) {
    for (final value in values) {
      if (value.wire == wire) return value;
    }
    throw const FormatException('Invalid MobileTimelineKind');
  }
}

final class MobileTimelineEvent {
  const MobileTimelineEvent({
    required this.seq,
    this.runId,
    required this.kind,
    required this.createdAt,
    this.text,
    this.truncated,
    this.itemId,
    this.name,
    this.failed,
    this.finishedSteps,
    this.totalSteps,
  });
  final int seq;
  final String? runId;
  final MobileTimelineKind kind;
  final String createdAt;
  final String? text;
  final bool? truncated;
  final String? itemId;
  final String? name;
  final bool? failed;
  final int? finishedSteps;
  final int? totalSteps;

  factory MobileTimelineEvent.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {
        'seq',
        'runId',
        'kind',
        'createdAt',
        'text',
        'truncated',
        'itemId',
        'name',
        'failed',
        'finishedSteps',
        'totalSteps',
      }.contains(key),
    )) {
      throw const FormatException(
        'MobileTimelineEvent contains an unknown field',
      );
    }
    final seq = json['seq'] as int;
    if (seq < 0 || seq > 9007199254740991) {
      throw const FormatException('Invalid seq');
    }
    final runId = json.containsKey('runId') ? json['runId'] as String : null;
    if (runId != null && (runId.isEmpty)) {
      throw const FormatException('Invalid runId');
    }
    final kind = MobileTimelineKind.fromWire(json['kind'] as String);
    final createdAt = json['createdAt'] as String;
    if (!RegExp(
      '^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))\$',
    ).hasMatch(createdAt)) {
      throw const FormatException('Invalid createdAt');
    }
    final text = json.containsKey('text') ? json['text'] as String : null;
    final truncated = json.containsKey('truncated')
        ? json['truncated'] as bool
        : null;
    final itemId = json.containsKey('itemId') ? json['itemId'] as String : null;
    final name = json.containsKey('name') ? json['name'] as String : null;
    final failed = json.containsKey('failed') ? json['failed'] as bool : null;
    final finishedSteps = json.containsKey('finishedSteps')
        ? json['finishedSteps'] as int
        : null;
    if (finishedSteps != null &&
        (finishedSteps < 0 || finishedSteps > 9007199254740991)) {
      throw const FormatException('Invalid finishedSteps');
    }
    final totalSteps = json.containsKey('totalSteps')
        ? json['totalSteps'] as int
        : null;
    if (totalSteps != null &&
        (totalSteps < 0 || totalSteps > 9007199254740991)) {
      throw const FormatException('Invalid totalSteps');
    }
    return MobileTimelineEvent(
      seq: seq,
      runId: runId,
      kind: kind,
      createdAt: createdAt,
      text: text,
      truncated: truncated,
      itemId: itemId,
      name: name,
      failed: failed,
      finishedSteps: finishedSteps,
      totalSteps: totalSteps,
    );
  }

  Map<String, Object?> toJson() => {
    'seq': seq,
    'runId': ?runId,
    'kind': kind.wire,
    'createdAt': createdAt,
    'text': ?text,
    'truncated': ?truncated,
    'itemId': ?itemId,
    'name': ?name,
    'failed': ?failed,
    'finishedSteps': ?finishedSteps,
    'totalSteps': ?totalSteps,
  };
}

final class MobileTimelineToolPreview {
  const MobileTimelineToolPreview({
    required this.id,
    required this.text,
    required this.truncated,
  });
  final String id;
  final String text;
  final bool truncated;

  factory MobileTimelineToolPreview.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {'id', 'text', 'truncated'}.contains(key),
    )) {
      throw const FormatException(
        'MobileTimelineToolPreview contains an unknown field',
      );
    }
    final id = json['id'] as String;
    if (id.isEmpty) {
      throw const FormatException('Invalid id');
    }
    final text = json['text'] as String;
    final truncated = json['truncated'] as bool;
    return MobileTimelineToolPreview(id: id, text: text, truncated: truncated);
  }

  Map<String, Object?> toJson() => {
    'id': id,
    'text': text,
    'truncated': truncated,
  };
}

enum MobileTimelinePendingKind {
  approval('approval'),
  question('question');

  const MobileTimelinePendingKind(this.wire);
  final String wire;

  factory MobileTimelinePendingKind.fromWire(String wire) {
    for (final value in values) {
      if (value.wire == wire) return value;
    }
    throw const FormatException('Invalid MobileTimelinePendingKind');
  }
}

final class MobileTimelinePending {
  const MobileTimelinePending({required this.id, required this.kind});
  final String id;
  final MobileTimelinePendingKind kind;

  factory MobileTimelinePending.fromJson(Map<String, dynamic> json) {
    if (json.keys.any((key) => !const {'id', 'kind'}.contains(key))) {
      throw const FormatException(
        'MobileTimelinePending contains an unknown field',
      );
    }
    final id = json['id'] as String;
    if (id.isEmpty) {
      throw const FormatException('Invalid id');
    }
    final kind = MobileTimelinePendingKind.fromWire(json['kind'] as String);
    return MobileTimelinePending(id: id, kind: kind);
  }

  Map<String, Object?> toJson() => {'id': id, 'kind': kind.wire};
}

final class MobileActiveRun {
  const MobileActiveRun({
    required this.runId,
    required this.startedAt,
    required this.revision,
    required this.text,
    required this.textTruncated,
    required this.reasoning,
    required this.reasoningTruncated,
    required this.tools,
    required this.pending,
    this.step,
    this.finishedSteps,
    this.totalSteps,
  });
  final String runId;
  final String startedAt;
  final int revision;
  final String text;
  final bool textTruncated;
  final String reasoning;
  final bool reasoningTruncated;
  final List<MobileTimelineToolPreview> tools;
  final List<MobileTimelinePending> pending;
  final String? step;
  final int? finishedSteps;
  final int? totalSteps;

  factory MobileActiveRun.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {
        'runId',
        'startedAt',
        'revision',
        'text',
        'textTruncated',
        'reasoning',
        'reasoningTruncated',
        'tools',
        'pending',
        'step',
        'finishedSteps',
        'totalSteps',
      }.contains(key),
    )) {
      throw const FormatException('MobileActiveRun contains an unknown field');
    }
    final runId = json['runId'] as String;
    if (runId.isEmpty) {
      throw const FormatException('Invalid runId');
    }
    final startedAt = json['startedAt'] as String;
    if (!RegExp(
      '^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))\$',
    ).hasMatch(startedAt)) {
      throw const FormatException('Invalid startedAt');
    }
    final revision = json['revision'] as int;
    if (revision < 0 || revision > 9007199254740991) {
      throw const FormatException('Invalid revision');
    }
    final text = json['text'] as String;
    final textTruncated = json['textTruncated'] as bool;
    final reasoning = json['reasoning'] as String;
    final reasoningTruncated = json['reasoningTruncated'] as bool;
    final tools = List<MobileTimelineToolPreview>.unmodifiable(
      (json['tools'] as List<dynamic>).map(
        (item) =>
            MobileTimelineToolPreview.fromJson(item as Map<String, dynamic>),
      ),
    );
    final pending = List<MobileTimelinePending>.unmodifiable(
      (json['pending'] as List<dynamic>).map(
        (item) => MobileTimelinePending.fromJson(item as Map<String, dynamic>),
      ),
    );
    final step = json.containsKey('step') ? json['step'] as String : null;
    final finishedSteps = json.containsKey('finishedSteps')
        ? json['finishedSteps'] as int
        : null;
    if (finishedSteps != null &&
        (finishedSteps < 0 || finishedSteps > 9007199254740991)) {
      throw const FormatException('Invalid finishedSteps');
    }
    final totalSteps = json.containsKey('totalSteps')
        ? json['totalSteps'] as int
        : null;
    if (totalSteps != null &&
        (totalSteps < 0 || totalSteps > 9007199254740991)) {
      throw const FormatException('Invalid totalSteps');
    }
    return MobileActiveRun(
      runId: runId,
      startedAt: startedAt,
      revision: revision,
      text: text,
      textTruncated: textTruncated,
      reasoning: reasoning,
      reasoningTruncated: reasoningTruncated,
      tools: tools,
      pending: pending,
      step: step,
      finishedSteps: finishedSteps,
      totalSteps: totalSteps,
    );
  }

  Map<String, Object?> toJson() => {
    'runId': runId,
    'startedAt': startedAt,
    'revision': revision,
    'text': text,
    'textTruncated': textTruncated,
    'reasoning': reasoning,
    'reasoningTruncated': reasoningTruncated,
    'tools': tools.map((item) => item.toJson()).toList(),
    'pending': pending.map((item) => item.toJson()).toList(),
    'step': ?step,
    'finishedSteps': ?finishedSteps,
    'totalSteps': ?totalSteps,
  };
}

final class MobileTimelinePage {
  const MobileTimelinePage({
    required this.events,
    required this.through,
    this.nextBefore,
  });
  final List<MobileTimelineEvent> events;
  final int through;
  final int? nextBefore;

  factory MobileTimelinePage.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {'events', 'through', 'nextBefore'}.contains(key),
    )) {
      throw const FormatException(
        'MobileTimelinePage contains an unknown field',
      );
    }
    final events = List<MobileTimelineEvent>.unmodifiable(
      (json['events'] as List<dynamic>).map(
        (item) => MobileTimelineEvent.fromJson(item as Map<String, dynamic>),
      ),
    );
    final through = json['through'] as int;
    if (through < 0 || through > 9007199254740991) {
      throw const FormatException('Invalid through');
    }
    final nextBefore = json.containsKey('nextBefore')
        ? json['nextBefore'] as int
        : null;
    if (nextBefore != null && (nextBefore > 9007199254740991)) {
      throw const FormatException('Invalid nextBefore');
    }
    return MobileTimelinePage(
      events: events,
      through: through,
      nextBefore: nextBefore,
    );
  }

  Map<String, Object?> toJson() => {
    'events': events.map((item) => item.toJson()).toList(),
    'through': through,
    'nextBefore': ?nextBefore,
  };
}

final class MobileTimelineSubscription {
  const MobileTimelineSubscription({required this.page, this.live});
  final MobileTimelinePage page;
  final MobileActiveRun? live;

  factory MobileTimelineSubscription.fromJson(Map<String, dynamic> json) {
    if (json.keys.any((key) => !const {'page', 'live'}.contains(key))) {
      throw const FormatException(
        'MobileTimelineSubscription contains an unknown field',
      );
    }
    final page = MobileTimelinePage.fromJson(
      json['page'] as Map<String, dynamic>,
    );
    final live = json.containsKey('live')
        ? MobileActiveRun.fromJson(json['live'] as Map<String, dynamic>)
        : null;
    return MobileTimelineSubscription(page: page, live: live);
  }

  Map<String, Object?> toJson() => {
    'page': page.toJson(),
    'live': ?live?.toJson(),
  };
}

final class MobileTimelineLiveResult {
  const MobileTimelineLiveResult({this.live, required this.through});
  final MobileActiveRun? live;
  final int through;

  factory MobileTimelineLiveResult.fromJson(Map<String, dynamic> json) {
    if (json.keys.any((key) => !const {'live', 'through'}.contains(key))) {
      throw const FormatException(
        'MobileTimelineLiveResult contains an unknown field',
      );
    }
    final live = json.containsKey('live')
        ? MobileActiveRun.fromJson(json['live'] as Map<String, dynamic>)
        : null;
    final through = json['through'] as int;
    if (through < 0 || through > 9007199254740991) {
      throw const FormatException('Invalid through');
    }
    return MobileTimelineLiveResult(live: live, through: through);
  }

  Map<String, Object?> toJson() => {
    'live': ?live?.toJson(),
    'through': through,
  };
}

final class MobileTimelineUnsubscribed {
  const MobileTimelineUnsubscribed({required this.ok});
  final bool ok;

  factory MobileTimelineUnsubscribed.fromJson(Map<String, dynamic> json) {
    if (json.keys.any((key) => !const {'ok'}.contains(key))) {
      throw const FormatException(
        'MobileTimelineUnsubscribed contains an unknown field',
      );
    }
    final ok = json['ok'] as bool;
    return MobileTimelineUnsubscribed(ok: ok);
  }

  Map<String, Object?> toJson() => {'ok': ok};
}

final class MobileTimelineContentResult {
  const MobileTimelineContentResult({required this.text, this.nextOffset});
  final String text;
  final int? nextOffset;

  factory MobileTimelineContentResult.fromJson(Map<String, dynamic> json) {
    if (json.keys.any((key) => !const {'text', 'nextOffset'}.contains(key))) {
      throw const FormatException(
        'MobileTimelineContentResult contains an unknown field',
      );
    }
    final text = json['text'] as String;
    final nextOffset = json.containsKey('nextOffset')
        ? json['nextOffset'] as int
        : null;
    if (nextOffset != null &&
        (nextOffset < 0 || nextOffset > 9007199254740991)) {
      throw const FormatException('Invalid nextOffset');
    }
    return MobileTimelineContentResult(text: text, nextOffset: nextOffset);
  }

  Map<String, Object?> toJson() => {'text': text, 'nextOffset': ?nextOffset};
}

final class MobileTimelineNotice {
  const MobileTimelineNotice({
    required this.threadId,
    required this.previousSeq,
    required this.event,
  });
  final String threadId;
  final int previousSeq;
  final MobileTimelineEvent event;

  factory MobileTimelineNotice.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {'threadId', 'previousSeq', 'event'}.contains(key),
    )) {
      throw const FormatException(
        'MobileTimelineNotice contains an unknown field',
      );
    }
    final threadId = json['threadId'] as String;
    if (threadId.isEmpty) {
      throw const FormatException('Invalid threadId');
    }
    final previousSeq = json['previousSeq'] as int;
    if (previousSeq < 0 || previousSeq > 9007199254740991) {
      throw const FormatException('Invalid previousSeq');
    }
    final event = MobileTimelineEvent.fromJson(
      json['event'] as Map<String, dynamic>,
    );
    return MobileTimelineNotice(
      threadId: threadId,
      previousSeq: previousSeq,
      event: event,
    );
  }

  Map<String, Object?> toJson() => {
    'threadId': threadId,
    'previousSeq': previousSeq,
    'event': event.toJson(),
  };
}

enum MobileRunDeltaKind {
  text('text'),
  reasoning('reasoning'),
  tool('tool');

  const MobileRunDeltaKind(this.wire);
  final String wire;

  factory MobileRunDeltaKind.fromWire(String wire) {
    for (final value in values) {
      if (value.wire == wire) return value;
    }
    throw const FormatException('Invalid MobileRunDeltaKind');
  }
}

final class MobileRunDelta {
  const MobileRunDelta({
    required this.threadId,
    required this.runId,
    required this.revision,
    required this.kind,
    required this.text,
    this.truncated,
    this.toolId,
  });
  final String threadId;
  final String runId;
  final int revision;
  final MobileRunDeltaKind kind;
  final String text;
  final bool? truncated;
  final String? toolId;

  factory MobileRunDelta.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {
        'threadId',
        'runId',
        'revision',
        'kind',
        'text',
        'truncated',
        'toolId',
      }.contains(key),
    )) {
      throw const FormatException('MobileRunDelta contains an unknown field');
    }
    final threadId = json['threadId'] as String;
    if (threadId.isEmpty) {
      throw const FormatException('Invalid threadId');
    }
    final runId = json['runId'] as String;
    if (runId.isEmpty) {
      throw const FormatException('Invalid runId');
    }
    final revision = json['revision'] as int;
    if (revision > 9007199254740991) {
      throw const FormatException('Invalid revision');
    }
    final kind = MobileRunDeltaKind.fromWire(json['kind'] as String);
    final text = json['text'] as String;
    final truncated = json.containsKey('truncated')
        ? json['truncated'] as bool
        : null;
    final toolId = json.containsKey('toolId') ? json['toolId'] as String : null;
    return MobileRunDelta(
      threadId: threadId,
      runId: runId,
      revision: revision,
      kind: kind,
      text: text,
      truncated: truncated,
      toolId: toolId,
    );
  }

  Map<String, Object?> toJson() => {
    'threadId': threadId,
    'runId': runId,
    'revision': revision,
    'kind': kind.wire,
    'text': text,
    'truncated': ?truncated,
    'toolId': ?toolId,
  };
}
