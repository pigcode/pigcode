import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:pigcode_transport/pigcode_transport.dart';

import '../host_rpc.dart';
import 'workbench.dart';

const mobileWorkbenchWriteInlineMax = 32 * 1024;
const mobileWorkbenchWriteInlineJsonMax = 48 * 1024;
const mobileWorkbenchWriteChunkBytes = 24 * 1024;
const mobileWorkbenchWriteMaxBytes = 1024 * 1024;
const mobileWorkbenchCheckpointAffectedLimit = 50;
const mobileWorkbenchLabelMax = 200;
const mobileWorkbenchPrTitleMax = 256;
const mobileWorkbenchPrBodyMax = 32 * 1024;

const _maxSafeInt = 9007199254740991;
const _fileEols = <String>{'lf', 'crlf'};
const _checkpointPhases = <String>{'baseline', 'final', 'manual'};

abstract final class MobileWorkbenchWriteMethods {
  static const writeFile = 'mobile.workspace.writeFile';
  static const writeStart = 'mobile.workspace.writeStart';
  static const writeChunk = 'mobile.workspace.writeChunk';
  static const writeCommit = 'mobile.workspace.writeCommit';
  static const createFile = 'mobile.workspace.createFile';
  static const renamePath = 'mobile.workspace.renamePath';
  static const deletePath = 'mobile.workspace.deletePath';
  static const worktreeList = 'mobile.worktree.list';
  static const worktreeCreate = 'mobile.worktree.create';
  static const worktreeSwitch = 'mobile.worktree.switch';
  static const worktreeRemove = 'mobile.worktree.remove';
  static const checkpointList = 'mobile.checkpoint.list';
  static const checkpointCreate = 'mobile.checkpoint.create';
  static const checkpointRestore = 'mobile.checkpoint.restore';
  static const prCreate = 'mobile.pr.create';
  static const prComment = 'mobile.pr.comment';
  static const prMerge = 'mobile.pr.merge';
  static const prReady = 'mobile.pr.ready';
  static const prClose = 'mobile.pr.close';
  static const prReopen = 'mobile.pr.reopen';
}

enum MobilePrMergeMethod {
  merge('merge'),
  squash('squash'),
  rebase('rebase');

  const MobilePrMergeMethod(this.wireValue);
  final String wireValue;

  static MobilePrMergeMethod fromWireValue(String value) {
    for (final method in values) {
      if (method.wireValue == value) return method;
    }
    throw FormatException('Invalid PR merge method: $value');
  }
}

bool _listEquals<T>(List<T> a, List<T> b) {
  if (identical(a, b)) return true;
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

double _parseNonNegativeDouble(Object? raw, String field) {
  if (raw is! num || !raw.isFinite || raw < 0) {
    throw FormatException('Invalid $field');
  }
  return raw.toDouble();
}

int _parseNonNegativeInt(Object? raw, String field) {
  if (raw is! int || raw < 0 || raw > _maxSafeInt) {
    throw FormatException('Invalid $field');
  }
  return raw;
}

final class MobileWriteFileResult {
  const MobileWriteFileResult({
    required this.path,
    required this.size,
    required this.mtimeMs,
  });

  final String path;
  final int size;
  final double mtimeMs;

  factory MobileWriteFileResult.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {'path', 'size', 'mtimeMs'}.contains(key),
    )) {
      throw const FormatException(
        'MobileWriteFileResult contains an unknown field',
      );
    }
    final path = json['path'] as String;
    if (path.isEmpty || path.length > mobileWorkbenchPathMax) {
      throw const FormatException('Invalid path');
    }
    final size = _parseNonNegativeInt(json['size'], 'size');
    final mtimeMs = _parseNonNegativeDouble(json['mtimeMs'], 'mtimeMs');
    return MobileWriteFileResult(path: path, size: size, mtimeMs: mtimeMs);
  }

  Map<String, Object?> toJson() => {
    'path': path,
    'size': size,
    'mtimeMs': mtimeMs,
  };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is MobileWriteFileResult &&
          path == other.path &&
          size == other.size &&
          mtimeMs == other.mtimeMs;

  @override
  int get hashCode => Object.hash(path, size, mtimeMs);
}

final class MobileCreateFileResult {
  const MobileCreateFileResult({
    required this.path,
    required this.size,
    required this.mtimeMs,
  });

  final String path;
  final int size;
  final double mtimeMs;

  factory MobileCreateFileResult.fromJson(Map<String, dynamic> json) {
    final parsed = MobileWriteFileResult.fromJson(json);
    return MobileCreateFileResult(
      path: parsed.path,
      size: parsed.size,
      mtimeMs: parsed.mtimeMs,
    );
  }

  Map<String, Object?> toJson() => {
    'path': path,
    'size': size,
    'mtimeMs': mtimeMs,
  };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is MobileCreateFileResult &&
          path == other.path &&
          size == other.size &&
          mtimeMs == other.mtimeMs;

  @override
  int get hashCode => Object.hash(path, size, mtimeMs);
}

final class MobileRenamePathResult {
  const MobileRenamePathResult({required this.oldPath, required this.newPath});

  final String oldPath;
  final String newPath;

  factory MobileRenamePathResult.fromJson(Map<String, dynamic> json) {
    if (json.keys.any((key) => !const {'oldPath', 'newPath'}.contains(key))) {
      throw const FormatException(
        'MobileRenamePathResult contains an unknown field',
      );
    }
    final oldPath = json['oldPath'] as String;
    final newPath = json['newPath'] as String;
    if (oldPath.isEmpty ||
        oldPath.length > mobileWorkbenchPathMax ||
        newPath.isEmpty ||
        newPath.length > mobileWorkbenchPathMax) {
      throw const FormatException('Invalid rename path');
    }
    return MobileRenamePathResult(oldPath: oldPath, newPath: newPath);
  }

  Map<String, Object?> toJson() => {'oldPath': oldPath, 'newPath': newPath};

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is MobileRenamePathResult &&
          oldPath == other.oldPath &&
          newPath == other.newPath;

  @override
  int get hashCode => Object.hash(oldPath, newPath);
}

final class MobileDeletePathResult {
  const MobileDeletePathResult({required this.path, required this.deleted});

  final String path;
  final bool deleted;

  factory MobileDeletePathResult.fromJson(Map<String, dynamic> json) {
    if (json.keys.any((key) => !const {'path', 'deleted'}.contains(key))) {
      throw const FormatException(
        'MobileDeletePathResult contains an unknown field',
      );
    }
    final path = json['path'] as String;
    if (path.isEmpty || path.length > mobileWorkbenchPathMax) {
      throw const FormatException('Invalid path');
    }
    final deleted = json['deleted'] as bool;
    if (!deleted) {
      throw const FormatException('Expected deleted: true');
    }
    return MobileDeletePathResult(path: path, deleted: deleted);
  }

  Map<String, Object?> toJson() => {'path': path, 'deleted': deleted};

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is MobileDeletePathResult &&
          path == other.path &&
          deleted == other.deleted;

  @override
  int get hashCode => Object.hash(path, deleted);
}

final class MobileWorktreeItem {
  const MobileWorktreeItem({
    required this.id,
    required this.name,
    required this.branch,
    required this.active,
  });

  final String id;
  final String name;
  final String? branch;
  final bool active;

  factory MobileWorktreeItem.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {'id', 'name', 'branch', 'active'}.contains(key),
    )) {
      throw const FormatException(
        'MobileWorktreeItem contains an unknown field',
      );
    }
    if (!json.containsKey('branch')) {
      throw const FormatException('Missing branch');
    }
    final id = json['id'] as String;
    final name = json['name'] as String;
    if (id.isEmpty || name.isEmpty || name.length > mobileWorkbenchPathMax) {
      throw const FormatException('Invalid worktree item');
    }
    final branch = json['branch'] as String?;
    if (branch != null && branch.isEmpty) {
      throw const FormatException('Invalid branch');
    }
    final active = json['active'] as bool;
    return MobileWorktreeItem(
      id: id,
      name: name,
      branch: branch,
      active: active,
    );
  }

  Map<String, Object?> toJson() => {
    'id': id,
    'name': name,
    'branch': branch,
    'active': active,
  };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is MobileWorktreeItem &&
          id == other.id &&
          name == other.name &&
          branch == other.branch &&
          active == other.active;

  @override
  int get hashCode => Object.hash(id, name, branch, active);
}

final class MobileWorktreeListResult {
  const MobileWorktreeListResult({
    required this.worktrees,
    required this.mainActive,
  });

  final List<MobileWorktreeItem> worktrees;
  final bool mainActive;

  factory MobileWorktreeListResult.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {'worktrees', 'mainActive'}.contains(key),
    )) {
      throw const FormatException(
        'MobileWorktreeListResult contains an unknown field',
      );
    }
    final worktrees = List<MobileWorktreeItem>.unmodifiable(
      (json['worktrees'] as List<dynamic>).map(
        (item) => MobileWorktreeItem.fromJson(item as Map<String, dynamic>),
      ),
    );
    final mainActive = json['mainActive'] as bool;
    return MobileWorktreeListResult(
      worktrees: worktrees,
      mainActive: mainActive,
    );
  }

  Map<String, Object?> toJson() => {
    'worktrees': worktrees.map((item) => item.toJson()).toList(),
    'mainActive': mainActive,
  };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is MobileWorktreeListResult &&
          _listEquals(worktrees, other.worktrees) &&
          mainActive == other.mainActive;

  @override
  int get hashCode => Object.hash(Object.hashAll(worktrees), mainActive);
}

final class MobileCheckpointItem {
  const MobileCheckpointItem({
    required this.id,
    required this.runId,
    required this.phase,
    required this.label,
    required this.createdAt,
    required this.restorable,
  });

  final String id;
  final String? runId;
  final String phase;
  final String? label;
  final String createdAt;
  final bool restorable;

  factory MobileCheckpointItem.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {
        'id',
        'runId',
        'phase',
        'label',
        'createdAt',
        'restorable',
      }.contains(key),
    )) {
      throw const FormatException(
        'MobileCheckpointItem contains an unknown field',
      );
    }
    if (!json.containsKey('runId') || !json.containsKey('label')) {
      throw const FormatException('Missing nullable checkpoint fields');
    }
    final id = json['id'] as String;
    if (id.isEmpty) {
      throw const FormatException('Invalid id');
    }
    final runId = json['runId'] as String?;
    if (runId != null && runId.isEmpty) {
      throw const FormatException('Invalid runId');
    }
    final phase = json['phase'] as String;
    if (!_checkpointPhases.contains(phase)) {
      throw const FormatException('Invalid phase');
    }
    final label = json['label'] as String?;
    if (label != null && label.length > mobileWorkbenchLabelMax) {
      throw const FormatException('Invalid label');
    }
    final createdAt = json['createdAt'] as String;
    if (createdAt.isEmpty) {
      throw const FormatException('Invalid createdAt');
    }
    final restorable = json['restorable'] as bool;
    return MobileCheckpointItem(
      id: id,
      runId: runId,
      phase: phase,
      label: label,
      createdAt: createdAt,
      restorable: restorable,
    );
  }

  Map<String, Object?> toJson() => {
    'id': id,
    'runId': runId,
    'phase': phase,
    'label': label,
    'createdAt': createdAt,
    'restorable': restorable,
  };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is MobileCheckpointItem &&
          id == other.id &&
          runId == other.runId &&
          phase == other.phase &&
          label == other.label &&
          createdAt == other.createdAt &&
          restorable == other.restorable;

  @override
  int get hashCode =>
      Object.hash(id, runId, phase, label, createdAt, restorable);
}

final class MobileCheckpointListResult {
  const MobileCheckpointListResult({required this.checkpoints});

  final List<MobileCheckpointItem> checkpoints;

  factory MobileCheckpointListResult.fromJson(Map<String, dynamic> json) {
    if (json.keys.any((key) => !const {'checkpoints'}.contains(key))) {
      throw const FormatException(
        'MobileCheckpointListResult contains an unknown field',
      );
    }
    final checkpoints = List<MobileCheckpointItem>.unmodifiable(
      (json['checkpoints'] as List<dynamic>).map(
        (item) => MobileCheckpointItem.fromJson(item as Map<String, dynamic>),
      ),
    );
    return MobileCheckpointListResult(checkpoints: checkpoints);
  }

  Map<String, Object?> toJson() => {
    'checkpoints': checkpoints.map((item) => item.toJson()).toList(),
  };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is MobileCheckpointListResult &&
          _listEquals(checkpoints, other.checkpoints);

  @override
  int get hashCode => Object.hashAll(checkpoints);
}

final class MobileCheckpointRestoreResult {
  const MobileCheckpointRestoreResult({
    required this.checkpointId,
    required this.affectedCount,
    required this.affectedPaths,
  });

  final String checkpointId;
  final int affectedCount;
  final List<String> affectedPaths;

  factory MobileCheckpointRestoreResult.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {
        'checkpointId',
        'affectedCount',
        'affectedPaths',
      }.contains(key),
    )) {
      throw const FormatException(
        'MobileCheckpointRestoreResult contains an unknown field',
      );
    }
    final checkpointId = json['checkpointId'] as String;
    if (checkpointId.isEmpty) {
      throw const FormatException('Invalid checkpointId');
    }
    final affectedCount = _parseNonNegativeInt(
      json['affectedCount'],
      'affectedCount',
    );
    final rawPaths = json['affectedPaths'] as List<dynamic>;
    if (rawPaths.length > mobileWorkbenchCheckpointAffectedLimit) {
      throw const FormatException('Too many affectedPaths');
    }
    final affectedPaths = List<String>.unmodifiable(
      rawPaths.map((item) {
        final path = item as String;
        if (path.isEmpty || path.length > mobileWorkbenchPathMax) {
          throw const FormatException('Invalid affectedPath');
        }
        return path;
      }),
    );
    return MobileCheckpointRestoreResult(
      checkpointId: checkpointId,
      affectedCount: affectedCount,
      affectedPaths: affectedPaths,
    );
  }

  Map<String, Object?> toJson() => {
    'checkpointId': checkpointId,
    'affectedCount': affectedCount,
    'affectedPaths': affectedPaths,
  };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is MobileCheckpointRestoreResult &&
          checkpointId == other.checkpointId &&
          affectedCount == other.affectedCount &&
          _listEquals(affectedPaths, other.affectedPaths);

  @override
  int get hashCode =>
      Object.hash(checkpointId, affectedCount, Object.hashAll(affectedPaths));
}

class MobileWorkbenchWriteClient {
  const MobileWorkbenchWriteClient(
    this._rpc, {
    this.supportsWorkbenchWrite = true,
  });

  final HostRequests _rpc;
  final bool supportsWorkbenchWrite;

  void _requireSupported() {
    if (!supportsWorkbenchWrite) {
      throw const ConnectionFailure('update-desktop');
    }
  }

  void _requireNonEmpty(String value, String name) {
    if (value.isEmpty) {
      throw ArgumentError.value(value, name, 'Must not be empty');
    }
  }

  void _requireValidPath(String path, String name) {
    if (path.isEmpty || path.length > mobileWorkbenchPathMax) {
      throw ArgumentError.value(path, name, 'Invalid path');
    }
  }

  /// 保存工作区文本文件：UTF-8 <= 32 KiB 走单帧保存，> 32 KiB 且 <= 1 MiB 自动分片并校验 SHA-256。
  Future<MobileWriteFileResult> writeFile({
    required String threadId,
    required String path,
    required String text,
    double? expectedMtimeMs,
    String? eol,
    void Function(int sentBytes, int totalBytes)? onProgress,
  }) async {
    _requireSupported();
    _requireNonEmpty(threadId, 'threadId');
    _requireValidPath(path, 'path');
    if (expectedMtimeMs != null &&
        (!expectedMtimeMs.isFinite || expectedMtimeMs < 0)) {
      throw ArgumentError.value(
        expectedMtimeMs,
        'expectedMtimeMs',
        'Must be non-negative finite number',
      );
    }
    if (eol != null && !_fileEols.contains(eol)) {
      throw ArgumentError.value(eol, 'eol', 'Unsupported EOL');
    }

    final bytes = utf8.encode(text);
    if (bytes.length > mobileWorkbenchWriteMaxBytes) {
      throw RangeError.range(
        bytes.length,
        0,
        mobileWorkbenchWriteMaxBytes,
        'text',
      );
    }

    if (bytes.length <= mobileWorkbenchWriteInlineMax) {
      final inlineParams = <String, Object?>{
        'threadId': threadId,
        'path': path,
        'text': text,
        'expectedMtimeMs': ?expectedMtimeMs,
        'eol': ?eol,
      };
      // JSON 转义（如大量控制字符、引号、反斜杠或换行）可能导致单帧体积膨胀超过 Noise 65,519 字节上限；
      // 参数 JSON 超出 48 KiB 时自动降级到 24 KiB Base64 分片通道。
      if (utf8.encode(jsonEncode(inlineParams)).length <=
          mobileWorkbenchWriteInlineJsonMax) {
        final raw = await _rpc.call(
          MobileWorkbenchWriteMethods.writeFile,
          inlineParams,
        );
        onProgress?.call(bytes.length, bytes.length);
        return MobileWriteFileResult.fromJson(raw as Map<String, dynamic>);
      }
    }

    final sha256Hex = await publicKeyFingerprint(bytes);
    final startRaw = await _rpc.call(MobileWorkbenchWriteMethods.writeStart, {
      'threadId': threadId,
      'path': path,
      'totalBytes': bytes.length,
      'sha256': sha256Hex,
      'expectedMtimeMs': ?expectedMtimeMs,
      'eol': ?eol,
    });
    final startMap = startRaw as Map<String, dynamic>;
    if (startMap.keys.any(
      (key) => !const {'sessionId', 'chunkBytes'}.contains(key),
    )) {
      throw const FormatException('writeStart result contains unknown field');
    }
    final sessionId = startMap['sessionId'] as String;
    final rawChunkBytes = startMap['chunkBytes'] as int;
    if (sessionId.isEmpty ||
        rawChunkBytes <= 0 ||
        rawChunkBytes > mobileWorkbenchWriteChunkBytes) {
      throw const FormatException('Invalid writeStart result');
    }

    final chunkBytes = min(rawChunkBytes, mobileWorkbenchWriteChunkBytes);
    for (var offset = 0; offset < bytes.length; offset += chunkBytes) {
      final end = min(offset + chunkBytes, bytes.length);
      final slice = Uint8List.sublistView(bytes, offset, end);
      final chunkRaw = await _rpc.call(MobileWorkbenchWriteMethods.writeChunk, {
        'sessionId': sessionId,
        'offset': offset,
        'dataBase64': base64Encode(slice),
      });
      final chunkMap = chunkRaw as Map<String, dynamic>;
      if (chunkMap.keys.any((key) => !const {'receivedBytes'}.contains(key))) {
        throw const FormatException('writeChunk result contains unknown field');
      }
      final receivedBytes = _parseNonNegativeInt(
        chunkMap['receivedBytes'],
        'receivedBytes',
      );
      if (receivedBytes != end) {
        throw const FormatException('Unexpected chunk receivedBytes');
      }
      onProgress?.call(receivedBytes, bytes.length);
    }

    final commitRaw = await _rpc.call(MobileWorkbenchWriteMethods.writeCommit, {
      'sessionId': sessionId,
    });
    return MobileWriteFileResult.fromJson(commitRaw as Map<String, dynamic>);
  }

  Future<MobileCreateFileResult> createFile({
    required String threadId,
    required String path,
    String? text,
  }) async {
    _requireSupported();
    _requireNonEmpty(threadId, 'threadId');
    _requireValidPath(path, 'path');
    if (text != null &&
        utf8.encode(text).length > mobileWorkbenchWriteInlineMax) {
      throw RangeError.range(
        utf8.encode(text).length,
        0,
        mobileWorkbenchWriteInlineMax,
        'text',
      );
    }
    final raw = await _rpc.call(MobileWorkbenchWriteMethods.createFile, {
      'threadId': threadId,
      'path': path,
      'text': ?text,
    });
    return MobileCreateFileResult.fromJson(raw as Map<String, dynamic>);
  }

  Future<MobileRenamePathResult> renamePath({
    required String threadId,
    required String oldPath,
    required String newPath,
  }) async {
    _requireSupported();
    _requireNonEmpty(threadId, 'threadId');
    _requireValidPath(oldPath, 'oldPath');
    _requireValidPath(newPath, 'newPath');
    final raw = await _rpc.call(MobileWorkbenchWriteMethods.renamePath, {
      'threadId': threadId,
      'oldPath': oldPath,
      'newPath': newPath,
    });
    return MobileRenamePathResult.fromJson(raw as Map<String, dynamic>);
  }

  Future<MobileDeletePathResult> deletePath({
    required String threadId,
    required String path,
    bool recursive = false,
  }) async {
    _requireSupported();
    _requireNonEmpty(threadId, 'threadId');
    _requireValidPath(path, 'path');
    final raw = await _rpc.call(MobileWorkbenchWriteMethods.deletePath, {
      'threadId': threadId,
      'path': path,
      if (recursive) 'recursive': true,
    });
    return MobileDeletePathResult.fromJson(raw as Map<String, dynamic>);
  }

  Future<MobileWorktreeListResult> listWorktrees({
    required String threadId,
  }) async {
    _requireSupported();
    _requireNonEmpty(threadId, 'threadId');
    final raw = await _rpc.call(MobileWorkbenchWriteMethods.worktreeList, {
      'threadId': threadId,
    });
    return MobileWorktreeListResult.fromJson(raw as Map<String, dynamic>);
  }

  Future<MobileWorktreeItem> createWorktree({required String threadId}) async {
    _requireSupported();
    _requireNonEmpty(threadId, 'threadId');
    final raw = await _rpc.call(MobileWorkbenchWriteMethods.worktreeCreate, {
      'threadId': threadId,
    });
    final map = raw as Map<String, dynamic>;
    if (map.keys.any((key) => !const {'worktree'}.contains(key))) {
      throw const FormatException(
        'worktreeCreate result contains unknown field',
      );
    }
    return MobileWorktreeItem.fromJson(map['worktree'] as Map<String, dynamic>);
  }

  Future<MobileWorktreeItem> switchWorktree({
    required String threadId,
    required String worktreeId,
  }) async {
    _requireSupported();
    _requireNonEmpty(threadId, 'threadId');
    _requireNonEmpty(worktreeId, 'worktreeId');
    final raw = await _rpc.call(MobileWorkbenchWriteMethods.worktreeSwitch, {
      'threadId': threadId,
      'worktreeId': worktreeId,
    });
    final map = raw as Map<String, dynamic>;
    if (map.keys.any((key) => !const {'worktree'}.contains(key))) {
      throw const FormatException(
        'worktreeSwitch result contains unknown field',
      );
    }
    return MobileWorktreeItem.fromJson(map['worktree'] as Map<String, dynamic>);
  }

  Future<void> removeWorktree({required String threadId}) async {
    _requireSupported();
    _requireNonEmpty(threadId, 'threadId');
    final raw = await _rpc.call(MobileWorkbenchWriteMethods.worktreeRemove, {
      'threadId': threadId,
    });
    final map = raw as Map<String, dynamic>;
    if (map.keys.any((key) => !const {'removed'}.contains(key)) ||
        map['removed'] != true) {
      throw const FormatException('Invalid worktreeRemove result');
    }
  }

  Future<MobileCheckpointListResult> listCheckpoints({
    required String threadId,
  }) async {
    _requireSupported();
    _requireNonEmpty(threadId, 'threadId');
    final raw = await _rpc.call(MobileWorkbenchWriteMethods.checkpointList, {
      'threadId': threadId,
    });
    return MobileCheckpointListResult.fromJson(raw as Map<String, dynamic>);
  }

  Future<MobileCheckpointItem> createCheckpoint({
    required String threadId,
    String? label,
  }) async {
    _requireSupported();
    _requireNonEmpty(threadId, 'threadId');
    final trimmed = label?.trim();
    if (trimmed != null && trimmed.length > mobileWorkbenchLabelMax) {
      throw ArgumentError.value(label, 'label', 'Label too long');
    }
    final raw = await _rpc.call(MobileWorkbenchWriteMethods.checkpointCreate, {
      'threadId': threadId,
      if (trimmed != null && trimmed.isNotEmpty) 'label': trimmed,
    });
    final map = raw as Map<String, dynamic>;
    if (map.keys.any((key) => !const {'checkpoint'}.contains(key))) {
      throw const FormatException(
        'checkpointCreate result contains unknown field',
      );
    }
    return MobileCheckpointItem.fromJson(
      map['checkpoint'] as Map<String, dynamic>,
    );
  }

  Future<MobileCheckpointRestoreResult> restoreCheckpoint({
    required String threadId,
    required String checkpointId,
  }) async {
    _requireSupported();
    _requireNonEmpty(threadId, 'threadId');
    _requireNonEmpty(checkpointId, 'checkpointId');
    final raw = await _rpc.call(MobileWorkbenchWriteMethods.checkpointRestore, {
      'threadId': threadId,
      'checkpointId': checkpointId,
    });
    return MobileCheckpointRestoreResult.fromJson(raw as Map<String, dynamic>);
  }

  Future<MobilePrStatusResult> createPr({
    required String threadId,
    required String title,
    String? body,
    String? base,
    bool? draft,
  }) async {
    _requireSupported();
    _requireNonEmpty(threadId, 'threadId');
    final trimmedTitle = title.trim();
    if (trimmedTitle.isEmpty ||
        trimmedTitle.length > mobileWorkbenchPrTitleMax) {
      throw ArgumentError.value(title, 'title', 'Invalid PR title');
    }
    if (body != null && utf8.encode(body).length > mobileWorkbenchPrBodyMax) {
      throw RangeError.range(
        utf8.encode(body).length,
        0,
        mobileWorkbenchPrBodyMax,
        'body',
      );
    }
    final trimmedBase = base?.trim();
    if (trimmedBase != null &&
        (trimmedBase.isEmpty || trimmedBase.length > 256)) {
      throw ArgumentError.value(base, 'base', 'Invalid base branch');
    }
    final raw = await _rpc.call(MobileWorkbenchWriteMethods.prCreate, {
      'threadId': threadId,
      'title': trimmedTitle,
      'body': ?body,
      'base': ?trimmedBase,
      'draft': ?draft,
    });
    return MobilePrStatusResult.fromJson(raw as Map<String, dynamic>);
  }

  Future<void> commentPr({
    required String threadId,
    required String body,
  }) async {
    _requireSupported();
    _requireNonEmpty(threadId, 'threadId');
    final trimmed = body.trim();
    if (trimmed.isEmpty) {
      throw ArgumentError.value(body, 'body', 'PR comment must not be empty');
    }
    if (utf8.encode(trimmed).length > mobileWorkbenchPrBodyMax) {
      throw RangeError.range(
        utf8.encode(trimmed).length,
        1,
        mobileWorkbenchPrBodyMax,
        'body',
      );
    }
    final raw = await _rpc.call(MobileWorkbenchWriteMethods.prComment, {
      'threadId': threadId,
      'body': trimmed,
    });
    final map = raw as Map<String, dynamic>;
    if (map.keys.any((key) => !const {'ok'}.contains(key)) ||
        map['ok'] != true) {
      throw const FormatException('Invalid prComment result');
    }
  }

  Future<MobilePrStatusResult> mergePr({
    required String threadId,
    required MobilePrMergeMethod method,
    bool? deleteBranch,
  }) async {
    _requireSupported();
    _requireNonEmpty(threadId, 'threadId');
    final raw = await _rpc.call(MobileWorkbenchWriteMethods.prMerge, {
      'threadId': threadId,
      'method': method.wireValue,
      'deleteBranch': ?deleteBranch,
    });
    return MobilePrStatusResult.fromJson(raw as Map<String, dynamic>);
  }

  Future<MobilePrStatusResult> readyPr({required String threadId}) async {
    _requireSupported();
    _requireNonEmpty(threadId, 'threadId');
    final raw = await _rpc.call(MobileWorkbenchWriteMethods.prReady, {
      'threadId': threadId,
    });
    return MobilePrStatusResult.fromJson(raw as Map<String, dynamic>);
  }

  Future<MobilePrStatusResult> closePr({required String threadId}) async {
    _requireSupported();
    _requireNonEmpty(threadId, 'threadId');
    final raw = await _rpc.call(MobileWorkbenchWriteMethods.prClose, {
      'threadId': threadId,
    });
    return MobilePrStatusResult.fromJson(raw as Map<String, dynamic>);
  }

  Future<MobilePrStatusResult> reopenPr({required String threadId}) async {
    _requireSupported();
    _requireNonEmpty(threadId, 'threadId');
    final raw = await _rpc.call(MobileWorkbenchWriteMethods.prReopen, {
      'threadId': threadId,
    });
    return MobilePrStatusResult.fromJson(raw as Map<String, dynamic>);
  }
}
