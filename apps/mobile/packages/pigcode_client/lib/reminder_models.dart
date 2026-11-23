// 由 generate-mobile-contracts.ts 从 Zod 的 JSON Schema 生成。

abstract final class MobileReminderMethods {
  static const report = 'mobile.reminder-settings';
}

enum ReminderKind {
  approval('approval'),
  question('question'),
  completed('completed'),
  failed('failed');

  const ReminderKind(this.wire);
  final String wire;

  factory ReminderKind.fromWire(String wire) {
    for (final value in values) {
      if (value.wire == wire) return value;
    }
    throw const FormatException('Invalid ReminderKind');
  }
}

final class MobileReminder {
  const MobileReminder({
    required this.version,
    required this.eventId,
    required this.threadId,
    required this.kind,
    required this.computerId,
  });
  final int version;
  final String eventId;
  final String threadId;
  final ReminderKind kind;
  final String computerId;

  factory MobileReminder.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {
        'version',
        'eventId',
        'threadId',
        'kind',
        'computerId',
      }.contains(key),
    )) {
      throw const FormatException('MobileReminder contains an unknown field');
    }
    final version = json['version'] as int;
    if (version < 1 || version > 1) {
      throw const FormatException('Invalid version');
    }
    final eventId = json['eventId'] as String;
    if (eventId.isEmpty || eventId.length > 256) {
      throw const FormatException('Invalid eventId');
    }
    final threadId = json['threadId'] as String;
    if (threadId.isEmpty || threadId.length > 128) {
      throw const FormatException('Invalid threadId');
    }
    final kind = ReminderKind.fromWire(json['kind'] as String);
    final computerId = json['computerId'] as String;
    if (!RegExp('^[0-9a-f]{64}\$').hasMatch(computerId)) {
      throw const FormatException('Invalid computerId');
    }
    return MobileReminder(
      version: version,
      eventId: eventId,
      threadId: threadId,
      kind: kind,
      computerId: computerId,
    );
  }

  Map<String, Object?> toJson() => {
    'version': version,
    'eventId': eventId,
    'threadId': threadId,
    'kind': kind.wire,
    'computerId': computerId,
  };
}

enum MobileReminderPermission {
  granted('granted'),
  denied('denied'),
  undetermined('undetermined');

  const MobileReminderPermission(this.wire);
  final String wire;

  factory MobileReminderPermission.fromWire(String wire) {
    for (final value in values) {
      if (value.wire == wire) return value;
    }
    throw const FormatException('Invalid MobileReminderPermission');
  }
}

final class MobileReminderSettings {
  const MobileReminderSettings({
    required this.enabled,
    required this.permission,
  });
  final bool enabled;
  final MobileReminderPermission permission;

  factory MobileReminderSettings.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {'enabled', 'permission'}.contains(key),
    )) {
      throw const FormatException(
        'MobileReminderSettings contains an unknown field',
      );
    }
    final enabled = json['enabled'] as bool;
    final permission = MobileReminderPermission.fromWire(
      json['permission'] as String,
    );
    return MobileReminderSettings(enabled: enabled, permission: permission);
  }

  Map<String, Object?> toJson() => {
    'enabled': enabled,
    'permission': permission.wire,
  };
}
