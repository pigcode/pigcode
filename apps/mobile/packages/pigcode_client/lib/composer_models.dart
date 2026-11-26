import 'draft_models.dart';

abstract final class MobileComposerMethods {
  static const switchAgent = 'thread.switchAgent';
  static const setPermissionMode = 'thread.setPermissionMode';
  static const setPlanMode = 'thread.setPlanMode';
  static const composerChanged = 'thread.composer';
}

final class MobileContextUsage {
  const MobileContextUsage({
    required this.usedTokens,
    this.maxTokens,
    this.autoCompactTokens,
  });

  final int usedTokens;
  final int? maxTokens;
  final int? autoCompactTokens;

  factory MobileContextUsage.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) =>
          !const {'usedTokens', 'maxTokens', 'autoCompactTokens'}.contains(key),
    )) {
      throw const FormatException(
        'MobileContextUsage contains an unknown field',
      );
    }
    final usedTokens = json['usedTokens'] as int;
    if (usedTokens < 0 || usedTokens > 9007199254740991) {
      throw const FormatException('Invalid usedTokens');
    }
    final maxTokens = json['maxTokens'] as int?;
    if (maxTokens != null && (maxTokens < 0 || maxTokens > 9007199254740991)) {
      throw const FormatException('Invalid maxTokens');
    }
    final autoCompactTokens = json['autoCompactTokens'] as int?;
    if (autoCompactTokens != null &&
        (autoCompactTokens < 0 || autoCompactTokens > 9007199254740991)) {
      throw const FormatException('Invalid autoCompactTokens');
    }
    return MobileContextUsage(
      usedTokens: usedTokens,
      maxTokens: maxTokens,
      autoCompactTokens: autoCompactTokens,
    );
  }

  Map<String, Object?> toJson() => {
    'usedTokens': usedTokens,
    'maxTokens': ?maxTokens,
    'autoCompactTokens': ?autoCompactTokens,
  };
}

final class MobileThreadComposerState {
  const MobileThreadComposerState({
    required this.instanceId,
    required this.agentId,
    this.modelId,
    required this.permissionMode,
    required this.planMode,
    required this.supportsPlanMode,
    this._supportsImages,
    this.contextUsage,
  });

  final String instanceId;
  final String agentId;
  final String? modelId;
  final MobileDraftPermission permissionMode;
  final bool planMode;
  final bool supportsPlanMode;
  final bool? _supportsImages;
  final MobileContextUsage? contextUsage;

  /// 旧电脑未下发该字段时默认按支持原生看图处理，避免误提示降级。
  bool get supportsImages => _supportsImages ?? true;

  factory MobileThreadComposerState.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {
        'instanceId',
        'agentId',
        'modelId',
        'permissionMode',
        'planMode',
        'supportsPlanMode',
        'supportsImages',
        'contextUsage',
      }.contains(key),
    )) {
      throw const FormatException(
        'MobileThreadComposerState contains an unknown field',
      );
    }
    final instanceId = json['instanceId'] as String;
    if (instanceId.isEmpty) {
      throw const FormatException('Invalid instanceId');
    }
    final agentId = json['agentId'] as String;
    if (agentId.isEmpty) {
      throw const FormatException('Invalid agentId');
    }
    final modelId = json['modelId'] as String?;
    if (modelId != null && modelId.isEmpty) {
      throw const FormatException('Invalid modelId');
    }
    final permissionMode = MobileDraftPermission.fromWire(
      json['permissionMode'] as String,
    );
    final planMode = json['planMode'] as bool;
    final supportsPlanMode = json['supportsPlanMode'] as bool;
    final supportsImages = json['supportsImages'] as bool?;
    final rawUsage = json['contextUsage'];
    final contextUsage = rawUsage == null
        ? null
        : MobileContextUsage.fromJson(rawUsage as Map<String, dynamic>);
    return MobileThreadComposerState(
      instanceId: instanceId,
      agentId: agentId,
      modelId: modelId,
      permissionMode: permissionMode,
      planMode: planMode,
      supportsPlanMode: supportsPlanMode,
      supportsImages: supportsImages,
      contextUsage: contextUsage,
    );
  }

  Map<String, Object?> toJson() => {
    'instanceId': instanceId,
    'agentId': agentId,
    'modelId': ?modelId,
    'permissionMode': permissionMode.wire,
    'planMode': planMode,
    'supportsPlanMode': supportsPlanMode,
    'supportsImages': ?_supportsImages,
    'contextUsage': ?contextUsage?.toJson(),
  };
}

final class MobileThreadReference {
  const MobileThreadReference({
    this.kind = 'thread',
    required this.threadId,
    required this.title,
  });

  final String kind;
  final String threadId;
  final String title;

  factory MobileThreadReference.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {'kind', 'threadId', 'title'}.contains(key),
    )) {
      throw const FormatException(
        'MobileThreadReference contains an unknown field',
      );
    }
    final kind = json['kind'] as String;
    if (kind != 'thread') {
      throw const FormatException('Invalid kind');
    }
    final threadId = json['threadId'] as String;
    if (threadId.isEmpty) {
      throw const FormatException('Invalid threadId');
    }
    final title = json['title'] as String;
    if (title.isEmpty || title.length > 512) {
      throw const FormatException('Invalid title');
    }
    return MobileThreadReference(kind: kind, threadId: threadId, title: title);
  }

  Map<String, Object?> toJson() => {
    'kind': kind,
    'threadId': threadId,
    'title': title,
  };
}

final class MobileSwitchAgentParams {
  const MobileSwitchAgentParams({
    required this.threadId,
    required this.instanceId,
    this.modelId,
  });

  final String threadId;
  final String instanceId;
  final String? modelId;

  factory MobileSwitchAgentParams.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {'threadId', 'instanceId', 'modelId'}.contains(key),
    )) {
      throw const FormatException(
        'MobileSwitchAgentParams contains an unknown field',
      );
    }
    final threadId = json['threadId'] as String;
    if (threadId.isEmpty) {
      throw const FormatException('Invalid threadId');
    }
    final instanceId = json['instanceId'] as String;
    if (instanceId.isEmpty) {
      throw const FormatException('Invalid instanceId');
    }
    final modelId = json['modelId'] as String?;
    if (modelId != null && modelId.isEmpty) {
      throw const FormatException('Invalid modelId');
    }
    return MobileSwitchAgentParams(
      threadId: threadId,
      instanceId: instanceId,
      modelId: modelId,
    );
  }

  Map<String, Object?> toJson() => {
    'threadId': threadId,
    'instanceId': instanceId,
    'modelId': ?modelId,
  };
}

final class MobileSetPermissionModeParams {
  const MobileSetPermissionModeParams({
    required this.threadId,
    required this.permissionMode,
  });

  final String threadId;
  final MobileDraftPermission permissionMode;

  factory MobileSetPermissionModeParams.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {'threadId', 'permissionMode'}.contains(key),
    )) {
      throw const FormatException(
        'MobileSetPermissionModeParams contains an unknown field',
      );
    }
    final threadId = json['threadId'] as String;
    if (threadId.isEmpty) {
      throw const FormatException('Invalid threadId');
    }
    final permissionMode = MobileDraftPermission.fromWire(
      json['permissionMode'] as String,
    );
    return MobileSetPermissionModeParams(
      threadId: threadId,
      permissionMode: permissionMode,
    );
  }

  Map<String, Object?> toJson() => {
    'threadId': threadId,
    'permissionMode': permissionMode.wire,
  };
}

final class MobileSetPlanModeParams {
  const MobileSetPlanModeParams({
    required this.threadId,
    required this.planMode,
  });

  final String threadId;
  final bool planMode;

  factory MobileSetPlanModeParams.fromJson(Map<String, dynamic> json) {
    if (json.keys.any((key) => !const {'threadId', 'planMode'}.contains(key))) {
      throw const FormatException(
        'MobileSetPlanModeParams contains an unknown field',
      );
    }
    final threadId = json['threadId'] as String;
    if (threadId.isEmpty) {
      throw const FormatException('Invalid threadId');
    }
    final planMode = json['planMode'] as bool;
    return MobileSetPlanModeParams(threadId: threadId, planMode: planMode);
  }

  Map<String, Object?> toJson() => {'threadId': threadId, 'planMode': planMode};
}

final class MobileComposerChangedNotice {
  const MobileComposerChangedNotice({
    required this.threadId,
    required this.composer,
  });

  final String threadId;
  final MobileThreadComposerState composer;

  factory MobileComposerChangedNotice.fromJson(Map<String, dynamic> json) {
    if (json.keys.any((key) => !const {'threadId', 'composer'}.contains(key))) {
      throw const FormatException(
        'MobileComposerChangedNotice contains an unknown field',
      );
    }
    final threadId = json['threadId'] as String;
    if (threadId.isEmpty) {
      throw const FormatException('Invalid threadId');
    }
    final composer = MobileThreadComposerState.fromJson(
      json['composer'] as Map<String, dynamic>,
    );
    return MobileComposerChangedNotice(threadId: threadId, composer: composer);
  }

  Map<String, Object?> toJson() => {
    'threadId': threadId,
    'composer': composer.toJson(),
  };
}
