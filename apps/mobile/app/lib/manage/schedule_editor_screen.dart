import 'dart:async';
import 'dart:convert';

import 'package:flutter/cupertino.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';

import '../app_theme.dart';
import '../composer/composer_catalog.dart';
import '../mobile_glass.dart';
import '../mobile_sheet.dart';
import '../theme_colors.dart';
import '../timeline/timeline_tokens.dart';
import '../workspace_icon.dart';
import 'manage_form_widgets.dart';
import 'manage_utils.dart';

enum _ScheduleFrequency { hourly, daily, weekdays, weekly, monthly, custom }

enum _CustomUnit { minute, hour, day, week, month, year }

enum _CustomMonthMode { date, weekday }

const _weekOrder = <int>[1, 2, 3, 4, 5, 6, 0];
const _weekdayLabels = <int, String>{
  0: '周日',
  1: '周一',
  2: '周二',
  3: '周三',
  4: '周四',
  5: '周五',
  6: '周六',
};

const _permissionChoices = <MobileDraftPermission>[
  MobileDraftPermission.fullAccess,
  MobileDraftPermission.auto,
  MobileDraftPermission.autoAcceptEdits,
  MobileDraftPermission.approvalRequired,
];

String _pad2(int value) => value.toString().padLeft(2, '0');

String _formatTimeOfDay(TimeOfDay time) =>
    '${_pad2(time.hour)}:${_pad2(time.minute)}';

TimeOfDay _parseClockTime(String raw) {
  final parts = raw.split(':');
  if (parts.length == 2) {
    final h = int.tryParse(parts[0]);
    final m = int.tryParse(parts[1]);
    if (h != null && m != null && h >= 0 && h <= 23 && m >= 0 && m <= 59) {
      return TimeOfDay(hour: h, minute: m);
    }
  }
  return const TimeOfDay(hour: 9, minute: 0);
}

String _formatDateYmd(DateTime date) =>
    '${date.year}-${_pad2(date.month)}-${_pad2(date.day)}';

bool _sameLocalDay(DateTime a, DateTime b) =>
    a.year == b.year && a.month == b.month && a.day == b.day;

/// 定时任务新建与编辑页：完整支持 12 种触发规则、结束日期、Agent/模型/权限/Worktree 运行设置与删除确认。
class ScheduleEditorScreen extends StatefulWidget {
  const ScheduleEditorScreen({
    super.key,
    required this.connectionListenable,
    this.computerName,
    this.schedule,
    this.projects = const [],
    this.initialTitle,
    this.initialPrompt,
    this.initialRule,
  });

  static const saveButtonKey = ValueKey('schedule-editor-save');
  static const deleteButtonKey = ValueKey('schedule-editor-delete');
  static const deleteConfirmKey = ValueKey('schedule-editor-delete-confirm');
  static const titleInputKey = ValueKey('schedule-editor-title');
  static const promptInputKey = ValueKey('schedule-editor-prompt');
  static const projectFieldKey = ValueKey('schedule-editor-project');
  static const rulePreviewKey = ValueKey('schedule-rule-preview');
  static const ruleTimeKey = ValueKey('schedule-rule-time');
  static const ruleMinuteKey = ValueKey('schedule-rule-minute');
  static const monthDayKey = ValueKey('schedule-month-day');
  static const customEveryKey = ValueKey('schedule-custom-every');
  static const customMonthModeDateKey = ValueKey(
    'schedule-custom-month-mode-date',
  );
  static const customMonthModeWeekdayKey = ValueKey(
    'schedule-custom-month-mode-weekday',
  );
  static const customMonthWeekdayKey = ValueKey(
    'schedule-custom-month-weekday',
  );
  static const customYearMonthKey = ValueKey('schedule-custom-year-month');
  static const customYearDayKey = ValueKey('schedule-custom-year-day');
  static const endsToggleKey = ValueKey('schedule-ends-toggle');
  static const endsDateKey = ValueKey('schedule-ends-date');
  static const execAgentKey = ValueKey('schedule-exec-agent');
  static const execModelKey = ValueKey('schedule-exec-model');
  static const execPermissionKey = ValueKey('schedule-exec-permission');
  static const execWorktreeKey = ValueKey('schedule-exec-worktree');

  static ValueKey<String> frequencyKey(String id) =>
      ValueKey('schedule-freq-$id');
  static ValueKey<String> customUnitKey(String unit) =>
      ValueKey('schedule-custom-unit-$unit');
  static ValueKey<String> weekdayKey(int day) =>
      ValueKey('schedule-weekday-$day');
  static ValueKey<String> customMonthDayKey(int day) =>
      ValueKey('schedule-custom-month-day-$day');

  final ValueListenable<MobileConnection?> connectionListenable;
  final String? computerName;
  final MobileSchedule? schedule;
  final List<MobileProjectSummary> projects;
  final String? initialTitle;
  final String? initialPrompt;
  final MobileScheduleRule? initialRule;

  bool get isCreate => schedule == null;

  static Future<bool?> open(
    BuildContext context, {
    required ValueListenable<MobileConnection?> connectionListenable,
    String? computerName,
    MobileSchedule? schedule,
    List<MobileProjectSummary> projects = const [],
    String? initialTitle,
    String? initialPrompt,
    MobileScheduleRule? initialRule,
  }) => Navigator.of(context).push<bool>(
    MaterialPageRoute<bool>(
      builder: (_) => ScheduleEditorScreen(
        connectionListenable: connectionListenable,
        computerName: computerName,
        schedule: schedule,
        projects: projects,
        initialTitle: initialTitle,
        initialPrompt: initialPrompt,
        initialRule: initialRule,
      ),
    ),
  );

  @override
  State<ScheduleEditorScreen> createState() => _ScheduleEditorScreenState();
}

class _ScheduleEditorScreenState extends State<ScheduleEditorScreen> {
  MobileConnection? _connection;
  bool _saving = false;
  bool _deleting = false;
  String? _validationError;

  late final TextEditingController _titleController;
  late final TextEditingController _promptController;
  late final TextEditingController _everyController;

  List<MobileProjectSummary> _projects = const [];
  String? _selectedProjectId;
  bool _loadingProjects = false;

  late _ScheduleFrequency _frequency;
  late _CustomUnit _customUnit;
  late int _minute;
  late TimeOfDay _time;
  late Set<int> _weekDays;
  late int _monthDay;
  late _CustomMonthMode _customMonthMode;
  late Set<int> _customMonthDays;
  late int _customMonthWeekday;
  late int _yearMonth;
  late int _yearDay;
  late String _anchor;

  late bool _hasEndDate;
  late DateTime _endDate;
  DateTime? _initialEndDateLocal;

  // Execution settings (project schedules only).
  String? _instanceId;
  String? _modelId;
  late String _permissionMode;
  late bool _useWorktree;

  bool _loadingAgents = false;
  List<MobileAgentSummary> _agents = const [];
  bool _loadingModels = false;
  List<MobileAgentModelItem> _models = const [];
  int _modelsSeq = 0;

  bool get _isLegacyThread =>
      widget.schedule?.target is MobileScheduleThreadTarget;

  MobileScheduleExecution? get _initialExecution =>
      switch (widget.schedule?.target) {
        MobileScheduleProjectTarget(:final execution) => execution,
        _ => null,
      };

  @override
  void initState() {
    super.initState();
    _connection = widget.connectionListenable.value;
    widget.connectionListenable.addListener(_onConnectionChanged);

    final existing = widget.schedule;
    _titleController = TextEditingController(
      text: existing?.title ?? widget.initialTitle ?? '',
    );
    _promptController = TextEditingController(
      text: existing?.prompt ?? widget.initialPrompt ?? '',
    );

    _projects = List<MobileProjectSummary>.of(widget.projects);
    if (existing != null) {
      if (existing.target case MobileScheduleProjectTarget(:final projectId)) {
        _selectedProjectId = projectId;
      }
    } else if (_projects.isNotEmpty) {
      _selectedProjectId = _projects.first.id;
    }

    final initialRule =
        existing?.rule ??
        widget.initialRule ??
        const MobileScheduleRuleDaily(time: '09:00');
    _initRuleState(initialRule, existing?.endsAt);

    final exec = _initialExecution;
    _instanceId = exec?.instanceId;
    _modelId = exec?.modelId;
    _permissionMode =
        exec?.permissionMode ?? defaultMobileSchedulePermissionMode;
    _useWorktree = exec?.worktree != null;

    if (widget.isCreate && _projects.isEmpty) {
      unawaited(_loadProjects());
    }
    if (!_isLegacyThread) {
      unawaited(_loadAgents());
      if (_instanceId != null) {
        unawaited(_loadModels(_instanceId!));
      }
    }
  }

  void _initRuleState(MobileScheduleRule rule, String? endsAt) {
    final now = DateTime.now();
    final todayWeekday = now.weekday % 7;

    _frequency = switch (rule) {
      MobileScheduleRuleHourly() => _ScheduleFrequency.hourly,
      MobileScheduleRuleDaily() => _ScheduleFrequency.daily,
      MobileScheduleRuleWeekdays() => _ScheduleFrequency.weekdays,
      MobileScheduleRuleWeekly() => _ScheduleFrequency.weekly,
      MobileScheduleRuleMonthly() => _ScheduleFrequency.monthly,
      _ => _ScheduleFrequency.custom,
    };

    _customUnit = switch (rule) {
      MobileScheduleRuleEveryMinutes() => _CustomUnit.minute,
      MobileScheduleRuleHourly() ||
      MobileScheduleRuleEveryHours() => _CustomUnit.hour,
      MobileScheduleRuleDaily() ||
      MobileScheduleRuleEveryDays() => _CustomUnit.day,
      MobileScheduleRuleWeekdays() ||
      MobileScheduleRuleWeekly() ||
      MobileScheduleRuleEveryWeeks() => _CustomUnit.week,
      MobileScheduleRuleEveryYears() => _CustomUnit.year,
      MobileScheduleRuleMonthly() ||
      MobileScheduleRuleEveryMonths() ||
      MobileScheduleRuleEveryMonthsWeekday() => _CustomUnit.month,
    };

    final initialEvery = switch (rule) {
      MobileScheduleRuleEveryMinutes(:final every) => every,
      MobileScheduleRuleEveryHours(:final every) => every,
      MobileScheduleRuleEveryDays(:final every) => every,
      MobileScheduleRuleEveryWeeks(:final every) => every,
      MobileScheduleRuleEveryMonths(:final every) => every,
      MobileScheduleRuleEveryMonthsWeekday(:final every) => every,
      MobileScheduleRuleEveryYears(:final every) => every,
      _ => 1,
    };
    _everyController = TextEditingController(text: '$initialEvery');

    _minute = switch (rule) {
      MobileScheduleRuleHourly(:final minute) => minute,
      MobileScheduleRuleEveryHours(:final minute) => minute,
      _ => 0,
    };

    final clockStr = switch (rule) {
      MobileScheduleRuleDaily(:final time) => time,
      MobileScheduleRuleWeekdays(:final time) => time,
      MobileScheduleRuleWeekly(:final time) => time,
      MobileScheduleRuleMonthly(:final time) => time,
      MobileScheduleRuleEveryDays(:final time) => time,
      MobileScheduleRuleEveryWeeks(:final time) => time,
      MobileScheduleRuleEveryMonths(:final time) => time,
      MobileScheduleRuleEveryMonthsWeekday(:final time) => time,
      MobileScheduleRuleEveryYears(:final time) => time,
      _ => '09:00',
    };
    _time = _parseClockTime(clockStr);

    _weekDays = switch (rule) {
      MobileScheduleRuleWeekly(:final days) => Set<int>.of(days),
      MobileScheduleRuleEveryWeeks(:final days) => Set<int>.of(days),
      MobileScheduleRuleWeekdays() => {1, 2, 3, 4, 5},
      _ => {todayWeekday},
    };

    _monthDay = switch (rule) {
      MobileScheduleRuleMonthly(:final day) => day,
      MobileScheduleRuleEveryMonths(:final days) when days.isNotEmpty =>
        days.first,
      _ => now.day,
    };

    _customMonthMode = rule is MobileScheduleRuleEveryMonthsWeekday
        ? _CustomMonthMode.weekday
        : _CustomMonthMode.date;

    _customMonthDays = switch (rule) {
      MobileScheduleRuleEveryMonths(:final days) => Set<int>.of(days),
      MobileScheduleRuleMonthly(:final day) => {day},
      _ => {now.day},
    };

    _customMonthWeekday = switch (rule) {
      MobileScheduleRuleEveryMonthsWeekday(:final weekday) => weekday,
      _ => todayWeekday,
    };

    _yearMonth = switch (rule) {
      MobileScheduleRuleEveryYears(:final month) => month,
      _ => now.month,
    };

    _yearDay = switch (rule) {
      MobileScheduleRuleEveryYears(:final day) => day,
      _ => now.day,
    };

    _anchor = switch (rule) {
      MobileScheduleRuleEveryMinutes(:final anchor) => anchor,
      MobileScheduleRuleEveryHours(:final anchor) => anchor,
      MobileScheduleRuleEveryDays(:final anchor) => anchor,
      MobileScheduleRuleEveryWeeks(:final anchor) => anchor,
      MobileScheduleRuleEveryMonths(:final anchor) => anchor,
      MobileScheduleRuleEveryMonthsWeekday(:final anchor) => anchor,
      MobileScheduleRuleEveryYears(:final anchor) => anchor,
      _ => now.toUtc().toIso8601String(),
    };

    final parsedEnds = endsAt != null
        ? DateTime.tryParse(endsAt)?.toLocal()
        : null;
    _hasEndDate = parsedEnds != null;
    _initialEndDateLocal = parsedEnds;
    _endDate = parsedEnds ?? now.add(const Duration(days: 30));
  }

  @override
  void didUpdateWidget(covariant ScheduleEditorScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.connectionListenable != widget.connectionListenable) {
      oldWidget.connectionListenable.removeListener(_onConnectionChanged);
      widget.connectionListenable.addListener(_onConnectionChanged);
      _onConnectionChanged();
    }
  }

  @override
  void dispose() {
    widget.connectionListenable.removeListener(_onConnectionChanged);
    _titleController.dispose();
    _promptController.dispose();
    _everyController.dispose();
    super.dispose();
  }

  void _onConnectionChanged() {
    if (!mounted) return;
    final next = widget.connectionListenable.value;
    final reconnected = next != null && !identical(next, _connection);
    setState(() => _connection = next);
    if (reconnected) {
      if (widget.isCreate && _projects.isEmpty) {
        unawaited(_loadProjects());
      }
      if (!_isLegacyThread && _agents.isEmpty) {
        unawaited(_loadAgents());
      }
      if (!_isLegacyThread && _instanceId != null && _models.isEmpty) {
        unawaited(_loadModels(_instanceId!));
      }
    }
  }

  Future<void> _loadProjects() async {
    final conn = _connection;
    if (conn == null || _loadingProjects) return;
    setState(() => _loadingProjects = true);
    List<MobileProjectSummary>? loaded;
    if (connectionSupportsProjectManage(conn)) {
      try {
        final managed = await conn.projects.list();
        loaded = [
          for (final item in managed)
            MobileProjectSummary(id: item.id, name: item.name),
        ];
      } catch (_) {}
    }
    if (loaded == null) {
      var supportsSidebar = false;
      try {
        supportsSidebar = conn.supportsSidebar;
      } on NoSuchMethodError {
        supportsSidebar = false;
      }
      if (supportsSidebar) {
        try {
          final sidebar = await conn.openSidebar();
          final items = sidebar.snapshot?.projects;
          if (items != null) {
            loaded = List<MobileProjectSummary>.of(items);
          }
        } catch (_) {}
      }
    }
    if (!mounted) return;
    setState(() {
      _loadingProjects = false;
      if (loaded != null && loaded.isNotEmpty) {
        _projects = loaded;
        if (_selectedProjectId == null ||
            !_projects.any((p) => p.id == _selectedProjectId)) {
          _selectedProjectId = _projects.first.id;
        }
      }
    });
  }

  Future<void> _loadAgents() async {
    final conn = _connection;
    if (conn == null || !connectionSupportsAgentManage(conn)) return;
    setState(() => _loadingAgents = true);
    try {
      final result = await conn.agents.list();
      if (!mounted) return;
      setState(() {
        _agents = result.agents;
        _loadingAgents = false;
      });
    } catch (_) {
      if (!mounted) return;
      setState(() => _loadingAgents = false);
    }
  }

  Future<void> _loadModels(String instanceId) async {
    final conn = _connection;
    if (conn == null || !connectionSupportsAgentManage(conn)) return;
    final seq = ++_modelsSeq;
    setState(() {
      _loadingModels = true;
      _models = const [];
    });
    try {
      final list = await conn.agents.models(instanceId: instanceId);
      if (!mounted || seq != _modelsSeq) return;
      setState(() {
        _models = list.where((item) => !item.hidden).toList(growable: false);
        _loadingModels = false;
      });
    } catch (_) {
      if (!mounted || seq != _modelsSeq) return;
      setState(() => _loadingModels = false);
    }
  }

  ({MobileScheduleRule? rule, String? error}) _buildRule() {
    final time = _formatTimeOfDay(_time);
    switch (_frequency) {
      case _ScheduleFrequency.hourly:
        return (rule: MobileScheduleRuleHourly(minute: _minute), error: null);
      case _ScheduleFrequency.daily:
        return (rule: MobileScheduleRuleDaily(time: time), error: null);
      case _ScheduleFrequency.weekdays:
        return (rule: MobileScheduleRuleWeekdays(time: time), error: null);
      case _ScheduleFrequency.weekly:
        if (_weekDays.isEmpty) return (rule: null, error: '至少选一天');
        final sorted = _weekDays.toList()..sort();
        return (
          rule: MobileScheduleRuleWeekly(days: sorted, time: time),
          error: null,
        );
      case _ScheduleFrequency.monthly:
        return (
          rule: MobileScheduleRuleMonthly(day: _monthDay, time: time),
          error: null,
        );
      case _ScheduleFrequency.custom:
        final every = int.tryParse(_everyController.text.trim());
        if (every == null || every < 1 || every > maxMobileScheduleEvery) {
          return (rule: null, error: '填 1 到 $maxMobileScheduleEvery 的整数');
        }
        switch (_customUnit) {
          case _CustomUnit.minute:
            return (
              rule: MobileScheduleRuleEveryMinutes(
                every: every,
                anchor: _anchor,
              ),
              error: null,
            );
          case _CustomUnit.hour:
            return (
              rule: MobileScheduleRuleEveryHours(
                every: every,
                minute: _minute,
                anchor: _anchor,
              ),
              error: null,
            );
          case _CustomUnit.day:
            return (
              rule: MobileScheduleRuleEveryDays(
                every: every,
                time: time,
                anchor: _anchor,
              ),
              error: null,
            );
          case _CustomUnit.week:
            if (_weekDays.isEmpty) return (rule: null, error: '至少选一天');
            final sorted = _weekDays.toList()..sort();
            return (
              rule: MobileScheduleRuleEveryWeeks(
                every: every,
                days: sorted,
                time: time,
                anchor: _anchor,
              ),
              error: null,
            );
          case _CustomUnit.month:
            if (_customMonthMode == _CustomMonthMode.weekday) {
              return (
                rule: MobileScheduleRuleEveryMonthsWeekday(
                  every: every,
                  weekday: _customMonthWeekday,
                  time: time,
                  anchor: _anchor,
                ),
                error: null,
              );
            }
            if (_customMonthDays.isEmpty) {
              return (rule: null, error: '至少选一个日期');
            }
            final sorted = _customMonthDays.toList()..sort();
            return (
              rule: MobileScheduleRuleEveryMonths(
                every: every,
                days: sorted,
                time: time,
                anchor: _anchor,
              ),
              error: null,
            );
          case _CustomUnit.year:
            return (
              rule: MobileScheduleRuleEveryYears(
                every: every,
                month: _yearMonth,
                day: _yearDay,
                time: time,
                anchor: _anchor,
              ),
              error: null,
            );
        }
    }
  }

  String? _computeEndsAtIso() {
    if (!_hasEndDate) return null;
    final existingEndsAt = widget.schedule?.endsAt;
    if (existingEndsAt != null &&
        _initialEndDateLocal != null &&
        _sameLocalDay(_endDate, _initialEndDateLocal!)) {
      return existingEndsAt;
    }
    return DateTime(
      _endDate.year,
      _endDate.month,
      _endDate.day,
      23,
      59,
      59,
      999,
    ).toUtc().toIso8601String();
  }

  MobileScheduleExecution _buildExecution() {
    final initial = _initialExecution;
    final sameInstance = initial != null && _instanceId == initial.instanceId;
    final sameModel = sameInstance && _modelId == initial.modelId;
    final effectiveModelId = _instanceId == null ? null : _modelId;

    return MobileScheduleExecution(
      instanceId: _instanceId,
      modelId: effectiveModelId,
      effort: sameModel && effectiveModelId != null ? initial.effort : null,
      fast: sameModel && effectiveModelId != null ? initial.fast : null,
      ultracode: sameModel && effectiveModelId != null
          ? initial.ultracode
          : null,
      planMode: sameInstance ? initial.planMode : null,
      worktree: _useWorktree
          ? (initial?.worktree ?? const MobileScheduleWorktree())
          : null,
      permissionMode: _permissionMode,
    );
  }

  Future<void> _pickTime() async {
    var draft = DateTime(2026, 1, 1, _time.hour, _time.minute);
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final picked = await showMobileSheet<TimeOfDay>(
      context,
      title: '选择触发时间',
      content: (sheet) => SliverToBoxAdapter(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SizedBox(
              height: 196,
              child: CupertinoDatePicker(
                mode: CupertinoDatePickerMode.time,
                use24hFormat: true,
                initialDateTime: draft,
                onDateTimeChanged: (next) => draft = next,
              ),
            ),
            const SizedBox(height: 12),
            FilledButton(
              style: FilledButton.styleFrom(
                backgroundColor: colors.primary,
                foregroundColor: colors.onPrimary,
                minimumSize: const Size.fromHeight(46),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
              ),
              onPressed: () => Navigator.of(
                sheet,
              ).pop(TimeOfDay(hour: draft.hour, minute: draft.minute)),
              child: const Text('确定'),
            ),
          ],
        ),
      ),
    );
    if (!mounted || picked == null) return;
    setState(() => _time = picked);
  }

  Future<void> _pickEndDate() async {
    final now = DateTime.now();
    final first = DateTime(now.year - 1, 1, 1);
    final last = DateTime(now.year + 10, 12, 31);
    final initial = _endDate.isBefore(first)
        ? first
        : (_endDate.isAfter(last) ? last : _endDate);
    var draft = initial;
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final picked = await showMobileSheet<DateTime>(
      context,
      title: '选择结束日期',
      content: (sheet) => SliverToBoxAdapter(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SizedBox(
              height: 204,
              child: CupertinoDatePicker(
                mode: CupertinoDatePickerMode.date,
                initialDateTime: initial,
                minimumDate: first,
                maximumDate: last,
                onDateTimeChanged: (next) => draft = next,
              ),
            ),
            const SizedBox(height: 12),
            FilledButton(
              style: FilledButton.styleFrom(
                backgroundColor: colors.primary,
                foregroundColor: colors.onPrimary,
                minimumSize: const Size.fromHeight(46),
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(12),
                ),
              ),
              onPressed: () => Navigator.of(sheet).pop(draft),
              child: const Text('确定'),
            ),
          ],
        ),
      ),
    );
    if (!mounted || picked == null) return;
    setState(() => _endDate = picked);
  }

  Future<void> _save() async {
    final conn = _connection;
    if (conn == null || _saving || _deleting) return;
    setState(() => _validationError = null);

    final builtRule = _buildRule();
    if (builtRule.rule == null) {
      setState(() => _validationError = builtRule.error ?? '请检查触发规则设置。');
      return;
    }

    final title = _titleController.text.trim();
    final promptText = _promptController.text;
    final trimmedPrompt = promptText.trim();
    if (trimmedPrompt.isEmpty) {
      setState(() => _validationError = '请填写要做什么。');
      return;
    }

    final endsAt = _computeEndsAtIso();

    if (widget.isCreate) {
      final projectId = _selectedProjectId;
      if (projectId == null || projectId.isEmpty) {
        setState(() => _validationError = '请选择所属项目。');
        return;
      }
      final execution = _buildExecution();
      setState(() => _saving = true);
      try {
        await conn.schedules.create(
          projectId: projectId,
          title: title,
          prompt: trimmedPrompt,
          rule: builtRule.rule!,
          endsAt: endsAt,
          enabled: true,
          execution: execution,
        );
        if (!mounted) return;
        ScaffoldMessenger.maybeOf(
          context,
        )?.showSnackBar(const SnackBar(content: Text('已创建定时任务')));
        Navigator.of(context).pop(true);
      } catch (error) {
        if (!mounted) return;
        setState(() {
          _saving = false;
          _validationError = manageErrorMessage(error);
        });
      }
      return;
    }

    final existing = widget.schedule!;
    // 编辑模式下未修改 prompt 时不传 prompt，避免 Host 清空桌面端富文本 draft。
    final promptChanged =
        promptText != existing.prompt &&
        trimmedPrompt != existing.prompt.trim();
    final titleChanged = title != existing.title;
    final ruleChanged =
        jsonEncode(builtRule.rule!.toJson()) !=
        jsonEncode(existing.rule.toJson());
    final clearEndsAt = !_hasEndDate && existing.endsAt != null;
    final endsAtChanged = _hasEndDate && endsAt != existing.endsAt;

    MobileScheduleExecution? executionPatch;
    if (!_isLegacyThread) {
      final nextExec = _buildExecution();
      final prevExec = _initialExecution;
      if (prevExec == null ||
          jsonEncode(nextExec.toJson()) != jsonEncode(prevExec.toJson())) {
        executionPatch = nextExec;
      }
    }

    setState(() => _saving = true);
    try {
      await conn.schedules.update(
        id: existing.id,
        title: titleChanged ? title : null,
        prompt: promptChanged ? trimmedPrompt : null,
        rule: ruleChanged ? builtRule.rule : null,
        endsAt: endsAtChanged ? endsAt : null,
        clearEndsAt: clearEndsAt,
        execution: executionPatch,
      );
      if (!mounted) return;
      ScaffoldMessenger.maybeOf(
        context,
      )?.showSnackBar(const SnackBar(content: Text('任务已保存')));
      Navigator.of(context).pop(true);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _validationError = manageErrorMessage(error);
      });
    }
  }

  Future<void> _deleteSchedule() async {
    final conn = _connection;
    final existing = widget.schedule;
    if (conn == null || existing == null || _saving || _deleting) return;

    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) {
        final colors = Theme.of(dialogContext).brightness == Brightness.dark
            ? pigcodeDark
            : pigcodeLight;
        return MobileGlassDialog(
          title: const Text('删除这个任务？'),
          content: const Text('任务和运行记录会删掉，已有的会话还在'),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('取消'),
            ),
            FilledButton(
              key: ScheduleEditorScreen.deleteConfirmKey,
              style: FilledButton.styleFrom(
                backgroundColor: colors.error,
                foregroundColor: colors.onError,
              ),
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: const Text('删除'),
            ),
          ],
        );
      },
    );
    if (!mounted || confirmed != true) return;

    setState(() {
      _deleting = true;
      _validationError = null;
    });
    try {
      await conn.schedules.delete(id: existing.id);
      if (!mounted) return;
      ScaffoldMessenger.maybeOf(
        context,
      )?.showSnackBar(const SnackBar(content: Text('已删除定时任务')));
      Navigator.of(context).pop(true);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _deleting = false;
        _validationError = manageErrorMessage(error);
      });
    }
  }

  String _permissionLabel(String mode) {
    for (final item in MobileDraftPermission.values) {
      if (item.wire == mode) return composerPermissionLabel(item);
    }
    return mode;
  }

  List<({String instanceId, String label})> _availableAgentInstances() {
    final items = <({String instanceId, String label})>[];
    final seen = <String>{};
    for (final agent in _agents) {
      if (!agent.registered || !agent.enabled) continue;
      for (final inst in agent.instances) {
        if (!inst.enabled) continue;
        if (seen.add(inst.instanceId)) {
          items.add((
            instanceId: inst.instanceId,
            label: inst.isDefault
                ? agent.displayName
                : '${inst.label} (${agent.displayName})',
          ));
        }
      }
    }
    if (_instanceId != null && seen.add(_instanceId!)) {
      items.add((instanceId: _instanceId!, label: _instanceId!));
    }
    return items;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final busy = _saving || _deleting;

    return Scaffold(
      backgroundColor: colors.background,
      appBar: AppBar(
        title: ManageAppBarTitle(
          title: widget.isCreate ? '新建任务' : '编辑任务',
          computerName: widget.computerName,
        ),
        centerTitle: true,
        scrolledUnderElevation: 0,
        systemOverlayStyle: pigcodeSystemOverlay(theme.brightness),
        leadingWidth: 58,
        leading: Align(
          alignment: AlignmentDirectional.centerStart,
          child: MobileGlassChromeButton(
            padding: const EdgeInsetsDirectional.only(start: 10),
            child: SizedBox.square(
              dimension: 40,
              child: IconButton(
                tooltip: '返回',
                padding: EdgeInsets.zero,
                onPressed: () => Navigator.maybePop(context),
                icon: const RotatedBox(
                  quarterTurns: 1,
                  child: WorkspaceIcon(WorkspaceGlyph.chevronDown, size: 20),
                ),
              ),
            ),
          ),
        ),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(1),
          child: Divider(height: 1, thickness: 1, color: colors.divider),
        ),
      ),
      body: Column(
        children: [
          if (_connection == null) const ManageOfflineBanner(),
          if (_validationError != null)
            Container(
              width: double.infinity,
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
              color: colors.errorTint,
              child: Text(
                _validationError!,
                style: TimelineType.smallStyle(colors.error),
              ),
            ),
          Expanded(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 96),
              children: [
                _buildBasicSection(context),
                const SizedBox(height: 22),
                _buildRuleSection(context),
                const SizedBox(height: 22),
                _buildExecutionSection(context),
                if (!widget.isCreate) ...[
                  const SizedBox(height: 24),
                  ManageDestructiveRow(
                    buttonKey: ScheduleEditorScreen.deleteButtonKey,
                    label: _deleting ? '正在删除…' : '删除任务',
                    busy: _deleting,
                    onPressed: _connection == null || busy
                        ? null
                        : () => unawaited(_deleteSchedule()),
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
      bottomNavigationBar: SafeArea(
        top: false,
        child: Container(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 12),
          decoration: BoxDecoration(
            color: colors.background,
            border: Border(top: BorderSide(color: colors.divider)),
          ),
          child: FilledButton(
            key: ScheduleEditorScreen.saveButtonKey,
            style: FilledButton.styleFrom(
              backgroundColor: colors.primary,
              foregroundColor: colors.onPrimary,
              minimumSize: const Size.fromHeight(48),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(14),
              ),
              textStyle: TimelineType.contentStyle(
                colors.onPrimary,
                weight: FontWeight.w600,
              ),
            ),
            onPressed: _connection == null || busy ? null : _save,
            child: Text(
              _saving
                  ? (widget.isCreate ? '创建中…' : '保存中…')
                  : (widget.isCreate ? '创建任务' : '保存修改'),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildBasicSection(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const ManageSectionHeader(title: '要做什么'),
        const SizedBox(height: 8),
        ManageSurfaceCard(
          children: [
            _buildProjectRow(context),
            Divider(height: 1, color: colors.divider),
            Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  ManageFilledTextField(
                    fieldKey: ScheduleEditorScreen.titleInputKey,
                    controller: _titleController,
                    label: '任务名字（可选）',
                    hintText: '留空显示为「没有名字的任务」',
                  ),
                  const SizedBox(height: 14),
                  ManageFilledTextField(
                    fieldKey: ScheduleEditorScreen.promptInputKey,
                    controller: _promptController,
                    label: '执行指令',
                    hintText: '比如：总结今天的改动，列成 6 条以内',
                    minLines: 4,
                    maxLines: 8,
                    helperText: widget.isCreate
                        ? null
                        : '未改指令正文直接保存时，不会覆盖电脑端的富文本引用。',
                  ),
                ],
              ),
            ),
          ],
        ),
      ],
    );
  }

  Widget _buildProjectRow(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;

    if (!widget.isCreate) {
      final existing = widget.schedule!;
      final isThread = existing.target is MobileScheduleThreadTarget;
      final label = isThread
          ? (existing.threadTitle ?? existing.projectName ?? '会话已删除')
          : (existing.projectName ??
                (existing.target as MobileScheduleProjectTarget).projectId);
      return ManagePickerRow(
        key: ScheduleEditorScreen.projectFieldKey,
        leading: IconTheme(
          data: IconThemeData(color: colors.secondaryText),
          child: WorkspaceIcon(
            isThread ? WorkspaceGlyph.messagesSquare : WorkspaceGlyph.folder,
            size: 18,
          ),
        ),
        title: isThread ? '绑定会话' : '所属项目',
        value: label,
        showChevron: false,
        enabled: false,
      );
    }

    if (_loadingProjects && _projects.isEmpty) {
      return ManagePickerRow(
        key: ScheduleEditorScreen.projectFieldKey,
        title: '所属项目',
        value: '加载中…',
        placeholder: true,
        showChevron: false,
        enabled: false,
      );
    }

    if (_projects.isEmpty) {
      return Padding(
        key: ScheduleEditorScreen.projectFieldKey,
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 13),
        child: Text(
          '暂无可用项目，请先在「项目管理」中添加项目。',
          style: TimelineType.metaStyle(colors.muted),
        ),
      );
    }

    final currentProject =
        _projects.where((p) => p.id == _selectedProjectId).firstOrNull ??
        _projects.first;

    return ManagePickerRow(
      key: ScheduleEditorScreen.projectFieldKey,
      leading: IconTheme(
        data: IconThemeData(color: colors.secondaryText),
        child: const WorkspaceIcon(WorkspaceGlyph.folder, size: 18),
      ),
      title: '所属项目',
      value: currentProject.name,
      onTap: () async {
        final next = await ManageSelectSheet.show<String>(
          context,
          title: '选择所属项目',
          selected: currentProject.id,
          options: [
            for (final project in _projects)
              ManageSelectOption(
                value: project.id,
                label: project.name,
                leading: IconTheme(
                  data: IconThemeData(color: colors.secondaryText),
                  child: const WorkspaceIcon(WorkspaceGlyph.folder, size: 18),
                ),
              ),
          ],
        );
        if (next != null && mounted) {
          setState(() => _selectedProjectId = next);
        }
      },
    );
  }

  Widget _buildRuleSection(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final built = _buildRule();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const ManageSectionHeader(title: '什么时候跑'),
        const SizedBox(height: 8),
        ManageSurfaceCard(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 16, 16, 12),
              child: ManageSegmentedGrid<_ScheduleFrequency>(
                selected: _frequency,
                columns: 3,
                itemKeyBuilder: (v) =>
                    ScheduleEditorScreen.frequencyKey(v.name),
                options: const [
                  (value: _ScheduleFrequency.hourly, label: '每小时'),
                  (value: _ScheduleFrequency.daily, label: '每天'),
                  (value: _ScheduleFrequency.weekdays, label: '工作日'),
                  (value: _ScheduleFrequency.weekly, label: '每周'),
                  (value: _ScheduleFrequency.monthly, label: '每月'),
                  (value: _ScheduleFrequency.custom, label: '自定义'),
                ],
                onSelected: (next) => setState(() => _frequency = next),
              ),
            ),
            Divider(height: 1, color: colors.divider),
            ..._buildFrequencyParameterRows(context),
            Divider(height: 1, color: colors.divider),
            ManageSwitchRow(
              switchKey: ScheduleEditorScreen.endsToggleKey,
              title: '设置结束日期',
              subtitle: _hasEndDate ? '到期后任务自动停止' : '长期有效',
              value: _hasEndDate,
              onChanged: (next) => setState(() => _hasEndDate = next),
            ),
            if (_hasEndDate) ...[
              Divider(height: 1, color: colors.divider),
              ManagePickerRow(
                key: ScheduleEditorScreen.endsDateKey,
                title: '结束日期',
                value: _formatDateYmd(_endDate),
                onTap: () => unawaited(_pickEndDate()),
              ),
            ],
            Divider(height: 1, color: colors.divider),
            Container(
              key: ScheduleEditorScreen.rulePreviewKey,
              color: built.rule != null
                  ? colors.surfaceSunken
                  : colors.errorTint,
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
              child: Row(
                spacing: 8,
                children: [
                  Icon(
                    built.rule != null
                        ? Icons.event_repeat_outlined
                        : Icons.error_outline,
                    size: 15,
                    color: built.rule != null ? colors.muted : colors.error,
                  ),
                  Expanded(
                    child: Text(
                      built.rule != null
                          ? (_hasEndDate
                                ? '${describeScheduleRule(built.rule!)} · 到 ${_formatDateYmd(_endDate)}'
                                : describeScheduleRule(built.rule!))
                          : (built.error ?? '规则无效'),
                      style: TimelineType.smallStyle(
                        built.rule != null
                            ? colors.secondaryText
                            : colors.error,
                        weight: FontWeight.w500,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ],
    );
  }

  List<Widget> _buildFrequencyParameterRows(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;

    return switch (_frequency) {
      _ScheduleFrequency.hourly => [_buildMinutePickerRow(context)],
      _ScheduleFrequency.daily ||
      _ScheduleFrequency.weekdays => [_buildTimePickerRow(context)],
      _ScheduleFrequency.weekly => [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
          child: _buildWeekdaySelector(context),
        ),
        Divider(height: 1, color: colors.divider),
        _buildTimePickerRow(context),
      ],
      _ScheduleFrequency.monthly => [
        _buildMonthDayPickerRow(context),
        Divider(height: 1, color: colors.divider),
        _buildTimePickerRow(context),
      ],
      _ScheduleFrequency.custom => _buildCustomRuleRows(context),
    };
  }

  List<Widget> _buildCustomRuleRows(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;

    const unitEntries = <(_CustomUnit, String, String)>[
      (_CustomUnit.minute, 'minute', '分钟'),
      (_CustomUnit.hour, 'hour', '小时'),
      (_CustomUnit.day, 'day', '天'),
      (_CustomUnit.week, 'week', '周'),
      (_CustomUnit.month, 'month', '个月'),
      (_CustomUnit.year, 'year', '年'),
    ];
    final unitNameMap = <String, _CustomUnit>{
      for (final e in unitEntries) e.$2: e.$1,
    };

    return [
      Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              spacing: 10,
              children: [
                Text(
                  '间隔周期',
                  style: TimelineType.contentStyle(
                    colors.foreground,
                    weight: FontWeight.w500,
                  ),
                ),
                const Spacer(),
                Text('每', style: TimelineType.metaStyle(colors.muted)),
                SizedBox(
                  width: 72,
                  child: ManageFilledTextField(
                    fieldKey: ScheduleEditorScreen.customEveryKey,
                    controller: _everyController,
                    hintText: '1',
                    keyboardType: TextInputType.number,
                    contentPadding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 8,
                    ),
                    onChanged: (_) => setState(() {}),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            ManageSegmentedGrid<String>(
              selected: _customUnit.name,
              columns: 3,
              itemKeyBuilder: (u) => ScheduleEditorScreen.customUnitKey(u),
              options: [
                for (final e in unitEntries) (value: e.$2, label: e.$3),
              ],
              onSelected: (unitStr) {
                final u = unitNameMap[unitStr];
                if (u != null) setState(() => _customUnit = u);
              },
            ),
          ],
        ),
      ),
      if (_customUnit == _CustomUnit.hour) ...[
        Divider(height: 1, color: colors.divider),
        _buildMinutePickerRow(context),
      ],
      if (_customUnit == _CustomUnit.week) ...[
        Divider(height: 1, color: colors.divider),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
          child: _buildWeekdaySelector(context),
        ),
      ],
      if (_customUnit == _CustomUnit.month) ...[
        Divider(height: 1, color: colors.divider),
        ..._buildCustomMonthRows(context),
      ],
      if (_customUnit == _CustomUnit.year) ...[
        Divider(height: 1, color: colors.divider),
        ..._buildCustomYearRows(context),
      ],
      if (_customUnit != _CustomUnit.minute &&
          _customUnit != _CustomUnit.hour) ...[
        Divider(height: 1, color: colors.divider),
        _buildTimePickerRow(context),
      ],
    ];
  }

  List<Widget> _buildCustomMonthRows(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;

    return [
      Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            ManageSegmentedGrid<_CustomMonthMode>(
              selected: _customMonthMode,
              columns: 2,
              itemKeyBuilder: (m) => m == _CustomMonthMode.date
                  ? ScheduleEditorScreen.customMonthModeDateKey
                  : ScheduleEditorScreen.customMonthModeWeekdayKey,
              options: const [
                (value: _CustomMonthMode.date, label: '按日期'),
                (value: _CustomMonthMode.weekday, label: '按首个星期'),
              ],
              onSelected: (next) => setState(() => _customMonthMode = next),
            ),
            if (_customMonthMode == _CustomMonthMode.date) ...[
              const SizedBox(height: 12),
              GridView.builder(
                shrinkWrap: true,
                physics: const NeverScrollableScrollPhysics(),
                gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: 7,
                  mainAxisSpacing: 6,
                  crossAxisSpacing: 6,
                  childAspectRatio: 1.15,
                ),
                itemCount: 31,
                itemBuilder: (_, index) {
                  final day = index + 1;
                  final selected = _customMonthDays.contains(day);
                  return Material(
                    key: ScheduleEditorScreen.customMonthDayKey(day),
                    color: selected ? colors.primary : colors.field,
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(8),
                      side: BorderSide(
                        color: selected ? colors.primary : colors.border,
                      ),
                    ),
                    clipBehavior: Clip.antiAlias,
                    child: InkWell(
                      onTap: () => setState(() {
                        if (selected) {
                          _customMonthDays.remove(day);
                        } else {
                          _customMonthDays.add(day);
                        }
                      }),
                      child: Center(
                        child: Text(
                          '$day',
                          style: TimelineType.smallStyle(
                            selected ? colors.onPrimary : colors.foreground,
                            weight: selected
                                ? FontWeight.w600
                                : FontWeight.w400,
                          ),
                        ),
                      ),
                    ),
                  );
                },
              ),
            ],
          ],
        ),
      ),
      if (_customMonthMode == _CustomMonthMode.weekday) ...[
        Divider(height: 1, color: colors.divider),
        ManagePickerRow(
          key: ScheduleEditorScreen.customMonthWeekdayKey,
          title: '每月首个星期几',
          value: _weekdayLabels[_customMonthWeekday] ?? '$_customMonthWeekday',
          onTap: () async {
            final next = await ManageSelectSheet.show<int>(
              context,
              title: '选择每月首个星期几',
              selected: _customMonthWeekday,
              options: [
                for (final day in _weekOrder)
                  ManageSelectOption(
                    value: day,
                    label: _weekdayLabels[day] ?? '$day',
                  ),
              ],
            );
            if (next != null && mounted) {
              setState(() => _customMonthWeekday = next);
            }
          },
        ),
      ],
    ];
  }

  List<Widget> _buildCustomYearRows(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;

    return [
      ManagePickerRow(
        key: ScheduleEditorScreen.customYearMonthKey,
        title: '每年月份',
        value: '$_yearMonth 月',
        onTap: () async {
          final next = await ManageSelectSheet.show<int>(
            context,
            title: '选择月份',
            selected: _yearMonth,
            options: [
              for (var m = 1; m <= 12; m++)
                ManageSelectOption(value: m, label: '$m 月'),
            ],
          );
          if (next != null && mounted) {
            setState(() => _yearMonth = next);
          }
        },
      ),
      Divider(height: 1, color: colors.divider),
      ManagePickerRow(
        key: ScheduleEditorScreen.customYearDayKey,
        title: '每年日期',
        value: '$_yearDay 号',
        onTap: () async {
          final next = await ManageSelectSheet.show<int>(
            context,
            title: '选择日期',
            selected: _yearDay,
            options: [
              for (var d = 1; d <= 31; d++)
                ManageSelectOption(value: d, label: '$d 号'),
            ],
          );
          if (next != null && mounted) {
            setState(() => _yearDay = next);
          }
        },
      ),
    ];
  }

  Widget _buildMinutePickerRow(BuildContext context) => ManagePickerRow(
    key: ScheduleEditorScreen.ruleMinuteKey,
    title: '每小时第几分',
    value: '第 ${_pad2(_minute)} 分',
    onTap: () async {
      final next = await ManageSelectSheet.show<int>(
        context,
        title: '选择分钟',
        selected: _minute,
        options: [
          for (var m = 0; m < 60; m++)
            ManageSelectOption(value: m, label: '第 ${_pad2(m)} 分'),
        ],
      );
      if (next != null && mounted) {
        setState(() => _minute = next);
      }
    },
  );

  Widget _buildMonthDayPickerRow(BuildContext context) => ManagePickerRow(
    key: ScheduleEditorScreen.monthDayKey,
    title: '每月几号',
    value: '$_monthDay 号',
    onTap: () async {
      final next = await ManageSelectSheet.show<int>(
        context,
        title: '选择每月几号',
        selected: _monthDay,
        options: [
          for (var d = 1; d <= 31; d++)
            ManageSelectOption(value: d, label: '$d 号'),
        ],
      );
      if (next != null && mounted) {
        setState(() => _monthDay = next);
      }
    },
  );

  Widget _buildWeekdaySelector(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;

    const shortLabels = <int, String>{
      0: '日',
      1: '一',
      2: '二',
      3: '三',
      4: '四',
      5: '五',
      6: '六',
    };

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('重复星期', style: TimelineType.metaStyle(colors.muted)),
        const SizedBox(height: 10),
        Row(
          children: [
            for (var i = 0; i < _weekOrder.length; i++) ...[
              if (i > 0) const SizedBox(width: 6),
              Expanded(
                child: Builder(
                  builder: (_) {
                    final day = _weekOrder[i];
                    final selected = _weekDays.contains(day);
                    return Material(
                      key: ScheduleEditorScreen.weekdayKey(day),
                      color: selected ? colors.primary : colors.field,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(10),
                        side: BorderSide(
                          color: selected ? colors.primary : colors.border,
                        ),
                      ),
                      clipBehavior: Clip.antiAlias,
                      child: InkWell(
                        onTap: () => setState(() {
                          if (selected) {
                            _weekDays.remove(day);
                          } else {
                            _weekDays.add(day);
                          }
                        }),
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(minHeight: 38),
                          child: Center(
                            child: Text(
                              shortLabels[day] ?? '$day',
                              style: TimelineType.metaStyle(
                                selected ? colors.onPrimary : colors.foreground,
                                weight: selected
                                    ? FontWeight.w600
                                    : FontWeight.w500,
                              ),
                            ),
                          ),
                        ),
                      ),
                    );
                  },
                ),
              ),
            ],
          ],
        ),
      ],
    );
  }

  Widget _buildTimePickerRow(BuildContext context) => ManagePickerRow(
    key: ScheduleEditorScreen.ruleTimeKey,
    title: '触发时间',
    value: _formatTimeOfDay(_time),
    onTap: () => unawaited(_pickTime()),
  );

  Widget _buildExecutionSection(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;

    if (_isLegacyThread) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const ManageSectionHeader(title: '交给谁跑'),
          const SizedBox(height: 8),
          ManageSurfaceCard(
            padding: const EdgeInsets.all(16),
            children: [
              Row(
                spacing: 10,
                children: [
                  Icon(Icons.info_outline, size: 18, color: colors.muted),
                  Expanded(
                    child: Text(
                      '旧版会话绑定的定时任务沿用原会话配置',
                      style: TimelineType.metaStyle(colors.muted),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ],
      );
    }

    final agentChoices = _availableAgentInstances();
    final currentAgentLabel = _instanceId == null
        ? '默认 Agent'
        : agentChoices
                  .where((a) => a.instanceId == _instanceId)
                  .firstOrNull
                  ?.label ??
              _instanceId!;

    final modelChoices = <({String id, String name})>[
      for (final item in _models) (id: item.id, name: item.name),
      if (_modelId != null && !_models.any((m) => m.id == _modelId))
        (id: _modelId!, name: _modelId!),
    ];
    final currentModelLabel = _modelId == null
        ? '默认模型'
        : modelChoices.where((m) => m.id == _modelId).firstOrNull?.name ??
              _modelId!;

    final permissionWires = <String>[
      for (final p in _permissionChoices) p.wire,
      if (!_permissionChoices.any((p) => p.wire == _permissionMode))
        _permissionMode,
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const ManageSectionHeader(title: '交给谁跑'),
        const SizedBox(height: 8),
        ManageSurfaceCard(
          children: [
            ManagePickerRow(
              key: ScheduleEditorScreen.execAgentKey,
              title: 'Agent 实例',
              subtitle: _loadingAgents ? '正在加载电脑列表…' : null,
              value: currentAgentLabel,
              onTap: () async {
                final picked =
                    await ManageSelectSheet.show<_OptionalValue<String?>>(
                      context,
                      title: '选择 Agent 实例',
                      selected: _OptionalValue<String?>(_instanceId),
                      options: [
                        const ManageSelectOption(
                          value: _OptionalValue<String?>(null),
                          label: '用默认的 Agent',
                        ),
                        for (final item in agentChoices)
                          ManageSelectOption(
                            value: _OptionalValue<String?>(item.instanceId),
                            label: item.label,
                          ),
                      ],
                    );
                if (picked == null || !mounted) return;
                final next = picked.value;
                setState(() {
                  if (_instanceId != next) {
                    _instanceId = next;
                    _modelId = null;
                    _models = const [];
                  }
                });
                if (next != null) {
                  unawaited(_loadModels(next));
                }
              },
            ),
            if (_instanceId != null) ...[
              Divider(height: 1, color: colors.divider),
              ManagePickerRow(
                key: ScheduleEditorScreen.execModelKey,
                title: '指定模型',
                subtitle: _loadingModels ? '正在加载模型列表…' : null,
                value: currentModelLabel,
                onTap: () async {
                  final picked =
                      await ManageSelectSheet.show<_OptionalValue<String?>>(
                        context,
                        title: '选择模型',
                        selected: _OptionalValue<String?>(_modelId),
                        options: [
                          const ManageSelectOption(
                            value: _OptionalValue<String?>(null),
                            label: '使用实例默认模型',
                          ),
                          for (final model in modelChoices)
                            ManageSelectOption(
                              value: _OptionalValue<String?>(model.id),
                              label: model.name,
                            ),
                        ],
                      );
                  if (picked != null && mounted) {
                    setState(() => _modelId = picked.value);
                  }
                },
              ),
            ],
            Divider(height: 1, color: colors.divider),
            ManagePickerRow(
              key: ScheduleEditorScreen.execPermissionKey,
              title: '权限模式',
              value: _permissionLabel(_permissionMode),
              onTap: () async {
                final next = await ManageSelectSheet.show<String>(
                  context,
                  title: '选择权限模式',
                  selected: _permissionMode,
                  options: [
                    for (final wire in permissionWires)
                      ManageSelectOption(
                        value: wire,
                        label: _permissionLabel(wire),
                      ),
                  ],
                );
                if (next != null && mounted) {
                  setState(() => _permissionMode = next);
                }
              },
            ),
            Divider(height: 1, color: colors.divider),
            ManageSwitchRow(
              switchKey: ScheduleEditorScreen.execWorktreeKey,
              title: '在独立 Worktree 中运行',
              subtitle: '每次自动新建工作树，不改动当前工作区',
              value: _useWorktree,
              onChanged: (next) => setState(() => _useWorktree = next),
            ),
          ],
        ),
      ],
    );
  }
}

class _OptionalValue<T> {
  const _OptionalValue(this.value);

  final T value;

  @override
  bool operator ==(Object other) =>
      other is _OptionalValue<T> && other.value == value;

  @override
  int get hashCode => value.hashCode;
}
