// 由 generate-mobile-contracts.ts 从 Zod 的 JSON Schema 生成。

abstract final class MobileCommandMethods {
  static const start = 'run.start';
  static const interrupt = 'run.interrupt';
  static const receipt = 'command.receipt';
}

const mobileCommandTextLimit = 10000;

final class MobileStartRunParams {
  const MobileStartRunParams({
    required this.commandId,
    required this.threadId,
    required this.text,
  });
  final String commandId;
  final String threadId;
  final String text;

  factory MobileStartRunParams.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {'commandId', 'threadId', 'text'}.contains(key),
    )) {
      throw const FormatException(
        'MobileStartRunParams contains an unknown field',
      );
    }
    final commandId = json['commandId'] as String;
    if (!RegExp(
      '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)\$',
    ).hasMatch(commandId)) {
      throw const FormatException('Invalid commandId');
    }
    final threadId = json['threadId'] as String;
    if (threadId.isEmpty) {
      throw const FormatException('Invalid threadId');
    }
    final text = json['text'] as String;
    if (text.isEmpty || text.length > 10000 || !RegExp('\\S').hasMatch(text)) {
      throw const FormatException('Invalid text');
    }
    return MobileStartRunParams(
      commandId: commandId,
      threadId: threadId,
      text: text,
    );
  }

  Map<String, Object?> toJson() => {
    'commandId': commandId,
    'threadId': threadId,
    'text': text,
  };
}

final class MobileInterruptRunParams {
  const MobileInterruptRunParams({
    required this.commandId,
    required this.threadId,
    required this.runId,
  });
  final String commandId;
  final String threadId;
  final String runId;

  factory MobileInterruptRunParams.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {'commandId', 'threadId', 'runId'}.contains(key),
    )) {
      throw const FormatException(
        'MobileInterruptRunParams contains an unknown field',
      );
    }
    final commandId = json['commandId'] as String;
    if (!RegExp(
      '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)\$',
    ).hasMatch(commandId)) {
      throw const FormatException('Invalid commandId');
    }
    final threadId = json['threadId'] as String;
    if (threadId.isEmpty) {
      throw const FormatException('Invalid threadId');
    }
    final runId = json['runId'] as String;
    if (runId.isEmpty) {
      throw const FormatException('Invalid runId');
    }
    return MobileInterruptRunParams(
      commandId: commandId,
      threadId: threadId,
      runId: runId,
    );
  }

  Map<String, Object?> toJson() => {
    'commandId': commandId,
    'threadId': threadId,
    'runId': runId,
  };
}

final class MobileReceiptParams {
  const MobileReceiptParams({required this.commandId});
  final String commandId;

  factory MobileReceiptParams.fromJson(Map<String, dynamic> json) {
    if (json.keys.any((key) => !const {'commandId'}.contains(key))) {
      throw const FormatException(
        'MobileReceiptParams contains an unknown field',
      );
    }
    final commandId = json['commandId'] as String;
    if (!RegExp(
      '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)\$',
    ).hasMatch(commandId)) {
      throw const FormatException('Invalid commandId');
    }
    return MobileReceiptParams(commandId: commandId);
  }

  Map<String, Object?> toJson() => {'commandId': commandId};
}

enum MobileRunMethod {
  runStart('run.start'),
  runInterrupt('run.interrupt');

  const MobileRunMethod(this.wire);
  final String wire;

  factory MobileRunMethod.fromWire(String wire) {
    for (final value in values) {
      if (value.wire == wire) return value;
    }
    throw const FormatException('Invalid MobileRunMethod');
  }
}

final class MobileRunReceipt {
  const MobileRunReceipt({
    required this.commandId,
    required this.method,
    required this.threadId,
    required this.runId,
  });
  final String commandId;
  final MobileRunMethod method;
  final String threadId;
  final String runId;

  factory MobileRunReceipt.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) =>
          !const {'commandId', 'method', 'threadId', 'runId'}.contains(key),
    )) {
      throw const FormatException('MobileRunReceipt contains an unknown field');
    }
    final commandId = json['commandId'] as String;
    if (!RegExp(
      '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)\$',
    ).hasMatch(commandId)) {
      throw const FormatException('Invalid commandId');
    }
    final method = MobileRunMethod.fromWire(json['method'] as String);
    final threadId = json['threadId'] as String;
    if (threadId.isEmpty) {
      throw const FormatException('Invalid threadId');
    }
    final runId = json['runId'] as String;
    if (runId.isEmpty) {
      throw const FormatException('Invalid runId');
    }
    return MobileRunReceipt(
      commandId: commandId,
      method: method,
      threadId: threadId,
      runId: runId,
    );
  }

  Map<String, Object?> toJson() => {
    'commandId': commandId,
    'method': method.wire,
    'threadId': threadId,
    'runId': runId,
  };
}

final class MobileReceiptResult {
  const MobileReceiptResult({this.receipt});
  final MobileRunReceipt? receipt;

  factory MobileReceiptResult.fromJson(Map<String, dynamic> json) {
    if (json.keys.any((key) => !const {'receipt'}.contains(key))) {
      throw const FormatException(
        'MobileReceiptResult contains an unknown field',
      );
    }
    final receipt = json.containsKey('receipt')
        ? MobileRunReceipt.fromJson(json['receipt'] as Map<String, dynamic>)
        : null;
    return MobileReceiptResult(receipt: receipt);
  }

  Map<String, Object?> toJson() => {'receipt': ?receipt?.toJson()};
}
