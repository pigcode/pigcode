import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pigcode_client/pigcode_client.dart';

import 'new_thread_draft_state.dart';
import 'theme_colors.dart';

final _draftOptionsProvider = FutureProvider.autoDispose
    .family<MobileDraftOptions, MobileConnection>(
      (ref, connection) => connection.drafts.options(),
    );
final _draftModelsProvider = FutureProvider.autoDispose
    .family<MobileDraftModels, (MobileConnection, String)>(
      (ref, target) => target.$1.drafts.models(target.$2),
    );

class NewThreadDraft extends ConsumerStatefulWidget {
  const NewThreadDraft({
    super.key,
    required this.connection,
    required this.projects,
    required this.online,
    required this.onAccepted,
    this.projectId,
    this.fallbackProjectId,
    this.computerKey,
    this.deviceId,
  });

  final MobileConnection? connection;
  final String? computerKey;
  final String? deviceId;
  final String? projectId;
  final String? fallbackProjectId;
  final List<MobileProjectSummary> projects;
  final bool online;
  final ValueChanged<MobileDraftReceipt> onAccepted;

  @override
  ConsumerState<NewThreadDraft> createState() => _NewThreadDraftState();
}

class _NewThreadDraftState extends ConsumerState<NewThreadDraft> {
  late final _entry = DraftEntry(widget.projectId);

  DraftTarget get _target => (
    connection: widget.connection,
    computerKey: widget.computerKey ?? widget.connection!.computer.computerKey,
    deviceId: widget.deviceId ?? widget.connection!.deviceId,
    entry: _entry,
  );

  @override
  Widget build(BuildContext context) {
    final target = _target;
    final link = widget.connection;
    final online = widget.online;
    final projects = widget.projects;
    final provider = newThreadDraftProvider(target);
    final draft = ref.watch(provider);
    ref.listen(provider, (previous, next) {
      final receipt = next.value?.receipt;
      if (receipt != null &&
          receipt.commandId != previous?.value?.receipt?.commandId) {
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

    final actions = ref.read(provider.notifier);
    final optionsKey = link == null ? null : _draftOptionsProvider(link);
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
    final instances =
        options?.value?.instances ?? const <MobileDraftInstance>[];
    final selectedInstance =
        form.instanceId ?? options?.value?.defaultInstanceId;
    final instance = instances
        .where((item) => item.instanceId == selectedInstance)
        .firstOrNull;
    final modelsKey = instance == null || link == null
        ? null
        : _draftModelsProvider((link, instance.instanceId));
    final models = modelsKey == null ? null : ref.watch(modelsKey);
    final modelCatalog = models?.value;
    final selectedModel = form.modelId ?? modelCatalog?.defaultModelId;
    final model = modelCatalog?.models
        .where((item) => item.id == selectedModel)
        .firstOrNull;
    final permission = form.permissionMode ?? instance?.defaultPermissionMode;
    final displayed = form.copyWith(
      projectId: selectedProject,
      instanceId: selectedInstance,
      modelId: selectedModel,
      permissionMode: permission,
      instanceLabel: instance?.label,
      modelLabel: model?.label,
    );
    final defaultsLoaded =
        form.projectId != displayed.projectId ||
        form.instanceId != displayed.instanceId ||
        form.modelId != displayed.modelId ||
        form.permissionMode != displayed.permissionMode ||
        form.instanceLabel != displayed.instanceLabel ||
        form.modelLabel != displayed.modelLabel;
    if (defaultsLoaded &&
        form.text.isNotEmpty &&
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

    Future<void> pick<T>(
      String title,
      List<(T, String)> choices,
      NewThreadForm Function(NewThreadForm form, T choice) select,
    ) async {
      final choice = await _choose(context, title, choices);
      if (choice == null) return;
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
        ref
            .read(provider.notifier)
            .edit(select(ref.read(provider).value?.form ?? view.form, choice));
        return;
      }
    }

    String instanceLabel(MobileDraftInstance item) =>
        item.label == item.agentName
        ? item.agentName
        : '${item.label} · ${item.agentName}';

    return Align(
      alignment: Alignment.bottomCenter,
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Wrap(
              spacing: 8,
              runSpacing: 4,
              children: [
                _DraftChip(
                  icon: Icons.folder_outlined,
                  label:
                      project?.name ??
                      (form.projectId == null ? '选择项目' : '已选项目'),
                  tooltip: '草稿项目',
                  onTap: !view.working && projects.isNotEmpty
                      ? () => pick('选择项目', [
                          for (final item in projects) (item.id, item.name),
                        ], (current, id) => current.copyWith(projectId: id))
                      : null,
                ),
                _DraftChip(
                  icon: Icons.smart_toy_outlined,
                  label: instance == null
                      ? form.instanceLabel ??
                            (form.instanceId == null
                                ? '选择 Agent 实例'
                                : '已选 Agent 实例')
                      : instanceLabel(instance),
                  tooltip: '草稿 Agent 实例',
                  onTap: !view.working && instances.isNotEmpty
                      ? () => pick(
                          '选择 Agent 实例',
                          [
                            for (final item in instances)
                              (item, instanceLabel(item)),
                          ],
                          (current, item) => current.copyWith(
                            instanceId: item.instanceId,
                            instanceLabel: item.label,
                            resetModel: true,
                          ),
                        )
                      : null,
                ),
                _DraftChip(
                  icon: Icons.layers_outlined,
                  label:
                      model?.label ??
                      form.modelLabel ??
                      (validModel ? 'Agent 默认模型' : form.modelId ?? '选择模型'),
                  tooltip: '草稿模型',
                  onTap:
                      !view.working &&
                          (modelCatalog?.models.isNotEmpty ?? false)
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
                ),
                _DraftChip(
                  icon: Icons.shield_outlined,
                  label: permission == null
                      ? '选择权限'
                      : _permissionName(permission),
                  tooltip: '草稿权限',
                  onTap: !view.working && instance != null
                      ? () => pick(
                          '选择权限模式',
                          [
                            for (final item in instance.permissionModes)
                              (item, _permissionName(item)),
                          ],
                          (current, mode) =>
                              current.copyWith(permissionMode: mode),
                        )
                      : null,
                ),
              ],
            ),
            if (online &&
                (options?.isLoading == true || models?.isLoading == true))
              const LinearProgressIndicator(),
            if (online &&
                (view.selectionUnavailable ||
                    options?.hasError == true ||
                    models?.hasError == true))
              TextButton(
                onPressed: () {
                  if (optionsKey != null) ref.invalidate(optionsKey);
                  if (modelsKey != null) ref.invalidate(modelsKey);
                },
                child: const Text('重新读取可用选项'),
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
                    onPressed: online && !view.working
                        ? () => actions.check()
                        : null,
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
            const SizedBox(height: 4),
            _DraftText(
              text: form.text,
              working: view.working,
              onChanged: (text) => actions.edit(displayed.copyWith(text: text)),
              onSend: allowed
                  ? () => actions.submit(
                      NewThreadForm(
                        text: form.text,
                        projectId: project.id,
                        instanceId: instance.instanceId,
                        modelId: selectedModel,
                        instanceLabel: displayed.instanceLabel,
                        modelLabel: displayed.modelLabel,
                        permissionMode: permission,
                      ),
                    )
                  : null,
            ),
          ],
        ),
      ),
    );
  }
}

String _permissionName(MobileDraftPermission permission) =>
    switch (permission) {
      MobileDraftPermission.approvalRequired => '监督审批',
      MobileDraftPermission.autoAcceptEdits => '接受编辑',
      MobileDraftPermission.auto => '自动审批',
      MobileDraftPermission.fullAccess => '完全访问',
    };

Future<T?> _choose<T>(
  BuildContext context,
  String title,
  List<(T, String)> choices,
) => showModalBottomSheet<T>(
  context: context,
  showDragHandle: true,
  useSafeArea: true,
  shape: const RoundedRectangleBorder(
    borderRadius: BorderRadius.vertical(top: Radius.circular(22)),
  ),
  builder: (context) => ListView(
    shrinkWrap: true,
    children: [
      ListTile(
        title: Text(title, style: Theme.of(context).textTheme.titleMedium),
      ),
      for (final (value, label) in choices)
        ListTile(
          title: Text(label),
          onTap: () => Navigator.pop(context, value),
        ),
    ],
  ),
);

class _DraftChip extends StatelessWidget {
  const _DraftChip({
    required this.icon,
    required this.label,
    required this.tooltip,
    this.onTap,
  });

  final IconData icon;
  final String label;
  final String tooltip;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => Tooltip(
    message: tooltip,
    child: ActionChip(
      materialTapTargetSize: MaterialTapTargetSize.padded,
      avatar: Icon(icon, size: 16),
      label: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis),
      onPressed: onTap,
    ),
  );
}

class _DraftNotice extends StatelessWidget {
  const _DraftNotice(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(4, 2, 4, 6),
    child: Semantics(liveRegion: true, child: Text(text)),
  );
}

class _DraftText extends StatefulWidget {
  const _DraftText({
    required this.text,
    required this.working,
    required this.onChanged,
    this.onSend,
  });

  final String text;
  final bool working;
  final ValueChanged<String> onChanged;
  final VoidCallback? onSend;

  @override
  State<_DraftText> createState() => _DraftTextState();
}

class _DraftTextState extends State<_DraftText> {
  late final TextEditingController _controller;

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController(text: widget.text);
  }

  @override
  void didUpdateWidget(covariant _DraftText oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (_controller.text != widget.text) {
      _controller.value = TextEditingValue(
        text: widget.text,
        selection: TextSelection.collapsed(offset: widget.text.length),
      );
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final hitSize = theme.platform == TargetPlatform.android ? 48.0 : 44.0;
    return Material(
      color: colors.surface,
      elevation: 1,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(22),
        side: BorderSide(color: colors.divider),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 3),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.end,
          children: [
            Expanded(
              child: TextField(
                key: const ValueKey('first-message-input'),
                controller: _controller,
                onChanged: widget.onChanged,
                readOnly: widget.working,
                minLines: 1,
                maxLines: 5,
                keyboardType: TextInputType.multiline,
                style: const TextStyle(fontSize: 16, height: 1.375),
                decoration: const InputDecoration(
                  hintText: '发出第一条消息',
                  contentPadding: EdgeInsets.symmetric(
                    horizontal: 4,
                    vertical: 12,
                  ),
                  border: InputBorder.none,
                ),
              ),
            ),
            SizedBox.square(
              dimension: hitSize,
              child: IconButton(
                onPressed: widget.onSend,
                tooltip: '发送首条消息',
                padding: EdgeInsets.zero,
                icon: DecoratedBox(
                  decoration: BoxDecoration(
                    color: widget.onSend == null
                        ? colors.selected
                        : colors.primary,
                    shape: BoxShape.circle,
                  ),
                  child: SizedBox.square(
                    dimension: 36,
                    child: Icon(
                      Icons.arrow_upward,
                      size: 20,
                      color: widget.onSend == null
                          ? colors.muted
                          : colors.onPrimary,
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
