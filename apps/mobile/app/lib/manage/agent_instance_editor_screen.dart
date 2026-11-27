import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';

import '../app_theme.dart';
import '../mobile_glass.dart';
import '../theme_colors.dart';
import '../timeline/timeline_tokens.dart';
import '../workspace_icon.dart';
import 'manage_form_widgets.dart';
import 'manage_utils.dart';

const agentAccentPalette = <String>[
  '#2563eb',
  '#0891b2',
  '#059669',
  '#65a30d',
  '#d97706',
  '#ea580c',
  '#dc2626',
  '#7c3aed',
];

final _customInstanceIdPattern = RegExp(r'^[A-Za-z][A-Za-z0-9_-]*$');
final _envNamePattern = RegExp(r'^[A-Za-z_][A-Za-z0-9_]*$');
final _digitsOnlyPattern = RegExp(r'^\d+$');

Color? parseAgentAccentColor(String? raw) {
  if (raw == null || raw.length != 7 || !raw.startsWith('#')) return null;
  final hex = int.tryParse(raw.substring(1), radix: 16);
  if (hex == null) return null;
  return Color(0xFF000000 | hex);
}

class _SecretFieldState {
  _SecretFieldState({
    required this.initiallyConfigured,
    required this.initialReference,
  }) : controller = TextEditingController();

  final bool initiallyConfigured;
  final String? initialReference;
  bool replacing = false;
  bool cleared = false;
  bool obscure = true;
  final TextEditingController controller;

  void dispose() => controller.dispose();

  bool get showsLockedConfigured =>
      (initiallyConfigured || initialReference != null) &&
      !replacing &&
      !cleared;
}

class _EnvRowDraft {
  _EnvRowDraft({
    String name = '',
    String plainValue = '',
    this.sensitive = false,
    this.configuredSecret = false,
    this.secretReference,
  }) : nameController = TextEditingController(text: name),
       valueController = TextEditingController(text: plainValue);

  final TextEditingController nameController;
  final TextEditingController valueController;
  bool sensitive;
  bool configuredSecret;
  String? secretReference;
  bool replacingSecret = false;

  void dispose() {
    nameController.dispose();
    valueController.dispose();
  }
}

/// Agent 实例新建与编辑页：支持标识区、全部 7 种动态设置字段（含写只读密钥保护）、模型偏好与删除实例。
class AgentInstanceEditorScreen extends StatefulWidget {
  const AgentInstanceEditorScreen({
    super.key,
    required this.connectionListenable,
    required this.agent,
    this.instance,
    this.computerName,
  });

  static const saveButtonKey = ValueKey('agent-editor-save');
  static const labelInputKey = ValueKey('agent-editor-label');
  static const instanceIdInputKey = ValueKey('agent-editor-instance-id');
  static const copyFromDropdownKey = ValueKey('agent-editor-copy-from');
  static const clearColorChipKey = ValueKey('agent-editor-color-clear');
  static const customModelInputKey = ValueKey(
    'agent-editor-custom-model-input',
  );
  static const customModelAddButtonKey = ValueKey(
    'agent-editor-custom-model-add',
  );
  static const deleteButtonKey = ValueKey('agent-editor-delete');
  static const deleteConfirmKey = ValueKey('agent-editor-delete-confirm');

  static ValueKey<String> colorSwatchKey(String hex) =>
      ValueKey('agent-editor-color-$hex');
  static ValueKey<String> fieldKey(String key) =>
      ValueKey('agent-editor-field-$key');
  static ValueKey<String> secretReplaceKey(String key) =>
      ValueKey('agent-editor-secret-replace-$key');
  static ValueKey<String> secretClearKey(String key) =>
      ValueKey('agent-editor-secret-clear-$key');
  static ValueKey<String> argAddKey(String key) =>
      ValueKey('agent-editor-arg-add-$key');
  static ValueKey<String> envAddKey(String key) =>
      ValueKey('agent-editor-env-add-$key');
  static ValueKey<String> modelSwitchKey(String modelId) =>
      ValueKey('agent-editor-model-switch-$modelId');
  static ValueKey<String> modelRemoveKey(String modelId) =>
      ValueKey('agent-editor-model-remove-$modelId');

  final ValueListenable<MobileConnection?> connectionListenable;
  final MobileAgentSummary agent;
  final MobileAgentInstance? instance;
  final String? computerName;

  bool get isCreate => instance == null;
  bool get isDefaultInstance => instance?.isDefault == true;

  static Future<bool?> open(
    BuildContext context, {
    required ValueListenable<MobileConnection?> connectionListenable,
    required MobileAgentSummary agent,
    MobileAgentInstance? instance,
    String? computerName,
  }) => Navigator.of(context).push<bool>(
    MaterialPageRoute<bool>(
      builder: (_) => AgentInstanceEditorScreen(
        connectionListenable: connectionListenable,
        agent: agent,
        instance: instance,
        computerName: computerName,
      ),
    ),
  );

  @override
  State<AgentInstanceEditorScreen> createState() =>
      _AgentInstanceEditorScreenState();
}

class _AgentInstanceEditorScreenState extends State<AgentInstanceEditorScreen> {
  MobileConnection? _connection;
  bool _saving = false;
  bool _deleting = false;
  String? _validationError;

  late final TextEditingController _labelController;
  late final TextEditingController _instanceIdController;
  final TextEditingController _customModelController = TextEditingController();
  String? _accentColor;
  String? _copyFrom;
  bool _fieldsTouched = false;

  final Map<String, TextEditingController> _textControllers = {};
  final Map<String, bool> _boolValues = {};
  final Map<String, String> _selectValues = {};
  final Map<String, List<TextEditingController>> _argControllers = {};
  final Map<String, List<_EnvRowDraft>> _envRows = {};
  final Map<String, _SecretFieldState> _secretFields = {};

  bool _loadingModels = false;
  bool _modelsExpanded = false;
  String? _modelsError;
  List<MobileAgentModelItem> _models = const [];
  final List<String> _customModels = [];
  final Set<String> _hiddenModels = {};
  bool _modelsModified = false;
  int _modelsSeq = 0;

  List<MobileAgentSettingField> get _visibleFields =>
      widget.agent.fields.where((f) => !f.hidden).toList(growable: false);

  @override
  void initState() {
    super.initState();
    _connection = widget.connectionListenable.value;
    widget.connectionListenable.addListener(_onConnectionChanged);

    final inst = widget.instance;
    _labelController = TextEditingController(text: inst?.label ?? '');
    _instanceIdController = TextEditingController(text: inst?.instanceId ?? '');
    _accentColor = inst?.accentColor;

    final values = inst?.values ?? const <String, dynamic>{};
    _initFieldsFromValues(values);
    _initModelPreferences(values);
    unawaited(_loadModels());
  }

  void _initFieldsFromValues(Map<String, dynamic> values) {
    for (final field in _visibleFields) {
      final raw = values[field.key];
      switch (field.type) {
        case MobileAgentFieldType.text:
        case MobileAgentFieldType.path:
          _textControllers[field.key] = TextEditingController(
            text: raw is String ? raw : '',
          );
        case MobileAgentFieldType.boolean:
          _boolValues[field.key] = raw is bool
              ? raw
              : (field.defaultBool ?? false);
        case MobileAgentFieldType.select:
          final current = raw is String ? raw : '';
          final valid = field.options.any((opt) => opt.value == current);
          _selectValues[field.key] = valid ? current : '';
        case MobileAgentFieldType.arguments:
          final list = <TextEditingController>[];
          if (raw is List) {
            for (final item in raw) {
              if (item is String) {
                list.add(TextEditingController(text: item));
              }
            }
          }
          _argControllers[field.key] = list;
        case MobileAgentFieldType.env:
          final rows = <_EnvRowDraft>[];
          if (raw is List) {
            for (final item in raw) {
              if (item is! Map) continue;
              final name = item['name'] is String ? item['name'] as String : '';
              final val = item['value'];
              final sensitive = item['sensitive'] == true;
              if (val is Map) {
                if (val['configured'] == true) {
                  rows.add(
                    _EnvRowDraft(
                      name: name,
                      sensitive: true,
                      configuredSecret: true,
                    ),
                  );
                } else if (val['reference'] is String) {
                  rows.add(
                    _EnvRowDraft(
                      name: name,
                      sensitive: true,
                      secretReference: val['reference'] as String,
                    ),
                  );
                } else if (val['secret'] is String) {
                  rows.add(
                    _EnvRowDraft(
                      name: name,
                      plainValue: val['secret'] as String,
                      sensitive: true,
                    ),
                  );
                }
              } else if (val is String) {
                rows.add(
                  _EnvRowDraft(
                    name: name,
                    plainValue: val,
                    sensitive: sensitive,
                  ),
                );
              }
            }
          }
          _envRows[field.key] = rows;
        case MobileAgentFieldType.secret:
          var configured = false;
          String? reference;
          if (raw is Map) {
            configured = raw['configured'] == true;
            if (raw['reference'] is String) {
              reference = raw['reference'] as String;
            }
          } else if (raw is String && raw.isNotEmpty) {
            configured = true;
          }
          _secretFields[field.key] = _SecretFieldState(
            initiallyConfigured: configured,
            initialReference: reference,
          );
      }
    }
  }

  void _initModelPreferences(Map<String, dynamic> values) {
    final rawCustom = values[mobileAgentCustomModelsKey];
    if (rawCustom is List) {
      for (final item in rawCustom) {
        if (item is String && item.trim().isNotEmpty) {
          final id = item.trim();
          if (!_customModels.contains(id)) _customModels.add(id);
        }
      }
    }
    final rawHidden = values[mobileAgentHiddenModelsKey];
    if (rawHidden is List) {
      for (final item in rawHidden) {
        if (item is String && item.trim().isNotEmpty) {
          _hiddenModels.add(item.trim());
        }
      }
    }
  }

  @override
  void didUpdateWidget(covariant AgentInstanceEditorScreen oldWidget) {
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
    _labelController.dispose();
    _instanceIdController.dispose();
    _customModelController.dispose();
    for (final c in _textControllers.values) {
      c.dispose();
    }
    for (final list in _argControllers.values) {
      for (final c in list) {
        c.dispose();
      }
    }
    for (final rows in _envRows.values) {
      for (final row in rows) {
        row.dispose();
      }
    }
    for (final secret in _secretFields.values) {
      secret.dispose();
    }
    super.dispose();
  }

  void _onConnectionChanged() {
    if (!mounted) return;
    final next = widget.connectionListenable.value;
    final reconnected = next != null && !identical(next, _connection);
    setState(() => _connection = next);
    if (reconnected && _models.isEmpty) {
      unawaited(_loadModels());
    }
  }

  Future<void> _loadModels() async {
    final conn = _connection;
    if (conn == null || !widget.agent.registered) return;
    final seq = ++_modelsSeq;
    setState(() {
      _loadingModels = true;
      _modelsError = null;
    });
    try {
      final list = await conn.agents.models(
        agentId: widget.instance == null ? widget.agent.agentId : null,
        instanceId: widget.instance?.instanceId,
      );
      if (!mounted || seq != _modelsSeq) return;
      setState(() {
        _models = list;
        if (!_modelsModified) {
          for (final item in list) {
            if (item.isCustom && !_customModels.contains(item.id)) {
              _customModels.add(item.id);
            }
            if (item.hidden) _hiddenModels.add(item.id);
          }
        }
        _loadingModels = false;
      });
    } catch (error) {
      if (!mounted || seq != _modelsSeq) return;
      setState(() {
        _loadingModels = false;
        _modelsError = manageErrorMessage(error);
      });
    }
  }

  List<MobileAgentModelItem> get _displayModels {
    final result = <MobileAgentModelItem>[];
    final seen = <String>{};
    for (final item in _models) {
      if (item.isCustom && !_customModels.contains(item.id)) continue;
      seen.add(item.id);
      result.add(
        MobileAgentModelItem(
          id: item.id,
          name: item.name,
          isCustom: item.isCustom || _customModels.contains(item.id),
          hidden: _hiddenModels.contains(item.id),
        ),
      );
    }
    for (final id in _customModels) {
      if (seen.contains(id)) continue;
      seen.add(id);
      result.add(
        MobileAgentModelItem(
          id: id,
          name: id,
          isCustom: true,
          hidden: _hiddenModels.contains(id),
        ),
      );
    }
    return result;
  }

  void _addCustomModel() {
    final id = _customModelController.text.trim();
    if (id.isEmpty) return;
    if (id.length > 256) {
      setState(() => _validationError = '模型 ID 长度不能超过 256 个字符。');
      return;
    }
    setState(() {
      _validationError = null;
      if (!_customModels.contains(id)) {
        _customModels.add(id);
      }
      _hiddenModels.remove(id);
      _customModelController.clear();
      _modelsModified = true;
      _fieldsTouched = true;
    });
  }

  Map<String, Object?>? _buildValidatedValues() {
    final values = widget.instance != null
        ? Map<String, Object?>.from(widget.instance!.values)
        : <String, Object?>{};

    for (final field in _visibleFields) {
      switch (field.type) {
        case MobileAgentFieldType.text:
          final text = _textControllers[field.key]!.text.trim();
          if (text.isNotEmpty && field.integerRange != null) {
            final range = field.integerRange!;
            final parsed = _digitsOnlyPattern.hasMatch(text)
                ? int.tryParse(text)
                : null;
            if (parsed == null || parsed < range.min || parsed > range.max) {
              setState(
                () => _validationError =
                    '「${field.label}」必须是 ${range.min} 到 ${range.max} 之间的整数。',
              );
              return null;
            }
          }
          values[field.key] = text;
        case MobileAgentFieldType.path:
          values[field.key] = _textControllers[field.key]!.text.trim();
        case MobileAgentFieldType.boolean:
          values[field.key] = _boolValues[field.key] ?? false;
        case MobileAgentFieldType.select:
          values[field.key] = _selectValues[field.key] ?? '';
        case MobileAgentFieldType.arguments:
          final args = <String>[];
          for (final controller in _argControllers[field.key]!) {
            final value = controller.text.trim();
            if (value.isNotEmpty) args.add(value);
          }
          values[field.key] = args;
        case MobileAgentFieldType.env:
          final entries = <Map<String, Object?>>[];
          for (final row in _envRows[field.key]!) {
            final name = row.nameController.text.trim();
            final text = row.valueController.text;
            if (name.isEmpty &&
                text.isEmpty &&
                !row.configuredSecret &&
                row.secretReference == null) {
              continue;
            }
            if (!_envNamePattern.hasMatch(name)) {
              setState(
                () => _validationError =
                    '「${field.label}」中的变量名「$name」无效，仅支持字母/下划线开头及字母、数字、下划线。',
              );
              return null;
            }
            if (row.sensitive) {
              Object valuePayload;
              if (row.configuredSecret && !row.replacingSecret) {
                valuePayload = const {'configured': true};
              } else if (row.secretReference != null && !row.replacingSecret) {
                valuePayload = {'reference': row.secretReference!};
              } else if (widget.agent.secretReferences &&
                  text.trim().startsWith('op://')) {
                valuePayload = {'reference': text.trim()};
              } else {
                valuePayload = {'secret': text};
              }
              entries.add({
                'name': name,
                'value': valuePayload,
                'sensitive': true,
              });
            } else {
              entries.add({'name': name, 'value': text});
            }
          }
          values[field.key] = entries;
        case MobileAgentFieldType.secret:
          final state = _secretFields[field.key]!;
          if (state.cleared) {
            values[field.key] = '';
          } else if (state.showsLockedConfigured) {
            values[field.key] = state.initialReference != null
                ? {'reference': state.initialReference!}
                : const {'configured': true};
          } else {
            final entered = state.controller.text.trim();
            if (entered.isEmpty) {
              values[field.key] = '';
            } else if (widget.agent.secretReferences &&
                entered.startsWith('op://')) {
              values[field.key] = {'reference': entered};
            } else {
              values[field.key] = {'secret': entered};
            }
          }
      }
    }

    if (widget.agent.customModels && (_modelsModified || !widget.isCreate)) {
      values[mobileAgentCustomModelsKey] = List<String>.from(_customModels);
    }
    if (_modelsModified || !widget.isCreate) {
      values[mobileAgentHiddenModelsKey] = _hiddenModels.toList();
    }
    return values;
  }

  Future<void> _save() async {
    final conn = _connection;
    if (conn == null || _saving || _deleting) return;
    setState(() => _validationError = null);

    if (widget.isCreate) {
      final rawId = _instanceIdController.text.trim();
      if (rawId.isNotEmpty && !_customInstanceIdPattern.hasMatch(rawId)) {
        setState(() => _validationError = '实例 ID 必须以字母开头，仅可包含字母、数字、下划线和短横线。');
        return;
      }
      final values = (_copyFrom != null && !_fieldsTouched)
          ? null
          : _buildValidatedValues();
      if (_copyFrom == null && values == null) return;
      if (_copyFrom != null && _fieldsTouched && values == null) return;

      setState(() => _saving = true);
      try {
        await conn.agents.createInstance(
          agentId: widget.agent.agentId,
          label: _labelController.text.trim(),
          instanceId: rawId.isEmpty ? null : rawId,
          accentColor: _accentColor,
          values: values,
          copyFrom: _copyFrom,
        );
        if (!mounted) return;
        ScaffoldMessenger.maybeOf(
          context,
        )?.showSnackBar(const SnackBar(content: Text('已创建 Agent 实例')));
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

    // Edit mode.
    final inst = widget.instance!;
    final values = _buildValidatedValues();
    if (values == null) return;

    final label = _labelController.text.trim();
    if (!inst.isDefault && label.isEmpty) {
      setState(() => _validationError = '请输入实例名称。');
      return;
    }

    setState(() => _saving = true);
    try {
      await conn.agents.updateInstance(
        instanceId: inst.instanceId,
        label: inst.isDefault ? null : label,
        accentColor: inst.isDefault ? null : _accentColor,
        clearAccentColor:
            !inst.isDefault && inst.accentColor != null && _accentColor == null,
        values: values,
      );
      if (!mounted) return;
      ScaffoldMessenger.maybeOf(
        context,
      )?.showSnackBar(const SnackBar(content: Text('实例配置已保存')));
      Navigator.of(context).pop(true);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _saving = false;
        _validationError = manageErrorMessage(error);
      });
    }
  }

  Future<void> _deleteInstance() async {
    final conn = _connection;
    final inst = widget.instance;
    if (conn == null ||
        inst == null ||
        inst.isDefault ||
        _saving ||
        _deleting) {
      return;
    }
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) {
        final colors = Theme.of(dialogContext).brightness == Brightness.dark
            ? pigcodeDark
            : pigcodeLight;
        return MobileGlassDialog(
          title: Text('删除「${inst.label}」？'),
          content: const Text('将删除此自定义实例及其保存的配置与密钥。如果仍有历史会话使用该实例，删除会被阻止。'),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(dialogContext).pop(false),
              child: const Text('取消'),
            ),
            FilledButton(
              key: AgentInstanceEditorScreen.deleteConfirmKey,
              style: FilledButton.styleFrom(
                backgroundColor: colors.error,
                foregroundColor: colors.onError,
              ),
              onPressed: () => Navigator.of(dialogContext).pop(true),
              child: const Text('确认删除'),
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
      await conn.agents.removeInstance(instanceId: inst.instanceId);
      if (!mounted) return;
      ScaffoldMessenger.maybeOf(
        context,
      )?.showSnackBar(SnackBar(content: Text('已删除实例「${inst.label}」')));
      Navigator.of(context).pop(true);
    } catch (error) {
      if (!mounted) return;
      setState(() {
        _deleting = false;
        _validationError = manageErrorMessage(error);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final busy = _saving || _deleting;

    bool isAdvancedField(MobileAgentSettingField f) =>
        f.type == MobileAgentFieldType.arguments ||
        f.type == MobileAgentFieldType.env ||
        f.key == 'launchArgs' ||
        f.key == 'arguments';

    final primaryFields = _visibleFields
        .where((f) => !isAdvancedField(f))
        .toList(growable: false);
    final advancedFields = _visibleFields
        .where(isAdvancedField)
        .toList(growable: false);

    return Scaffold(
      backgroundColor: colors.background,
      appBar: AppBar(
        title: ManageAppBarTitle(
          title: widget.isCreate
              ? '新建 ${widget.agent.displayName} 实例'
              : widget.instance!.label,
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
                _buildIdentitySection(context),
                if (primaryFields.isNotEmpty) ...[
                  const SizedBox(height: 22),
                  const ManageSectionHeader(title: '基础配置'),
                  const SizedBox(height: 8),
                  ManageSurfaceCard(
                    children: [
                      for (var i = 0; i < primaryFields.length; i++) ...[
                        if (i > 0) Divider(height: 1, color: colors.divider),
                        _buildFieldWidget(context, primaryFields[i]),
                      ],
                    ],
                  ),
                ],
                if (advancedFields.isNotEmpty) ...[
                  const SizedBox(height: 22),
                  const ManageSectionHeader(title: '启动参数与环境变量'),
                  const SizedBox(height: 8),
                  ManageSurfaceCard(
                    children: [
                      for (var i = 0; i < advancedFields.length; i++) ...[
                        if (i > 0) Divider(height: 1, color: colors.divider),
                        _buildFieldWidget(context, advancedFields[i]),
                      ],
                    ],
                  ),
                ],
                if (widget.agent.customModels ||
                    _models.isNotEmpty ||
                    _loadingModels) ...[
                  const SizedBox(height: 22),
                  const ManageSectionHeader(title: '模型偏好'),
                  const SizedBox(height: 8),
                  _buildModelsSection(context),
                ],
                if (!widget.isCreate && !widget.isDefaultInstance) ...[
                  const SizedBox(height: 24),
                  ManageDestructiveRow(
                    buttonKey: AgentInstanceEditorScreen.deleteButtonKey,
                    label: _deleting ? '正在删除…' : '删除此实例',
                    busy: _deleting,
                    onPressed: _connection == null || busy
                        ? null
                        : _deleteInstance,
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
            key: AgentInstanceEditorScreen.saveButtonKey,
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
            child: Text(_saving ? '保存中…' : (widget.isCreate ? '创建实例' : '保存修改')),
          ),
        ),
      ),
    );
  }

  Widget _buildIdentitySection(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;

    if (widget.isDefaultInstance) {
      final inst = widget.instance!;
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const ManageSectionHeader(title: '默认实例'),
          const SizedBox(height: 8),
          ManageSurfaceCard(
            padding: const EdgeInsets.all(16),
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      inst.label,
                      style: TimelineType.headingStyle(
                        TimelineType.heading2,
                        FontWeight.w600,
                      ).copyWith(color: colors.foreground),
                    ),
                  ),
                  ManageStatusTag(
                    label: '内置默认',
                    background: colors.field,
                    foreground: colors.secondaryText,
                  ),
                ],
              ),
              const SizedBox(height: 4),
              Text(
                'ID · ${inst.instanceId}',
                style: TimelineType.smallStyle(colors.muted),
              ),
              const SizedBox(height: 6),
              Text(
                '内置实例名称和标识色不可更改，可直接编辑以下参数与模型偏好。',
                style: TimelineType.smallStyle(colors.muted),
              ),
            ],
          ),
        ],
      );
    }

    final copySource = widget.agent.instances
        .where((s) => s.instanceId == _copyFrom)
        .firstOrNull;
    final copyLabel = copySource == null
        ? '不复制（空白配置）'
        : '${copySource.label} (${copySource.instanceId})';

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const ManageSectionHeader(title: '基本信息'),
        const SizedBox(height: 8),
        ManageSurfaceCard(
          children: [
            Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  ManageFilledTextField(
                    fieldKey: AgentInstanceEditorScreen.labelInputKey,
                    controller: _labelController,
                    label: '实例名称',
                    hintText: '例如：工作号、API 备用',
                  ),
                  const SizedBox(height: 14),
                  if (widget.isCreate)
                    ManageFilledTextField(
                      fieldKey: AgentInstanceEditorScreen.instanceIdInputKey,
                      controller: _instanceIdController,
                      label: '自定义 ID（可选）',
                      hintText: '留空自动生成，如 claude-work',
                      helperText: '支持字母开头，包含字母、数字、下划线或短横线',
                      style: TimelineType.metaMonoStyle(colors.foreground),
                    )
                  else
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 10,
                      ),
                      decoration: BoxDecoration(
                        color: colors.field,
                        borderRadius: BorderRadius.circular(12),
                      ),
                      child: Row(
                        children: [
                          Text(
                            '实例 ID',
                            style: TimelineType.metaStyle(colors.muted),
                          ),
                          const Spacer(),
                          Text(
                            widget.instance!.instanceId,
                            style: TimelineType.metaMonoStyle(
                              colors.foreground,
                            ),
                          ),
                        ],
                      ),
                    ),
                ],
              ),
            ),
            if (widget.isCreate && widget.agent.instances.isNotEmpty) ...[
              Divider(height: 1, color: colors.divider),
              ManagePickerRow(
                key: AgentInstanceEditorScreen.copyFromDropdownKey,
                title: '复制配置自',
                value: copyLabel,
                onTap: () async {
                  final picked = await ManageSelectSheet.show<_OptionalId>(
                    context,
                    title: '选择配置来源',
                    selected: _OptionalId(_copyFrom),
                    options: [
                      const ManageSelectOption(
                        value: _OptionalId(null),
                        label: '不复制（从空白配置开始）',
                      ),
                      for (final source in widget.agent.instances)
                        ManageSelectOption(
                          value: _OptionalId(source.instanceId),
                          label: '${source.label} (${source.instanceId})',
                        ),
                    ],
                  );
                  if (picked != null && mounted) {
                    setState(() => _copyFrom = picked.id);
                  }
                },
              ),
            ],
            Divider(height: 1, color: colors.divider),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '标识色',
                    style: TimelineType.metaStyle(
                      colors.secondaryText,
                      weight: FontWeight.w500,
                    ),
                  ),
                  const SizedBox(height: 10),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      for (final hex in agentAccentPalette)
                        GestureDetector(
                          key: AgentInstanceEditorScreen.colorSwatchKey(hex),
                          onTap: () => setState(() => _accentColor = hex),
                          child: Container(
                            width: 28,
                            height: 28,
                            padding: const EdgeInsets.all(2),
                            decoration: BoxDecoration(
                              shape: BoxShape.circle,
                              border: Border.all(
                                color: _accentColor == hex
                                    ? colors.foreground
                                    : Colors.transparent,
                                width: 1.5,
                              ),
                            ),
                            child: DecoratedBox(
                              decoration: BoxDecoration(
                                color: parseAgentAccentColor(hex),
                                shape: BoxShape.circle,
                              ),
                              child: _accentColor == hex
                                  ? const Center(
                                      child: Icon(
                                        Icons.check,
                                        size: 14,
                                        color: Colors.white,
                                      ),
                                    )
                                  : null,
                            ),
                          ),
                        ),
                      GestureDetector(
                        key: AgentInstanceEditorScreen.clearColorChipKey,
                        onTap: () => setState(() => _accentColor = null),
                        child: Container(
                          width: 28,
                          height: 28,
                          padding: const EdgeInsets.all(2),
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            border: Border.all(
                              color: _accentColor == null
                                  ? colors.foreground
                                  : colors.border,
                              width: _accentColor == null ? 1.5 : 1,
                            ),
                          ),
                          child: Center(
                            child: Icon(
                              Icons.block_rounded,
                              size: 14,
                              color: _accentColor == null
                                  ? colors.foreground
                                  : colors.muted,
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
              ),
            ),
          ],
        ),
      ],
    );
  }

  Widget _buildFieldWidget(
    BuildContext context,
    MobileAgentSettingField field,
  ) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;

    switch (field.type) {
      case MobileAgentFieldType.boolean:
        final value = _boolValues[field.key] ?? false;
        return ManageSwitchRow(
          switchKey: AgentInstanceEditorScreen.fieldKey(field.key),
          title: field.label,
          subtitle: field.description,
          value: value,
          onChanged: (next) => setState(() {
            _boolValues[field.key] = next;
            _fieldsTouched = true;
          }),
        );
      case MobileAgentFieldType.text:
      case MobileAgentFieldType.path:
        final controller = _textControllers[field.key]!;
        final range = field.integerRange;
        return Padding(
          padding: const EdgeInsets.all(16),
          child: ManageFilledTextField(
            fieldKey: AgentInstanceEditorScreen.fieldKey(field.key),
            controller: controller,
            label: field.label,
            hintText:
                field.placeholder ??
                (field.type == MobileAgentFieldType.path
                    ? '填写电脑本机路径（留空使用默认）'
                    : null),
            helperText: field.description,
            keyboardType: range != null
                ? TextInputType.number
                : TextInputType.text,
            style: field.monospace || field.type == MobileAgentFieldType.path
                ? TimelineType.metaMonoStyle(colors.foreground)
                : null,
            onChanged: (_) => _fieldsTouched = true,
          ),
        );
      case MobileAgentFieldType.select:
        final current = _selectValues[field.key] ?? '';
        final currentOpt = field.options
            .where((o) => o.value == current)
            .firstOrNull;
        return ManagePickerRow(
          key: AgentInstanceEditorScreen.fieldKey(field.key),
          title: field.label,
          subtitle: field.description,
          value: current.isEmpty ? '使用默认' : (currentOpt?.label ?? current),
          onTap: () async {
            final next = await ManageSelectSheet.show<String>(
              context,
              title: field.label,
              selected: current,
              options: [
                const ManageSelectOption(value: '', label: '使用默认'),
                for (final opt in field.options)
                  ManageSelectOption(value: opt.value, label: opt.label),
              ],
            );
            if (next != null && mounted) {
              setState(() {
                _selectValues[field.key] = next;
                _fieldsTouched = true;
              });
            }
          },
        );
      case MobileAgentFieldType.secret:
        final state = _secretFields[field.key]!;
        return Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                field.label,
                style: TimelineType.metaStyle(
                  colors.secondaryText,
                  weight: FontWeight.w500,
                ),
              ),
              if (field.description != null &&
                  field.description!.trim().isNotEmpty) ...[
                const SizedBox(height: 3),
                Text(
                  field.description!,
                  style: TimelineType.smallStyle(colors.muted),
                ),
              ],
              const SizedBox(height: 8),
              if (state.showsLockedConfigured)
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 8,
                  ),
                  decoration: BoxDecoration(
                    color: colors.field,
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: colors.border),
                  ),
                  child: Row(
                    children: [
                      Icon(
                        Icons.lock_outline,
                        size: 16,
                        color: colors.secondaryText,
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          state.initialReference != null
                              ? '已引用 ${state.initialReference}'
                              : '已配置（出于安全不回传明文）',
                          style: TimelineType.smallStyle(colors.secondaryText),
                        ),
                      ),
                      TextButton(
                        key: AgentInstanceEditorScreen.secretReplaceKey(
                          field.key,
                        ),
                        style: TextButton.styleFrom(
                          visualDensity: VisualDensity.compact,
                        ),
                        onPressed: () => setState(() {
                          state.replacing = true;
                          state.cleared = false;
                          _fieldsTouched = true;
                        }),
                        child: const Text('替换'),
                      ),
                      TextButton(
                        key: AgentInstanceEditorScreen.secretClearKey(
                          field.key,
                        ),
                        style: TextButton.styleFrom(
                          visualDensity: VisualDensity.compact,
                        ),
                        onPressed: () => setState(() {
                          state.cleared = true;
                          state.replacing = false;
                          state.controller.clear();
                          _fieldsTouched = true;
                        }),
                        child: Text(
                          '清空',
                          style: TextStyle(color: colors.error),
                        ),
                      ),
                    ],
                  ),
                )
              else
                ManageFilledTextField(
                  fieldKey: AgentInstanceEditorScreen.fieldKey(field.key),
                  controller: state.controller,
                  obscureText: state.obscure,
                  hintText: widget.agent.secretReferences
                      ? '输入密钥或 op:// 引用（留空清除）'
                      : '输入密钥（留空清除）',
                  suffix: IconButton(
                    tooltip: state.obscure ? '显示' : '隐藏',
                    onPressed: () =>
                        setState(() => state.obscure = !state.obscure),
                    icon: Icon(
                      state.obscure ? Icons.visibility : Icons.visibility_off,
                      size: 18,
                      color: colors.muted,
                    ),
                  ),
                  onChanged: (_) => setState(() {
                    state.cleared = false;
                    _fieldsTouched = true;
                  }),
                ),
            ],
          ),
        );
      case MobileAgentFieldType.arguments:
        final controllers = _argControllers[field.key]!;
        return Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      field.label,
                      style: TimelineType.contentStyle(
                        colors.foreground,
                        weight: FontWeight.w500,
                      ),
                    ),
                  ),
                  TextButton.icon(
                    key: AgentInstanceEditorScreen.argAddKey(field.key),
                    style: TextButton.styleFrom(
                      visualDensity: VisualDensity.compact,
                      foregroundColor: colors.secondaryText,
                    ),
                    onPressed: () => setState(() {
                      controllers.add(TextEditingController());
                      _fieldsTouched = true;
                    }),
                    icon: const Icon(Icons.add, size: 16),
                    label: const Text('添加'),
                  ),
                ],
              ),
              if (field.description != null &&
                  field.description!.trim().isNotEmpty) ...[
                const SizedBox(height: 2),
                Text(
                  field.description!,
                  style: TimelineType.smallStyle(colors.muted),
                ),
              ],
              const SizedBox(height: 8),
              if (controllers.isEmpty)
                Text('暂无额外启动参数', style: TimelineType.smallStyle(colors.muted)),
              for (var i = 0; i < controllers.length; i++) ...[
                if (i > 0) const SizedBox(height: 8),
                Row(
                  children: [
                    Expanded(
                      child: ManageFilledTextField(
                        fieldKey: ValueKey('agent-editor-arg-${field.key}-$i'),
                        controller: controllers[i],
                        hintText: '参数 ${i + 1}',
                        style: TimelineType.metaMonoStyle(colors.foreground),
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 12,
                          vertical: 9,
                        ),
                        onChanged: (_) => _fieldsTouched = true,
                      ),
                    ),
                    IconButton(
                      tooltip: '移除参数',
                      onPressed: () => setState(() {
                        final removed = controllers.removeAt(i);
                        removed.dispose();
                        _fieldsTouched = true;
                      }),
                      icon: Icon(
                        Icons.remove_circle_outline,
                        size: 18,
                        color: colors.muted,
                      ),
                    ),
                  ],
                ),
              ],
            ],
          ),
        );
      case MobileAgentFieldType.env:
        final rows = _envRows[field.key]!;
        return Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      field.label,
                      style: TimelineType.contentStyle(
                        colors.foreground,
                        weight: FontWeight.w500,
                      ),
                    ),
                  ),
                  TextButton.icon(
                    key: AgentInstanceEditorScreen.envAddKey(field.key),
                    style: TextButton.styleFrom(
                      visualDensity: VisualDensity.compact,
                      foregroundColor: colors.secondaryText,
                    ),
                    onPressed: () => setState(() {
                      rows.add(_EnvRowDraft());
                      _fieldsTouched = true;
                    }),
                    icon: const Icon(Icons.add, size: 16),
                    label: const Text('添加'),
                  ),
                ],
              ),
              if (field.description != null &&
                  field.description!.trim().isNotEmpty) ...[
                const SizedBox(height: 2),
                Text(
                  field.description!,
                  style: TimelineType.smallStyle(colors.muted),
                ),
              ],
              const SizedBox(height: 8),
              if (rows.isEmpty)
                Text('暂无环境变量', style: TimelineType.smallStyle(colors.muted)),
              for (var i = 0; i < rows.length; i++) ...[
                if (i > 0) const SizedBox(height: 10),
                _buildEnvRow(context, field.key, rows, i),
              ],
            ],
          ),
        );
    }
  }

  Widget _buildEnvRow(
    BuildContext context,
    String fieldKey,
    List<_EnvRowDraft> rows,
    int index,
  ) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final row = rows[index];
    final locked =
        row.sensitive &&
        (row.configuredSecret || row.secretReference != null) &&
        !row.replacingSecret;

    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: colors.surfaceSunken,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: colors.border),
      ),
      child: Column(
        spacing: 8,
        children: [
          Row(
            children: [
              Expanded(
                child: ManageFilledTextField(
                  fieldKey: ValueKey('agent-editor-env-name-$fieldKey-$index'),
                  controller: row.nameController,
                  hintText: '变量名（如 API_KEY）',
                  style: TimelineType.metaMonoStyle(colors.foreground),
                  contentPadding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 9,
                  ),
                  onChanged: (_) => _fieldsTouched = true,
                ),
              ),
              IconButton(
                tooltip: '删除变量',
                onPressed: () => setState(() {
                  final removed = rows.removeAt(index);
                  removed.dispose();
                  _fieldsTouched = true;
                }),
                icon: Icon(Icons.close, size: 18, color: colors.muted),
              ),
            ],
          ),
          if (locked)
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
              decoration: BoxDecoration(
                color: colors.field,
                borderRadius: BorderRadius.circular(10),
              ),
              child: Row(
                children: [
                  Icon(
                    Icons.lock_outline,
                    size: 14,
                    color: colors.secondaryText,
                  ),
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      row.secretReference ?? '敏感值已配置',
                      style: TimelineType.smallStyle(colors.secondaryText),
                    ),
                  ),
                  TextButton(
                    style: TextButton.styleFrom(
                      visualDensity: VisualDensity.compact,
                    ),
                    onPressed: () => setState(() {
                      row.replacingSecret = true;
                      _fieldsTouched = true;
                    }),
                    child: const Text('替换'),
                  ),
                ],
              ),
            )
          else
            ManageFilledTextField(
              fieldKey: ValueKey('agent-editor-env-value-$fieldKey-$index'),
              controller: row.valueController,
              obscureText: row.sensitive,
              hintText: row.sensitive ? '输入敏感值' : '变量值',
              style: TimelineType.metaMonoStyle(colors.foreground),
              contentPadding: const EdgeInsets.symmetric(
                horizontal: 10,
                vertical: 9,
              ),
              onChanged: (_) => _fieldsTouched = true,
            ),
          Row(
            children: [
              Text('作为敏感密钥保护', style: TimelineType.smallStyle(colors.muted)),
              const Spacer(),
              Switch.adaptive(
                value: row.sensitive,
                onChanged: (next) => setState(() {
                  row.sensitive = next;
                  if (!row.sensitive) {
                    row.configuredSecret = false;
                    row.secretReference = null;
                    row.replacingSecret = false;
                  }
                  _fieldsTouched = true;
                }),
              ),
            ],
          ),
        ],
      ),
    );
  }

  static const _collapsedModelLimit = 6;

  Widget _buildModelsSection(BuildContext context) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final allItems = _displayModels;
    final canCollapse = allItems.length > _collapsedModelLimit;
    final List<MobileAgentModelItem> items;
    if (!canCollapse || _modelsExpanded) {
      items = allItems;
    } else {
      final prioritized = <MobileAgentModelItem>[
        for (final item in allItems)
          if (item.isCustom || item.hidden) item,
      ];
      final seenIds = {for (final item in prioritized) item.id};
      for (final item in allItems) {
        if (prioritized.length >= _collapsedModelLimit) break;
        if (seenIds.add(item.id)) prioritized.add(item);
      }
      items = prioritized;
    }
    return ManageSurfaceCard(
      children: [
        if (widget.agent.customModels)
          Padding(
            padding: const EdgeInsets.all(14),
            child: Row(
              children: [
                Expanded(
                  child: ManageFilledTextField(
                    fieldKey: AgentInstanceEditorScreen.customModelInputKey,
                    controller: _customModelController,
                    hintText: '输入自定义模型 ID，如 claude-opus-4-6',
                    style: TimelineType.metaMonoStyle(colors.foreground),
                    contentPadding: const EdgeInsets.symmetric(
                      horizontal: 12,
                      vertical: 10,
                    ),
                    onSubmitted: (_) => _addCustomModel(),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  key: AgentInstanceEditorScreen.customModelAddButtonKey,
                  style: FilledButton.styleFrom(
                    backgroundColor: colors.field,
                    foregroundColor: colors.foreground,
                    elevation: 0,
                    minimumSize: const Size(58, 42),
                    shape: RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(12),
                      side: BorderSide(color: colors.border),
                    ),
                  ),
                  onPressed: _addCustomModel,
                  child: const Text('添加'),
                ),
              ],
            ),
          ),
        if (_loadingModels)
          const Padding(
            padding: EdgeInsets.all(16),
            child: Center(child: CircularProgressIndicator.adaptive()),
          )
        else if (_modelsError != null && allItems.isEmpty)
          Padding(
            padding: const EdgeInsets.all(16),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    _modelsError!,
                    style: TimelineType.metaStyle(colors.muted),
                  ),
                ),
                TextButton(
                  onPressed: () => unawaited(_loadModels()),
                  child: const Text('重试'),
                ),
              ],
            ),
          )
        else if (allItems.isEmpty)
          Padding(
            padding: const EdgeInsets.all(16),
            child: Text(
              '暂无可配置的模型列表',
              style: TimelineType.metaStyle(colors.muted),
            ),
          )
        else ...[
          for (var i = 0; i < items.length; i++) ...[
            if (i > 0 || widget.agent.customModels)
              Divider(height: 1, color: colors.divider),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 10, 12, 10),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Flexible(
                              child: Text(
                                items[i].name,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TimelineType.contentStyle(
                                  colors.foreground,
                                  weight: FontWeight.w500,
                                ),
                              ),
                            ),
                            if (items[i].isCustom) ...[
                              const SizedBox(width: 6),
                              ManageStatusTag(
                                label: '自定义',
                                background: colors.field,
                                foreground: colors.secondaryText,
                              ),
                            ],
                          ],
                        ),
                        if (items[i].name != items[i].id) ...[
                          const SizedBox(height: 2),
                          Text(
                            items[i].id,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TimelineType.smallStyle(colors.muted),
                          ),
                        ],
                      ],
                    ),
                  ),
                  if (items[i].isCustom)
                    IconButton(
                      key: AgentInstanceEditorScreen.modelRemoveKey(
                        items[i].id,
                      ),
                      tooltip: '移除自定义模型',
                      onPressed: () => setState(() {
                        _customModels.remove(items[i].id);
                        _hiddenModels.remove(items[i].id);
                        _modelsModified = true;
                        _fieldsTouched = true;
                      }),
                      icon: Icon(
                        Icons.delete_outline,
                        size: 18,
                        color: colors.muted,
                      ),
                    ),
                  Switch.adaptive(
                    key: AgentInstanceEditorScreen.modelSwitchKey(items[i].id),
                    value: !items[i].hidden,
                    onChanged: (visible) => setState(() {
                      if (visible) {
                        _hiddenModels.remove(items[i].id);
                      } else {
                        _hiddenModels.add(items[i].id);
                      }
                      _modelsModified = true;
                      _fieldsTouched = true;
                    }),
                  ),
                ],
              ),
            ),
          ],
          if (canCollapse) ...[
            Divider(height: 1, color: colors.divider),
            InkWell(
              key: const ValueKey('agent-editor-models-toggle'),
              onTap: () => setState(() => _modelsExpanded = !_modelsExpanded),
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: 44),
                child: Center(
                  child: Text(
                    _modelsExpanded ? '收起模型列表' : '展开全部 ${allItems.length} 个模型',
                    style: TimelineType.metaStyle(
                      colors.secondaryText,
                      weight: FontWeight.w500,
                    ),
                  ),
                ),
              ),
            ),
          ],
        ],
      ],
    );
  }
}

class _OptionalId {
  const _OptionalId(this.id);

  final String? id;

  @override
  bool operator ==(Object other) => other is _OptionalId && other.id == id;

  @override
  int get hashCode => id.hashCode;
}
