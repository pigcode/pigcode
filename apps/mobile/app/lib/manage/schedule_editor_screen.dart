import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';

import '../app_theme.dart';
import '../composer/composer_catalog.dart';
import '../mobile_glass.dart';
import '../theme_colors.dart';
import '../timeline/timeline_tokens.dart';
import '../workspace_icon.dart';
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
  final MobileSchedule? schedule;
  final List<MobileProjectSummary> projects;
  final String? initialTitle;
  final String? initialPrompt;
  final MobileScheduleRule? initialRule;

  bool get isCreate => schedule == null;

  static Future<bool?> open(
    BuildContext context, {
    required ValueListenable<MobileConnection?> connectionListenable,
    MobileSchedule? schedule,
    List<MobileProjectSummary> projects = const [],
    String? initialTitle,
    String? initialPrompt,
    MobileScheduleRule? initialRule,
  }) => Navigator.of(context).push<bool>(
    MaterialPageRoute<bool>(
      builder: (_) => ScheduleEditorScreen(
        connectionListenable: connectionListenable,
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
    final picked = await showTimePicker(context: context, initialTime: _time);
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
    final picked = await showDatePicker(
      context: context,
      initialDate: initial,
      firstDate: first,
      lastDate: last,
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
        title: Text(widget.isCreate ? '新建任务' : '编辑任务'),
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
        actions: [
          Padding(
            padding: const EdgeInsetsDirectional.only(end: 12),
            child: FilledButton(
              key: ScheduleEditorScreen.saveButtonKey,
              onPressed: _connection == null || busy ? null : _save,
              child: Text(
                _saving
                    ? (widget.isCreate ? '创建中…' : '保存中…')
                    : (widget.isCreate ? '创建' : '保存'),
              ),
            ),
          ),
        ],
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(1),
          child: Divider(height: 1, thickness: 1, color: colors.divider),
        ),
      ),
      body: SafeArea(
        top: false,
        child: Column(
          children: [
            if (_connection == null) const ManageOfflineBanner(),
            if (_validationError != null)
              Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 10,
                ),
                color: colors.error.withValues(alpha: 0.12),
                child: Text(
                  _validationError!,
                  style: theme.textTheme.bodySmall?.copyWith(
                    color: colors.error,
                  ),
                ),
              ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 80),
                children: [
                  _buildBasicSection(context),
                  const SizedBox(height: 22),
                  _buildRuleSection(context),
                  const SizedBox(height: 22),
                  _buildExecutionSection(context),
                  if (!widget.isCreate) ...[
                    const SizedBox(height: 28),
                    SizedBox(
                      width: double.infinity,
                      child: OutlinedButton(
                        key: ScheduleEditorScreen.deleteButtonKey,
                        style: OutlinedButton.styleFrom(
                          foregroundColor: colors.error,
                          side: BorderSide(
                            color: colors.error.withValues(alpha: 0.5),
                          ),
                        ),
                        onPressed: _connection == null || busy
                            ? null
                            : () => unawaited(_deleteSchedule()),
                        child: Text(_deleting ? '正在删除…' : '删除任务'),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],
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
        const _ScheduleSectionHeader(title: '基本设置'),
        const SizedBox(height: 8),
        _ScheduleFormCard(
          children: [
            Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                spacing: 14,
                children: [
                  _buildProjectField(context),
                  TextField(
                    key: ScheduleEditorScreen.titleInputKey,
                    controller: _titleController,
                    maxLength: 120,
                    decoration: const InputDecoration(
                      labelText: '名字（可选）',
                      hintText: '留空显示为「没有名字的任务」',
                      counterText: '',
                    ),
                  ),
                  TextField(
                    key: ScheduleEditorScreen.promptInputKey,
                    controller: _promptController,
                    minLines: 4,
                    maxLines: 8,
                    decoration: const InputDecoration(
                      labelText: '要做什么',
                      hintText: '比如：总结今天的改动，列成 6 条以内',
                      alignLabelWithHint: true,
                    ),
                  ),
                  if (!widget.isCreate)
                    Text(
                      '如无需修改指令正文，保持原样保存不会覆盖电脑端的富文本引用。',
                      style: TimelineType.microStyle(colors.muted),
                    ),
                ],
              ),
            ),
          ],
        ),
      ],
    );
  }

  Widget _buildProjectField(BuildContext context) {
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
      return Container(
        key: ScheduleEditorScreen.projectFieldKey,
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: colors.field,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: colors.border),
        ),
        child: Row(
          children: [
            IconTheme(
              data: IconThemeData(color: colors.secondaryText),
              child: WorkspaceIcon(
                isThread
                    ? WorkspaceGlyph.messagesSquare
                    : WorkspaceGlyph.folder,
                size: 18,
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    isThread ? '绑定会话（旧版任务）' : '所属项目',
                    style: TimelineType.microStyle(colors.muted),
                  ),
                  Text(
                    label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TimelineType.contentStyle(
                      colors.foreground,
                      weight: FontWeight.w500,
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      );
    }

    if (_loadingProjects && _projects.isEmpty) {
      return InputDecorator(
        decoration: const InputDecoration(labelText: '所属项目'),
        child: Text('正在加载项目列表…', style: TimelineType.metaStyle(colors.muted)),
      );
    }

    if (_projects.isEmpty) {
      return Container(
        key: ScheduleEditorScreen.projectFieldKey,
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
        decoration: BoxDecoration(
          color: colors.field,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: colors.border),
        ),
        child: Text(
          '暂无可用项目，请先在「项目管理」中添加项目。',
          style: TimelineType.metaStyle(colors.muted),
        ),
      );
    }

    final currentValue = _projects.any((p) => p.id == _selectedProjectId)
        ? _selectedProjectId
        : _projects.first.id;
    return InputDecorator(
      decoration: const InputDecoration(labelText: '所属项目'),
      child: DropdownButtonHideUnderline(
        child: DropdownButton<String>(
          key: ScheduleEditorScreen.projectFieldKey,
          value: currentValue,
          isExpanded: true,
          isDense: true,
          items: [
            for (final project in _projects)
              DropdownMenuItem<String>(
                value: project.id,
                child: Text(
                  project.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
          ],
          onChanged: (next) => setState(() => _selectedProjectId = next),
        ),
      ),
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
        const _ScheduleSectionHeader(title: '什么时候'),
        const SizedBox(height: 8),
        _ScheduleFormCard(
          children: [
            Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                spacing: 14,
                children: [
                  Text('触发频率', style: TimelineType.metaStyle(colors.muted)),
                  Wrap(
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      for (final item in const [
                        (_ScheduleFrequency.hourly, 'hourly', '每小时'),
                        (_ScheduleFrequency.daily, 'daily', '每天'),
                        (_ScheduleFrequency.weekdays, 'weekdays', '工作日'),
                        (_ScheduleFrequency.weekly, 'weekly', '每周'),
                        (_ScheduleFrequency.monthly, 'monthly', '每月'),
                        (_ScheduleFrequency.custom, 'custom', '自定义间隔'),
                      ])
                        ChoiceChip(
                          key: ScheduleEditorScreen.frequencyKey(item.$2),
                          label: Text(item.$3),
                          selected: _frequency == item.$1,
                          onSelected: (_) =>
                              setState(() => _frequency = item.$1),
                        ),
                    ],
                  ),
                  if (_frequency == _ScheduleFrequency.hourly)
                    _buildMinutePicker(context)
                  else if (_frequency == _ScheduleFrequency.daily ||
                      _frequency == _ScheduleFrequency.weekdays)
                    _buildTimePickerRow(context)
                  else if (_frequency == _ScheduleFrequency.weekly) ...[
                    _buildWeekdaySelector(context),
                    _buildTimePickerRow(context),
                  ] else if (_frequency == _ScheduleFrequency.monthly) ...[
                    _buildMonthDayPicker(context),
                    _buildTimePickerRow(context),
                  ] else
                    _buildCustomRuleControls(context),
                  Container(
                    key: ScheduleEditorScreen.rulePreviewKey,
                    width: double.infinity,
                    padding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 10,
                    ),
                    decoration: BoxDecoration(
                      color: built.rule != null
                          ? colors.field
                          : colors.error.withValues(alpha: 0.10),
                      borderRadius: BorderRadius.circular(10),
                      border: Border.all(
                        color: built.rule != null
                            ? colors.border
                            : colors.error.withValues(alpha: 0.35),
                      ),
                    ),
                    child: Row(
                      spacing: 8,
                      children: [
                        Icon(
                          built.rule != null
                              ? Icons.schedule
                              : Icons.error_outline,
                          size: 16,
                          color: built.rule != null
                              ? colors.secondaryText
                              : colors.error,
                        ),
                        Expanded(
                          child: Text(
                            built.rule != null
                                ? (_hasEndDate
                                      ? '${describeScheduleRule(built.rule!)} · 到 ${_formatDateYmd(_endDate)}'
                                      : describeScheduleRule(built.rule!))
                                : (built.error ?? '规则无效'),
                            style: TimelineType.metaStyle(
                              built.rule != null
                                  ? colors.foreground
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
            ),
            Divider(height: 1, color: colors.divider),
            SwitchListTile.adaptive(
              key: ScheduleEditorScreen.endsToggleKey,
              title: const Text('设置结束日期'),
              subtitle: Text(
                _hasEndDate ? '到期后任务自动结束' : '永不结束',
                style: TimelineType.metaStyle(colors.muted),
              ),
              value: _hasEndDate,
              onChanged: (next) => setState(() => _hasEndDate = next),
            ),
            if (_hasEndDate) ...[
              Divider(height: 1, color: colors.divider),
              ListTile(
                key: ScheduleEditorScreen.endsDateKey,
                leading: Icon(
                  Icons.event_outlined,
                  size: 20,
                  color: colors.secondaryText,
                ),
                title: const Text('结束日期'),
                trailing: Row(
                  mainAxisSize: MainAxisSize.min,
                  spacing: 4,
                  children: [
                    Text(
                      _formatDateYmd(_endDate),
                      style: TimelineType.metaMonoStyle(colors.foreground),
                    ),
                    Icon(Icons.chevron_right, size: 18, color: colors.faint),
                  ],
                ),
                onTap: () => unawaited(_pickEndDate()),
              ),
            ],
          ],
        ),
      ],
    );
  }

  Widget _buildCustomRuleControls(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      spacing: 12,
      children: [
        Row(
          spacing: 10,
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            Text('每', style: TimelineType.contentStyle(colors.foreground)),
            SizedBox(
              width: 84,
              child: TextField(
                key: ScheduleEditorScreen.customEveryKey,
                controller: _everyController,
                keyboardType: TextInputType.number,
                textAlign: TextAlign.center,
                decoration: const InputDecoration(isDense: true, hintText: '1'),
                onChanged: (_) => setState(() {}),
              ),
            ),
            Expanded(
              child: Wrap(
                spacing: 6,
                runSpacing: 6,
                children: [
                  for (final item in const [
                    (_CustomUnit.minute, 'minute', '分钟'),
                    (_CustomUnit.hour, 'hour', '小时'),
                    (_CustomUnit.day, 'day', '天'),
                    (_CustomUnit.week, 'week', '周'),
                    (_CustomUnit.month, 'month', '个月'),
                    (_CustomUnit.year, 'year', '年'),
                  ])
                    ChoiceChip(
                      key: ScheduleEditorScreen.customUnitKey(item.$2),
                      label: Text(item.$3),
                      selected: _customUnit == item.$1,
                      onSelected: (_) => setState(() => _customUnit = item.$1),
                    ),
                ],
              ),
            ),
          ],
        ),
        if (_customUnit == _CustomUnit.hour) _buildMinutePicker(context),
        if (_customUnit == _CustomUnit.week) _buildWeekdaySelector(context),
        if (_customUnit == _CustomUnit.month)
          _buildCustomMonthControls(context),
        if (_customUnit == _CustomUnit.year) _buildCustomYearControls(context),
        if (_customUnit != _CustomUnit.minute &&
            _customUnit != _CustomUnit.hour)
          _buildTimePickerRow(context),
      ],
    );
  }

  Widget _buildCustomMonthControls(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      spacing: 10,
      children: [
        Wrap(
          spacing: 8,
          children: [
            ChoiceChip(
              key: ScheduleEditorScreen.customMonthModeDateKey,
              label: const Text('按日期'),
              selected: _customMonthMode == _CustomMonthMode.date,
              onSelected: (_) =>
                  setState(() => _customMonthMode = _CustomMonthMode.date),
            ),
            ChoiceChip(
              key: ScheduleEditorScreen.customMonthModeWeekdayKey,
              label: const Text('按首个星期'),
              selected: _customMonthMode == _CustomMonthMode.weekday,
              onSelected: (_) =>
                  setState(() => _customMonthMode = _CustomMonthMode.weekday),
            ),
          ],
        ),
        if (_customMonthMode == _CustomMonthMode.date)
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              for (var day = 1; day <= 31; day++)
                FilterChip(
                  key: ScheduleEditorScreen.customMonthDayKey(day),
                  label: Text('$day'),
                  showCheckmark: false,
                  visualDensity: VisualDensity.compact,
                  selected: _customMonthDays.contains(day),
                  onSelected: (selected) => setState(() {
                    if (selected) {
                      _customMonthDays.add(day);
                    } else {
                      _customMonthDays.remove(day);
                    }
                  }),
                ),
            ],
          )
        else
          InputDecorator(
            decoration: const InputDecoration(labelText: '每月首个星期几'),
            child: DropdownButtonHideUnderline(
              child: DropdownButton<int>(
                key: ScheduleEditorScreen.customMonthWeekdayKey,
                value: _customMonthWeekday,
                isExpanded: true,
                isDense: true,
                items: [
                  for (final day in _weekOrder)
                    DropdownMenuItem<int>(
                      value: day,
                      child: Text(
                        _weekdayLabels[day] ?? '$day',
                        style: TimelineType.contentStyle(colors.foreground),
                      ),
                    ),
                ],
                onChanged: (next) {
                  if (next != null) {
                    setState(() => _customMonthWeekday = next);
                  }
                },
              ),
            ),
          ),
      ],
    );
  }

  Widget _buildCustomYearControls(BuildContext context) => Row(
    spacing: 12,
    children: [
      Expanded(
        child: InputDecorator(
          decoration: const InputDecoration(labelText: '月份'),
          child: DropdownButtonHideUnderline(
            child: DropdownButton<int>(
              key: ScheduleEditorScreen.customYearMonthKey,
              value: _yearMonth,
              isExpanded: true,
              isDense: true,
              items: [
                for (var m = 1; m <= 12; m++)
                  DropdownMenuItem<int>(value: m, child: Text('$m 月')),
              ],
              onChanged: (next) {
                if (next != null) setState(() => _yearMonth = next);
              },
            ),
          ),
        ),
      ),
      Expanded(
        child: InputDecorator(
          decoration: const InputDecoration(labelText: '日期'),
          child: DropdownButtonHideUnderline(
            child: DropdownButton<int>(
              key: ScheduleEditorScreen.customYearDayKey,
              value: _yearDay,
              isExpanded: true,
              isDense: true,
              items: [
                for (var d = 1; d <= 31; d++)
                  DropdownMenuItem<int>(value: d, child: Text('$d 号')),
              ],
              onChanged: (next) {
                if (next != null) setState(() => _yearDay = next);
              },
            ),
          ),
        ),
      ),
    ],
  );

  Widget _buildMinutePicker(BuildContext context) => InputDecorator(
    decoration: const InputDecoration(labelText: '每小时的第几分钟'),
    child: DropdownButtonHideUnderline(
      child: DropdownButton<int>(
        key: ScheduleEditorScreen.ruleMinuteKey,
        value: _minute,
        isExpanded: true,
        isDense: true,
        items: [
          for (var m = 0; m < 60; m++)
            DropdownMenuItem<int>(value: m, child: Text('第 ${_pad2(m)} 分')),
        ],
        onChanged: (next) {
          if (next != null) setState(() => _minute = next);
        },
      ),
    ),
  );

  Widget _buildMonthDayPicker(BuildContext context) => InputDecorator(
    decoration: const InputDecoration(labelText: '每月几号'),
    child: DropdownButtonHideUnderline(
      child: DropdownButton<int>(
        key: ScheduleEditorScreen.monthDayKey,
        value: _monthDay,
        isExpanded: true,
        isDense: true,
        items: [
          for (var d = 1; d <= 31; d++)
            DropdownMenuItem<int>(value: d, child: Text('$d 号')),
        ],
        onChanged: (next) {
          if (next != null) setState(() => _monthDay = next);
        },
      ),
    ),
  );

  Widget _buildWeekdaySelector(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      spacing: 8,
      children: [
        Text('星期几', style: TimelineType.metaStyle(colors.muted)),
        Wrap(
          spacing: 6,
          runSpacing: 6,
          children: [
            for (final day in _weekOrder)
              FilterChip(
                key: ScheduleEditorScreen.weekdayKey(day),
                label: Text(_weekdayLabels[day] ?? '$day'),
                showCheckmark: false,
                selected: _weekDays.contains(day),
                onSelected: (selected) => setState(() {
                  if (selected) {
                    _weekDays.add(day);
                  } else {
                    _weekDays.remove(day);
                  }
                }),
              ),
          ],
        ),
      ],
    );
  }

  Widget _buildTimePickerRow(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;

    return InkWell(
      key: ScheduleEditorScreen.ruleTimeKey,
      borderRadius: BorderRadius.circular(10),
      onTap: () => unawaited(_pickTime()),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
        decoration: BoxDecoration(
          color: colors.field,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: colors.border),
        ),
        child: Row(
          children: [
            Icon(Icons.access_time, size: 18, color: colors.secondaryText),
            const SizedBox(width: 10),
            Text('触发时间', style: TimelineType.contentStyle(colors.foreground)),
            const Spacer(),
            Text(
              _formatTimeOfDay(_time),
              style: TimelineType.metaMonoStyle(colors.foreground),
            ),
            const SizedBox(width: 4),
            Icon(Icons.chevron_right, size: 18, color: colors.faint),
          ],
        ),
      ),
    );
  }

  Widget _buildExecutionSection(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;

    if (_isLegacyThread) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const _ScheduleSectionHeader(title: '运行设置'),
          const SizedBox(height: 8),
          _ScheduleFormCard(
            children: [
              Padding(
                padding: const EdgeInsets.all(16),
                child: Row(
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
              ),
            ],
          ),
        ],
      );
    }

    final agentChoices = _availableAgentInstances();
    final modelChoices = <({String id, String name})>[
      for (final item in _models) (id: item.id, name: item.name),
      if (_modelId != null && !_models.any((m) => m.id == _modelId))
        (id: _modelId!, name: _modelId!),
    ];
    final permissionWires = <String>[
      for (final p in _permissionChoices) p.wire,
      if (!_permissionChoices.any((p) => p.wire == _permissionMode))
        _permissionMode,
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const _ScheduleSectionHeader(title: '运行设置'),
        const SizedBox(height: 8),
        _ScheduleFormCard(
          children: [
            Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                spacing: 14,
                children: [
                  InputDecorator(
                    decoration: InputDecoration(
                      labelText: 'Agent 实例',
                      helperText: _loadingAgents ? '正在加载电脑上的 Agent 列表…' : null,
                    ),
                    child: DropdownButtonHideUnderline(
                      child: DropdownButton<String?>(
                        key: ScheduleEditorScreen.execAgentKey,
                        value: _instanceId,
                        isExpanded: true,
                        isDense: true,
                        items: [
                          const DropdownMenuItem<String?>(
                            value: null,
                            child: Text('用默认的 Agent'),
                          ),
                          for (final item in agentChoices)
                            DropdownMenuItem<String?>(
                              value: item.instanceId,
                              child: Text(
                                item.label,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
                            ),
                        ],
                        onChanged: (next) {
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
                    ),
                  ),
                  if (_instanceId != null)
                    InputDecorator(
                      decoration: InputDecoration(
                        labelText: '模型（可选）',
                        helperText: _loadingModels ? '正在加载模型列表…' : null,
                      ),
                      child: DropdownButtonHideUnderline(
                        child: DropdownButton<String?>(
                          key: ScheduleEditorScreen.execModelKey,
                          value: _modelId,
                          isExpanded: true,
                          isDense: true,
                          items: [
                            const DropdownMenuItem<String?>(
                              value: null,
                              child: Text('使用实例默认模型'),
                            ),
                            for (final model in modelChoices)
                              DropdownMenuItem<String?>(
                                value: model.id,
                                child: Text(
                                  model.name,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ),
                          ],
                          onChanged: (next) => setState(() => _modelId = next),
                        ),
                      ),
                    ),
                  InputDecorator(
                    decoration: const InputDecoration(labelText: '权限模式'),
                    child: DropdownButtonHideUnderline(
                      child: DropdownButton<String>(
                        key: ScheduleEditorScreen.execPermissionKey,
                        value: _permissionMode,
                        isExpanded: true,
                        isDense: true,
                        items: [
                          for (final wire in permissionWires)
                            DropdownMenuItem<String>(
                              value: wire,
                              child: Text(_permissionLabel(wire)),
                            ),
                        ],
                        onChanged: (next) {
                          if (next != null) {
                            setState(() => _permissionMode = next);
                          }
                        },
                      ),
                    ),
                  ),
                ],
              ),
            ),
            Divider(height: 1, color: colors.divider),
            SwitchListTile.adaptive(
              key: ScheduleEditorScreen.execWorktreeKey,
              title: const Text('在独立 Worktree 中运行'),
              subtitle: Text(
                '每次运行自动创建独立 Git 工作树，不影响当前工作区',
                style: TimelineType.metaStyle(colors.muted),
              ),
              value: _useWorktree,
              onChanged: (next) => setState(() => _useWorktree = next),
            ),
          ],
        ),
      ],
    );
  }
}

class _ScheduleSectionHeader extends StatelessWidget {
  const _ScheduleSectionHeader({required this.title});

  final String title;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 4),
      child: Text(
        title,
        style: TimelineType.metaStyle(colors.muted, weight: FontWeight.w500),
      ),
    );
  }
}

class _ScheduleFormCard extends StatelessWidget {
  const _ScheduleFormCard({required this.children});

  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    return Material(
      color: colors.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(16),
        side: BorderSide(color: colors.border),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: children,
      ),
    );
  }
}
