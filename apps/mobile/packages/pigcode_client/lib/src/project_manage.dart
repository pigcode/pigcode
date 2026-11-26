import '../host_rpc.dart';
import '../sidebar_models.dart';

abstract final class MobileProjectMethods {
  static const list = 'mobile.project.list';
  static const browseDirs = 'mobile.project.browseDirs';
  static const add = 'mobile.project.add';
  static const rename = 'mobile.project.rename';
  static const remove = 'mobile.project.remove';
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

final class MobileProjectShortcut {
  const MobileProjectShortcut({
    required this.label,
    required this.relPath,
    required this.displayPath,
  });

  final String label;
  final String relPath;
  final String displayPath;

  factory MobileProjectShortcut.fromJson(Map<String, dynamic> json) =>
      MobileProjectShortcut(
        label: _reqString(json['label'], 'label'),
        relPath: _str(json['relPath'], 'relPath'),
        displayPath: _reqString(json['displayPath'], 'displayPath'),
      );

  Map<String, Object?> toJson() => {
    'label': label,
    'relPath': relPath,
    'displayPath': displayPath,
  };
}

final class MobileProjectDirEntry {
  const MobileProjectDirEntry({
    required this.name,
    required this.relPath,
    required this.isGitRepo,
    required this.alreadyAddedProjectId,
    required this.hasChildren,
  });

  final String name;
  final String relPath;
  final bool isGitRepo;
  final String? alreadyAddedProjectId;
  final bool hasChildren;

  factory MobileProjectDirEntry.fromJson(Map<String, dynamic> json) =>
      MobileProjectDirEntry(
        name: _reqString(json['name'], 'name'),
        relPath: _reqString(json['relPath'], 'relPath'),
        isGitRepo: _reqBool(json['isGitRepo'], 'isGitRepo'),
        alreadyAddedProjectId: json['alreadyAddedProjectId'] as String?,
        hasChildren: _reqBool(json['hasChildren'], 'hasChildren'),
      );

  Map<String, Object?> toJson() => {
    'name': name,
    'relPath': relPath,
    'isGitRepo': isGitRepo,
    'alreadyAddedProjectId': alreadyAddedProjectId,
    'hasChildren': hasChildren,
  };
}

final class MobileManagedProject {
  const MobileManagedProject({
    required this.id,
    required this.name,
    required this.displayPath,
    required this.createdAt,
    required this.threadCount,
  });

  final String id;
  final String name;
  final String displayPath;
  final String createdAt;
  final int threadCount;

  factory MobileManagedProject.fromJson(Map<String, dynamic> json) =>
      MobileManagedProject(
        id: _reqString(json['id'], 'id'),
        name: _reqString(json['name'], 'name'),
        displayPath: _reqString(json['displayPath'], 'displayPath'),
        createdAt: _reqString(json['createdAt'], 'createdAt'),
        threadCount: _nonNegInt(json['threadCount'], 'threadCount'),
      );

  Map<String, Object?> toJson() => {
    'id': id,
    'name': name,
    'displayPath': displayPath,
    'createdAt': createdAt,
    'threadCount': threadCount,
  };
}

final class MobileProjectBrowseDirsResult {
  const MobileProjectBrowseDirsResult({
    required this.currentRelPath,
    required this.displayPath,
    required this.parentRelPath,
    required this.shortcuts,
    required this.entries,
    required this.truncated,
  });

  final String currentRelPath;
  final String displayPath;
  final String? parentRelPath;
  final List<MobileProjectShortcut> shortcuts;
  final List<MobileProjectDirEntry> entries;
  final bool truncated;

  factory MobileProjectBrowseDirsResult.fromJson(Map<String, dynamic> json) {
    final shortcutsRaw = json['shortcuts'];
    final entriesRaw = json['entries'];
    if (shortcutsRaw is! List || entriesRaw is! List) {
      throw const FormatException('Invalid browseDirs payload');
    }
    return MobileProjectBrowseDirsResult(
      currentRelPath: _str(json['currentRelPath'], 'currentRelPath'),
      displayPath: _reqString(json['displayPath'], 'displayPath'),
      parentRelPath: json['parentRelPath'] as String?,
      shortcuts: List.unmodifiable(
        shortcutsRaw.map(
          (item) =>
              MobileProjectShortcut.fromJson(item as Map<String, dynamic>),
        ),
      ),
      entries: List.unmodifiable(
        entriesRaw.map(
          (item) =>
              MobileProjectDirEntry.fromJson(item as Map<String, dynamic>),
        ),
      ),
      truncated: _reqBool(json['truncated'], 'truncated'),
    );
  }

  Map<String, Object?> toJson() => {
    'currentRelPath': currentRelPath,
    'displayPath': displayPath,
    'parentRelPath': parentRelPath,
    'shortcuts': shortcuts.map((e) => e.toJson()).toList(growable: false),
    'entries': entries.map((e) => e.toJson()).toList(growable: false),
    'truncated': truncated,
  };
}

class MobileProjectManageClient {
  MobileProjectManageClient(this._rpc, {required this.supportsProjectManage});

  final HostRequests _rpc;
  final bool supportsProjectManage;

  void _ensureSupported() {
    if (!supportsProjectManage) {
      throw const MobileRpcFailure(
        MobileRpcProblem(
          code: 'METHOD_NOT_AVAILABLE',
          message: '当前电脑版本不支持在手机端管理项目，请升级电脑端 Pigcode。',
          retryable: false,
        ),
      );
    }
  }

  Future<List<MobileManagedProject>> list() async {
    _ensureSupported();
    final raw =
        await _rpc.call(MobileProjectMethods.list, const {})
            as Map<String, dynamic>;
    final list = raw['projects'];
    if (list is! List) throw const FormatException('Invalid projects list');
    return List.unmodifiable(
      list.map(
        (item) => MobileManagedProject.fromJson(item as Map<String, dynamic>),
      ),
    );
  }

  Future<MobileProjectBrowseDirsResult> browseDirs({
    String relPath = '',
  }) async {
    _ensureSupported();
    final raw =
        await _rpc.call(
              MobileProjectMethods.browseDirs,
              relPath.isEmpty ? const {} : {'relPath': relPath},
            )
            as Map<String, dynamic>;
    return MobileProjectBrowseDirsResult.fromJson(raw);
  }

  Future<MobileManagedProject> add({
    required String relPath,
    String? name,
  }) async {
    _ensureSupported();
    final trimmed = name?.trim();
    final raw =
        await _rpc.call(MobileProjectMethods.add, {
              'relPath': relPath,
              if (trimmed != null && trimmed.isNotEmpty) 'name': trimmed,
            })
            as Map<String, dynamic>;
    return MobileManagedProject.fromJson(
      raw['project'] as Map<String, dynamic>,
    );
  }

  Future<MobileManagedProject> rename({
    required String projectId,
    required String name,
  }) async {
    _ensureSupported();
    final raw =
        await _rpc.call(MobileProjectMethods.rename, {
              'projectId': projectId,
              'name': name.trim(),
            })
            as Map<String, dynamic>;
    return MobileManagedProject.fromJson(
      raw['project'] as Map<String, dynamic>,
    );
  }

  Future<void> remove({required String projectId}) async {
    _ensureSupported();
    await _rpc.call(MobileProjectMethods.remove, {'projectId': projectId});
  }
}
