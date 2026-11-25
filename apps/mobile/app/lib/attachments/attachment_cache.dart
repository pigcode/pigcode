import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:cryptography/cryptography.dart';
import 'package:flutter/services.dart' show MissingPluginException;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path_provider/path_provider.dart';

import '../mobile_secure_storage.dart';

const _attachmentCacheRootName = 'pigcode_attachments';
const _thumbsDirName = 'thumbs';
const _fullDirName = 'full';
const _draftsDirName = 'drafts';
const _maxMemoryThumbEntries = 64;

Future<Directory?> _defaultAttachmentsDirectory() async {
  try {
    final root = await getApplicationSupportDirectory();
    return Directory(_join(root.path, _attachmentCacheRootName));
  } on MissingPluginException {
    return null;
  }
}

String _join(String parent, String child) =>
    '$parent${Platform.pathSeparator}$child';

String _safeSegment(String raw) {
  if (raw.isNotEmpty &&
      raw != '.' &&
      raw != '..' &&
      RegExp(r'^[A-Za-z0-9._-]+$').hasMatch(raw)) {
    return raw;
  }
  return 'b64_${base64Url.encode(utf8.encode(raw)).replaceAll('=', '')}';
}

/// 按 `computerKey` 隔离的附件磁盘与缩略图内存缓存：
/// - `<appSupportDir>/pigcode_attachments/<computerHash>/thumbs/<attachmentId>`
/// - `<appSupportDir>/pigcode_attachments/<computerHash>/full/<attachmentId>`
/// - `<appSupportDir>/pigcode_attachments/<computerHash>/drafts/<localId>.<ext>`
class AttachmentCacheStore {
  AttachmentCacheStore({required this.directory}) : _inMemory = false;

  /// 纯内存隔离存储，供 Widget 测试在 `FakeAsync` 下零磁盘 I/O 阻塞运行。
  AttachmentCacheStore.inMemory()
    : directory = _nullDirectory,
      _inMemory = true;

  static Future<Directory?> _nullDirectory() async => null;

  static AttachmentCacheStore defaultInstance = AttachmentCacheStore(
    directory: _defaultAttachmentsDirectory,
  );

  final Future<Directory?> Function() directory;
  final bool _inMemory;
  final _memoryThumbs = <String, Uint8List>{};
  final _memoryFull = <String, Uint8List>{};
  final _memoryDrafts = <String, Uint8List>{};
  final _hashCache = <String, String>{};

  String _memoryKey(String computerKey, String attachmentId) =>
      '$computerKey\u0000$attachmentId';

  String _storageLockKey(String computerKey) =>
      'pigcode.attachments.$computerKey';

  Future<String> computerHash(String computerKey) async {
    final existing = _hashCache[computerKey];
    if (existing != null) return existing;
    final digest = await Sha256().hash(utf8.encode(computerKey));
    final encoded = base64Url.encode(digest.bytes).replaceAll('=', '');
    _hashCache[computerKey] = encoded;
    return encoded;
  }

  Future<Directory?> computerDirectory(String computerKey) async {
    final root = await directory();
    if (root == null) return null;
    final hash = await computerHash(computerKey);
    return Directory(_join(root.path, hash));
  }

  Future<File?> thumbFile(String computerKey, String attachmentId) async {
    final base = await computerDirectory(computerKey);
    if (base == null) return null;
    return File(
      _join(_join(base.path, _thumbsDirName), _safeSegment(attachmentId)),
    );
  }

  Future<File?> fullFile(String computerKey, String attachmentId) async {
    final base = await computerDirectory(computerKey);
    if (base == null) return null;
    return File(
      _join(_join(base.path, _fullDirName), _safeSegment(attachmentId)),
    );
  }

  Future<File?> draftFile(String computerKey, String draftFileName) async {
    final base = await computerDirectory(computerKey);
    if (base == null) return null;
    return File(
      _join(_join(base.path, _draftsDirName), _safeSegment(draftFileName)),
    );
  }

  Uint8List? peekThumbMemory(String computerKey, String attachmentId) {
    final key = _memoryKey(computerKey, attachmentId);
    final value = _memoryThumbs.remove(key);
    if (value != null) _memoryThumbs[key] = value;
    return value;
  }

  void _rememberThumbMemory(
    String computerKey,
    String attachmentId,
    Uint8List bytes,
  ) {
    final key = _memoryKey(computerKey, attachmentId);
    _memoryThumbs.remove(key);
    _memoryThumbs[key] = bytes;
    while (_memoryThumbs.length > _maxMemoryThumbEntries) {
      _memoryThumbs.remove(_memoryThumbs.keys.first);
    }
  }

  Future<Uint8List?> readThumb(String computerKey, String attachmentId) async {
    final cached = peekThumbMemory(computerKey, attachmentId);
    if (cached != null) return cached;
    if (_inMemory) return null;
    final lease = ComputerStorageLease(computerKey);
    return withComputerStorage(_storageLockKey(computerKey), () async {
      if (!lease.valid) return null;
      final file = await thumbFile(computerKey, attachmentId);
      if (file == null || !await file.exists()) return null;
      try {
        final bytes = await file.readAsBytes();
        if (!lease.valid || bytes.isEmpty) return null;
        _rememberThumbMemory(computerKey, attachmentId, bytes);
        return bytes;
      } catch (_) {
        return null;
      }
    });
  }

  Future<void> writeThumb(
    String computerKey,
    String attachmentId,
    Uint8List bytes,
  ) async {
    if (_inMemory) {
      _rememberThumbMemory(computerKey, attachmentId, bytes);
      return;
    }
    final lease = ComputerStorageLease(computerKey);
    await withComputerStorage(_storageLockKey(computerKey), () async {
      if (!lease.valid) return;
      final file = await thumbFile(computerKey, attachmentId);
      if (file == null) return;
      await _writeAtomic(file, bytes);
      if (lease.valid) {
        _rememberThumbMemory(computerKey, attachmentId, bytes);
      }
    });
  }

  Future<Uint8List?> readFull(String computerKey, String attachmentId) async {
    if (_inMemory) {
      return _memoryFull[_memoryKey(computerKey, attachmentId)];
    }
    final lease = ComputerStorageLease(computerKey);
    return withComputerStorage(_storageLockKey(computerKey), () async {
      if (!lease.valid) return null;
      final file = await fullFile(computerKey, attachmentId);
      if (file == null || !await file.exists()) return null;
      try {
        final bytes = await file.readAsBytes();
        return lease.valid && bytes.isNotEmpty ? bytes : null;
      } catch (_) {
        return null;
      }
    });
  }

  Future<void> writeFull(
    String computerKey,
    String attachmentId,
    Uint8List bytes,
  ) async {
    if (_inMemory) {
      _memoryFull[_memoryKey(computerKey, attachmentId)] = bytes;
      return;
    }
    final lease = ComputerStorageLease(computerKey);
    await withComputerStorage(_storageLockKey(computerKey), () async {
      if (!lease.valid) return;
      final file = await fullFile(computerKey, attachmentId);
      if (file == null) return;
      await _writeAtomic(file, bytes);
    });
  }

  /// 将离线草稿或待发图片副本写入 `<computerHash>/drafts/<localId>.<ext>`，返回安全文件名。
  Future<String> writeDraftFile(
    String computerKey,
    String localId,
    String ext,
    Uint8List bytes,
  ) async {
    final normalizedExt = ext.replaceAll(RegExp(r'[^a-zA-Z0-9]'), '');
    final fileName =
        '${_safeSegment(localId)}.${normalizedExt.isEmpty ? 'jpg' : normalizedExt}';
    if (_inMemory) {
      _memoryDrafts[_memoryKey(computerKey, fileName)] = bytes;
      return fileName;
    }
    final lease = ComputerStorageLease(computerKey);
    await withComputerStorage(_storageLockKey(computerKey), () async {
      if (!lease.valid) return;
      final file = await draftFile(computerKey, fileName);
      if (file == null) return;
      await _writeAtomic(file, bytes);
    });
    return fileName;
  }

  Future<Uint8List?> readDraftFile(
    String computerKey,
    String draftFileName,
  ) async {
    if (_inMemory) {
      return _memoryDrafts[_memoryKey(computerKey, draftFileName)];
    }
    final lease = ComputerStorageLease(computerKey);
    return withComputerStorage(_storageLockKey(computerKey), () async {
      if (!lease.valid) return null;
      final file = await draftFile(computerKey, draftFileName);
      if (file == null || !await file.exists()) return null;
      try {
        final bytes = await file.readAsBytes();
        return lease.valid && bytes.isNotEmpty ? bytes : null;
      } catch (_) {
        return null;
      }
    });
  }

  Future<void> deleteDraftFile(String computerKey, String draftFileName) async {
    if (_inMemory) {
      _memoryDrafts.remove(_memoryKey(computerKey, draftFileName));
      return;
    }
    await withComputerStorage(_storageLockKey(computerKey), () async {
      final file = await draftFile(computerKey, draftFileName);
      if (file != null && await file.exists()) {
        await file.delete().catchError((Object _) => file);
      }
    });
  }

  /// 清理某台电脑的草稿副本目录（供草稿清空调用）。
  Future<void> clearComputerDraftFiles(String computerKey) async {
    _memoryDrafts.removeWhere((key, _) => key.startsWith('$computerKey\u0000'));
    if (_inMemory) return;
    await withComputerStorage(_storageLockKey(computerKey), () async {
      final base = await computerDirectory(computerKey);
      if (base == null) return;
      final dir = Directory(_join(base.path, _draftsDirName));
      if (await dir.exists()) {
        await dir.delete(recursive: true);
      }
    });
  }

  /// 彻底清除某台电脑的全部附件缓存（thumbs / full / drafts）及内存缩略图。
  Future<void> clearComputerAttachmentCache(String computerKey) async {
    invalidateComputerStorage(computerKey);
    _memoryThumbs.removeWhere((key, _) => key.startsWith('$computerKey\u0000'));
    _memoryFull.removeWhere((key, _) => key.startsWith('$computerKey\u0000'));
    _memoryDrafts.removeWhere((key, _) => key.startsWith('$computerKey\u0000'));
    if (_inMemory) return;
    await withComputerStorage(_storageLockKey(computerKey), () async {
      final dir = await computerDirectory(computerKey);
      if (dir != null && await dir.exists()) {
        await dir.delete(recursive: true);
      }
    });
  }

  /// 彻底清除全部电脑的附件缓存（重装初始化或全量重置时调用）。
  Future<void> clearAllAttachmentCaches() async {
    _memoryThumbs.clear();
    _memoryFull.clear();
    _memoryDrafts.clear();
    if (_inMemory) return;
    final root = await directory();
    if (root != null && await root.exists()) {
      await root.delete(recursive: true);
    }
  }

  Future<void> _writeAtomic(File target, Uint8List bytes) async {
    await target.parent.create(recursive: true);
    final temp = File('${target.path}.tmp');
    await temp.writeAsBytes(bytes, flush: true);
    await temp.rename(target.path);
  }
}

final attachmentCacheProvider = Provider<AttachmentCacheStore>(
  (_) => AttachmentCacheStore.defaultInstance,
);

/// 便捷清理函数：清除指定电脑的全部附件缓存（缩略图、原图与离线草稿副本）。
Future<void> clearComputerAttachmentCache(String computerKey) =>
    AttachmentCacheStore.defaultInstance.clearComputerAttachmentCache(
      computerKey,
    );

/// 便捷清理函数：清除所有电脑的附件缓存。
Future<void> clearAllAttachmentCaches() =>
    AttachmentCacheStore.defaultInstance.clearAllAttachmentCaches();
