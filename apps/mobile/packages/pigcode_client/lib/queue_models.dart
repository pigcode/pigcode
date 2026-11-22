// 由 generate-mobile-contracts.ts 从 Zod 的 JSON Schema 生成。

abstract final class QueueMethods {
  static const get = 'queue.get';
  static const withdraw = 'queue.withdraw';
  static const stopAndSend = 'queue.stopAndSend';
  static const resume = 'queue.resume';
}

final class QueueThreadParams {
  const QueueThreadParams({required this.threadId});
  final String threadId;

  factory QueueThreadParams.fromJson(Map<String, dynamic> json) {
    if (json.keys.any((key) => !const {'threadId'}.contains(key))) {
      throw const FormatException(
        'QueueThreadParams contains an unknown field',
      );
    }
    final threadId = json['threadId'] as String;
    if (threadId.isEmpty || threadId.length > 128) {
      throw const FormatException('Invalid threadId');
    }
    return QueueThreadParams(threadId: threadId);
  }

  Map<String, Object?> toJson() => {'threadId': threadId};
}

final class QueueWithdrawParams {
  const QueueWithdrawParams({
    required this.threadId,
    required this.commandId,
    required this.messageId,
  });
  final String threadId;
  final String commandId;
  final String messageId;

  factory QueueWithdrawParams.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {'threadId', 'commandId', 'messageId'}.contains(key),
    )) {
      throw const FormatException(
        'QueueWithdrawParams contains an unknown field',
      );
    }
    final threadId = json['threadId'] as String;
    if (threadId.isEmpty || threadId.length > 128) {
      throw const FormatException('Invalid threadId');
    }
    final commandId = json['commandId'] as String;
    if (!RegExp(
      '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)\$',
    ).hasMatch(commandId)) {
      throw const FormatException('Invalid commandId');
    }
    final messageId = json['messageId'] as String;
    if (messageId.isEmpty || messageId.length > 128) {
      throw const FormatException('Invalid messageId');
    }
    return QueueWithdrawParams(
      threadId: threadId,
      commandId: commandId,
      messageId: messageId,
    );
  }

  Map<String, Object?> toJson() => {
    'threadId': threadId,
    'commandId': commandId,
    'messageId': messageId,
  };
}

final class QueueStopAndSendParams {
  const QueueStopAndSendParams({
    required this.threadId,
    required this.commandId,
    required this.messageId,
    required this.runId,
  });
  final String threadId;
  final String commandId;
  final String messageId;
  final String runId;

  factory QueueStopAndSendParams.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) =>
          !const {'threadId', 'commandId', 'messageId', 'runId'}.contains(key),
    )) {
      throw const FormatException(
        'QueueStopAndSendParams contains an unknown field',
      );
    }
    final threadId = json['threadId'] as String;
    if (threadId.isEmpty || threadId.length > 128) {
      throw const FormatException('Invalid threadId');
    }
    final commandId = json['commandId'] as String;
    if (!RegExp(
      '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)\$',
    ).hasMatch(commandId)) {
      throw const FormatException('Invalid commandId');
    }
    final messageId = json['messageId'] as String;
    if (messageId.isEmpty || messageId.length > 128) {
      throw const FormatException('Invalid messageId');
    }
    final runId = json['runId'] as String;
    if (runId.isEmpty || runId.length > 128) {
      throw const FormatException('Invalid runId');
    }
    return QueueStopAndSendParams(
      threadId: threadId,
      commandId: commandId,
      messageId: messageId,
      runId: runId,
    );
  }

  Map<String, Object?> toJson() => {
    'threadId': threadId,
    'commandId': commandId,
    'messageId': messageId,
    'runId': runId,
  };
}

final class QueueResumeParams {
  const QueueResumeParams({required this.threadId, required this.commandId});
  final String threadId;
  final String commandId;

  factory QueueResumeParams.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {'threadId', 'commandId'}.contains(key),
    )) {
      throw const FormatException(
        'QueueResumeParams contains an unknown field',
      );
    }
    final threadId = json['threadId'] as String;
    if (threadId.isEmpty || threadId.length > 128) {
      throw const FormatException('Invalid threadId');
    }
    final commandId = json['commandId'] as String;
    if (!RegExp(
      '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)\$',
    ).hasMatch(commandId)) {
      throw const FormatException('Invalid commandId');
    }
    return QueueResumeParams(threadId: threadId, commandId: commandId);
  }

  Map<String, Object?> toJson() => {
    'threadId': threadId,
    'commandId': commandId,
  };
}

final class QueuedMessage {
  const QueuedMessage({
    required this.id,
    required this.text,
    required this.selected,
  });
  final String id;
  final String text;
  final bool selected;

  factory QueuedMessage.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {'id', 'text', 'selected'}.contains(key),
    )) {
      throw const FormatException('QueuedMessage contains an unknown field');
    }
    final id = json['id'] as String;
    if (id.isEmpty || id.length > 128) {
      throw const FormatException('Invalid id');
    }
    final text = json['text'] as String;
    final selected = json['selected'] as bool;
    return QueuedMessage(id: id, text: text, selected: selected);
  }

  Map<String, Object?> toJson() => {
    'id': id,
    'text': text,
    'selected': selected,
  };
}

final class QueueSnapshot {
  const QueueSnapshot({
    required this.threadId,
    required this.paused,
    this.activeRunId,
    required this.messages,
  });
  final String threadId;
  final bool paused;
  final String? activeRunId;
  final List<QueuedMessage> messages;

  factory QueueSnapshot.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {
        'threadId',
        'paused',
        'activeRunId',
        'messages',
      }.contains(key),
    )) {
      throw const FormatException('QueueSnapshot contains an unknown field');
    }
    final threadId = json['threadId'] as String;
    if (threadId.isEmpty || threadId.length > 128) {
      throw const FormatException('Invalid threadId');
    }
    final paused = json['paused'] as bool;
    final activeRunId = json.containsKey('activeRunId')
        ? json['activeRunId'] as String
        : null;
    if (activeRunId != null &&
        (activeRunId.isEmpty || activeRunId.length > 128)) {
      throw const FormatException('Invalid activeRunId');
    }
    final messages = List<QueuedMessage>.unmodifiable(
      (json['messages'] as List<dynamic>).map(
        (item) => QueuedMessage.fromJson(item as Map<String, dynamic>),
      ),
    );
    return QueueSnapshot(
      threadId: threadId,
      paused: paused,
      activeRunId: activeRunId,
      messages: messages,
    );
  }

  Map<String, Object?> toJson() => {
    'threadId': threadId,
    'paused': paused,
    'activeRunId': ?activeRunId,
    'messages': messages.map((item) => item.toJson()).toList(),
  };
}

enum QueueMethod {
  queueWithdraw('queue.withdraw'),
  queueStopAndSend('queue.stopAndSend'),
  queueResume('queue.resume');

  const QueueMethod(this.wire);
  final String wire;

  factory QueueMethod.fromWire(String wire) {
    for (final value in values) {
      if (value.wire == wire) return value;
    }
    throw const FormatException('Invalid QueueMethod');
  }
}

enum QueueEffect {
  withdrawn('withdrawn'),
  scheduled('scheduled'),
  resumed('resumed'),
  unchanged('unchanged');

  const QueueEffect(this.wire);
  final String wire;

  factory QueueEffect.fromWire(String wire) {
    for (final value in values) {
      if (value.wire == wire) return value;
    }
    throw const FormatException('Invalid QueueEffect');
  }
}

final class QueueReceipt {
  const QueueReceipt({
    required this.threadId,
    required this.commandId,
    required this.method,
    required this.effect,
    this.messageId,
    this.runId,
    this.stoppedRunId,
    this.text,
  });
  final String threadId;
  final String commandId;
  final QueueMethod method;
  final QueueEffect effect;
  final String? messageId;
  final String? runId;
  final String? stoppedRunId;
  final String? text;

  factory QueueReceipt.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {
        'threadId',
        'commandId',
        'method',
        'effect',
        'messageId',
        'runId',
        'stoppedRunId',
        'text',
      }.contains(key),
    )) {
      throw const FormatException('QueueReceipt contains an unknown field');
    }
    final threadId = json['threadId'] as String;
    if (threadId.isEmpty || threadId.length > 128) {
      throw const FormatException('Invalid threadId');
    }
    final commandId = json['commandId'] as String;
    if (!RegExp(
      '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)\$',
    ).hasMatch(commandId)) {
      throw const FormatException('Invalid commandId');
    }
    final method = QueueMethod.fromWire(json['method'] as String);
    final effect = QueueEffect.fromWire(json['effect'] as String);
    final messageId = json.containsKey('messageId')
        ? json['messageId'] as String
        : null;
    if (messageId != null && (messageId.isEmpty || messageId.length > 128)) {
      throw const FormatException('Invalid messageId');
    }
    final runId = json.containsKey('runId') ? json['runId'] as String : null;
    if (runId != null && (runId.isEmpty || runId.length > 128)) {
      throw const FormatException('Invalid runId');
    }
    final stoppedRunId = json.containsKey('stoppedRunId')
        ? json['stoppedRunId'] as String
        : null;
    if (stoppedRunId != null &&
        (stoppedRunId.isEmpty || stoppedRunId.length > 128)) {
      throw const FormatException('Invalid stoppedRunId');
    }
    final text = json.containsKey('text') ? json['text'] as String : null;
    return QueueReceipt(
      threadId: threadId,
      commandId: commandId,
      method: method,
      effect: effect,
      messageId: messageId,
      runId: runId,
      stoppedRunId: stoppedRunId,
      text: text,
    );
  }

  Map<String, Object?> toJson() => {
    'threadId': threadId,
    'commandId': commandId,
    'method': method.wire,
    'effect': effect.wire,
    'messageId': ?messageId,
    'runId': ?runId,
    'stoppedRunId': ?stoppedRunId,
    'text': ?text,
  };
}

final class QueueReceiptResult {
  const QueueReceiptResult({this.receipt});
  final QueueReceipt? receipt;

  factory QueueReceiptResult.fromJson(Map<String, dynamic> json) {
    if (json.keys.any((key) => !const {'receipt'}.contains(key))) {
      throw const FormatException(
        'QueueReceiptResult contains an unknown field',
      );
    }
    final receipt = json.containsKey('receipt')
        ? QueueReceipt.fromJson(json['receipt'] as Map<String, dynamic>)
        : null;
    return QueueReceiptResult(receipt: receipt);
  }

  Map<String, Object?> toJson() => {'receipt': ?receipt?.toJson()};
}
