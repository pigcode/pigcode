import '../host_rpc.dart';
import '../sidebar_models.dart';

abstract final class MobileAgentMethods {
  static const list = 'mobile.agent.list';
  static const detect = 'mobile.agent.detect';
  static const models = 'mobile.agent.models';
  static const setDefault = 'mobile.agent.setDefault';
  static const createInstance = 'mobile.agent.createInstance';
  static const updateInstance = 'mobile.agent.updateInstance';
  static const removeInstance = 'mobile.agent.removeInstance';
}

const mobileAgentCustomModelsKey = 'customModels';
const mobileAgentHiddenModelsKey = 'hiddenModels';

/// 解析插件声明的多语言文案（优先 zh-CN -> zh -> en -> 首个非空值）。
String? resolveMobileLocalizedText(Object? raw) {
  if (raw == null) return null;
  if (raw is String) return raw.isEmpty ? null : raw;
  if (raw is Map) {
    for (final key in const ['zh-CN', 'zh', 'zh-Hans', 'en-US', 'en']) {
      final value = raw[key];
      if (value is String && value.isNotEmpty) return value;
    }
    for (final value in raw.values) {
      if (value is String && value.isNotEmpty) return value;
    }
  }
  return null;
}

enum MobileAgentFieldType {
  text('text'),
  path('path'),
  boolean('boolean'),
  select('select'),
  env('env'),
  arguments('arguments'),
  secret('secret');

  const MobileAgentFieldType(this.wireValue);
  final String wireValue;

  static MobileAgentFieldType fromWireValue(String value) {
    for (final type in values) {
      if (type.wireValue == value) return type;
    }
    throw FormatException('Unknown agent field type: $value');
  }
}

final class MobileAgentFieldOption {
  const MobileAgentFieldOption({required this.value, required this.label});

  final String value;
  final String label;

  factory MobileAgentFieldOption.fromJson(Map<String, dynamic> json) {
    final value = json['value'];
    if (value is! String) throw const FormatException('Invalid option value');
    return MobileAgentFieldOption(
      value: value,
      label: resolveMobileLocalizedText(json['label']) ?? value,
    );
  }
}

final class MobileAgentIntegerRange {
  const MobileAgentIntegerRange({required this.min, required this.max});

  final int min;
  final int max;

  factory MobileAgentIntegerRange.fromJson(Map<String, dynamic> json) {
    final min = json['min'];
    final max = json['max'];
    if (min is! int || max is! int) {
      throw const FormatException('Invalid integerRange');
    }
    return MobileAgentIntegerRange(min: min, max: max);
  }
}

final class MobileAgentSettingField {
  const MobileAgentSettingField({
    required this.key,
    required this.type,
    required this.label,
    this.description,
    this.hidden = false,
    this.placeholder,
    this.monospace = false,
    this.integerRange,
    this.pathKind = 'file',
    this.defaultBool,
    this.defaultString,
    this.options = const [],
  });

  final String key;
  final MobileAgentFieldType type;
  final String label;
  final String? description;
  final bool hidden;
  final String? placeholder;
  final bool monospace;
  final MobileAgentIntegerRange? integerRange;
  final String pathKind;
  final bool? defaultBool;
  final String? defaultString;
  final List<MobileAgentFieldOption> options;

  factory MobileAgentSettingField.fromJson(Map<String, dynamic> json) {
    final key = json['key'];
    final typeRaw = json['type'];
    if (key is! String || key.isEmpty || typeRaw is! String) {
      throw const FormatException('Invalid setting field');
    }
    final type = MobileAgentFieldType.fromWireValue(typeRaw);
    final optionsRaw = json['options'];
    return MobileAgentSettingField(
      key: key,
      type: type,
      label: resolveMobileLocalizedText(json['label']) ?? key,
      description: resolveMobileLocalizedText(json['description']),
      hidden: json['visibility'] == 'hidden',
      placeholder: resolveMobileLocalizedText(json['placeholder']),
      monospace: json['monospace'] == true,
      integerRange: json['integerRange'] is Map<String, dynamic>
          ? MobileAgentIntegerRange.fromJson(
              json['integerRange'] as Map<String, dynamic>,
            )
          : null,
      pathKind: json['pathKind'] is String ? json['pathKind'] as String : 'file',
      defaultBool: json['default'] is bool ? json['default'] as bool : null,
      defaultString: json['default'] is String
          ? json['default'] as String
          : null,
      options: optionsRaw is List
          ? List.unmodifiable(
              optionsRaw.map(
                (item) => MobileAgentFieldOption.fromJson(
                  item as Map<String, dynamic>,
                ),
              ),
            )
          : const [],
    );
  }
}

final class MobileAgentStatus {
  const MobileAgentStatus({
    required this.installed,
    this.version,
    this.authenticated,
    this.usingCliLogin = false,
    this.credentialsConfigured = false,
    this.account,
    this.email,
    this.error,
  });

  final bool installed;
  final String? version;
  final bool? authenticated;
  final bool usingCliLogin;
  final bool credentialsConfigured;
  final String? account;
  final String? email;
  final String? error;

  factory MobileAgentStatus.fromJson(Map<String, dynamic> json) {
    final installed = json['installed'];
    if (installed is! bool) throw const FormatException('Invalid installed');
    return MobileAgentStatus(
      installed: installed,
      version: json['version'] as String?,
      authenticated: json['authenticated'] as bool?,
      usingCliLogin: json['usingCliLogin'] == true,
      credentialsConfigured: json['credentialsConfigured'] == true,
      account: json['account'] as String?,
      email: json['email'] as String?,
      error: json['error'] as String?,
    );
  }
}

final class MobileAgentInstance {
  const MobileAgentInstance({
    required this.instanceId,
    required this.agentId,
    required this.label,
    this.accentColor,
    required this.enabled,
    required this.isDefault,
    required this.values,
  });

  final String instanceId;
  final String agentId;
  final String label;
  final String? accentColor;
  final bool enabled;
  final bool isDefault;
  final Map<String, dynamic> values;

  factory MobileAgentInstance.fromJson(Map<String, dynamic> json) {
    final instanceId = json['instanceId'];
    final agentId = json['agentId'];
    final label = json['label'];
    final enabled = json['enabled'];
    final isDefault = json['isDefault'];
    final values = json['values'];
    if (instanceId is! String ||
        agentId is! String ||
        label is! String ||
        enabled is! bool ||
        isDefault is! bool ||
        values is! Map) {
      throw const FormatException('Invalid agent instance');
    }
    return MobileAgentInstance(
      instanceId: instanceId,
      agentId: agentId,
      label: label,
      accentColor: json['accentColor'] as String?,
      enabled: enabled,
      isDefault: isDefault,
      values: Map<String, dynamic>.unmodifiable(
        Map<String, dynamic>.from(values),
      ),
    );
  }
}

final class MobileAgentSummary {
  const MobileAgentSummary({
    required this.agentId,
    required this.displayName,
    this.pluginId,
    this.version,
    required this.builtin,
    required this.enabled,
    required this.registered,
    required this.requiresInstance,
    required this.acpRegistry,
    this.accountSetup = false,
    required this.secretReferences,
    required this.customModels,
    this.description,
    required this.fields,
    this.error,
    required this.instances,
  });

  final String agentId;
  final String displayName;
  final String? pluginId;
  final String? version;
  final bool builtin;
  final bool enabled;
  final bool registered;
  final bool requiresInstance;
  final bool acpRegistry;
  final bool accountSetup;
  final bool secretReferences;
  final bool customModels;
  final String? description;
  final List<MobileAgentSettingField> fields;
  final String? error;
  final List<MobileAgentInstance> instances;

  factory MobileAgentSummary.fromJson(Map<String, dynamic> json) {
    final agentId = json['agentId'];
    final displayName = json['displayName'];
    final fieldsRaw = json['fields'];
    final instancesRaw = json['instances'];
    if (agentId is! String ||
        displayName is! String ||
        fieldsRaw is! List ||
        instancesRaw is! List) {
      throw const FormatException('Invalid agent summary');
    }
    return MobileAgentSummary(
      agentId: agentId,
      displayName: displayName,
      pluginId: json['pluginId'] as String?,
      version: json['version'] as String?,
      builtin: json['builtin'] == true,
      enabled: json['enabled'] == true,
      registered: json['registered'] == true,
      requiresInstance: json['requiresInstance'] == true,
      acpRegistry: json['acpRegistry'] == true,
      accountSetup: json['accountSetup'] == true,
      secretReferences: json['secretReferences'] == true,
      customModels: json['customModels'] != false,
      description: resolveMobileLocalizedText(json['description']),
      fields: List.unmodifiable(
        fieldsRaw.map(
          (item) =>
              MobileAgentSettingField.fromJson(item as Map<String, dynamic>),
        ),
      ),
      error: json['error'] as String?,
      instances: List.unmodifiable(
        instancesRaw.map(
          (item) => MobileAgentInstance.fromJson(item as Map<String, dynamic>),
        ),
      ),
    );
  }
}

final class MobileAgentListResult {
  const MobileAgentListResult({
    this.defaultAgentId,
    this.defaultInstanceId,
    required this.agents,
  });

  final String? defaultAgentId;
  final String? defaultInstanceId;
  final List<MobileAgentSummary> agents;

  factory MobileAgentListResult.fromJson(Map<String, dynamic> json) {
    final agentsRaw = json['agents'];
    if (agentsRaw is! List) throw const FormatException('Invalid agent list');
    return MobileAgentListResult(
      defaultAgentId: json['defaultAgentId'] as String?,
      defaultInstanceId: json['defaultInstanceId'] as String?,
      agents: List.unmodifiable(
        agentsRaw.map(
          (item) => MobileAgentSummary.fromJson(item as Map<String, dynamic>),
        ),
      ),
    );
  }
}

final class MobileAgentModelItem {
  const MobileAgentModelItem({
    required this.id,
    required this.name,
    required this.isCustom,
    required this.hidden,
  });

  final String id;
  final String name;
  final bool isCustom;
  final bool hidden;

  factory MobileAgentModelItem.fromJson(Map<String, dynamic> json) {
    final id = json['id'];
    final name = json['name'];
    if (id is! String || id.isEmpty || name is! String) {
      throw const FormatException('Invalid model item');
    }
    return MobileAgentModelItem(
      id: id,
      name: name,
      isCustom: json['isCustom'] == true,
      hidden: json['hidden'] == true,
    );
  }
}

final class MobileAgentDefaultResult {
  const MobileAgentDefaultResult({
    this.defaultAgentId,
    this.defaultInstanceId,
  });

  final String? defaultAgentId;
  final String? defaultInstanceId;

  factory MobileAgentDefaultResult.fromJson(Map<String, dynamic> json) =>
      MobileAgentDefaultResult(
        defaultAgentId: json['defaultAgentId'] as String?,
        defaultInstanceId: json['defaultInstanceId'] as String?,
      );
}

class MobileAgentManageClient {
  MobileAgentManageClient(this._rpc, {required this.supportsAgentManage});

  final HostRequests _rpc;
  final bool supportsAgentManage;

  void _ensureSupported() {
    if (!supportsAgentManage) {
      throw const MobileRpcFailure(
        MobileRpcProblem(
          code: 'METHOD_NOT_AVAILABLE',
          message: '当前电脑版本不支持在手机端管理 Agent 实例，请升级电脑端 Pigcode。',
          retryable: false,
        ),
      );
    }
  }

  Future<MobileAgentListResult> list() async {
    _ensureSupported();
    final raw =
        await _rpc.call(MobileAgentMethods.list, const {})
            as Map<String, dynamic>;
    return MobileAgentListResult.fromJson(raw);
  }

  Future<Map<String, MobileAgentStatus>> detect({
    String? agentId,
    String? instanceId,
    bool? refresh,
  }) async {
    _ensureSupported();
    final raw =
        await _rpc.call(MobileAgentMethods.detect, {
              'agentId': ?agentId,
              'instanceId': ?instanceId,
              'refresh': ?refresh,
            })
            as Map<String, dynamic>;
    final map = raw['statuses'];
    if (map is! Map) throw const FormatException('Invalid detect statuses');
    return Map<String, MobileAgentStatus>.unmodifiable({
      for (final entry in map.entries)
        entry.key.toString(): MobileAgentStatus.fromJson(
          entry.value as Map<String, dynamic>,
        ),
    });
  }

  Future<List<MobileAgentModelItem>> models({
    String? agentId,
    String? instanceId,
  }) async {
    _ensureSupported();
    final raw =
        await _rpc.call(MobileAgentMethods.models, {
              'agentId': ?agentId,
              'instanceId': ?instanceId,
            })
            as Map<String, dynamic>;
    final list = raw['models'];
    if (list is! List) throw const FormatException('Invalid models list');
    return List.unmodifiable(
      list.map(
        (item) => MobileAgentModelItem.fromJson(item as Map<String, dynamic>),
      ),
    );
  }

  Future<MobileAgentDefaultResult> setDefault({
    required String? agentId,
    String? instanceId,
  }) async {
    _ensureSupported();
    final raw =
        await _rpc.call(MobileAgentMethods.setDefault, {
              'agentId': agentId,
              if (agentId != null) 'instanceId': ?instanceId,
            })
            as Map<String, dynamic>;
    return MobileAgentDefaultResult.fromJson(raw);
  }

  Future<MobileAgentInstance> createInstance({
    required String agentId,
    required String label,
    String? instanceId,
    String? accentColor,
    Map<String, Object?>? values,
    String? copyFrom,
  }) async {
    _ensureSupported();
    final raw =
        await _rpc.call(MobileAgentMethods.createInstance, {
              'agentId': agentId,
              'label': label.trim(),
              if (instanceId != null && instanceId.trim().isNotEmpty)
                'instanceId': instanceId.trim(),
              if (accentColor != null && accentColor.isNotEmpty)
                'accentColor': accentColor,
              'values': ?values,
              if (copyFrom != null && copyFrom.isNotEmpty) 'copyFrom': copyFrom,
            })
            as Map<String, dynamic>;
    return MobileAgentInstance.fromJson(
      raw['instance'] as Map<String, dynamic>,
    );
  }

  Future<MobileAgentInstance> updateInstance({
    required String instanceId,
    String? label,
    String? accentColor,
    bool clearAccentColor = false,
    bool? enabled,
    Map<String, Object?>? values,
  }) async {
    _ensureSupported();
    final patch = <String, Object?>{
      if (label != null) 'label': label.trim(),
      if (clearAccentColor)
        'accentColor': null
      else
        'accentColor': ?accentColor,
      'enabled': ?enabled,
      'values': ?values,
    };
    final raw =
        await _rpc.call(MobileAgentMethods.updateInstance, {
              'instanceId': instanceId,
              'patch': patch,
            })
            as Map<String, dynamic>;
    return MobileAgentInstance.fromJson(
      raw['instance'] as Map<String, dynamic>,
    );
  }

  Future<void> removeInstance({required String instanceId}) async {
    _ensureSupported();
    await _rpc.call(MobileAgentMethods.removeInstance, {
      'instanceId': instanceId,
    });
  }
}
