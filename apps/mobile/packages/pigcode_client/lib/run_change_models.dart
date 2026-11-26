// 由 generate-mobile-contracts.ts 从 Zod 的 JSON Schema 生成。

abstract final class MobileRunChangesMethods {
  static const list = 'run.changes';
  static const diff = 'run.diff';
}

final class MobileRunChangesParams {
  const MobileRunChangesParams({
    required this.threadId,
    required this.runId,
    this.offset,
  });
  final String threadId;
  final String runId;
  final int? offset;

  factory MobileRunChangesParams.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {'threadId', 'runId', 'offset'}.contains(key),
    )) {
      throw const FormatException(
        'MobileRunChangesParams contains an unknown field',
      );
    }
    final threadId = (json['threadId'] as String);
    if (threadId.isEmpty) {
      throw const FormatException('Invalid threadId');
    }
    final runId = (json['runId'] as String);
    if (runId.isEmpty) {
      throw const FormatException('Invalid runId');
    }
    final offset = json['offset'] != null ? json['offset'] as int : null;
    if (offset != null && (offset < 0 || offset > 9007199254740991)) {
      throw const FormatException('Invalid offset');
    }
    return MobileRunChangesParams(
      threadId: threadId,
      runId: runId,
      offset: offset,
    );
  }

  Map<String, Object?> toJson() => {
    'threadId': threadId,
    'runId': runId,
    'offset': ?offset,
  };
}

final class MobileRunDiffParams {
  const MobileRunDiffParams({
    required this.threadId,
    required this.runId,
    this.offset,
    required this.path,
  });
  final String threadId;
  final String runId;
  final int? offset;
  final String path;

  factory MobileRunDiffParams.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {'threadId', 'runId', 'offset', 'path'}.contains(key),
    )) {
      throw const FormatException(
        'MobileRunDiffParams contains an unknown field',
      );
    }
    final threadId = (json['threadId'] as String);
    if (threadId.isEmpty) {
      throw const FormatException('Invalid threadId');
    }
    final runId = (json['runId'] as String);
    if (runId.isEmpty) {
      throw const FormatException('Invalid runId');
    }
    final offset = json['offset'] != null ? json['offset'] as int : null;
    if (offset != null && (offset < 0 || offset > 9007199254740991)) {
      throw const FormatException('Invalid offset');
    }
    final path = (json['path'] as String);
    if (path.isEmpty || path.length > 4096) {
      throw const FormatException('Invalid path');
    }
    return MobileRunDiffParams(
      threadId: threadId,
      runId: runId,
      offset: offset,
      path: path,
    );
  }

  Map<String, Object?> toJson() => {
    'threadId': threadId,
    'runId': runId,
    'offset': ?offset,
    'path': path,
  };
}

final class MobileRunChangedFile {
  const MobileRunChangedFile({
    required this.path,
    this.added,
    this.removed,
    this.binary,
  });
  final String path;
  final int? added;
  final int? removed;
  final bool? binary;

  factory MobileRunChangedFile.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {'path', 'added', 'removed', 'binary'}.contains(key),
    )) {
      throw const FormatException(
        'MobileRunChangedFile contains an unknown field',
      );
    }
    final path = (json['path'] as String);
    if (path.isEmpty || path.length > 4096) {
      throw const FormatException('Invalid path');
    }
    final added = json['added'] != null ? json['added'] as int : null;
    if (added != null && (added < 0 || added > 9007199254740991)) {
      throw const FormatException('Invalid added');
    }
    final removed = json['removed'] != null ? json['removed'] as int : null;
    if (removed != null && (removed < 0 || removed > 9007199254740991)) {
      throw const FormatException('Invalid removed');
    }
    final binary = json['binary'] != null ? json['binary'] as bool : null;
    return MobileRunChangedFile(
      path: path,
      added: added,
      removed: removed,
      binary: binary,
    );
  }

  Map<String, Object?> toJson() => {
    'path': path,
    'added': ?added,
    'removed': ?removed,
    'binary': ?binary,
  };
}

final class MobileRunChangesPage {
  const MobileRunChangesPage({
    required this.files,
    required this.diffAvailable,
    this.sharedWorktree,
    this.nextOffset,
  });
  final List<MobileRunChangedFile> files;
  final bool diffAvailable;
  final bool? sharedWorktree;
  final int? nextOffset;

  factory MobileRunChangesPage.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {
        'files',
        'diffAvailable',
        'sharedWorktree',
        'nextOffset',
      }.contains(key),
    )) {
      throw const FormatException(
        'MobileRunChangesPage contains an unknown field',
      );
    }
    final files = (List<MobileRunChangedFile>.unmodifiable(
      (json['files'] as List<dynamic>).map(
        (item) => MobileRunChangedFile.fromJson(item as Map<String, dynamic>),
      ),
    ));
    final diffAvailable = (json['diffAvailable'] as bool);
    final sharedWorktree = json['sharedWorktree'] != null
        ? json['sharedWorktree'] as bool
        : null;
    final nextOffset = json['nextOffset'] != null
        ? json['nextOffset'] as int
        : null;
    if (nextOffset != null &&
        (nextOffset < 0 || nextOffset > 9007199254740991)) {
      throw const FormatException('Invalid nextOffset');
    }
    return MobileRunChangesPage(
      files: files,
      diffAvailable: diffAvailable,
      sharedWorktree: sharedWorktree,
      nextOffset: nextOffset,
    );
  }

  Map<String, Object?> toJson() => {
    'files': files.map((item) => item.toJson()).toList(),
    'diffAvailable': diffAvailable,
    'sharedWorktree': ?sharedWorktree,
    'nextOffset': ?nextOffset,
  };
}

final class MobileRunDiffPage {
  const MobileRunDiffPage({required this.text, this.nextOffset});
  final String text;
  final int? nextOffset;

  factory MobileRunDiffPage.fromJson(Map<String, dynamic> json) {
    if (json.keys.any((key) => !const {'text', 'nextOffset'}.contains(key))) {
      throw const FormatException(
        'MobileRunDiffPage contains an unknown field',
      );
    }
    final text = (json['text'] as String);
    final nextOffset = json['nextOffset'] != null
        ? json['nextOffset'] as int
        : null;
    if (nextOffset != null &&
        (nextOffset < 0 || nextOffset > 9007199254740991)) {
      throw const FormatException('Invalid nextOffset');
    }
    return MobileRunDiffPage(text: text, nextOffset: nextOffset);
  }

  Map<String, Object?> toJson() => {'text': text, 'nextOffset': ?nextOffset};
}
