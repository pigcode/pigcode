// 由 generate-mobile-contracts.ts 从 Zod 的 JSON Schema 生成。
import 'composer_models.dart';

abstract final class MobileDraftMethods {
  static const options = 'thread.draftOptions';
  static const models = 'thread.draftModels';
  static const create = 'thread.create';
}

enum MobileDraftPermission {
  approvalRequired('approval-required'),
  autoAcceptEdits('auto-accept-edits'),
  auto('auto'),
  fullAccess('full-access');

  const MobileDraftPermission(this.wire);
  final String wire;

  factory MobileDraftPermission.fromWire(String wire) {
    for (final value in values) {
      if (value.wire == wire) return value;
    }
    throw const FormatException('Invalid MobileDraftPermission');
  }
}

final class MobileDraftModelParams {
  const MobileDraftModelParams({required this.instanceId});
  final String instanceId;

  factory MobileDraftModelParams.fromJson(Map<String, dynamic> json) {
    if (json.keys.any((key) => !const {'instanceId'}.contains(key))) {
      throw const FormatException(
        'MobileDraftModelParams contains an unknown field',
      );
    }
    final instanceId = json['instanceId'] as String;
    if (instanceId.isEmpty) {
      throw const FormatException('Invalid instanceId');
    }
    return MobileDraftModelParams(instanceId: instanceId);
  }

  Map<String, Object?> toJson() => {'instanceId': instanceId};
}

final class MobileDraftCreateParams {
  const MobileDraftCreateParams({
    required this.instanceId,
    required this.commandId,
    required this.projectId,
    this.modelId,
    required this.permissionMode,
    required this.text,
    this.effort,
    this.fast,
    this.ultracode,
    this.planMode,
    this.references,
  });
  final String instanceId;
  final String commandId;
  final String projectId;
  final String? modelId;
  final MobileDraftPermission permissionMode;
  final String text;
  final String? effort;
  final bool? fast;
  final bool? ultracode;
  final bool? planMode;
  final List<MobileThreadReference>? references;

  factory MobileDraftCreateParams.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {
        'instanceId',
        'commandId',
        'projectId',
        'modelId',
        'permissionMode',
        'text',
        'effort',
        'fast',
        'ultracode',
        'planMode',
        'references',
      }.contains(key),
    )) {
      throw const FormatException(
        'MobileDraftCreateParams contains an unknown field',
      );
    }
    final instanceId = json['instanceId'] as String;
    if (instanceId.isEmpty) {
      throw const FormatException('Invalid instanceId');
    }
    final commandId = json['commandId'] as String;
    if (!RegExp(
      '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)\$',
    ).hasMatch(commandId)) {
      throw const FormatException('Invalid commandId');
    }
    final projectId = json['projectId'] as String;
    if (projectId.isEmpty) {
      throw const FormatException('Invalid projectId');
    }
    final modelId = json['modelId'] as String?;
    if (modelId != null && (modelId.isEmpty)) {
      throw const FormatException('Invalid modelId');
    }
    final permissionMode = MobileDraftPermission.fromWire(
      json['permissionMode'] as String,
    );
    final text = json['text'] as String;
    if (text.isEmpty || text.length > 10000 || !RegExp('\\S').hasMatch(text)) {
      throw const FormatException('Invalid text');
    }
    final rawEffort = json['effort'] as String?;
    final effort = rawEffort?.trim();
    if (effort != null && (effort.isEmpty || effort.length > 64)) {
      throw const FormatException('Invalid effort');
    }
    final fast = json['fast'] as bool?;
    final ultracode = json['ultracode'] as bool?;
    final planMode = json['planMode'] as bool?;
    final rawReferences = json['references'];
    final references = rawReferences == null
        ? null
        : List<MobileThreadReference>.unmodifiable(
            (rawReferences as List<dynamic>).map(
              (item) =>
                  MobileThreadReference.fromJson(item as Map<String, dynamic>),
            ),
          );
    if (references != null && references.length > 10) {
      throw const FormatException('Invalid references');
    }
    return MobileDraftCreateParams(
      instanceId: instanceId,
      commandId: commandId,
      projectId: projectId,
      modelId: modelId,
      permissionMode: permissionMode,
      text: text,
      effort: effort,
      fast: fast,
      ultracode: ultracode,
      planMode: planMode,
      references: references,
    );
  }

  Map<String, Object?> toJson() => {
    'instanceId': instanceId,
    'commandId': commandId,
    'projectId': projectId,
    'modelId': ?modelId,
    'permissionMode': permissionMode.wire,
    'text': text,
    'effort': ?effort,
    'fast': ?fast,
    'ultracode': ?ultracode,
    'planMode': ?planMode,
    'references': ?references?.map((item) => item.toJson()).toList(),
  };
}

final class MobileDraftInstance {
  const MobileDraftInstance({
    required this.instanceId,
    required this.label,
    required this.agentName,
    required this.permissionModes,
    required this.defaultPermissionMode,
    this.agentId,
    this.accentColor,
    this.supportsPlanMode,
  });
  final String instanceId;
  final String label;
  final String agentName;
  final List<MobileDraftPermission> permissionModes;
  final MobileDraftPermission defaultPermissionMode;
  final String? agentId;
  final String? accentColor;
  final bool? supportsPlanMode;

  factory MobileDraftInstance.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {
        'instanceId',
        'label',
        'agentName',
        'permissionModes',
        'defaultPermissionMode',
        'agentId',
        'accentColor',
        'supportsPlanMode',
      }.contains(key),
    )) {
      throw const FormatException(
        'MobileDraftInstance contains an unknown field',
      );
    }
    final instanceId = json['instanceId'] as String;
    if (instanceId.isEmpty) {
      throw const FormatException('Invalid instanceId');
    }
    final label = json['label'] as String;
    if (label.isEmpty) {
      throw const FormatException('Invalid label');
    }
    final agentName = json['agentName'] as String;
    if (agentName.isEmpty) {
      throw const FormatException('Invalid agentName');
    }
    final permissionModes = List<MobileDraftPermission>.unmodifiable(
      (json['permissionModes'] as List<dynamic>).map(
        (item) => MobileDraftPermission.fromWire(item as String),
      ),
    );
    final defaultPermissionMode = MobileDraftPermission.fromWire(
      json['defaultPermissionMode'] as String,
    );
    final agentId = json['agentId'] as String?;
    if (agentId != null && agentId.isEmpty) {
      throw const FormatException('Invalid agentId');
    }
    final accentColor = json['accentColor'] as String?;
    if (accentColor != null &&
        !RegExp(r'^#[\da-fA-F]{6}$').hasMatch(accentColor)) {
      throw const FormatException('Invalid accentColor');
    }
    final supportsPlanMode = json['supportsPlanMode'] as bool?;
    return MobileDraftInstance(
      instanceId: instanceId,
      label: label,
      agentName: agentName,
      permissionModes: permissionModes,
      defaultPermissionMode: defaultPermissionMode,
      agentId: agentId,
      accentColor: accentColor,
      supportsPlanMode: supportsPlanMode,
    );
  }

  Map<String, Object?> toJson() => {
    'instanceId': instanceId,
    'label': label,
    'agentName': agentName,
    'permissionModes': permissionModes.map((item) => item.wire).toList(),
    'defaultPermissionMode': defaultPermissionMode.wire,
    'agentId': ?agentId,
    'accentColor': ?accentColor,
    'supportsPlanMode': ?supportsPlanMode,
  };
}

final class MobileDraftOptions {
  const MobileDraftOptions({required this.instances, this.defaultInstanceId});
  final List<MobileDraftInstance> instances;
  final String? defaultInstanceId;

  factory MobileDraftOptions.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {'instances', 'defaultInstanceId'}.contains(key),
    )) {
      throw const FormatException(
        'MobileDraftOptions contains an unknown field',
      );
    }
    final instances = List<MobileDraftInstance>.unmodifiable(
      (json['instances'] as List<dynamic>).map(
        (item) => MobileDraftInstance.fromJson(item as Map<String, dynamic>),
      ),
    );
    final defaultInstanceId = json.containsKey('defaultInstanceId')
        ? json['defaultInstanceId'] as String
        : null;
    if (defaultInstanceId != null && (defaultInstanceId.isEmpty)) {
      throw const FormatException('Invalid defaultInstanceId');
    }
    return MobileDraftOptions(
      instances: instances,
      defaultInstanceId: defaultInstanceId,
    );
  }

  Map<String, Object?> toJson() => {
    'instances': instances.map((item) => item.toJson()).toList(),
    'defaultInstanceId': ?defaultInstanceId,
  };
}

final class MobileDraftModel {
  const MobileDraftModel({
    required this.id,
    required this.label,
    this.efforts,
    this.fast,
    this.ultracode,
  });
  final String id;
  final String label;
  final List<String>? efforts;
  final bool? fast;
  final bool? ultracode;

  factory MobileDraftModel.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {
        'id',
        'label',
        'efforts',
        'fast',
        'ultracode',
      }.contains(key),
    )) {
      throw const FormatException('MobileDraftModel contains an unknown field');
    }
    final id = json['id'] as String;
    if (id.isEmpty) {
      throw const FormatException('Invalid id');
    }
    final label = json['label'] as String;
    if (label.isEmpty) {
      throw const FormatException('Invalid label');
    }
    final rawEfforts = json['efforts'];
    final efforts = rawEfforts == null
        ? null
        : List<String>.unmodifiable(
            (rawEfforts as List<dynamic>).map((item) {
              final value = (item as String).trim();
              if (value.isEmpty || value.length > 64) {
                throw const FormatException('Invalid efforts');
              }
              return value;
            }),
          );
    final fast = json['fast'] as bool?;
    final ultracode = json['ultracode'] as bool?;
    return MobileDraftModel(
      id: id,
      label: label,
      efforts: efforts,
      fast: fast,
      ultracode: ultracode,
    );
  }

  Map<String, Object?> toJson() => {
    'id': id,
    'label': label,
    'efforts': ?efforts?.toList(),
    'fast': ?fast,
    'ultracode': ?ultracode,
  };
}

final class MobileDraftModels {
  const MobileDraftModels({required this.models, this.defaultModelId});
  final List<MobileDraftModel> models;
  final String? defaultModelId;

  factory MobileDraftModels.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {'models', 'defaultModelId'}.contains(key),
    )) {
      throw const FormatException(
        'MobileDraftModels contains an unknown field',
      );
    }
    final models = List<MobileDraftModel>.unmodifiable(
      (json['models'] as List<dynamic>).map(
        (item) => MobileDraftModel.fromJson(item as Map<String, dynamic>),
      ),
    );
    final defaultModelId = json.containsKey('defaultModelId')
        ? json['defaultModelId'] as String
        : null;
    if (defaultModelId != null && (defaultModelId.isEmpty)) {
      throw const FormatException('Invalid defaultModelId');
    }
    return MobileDraftModels(models: models, defaultModelId: defaultModelId);
  }

  Map<String, Object?> toJson() => {
    'models': models.map((item) => item.toJson()).toList(),
    'defaultModelId': ?defaultModelId,
  };
}

final class MobileDraftReceipt {
  const MobileDraftReceipt({
    required this.method,
    required this.commandId,
    required this.projectId,
    required this.threadId,
    required this.title,
    required this.runId,
  });
  final String method;
  final String commandId;
  final String projectId;
  final String threadId;
  final String title;
  final String runId;

  factory MobileDraftReceipt.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {
        'method',
        'commandId',
        'projectId',
        'threadId',
        'title',
        'runId',
      }.contains(key),
    )) {
      throw const FormatException(
        'MobileDraftReceipt contains an unknown field',
      );
    }
    final method = json['method'] as String;
    final commandId = json['commandId'] as String;
    if (!RegExp(
      '^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)\$',
    ).hasMatch(commandId)) {
      throw const FormatException('Invalid commandId');
    }
    final projectId = json['projectId'] as String;
    if (projectId.isEmpty) {
      throw const FormatException('Invalid projectId');
    }
    final threadId = json['threadId'] as String;
    if (threadId.isEmpty) {
      throw const FormatException('Invalid threadId');
    }
    final title = json['title'] as String;
    if (title.isEmpty) {
      throw const FormatException('Invalid title');
    }
    final runId = json['runId'] as String;
    if (runId.isEmpty) {
      throw const FormatException('Invalid runId');
    }
    return MobileDraftReceipt(
      method: method,
      commandId: commandId,
      projectId: projectId,
      threadId: threadId,
      title: title,
      runId: runId,
    );
  }

  Map<String, Object?> toJson() => {
    'method': method,
    'commandId': commandId,
    'projectId': projectId,
    'threadId': threadId,
    'title': title,
    'runId': runId,
  };
}

final class MobileDraftReceiptResult {
  const MobileDraftReceiptResult({this.receipt});
  final MobileDraftReceipt? receipt;

  factory MobileDraftReceiptResult.fromJson(Map<String, dynamic> json) {
    if (json.keys.any((key) => !const {'receipt'}.contains(key))) {
      throw const FormatException(
        'MobileDraftReceiptResult contains an unknown field',
      );
    }
    final receipt = json.containsKey('receipt')
        ? MobileDraftReceipt.fromJson(json['receipt'] as Map<String, dynamic>)
        : null;
    return MobileDraftReceiptResult(receipt: receipt);
  }

  Map<String, Object?> toJson() => {'receipt': ?receipt?.toJson()};
}
