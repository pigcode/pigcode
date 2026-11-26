import '../host_rpc.dart';
import '../sidebar_models.dart';

abstract final class MobileScheduleMethods {
  static const list = 'mobile.schedule.list';
  static const create = 'mobile.schedule.create';
  static const update = 'mobile.schedule.update';
  static const delete = 'mobile.schedule.delete';
  static const runNow = 'mobile.schedule.runNow';
  static const runs = 'mobile.schedule.runs';
  static const deleteRun = 'mobile.schedule.deleteRun';
}

const defaultMobileSchedulePermissionMode = 'full-access';
const maxMobileScheduleEvery = 200;

final _clockTimeRegex = RegExp(r'^([01]\d|2[0-3]):[0-5]\d$');

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

int _intInRange(Object? raw, int min, int max, String field) {
  if (raw is! int || raw < min || raw > max) {
    throw FormatException('Invalid $field');
  }
  return raw;
}

int _nonNegInt(Object? raw, String field) {
  if (raw is! int || raw < 0) throw FormatException('Invalid $field');
  return raw;
}

String _clockTime(Object? raw, String field) {
  final value = _reqString(raw, field);
  if (!_clockTimeRegex.hasMatch(value)) {
    throw FormatException('Invalid $field');
  }
  return value;
}

List<int> _intListInRange(
  Object? raw,
  int min,
  int max,
  int maxItems,
  String field,
) {
  if (raw is! List || raw.isEmpty || raw.length > maxItems) {
    throw FormatException('Invalid $field');
  }
  return List<int>.unmodifiable(
    raw.map((item) => _intInRange(item, min, max, field)),
  );
}

sealed class MobileScheduleRule {
  const MobileScheduleRule();

  String get kind;

  Map<String, Object?> toJson();

  factory MobileScheduleRule.fromJson(Map<String, dynamic> json) {
    final kind = _reqString(json['kind'], 'kind');
    switch (kind) {
      case 'hourly':
        return MobileScheduleRuleHourly(
          minute: _intInRange(json['minute'], 0, 59, 'minute'),
        );
      case 'daily':
        return MobileScheduleRuleDaily(time: _clockTime(json['time'], 'time'));
      case 'weekdays':
        return MobileScheduleRuleWeekdays(
          time: _clockTime(json['time'], 'time'),
        );
      case 'weekly':
        return MobileScheduleRuleWeekly(
          days: _intListInRange(json['days'], 0, 6, 7, 'days'),
          time: _clockTime(json['time'], 'time'),
        );
      case 'monthly':
        return MobileScheduleRuleMonthly(
          day: _intInRange(json['day'], 1, 31, 'day'),
          time: _clockTime(json['time'], 'time'),
        );
      case 'everyMinutes':
        return MobileScheduleRuleEveryMinutes(
          every: _intInRange(json['every'], 1, maxMobileScheduleEvery, 'every'),
          anchor: _reqString(json['anchor'], 'anchor'),
        );
      case 'everyHours':
        return MobileScheduleRuleEveryHours(
          every: _intInRange(json['every'], 1, maxMobileScheduleEvery, 'every'),
          minute: _intInRange(json['minute'], 0, 59, 'minute'),
          anchor: _reqString(json['anchor'], 'anchor'),
        );
      case 'everyDays':
        return MobileScheduleRuleEveryDays(
          every: _intInRange(json['every'], 1, maxMobileScheduleEvery, 'every'),
          time: _clockTime(json['time'], 'time'),
          anchor: _reqString(json['anchor'], 'anchor'),
        );
      case 'everyWeeks':
        return MobileScheduleRuleEveryWeeks(
          every: _intInRange(json['every'], 1, maxMobileScheduleEvery, 'every'),
          days: _intListInRange(json['days'], 0, 6, 7, 'days'),
          time: _clockTime(json['time'], 'time'),
          anchor: _reqString(json['anchor'], 'anchor'),
        );
      case 'everyMonths':
        return MobileScheduleRuleEveryMonths(
          every: _intInRange(json['every'], 1, maxMobileScheduleEvery, 'every'),
          days: _intListInRange(json['days'], 1, 31, 31, 'days'),
          time: _clockTime(json['time'], 'time'),
          anchor: _reqString(json['anchor'], 'anchor'),
        );
      case 'everyMonthsWeekday':
        return MobileScheduleRuleEveryMonthsWeekday(
          every: _intInRange(json['every'], 1, maxMobileScheduleEvery, 'every'),
          weekday: _intInRange(json['weekday'], 0, 6, 'weekday'),
          time: _clockTime(json['time'], 'time'),
          anchor: _reqString(json['anchor'], 'anchor'),
        );
      case 'everyYears':
        return MobileScheduleRuleEveryYears(
          every: _intInRange(json['every'], 1, maxMobileScheduleEvery, 'every'),
          month: _intInRange(json['month'], 1, 12, 'month'),
          day: _intInRange(json['day'], 1, 31, 'day'),
          time: _clockTime(json['time'], 'time'),
          anchor: _reqString(json['anchor'], 'anchor'),
        );
      default:
        throw FormatException('Unknown schedule rule kind: $kind');
    }
  }
}

final class MobileScheduleRuleHourly extends MobileScheduleRule {
  const MobileScheduleRuleHourly({required this.minute});

  final int minute;

  @override
  String get kind => 'hourly';

  @override
  Map<String, Object?> toJson() => {'kind': kind, 'minute': minute};
}

final class MobileScheduleRuleDaily extends MobileScheduleRule {
  const MobileScheduleRuleDaily({required this.time});

  final String time;

  @override
  String get kind => 'daily';

  @override
  Map<String, Object?> toJson() => {'kind': kind, 'time': time};
}

final class MobileScheduleRuleWeekdays extends MobileScheduleRule {
  const MobileScheduleRuleWeekdays({required this.time});

  final String time;

  @override
  String get kind => 'weekdays';

  @override
  Map<String, Object?> toJson() => {'kind': kind, 'time': time};
}

final class MobileScheduleRuleWeekly extends MobileScheduleRule {
  const MobileScheduleRuleWeekly({required this.days, required this.time});

  final List<int> days;
  final String time;

  @override
  String get kind => 'weekly';

  @override
  Map<String, Object?> toJson() => {
    'kind': kind,
    'days': days.toList(growable: false),
    'time': time,
  };
}

final class MobileScheduleRuleMonthly extends MobileScheduleRule {
  const MobileScheduleRuleMonthly({required this.day, required this.time});

  final int day;
  final String time;

  @override
  String get kind => 'monthly';

  @override
  Map<String, Object?> toJson() => {'kind': kind, 'day': day, 'time': time};
}

final class MobileScheduleRuleEveryMinutes extends MobileScheduleRule {
  const MobileScheduleRuleEveryMinutes({
    required this.every,
    required this.anchor,
  });

  final int every;
  final String anchor;

  @override
  String get kind => 'everyMinutes';

  @override
  Map<String, Object?> toJson() => {
    'kind': kind,
    'every': every,
    'anchor': anchor,
  };
}

final class MobileScheduleRuleEveryHours extends MobileScheduleRule {
  const MobileScheduleRuleEveryHours({
    required this.every,
    required this.minute,
    required this.anchor,
  });

  final int every;
  final int minute;
  final String anchor;

  @override
  String get kind => 'everyHours';

  @override
  Map<String, Object?> toJson() => {
    'kind': kind,
    'every': every,
    'minute': minute,
    'anchor': anchor,
  };
}

final class MobileScheduleRuleEveryDays extends MobileScheduleRule {
  const MobileScheduleRuleEveryDays({
    required this.every,
    required this.time,
    required this.anchor,
  });

  final int every;
  final String time;
  final String anchor;

  @override
  String get kind => 'everyDays';

  @override
  Map<String, Object?> toJson() => {
    'kind': kind,
    'every': every,
    'time': time,
    'anchor': anchor,
  };
}

final class MobileScheduleRuleEveryWeeks extends MobileScheduleRule {
  const MobileScheduleRuleEveryWeeks({
    required this.every,
    required this.days,
    required this.time,
    required this.anchor,
  });

  final int every;
  final List<int> days;
  final String time;
  final String anchor;

  @override
  String get kind => 'everyWeeks';

  @override
  Map<String, Object?> toJson() => {
    'kind': kind,
    'every': every,
    'days': days.toList(growable: false),
    'time': time,
    'anchor': anchor,
  };
}

final class MobileScheduleRuleEveryMonths extends MobileScheduleRule {
  const MobileScheduleRuleEveryMonths({
    required this.every,
    required this.days,
    required this.time,
    required this.anchor,
  });

  final int every;
  final List<int> days;
  final String time;
  final String anchor;

  @override
  String get kind => 'everyMonths';

  @override
  Map<String, Object?> toJson() => {
    'kind': kind,
    'every': every,
    'days': days.toList(growable: false),
    'time': time,
    'anchor': anchor,
  };
}

final class MobileScheduleRuleEveryMonthsWeekday extends MobileScheduleRule {
  const MobileScheduleRuleEveryMonthsWeekday({
    required this.every,
    required this.weekday,
    required this.time,
    required this.anchor,
  });

  final int every;
  final int weekday;
  final String time;
  final String anchor;

  @override
  String get kind => 'everyMonthsWeekday';

  @override
  Map<String, Object?> toJson() => {
    'kind': kind,
    'every': every,
    'weekday': weekday,
    'time': time,
    'anchor': anchor,
  };
}

final class MobileScheduleRuleEveryYears extends MobileScheduleRule {
  const MobileScheduleRuleEveryYears({
    required this.every,
    required this.month,
    required this.day,
    required this.time,
    required this.anchor,
  });

  final int every;
  final int month;
  final int day;
  final String time;
  final String anchor;

  @override
  String get kind => 'everyYears';

  @override
  Map<String, Object?> toJson() => {
    'kind': kind,
    'every': every,
    'month': month,
    'day': day,
    'time': time,
    'anchor': anchor,
  };
}

const _weekdayChars = <int, String>{
  0: '日',
  1: '一',
  2: '二',
  3: '三',
  4: '四',
  5: '五',
  6: '六',
};

int _weekdayOrder(int day) => day == 0 ? 7 : day;

String _formatWeekdays(List<int> days) {
  final unique = days.toSet().toList()
    ..sort((a, b) => _weekdayOrder(a).compareTo(_weekdayOrder(b)));
  return unique.map((day) => _weekdayChars[day] ?? '$day').join('、');
}

String _formatMonthDays(List<int> days) {
  final unique = days.toSet().toList()..sort();
  return unique.join('、');
}

/// 将 12 种定时规则格式化为可读中文摘要。
String describeScheduleRule(MobileScheduleRule rule) => switch (rule) {
  MobileScheduleRuleHourly(:final minute) => '每小时第 $minute 分',
  MobileScheduleRuleDaily(:final time) => '每天 $time',
  MobileScheduleRuleWeekdays(:final time) => '工作日 $time',
  MobileScheduleRuleWeekly(:final days, :final time) =>
    '每周${_formatWeekdays(days)} $time',
  MobileScheduleRuleMonthly(:final day, :final time) => '每月 $day 日 $time',
  MobileScheduleRuleEveryMinutes(:final every) => '每 $every 分钟',
  MobileScheduleRuleEveryHours(:final every, :final minute) =>
    '每 $every 小时第 $minute 分',
  MobileScheduleRuleEveryDays(:final every, :final time) => '每 $every 天 $time',
  MobileScheduleRuleEveryWeeks(:final every, :final days, :final time) =>
    '每 $every 周 ${_formatWeekdays(days)} $time',
  MobileScheduleRuleEveryMonths(:final every, :final days, :final time) =>
    '每 $every 个月 ${_formatMonthDays(days)} 日 $time',
  MobileScheduleRuleEveryMonthsWeekday(
    :final every,
    :final weekday,
    :final time,
  ) =>
    '每 $every 个月首个周${_weekdayChars[weekday] ?? '$weekday'} $time',
  MobileScheduleRuleEveryYears(
    :final every,
    :final month,
    :final day,
    :final time,
  ) =>
    '每 $every 年 $month 月 $day 日 $time',
};

final class MobileScheduleWorktree {
  const MobileScheduleWorktree({this.baseRef});

  final String? baseRef;

  factory MobileScheduleWorktree.fromJson(Map<String, dynamic> json) =>
      MobileScheduleWorktree(baseRef: json['baseRef'] as String?);

  Map<String, Object?> toJson() => {'baseRef': ?baseRef};
}

final class MobileScheduleExecution {
  const MobileScheduleExecution({
    this.instanceId,
    this.modelId,
    this.effort,
    this.fast,
    this.ultracode,
    this.planMode,
    this.worktree,
    this.permissionMode = defaultMobileSchedulePermissionMode,
  });

  final String? instanceId;
  final String? modelId;
  final String? effort;
  final bool? fast;
  final bool? ultracode;
  final bool? planMode;
  final MobileScheduleWorktree? worktree;
  final String permissionMode;

  factory MobileScheduleExecution.fromJson(Map<String, dynamic> json) {
    final worktreeRaw = json['worktree'];
    return MobileScheduleExecution(
      instanceId: json['instanceId'] as String?,
      modelId: json['modelId'] as String?,
      effort: json['effort'] as String?,
      fast: json['fast'] as bool?,
      ultracode: json['ultracode'] as bool?,
      planMode: json['planMode'] as bool?,
      worktree: worktreeRaw is Map<String, dynamic>
          ? MobileScheduleWorktree.fromJson(worktreeRaw)
          : null,
      permissionMode:
          (json['permissionMode'] as String?) ??
          defaultMobileSchedulePermissionMode,
    );
  }

  Map<String, Object?> toJson() => {
    'instanceId': ?instanceId,
    'modelId': ?modelId,
    'effort': ?effort,
    'fast': ?fast,
    'ultracode': ?ultracode,
    'planMode': ?planMode,
    if (worktree != null) 'worktree': worktree!.toJson(),
    'permissionMode': permissionMode,
  };
}

sealed class MobileScheduleTarget {
  const MobileScheduleTarget();

  String get kind;

  Map<String, Object?> toJson();

  factory MobileScheduleTarget.fromJson(Map<String, dynamic> json) {
    final kind = _reqString(json['kind'], 'kind');
    switch (kind) {
      case 'project':
        final executionRaw = json['execution'];
        if (executionRaw is! Map<String, dynamic>) {
          throw const FormatException('Invalid schedule execution');
        }
        return MobileScheduleProjectTarget(
          projectId: _reqString(json['projectId'], 'projectId'),
          execution: MobileScheduleExecution.fromJson(executionRaw),
        );
      case 'thread':
        return MobileScheduleThreadTarget(
          threadId: _reqString(json['threadId'], 'threadId'),
        );
      default:
        throw FormatException('Unknown schedule target kind: $kind');
    }
  }
}

final class MobileScheduleProjectTarget extends MobileScheduleTarget {
  const MobileScheduleProjectTarget({
    required this.projectId,
    required this.execution,
  });

  final String projectId;
  final MobileScheduleExecution execution;

  @override
  String get kind => 'project';

  @override
  Map<String, Object?> toJson() => {
    'kind': kind,
    'projectId': projectId,
    'execution': execution.toJson(),
  };
}

final class MobileScheduleThreadTarget extends MobileScheduleTarget {
  const MobileScheduleThreadTarget({required this.threadId});

  final String threadId;

  @override
  String get kind => 'thread';

  @override
  Map<String, Object?> toJson() => {'kind': kind, 'threadId': threadId};
}

enum MobileScheduleStatus {
  active('active'),
  paused('paused'),
  completed('completed');

  const MobileScheduleStatus(this.wireValue);
  final String wireValue;

  static MobileScheduleStatus fromWireValue(String value) {
    for (final status in values) {
      if (status.wireValue == value) return status;
    }
    throw FormatException('Unknown schedule status: $value');
  }
}

final class MobileSchedule {
  const MobileSchedule({
    required this.id,
    required this.target,
    this.projectName,
    this.threadTitle,
    required this.title,
    required this.prompt,
    required this.rule,
    this.endsAt,
    required this.enabled,
    required this.status,
    this.nextRunAt,
    this.lastRunAt,
    this.lastRunId,
    required this.runCount,
    required this.createdAt,
    required this.updatedAt,
  });

  final String id;
  final MobileScheduleTarget target;
  final String? projectName;
  final String? threadTitle;
  final String title;
  final String prompt;
  final MobileScheduleRule rule;
  final String? endsAt;
  final bool enabled;
  final MobileScheduleStatus status;
  final String? nextRunAt;
  final String? lastRunAt;
  final String? lastRunId;
  final int runCount;
  final String createdAt;
  final String updatedAt;

  factory MobileSchedule.fromJson(Map<String, dynamic> json) {
    final targetRaw = json['target'];
    final ruleRaw = json['rule'];
    if (targetRaw is! Map<String, dynamic> ||
        ruleRaw is! Map<String, dynamic>) {
      throw const FormatException('Invalid schedule payload');
    }
    return MobileSchedule(
      id: _reqString(json['id'], 'id'),
      target: MobileScheduleTarget.fromJson(targetRaw),
      projectName: json['projectName'] as String?,
      threadTitle: json['threadTitle'] as String?,
      title: _str(json['title'], 'title'),
      prompt: _reqString(json['prompt'], 'prompt'),
      rule: MobileScheduleRule.fromJson(ruleRaw),
      endsAt: json['endsAt'] as String?,
      enabled: _reqBool(json['enabled'], 'enabled'),
      status: MobileScheduleStatus.fromWireValue(
        _reqString(json['status'], 'status'),
      ),
      nextRunAt: json['nextRunAt'] as String?,
      lastRunAt: json['lastRunAt'] as String?,
      lastRunId: json['lastRunId'] as String?,
      runCount: _nonNegInt(json['runCount'], 'runCount'),
      createdAt: _reqString(json['createdAt'], 'createdAt'),
      updatedAt: _reqString(json['updatedAt'], 'updatedAt'),
    );
  }

  Map<String, Object?> toJson() => {
    'id': id,
    'target': target.toJson(),
    'projectName': projectName,
    'threadTitle': threadTitle,
    'title': title,
    'prompt': prompt,
    'rule': rule.toJson(),
    'endsAt': endsAt,
    'enabled': enabled,
    'status': status.wireValue,
    'nextRunAt': nextRunAt,
    'lastRunAt': lastRunAt,
    'lastRunId': lastRunId,
    'runCount': runCount,
    'createdAt': createdAt,
    'updatedAt': updatedAt,
  };
}

final class MobileScheduleListResult {
  const MobileScheduleListResult({
    required this.schedules,
    required this.truncated,
  });

  final List<MobileSchedule> schedules;
  final bool truncated;

  factory MobileScheduleListResult.fromJson(Map<String, dynamic> json) {
    final list = json['schedules'];
    if (list is! List) throw const FormatException('Invalid schedules list');
    return MobileScheduleListResult(
      schedules: List<MobileSchedule>.unmodifiable(
        list.map(
          (item) => MobileSchedule.fromJson(item as Map<String, dynamic>),
        ),
      ),
      truncated: _reqBool(json['truncated'], 'truncated'),
    );
  }

  Map<String, Object?> toJson() => {
    'schedules': schedules.map((item) => item.toJson()).toList(growable: false),
    'truncated': truncated,
  };
}

enum MobileScheduleRunSource {
  schedule('schedule'),
  manual('manual');

  const MobileScheduleRunSource(this.wireValue);
  final String wireValue;

  static MobileScheduleRunSource fromWireValue(String value) {
    for (final source in values) {
      if (source.wireValue == value) return source;
    }
    throw FormatException('Unknown schedule run source: $value');
  }
}

enum MobileScheduleRunStatus {
  running('running'),
  succeeded('succeeded'),
  failed('failed'),
  stopped('stopped'),
  skipped('skipped');

  const MobileScheduleRunStatus(this.wireValue);
  final String wireValue;

  static MobileScheduleRunStatus fromWireValue(String value) {
    for (final status in values) {
      if (status.wireValue == value) return status;
    }
    throw FormatException('Unknown schedule run status: $value');
  }
}

final class MobileScheduleRun {
  const MobileScheduleRun({
    required this.id,
    required this.scheduleId,
    required this.source,
    required this.status,
    this.threadId,
    this.runId,
    this.error,
    required this.triggeredAt,
    this.finishedAt,
  });

  final String id;
  final String scheduleId;
  final MobileScheduleRunSource source;
  final MobileScheduleRunStatus status;
  final String? threadId;
  final String? runId;
  final String? error;
  final String triggeredAt;
  final String? finishedAt;

  factory MobileScheduleRun.fromJson(Map<String, dynamic> json) =>
      MobileScheduleRun(
        id: _reqString(json['id'], 'id'),
        scheduleId: _reqString(json['scheduleId'], 'scheduleId'),
        source: MobileScheduleRunSource.fromWireValue(
          _reqString(json['source'], 'source'),
        ),
        status: MobileScheduleRunStatus.fromWireValue(
          _reqString(json['status'], 'status'),
        ),
        threadId: json['threadId'] as String?,
        runId: json['runId'] as String?,
        error: json['error'] as String?,
        triggeredAt: _reqString(json['triggeredAt'], 'triggeredAt'),
        finishedAt: json['finishedAt'] as String?,
      );

  Map<String, Object?> toJson() => {
    'id': id,
    'scheduleId': scheduleId,
    'source': source.wireValue,
    'status': status.wireValue,
    'threadId': threadId,
    'runId': runId,
    'error': error,
    'triggeredAt': triggeredAt,
    'finishedAt': finishedAt,
  };
}

enum MobileScheduleRunNowStatus {
  started('started'),
  busy('busy'),
  unavailable('unavailable'),
  failed('failed');

  const MobileScheduleRunNowStatus(this.wireValue);
  final String wireValue;

  static MobileScheduleRunNowStatus fromWireValue(String value) {
    for (final status in values) {
      if (status.wireValue == value) return status;
    }
    throw FormatException('Unknown runNow status: $value');
  }
}

final class MobileScheduleRunNowResult {
  const MobileScheduleRunNowResult({required this.status, this.runId});

  final MobileScheduleRunNowStatus status;
  final String? runId;

  factory MobileScheduleRunNowResult.fromJson(Map<String, dynamic> json) =>
      MobileScheduleRunNowResult(
        status: MobileScheduleRunNowStatus.fromWireValue(
          _reqString(json['status'], 'status'),
        ),
        runId: json['runId'] as String?,
      );

  Map<String, Object?> toJson() => {'status': status.wireValue, 'runId': runId};
}

final class MobileScheduleRunsPage {
  const MobileScheduleRunsPage({required this.runs, required this.total});

  final List<MobileScheduleRun> runs;
  final int total;

  factory MobileScheduleRunsPage.fromJson(Map<String, dynamic> json) {
    final list = json['runs'];
    if (list is! List) throw const FormatException('Invalid schedule runs');
    return MobileScheduleRunsPage(
      runs: List<MobileScheduleRun>.unmodifiable(
        list.map(
          (item) => MobileScheduleRun.fromJson(item as Map<String, dynamic>),
        ),
      ),
      total: _nonNegInt(json['total'], 'total'),
    );
  }

  Map<String, Object?> toJson() => {
    'runs': runs.map((item) => item.toJson()).toList(growable: false),
    'total': total,
  };
}

class MobileScheduleManageClient {
  MobileScheduleManageClient(this._rpc, {required this.supportsScheduleManage});

  final HostRequests _rpc;
  final bool supportsScheduleManage;

  void _ensureSupported() {
    if (!supportsScheduleManage) {
      throw const MobileRpcFailure(
        MobileRpcProblem(
          code: 'METHOD_NOT_AVAILABLE',
          message: '当前电脑版本不支持在手机端管理定时任务，请升级电脑端 Pigcode。',
          retryable: false,
        ),
      );
    }
  }

  Future<MobileScheduleListResult> list() async {
    _ensureSupported();
    final raw =
        await _rpc.call(MobileScheduleMethods.list, const {})
            as Map<String, dynamic>;
    return MobileScheduleListResult.fromJson(raw);
  }

  Future<MobileSchedule> create({
    required String projectId,
    String? title,
    required String prompt,
    required MobileScheduleRule rule,
    String? endsAt,
    bool? enabled,
    MobileScheduleExecution? execution,
  }) async {
    _ensureSupported();
    final raw =
        await _rpc.call(MobileScheduleMethods.create, {
              'projectId': projectId,
              if (title != null) 'title': title.trim(),
              'prompt': prompt.trim(),
              'rule': rule.toJson(),
              'endsAt': ?endsAt,
              'enabled': ?enabled,
              if (execution != null) 'execution': execution.toJson(),
            })
            as Map<String, dynamic>;
    return MobileSchedule.fromJson(raw);
  }

  Future<MobileSchedule> update({
    required String id,
    String? title,
    String? prompt,
    MobileScheduleRule? rule,
    String? endsAt,
    bool clearEndsAt = false,
    bool? enabled,
    MobileScheduleExecution? execution,
  }) async {
    _ensureSupported();
    final raw =
        await _rpc.call(MobileScheduleMethods.update, {
              'id': id,
              if (title != null) 'title': title.trim(),
              if (prompt != null) 'prompt': prompt.trim(),
              if (rule != null) 'rule': rule.toJson(),
              if (clearEndsAt) 'endsAt': null else 'endsAt': ?endsAt,
              'enabled': ?enabled,
              if (execution != null) 'execution': execution.toJson(),
            })
            as Map<String, dynamic>;
    return MobileSchedule.fromJson(raw);
  }

  Future<bool> delete({required String id}) async {
    _ensureSupported();
    final raw =
        await _rpc.call(MobileScheduleMethods.delete, {'id': id})
            as Map<String, dynamic>;
    return _reqBool(raw['deleted'], 'deleted');
  }

  Future<MobileScheduleRunNowResult> runNow({required String id}) async {
    _ensureSupported();
    final raw =
        await _rpc.call(MobileScheduleMethods.runNow, {'id': id})
            as Map<String, dynamic>;
    return MobileScheduleRunNowResult.fromJson(raw);
  }

  Future<MobileScheduleRunsPage> runs({
    required String id,
    int limit = 20,
    int offset = 0,
  }) async {
    _ensureSupported();
    final raw =
        await _rpc.call(MobileScheduleMethods.runs, {
              'id': id,
              'limit': limit,
              'offset': offset,
            })
            as Map<String, dynamic>;
    return MobileScheduleRunsPage.fromJson(raw);
  }

  Future<bool> deleteRun({required String id}) async {
    _ensureSupported();
    final raw =
        await _rpc.call(MobileScheduleMethods.deleteRun, {'id': id})
            as Map<String, dynamic>;
    return _reqBool(raw['deleted'], 'deleted');
  }
}
