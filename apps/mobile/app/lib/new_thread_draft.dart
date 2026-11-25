import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pigcode_client/pigcode_client.dart';

import 'composer/composer_catalog.dart';
import 'composer/composer_suggestion_panel.dart';
import 'composer/composer_tokens.dart';
import 'composer/mention_editing_controller.dart';
import 'composer/mobile_composer_card.dart';
import 'composer/model_picker_sheet.dart';
import 'composer/model_preferences.dart';
import 'mobile_sheet.dart';
import 'new_thread_draft_state.dart';
import 'workspace_icon.dart';

class NewThreadDraft extends ConsumerStatefulWidget {
  const NewThreadDraft({
    super.key,
    required this.connection,
    required this.projects,
    required this.online,
    required this.onAccepted,
    this.threads = const [],
    this.projectId,
    this.fallbackProjectId,
    this.onProjectNameChanged,
    this.computerKey,
    this.deviceId,
    this.leading,
  });

  final MobileConnection? connection;
  final String? computerKey;
  final String? deviceId;
  final String? projectId;
  final String? fallbackProjectId;
  final ValueChanged<String?>? onProjectNameChanged;
  final List<MobileProjectSummary> projects;
  final List<MobileThreadSummary> threads;
  final bool online;
  final ValueChanged<MobileDraftReceipt> onAccepted;
  final Widget? leading;

  @override
  ConsumerState<NewThreadDraft> createState() => _NewThreadDraftState();
}

class _NewThreadDraftState extends ConsumerState<NewThreadDraft> {
  late final _entry = DraftEntry(widget.projectId);
  String? _reportedProjectName;
  final _textController = ComposerTextEditingController();
  final _focusNode = FocusNode();
  bool _initialTextSynced = false;
  final _selectionNotifier = ValueNotifier<ComposerSelectionSnapshot>(
    const ComposerSelectionSnapshot(),
  );
  ComposerSelectionSnapshot _latestSelection =
      const ComposerSelectionSnapshot();

  DraftTarget get _target => (
    connection: widget.connection,
    computerKey: widget.computerKey ?? widget.connection!.computer.computerKey,
    deviceId: widget.deviceId ?? widget.connection!.deviceId,
    entry: _entry,
  );

  @override
  void dispose() {
    _textController.dispose();
    _focusNode.dispose();
    _selectionNotifier.dispose();
    super.dispose();
  }

  void _syncTextFromForm(String nextText) {
    if (_textController.text == nextText) return;
    _textController.value = TextEditingValue(
      text: nextText,
      selection: TextSelection.collapsed(offset: nextText.length),
    );
  }

  void _scheduleSelectionSync(ComposerSelectionSnapshot snapshot) {
    _latestSelection = snapshot;
    if (_selectionNotifier.value == snapshot) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && _selectionNotifier.value != _latestSelection) {
        _selectionNotifier.value = _latestSelection;
      }
    });
  }

  Future<void> _applyDraftEdit(
    NewThreadForm Function(NewThreadForm current) update,
  ) async {
    while (mounted) {
      final active = _target;
      final provider = newThreadDraftProvider(active);
      final NewThreadDraftState view;
      try {
        view = await ref.read(provider.future);
      } catch (_) {
        if (mounted && active != _target) continue;
        return;
      }
      if (!mounted) return;
      if (active != _target) continue;
      final current = ref.read(provider).value?.form ?? view.form;
      ref.read(provider.notifier).edit(update(current));
      return;
    }
  }

  Future<void> _openModelPicker(MobileConnection connection) async {
    _selectionNotifier.value = _latestSelection;
    await showMobileModelPickerSheet(
      context: context,
      connection: connection,
      selection: _selectionNotifier,
      onSelectModel: (nextInstance, nextModel) async {
        await _applyDraftEdit((current) {
          final currentPermission = current.permissionMode;
          final nextPermission =
              currentPermission != null &&
                  nextInstance.permissionModes.contains(currentPermission)
              ? currentPermission
              : nextInstance.defaultPermissionMode;
          final nextPlanMode = nextInstance.supportsPlanMode == true
              ? current.planMode
              : false;
          final nextForm = current.copyWith(
            instanceId: nextInstance.instanceId,
            instanceLabel: nextInstance.label,
            modelId: nextModel.id,
            modelLabel: nextModel.label,
            permissionMode: nextPermission,
            planMode: nextPlanMode,
          );
          _selectionNotifier.value = ComposerSelectionSnapshot(
            instanceId: nextInstance.instanceId,
            agentId: nextInstance.agentId ?? nextInstance.instanceId,
            modelId: nextModel.id,
            permissionMode: nextPermission,
            planMode: nextPlanMode,
            supportsPlanMode: nextInstance.supportsPlanMode == true,
            locked: _latestSelection.locked,
            instanceLabel: nextInstance.label,
            modelLabel: nextModel.label,
          );
          return nextForm;
        });
      },
      onPermissionMode: (mode) async {
        await _applyDraftEdit((current) {
          final nextForm = current.copyWith(permissionMode: mode);
          final base = _selectionNotifier.value;
          _selectionNotifier.value = ComposerSelectionSnapshot(
            instanceId: base.instanceId,
            agentId: base.agentId,
            modelId: base.modelId,
            permissionMode: mode,
            planMode: base.planMode,
            supportsPlanMode: base.supportsPlanMode,
            locked: base.locked,
            instanceLabel: base.instanceLabel,
            modelLabel: base.modelLabel,
          );
          return nextForm;
        });
      },
      onPlanMode: (enabled) async {
        await _applyDraftEdit((current) {
          final nextForm = current.copyWith(planMode: enabled);
          final base = _selectionNotifier.value;
          _selectionNotifier.value = ComposerSelectionSnapshot(
            instanceId: base.instanceId,
            agentId: base.agentId,
            modelId: base.modelId,
            permissionMode: base.permissionMode,
            planMode: enabled,
            supportsPlanMode: base.supportsPlanMode,
            locked: base.locked,
            instanceLabel: base.instanceLabel,
            modelLabel: base.modelLabel,
          );
          return nextForm;
        });
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final target = _target;
    final link = widget.connection;
    final online = widget.online;
    final projects = widget.projects;
    final supportsControls =
        online && connectionSupportsComposerControls(link);
    final provider = newThreadDraftProvider(target);
    final draft = ref.watch(provider);
    ref.listen(provider, (previous, next) {
      final nextState = next.value;
      if (nextState != null) {
        _initialTextSynced = true;
        _syncTextFromForm(nextState.form.text);
      }
      final receipt = nextState?.receipt;
      if (receipt != null &&
          receipt.commandId != previous?.value?.receipt?.commandId) {
        _textController.clearThreadReferences();
        widget.onAccepted(receipt);
      }
    });
    final view = draft.value;
    if (view == null) {
      return Center(
        child: draft.hasError
            ? TextButton(
                onPressed: () => ref.invalidate(provider),
                child: const Text('重新读取草稿'),
              )
            : const CircularProgressIndicator.adaptive(),
      );
    }
    if (!_initialTextSynced) {
      _initialTextSynced = true;
      if (_textController.text != view.form.text) {
        final targetText = view.form.text;
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) _syncTextFromForm(targetText);
        });
      }
    }

    final actions = ref.read(provider.notifier);
    final optionsKey = link == null ? null : composerDraftOptionsProvider(link);
    final options = online && optionsKey != null ? ref.watch(optionsKey) : null;
    final form = view.form;
    final currentProject = projects
        .where((item) => item.id == widget.fallbackProjectId)
        .firstOrNull;
    final selectedProject =
        form.projectId ?? currentProject?.id ?? projects.firstOrNull?.id;
    final project = projects
        .where((item) => item.id == selectedProject)
        .firstOrNull;
    final projectName =
        project?.name ??
        (form.projectId == null
            ? null
            : online
            ? '所选项目不可用'
            : '已选项目');
    if (projectName != _reportedProjectName) {
      _reportedProjectName = projectName;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _reportedProjectName == projectName) {
          widget.onProjectNameChanged?.call(projectName);
        }
      });
    }
    final instances =
        options?.value?.instances ?? const <MobileDraftInstance>[];
    final selectedInstance =
        form.instanceId ?? options?.value?.defaultInstanceId;
    final instance = instances
        .where((item) => item.instanceId == selectedInstance)
        .firstOrNull;
    final modelsKey = instance == null || link == null
        ? null
        : composerDraftModelsProvider((link, instance.instanceId));
    final models = modelsKey == null ? null : ref.watch(modelsKey);
    final modelCatalog = models?.value;
    final selectedModel = form.modelId ?? modelCatalog?.defaultModelId;
    final model = modelCatalog?.models
        .where((item) => item.id == selectedModel)
        .firstOrNull;
    final resolvedModel = resolveDraftModel(modelCatalog, selectedModel);
    final permission = form.permissionMode ?? instance?.defaultPermissionMode;
    final planModeUnsupported =
        instance != null && instance.supportsPlanMode != true;
    final effectivePlanMode =
        supportsControls && !planModeUnsupported && form.planMode;
    final persistedPlanMode = planModeUnsupported ? false : form.planMode;
    final displayed = form.copyWith(
      projectId: selectedProject,
      instanceId: selectedInstance,
      modelId: selectedModel,
      permissionMode: permission,
      planMode: persistedPlanMode,
      instanceLabel: instance?.label,
      modelLabel: model?.label,
    );
    final defaultsLoaded =
        form.projectId != displayed.projectId ||
        form.instanceId != displayed.instanceId ||
        form.modelId != displayed.modelId ||
        form.permissionMode != displayed.permissionMode ||
        form.planMode != displayed.planMode ||
        form.instanceLabel != displayed.instanceLabel ||
        form.modelLabel != displayed.modelLabel;
    if (defaultsLoaded &&
        (form.text.isNotEmpty || (planModeUnsupported && form.planMode)) &&
        !view.working &&
        view.notice == null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted &&
            _target == target &&
            identical(ref.read(provider).value?.form, form)) {
          actions.edit(displayed);
        }
      });
    }
    final validPermission =
        permission != null &&
        instance?.permissionModes.contains(permission) == true;
    final validModel =
        modelCatalog != null && (selectedModel == null || model != null);
    final allowed =
        online &&
        !view.working &&
        view.pending == null &&
        project != null &&
        instance != null &&
        validModel &&
        validPermission &&
        form.text.trim().isNotEmpty &&
        form.text.length <= mobileCommandTextLimit;

    final preferences = supportsControls
        ? ref.watch(modelPreferencesProvider)
        : ModelPreferences.empty;
    final runOptions = resolveComposerRunOptions(
      supportsComposerControls: supportsControls,
      instanceId: instance?.instanceId,
      model: resolvedModel,
      preferences: preferences,
    );
    if (supportsControls) {
      _scheduleSelectionSync(
        ComposerSelectionSnapshot(
          instanceId: selectedInstance,
          agentId: instance?.agentId ?? selectedInstance,
          modelId: resolvedModel?.id ?? selectedModel,
          permissionMode: permission,
          planMode: effectivePlanMode,
          supportsPlanMode: instance?.supportsPlanMode == true,
          locked: view.working,
          instanceLabel: instance?.label ?? form.instanceLabel,
          modelLabel: resolvedModel?.label ?? form.modelLabel,
        ),
      );
    }

    Future<void> pick<T>(
      String title,
      List<(T, String)> choices,
      NewThreadForm Function(NewThreadForm form, T choice) select,
    ) async {
      final choice = await _choose(context, title, choices);
      if (choice == null) return;
      await _applyDraftEdit((current) => select(current, choice));
    }

    String instanceLabel(MobileDraftInstance item) =>
        item.label == item.agentName
        ? item.agentName
        : '${item.label} · ${item.agentName}';

    final projectPicker = MobileComposerChip(
      icon: WorkspaceGlyph.folder,
      variant: MobileComposerChipVariant.header,
      label: projectName ?? '选择项目',
      tooltip: '草稿项目',
      onTap: !view.working && projects.isNotEmpty
          ? () => pick('选择项目', [
              for (final item in projects) (item.id, item.name),
            ], (current, id) => current.copyWith(projectId: id))
          : null,
    );

    final isLoadingCatalog =
        online && (options?.isLoading == true || models?.isLoading == true);
    final Widget trailingControls;
    if (supportsControls && link != null) {
      final modelLabel =
          resolvedModel?.label ??
          form.modelLabel ??
          instance?.label ??
          form.instanceLabel ??
          (isLoadingCatalog
              ? '加载模型…'
              : validModel
              ? 'Agent 默认模型'
              : form.modelId ?? '选择模型');
      trailingControls = MobileModelPickerChip(
        agentId: instance?.agentId ?? selectedInstance,
        instanceId: selectedInstance,
        accentColor: instance?.accentColor,
        instanceLabel: instance?.label ?? form.instanceLabel,
        modelLabel: modelLabel,
        effort: runOptions.effort,
        fast: runOptions.fast == true,
        ultracode: runOptions.ultracode == true,
        planMode: effectivePlanMode,
        loading: isLoadingCatalog,
        permissionMode: permission,
        defaultPermissionMode: instance?.defaultPermissionMode,
        onTap: !view.working && instances.isNotEmpty
            ? () => unawaited(_openModelPicker(link))
            : null,
      );
    } else {
      final instancePicker = MobileComposerChip(
        label: instance == null
            ? form.instanceLabel ??
                  (form.instanceId == null ? '选择 Agent 实例' : '已选 Agent 实例')
            : instanceLabel(instance),
        tooltip: '草稿 Agent 实例',
        onTap: !view.working && instances.isNotEmpty
            ? () => pick(
                '选择 Agent 实例',
                [for (final item in instances) (item, instanceLabel(item))],
                (current, item) => current.copyWith(
                  instanceId: item.instanceId,
                  instanceLabel: item.label,
                  planMode: false,
                  resetModel: true,
                ),
              )
            : null,
      );

      final modelPicker = MobileComposerChip(
        label:
            model?.label ??
            form.modelLabel ??
            (validModel ? 'Agent 默认模型' : form.modelId ?? '选择模型'),
        tooltip: '草稿模型',
        onTap: !view.working && (modelCatalog?.models.isNotEmpty ?? false)
            ? () => pick(
                '选择模型',
                [
                  for (final item in modelCatalog!.models)
                    (item.id, item.label),
                ],
                (current, id) => current.copyWith(
                  modelId: id,
                  modelLabel: modelCatalog.models
                      .firstWhere((item) => item.id == id)
                      .label,
                ),
              )
            : null,
      );

      final permissionPicker = MobileComposerChip(
        label: permission == null
            ? '选择权限'
            : composerPermissionLabel(permission),
        tooltip: '草稿权限',
        warning: permission == MobileDraftPermission.fullAccess,
        onTap: !view.working && instance != null
            ? () => pick(
                '选择权限模式',
                [
                  for (final item in instance.permissionModes)
                    (item, composerPermissionLabel(item)),
                ],
                (current, mode) => current.copyWith(permissionMode: mode),
              )
            : null,
      );

      trailingControls = Row(
        mainAxisSize: MainAxisSize.min,
        spacing: ComposerSpace.toolbarGap,
        children: [instancePicker, modelPicker, permissionPicker],
      );
    }

    final banners = <Widget>[
      if (online &&
          (view.selectionUnavailable ||
              options?.hasError == true ||
              models?.hasError == true))
        Align(
          alignment: AlignmentDirectional.centerStart,
          child: TextButton(
            onPressed: () {
              if (optionsKey != null) ref.invalidate(optionsKey);
              if (modelsKey != null) ref.invalidate(modelsKey);
            },
            child: const Text('重新读取可用选项'),
          ),
        ),
      if (online && options?.value?.instances.isEmpty == true)
        const Text('电脑上暂无可用的 Agent 实例。'),
      if (view.notice case final notice?) _DraftNotice(notice),
      if (view.pending != null)
        Wrap(
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            const Text('首发结果待确认'),
            TextButton(
              onPressed: online && !view.working ? () => actions.check() : null,
              child: const Text('查回执'),
            ),
            TextButton(
              onPressed: online && !view.working
                  ? () => actions.check(retry: true)
                  : null,
              child: const Text('用原编号重试'),
            ),
          ],
        ),
      if (form.text.length > mobileCommandTextLimit)
        const _DraftNotice('首条消息超过长度上限，请缩短后发送。'),
    ];

    final dock = SingleChildScrollView(
      child: MobileComposerMentionHost(
        connection: link,
        online: online,
        controller: _textController,
        focusNode: _focusNode,
        enabled: !view.working,
        projectId: selectedProject,
        threadId: null,
        instanceId: selectedInstance,
        projects: projects,
        threads: widget.threads,
        supportsPlanMode:
            supportsControls &&
            (instance?.supportsPlanMode == true || effectivePlanMode),
        permissionModes: supportsControls
            ? (instance?.permissionModes ?? const [])
            : const [],
        canOpenModelPicker:
            supportsControls && link != null && !view.working && instances.isNotEmpty,
        onOpenModelPicker:
            supportsControls && link != null && !view.working && instances.isNotEmpty
            ? () => unawaited(_openModelPicker(link))
            : null,
        onTogglePlanMode: supportsControls && !view.working
            ? () => unawaited(
                _applyDraftEdit(
                  (current) => current.copyWith(planMode: !effectivePlanMode),
                ),
              )
            : null,
        onSelectPermissionMode: supportsControls && !view.working
            ? (mode) => unawaited(
                _applyDraftEdit(
                  (current) => current.copyWith(permissionMode: mode),
                ),
              )
            : null,
        onTextChanged: (text) => actions.edit(displayed.copyWith(text: text)),
        externalLeading: widget.leading,
        builder: (context, leading) => _DraftComposer(
          controller: _textController,
          focusNode: _focusNode,
          header: projectPicker,
          banners: banners,
          leading: leading,
          trailing: trailingControls,
          offline: !online,
          working: view.working,
          onChanged: (text) => actions.edit(displayed.copyWith(text: text)),
          onSend: allowed
              ? () {
                  final references = _textController.resolveReferences(
                    form.text,
                  );
                  actions.submit(
                    NewThreadForm(
                      text: form.text,
                      projectId: project.id,
                      instanceId: instance.instanceId,
                      modelId: selectedModel,
                      instanceLabel: displayed.instanceLabel,
                      modelLabel: displayed.modelLabel,
                      permissionMode: permission,
                      planMode: effectivePlanMode,
                    ),
                    effort: runOptions.effort,
                    fast: runOptions.fast,
                    ultracode: runOptions.ultracode,
                    planMode: effectivePlanMode ? true : null,
                    references: supportsControls && references.isNotEmpty
                        ? references
                        : null,
                  );
                }
              : null,
        ),
      ),
    );
    return LayoutBuilder(
      builder: (context, constraints) {
        final showPrompt =
            form.text.trim().isEmpty &&
            MediaQuery.viewInsetsOf(context).bottom == 0 &&
            constraints.maxHeight >= ComposerType.heroMinViewportHeight;
        return Column(
          children: [
            Expanded(
              child: Center(
                child: showPrompt
                    ? Text(
                        '做点什么？',
                        style: Theme.of(context).textTheme.headlineSmall
                            ?.copyWith(
                              fontSize: ComposerType.heroFontSize,
                              fontWeight: FontWeight.w500,
                              letterSpacing: 0,
                              height: ComposerType.heroHeight,
                              leadingDistribution: TextLeadingDistribution.even,
                            ),
                      )
                    : null,
              ),
            ),
            ConstrainedBox(
              constraints: BoxConstraints(maxHeight: constraints.maxHeight),
              child: dock,
            ),
          ],
        );
      },
    );
  }
}

Future<T?> _choose<T>(
  BuildContext context,
  String title,
  List<(T, String)> choices,
) => showMobileSheet<T>(
  context,
  title: title,
  content: (context) => SliverList.builder(
    itemCount: choices.length,
    itemBuilder: (_, index) {
      final (value, label) = choices[index];
      return MobileSheetAction(
        label: label,
        dividerAbove: index > 0,
        onTap: () => Navigator.pop(context, value),
      );
    },
  ),
);

class _DraftNotice extends StatelessWidget {
  const _DraftNotice(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Semantics(
    liveRegion: true,
    child: Text(text, style: Theme.of(context).textTheme.bodySmall),
  );
}

class _DraftComposer extends StatelessWidget {
  const _DraftComposer({
    required this.controller,
    required this.focusNode,
    required this.header,
    required this.banners,
    required this.trailing,
    required this.offline,
    required this.working,
    required this.onChanged,
    this.leading,
    this.onSend,
  });

  final ComposerTextEditingController controller;
  final FocusNode focusNode;
  final Widget header;
  final List<Widget> banners;
  final Widget? leading;
  final Widget trailing;
  final bool offline;
  final bool working;
  final ValueChanged<String> onChanged;
  final VoidCallback? onSend;

  @override
  Widget build(BuildContext context) => MobileComposerCard(
    controller: controller,
    focusNode: focusNode,
    inputKey: const ValueKey('first-message-input'),
    hintText: '描述要做的事',
    header: header,
    banners: banners,
    leading: leading,
    trailing: trailing,
    offline: offline,
    readOnly: working,
    onChanged: onChanged,
    actions: [
      MobileComposerActionButton(
        tooltip: '发送首条消息',
        glyph: WorkspaceGlyph.arrowUp,
        offline: offline,
        onPressed: onSend,
      ),
    ],
  );
}
