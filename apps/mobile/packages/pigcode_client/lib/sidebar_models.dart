// 由 generate-mobile-contracts.ts 从 Zod 的 JSON Schema 生成。

abstract final class MobileSidebarMethods {
  static const setPinned = 'thread.setPinned';
  static const archive = 'thread.archive';
  static const unarchive = 'thread.unarchive';
  static const markRead = 'thread.markRead';
  static const markAllRead = 'thread.markAllRead';
  static const acknowledgeRead = 'thread.acknowledgeRead';
  static const projectList = 'project.list';
  static const threadList = 'thread.list';
  static const subscribe = 'sidebar.subscribe';
  static const changed = 'sidebar.changed';
  static const status = 'mobile.status';
}

const mobileSidebarPageSize = 64;

final class MobileProjectListParams {
  const MobileProjectListParams({this.offset, this.limit});
  final int? offset;
  final int? limit;

  factory MobileProjectListParams.fromJson(Map<String, dynamic> json) {
    if (json.keys.any((key) => !const {'offset', 'limit'}.contains(key))) {
      throw const FormatException(
        'MobileProjectListParams contains an unknown field',
      );
    }
    final offset = json.containsKey('offset') ? json['offset'] as int : null;
    if (offset != null && (offset < 0 || offset > 9007199254740991)) {
      throw const FormatException('Invalid offset');
    }
    final limit = json.containsKey('limit') ? json['limit'] as int : null;
    if (limit != null && (limit < 1 || limit > 64)) {
      throw const FormatException('Invalid limit');
    }
    return MobileProjectListParams(offset: offset, limit: limit);
  }

  Map<String, Object?> toJson() => {'offset': ?offset, 'limit': ?limit};
}

final class MobileThreadListParams {
  const MobileThreadListParams({this.offset, this.limit, this.projectId});
  final int? offset;
  final int? limit;
  final String? projectId;

  factory MobileThreadListParams.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {'offset', 'limit', 'projectId'}.contains(key),
    )) {
      throw const FormatException(
        'MobileThreadListParams contains an unknown field',
      );
    }
    final offset = json.containsKey('offset') ? json['offset'] as int : null;
    if (offset != null && (offset < 0 || offset > 9007199254740991)) {
      throw const FormatException('Invalid offset');
    }
    final limit = json.containsKey('limit') ? json['limit'] as int : null;
    if (limit != null && (limit < 1 || limit > 64)) {
      throw const FormatException('Invalid limit');
    }
    final projectId = json.containsKey('projectId')
        ? json['projectId'] as String
        : null;
    if (projectId != null && (projectId.isEmpty)) {
      throw const FormatException('Invalid projectId');
    }
    return MobileThreadListParams(
      offset: offset,
      limit: limit,
      projectId: projectId,
    );
  }

  Map<String, Object?> toJson() => {
    'offset': ?offset,
    'limit': ?limit,
    'projectId': ?projectId,
  };
}

final class MobileSidebarSubscribeParams {
  const MobileSidebarSubscribeParams();

  factory MobileSidebarSubscribeParams.fromJson(Map<String, dynamic> json) {
    if (json.isNotEmpty) {
      throw const FormatException(
        'MobileSidebarSubscribeParams contains an unknown field',
      );
    }
    return MobileSidebarSubscribeParams();
  }

  Map<String, Object?> toJson() => {};
}

final class MobileSidebarSubscribeResult {
  const MobileSidebarSubscribeResult();

  factory MobileSidebarSubscribeResult.fromJson(Map<String, dynamic> json) {
    if (json.isNotEmpty) {
      throw const FormatException(
        'MobileSidebarSubscribeResult contains an unknown field',
      );
    }
    return MobileSidebarSubscribeResult();
  }

  Map<String, Object?> toJson() => {};
}

final class MobileSidebarChanged {
  const MobileSidebarChanged();

  factory MobileSidebarChanged.fromJson(Map<String, dynamic> json) {
    if (json.isNotEmpty) {
      throw const FormatException(
        'MobileSidebarChanged contains an unknown field',
      );
    }
    return MobileSidebarChanged();
  }

  Map<String, Object?> toJson() => {};
}

final class MobileStatusParams {
  const MobileStatusParams();

  factory MobileStatusParams.fromJson(Map<String, dynamic> json) {
    if (json.isNotEmpty) {
      throw const FormatException(
        'MobileStatusParams contains an unknown field',
      );
    }
    return MobileStatusParams();
  }

  Map<String, Object?> toJson() => {};
}

final class MobileStatus {
  const MobileStatus({
    required this.computerId,
    required this.computerName,
    required this.deviceId,
  });
  final String computerId;
  final String computerName;
  final String deviceId;

  factory MobileStatus.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {'computerId', 'computerName', 'deviceId'}.contains(key),
    )) {
      throw const FormatException('MobileStatus contains an unknown field');
    }
    final computerId = json['computerId'] as String;
    if (!RegExp('^[0-9a-f]{64}\$').hasMatch(computerId)) {
      throw const FormatException('Invalid computerId');
    }
    final computerName = json['computerName'] as String;
    if (computerName.isEmpty) {
      throw const FormatException('Invalid computerName');
    }
    final deviceId = json['deviceId'] as String;
    if (!RegExp('^[0-9a-f]{64}\$').hasMatch(deviceId)) {
      throw const FormatException('Invalid deviceId');
    }
    return MobileStatus(
      computerId: computerId,
      computerName: computerName,
      deviceId: deviceId,
    );
  }

  Map<String, Object?> toJson() => {
    'computerId': computerId,
    'computerName': computerName,
    'deviceId': deviceId,
  };
}

final class MobileRpcProblem {
  const MobileRpcProblem({
    required this.code,
    required this.message,
    this.retryable,
  });
  final String code;
  final String message;
  final bool? retryable;

  factory MobileRpcProblem.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {'code', 'message', 'retryable'}.contains(key),
    )) {
      throw const FormatException('MobileRpcProblem contains an unknown field');
    }
    final code = json['code'] as String;
    if (code.isEmpty) {
      throw const FormatException('Invalid code');
    }
    final message = json['message'] as String;
    if (message.isEmpty) {
      throw const FormatException('Invalid message');
    }
    final retryable = json.containsKey('retryable')
        ? json['retryable'] as bool
        : null;
    return MobileRpcProblem(code: code, message: message, retryable: retryable);
  }

  Map<String, Object?> toJson() => {
    'code': code,
    'message': message,
    'retryable': ?retryable,
  };
}

final class MobileProjectSummary {
  const MobileProjectSummary({required this.id, required this.name});
  final String id;
  final String name;

  factory MobileProjectSummary.fromJson(Map<String, dynamic> json) {
    if (json.keys.any((key) => !const {'id', 'name'}.contains(key))) {
      throw const FormatException(
        'MobileProjectSummary contains an unknown field',
      );
    }
    final id = json['id'] as String;
    if (id.isEmpty) {
      throw const FormatException('Invalid id');
    }
    final name = json['name'] as String;
    if (name.isEmpty || name.length > 512) {
      throw const FormatException('Invalid name');
    }
    return MobileProjectSummary(id: id, name: name);
  }

  Map<String, Object?> toJson() => {'id': id, 'name': name};
}

final class MobileThreadSummary {
  const MobileThreadSummary({
    required this.id,
    required this.projectId,
    required this.title,
    required this.updatedAt,
    this.readTarget,
    this.manualUnread,
    required this.archived,
    required this.pinned,
    required this.status,
    required this.unread,
  });
  final String id;
  final String projectId;
  final String title;
  final String updatedAt;
  final MobileThreadReadTarget? readTarget;
  final MobileThreadReadTarget? manualUnread;
  final bool archived;
  final bool pinned;
  final MobileThreadStatus status;
  final bool unread;

  factory MobileThreadSummary.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {
        'id',
        'projectId',
        'title',
        'updatedAt',
        'readTarget',
        'manualUnread',
        'archived',
        'pinned',
        'status',
        'unread',
      }.contains(key),
    )) {
      throw const FormatException(
        'MobileThreadSummary contains an unknown field',
      );
    }
    final id = json['id'] as String;
    if (id.isEmpty) {
      throw const FormatException('Invalid id');
    }
    final projectId = json['projectId'] as String;
    if (projectId.isEmpty) {
      throw const FormatException('Invalid projectId');
    }
    final title = json['title'] as String;
    if (title.isEmpty || title.length > 512) {
      throw const FormatException('Invalid title');
    }
    final updatedAt = json['updatedAt'] as String;
    if (!RegExp(
      '^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))\$',
    ).hasMatch(updatedAt)) {
      throw const FormatException('Invalid updatedAt');
    }
    final readTarget = json.containsKey('readTarget')
        ? MobileThreadReadTarget.fromJson(
            json['readTarget'] as Map<String, dynamic>,
          )
        : null;
    final manualUnread = json.containsKey('manualUnread')
        ? MobileThreadReadTarget.fromJson(
            json['manualUnread'] as Map<String, dynamic>,
          )
        : null;
    final archived = json['archived'] as bool;
    final pinned = json['pinned'] as bool;
    final status = MobileThreadStatus.fromWire(json['status'] as String);
    final unread = json['unread'] as bool;
    return MobileThreadSummary(
      id: id,
      projectId: projectId,
      title: title,
      updatedAt: updatedAt,
      readTarget: readTarget,
      manualUnread: manualUnread,
      archived: archived,
      pinned: pinned,
      status: status,
      unread: unread,
    );
  }

  Map<String, Object?> toJson() => {
    'id': id,
    'projectId': projectId,
    'title': title,
    'updatedAt': updatedAt,
    'readTarget': ?readTarget?.toJson(),
    'manualUnread': ?manualUnread?.toJson(),
    'archived': archived,
    'pinned': pinned,
    'status': status.wire,
    'unread': unread,
  };
}

enum MobileThreadStatus {
  idle('idle'),
  queued('queued'),
  running('running'),
  waitingApproval('waiting-approval'),
  completed('completed'),
  failed('failed'),
  interrupted('interrupted');

  const MobileThreadStatus(this.wire);
  final String wire;

  factory MobileThreadStatus.fromWire(String wire) {
    for (final value in values) {
      if (value.wire == wire) return value;
    }
    throw const FormatException('Invalid MobileThreadStatus');
  }
}

final class MobileThreadReadTarget {
  const MobileThreadReadTarget({required this.runId, required this.revision});
  final String runId;
  final int revision;

  factory MobileThreadReadTarget.fromJson(Map<String, dynamic> json) {
    if (json.keys.any((key) => !const {'runId', 'revision'}.contains(key))) {
      throw const FormatException(
        'MobileThreadReadTarget contains an unknown field',
      );
    }
    final runId = json['runId'] as String;
    if (runId.isEmpty) {
      throw const FormatException('Invalid runId');
    }
    final revision = json['revision'] as int;
    if (revision < 0 || revision > 9007199254740991) {
      throw const FormatException('Invalid revision');
    }
    return MobileThreadReadTarget(runId: runId, revision: revision);
  }

  Map<String, Object?> toJson() => {'runId': runId, 'revision': revision};
}

typedef MobileProjectList = List<MobileProjectSummary>;
MobileProjectList decodeMobileProjectList(Object? json) => List.unmodifiable(
  (json as List<dynamic>).map(
    (entry) => MobileProjectSummary.fromJson(entry as Map<String, dynamic>),
  ),
);

typedef MobileThreadList = List<MobileThreadSummary>;
MobileThreadList decodeMobileThreadList(Object? json) => List.unmodifiable(
  (json as List<dynamic>).map(
    (entry) => MobileThreadSummary.fromJson(entry as Map<String, dynamic>),
  ),
);
