import '../host_rpc.dart';
import '../sidebar.dart';
import '../sidebar_models.dart';

abstract final class MobileSummaryMethods {
  static const summary = 'mobile.summary';
}

const mobileSummaryMaxItems = 50;
const mobileSummaryPreviewLimit = 120;
const _mobileSummaryLabelLimit = 512;
const _mobileSummaryComputerNameLimit = 80;

final _computerIdRegex = RegExp(r'^[0-9a-f]{64}$');

void _rejectUnknownKeys(
  Map<String, dynamic> json,
  Set<String> allowed,
  String model,
) {
  if (json.keys.any((key) => !allowed.contains(key))) {
    throw FormatException('$model contains an unknown field');
  }
}

String _reqString(Object? raw, String field, {int? maxLength}) {
  if (raw is! String || raw.isEmpty) {
    throw FormatException('Invalid $field');
  }
  if (maxLength != null && raw.length > maxLength) {
    throw FormatException('Invalid $field');
  }
  return raw;
}

String? _optString(Object? raw, String field, {int? maxLength}) {
  if (raw == null) return null;
  return _reqString(raw, field, maxLength: maxLength);
}

int _nonNegInt(Object? raw, String field) {
  if (raw is! int || raw < 0) {
    throw FormatException('Invalid $field');
  }
  return raw;
}

bool _reqBool(Object? raw, String field) {
  if (raw is! bool) {
    throw FormatException('Invalid $field');
  }
  return raw;
}

DateTime _parseIsoDateTime(String value, String field) {
  try {
    return DateTime.parse(value);
  } on FormatException {
    throw FormatException('Invalid $field');
  }
}

final class MobileSummaryCounts {
  const MobileSummaryCounts({
    required this.attention,
    required this.error,
    required this.unread,
    required this.working,
    required this.total,
  });

  static const zero = MobileSummaryCounts(
    attention: 0,
    error: 0,
    unread: 0,
    working: 0,
    total: 0,
  );

  final int attention;
  final int error;
  final int unread;
  final int working;
  final int total;

  int get actionable => attention + error + unread;
  int get urgent => attention + error;

  factory MobileSummaryCounts.fromJson(Map<String, dynamic> json) {
    _rejectUnknownKeys(json, const {
      'attention',
      'error',
      'unread',
      'working',
      'total',
    }, 'MobileSummaryCounts');
    return MobileSummaryCounts(
      attention: _nonNegInt(json['attention'], 'attention'),
      error: _nonNegInt(json['error'], 'error'),
      unread: _nonNegInt(json['unread'], 'unread'),
      working: _nonNegInt(json['working'], 'working'),
      total: _nonNegInt(json['total'], 'total'),
    );
  }

  Map<String, Object?> toJson() => {
    'attention': attention,
    'error': error,
    'unread': unread,
    'working': working,
    'total': total,
  };

  @override
  bool operator ==(Object other) =>
      other is MobileSummaryCounts &&
      other.attention == attention &&
      other.error == error &&
      other.unread == unread &&
      other.working == working &&
      other.total == total;

  @override
  int get hashCode => Object.hash(attention, error, unread, working, total);

  @override
  String toString() =>
      'MobileSummaryCounts(attention: $attention, error: $error, '
      'unread: $unread, working: $working, total: $total)';
}

final class MobileSummaryItem {
  const MobileSummaryItem({
    required this.threadId,
    required this.projectId,
    required this.projectName,
    required this.title,
    required this.updatedAt,
    required this.status,
    this.pendingKind,
    this.pendingPreview,
    required this.unread,
    required this.pinned,
    this.agentName,
  });

  final String threadId;
  final String projectId;
  final String projectName;
  final String title;
  final String updatedAt;
  final MobileThreadStatus status;
  final MobileThreadPendingKind? pendingKind;
  final String? pendingPreview;
  final bool unread;
  final bool pinned;
  final String? agentName;

  bool get isAttention => status == MobileThreadStatus.waitingApproval;
  bool get isError => status == MobileThreadStatus.failed;
  bool get isWorking =>
      status == MobileThreadStatus.running ||
      status == MobileThreadStatus.queued;
  bool get isUnread => !isAttention && !isError && !isWorking && unread;

  factory MobileSummaryItem.fromJson(Map<String, dynamic> json) {
    _rejectUnknownKeys(json, const {
      'threadId',
      'projectId',
      'projectName',
      'title',
      'updatedAt',
      'status',
      'pendingKind',
      'pendingPreview',
      'unread',
      'pinned',
      'agentName',
    }, 'MobileSummaryItem');
    final updatedAt = _reqString(json['updatedAt'], 'updatedAt');
    _parseIsoDateTime(updatedAt, 'updatedAt');
    final pendingKindRaw = json['pendingKind'];
    return MobileSummaryItem(
      threadId: _reqString(json['threadId'], 'threadId'),
      projectId: _reqString(json['projectId'], 'projectId'),
      projectName: _reqString(
        json['projectName'],
        'projectName',
        maxLength: _mobileSummaryLabelLimit,
      ),
      title: _reqString(
        json['title'],
        'title',
        maxLength: _mobileSummaryLabelLimit,
      ),
      updatedAt: updatedAt,
      status: MobileThreadStatus.fromWire(_reqString(json['status'], 'status')),
      pendingKind: pendingKindRaw != null
          ? MobileThreadPendingKind.fromWire(
              _reqString(pendingKindRaw, 'pendingKind'),
            )
          : null,
      pendingPreview: _optString(
        json['pendingPreview'],
        'pendingPreview',
        maxLength: mobileSummaryPreviewLimit,
      ),
      unread: _reqBool(json['unread'], 'unread'),
      pinned: _reqBool(json['pinned'], 'pinned'),
      agentName: _optString(
        json['agentName'],
        'agentName',
        maxLength: _mobileSummaryLabelLimit,
      ),
    );
  }

  Map<String, Object?> toJson() => {
    'threadId': threadId,
    'projectId': projectId,
    'projectName': projectName,
    'title': title,
    'updatedAt': updatedAt,
    'status': status.wire,
    'pendingKind': ?pendingKind?.wire,
    'pendingPreview': ?pendingPreview,
    'unread': unread,
    'pinned': pinned,
    'agentName': ?agentName,
  };

  @override
  bool operator ==(Object other) =>
      other is MobileSummaryItem &&
      other.threadId == threadId &&
      other.projectId == projectId &&
      other.projectName == projectName &&
      other.title == title &&
      other.updatedAt == updatedAt &&
      other.status == status &&
      other.pendingKind == pendingKind &&
      other.pendingPreview == pendingPreview &&
      other.unread == unread &&
      other.pinned == pinned &&
      other.agentName == agentName;

  @override
  int get hashCode => Object.hash(
    threadId,
    projectId,
    projectName,
    title,
    updatedAt,
    status,
    pendingKind,
    pendingPreview,
    unread,
    pinned,
    agentName,
  );
}

final class MobileComputerSummary {
  MobileComputerSummary({
    required this.computerId,
    required this.computerName,
    required this.syncedAt,
    required this.counts,
    required List<MobileSummaryItem> items,
    required this.truncated,
  }) : items = List<MobileSummaryItem>.unmodifiable(items);

  final String computerId;
  final String computerName;
  final DateTime syncedAt;
  final MobileSummaryCounts counts;
  final List<MobileSummaryItem> items;
  final bool truncated;

  factory MobileComputerSummary.fromJson(Map<String, dynamic> json) {
    _rejectUnknownKeys(json, const {
      'computerId',
      'computerName',
      'syncedAt',
      'counts',
      'items',
      'truncated',
    }, 'MobileComputerSummary');
    final computerId = _reqString(json['computerId'], 'computerId');
    if (!_computerIdRegex.hasMatch(computerId)) {
      throw const FormatException('Invalid computerId');
    }
    final computerName = _reqString(
      json['computerName'],
      'computerName',
      maxLength: _mobileSummaryComputerNameLimit,
    );
    final syncedAt = _parseIsoDateTime(
      _reqString(json['syncedAt'], 'syncedAt'),
      'syncedAt',
    );
    final countsRaw = json['counts'];
    if (countsRaw is! Map<String, dynamic>) {
      throw const FormatException('Invalid counts');
    }
    final itemsRaw = json['items'];
    if (itemsRaw is! List || itemsRaw.length > mobileSummaryMaxItems) {
      throw const FormatException('Invalid items');
    }
    final items = itemsRaw
        .map((entry) {
          if (entry is! Map<String, dynamic>) {
            throw const FormatException('Invalid summary item');
          }
          return MobileSummaryItem.fromJson(entry);
        })
        .toList(growable: false);
    return MobileComputerSummary(
      computerId: computerId,
      computerName: computerName,
      syncedAt: syncedAt,
      counts: MobileSummaryCounts.fromJson(countsRaw),
      items: items,
      truncated: _reqBool(json['truncated'], 'truncated'),
    );
  }

  Map<String, Object?> toJson() => {
    'computerId': computerId,
    'computerName': computerName,
    'syncedAt': syncedAt.toUtc().toIso8601String(),
    'counts': counts.toJson(),
    'items': items.map((item) => item.toJson()).toList(growable: false),
    'truncated': truncated,
  };

  @override
  bool operator ==(Object other) {
    if (other is! MobileComputerSummary) return false;
    if (other.computerId != computerId ||
        other.computerName != computerName ||
        other.syncedAt.toUtc() != syncedAt.toUtc() ||
        other.counts != counts ||
        other.truncated != truncated ||
        other.items.length != items.length) {
      return false;
    }
    for (var i = 0; i < items.length; i++) {
      if (other.items[i] != items[i]) return false;
    }
    return true;
  }

  @override
  int get hashCode => Object.hash(
    computerId,
    computerName,
    syncedAt.toUtc(),
    counts,
    Object.hashAll(items),
    truncated,
  );
}

int? _actionableRank(MobileThreadStatus status, bool unread) =>
    switch (status) {
      MobileThreadStatus.waitingApproval => 0,
      MobileThreadStatus.failed => 1,
      MobileThreadStatus.running || MobileThreadStatus.queued => null,
      _ => unread ? 2 : null,
    };

/// 与 Host 侧 `mobile.summary` 保持完全一致的互斥分类、优先级排序与截断规则，
/// 供当前活跃电脑实时复用及老版本桌面端降级汇总使用。
MobileComputerSummary summarizeSidebarSnapshot({
  required String computerId,
  required String computerName,
  required SidebarSnapshot snapshot,
  int maxItems = mobileSummaryMaxItems,
}) {
  if (maxItems < 0) {
    throw RangeError.value(maxItems, 'maxItems');
  }
  final projectNames = <String, String>{
    for (final project in snapshot.projects) project.id: project.name,
  };

  var attention = 0;
  var error = 0;
  var unread = 0;
  var working = 0;
  var total = 0;

  final candidates =
      <({int rank, DateTime updatedAt, MobileSummaryItem item})>[];

  for (final thread in snapshot.threads) {
    if (thread.archived) continue;
    final projectName = projectNames[thread.projectId];
    if (projectName == null) continue;

    total += 1;
    final rank = _actionableRank(thread.status, thread.unread);
    if (rank == 0) {
      attention += 1;
    } else if (rank == 1) {
      error += 1;
    } else if (thread.status == MobileThreadStatus.running ||
        thread.status == MobileThreadStatus.queued) {
      working += 1;
    } else if (rank == 2) {
      unread += 1;
    }

    if (rank == null) continue;

    candidates.add((
      rank: rank,
      updatedAt: DateTime.parse(thread.updatedAt).toUtc(),
      item: MobileSummaryItem(
        threadId: thread.id,
        projectId: thread.projectId,
        projectName: projectName,
        title: thread.title,
        updatedAt: thread.updatedAt,
        status: thread.status,
        pendingKind: thread.pendingKind,
        unread: thread.unread,
        pinned: thread.pinned,
        agentName: thread.agentName,
      ),
    ));
  }

  candidates.sort((a, b) {
    final rankCompare = a.rank.compareTo(b.rank);
    if (rankCompare != 0) return rankCompare;
    final timeCompare = b.updatedAt.compareTo(a.updatedAt);
    if (timeCompare != 0) return timeCompare;
    return a.item.threadId.compareTo(b.item.threadId);
  });

  final truncated = candidates.length > maxItems;
  final items = (truncated ? candidates.take(maxItems) : candidates)
      .map((entry) => entry.item)
      .toList(growable: false);

  return MobileComputerSummary(
    computerId: computerId,
    computerName: computerName,
    syncedAt: snapshot.syncedAt,
    counts: MobileSummaryCounts(
      attention: attention,
      error: error,
      unread: unread,
      working: working,
      total: total,
    ),
    items: items,
    truncated: truncated,
  );
}

class MobileSummaryClient {
  const MobileSummaryClient(
    this._rpc, {
    required this.supportsComputerSummary,
    required this.computerId,
    required this.computerName,
  });

  final HostRequests _rpc;
  final bool supportsComputerSummary;
  final String computerId;
  final String computerName;

  Future<MobileComputerSummary> fetch() async {
    if (supportsComputerSummary) {
      final raw = await _rpc.call(MobileSummaryMethods.summary, const {});
      if (raw is! Map<String, dynamic>) {
        throw const FormatException('Invalid mobile.summary response');
      }
      return MobileComputerSummary.fromJson(raw);
    }

    final projects = await _fetchAllPages<MobileProjectSummary>(
      (offset) async => decodeMobileProjectList(
        await _rpc.call(
          MobileSidebarMethods.projectList,
          MobileProjectListParams(
            offset: offset,
            limit: mobileSidebarPageSize,
          ).toJson(),
        ),
      ),
    );
    final threads = await _fetchAllPages<MobileThreadSummary>(
      (offset) async => decodeMobileThreadList(
        await _rpc.call(
          MobileSidebarMethods.threadList,
          MobileThreadListParams(
            offset: offset,
            limit: mobileSidebarPageSize,
          ).toJson(),
        ),
      ),
    );
    return summarizeSidebarSnapshot(
      computerId: computerId,
      computerName: computerName,
      snapshot: SidebarSnapshot(
        projects: projects,
        threads: threads,
        syncedAt: DateTime.now().toUtc(),
      ),
    );
  }
}

Future<List<T>> _fetchAllPages<T>(Future<List<T>> Function(int) request) async {
  final result = <T>[];
  while (true) {
    final page = await request(result.length);
    if (page.isEmpty) return result;
    result.addAll(page);
  }
}
