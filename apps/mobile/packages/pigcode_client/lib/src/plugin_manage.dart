import '../host_rpc.dart';
import '../sidebar_models.dart';

abstract final class MobilePluginMethods {
  static const list = 'mobile.plugin.list';
  static const setEnabled = 'mobile.plugin.setEnabled';
  static const update = 'mobile.plugin.update';
  static const uninstall = 'mobile.plugin.uninstall';
  static const marketplaces = 'mobile.plugin.marketplaces';
  static const refreshMarketplaces = 'mobile.plugin.refreshMarketplaces';
  static const installFromMarketplace = 'mobile.plugin.installFromMarketplace';
}

String _reqString(Object? raw, String field) {
  if (raw is! String || raw.isEmpty) {
    throw FormatException('Invalid $field');
  }
  return raw;
}

String _str(Object? raw, String field) {
  if (raw is! String) throw FormatException('Invalid $field');
  return raw;
}

bool _reqBool(Object? raw, String field) {
  if (raw is! bool) throw FormatException('Invalid $field');
  return raw;
}

int _nonNegInt(Object? raw, String field) {
  if (raw is! int || raw < 0) throw FormatException('Invalid $field');
  return raw;
}

List<String> _stringList(Object? raw, String field) {
  if (raw is! List) throw FormatException('Invalid $field');
  return List<String>.unmodifiable(raw.map((item) => _str(item, field)));
}

Map<String, String>? _optionalStringMap(Object? raw, String field) {
  if (raw == null) return null;
  if (raw is! Map) throw FormatException('Invalid $field');
  final map = <String, String>{};
  for (final entry in raw.entries) {
    final value = entry.value;
    if (value is String && value.isNotEmpty) {
      map[entry.key.toString()] = value;
    }
  }
  return map.isEmpty ? null : Map<String, String>.unmodifiable(map);
}

String? _pickLocalized(Map<String, String>? i18n, String? fallback) {
  if (i18n != null) {
    for (final key in const ['zh-CN', 'zh', 'zh-Hans', 'en-US', 'en']) {
      final value = i18n[key];
      if (value != null && value.trim().isNotEmpty) return value.trim();
    }
  }
  if (fallback != null && fallback.trim().isNotEmpty) return fallback.trim();
  if (i18n != null) {
    for (final value in i18n.values) {
      if (value.trim().isNotEmpty) return value.trim();
    }
  }
  return null;
}

enum MobilePluginKind {
  agent('agent'),
  capability('capability'),
  ui('ui'),
  bundle('bundle');

  const MobilePluginKind(this.wireValue);
  final String wireValue;

  static MobilePluginKind fromWireValue(String value) {
    for (final kind in values) {
      if (kind.wireValue == value) return kind;
    }
    throw FormatException('Unknown plugin kind: $value');
  }
}

enum MobilePluginOriginKind {
  builtin('builtin'),
  marketplace('marketplace'),
  npm('npm'),
  github('github'),
  git('git'),
  url('url'),
  local('local');

  const MobilePluginOriginKind(this.wireValue);
  final String wireValue;

  static MobilePluginOriginKind fromWireValue(String value) {
    for (final kind in values) {
      if (kind.wireValue == value) return kind;
    }
    throw FormatException('Unknown plugin origin kind: $value');
  }
}

enum MobileMarketplaceSourceType {
  github('github'),
  git('git'),
  url('url'),
  directory('directory'),
  file('file');

  const MobileMarketplaceSourceType(this.wireValue);
  final String wireValue;

  static MobileMarketplaceSourceType fromWireValue(String value) {
    for (final type in values) {
      if (type.wireValue == value) return type;
    }
    throw FormatException('Unknown marketplace source type: $value');
  }
}

enum MobileMarketplacePublisherType {
  official('official'),
  community('community');

  const MobileMarketplacePublisherType(this.wireValue);
  final String wireValue;

  static MobileMarketplacePublisherType fromWireValue(String value) {
    for (final type in values) {
      if (type.wireValue == value) return type;
    }
    throw FormatException('Unknown publisher type: $value');
  }
}

final class MobilePluginSummary {
  const MobilePluginSummary({
    required this.id,
    required this.name,
    required this.displayName,
    this.description,
    required this.version,
    required this.kind,
    required this.enabled,
    required this.builtin,
    required this.apiVersion,
    required this.permissions,
    required this.provides,
    this.conflict,
    this.error,
    this.originKind,
    this.marketplaceId,
    this.marketplacePluginName,
    this.originLabel,
    required this.canUpdate,
  });

  final String id;
  final String name;
  final String displayName;
  final String? description;
  final String version;
  final MobilePluginKind kind;
  final bool enabled;
  final bool builtin;
  final int apiVersion;
  final List<String> permissions;
  final List<String> provides;
  final String? conflict;
  final String? error;
  final MobilePluginOriginKind? originKind;
  final String? marketplaceId;
  final String? marketplacePluginName;
  final String? originLabel;
  final bool canUpdate;

  factory MobilePluginSummary.fromJson(Map<String, dynamic> json) {
    final originKindRaw = json['originKind'];
    return MobilePluginSummary(
      id: _reqString(json['id'], 'id'),
      name: _reqString(json['name'], 'name'),
      displayName: _reqString(json['displayName'], 'displayName'),
      description: json['description'] as String?,
      version: _str(json['version'], 'version'),
      kind: MobilePluginKind.fromWireValue(_reqString(json['kind'], 'kind')),
      enabled: _reqBool(json['enabled'], 'enabled'),
      builtin: _reqBool(json['builtin'], 'builtin'),
      apiVersion: _nonNegInt(json['apiVersion'], 'apiVersion'),
      permissions: _stringList(json['permissions'], 'permissions'),
      provides: _stringList(json['provides'], 'provides'),
      conflict: json['conflict'] as String?,
      error: json['error'] as String?,
      originKind: originKindRaw is String
          ? MobilePluginOriginKind.fromWireValue(originKindRaw)
          : null,
      marketplaceId: json['marketplaceId'] as String?,
      marketplacePluginName: json['marketplacePluginName'] as String?,
      originLabel: json['originLabel'] as String?,
      canUpdate: _reqBool(json['canUpdate'], 'canUpdate'),
    );
  }

  Map<String, Object?> toJson() => {
    'id': id,
    'name': name,
    'displayName': displayName,
    'description': description,
    'version': version,
    'kind': kind.wireValue,
    'enabled': enabled,
    'builtin': builtin,
    'apiVersion': apiVersion,
    'permissions': permissions.toList(growable: false),
    'provides': provides.toList(growable: false),
    'conflict': conflict,
    'error': error,
    'originKind': originKind?.wireValue,
    'marketplaceId': marketplaceId,
    'marketplacePluginName': marketplacePluginName,
    'originLabel': originLabel,
    'canUpdate': canUpdate,
  };
}

final class MobilePluginListResult {
  const MobilePluginListResult({
    required this.plugins,
    required this.truncated,
  });

  final List<MobilePluginSummary> plugins;
  final bool truncated;

  factory MobilePluginListResult.fromJson(Map<String, dynamic> json) {
    final list = json['plugins'];
    if (list is! List) throw const FormatException('Invalid plugins list');
    return MobilePluginListResult(
      plugins: List<MobilePluginSummary>.unmodifiable(
        list.map(
          (item) => MobilePluginSummary.fromJson(item as Map<String, dynamic>),
        ),
      ),
      truncated: _reqBool(json['truncated'], 'truncated'),
    );
  }

  Map<String, Object?> toJson() => {
    'plugins': plugins.map((item) => item.toJson()).toList(growable: false),
    'truncated': truncated,
  };
}

final class MobileMarketplacePlugin {
  const MobileMarketplacePlugin({
    required this.name,
    this.displayName,
    this.description,
    this.version,
    this.category,
    this.iconUrl,
    this.homepage,
    this.author,
    this.publisherType,
    this.displayNameI18n,
    this.descriptionI18n,
    required this.sourceLabel,
  });

  final String name;
  final String? displayName;
  final String? description;
  final String? version;
  final String? category;
  final String? iconUrl;
  final String? homepage;
  final String? author;
  final MobileMarketplacePublisherType? publisherType;
  final Map<String, String>? displayNameI18n;
  final Map<String, String>? descriptionI18n;
  final String sourceLabel;

  /// 优先 zh-CN -> zh -> en -> displayName -> name。
  String get localizedDisplayName =>
      _pickLocalized(displayNameI18n, displayName) ?? name;

  /// 优先 zh-CN -> zh -> en -> description。
  String? get localizedDescription =>
      _pickLocalized(descriptionI18n, description);

  factory MobileMarketplacePlugin.fromJson(Map<String, dynamic> json) {
    final publisherRaw = json['publisherType'];
    return MobileMarketplacePlugin(
      name: _reqString(json['name'], 'name'),
      displayName: json['displayName'] as String?,
      description: json['description'] as String?,
      version: json['version'] as String?,
      category: json['category'] as String?,
      iconUrl: json['iconUrl'] as String?,
      homepage: json['homepage'] as String?,
      author: json['author'] as String?,
      publisherType: publisherRaw is String
          ? MobileMarketplacePublisherType.fromWireValue(publisherRaw)
          : null,
      displayNameI18n: _optionalStringMap(
        json['displayNameI18n'],
        'displayNameI18n',
      ),
      descriptionI18n: _optionalStringMap(
        json['descriptionI18n'],
        'descriptionI18n',
      ),
      sourceLabel: _str(json['sourceLabel'], 'sourceLabel'),
    );
  }

  Map<String, Object?> toJson() => {
    'name': name,
    'displayName': displayName,
    'description': description,
    'version': version,
    'category': category,
    'iconUrl': iconUrl,
    'homepage': homepage,
    'author': author,
    'publisherType': publisherType?.wireValue,
    'displayNameI18n': ?displayNameI18n,
    'descriptionI18n': ?descriptionI18n,
    'sourceLabel': sourceLabel,
  };
}

final class MobileMarketplaceSummary {
  const MobileMarketplaceSummary({
    required this.id,
    required this.official,
    required this.displayName,
    this.description,
    this.owner,
    required this.sourceType,
    required this.sourceLabel,
    this.sourceUrl,
    required this.enabled,
    this.lastUpdated,
    this.error,
    required this.plugins,
  });

  final String id;
  final bool official;
  final String displayName;
  final String? description;
  final String? owner;
  final MobileMarketplaceSourceType sourceType;
  final String sourceLabel;
  final String? sourceUrl;
  final bool enabled;
  final String? lastUpdated;
  final String? error;
  final List<MobileMarketplacePlugin> plugins;

  factory MobileMarketplaceSummary.fromJson(Map<String, dynamic> json) {
    final list = json['plugins'];
    if (list is! List) {
      throw const FormatException('Invalid marketplace plugins');
    }
    return MobileMarketplaceSummary(
      id: _reqString(json['id'], 'id'),
      official: _reqBool(json['official'], 'official'),
      displayName: _reqString(json['displayName'], 'displayName'),
      description: json['description'] as String?,
      owner: json['owner'] as String?,
      sourceType: MobileMarketplaceSourceType.fromWireValue(
        _reqString(json['sourceType'], 'sourceType'),
      ),
      sourceLabel: _str(json['sourceLabel'], 'sourceLabel'),
      sourceUrl: json['sourceUrl'] as String?,
      enabled: _reqBool(json['enabled'], 'enabled'),
      lastUpdated: json['lastUpdated'] as String?,
      error: json['error'] as String?,
      plugins: List<MobileMarketplacePlugin>.unmodifiable(
        list.map(
          (item) =>
              MobileMarketplacePlugin.fromJson(item as Map<String, dynamic>),
        ),
      ),
    );
  }

  Map<String, Object?> toJson() => {
    'id': id,
    'official': official,
    'displayName': displayName,
    'description': description,
    'owner': owner,
    'sourceType': sourceType.wireValue,
    'sourceLabel': sourceLabel,
    'sourceUrl': sourceUrl,
    'enabled': enabled,
    'lastUpdated': lastUpdated,
    'error': error,
    'plugins': plugins.map((item) => item.toJson()).toList(growable: false),
  };
}

final class MobileMarketplaceListResult {
  const MobileMarketplaceListResult({
    required this.marketplaces,
    required this.truncated,
  });

  final List<MobileMarketplaceSummary> marketplaces;
  final bool truncated;

  factory MobileMarketplaceListResult.fromJson(Map<String, dynamic> json) {
    final list = json['marketplaces'];
    if (list is! List) throw const FormatException('Invalid marketplaces list');
    return MobileMarketplaceListResult(
      marketplaces: List<MobileMarketplaceSummary>.unmodifiable(
        list.map(
          (item) =>
              MobileMarketplaceSummary.fromJson(item as Map<String, dynamic>),
        ),
      ),
      truncated: _reqBool(json['truncated'], 'truncated'),
    );
  }

  Map<String, Object?> toJson() => {
    'marketplaces': marketplaces
        .map((item) => item.toJson())
        .toList(growable: false),
    'truncated': truncated,
  };
}

final _semverRegex = RegExp(r'^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?');

({List<int> numbers, String pre})? _parseSemver(String raw) {
  final match = _semverRegex.firstMatch(raw.trim());
  if (match == null) return null;
  final numbers = match
      .group(1)!
      .split('.')
      .map(int.parse)
      .toList(growable: false);
  return (numbers: numbers, pre: match.group(2) ?? '');
}

/// 比较两个语义化版本号：a > b 返回正数，相等返回 0，a < b 返回负数。
int compareSemver(String a, String b) {
  final left = _parseSemver(a);
  final right = _parseSemver(b);
  if (left == null || right == null) return a.trim().compareTo(b.trim());
  final maxLen = left.numbers.length > right.numbers.length
      ? left.numbers.length
      : right.numbers.length;
  for (var i = 0; i < maxLen; i += 1) {
    final l = i < left.numbers.length ? left.numbers[i] : 0;
    final r = i < right.numbers.length ? right.numbers[i] : 0;
    if (l != r) return l.compareTo(r);
  }
  if (left.pre == right.pre) return 0;
  if (left.pre.isEmpty) return 1;
  if (right.pre.isEmpty) return -1;
  return left.pre.compareTo(right.pre);
}

/// 判断已安装插件相对目标市场条目是否存在可用更新。
bool hasPluginUpdate(
  MobilePluginSummary installed,
  MobileMarketplaceSummary marketplace,
  MobileMarketplacePlugin entry,
) {
  if (installed.builtin || !installed.canUpdate) return false;
  if (installed.originKind != MobilePluginOriginKind.marketplace) return false;
  if (installed.marketplaceId != marketplace.id) return false;
  if (installed.marketplacePluginName != null &&
      installed.marketplacePluginName != entry.name) {
    return false;
  }
  final candidate = entry.version?.trim();
  if (candidate == null || candidate.isEmpty) return false;
  final parsedCandidate = _parseSemver(candidate);
  final parsedInstalled = _parseSemver(installed.version);
  if (parsedCandidate == null || parsedInstalled == null) {
    return candidate != installed.version.trim();
  }
  return compareSemver(candidate, installed.version) > 0;
}

class MobilePluginManageClient {
  MobilePluginManageClient(this._rpc, {required this.supportsPluginManage});

  final HostRequests _rpc;
  final bool supportsPluginManage;

  void _ensureSupported() {
    if (!supportsPluginManage) {
      throw const MobileRpcFailure(
        MobileRpcProblem(
          code: 'METHOD_NOT_AVAILABLE',
          message: '当前电脑版本不支持在手机端管理插件，请升级电脑端 Pigcode。',
          retryable: false,
        ),
      );
    }
  }

  Future<MobilePluginListResult> list() async {
    _ensureSupported();
    final raw =
        await _rpc.call(MobilePluginMethods.list, const {})
            as Map<String, dynamic>;
    return MobilePluginListResult.fromJson(raw);
  }

  Future<MobilePluginSummary> setEnabled({
    required String id,
    required bool enabled,
  }) async {
    _ensureSupported();
    final raw =
        await _rpc.call(MobilePluginMethods.setEnabled, {
              'id': id,
              'enabled': enabled,
            })
            as Map<String, dynamic>;
    return MobilePluginSummary.fromJson(raw['plugin'] as Map<String, dynamic>);
  }

  Future<MobilePluginSummary> update({required String id}) async {
    _ensureSupported();
    final raw =
        await _rpc.call(MobilePluginMethods.update, {'id': id})
            as Map<String, dynamic>;
    return MobilePluginSummary.fromJson(raw['plugin'] as Map<String, dynamic>);
  }

  Future<void> uninstall({required String id}) async {
    _ensureSupported();
    await _rpc.call(MobilePluginMethods.uninstall, {'id': id});
  }

  Future<MobileMarketplaceListResult> marketplaces() async {
    _ensureSupported();
    final raw =
        await _rpc.call(MobilePluginMethods.marketplaces, const {})
            as Map<String, dynamic>;
    return MobileMarketplaceListResult.fromJson(raw);
  }

  Future<MobileMarketplaceListResult> refreshMarketplaces({
    String? id,
    bool? ifStale,
  }) async {
    _ensureSupported();
    final raw =
        await _rpc.call(MobilePluginMethods.refreshMarketplaces, {
              if (id != null && id.isNotEmpty) 'id': id,
              'ifStale': ?ifStale,
            })
            as Map<String, dynamic>;
    return MobileMarketplaceListResult.fromJson(raw);
  }

  Future<MobilePluginSummary> installFromMarketplace({
    required String marketplace,
    required String name,
  }) async {
    _ensureSupported();
    final raw =
        await _rpc.call(MobilePluginMethods.installFromMarketplace, {
              'marketplace': marketplace,
              'name': name,
            })
            as Map<String, dynamic>;
    return MobilePluginSummary.fromJson(raw['plugin'] as Map<String, dynamic>);
  }
}
