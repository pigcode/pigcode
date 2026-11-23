// 由 generate-mobile-contracts.ts 从 Zod 的 JSON Schema 生成。

abstract final class MobileReminderMethods {
  static const report = 'mobile.reminder-settings';
  static const configure = 'mobile.reminders.configure';
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

enum ApnsEnvironment {
  sandbox('sandbox'),
  production('production');

  const ApnsEnvironment(this.wire);
  final String wire;

  factory ApnsEnvironment.fromWire(String wire) {
    for (final value in values) {
      if (value.wire == wire) return value;
    }
    throw const FormatException('Invalid ApnsEnvironment');
  }
}

final class MobileApnsRegistration {
  const MobileApnsRegistration({
    required this.token,
    required this.environment,
    required this.observationId,
  });
  final String token;
  final ApnsEnvironment environment;
  final String observationId;

  factory MobileApnsRegistration.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {'token', 'environment', 'observationId'}.contains(key),
    )) {
      throw const FormatException(
        'MobileApnsRegistration contains an unknown field',
      );
    }
    final token = json['token'] as String;
    if (!RegExp('^(?:[0-9a-f]{2}){1,128}\$').hasMatch(token)) {
      throw const FormatException('Invalid token');
    }
    final environment = ApnsEnvironment.fromWire(json['environment'] as String);
    final observationId = json['observationId'] as String;
    if (!RegExp(
      '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)\$',
    ).hasMatch(observationId)) {
      throw const FormatException('Invalid observationId');
    }
    return MobileApnsRegistration(
      token: token,
      environment: environment,
      observationId: observationId,
    );
  }

  Map<String, Object?> toJson() => {
    'token': token,
    'environment': environment.wire,
    'observationId': observationId,
  };
}

final class MobileReminderSettings {
  const MobileReminderSettings({
    required this.enabled,
    required this.permission,
    this.apns,
  });
  final bool enabled;
  final MobileReminderPermission permission;
  final MobileApnsRegistration? apns;

  factory MobileReminderSettings.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {'enabled', 'permission', 'apns'}.contains(key),
    )) {
      throw const FormatException(
        'MobileReminderSettings contains an unknown field',
      );
    }
    final enabled = json['enabled'] as bool;
    final permission = MobileReminderPermission.fromWire(
      json['permission'] as String,
    );
    final apns = json.containsKey('apns')
        ? MobileApnsRegistration.fromJson(json['apns'] as Map<String, dynamic>)
        : null;
    return MobileReminderSettings(
      enabled: enabled,
      permission: permission,
      apns: apns,
    );
  }

  Map<String, Object?> toJson() => {
    'enabled': enabled,
    'permission': permission.wire,
    'apns': ?apns?.toJson(),
  };
}
