import 'dart:convert';

import '../mobile_secure_storage.dart';
import 'preview_url_extractor.dart';

const _previewHistoryPrefix = 'pigcode.mobile.preview-history.v1.';
const _previewHistoryMutex = 'pigcode.preview-history-storage';
const previewHistoryLimit = 10;

Future<T> _withPreviewHistory<T>(Future<T> Function() body) =>
    withComputerStorage(_previewHistoryMutex, body);

/// 清除指定电脑的最近预览历史（用于删除电脑 / 撤销配对清理）。
Future<void> clearComputerPreviewHistory(String computerKey) =>
    _withPreviewHistory(() async {
      await mobileSecureStorage.delete(key: '$_previewHistoryPrefix$computerKey');
    });

/// 重装初始化时清理所有残留的本机预览历史。
Future<void> clearPreviewHistoryOnInstall() => _withPreviewHistory(
  () => deleteSecurePrefix(_previewHistoryPrefix),
);

/// 按 `computerKey` 隔离持久化最近打开过的最多 [previewHistoryLimit] 条本机预览地址。
class PreviewHistoryStorage {
  PreviewHistoryStorage(this.computerKey)
    : _lease = ComputerStorageLease(computerKey),
      _key = '$_previewHistoryPrefix$computerKey';

  final String computerKey;
  final ComputerStorageLease _lease;
  final String _key;

  Future<List<String>> read() => _withPreviewHistory(() async {
    if (!_lease.valid) return const [];
    final items = await _readRaw();
    return _lease.valid ? items : const [];
  });

  /// 记录一条已打开的本机预览 URL：自动规范化、去重并置顶，最多保留 [previewHistoryLimit] 条。
  Future<List<String>> record(String rawUrl) => _withPreviewHistory(() async {
    if (!_lease.valid) return const [];
    final validated = normalizePreviewInput(rawUrl);
    final canonical = validated.uri?.toString();
    if (canonical == null) return _readRaw();

    final current = (await _readRaw()).toList();
    current.remove(canonical);
    current.insert(0, canonical);
    if (current.length > previewHistoryLimit) {
      current.removeRange(previewHistoryLimit, current.length);
    }
    await _write(current);
    return List<String>.unmodifiable(current);
  });

  /// 删除单条最近预览记录。
  Future<List<String>> remove(String url) => _withPreviewHistory(() async {
    if (!_lease.valid) return const [];
    final canonical = normalizePreviewInput(url).uri?.toString() ?? url;
    final current = (await _readRaw()).toList()
      ..removeWhere((item) => item == url || item == canonical);
    await _write(current);
    return List<String>.unmodifiable(current);
  });

  /// 清空当前电脑的全部预览历史。
  Future<void> clear() => _withPreviewHistory(() async {
    if (!_lease.valid) return;
    await mobileSecureStorage.delete(key: _key);
  });

  Future<List<String>> _readRaw() async {
    final raw = await mobileSecureStorage.read(key: _key);
    if (raw == null || raw.isEmpty) return const [];
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! List) return const [];
      final result = <String>[];
      final seen = <String>{};
      for (final item in decoded.whereType<String>()) {
        final validated = normalizePreviewInput(item);
        final canonical = validated.uri?.toString();
        if (canonical != null && seen.add(canonical)) {
          result.add(canonical);
          if (result.length >= previewHistoryLimit) break;
        }
      }
      return List<String>.unmodifiable(result);
    } on FormatException {
      return const [];
    } on TypeError {
      return const [];
    }
  }

  Future<void> _write(List<String> items) async {
    if (!_lease.valid) return;
    if (items.isEmpty) {
      await mobileSecureStorage.delete(key: _key);
    } else {
      await mobileSecureStorage.write(key: _key, value: jsonEncode(items));
    }
  }
}
