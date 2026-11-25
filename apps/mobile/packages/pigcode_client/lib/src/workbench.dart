import 'dart:convert';
import 'dart:typed_data';

import 'package:pigcode_transport/pigcode_transport.dart';

import '../host_rpc.dart';
import 'attachments.dart';

const mobileWorkbenchPathMax = 4096;
const mobileWorkbenchListDefaultLimit = 100;
const mobileWorkbenchListMaxLimit = 200;
const mobileWorkbenchReadMaxLength = 32 * 1024;
const mobileWorkbenchSearchQueryMax = 200;
const mobileWorkbenchSearchGlobMax = 200;
const mobileWorkbenchSearchMaxLimit = 100;
const mobileWorkbenchSearchPreviewMax = 200;
const _maxSafeInt = 9007199254740991;

const _readRequestModes = <String>{'auto', 'text', 'image'};
const _readResultModes = <String>{'text', 'image', 'binary'};
const _readVariants = <String>{'thumb', 'full'};
const _fileEols = <String>{'lf', 'crlf'};
const _entryKinds = <String>{'file', 'directory'};
const _prStatuses = <String>{
  'ok',
  'no-pr',
  'not-git',
  'no-remote',
  'gh-unavailable',
  'gh-unauthenticated',
};

abstract final class MobileWorkbenchMethods {
  static const list = 'mobile.workspace.list';
  static const readFile = 'mobile.workspace.readFile';
  static const search = 'mobile.workspace.search';
  static const prStatus = 'mobile.pr.status';
}

bool _listEquals<T>(List<T> a, List<T> b) {
  if (identical(a, b)) return true;
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

bool _bytesEquals(Uint8List a, Uint8List b) {
  if (identical(a, b)) return true;
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

final class MobileDirectoryEntry {
  const MobileDirectoryEntry({
    required this.path,
    required this.name,
    required this.kind,
    this.ignored = false,
    this.symlink = false,
    this.size,
  });

  final String path;
  final String name;
  final String kind;
  final bool ignored;
  final bool symlink;
  final int? size;

  bool get isDirectory => kind == 'directory';
  bool get isFile => kind == 'file';

  factory MobileDirectoryEntry.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {
        'path',
        'name',
        'kind',
        'ignored',
        'symlink',
        'size',
      }.contains(key),
    )) {
      throw const FormatException(
        'MobileDirectoryEntry contains an unknown field',
      );
    }
    final path = json['path'] as String;
    if (path.isEmpty || path.length > mobileWorkbenchPathMax) {
      throw const FormatException('Invalid path');
    }
    final name = json['name'] as String;
    if (name.isEmpty || name.length > mobileWorkbenchPathMax) {
      throw const FormatException('Invalid name');
    }
    final kind = json['kind'] as String;
    if (!_entryKinds.contains(kind)) {
      throw const FormatException('Invalid kind');
    }
    final ignored = json.containsKey('ignored') ? json['ignored'] as bool : false;
    if (json.containsKey('ignored') && !ignored) {
      throw const FormatException('Invalid ignored');
    }
    final symlink = json.containsKey('symlink') ? json['symlink'] as bool : false;
    if (json.containsKey('symlink') && !symlink) {
      throw const FormatException('Invalid symlink');
    }
    final size = json.containsKey('size') ? json['size'] as int : null;
    if (size != null && (size < 0 || size > _maxSafeInt)) {
      throw const FormatException('Invalid size');
    }
    return MobileDirectoryEntry(
      path: path,
      name: name,
      kind: kind,
      ignored: ignored,
      symlink: symlink,
      size: size,
    );
  }

  Map<String, Object?> toJson() => {
    'path': path,
    'name': name,
    'kind': kind,
    if (ignored) 'ignored': true,
    if (symlink) 'symlink': true,
    'size': ?size,
  };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is MobileDirectoryEntry &&
          path == other.path &&
          name == other.name &&
          kind == other.kind &&
          ignored == other.ignored &&
          symlink == other.symlink &&
          size == other.size;

  @override
  int get hashCode => Object.hash(path, name, kind, ignored, symlink, size);
}

final class MobileDirectoryListing {
  const MobileDirectoryListing({
    required this.path,
    required this.entries,
    required this.truncated,
    this.nextOffset,
  });

  final String path;
  final List<MobileDirectoryEntry> entries;
  final bool truncated;
  final int? nextOffset;

  factory MobileDirectoryListing.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {
        'path',
        'entries',
        'truncated',
        'nextOffset',
      }.contains(key),
    )) {
      throw const FormatException(
        'MobileDirectoryListing contains an unknown field',
      );
    }
    final path = json['path'] as String;
    if (path.length > mobileWorkbenchPathMax) {
      throw const FormatException('Invalid path');
    }
    final entries = List<MobileDirectoryEntry>.unmodifiable(
      (json['entries'] as List<dynamic>).map(
        (item) => MobileDirectoryEntry.fromJson(item as Map<String, dynamic>),
      ),
    );
    final truncated = json['truncated'] as bool;
    final nextOffset = json.containsKey('nextOffset')
        ? json['nextOffset'] as int
        : null;
    if (nextOffset != null && (nextOffset < 0 || nextOffset > _maxSafeInt)) {
      throw const FormatException('Invalid nextOffset');
    }
    return MobileDirectoryListing(
      path: path,
      entries: entries,
      truncated: truncated,
      nextOffset: nextOffset,
    );
  }

  Map<String, Object?> toJson() => {
    'path': path,
    'entries': entries.map((entry) => entry.toJson()).toList(),
    'truncated': truncated,
    'nextOffset': ?nextOffset,
  };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is MobileDirectoryListing &&
          path == other.path &&
          _listEquals(entries, other.entries) &&
          truncated == other.truncated &&
          nextOffset == other.nextOffset;

  @override
  int get hashCode =>
      Object.hash(path, Object.hashAll(entries), truncated, nextOffset);
}

final class MobileFileChunk {
  const MobileFileChunk({
    required this.path,
    required this.mode,
    required this.totalSize,
    required this.binary,
    required this.truncated,
    this.text,
    this.eol,
    this.languageHint,
    this.mimeType,
    this.dataBase64,
    this.width,
    this.height,
    this.nextOffset,
    this.mtimeMs,
  });

  final String path;
  final String mode;
  final int totalSize;
  final bool binary;
  final bool truncated;
  final String? text;
  final String? eol;
  final String? languageHint;
  final String? mimeType;
  final String? dataBase64;
  final int? width;
  final int? height;
  final int? nextOffset;
  final double? mtimeMs;

  factory MobileFileChunk.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {
        'path',
        'mode',
        'totalSize',
        'binary',
        'truncated',
        'text',
        'eol',
        'languageHint',
        'mimeType',
        'dataBase64',
        'width',
        'height',
        'nextOffset',
        'mtimeMs',
      }.contains(key),
    )) {
      throw const FormatException('MobileFileChunk contains an unknown field');
    }
    final path = json['path'] as String;
    if (path.isEmpty || path.length > mobileWorkbenchPathMax) {
      throw const FormatException('Invalid path');
    }
    final mode = json['mode'] as String;
    if (!_readResultModes.contains(mode)) {
      throw const FormatException('Invalid mode');
    }
    final totalSize = json['totalSize'] as int;
    if (totalSize < 0 || totalSize > _maxSafeInt) {
      throw const FormatException('Invalid totalSize');
    }
    final binary = json['binary'] as bool;
    final truncated = json['truncated'] as bool;
    final text = json.containsKey('text') ? json['text'] as String : null;
    final eol = json.containsKey('eol') ? json['eol'] as String : null;
    if (eol != null && !_fileEols.contains(eol)) {
      throw const FormatException('Invalid eol');
    }
    final languageHint = json.containsKey('languageHint')
        ? json['languageHint'] as String
        : null;
    if (languageHint != null &&
        (languageHint.isEmpty || languageHint.length > 64)) {
      throw const FormatException('Invalid languageHint');
    }
    final mimeType = json.containsKey('mimeType')
        ? json['mimeType'] as String
        : null;
    if (mimeType != null && !mobileAttachmentMimeTypes.contains(mimeType)) {
      throw const FormatException('Invalid mimeType');
    }
    final dataBase64 = json.containsKey('dataBase64')
        ? json['dataBase64'] as String
        : null;
    final width = json.containsKey('width') ? json['width'] as int : null;
    if (width != null && (width <= 0 || width > _maxSafeInt)) {
      throw const FormatException('Invalid width');
    }
    final height = json.containsKey('height') ? json['height'] as int : null;
    if (height != null && (height <= 0 || height > _maxSafeInt)) {
      throw const FormatException('Invalid height');
    }
    final nextOffset = json.containsKey('nextOffset')
        ? json['nextOffset'] as int
        : null;
    if (nextOffset != null && (nextOffset < 0 || nextOffset > _maxSafeInt)) {
      throw const FormatException('Invalid nextOffset');
    }
    final double? mtimeMs;
    if (!json.containsKey('mtimeMs')) {
      mtimeMs = null;
    } else {
      final rawMtime = json['mtimeMs'];
      if (rawMtime is! num || !rawMtime.isFinite || rawMtime < 0) {
        throw const FormatException('Invalid mtimeMs');
      }
      mtimeMs = rawMtime.toDouble();
    }
    return MobileFileChunk(
      path: path,
      mode: mode,
      totalSize: totalSize,
      binary: binary,
      truncated: truncated,
      text: text,
      eol: eol,
      languageHint: languageHint,
      mimeType: mimeType,
      dataBase64: dataBase64,
      width: width,
      height: height,
      nextOffset: nextOffset,
      mtimeMs: mtimeMs,
    );
  }

  Map<String, Object?> toJson() => {
    'path': path,
    'mode': mode,
    'totalSize': totalSize,
    'binary': binary,
    'truncated': truncated,
    'text': ?text,
    'eol': ?eol,
    'languageHint': ?languageHint,
    'mimeType': ?mimeType,
    'dataBase64': ?dataBase64,
    'width': ?width,
    'height': ?height,
    'nextOffset': ?nextOffset,
    'mtimeMs': ?mtimeMs,
  };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is MobileFileChunk &&
          path == other.path &&
          mode == other.mode &&
          totalSize == other.totalSize &&
          binary == other.binary &&
          truncated == other.truncated &&
          text == other.text &&
          eol == other.eol &&
          languageHint == other.languageHint &&
          mimeType == other.mimeType &&
          dataBase64 == other.dataBase64 &&
          width == other.width &&
          height == other.height &&
          nextOffset == other.nextOffset &&
          mtimeMs == other.mtimeMs;

  @override
  int get hashCode => Object.hash(
    path,
    mode,
    totalSize,
    binary,
    truncated,
    text,
    eol,
    languageHint,
    mimeType,
    dataBase64,
    width,
    height,
    nextOffset,
    mtimeMs,
  );
}

final class MobileFileImageData {
  const MobileFileImageData({
    required this.path,
    required this.mimeType,
    required this.bytes,
    required this.totalSize,
    this.width,
    this.height,
  });

  final String path;
  final String mimeType;
  final Uint8List bytes;
  final int totalSize;
  final int? width;
  final int? height;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is MobileFileImageData &&
          path == other.path &&
          mimeType == other.mimeType &&
          _bytesEquals(bytes, other.bytes) &&
          totalSize == other.totalSize &&
          width == other.width &&
          height == other.height;

  @override
  int get hashCode => Object.hash(
    path,
    mimeType,
    Object.hashAll(bytes),
    totalSize,
    width,
    height,
  );
}

final class MobileSearchMatch {
  const MobileSearchMatch({
    required this.path,
    required this.line,
    required this.preview,
  });

  final String path;
  final int line;
  final String preview;

  factory MobileSearchMatch.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {'path', 'line', 'preview'}.contains(key),
    )) {
      throw const FormatException(
        'MobileSearchMatch contains an unknown field',
      );
    }
    final path = json['path'] as String;
    if (path.isEmpty || path.length > mobileWorkbenchPathMax) {
      throw const FormatException('Invalid path');
    }
    final line = json['line'] as int;
    if (line < 1 || line > _maxSafeInt) {
      throw const FormatException('Invalid line');
    }
    final preview = json['preview'] as String;
    if (preview.length > mobileWorkbenchSearchPreviewMax) {
      throw const FormatException('Invalid preview');
    }
    return MobileSearchMatch(path: path, line: line, preview: preview);
  }

  Map<String, Object?> toJson() => {
    'path': path,
    'line': line,
    'preview': preview,
  };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is MobileSearchMatch &&
          path == other.path &&
          line == other.line &&
          preview == other.preview;

  @override
  int get hashCode => Object.hash(path, line, preview);
}

final class MobileSearchResult {
  const MobileSearchResult({
    required this.query,
    required this.matches,
    required this.truncated,
  });

  final String query;
  final List<MobileSearchMatch> matches;
  final bool truncated;

  factory MobileSearchResult.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {'query', 'matches', 'truncated'}.contains(key),
    )) {
      throw const FormatException(
        'MobileSearchResult contains an unknown field',
      );
    }
    final query = json['query'] as String;
    if (query.isEmpty || query.length > mobileWorkbenchSearchQueryMax) {
      throw const FormatException('Invalid query');
    }
    final matches = List<MobileSearchMatch>.unmodifiable(
      (json['matches'] as List<dynamic>).map(
        (item) => MobileSearchMatch.fromJson(item as Map<String, dynamic>),
      ),
    );
    final truncated = json['truncated'] as bool;
    return MobileSearchResult(
      query: query,
      matches: matches,
      truncated: truncated,
    );
  }

  Map<String, Object?> toJson() => {
    'query': query,
    'matches': matches.map((match) => match.toJson()).toList(),
    'truncated': truncated,
  };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is MobileSearchResult &&
          query == other.query &&
          _listEquals(matches, other.matches) &&
          truncated == other.truncated;

  @override
  int get hashCode => Object.hash(query, Object.hashAll(matches), truncated);
}

final class MobilePrChecksSummary {
  const MobilePrChecksSummary({
    required this.total,
    required this.passed,
    required this.failed,
    required this.pending,
  });

  final int total;
  final int passed;
  final int failed;
  final int pending;

  factory MobilePrChecksSummary.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {'total', 'passed', 'failed', 'pending'}.contains(key),
    )) {
      throw const FormatException(
        'MobilePrChecksSummary contains an unknown field',
      );
    }
    final total = json['total'] as int;
    final passed = json['passed'] as int;
    final failed = json['failed'] as int;
    final pending = json['pending'] as int;
    if (total < 0 ||
        passed < 0 ||
        failed < 0 ||
        pending < 0 ||
        total > _maxSafeInt ||
        passed > _maxSafeInt ||
        failed > _maxSafeInt ||
        pending > _maxSafeInt) {
      throw const FormatException('Invalid check counts');
    }
    return MobilePrChecksSummary(
      total: total,
      passed: passed,
      failed: failed,
      pending: pending,
    );
  }

  Map<String, Object?> toJson() => {
    'total': total,
    'passed': passed,
    'failed': failed,
    'pending': pending,
  };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is MobilePrChecksSummary &&
          total == other.total &&
          passed == other.passed &&
          failed == other.failed &&
          pending == other.pending;

  @override
  int get hashCode => Object.hash(total, passed, failed, pending);
}

final class MobilePullRequestInfo {
  const MobilePullRequestInfo({
    required this.number,
    required this.title,
    required this.state,
    required this.url,
    required this.headRefName,
    required this.baseRefName,
    this.isDraft,
    this.additions,
    this.deletions,
    this.changedFiles,
    this.reviewDecision,
    this.checksSummary,
    this.updatedAt,
  });

  final int number;
  final String title;
  final String state;
  final String url;
  final String headRefName;
  final String baseRefName;
  final bool? isDraft;
  final int? additions;
  final int? deletions;
  final int? changedFiles;
  final String? reviewDecision;
  final MobilePrChecksSummary? checksSummary;
  final String? updatedAt;

  factory MobilePullRequestInfo.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {
        'number',
        'title',
        'state',
        'url',
        'headRefName',
        'baseRefName',
        'isDraft',
        'additions',
        'deletions',
        'changedFiles',
        'reviewDecision',
        'checksSummary',
        'updatedAt',
      }.contains(key),
    )) {
      throw const FormatException(
        'MobilePullRequestInfo contains an unknown field',
      );
    }
    final number = json['number'] as int;
    if (number <= 0 || number > _maxSafeInt) {
      throw const FormatException('Invalid number');
    }
    final title = json['title'] as String;
    final state = json['state'] as String;
    if (state.isEmpty) {
      throw const FormatException('Invalid state');
    }
    final url = json['url'] as String;
    if (url.isEmpty) {
      throw const FormatException('Invalid url');
    }
    final headRefName = json['headRefName'] as String;
    if (headRefName.isEmpty) {
      throw const FormatException('Invalid headRefName');
    }
    final baseRefName = json['baseRefName'] as String;
    if (baseRefName.isEmpty) {
      throw const FormatException('Invalid baseRefName');
    }
    final isDraft = json.containsKey('isDraft') ? json['isDraft'] as bool : null;
    final additions = json.containsKey('additions')
        ? json['additions'] as int
        : null;
    if (additions != null && (additions < 0 || additions > _maxSafeInt)) {
      throw const FormatException('Invalid additions');
    }
    final deletions = json.containsKey('deletions')
        ? json['deletions'] as int
        : null;
    if (deletions != null && (deletions < 0 || deletions > _maxSafeInt)) {
      throw const FormatException('Invalid deletions');
    }
    final changedFiles = json.containsKey('changedFiles')
        ? json['changedFiles'] as int
        : null;
    if (changedFiles != null &&
        (changedFiles < 0 || changedFiles > _maxSafeInt)) {
      throw const FormatException('Invalid changedFiles');
    }
    final reviewDecision = json.containsKey('reviewDecision')
        ? json['reviewDecision'] as String?
        : null;
    final checksSummary = json.containsKey('checksSummary')
        ? MobilePrChecksSummary.fromJson(
            json['checksSummary'] as Map<String, dynamic>,
          )
        : null;
    final updatedAt = json.containsKey('updatedAt')
        ? json['updatedAt'] as String
        : null;
    if (updatedAt != null && updatedAt.isEmpty) {
      throw const FormatException('Invalid updatedAt');
    }
    return MobilePullRequestInfo(
      number: number,
      title: title,
      state: state,
      url: url,
      headRefName: headRefName,
      baseRefName: baseRefName,
      isDraft: isDraft,
      additions: additions,
      deletions: deletions,
      changedFiles: changedFiles,
      reviewDecision: reviewDecision,
      checksSummary: checksSummary,
      updatedAt: updatedAt,
    );
  }

  Map<String, Object?> toJson() => {
    'number': number,
    'title': title,
    'state': state,
    'url': url,
    'headRefName': headRefName,
    'baseRefName': baseRefName,
    'isDraft': ?isDraft,
    'additions': ?additions,
    'deletions': ?deletions,
    'changedFiles': ?changedFiles,
    'reviewDecision': ?reviewDecision,
    'checksSummary': ?checksSummary?.toJson(),
    'updatedAt': ?updatedAt,
  };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is MobilePullRequestInfo &&
          number == other.number &&
          title == other.title &&
          state == other.state &&
          url == other.url &&
          headRefName == other.headRefName &&
          baseRefName == other.baseRefName &&
          isDraft == other.isDraft &&
          additions == other.additions &&
          deletions == other.deletions &&
          changedFiles == other.changedFiles &&
          reviewDecision == other.reviewDecision &&
          checksSummary == other.checksSummary &&
          updatedAt == other.updatedAt;

  @override
  int get hashCode => Object.hash(
    number,
    title,
    state,
    url,
    headRefName,
    baseRefName,
    isDraft,
    additions,
    deletions,
    changedFiles,
    reviewDecision,
    checksSummary,
    updatedAt,
  );
}

final class MobilePrStatusResult {
  const MobilePrStatusResult({
    required this.status,
    required this.branch,
    this.pr,
  });

  final String status;
  final String? branch;
  final MobilePullRequestInfo? pr;

  factory MobilePrStatusResult.fromJson(Map<String, dynamic> json) {
    if (json.keys.any(
      (key) => !const {'status', 'branch', 'pr'}.contains(key),
    )) {
      throw const FormatException(
        'MobilePrStatusResult contains an unknown field',
      );
    }
    if (!json.containsKey('branch')) {
      throw const FormatException('Missing branch');
    }
    final status = json['status'] as String;
    if (!_prStatuses.contains(status)) {
      throw const FormatException('Invalid status');
    }
    final branch = json['branch'] as String?;
    if (branch != null && branch.isEmpty) {
      throw const FormatException('Invalid branch');
    }
    final pr = json.containsKey('pr')
        ? MobilePullRequestInfo.fromJson(json['pr'] as Map<String, dynamic>)
        : null;
    return MobilePrStatusResult(status: status, branch: branch, pr: pr);
  }

  Map<String, Object?> toJson() => {
    'status': status,
    'branch': branch,
    'pr': ?pr?.toJson(),
  };

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is MobilePrStatusResult &&
          status == other.status &&
          branch == other.branch &&
          pr == other.pr;

  @override
  int get hashCode => Object.hash(status, branch, pr);
}

class MobileWorkbenchCommands {
  const MobileWorkbenchCommands(
    this._rpc, {
    this.supportsWorkbenchRead = true,
  });

  final HostRequests _rpc;
  final bool supportsWorkbenchRead;

  void _requireSupported() {
    if (!supportsWorkbenchRead) {
      throw const ConnectionFailure('update-desktop');
    }
  }

  Future<MobileDirectoryListing> listDirectory({
    required String threadId,
    String path = '',
    int offset = 0,
    int? limit,
  }) async {
    _requireSupported();
    if (threadId.isEmpty) {
      throw ArgumentError.value(threadId, 'threadId', 'Must not be empty');
    }
    if (path.length > mobileWorkbenchPathMax) {
      throw ArgumentError.value(path, 'path', 'Path too long');
    }
    if (offset < 0) {
      throw RangeError.value(offset, 'offset', 'Must be non-negative');
    }
    if (limit != null && (limit < 1 || limit > mobileWorkbenchListMaxLimit)) {
      throw RangeError.range(limit, 1, mobileWorkbenchListMaxLimit, 'limit');
    }
    final raw = await _rpc.call(MobileWorkbenchMethods.list, {
      'threadId': threadId,
      if (path.isNotEmpty) 'path': path,
      if (offset > 0) 'offset': offset,
      'limit': ?limit,
    });
    return MobileDirectoryListing.fromJson(raw as Map<String, dynamic>);
  }

  Future<MobileFileChunk> readFile({
    required String threadId,
    required String path,
    int offset = 0,
    int? length,
    String mode = 'auto',
    String variant = 'full',
  }) async {
    _requireSupported();
    if (threadId.isEmpty) {
      throw ArgumentError.value(threadId, 'threadId', 'Must not be empty');
    }
    if (path.isEmpty || path.length > mobileWorkbenchPathMax) {
      throw ArgumentError.value(path, 'path', 'Invalid path');
    }
    if (offset < 0) {
      throw RangeError.value(offset, 'offset', 'Must be non-negative');
    }
    if (length != null && (length < 1 || length > mobileWorkbenchReadMaxLength)) {
      throw RangeError.range(length, 1, mobileWorkbenchReadMaxLength, 'length');
    }
    if (!_readRequestModes.contains(mode)) {
      throw ArgumentError.value(mode, 'mode', 'Unsupported read mode');
    }
    if (!_readVariants.contains(variant)) {
      throw ArgumentError.value(variant, 'variant', 'Unsupported variant');
    }
    final raw = await _rpc.call(MobileWorkbenchMethods.readFile, {
      'threadId': threadId,
      'path': path,
      if (offset > 0) 'offset': offset,
      'length': ?length,
      'mode': mode,
      'variant': variant,
    });
    return MobileFileChunk.fromJson(raw as Map<String, dynamic>);
  }

  Future<MobileFileImageData> readFileImage({
    required String threadId,
    required String path,
    String variant = 'full',
    void Function(int received, int total)? onProgress,
  }) async {
    _requireSupported();
    if (threadId.isEmpty) {
      throw ArgumentError.value(threadId, 'threadId', 'Must not be empty');
    }
    if (path.isEmpty || path.length > mobileWorkbenchPathMax) {
      throw ArgumentError.value(path, 'path', 'Invalid path');
    }
    if (!_readVariants.contains(variant)) {
      throw ArgumentError.value(variant, 'variant', 'Unsupported variant');
    }

    final builder = BytesBuilder(copy: false);
    String? canonicalPath;
    String? mimeType;
    int? expectedTotal;
    int? width;
    int? height;
    var offset = 0;

    while (true) {
      final chunk = await readFile(
        threadId: threadId,
        path: path,
        offset: offset,
        mode: 'image',
        variant: variant,
      );
      if (chunk.mode != 'image' ||
          chunk.mimeType == null ||
          chunk.dataBase64 == null) {
        throw const FormatException('File is not a supported image');
      }
      canonicalPath ??= chunk.path;
      mimeType ??= chunk.mimeType;
      width ??= chunk.width;
      height ??= chunk.height;
      expectedTotal ??= chunk.totalSize;
      if (chunk.totalSize != expectedTotal) {
        throw const FormatException('Image size changed while reading');
      }
      final bytes = base64Decode(chunk.dataBase64!);
      builder.add(bytes);
      onProgress?.call(builder.length, expectedTotal);

      final next = chunk.nextOffset;
      if (next == null) {
        if (builder.length != expectedTotal) {
          throw const FormatException('Truncated image payload');
        }
        return MobileFileImageData(
          path: canonicalPath,
          mimeType: mimeType!,
          bytes: builder.takeBytes(),
          totalSize: expectedTotal,
          width: width,
          height: height,
        );
      }
      if (next <= offset || next != builder.length || next >= expectedTotal) {
        throw const FormatException('Invalid image read offset');
      }
      offset = next;
    }
  }

  Future<MobileSearchResult> searchFiles({
    required String threadId,
    required String query,
    String? glob,
    int? limit,
  }) async {
    _requireSupported();
    if (threadId.isEmpty) {
      throw ArgumentError.value(threadId, 'threadId', 'Must not be empty');
    }
    final trimmedQuery = query.trim();
    if (trimmedQuery.isEmpty ||
        trimmedQuery.length > mobileWorkbenchSearchQueryMax) {
      throw ArgumentError.value(query, 'query', 'Invalid search query');
    }
    if (glob != null && glob.length > mobileWorkbenchSearchGlobMax) {
      throw ArgumentError.value(glob, 'glob', 'Glob pattern too long');
    }
    if (limit != null && (limit < 1 || limit > mobileWorkbenchSearchMaxLimit)) {
      throw RangeError.range(limit, 1, mobileWorkbenchSearchMaxLimit, 'limit');
    }
    final raw = await _rpc.call(MobileWorkbenchMethods.search, {
      'threadId': threadId,
      'query': trimmedQuery,
      'glob': ?glob,
      'limit': ?limit,
    });
    return MobileSearchResult.fromJson(raw as Map<String, dynamic>);
  }

  Future<MobilePrStatusResult> getPrStatus({required String threadId}) async {
    _requireSupported();
    if (threadId.isEmpty) {
      throw ArgumentError.value(threadId, 'threadId', 'Must not be empty');
    }
    final raw = await _rpc.call(MobileWorkbenchMethods.prStatus, {
      'threadId': threadId,
    });
    return MobilePrStatusResult.fromJson(raw as Map<String, dynamic>);
  }
}
