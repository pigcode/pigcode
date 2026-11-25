import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pigcode_client/pigcode_client.dart';

import '../mobile_secure_storage.dart';

const modelPreferencesStorageKey = 'pigcode.mobile.model-preferences.v1';
const _modelPreferencesMutex = 'pigcode.model-preferences-storage';

/// 模型的本机偏好全局键：`<instanceId>/<modelId>`，对齐桌面端 `modelKey`。
String modelPreferenceKey(String instanceId, String modelId) =>
    '$instanceId/$modelId';

/// 本机模型偏好：收藏列表、各模型思考深度、快速模式与 Ultracode 开关。
/// 「新会话草稿」与「已有会话」通过 `modelPreferencesProvider` 实时共享同一份状态。
class ModelPreferences {
  const ModelPreferences({
    this.favorites = const [],
    this.efforts = const {},
    this.fast = const {},
    this.ultracode = const {},
  });

  static const empty = ModelPreferences();

  final List<String> favorites;
  final Map<String, String> efforts;
  final Set<String> fast;
  final Set<String> ultracode;

  bool isFavorite(String key) => favorites.contains(key);
  String? effortFor(String key) => efforts[key];
  bool isFast(String key) => fast.contains(key);
  bool isUltracode(String key) => ultracode.contains(key);

  ModelPreferences toggleFavorite(String key) {
    final next = favorites.contains(key)
        ? favorites.where((item) => item != key).toList()
        : [...favorites, key];
    return ModelPreferences(
      favorites: List.unmodifiable(next),
      efforts: efforts,
      fast: fast,
      ultracode: ultracode,
    );
  }

  ModelPreferences withEffort(String key, String? effort) {
    final next = Map<String, String>.from(efforts);
    final normalized = effort?.trim();
    if (normalized == null || normalized.isEmpty) {
      next.remove(key);
    } else {
      next[key] = normalized;
    }
    return ModelPreferences(
      favorites: favorites,
      efforts: Map.unmodifiable(next),
      fast: fast,
      ultracode: ultracode,
    );
  }

  ModelPreferences withFast(String key, bool enabled) {
    final next = Set<String>.from(fast);
    if (enabled) {
      next.add(key);
    } else {
      next.remove(key);
    }
    return ModelPreferences(
      favorites: favorites,
      efforts: efforts,
      fast: Set.unmodifiable(next),
      ultracode: ultracode,
    );
  }

  ModelPreferences withUltracode(String key, bool enabled) {
    final next = Set<String>.from(ultracode);
    if (enabled) {
      next.add(key);
    } else {
      next.remove(key);
    }
    return ModelPreferences(
      favorites: favorites,
      efforts: efforts,
      fast: fast,
      ultracode: Set.unmodifiable(next),
    );
  }

  Map<String, Object?> toJson() => {
    'favorites': favorites.toList(),
    'efforts': efforts,
    'fast': fast.toList(),
    'ultracode': ultracode.toList(),
  };

  factory ModelPreferences.fromJson(Map<String, dynamic> json) {
    List<String> readList(Object? raw) => raw is List
        ? raw.whereType<String>().where((item) => item.isNotEmpty).toSet().toList()
        : const [];
    final rawEfforts = json['efforts'];
    final parsedEfforts = <String, String>{};
    if (rawEfforts is Map) {
      for (final entry in rawEfforts.entries) {
        final key = entry.key;
        final value = entry.value;
        if (key is String &&
            key.isNotEmpty &&
            value is String &&
            value.trim().isNotEmpty) {
          parsedEfforts[key] = value.trim();
        }
      }
    }
    return ModelPreferences(
      favorites: List.unmodifiable(readList(json['favorites'])),
      efforts: Map.unmodifiable(parsedEfforts),
      fast: Set.unmodifiable(readList(json['fast'])),
      ultracode: Set.unmodifiable(readList(json['ultracode'])),
    );
  }
}

/// 持久化存取层，复用应用统一的 `mobileSecureStorage` 与串行锁。
class ModelPreferencesStorage {
  const ModelPreferencesStorage();

  Future<ModelPreferences> read() => withComputerStorage(
    _modelPreferencesMutex,
    () async {
      final raw = await mobileSecureStorage.read(
        key: modelPreferencesStorageKey,
      );
      if (raw == null || raw.isEmpty) return ModelPreferences.empty;
      try {
        final decoded = jsonDecode(raw);
        if (decoded is Map<String, dynamic>) {
          return ModelPreferences.fromJson(decoded);
        }
      } on FormatException {
        // 忽略损坏的本地缓存。
      } on TypeError {
        // 忽略结构不匹配的本地缓存。
      }
      return ModelPreferences.empty;
    },
  );

  Future<void> write(ModelPreferences preferences) => withComputerStorage(
    _modelPreferencesMutex,
    () => mobileSecureStorage.write(
      key: modelPreferencesStorageKey,
      value: jsonEncode(preferences.toJson()),
    ),
  );

  Future<void> clear() => withComputerStorage(
    _modelPreferencesMutex,
    () => mobileSecureStorage.delete(key: modelPreferencesStorageKey),
  );
}

/// 发送时经能力安全过滤后的运行选项；不支持或未开启的字段一律为 `null`。
final class ResolvedComposerRunOptions {
  const ResolvedComposerRunOptions({
    this.effort,
    this.fast,
    this.ultracode,
  });

  final String? effort;
  final bool? fast;
  final bool? ultracode;
}

/// 对齐桌面端 `resolveModel`：按当前 modelId、目录默认模型、首项的顺序解析模型。
MobileDraftModel? resolveDraftModel(
  MobileDraftModels? catalog,
  String? modelId,
) {
  final models = catalog?.models;
  if (models == null || models.isEmpty) return null;
  if (modelId != null) {
    final matched = models.where((item) => item.id == modelId).firstOrNull;
    if (matched != null) return matched;
  }
  final defaultId = catalog?.defaultModelId;
  if (defaultId != null) {
    final fallback = models.where((item) => item.id == defaultId).firstOrNull;
    if (fallback != null) return fallback;
  }
  return models.first;
}

/// 仅当当前模型支持对应思考深度时返回，否则返回 `null`（默认不发送）。
String? resolveModelEffort(MobileDraftModel? model, String? preferred) {
  if (model == null || preferred == null || preferred.isEmpty) return null;
  final efforts = model.efforts;
  if (efforts == null || !efforts.contains(preferred)) return null;
  return preferred;
}

bool resolveModelFast(MobileDraftModel? model, bool enabled) =>
    model?.fast == true && enabled;

bool resolveModelUltracode(MobileDraftModel? model, bool enabled) =>
    model?.ultracode == true && enabled;

/// 安全过滤：仅当电脑已协商 `supportsComposerControls` 且当前模型明确支持对应能力时才携带扩展字段。
ResolvedComposerRunOptions resolveComposerRunOptions({
  required bool supportsComposerControls,
  required String? instanceId,
  required MobileDraftModel? model,
  required ModelPreferences preferences,
}) {
  if (!supportsComposerControls || instanceId == null || model == null) {
    return const ResolvedComposerRunOptions();
  }
  final key = modelPreferenceKey(instanceId, model.id);
  final effort = resolveModelEffort(model, preferences.effortFor(key));
  final fast = resolveModelFast(model, preferences.isFast(key));
  final ultracode = resolveModelUltracode(model, preferences.isUltracode(key));
  return ResolvedComposerRunOptions(
    effort: effort,
    fast: fast ? true : null,
    ultracode: ultracode ? true : null,
  );
}

final modelPreferencesProvider =
    NotifierProvider<ModelPreferencesController, ModelPreferences>(
      ModelPreferencesController.new,
    );

class ModelPreferencesController extends Notifier<ModelPreferences> {
  static const _storage = ModelPreferencesStorage();

  final _pendingBeforeHydrate =
      <ModelPreferences Function(ModelPreferences)>[];
  bool _hydrated = false;
  Future<void>? _hydration;

  /// 等待首次从本机存储读取完成（主要用于测试校验重启恢复）。
  Future<void> get ready => _hydration ?? Future<void>.value();

  @override
  ModelPreferences build() {
    _hydrated = false;
    _pendingBeforeHydrate.clear();
    _hydration = _hydrate();
    return ModelPreferences.empty;
  }

  Future<void> _hydrate() async {
    final stored = await _storage.read();
    if (!ref.mounted) return;
    var merged = stored;
    final hadPending = _pendingBeforeHydrate.isNotEmpty;
    for (final mutation in _pendingBeforeHydrate) {
      merged = mutation(merged);
    }
    _pendingBeforeHydrate.clear();
    _hydrated = true;
    state = merged;
    if (hadPending) {
      await _persist(merged);
    }
  }

  Future<void> toggleFavorite(String key) =>
      _mutate((current) => current.toggleFavorite(key));

  Future<void> setEffort(String key, String? effort) =>
      _mutate((current) => current.withEffort(key, effort));

  Future<void> setFast(String key, bool enabled) =>
      _mutate((current) => current.withFast(key, enabled));

  Future<void> setUltracode(String key, bool enabled) =>
      _mutate((current) => current.withUltracode(key, enabled));

  Future<void> _mutate(ModelPreferences Function(ModelPreferences) update) async {
    final next = update(state);
    state = next;
    if (!_hydrated) {
      _pendingBeforeHydrate.add(update);
      return;
    }
    await _persist(next);
  }

  Future<void> _persist(ModelPreferences value) async {
    try {
      await _storage.write(value);
    } catch (_) {
      // 存储不可用时本次运行内仍保持内存状态。
    }
  }
}
