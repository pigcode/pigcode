import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pigcode_client/pigcode_client.dart';

import '../mobile_glass.dart';
import '../mobile_sheet.dart';
import '../timeline/timeline_tokens.dart';
import '../workspace_icon.dart';
import 'agent_badge_icon.dart';
import 'composer_catalog.dart';
import 'composer_tokens.dart';
import 'model_preferences.dart';

const _favoritesTab = '__favorites__';

/// 供底部弹层实时订阅的当前会话/草稿选择状态快照。
class ComposerSelectionSnapshot {
  const ComposerSelectionSnapshot({
    this.instanceId,
    this.agentId,
    this.modelId,
    this.permissionMode,
    this.planMode = false,
    this.supportsPlanMode = false,
    this.locked = false,
    this.instanceLabel,
    this.modelLabel,
    this.notice,
    this.busy = false,
  });

  final String? instanceId;
  final String? agentId;
  final String? modelId;
  final MobileDraftPermission? permissionMode;
  final bool planMode;
  final bool supportsPlanMode;
  final bool locked;
  final String? instanceLabel;
  final String? modelLabel;
  final String? notice;
  final bool busy;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ComposerSelectionSnapshot &&
          other.instanceId == instanceId &&
          other.agentId == agentId &&
          other.modelId == modelId &&
          other.permissionMode == permissionMode &&
          other.planMode == planMode &&
          other.supportsPlanMode == supportsPlanMode &&
          other.locked == locked &&
          other.instanceLabel == instanceLabel &&
          other.modelLabel == modelLabel &&
          other.notice == notice &&
          other.busy == busy;

  @override
  int get hashCode => Object.hash(
    instanceId,
    agentId,
    modelId,
    permissionMode,
    planMode,
    supportsPlanMode,
    locked,
    instanceLabel,
    modelLabel,
    notice,
    busy,
  );
}

/// 输入框底栏右侧的综合模型/运行参数胶囊：
/// 展示 Agent 图标、当前模型名（省略截断）、非默认思考深度短标签、开启中的快速模式/Ultracode 小图标、
/// 开启中的计划模式短标记（`计划`）、非默认权限模式图标徽标（`完全访问` 使用警示底色/文字）与下箭头。
class MobileModelPickerChip extends StatelessWidget {
  const MobileModelPickerChip({
    super.key,
    required this.modelLabel,
    this.agentId,
    this.instanceId,
    this.accentColor,
    this.instanceLabel,
    this.effort,
    this.fast = false,
    this.ultracode = false,
    this.planMode = false,
    this.loading = false,
    this.permissionMode,
    this.defaultPermissionMode,
    this.onTap,
  });

  static const chipKey = ValueKey('composer-model-chip');
  static const permissionBadgeKey = ValueKey('composer-model-chip-permission');

  final String? agentId;
  final String? instanceId;
  final String? accentColor;
  final String? instanceLabel;
  final String modelLabel;
  final String? effort;
  final bool fast;
  final bool ultracode;
  final bool planMode;
  final bool loading;
  final MobileDraftPermission? permissionMode;
  final MobileDraftPermission? defaultPermissionMode;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final colors = ComposerSurface.palette(brightness);
    final visualHeight = ComposerControl.chipHeight(context);
    final touchHeight = math.max(visualHeight, timelineTouchHeight(context));
    final enabled = onTap != null;
    final mode = permissionMode;
    final isElevated =
        mode != null && composerPermissionNeedsConfirmation(mode);
    final showPermissionBadge =
        mode != null &&
        (isElevated ||
            mode !=
                (defaultPermissionMode ?? MobileDraftPermission.fullAccess));

    final effortText = effort == null ? null : composerEffortLabel(effort!);
    final semanticsParts = <String>[
      if (instanceLabel != null && instanceLabel!.isNotEmpty) instanceLabel!,
      modelLabel,
      ?effortText,
      if (fast) '快速模式',
      if (ultracode) 'Ultracode',
      if (planMode) '计划模式',
      if (showPermissionBadge) composerPermissionLabel(mode),
    ];
    final radius = BorderRadius.circular(ComposerRadius.chip);
    final primaryTextColor = enabled ? colors.foreground : colors.faint;
    final metaTextColor = enabled ? colors.muted : colors.faint;

    return Tooltip(
      message: 'Agent 和模型',
      child: Semantics(
        button: true,
        enabled: enabled,
        label: 'Agent 和模型：${semanticsParts.join(' · ')}',
        child: InkWell(
          key: chipKey,
          onTap: onTap,
          borderRadius: radius,
          child: ConstrainedBox(
            constraints: BoxConstraints(
              minWidth: touchHeight,
              minHeight: touchHeight,
            ),
            child: Align(
              widthFactor: 1,
              child: Container(
                height: visualHeight,
                constraints: const BoxConstraints(
                  maxWidth: ComposerSpace.modelChipMaxWidth,
                ),
                padding: const EdgeInsets.symmetric(
                  horizontal: ComposerSpace.chipToolbarHorizontal,
                ),
                decoration: BoxDecoration(
                  color: Colors.transparent,
                  borderRadius: radius,
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  spacing: ComposerSpace.modelChipGap,
                  children: [
                    if (loading && (agentId == null || agentId!.isEmpty))
                      SizedBox.square(
                        dimension: ComposerControl.suggestionSpinnerSize,
                        child: CircularProgressIndicator(
                          strokeWidth: ComposerControl.suggestionSpinnerStroke,
                          color: colors.faint,
                        ),
                      )
                    else if (agentId case final id? when id.isNotEmpty)
                      AgentBadgeIcon(
                        agentId: id,
                        instanceId: instanceId,
                        accentColor: accentColor,
                        name: instanceLabel ?? modelLabel,
                        size: ComposerControl.agentIconMd,
                        ringColor: colors.surfaceRaised,
                      ),
                    Flexible(
                      child: Text(
                        modelLabel,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: ComposerType.modelChipName(primaryTextColor),
                      ),
                    ),
                    if (loading && agentId != null && agentId!.isNotEmpty)
                      SizedBox.square(
                        dimension: ComposerControl.suggestionSpinnerSize,
                        child: CircularProgressIndicator(
                          strokeWidth: ComposerControl.suggestionSpinnerStroke,
                          color: colors.faint,
                        ),
                      ),
                    if (effortText != null)
                      Text(
                        effortText,
                        maxLines: 1,
                        style: ComposerType.modelChipMeta(metaTextColor),
                      ),
                    if (fast)
                      IconTheme(
                        data: IconThemeData(
                          color: enabled
                              ? ComposerSurface.favorite
                              : colors.faint,
                        ),
                        child: const WorkspaceIcon(
                          WorkspaceGlyph.zapFilled,
                          size: ComposerControl.modelChipSwitchIcon,
                        ),
                      ),
                    if (ultracode)
                      IconTheme(
                        data: IconThemeData(
                          color: enabled
                              ? ComposerSurface.accentText(brightness)
                              : colors.faint,
                        ),
                        child: const WorkspaceIcon(
                          WorkspaceGlyph.workflow,
                          size: ComposerControl.modelChipSwitchIcon,
                        ),
                      ),
                    if (planMode)
                      Text(
                        '计划',
                        maxLines: 1,
                        style: ComposerType.modelChipMeta(metaTextColor),
                      ),
                    if (showPermissionBadge)
                      Container(
                        key: permissionBadgeKey,
                        padding: const EdgeInsets.all(
                          ComposerSpace.modelChipBadgePadding,
                        ),
                        decoration: BoxDecoration(
                          color: isElevated
                              ? colors.attentionTint
                              : ComposerSurface.accentSoft(brightness),
                          borderRadius: BorderRadius.circular(
                            ComposerRadius.chipBadge,
                          ),
                        ),
                        child: IconTheme(
                          data: IconThemeData(
                            color: isElevated
                                ? colors.attention
                                : ComposerSurface.accentText(brightness),
                          ),
                          child: WorkspaceIcon(
                            composerPermissionGlyph(mode),
                            size: ComposerControl.modelChipModeIcon,
                          ),
                        ),
                      ),
                    IconTheme(
                      data: IconThemeData(color: colors.faint),
                      child: const WorkspaceIcon(
                        WorkspaceGlyph.chevronDown,
                        size: ComposerControl.chipCaret,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// 切换到「完全访问」前的二次确认弹窗；取消返回 `false`，确认返回 `true`。
Future<bool> showFullAccessConfirmDialog(BuildContext context) async {
  final theme = Theme.of(context);
  final colors = ComposerSurface.palette(theme.brightness);
  final touch = timelineTouchHeight(context);
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (dialogContext) => MobileGlassDialog(
      title: Text(
        '打开完全访问？',
        style: ComposerType.sheetTitle(colors.foreground, theme.platform),
      ),
      content: Text(
        'Agent 会不问你就改文件、跑任何命令。只在你信任这个任务和项目时打开。从下一条消息开始生效。',
        style: ComposerType.contextDetail(colors.secondaryText),
      ),
      actions: [
        TextButton(
          style: TextButton.styleFrom(minimumSize: Size(touch, touch)),
          onPressed: () => Navigator.pop(dialogContext, false),
          child: const Text('取消'),
        ),
        FilledButton(
          style: FilledButton.styleFrom(
            minimumSize: Size(touch, touch),
            backgroundColor: colors.error,
            foregroundColor: colors.onError,
          ),
          onPressed: () => Navigator.pop(dialogContext, true),
          child: const Text('打开完全访问'),
        ),
      ],
    ),
  );
  return confirmed == true;
}

/// 打开综合模型/运行参数底部弹层（新会话草稿与已有会话共用）。
Future<void> showMobileModelPickerSheet({
  required BuildContext context,
  required MobileConnection connection,
  required ValueListenable<ComposerSelectionSnapshot> selection,
  required FutureOr<void> Function(
    MobileDraftInstance instance,
    MobileDraftModel model,
  )
  onSelectModel,
  FutureOr<void> Function(MobileDraftPermission mode)? onPermissionMode,
  FutureOr<void> Function(bool enabled)? onPlanMode,
}) {
  final brightness = Theme.of(context).brightness;
  final colors = ComposerSurface.palette(brightness);
  final radius = const BorderRadius.vertical(
    top: Radius.circular(ComposerRadius.sheet),
  );
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: false,
    useSafeArea: true,
    backgroundColor: Colors.transparent,
    barrierColor: colors.scrim,
    barrierLabel: '关闭',
    elevation: 0,
    clipBehavior: Clip.none,
    sheetAnimationStyle: MediaQuery.disableAnimationsOf(context)
        ? AnimationStyle.noAnimation
        : const AnimationStyle(
            duration: TimelineMotion.slow,
            reverseDuration: TimelineMotion.med,
          ),
    builder: (sheetContext) {
      final viewInsets = MediaQuery.viewInsetsOf(sheetContext);
      final screenHeight = MediaQuery.sizeOf(sheetContext).height;
      final availableHeight = math.max(
        ComposerControl.pickerMinListHeight,
        (screenHeight - viewInsets.bottom) *
            ComposerControl.pickerMaxHeightFactor,
      );
      return Padding(
        padding: EdgeInsets.only(bottom: viewInsets.bottom),
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: availableHeight),
          child: MobileGlassSheetSurface(
            borderRadius: radius,
            child: SafeArea(
              top: false,
              child: _ModelPickerSheetBody(
                connection: connection,
                selection: selection,
                onSelectModel: onSelectModel,
                onPermissionMode: onPermissionMode,
                onPlanMode: onPlanMode,
                onClose: () => Navigator.pop(sheetContext),
              ),
            ),
          ),
        ),
      );
    },
  );
}

class _ModelRowEntry {
  const _ModelRowEntry({
    required this.instance,
    required this.model,
    required this.isDefault,
  });

  final MobileDraftInstance instance;
  final MobileDraftModel model;
  final bool isDefault;
}

class _ModelPickerSheetBody extends ConsumerStatefulWidget {
  const _ModelPickerSheetBody({
    required this.connection,
    required this.selection,
    required this.onSelectModel,
    required this.onPermissionMode,
    required this.onPlanMode,
    required this.onClose,
  });

  final MobileConnection connection;
  final ValueListenable<ComposerSelectionSnapshot> selection;
  final FutureOr<void> Function(
    MobileDraftInstance instance,
    MobileDraftModel model,
  )
  onSelectModel;
  final FutureOr<void> Function(MobileDraftPermission mode)? onPermissionMode;
  final FutureOr<void> Function(bool enabled)? onPlanMode;
  final VoidCallback onClose;

  @override
  ConsumerState<_ModelPickerSheetBody> createState() =>
      _ModelPickerSheetBodyState();
}

class _ModelPickerSheetBodyState extends ConsumerState<_ModelPickerSheetBody> {
  late String _tab;
  final _searchController = TextEditingController();
  String _query = '';

  @override
  void initState() {
    super.initState();
    _tab = widget.selection.value.instanceId ?? _favoritesTab;
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  static (String instanceId, String modelId)? _parseFavoriteKey(String key) {
    final slash = key.indexOf('/');
    if (slash <= 0 || slash >= key.length - 1) return null;
    return (key.substring(0, slash), key.substring(slash + 1));
  }

  Future<void> _pickPermission({
    required MobileDraftPermission? current,
    required List<MobileDraftPermission> modes,
  }) async {
    final onChange = widget.onPermissionMode;
    if (onChange == null || modes.isEmpty) return;
    final chosen = await showMobileSheet<MobileDraftPermission>(
      context,
      title: '权限模式',
      content: (sheetContext) => SliverList.builder(
        itemCount: modes.length,
        itemBuilder: (_, index) {
          final mode = modes[index];
          return _PermissionOptionRow(
            mode: mode,
            selected: mode == current,
            dividerAbove: index > 0,
            onTap: () => Navigator.pop(sheetContext, mode),
          );
        },
      ),
    );
    if (!mounted || chosen == null || chosen == current) return;
    if (composerPermissionNeedsConfirmation(chosen)) {
      final confirmed = await showFullAccessConfirmDialog(context);
      if (!mounted || !confirmed) return;
    }
    await onChange(chosen);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final brightness = theme.brightness;
    final colors = ComposerSurface.palette(brightness);
    final touch = timelineTouchHeight(context);
    final preferences = ref.watch(modelPreferencesProvider);
    final preferencesNotifier = ref.read(modelPreferencesProvider.notifier);
    final optionsAsync = ref.watch(
      composerDraftOptionsProvider(widget.connection),
    );
    final instances =
        optionsAsync.value?.instances ?? const <MobileDraftInstance>[];

    return ValueListenableBuilder<ComposerSelectionSnapshot>(
      valueListenable: widget.selection,
      builder: (context, current, _) {
        final currentInstanceId =
            current.instanceId ?? optionsAsync.value?.defaultInstanceId;
        final currentInstance = instances
            .where((item) => item.instanceId == currentInstanceId)
            .firstOrNull;
        final activeTab =
            _tab == _favoritesTab ||
                instances.any((item) => item.instanceId == _tab)
            ? _tab
            : currentInstanceId ??
                  instances.firstOrNull?.instanceId ??
                  _favoritesTab;

        final currentModelsAsync = currentInstanceId == null
            ? null
            : ref.watch(
                composerDraftModelsProvider((
                  widget.connection,
                  currentInstanceId,
                )),
              );
        final currentModel = resolveDraftModel(
          currentModelsAsync?.value,
          current.modelId,
        );
        final currentKey = currentInstanceId != null && currentModel != null
            ? modelPreferenceKey(currentInstanceId, currentModel.id)
            : null;
        final currentEffort = resolveModelEffort(
          currentModel,
          currentKey == null ? null : preferences.effortFor(currentKey),
        );
        final currentFast = resolveModelFast(
          currentModel,
          currentKey != null && preferences.isFast(currentKey),
        );
        final currentUltracode = resolveModelUltracode(
          currentModel,
          currentKey != null && preferences.isUltracode(currentKey),
        );

        // 按需懒加载当前页签或收藏页涉及到的 Agent 实例目录。
        final tabCatalogs = <String, AsyncValue<MobileDraftModels>>{};
        if (activeTab == _favoritesTab) {
          final favoriteInstanceIds = <String>{};
          for (final key in preferences.favorites) {
            final parsed = _parseFavoriteKey(key);
            if (parsed != null &&
                instances.any((item) => item.instanceId == parsed.$1)) {
              favoriteInstanceIds.add(parsed.$1);
            }
          }
          for (final id in favoriteInstanceIds) {
            tabCatalogs[id] = ref.watch(
              composerDraftModelsProvider((widget.connection, id)),
            );
          }
        } else {
          tabCatalogs[activeTab] = ref.watch(
            composerDraftModelsProvider((widget.connection, activeTab)),
          );
        }

        final isLoading =
            optionsAsync.isLoading ||
            (activeTab == _favoritesTab
                ? tabCatalogs.values.any(
                    (entry) => entry.isLoading && !entry.hasValue,
                  )
                : (tabCatalogs[activeTab]?.isLoading == true &&
                      tabCatalogs[activeTab]?.hasValue != true));
        final hasError =
            optionsAsync.hasError ||
            (activeTab != _favoritesTab &&
                tabCatalogs[activeTab]?.hasError == true);

        final allRows = <_ModelRowEntry>[];
        if (activeTab == _favoritesTab) {
          for (final key in preferences.favorites) {
            final parsed = _parseFavoriteKey(key);
            if (parsed == null) continue;
            final (favInstanceId, favModelId) = parsed;
            final inst = instances
                .where((item) => item.instanceId == favInstanceId)
                .firstOrNull;
            final catalog = tabCatalogs[favInstanceId]?.value;
            final model = catalog?.models
                .where((item) => item.id == favModelId)
                .firstOrNull;
            if (inst != null && model != null) {
              allRows.add(
                _ModelRowEntry(
                  instance: inst,
                  model: model,
                  isDefault: catalog?.defaultModelId == model.id,
                ),
              );
            }
          }
        } else {
          final inst = instances
              .where((item) => item.instanceId == activeTab)
              .firstOrNull;
          final catalog = tabCatalogs[activeTab]?.value;
          if (inst != null && catalog != null) {
            for (final model in catalog.models) {
              allRows.add(
                _ModelRowEntry(
                  instance: inst,
                  model: model,
                  isDefault: catalog.defaultModelId == model.id,
                ),
              );
            }
          }
        }

        final trimmedQuery = _query.trim();
        final visibleRows = trimmedQuery.isEmpty
            ? allRows
            : (() {
                final scored = <({_ModelRowEntry row, double score})>[];
                for (final row in allRows) {
                  final score = math.max(
                    composerFuzzyScore(row.model.label, trimmedQuery),
                    composerFuzzyScore(row.model.id, trimmedQuery),
                  );
                  if (score >= 0) scored.add((row: row, score: score));
                }
                scored.sort((a, b) => b.score.compareTo(a.score));
                return scored.map((entry) => entry.row).toList();
              })();

        final availablePermissions =
            currentInstance?.permissionModes ?? const <MobileDraftPermission>[];
        final showPlanToggle =
            widget.onPlanMode != null &&
            (current.supportsPlanMode || current.planMode);
        final showPermissionButton =
            widget.onPermissionMode != null &&
            availablePermissions.isNotEmpty &&
            current.permissionMode != null;

        return Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Center(
              child: Padding(
                padding: ComposerSpace.sheetHandlePadding,
                child: SizedBox(
                  width: ComposerControl.sheetHandleWidth,
                  height: ComposerControl.sheetHandleHeight,
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: colors.strongBorder,
                      borderRadius: BorderRadius.circular(
                        ComposerRadius.sheetHandle,
                      ),
                    ),
                  ),
                ),
              ),
            ),
            Padding(
              padding: ComposerSpace.sheetHeaderPadding,
              child: Row(
                children: [
                  Expanded(
                    child: Semantics(
                      header: true,
                      child: Text(
                        'Agent 和模型',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: ComposerType.sheetTitle(
                          colors.foreground,
                          theme.platform,
                        ),
                      ),
                    ),
                  ),
                  MobileSheetCloseButton(
                    touchDimension: touch,
                    onPressed: widget.onClose,
                  ),
                ],
              ),
            ),
            _AgentInstanceRail(
              instances: instances,
              selectedTab: activeTab,
              currentInstanceId: currentInstanceId,
              onSelectTab: (next) => setState(() => _tab = next),
            ),
            Divider(
              height: ComposerBorder.hairline,
              thickness: ComposerBorder.hairline,
              color: colors.divider,
            ),
            Padding(
              padding: ComposerSpace.searchPadding,
              child: _ModelSearchField(
                controller: _searchController,
                query: _query,
                onChanged: (value) => setState(() => _query = value),
                onClear: () {
                  _searchController.clear();
                  setState(() => _query = '');
                },
              ),
            ),
            Divider(
              height: ComposerBorder.hairline,
              thickness: ComposerBorder.hairline,
              color: colors.divider,
            ),
            Flexible(
              child: _ModelListSection(
                isLoading: isLoading,
                hasError: hasError,
                isFavoritesTab: activeTab == _favoritesTab,
                hasQuery: trimmedQuery.isNotEmpty,
                rows: visibleRows,
                currentInstanceId: currentInstanceId,
                currentModelId: currentModel?.id ?? current.modelId,
                locked: current.locked,
                preferences: preferences,
                onRetry: () {
                  ref.invalidate(
                    composerDraftOptionsProvider(widget.connection),
                  );
                  if (activeTab != _favoritesTab) {
                    ref.invalidate(
                      composerDraftModelsProvider((
                        widget.connection,
                        activeTab,
                      )),
                    );
                  }
                },
                onToggleFavorite: (key) =>
                    unawaited(preferencesNotifier.toggleFavorite(key)),
                onSelect: (row) {
                  if (current.locked) return;
                  unawaited(
                    Future<void>.sync(
                      () => widget.onSelectModel(row.instance, row.model),
                    ),
                  );
                },
              ),
            ),
            if (current.locked)
              Container(
                key: const ValueKey('composer-model-locked-banner'),
                padding: ComposerSpace.lockedBannerPadding,
                color: colors.attentionTint,
                child: Row(
                  spacing: ComposerSpace.lockedBannerGap,
                  children: [
                    IconTheme(
                      data: IconThemeData(color: colors.attention),
                      child: const WorkspaceIcon(
                        WorkspaceGlyph.lock,
                        size: ComposerControl.pickerLockIcon,
                      ),
                    ),
                    Expanded(
                      child: Text(
                        '运行中不可切换 Agent 或模型，其他参数将在下一轮生效',
                        style: ComposerType.notice(colors.attention),
                      ),
                    ),
                  ],
                ),
              ),
            if (current.notice case final notice? when notice.isNotEmpty)
              Container(
                key: const ValueKey('composer-model-notice-banner'),
                padding: ComposerSpace.lockedBannerPadding,
                color: colors.errorTint,
                child: Text(notice, style: ComposerType.notice(colors.error)),
              ),
            _ModelPickerFooter(
              currentModel: currentModel,
              currentKey: currentKey,
              effort: currentEffort,
              fast: currentFast,
              ultracode: currentUltracode,
              onEffortChanged: (next) {
                if (currentKey == null) return;
                unawaited(preferencesNotifier.setEffort(currentKey, next));
              },
              onToggleFast: () {
                if (currentKey == null) return;
                unawaited(
                  preferencesNotifier.setFast(currentKey, !currentFast),
                );
              },
              onToggleUltracode: () {
                if (currentKey == null) return;
                unawaited(
                  preferencesNotifier.setUltracode(
                    currentKey,
                    !currentUltracode,
                  ),
                );
              },
              showPlanToggle: showPlanToggle,
              planMode: current.planMode,
              onTogglePlan: showPlanToggle
                  ? () => unawaited(
                      Future<void>.sync(
                        () => widget.onPlanMode!(!current.planMode),
                      ),
                    )
                  : null,
              showPermissionButton: showPermissionButton,
              permissionMode: current.permissionMode,
              onTapPermission: showPermissionButton
                  ? () => unawaited(
                      _pickPermission(
                        current: current.permissionMode,
                        modes: availablePermissions,
                      ),
                    )
                  : null,
            ),
          ],
        );
      },
    );
  }
}

class _AgentInstanceRail extends StatelessWidget {
  const _AgentInstanceRail({
    required this.instances,
    required this.selectedTab,
    required this.currentInstanceId,
    required this.onSelectTab,
  });

  final List<MobileDraftInstance> instances;
  final String selectedTab;
  final String? currentInstanceId;
  final ValueChanged<String> onSelectTab;

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final colors = ComposerSurface.palette(brightness);
    final touch = timelineTouchHeight(context);

    return SingleChildScrollView(
      key: const ValueKey('composer-agent-rail'),
      scrollDirection: Axis.horizontal,
      padding: ComposerSpace.railPadding,
      child: Row(
        spacing: ComposerSpace.railGap,
        children: [
          _RailTabButton(
            key: const ValueKey('composer-rail-favorites'),
            selected: selectedTab == _favoritesTab,
            current: false,
            touchHeight: touch,
            label: '收藏',
            tooltip: '收藏',
            leading: IconTheme(
              data: IconThemeData(
                color: selectedTab == _favoritesTab
                    ? ComposerSurface.favorite
                    : colors.muted,
              ),
              child: WorkspaceIcon(
                selectedTab == _favoritesTab
                    ? WorkspaceGlyph.starFilled
                    : WorkspaceGlyph.star,
                size: ComposerControl.agentIconMd,
              ),
            ),
            onTap: () => onSelectTab(_favoritesTab),
          ),
          if (instances.isNotEmpty)
            Container(
              width: ComposerControl.pickerRailSepWidth,
              height: ComposerControl.pickerRailSepHeight,
              margin: ComposerSpace.railSeparatorMargin,
              color: colors.border,
            ),
          for (final item in instances)
            _RailTabButton(
              key: ValueKey('composer-rail-${item.instanceId}'),
              selected: selectedTab == item.instanceId,
              current: currentInstanceId == item.instanceId,
              touchHeight: touch,
              label: item.label,
              tooltip: item.label,
              leading: AgentBadgeIcon(
                agentId: item.agentId ?? item.instanceId,
                instanceId: item.instanceId,
                accentColor: item.accentColor,
                name: item.label,
                size: ComposerControl.agentIconMd,
                ringColor: selectedTab == item.instanceId
                    ? colors.selectedOnSurface
                    : colors.surface,
              ),
              onTap: () => onSelectTab(item.instanceId),
            ),
        ],
      ),
    );
  }
}

class _RailTabButton extends StatelessWidget {
  const _RailTabButton({
    super.key,
    required this.selected,
    required this.current,
    required this.touchHeight,
    required this.label,
    required this.tooltip,
    required this.leading,
    required this.onTap,
  });

  final bool selected;
  final bool current;
  final double touchHeight;
  final String label;
  final String tooltip;
  final Widget leading;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final colors = ComposerSurface.palette(brightness);
    final radius = BorderRadius.circular(ComposerRadius.block);

    return Tooltip(
      message: tooltip,
      child: Semantics(
        button: true,
        selected: selected,
        label: current ? '$label（当前使用）' : label,
        child: InkWell(
          onTap: onTap,
          borderRadius: radius,
          child: ConstrainedBox(
            constraints: BoxConstraints(
              minWidth: touchHeight,
              minHeight: touchHeight,
            ),
            child: Center(
              child: Container(
                height: ComposerControl.pickerRailHeight,
                padding: ComposerSpace.railTabPadding,
                decoration: BoxDecoration(
                  color: selected ? colors.selectedOnSurface : colors.field,
                  borderRadius: radius,
                  border: Border.all(
                    color: selected
                        ? ComposerSurface.accent(brightness)
                        : colors.divider,
                    width: selected
                        ? ComposerBorder.regular
                        : ComposerBorder.hairline,
                  ),
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  spacing: ComposerSpace.railTabGap,
                  children: [
                    leading,
                    Text(
                      label,
                      maxLines: 1,
                      style: ComposerType.railLabel(
                        selected ? colors.foreground : colors.secondaryText,
                        selected: selected,
                      ),
                    ),
                    if (current)
                      DecoratedBox(
                        decoration: BoxDecoration(
                          color: colors.readyMark,
                          shape: BoxShape.circle,
                        ),
                        child: const SizedBox.square(
                          dimension: ComposerControl.pickerCurrentDot,
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ModelSearchField extends StatelessWidget {
  const _ModelSearchField({
    required this.controller,
    required this.query,
    required this.onChanged,
    required this.onClear,
  });

  final TextEditingController controller;
  final String query;
  final ValueChanged<String> onChanged;
  final VoidCallback onClear;

  @override
  Widget build(BuildContext context) {
    final colors = ComposerSurface.palette(Theme.of(context).brightness);
    final touch = timelineTouchHeight(context);

    return Container(
      constraints: BoxConstraints(minHeight: touch),
      decoration: BoxDecoration(
        color: colors.field,
        borderRadius: BorderRadius.circular(ComposerRadius.block),
        border: Border.all(
          color: colors.inputBorder,
          width: ComposerBorder.hairline,
        ),
      ),
      padding: const EdgeInsetsDirectional.only(start: TimelineSpace.x5),
      child: Row(
        spacing: ComposerSpace.searchGap,
        children: [
          IconTheme(
            data: IconThemeData(color: colors.muted),
            child: const WorkspaceIcon(
              WorkspaceGlyph.search,
              size: ComposerControl.pickerSearchIcon,
            ),
          ),
          Expanded(
            child: TextField(
              key: const ValueKey('composer-model-search'),
              controller: controller,
              onChanged: onChanged,
              style: ComposerType.searchInput(colors.foreground),
              decoration: InputDecoration(
                hintText: '搜索模型',
                hintStyle: ComposerType.searchInput(colors.faint),
                isDense: true,
                border: InputBorder.none,
                contentPadding: const EdgeInsets.symmetric(
                  vertical: TimelineSpace.x4,
                ),
              ),
            ),
          ),
          if (query.isNotEmpty)
            SizedBox.square(
              dimension: touch,
              child: IconButton(
                tooltip: '清除搜索',
                color: colors.muted,
                onPressed: onClear,
                icon: const WorkspaceIcon(
                  WorkspaceGlyph.close,
                  size: ComposerControl.pickerSearchIcon,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _ModelListSection extends StatelessWidget {
  const _ModelListSection({
    required this.isLoading,
    required this.hasError,
    required this.isFavoritesTab,
    required this.hasQuery,
    required this.rows,
    required this.currentInstanceId,
    required this.currentModelId,
    required this.locked,
    required this.preferences,
    required this.onRetry,
    required this.onToggleFavorite,
    required this.onSelect,
  });

  final bool isLoading;
  final bool hasError;
  final bool isFavoritesTab;
  final bool hasQuery;
  final List<_ModelRowEntry> rows;
  final String? currentInstanceId;
  final String? currentModelId;
  final bool locked;
  final ModelPreferences preferences;
  final VoidCallback onRetry;
  final ValueChanged<String> onToggleFavorite;
  final ValueChanged<_ModelRowEntry> onSelect;

  @override
  Widget build(BuildContext context) {
    final colors = ComposerSurface.palette(Theme.of(context).brightness);
    final touch = timelineTouchHeight(context);

    if (isLoading) {
      return Padding(
        padding: ComposerSpace.emptyStatePadding,
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          spacing: ComposerSpace.emptyStateGap,
          children: [
            const SizedBox.square(
              dimension: ComposerControl.pickerSpinnerSize,
              child: CircularProgressIndicator.adaptive(
                strokeWidth: ComposerControl.pickerSpinnerStroke,
              ),
            ),
            Text('正在读取…', style: ComposerType.modelRowSubtitle(colors.muted)),
          ],
        ),
      );
    }

    if (hasError) {
      return Padding(
        padding: ComposerSpace.emptyStatePadding,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          spacing: ComposerSpace.emptyStateGap,
          children: [
            Text(
              '暂时无法读取模型列表',
              style: ComposerType.modelRowSubtitle(colors.muted),
            ),
            TextButton(
              style: TextButton.styleFrom(minimumSize: Size(touch, touch)),
              onPressed: onRetry,
              child: const Text('重试'),
            ),
          ],
        ),
      );
    }

    if (rows.isEmpty) {
      return Padding(
        padding: ComposerSpace.emptyStatePadding,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          spacing: ComposerSpace.emptyStateGap,
          children: [
            if (isFavoritesTab && !hasQuery)
              IconTheme(
                data: IconThemeData(color: colors.faint),
                child: const WorkspaceIcon(
                  WorkspaceGlyph.star,
                  size: ComposerControl.agentIconLg,
                ),
              ),
            Text(
              isFavoritesTab && !hasQuery ? '点模型右边的星星，常用的就会放到这里' : '没找到模型',
              textAlign: TextAlign.center,
              style: ComposerType.modelRowSubtitle(colors.muted),
            ),
          ],
        ),
      );
    }

    return ListView.builder(
      shrinkWrap: true,
      padding: ComposerSpace.listPadding,
      itemCount: rows.length,
      itemBuilder: (context, index) {
        final row = rows[index];
        final key = modelPreferenceKey(row.instance.instanceId, row.model.id);
        final isCurrent =
            row.instance.instanceId == currentInstanceId &&
            row.model.id == currentModelId;
        final isFavorite = preferences.isFavorite(key);
        return _ModelListRow(
          row: row,
          current: isCurrent,
          locked: locked,
          favorite: isFavorite,
          onSelect: () => onSelect(row),
          onToggleFavorite: () => onToggleFavorite(key),
        );
      },
    );
  }
}

class _ModelListRow extends StatelessWidget {
  const _ModelListRow({
    required this.row,
    required this.current,
    required this.locked,
    required this.favorite,
    required this.onSelect,
    required this.onToggleFavorite,
  });

  final _ModelRowEntry row;
  final bool current;
  final bool locked;
  final bool favorite;
  final VoidCallback onSelect;
  final VoidCallback onToggleFavorite;

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final colors = ComposerSurface.palette(brightness);
    final touch = timelineTouchHeight(context);
    final minHeight = math.max(ComposerControl.pickerRowMinHeight, touch);
    final radius = BorderRadius.circular(ComposerRadius.block);
    final subtitle = row.isDefault
        ? '${row.instance.label} · 默认'
        : row.instance.label;

    return Semantics(
      selected: current,
      enabled: !locked,
      child: Material(
        color: current ? colors.selected : Colors.transparent,
        borderRadius: radius,
        child: InkWell(
          onTap: locked ? null : onSelect,
          borderRadius: radius,
          child: ConstrainedBox(
            constraints: BoxConstraints(minHeight: minHeight),
            child: Padding(
              padding: ComposerSpace.modelRowPadding,
              child: Row(
                spacing: ComposerSpace.modelRowGap,
                children: [
                  Expanded(
                    child: Opacity(
                      opacity: locked ? ComposerControl.lockedRowOpacity : 1,
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            spacing: ComposerSpace.modelRowTitleGap,
                            children: [
                              Flexible(
                                child: Text(
                                  row.model.label,
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: ComposerType.modelRowTitle(
                                    colors.foreground,
                                    current: current,
                                  ),
                                ),
                              ),
                              if (row.model.fast == true)
                                const IconTheme(
                                  data: IconThemeData(
                                    color: ComposerSurface.favorite,
                                  ),
                                  child: WorkspaceIcon(
                                    WorkspaceGlyph.zapFilled,
                                    size: ComposerControl.pickerRowFastIcon,
                                  ),
                                ),
                            ],
                          ),
                          Text(
                            subtitle,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: ComposerType.modelRowSubtitle(colors.muted),
                          ),
                        ],
                      ),
                    ),
                  ),
                  if (current)
                    IconTheme(
                      data: IconThemeData(
                        color: ComposerSurface.accent(brightness),
                      ),
                      child: const WorkspaceIcon(
                        WorkspaceGlyph.check,
                        size: ComposerControl.pickerRowCheckIcon,
                      ),
                    ),
                  SizedBox.square(
                    dimension: touch,
                    child: IconButton(
                      key: ValueKey(
                        'composer-favorite-${row.instance.instanceId}-${row.model.id}',
                      ),
                      tooltip: favorite ? '取消收藏' : '收藏',
                      onPressed: onToggleFavorite,
                      color: favorite ? ComposerSurface.favorite : colors.faint,
                      icon: WorkspaceIcon(
                        favorite
                            ? WorkspaceGlyph.starFilled
                            : WorkspaceGlyph.star,
                        size: ComposerControl.pickerRowStarIcon,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ModelPickerFooter extends StatelessWidget {
  const _ModelPickerFooter({
    required this.currentModel,
    required this.currentKey,
    required this.effort,
    required this.fast,
    required this.ultracode,
    required this.onEffortChanged,
    required this.onToggleFast,
    required this.onToggleUltracode,
    required this.showPlanToggle,
    required this.planMode,
    required this.onTogglePlan,
    required this.showPermissionButton,
    required this.permissionMode,
    required this.onTapPermission,
  });

  final MobileDraftModel? currentModel;
  final String? currentKey;
  final String? effort;
  final bool fast;
  final bool ultracode;
  final ValueChanged<String?> onEffortChanged;
  final VoidCallback onToggleFast;
  final VoidCallback onToggleUltracode;
  final bool showPlanToggle;
  final bool planMode;
  final VoidCallback? onTogglePlan;
  final bool showPermissionButton;
  final MobileDraftPermission? permissionMode;
  final VoidCallback? onTapPermission;

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final colors = ComposerSurface.palette(brightness);
    final efforts = currentModel?.efforts ?? const <String>[];
    final supportsFast = currentModel?.fast == true && currentKey != null;
    final supportsUltracode =
        currentModel?.ultracode == true && currentKey != null;

    return Container(
      decoration: BoxDecoration(
        color: colors.panel,
        border: Border(
          top: BorderSide(
            color: colors.divider,
            width: ComposerBorder.hairline,
          ),
        ),
      ),
      padding: ComposerSpace.footerPadding,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        spacing: ComposerSpace.footerRowGap,
        children: [
          _EffortSliderRow(
            efforts: efforts,
            value: effort,
            enabled: currentKey != null && efforts.isNotEmpty,
            onChanged: onEffortChanged,
          ),
          Row(
            children: [
              _ModeSwitchButton(
                key: const ValueKey('composer-switch-fast'),
                tooltip: supportsFast ? '快速模式 · 更快，但更贵' : '这个模型没有快速模式',
                semanticsLabel: '快速模式',
                glyph: fast ? WorkspaceGlyph.zapFilled : WorkspaceGlyph.zap,
                active: fast,
                supported: supportsFast,
                activeBackground: colors.attentionTint,
                activeForeground: ComposerSurface.favorite,
                onTap: onToggleFast,
              ),
              _ModeSwitchButton(
                key: const ValueKey('composer-switch-ultracode'),
                tooltip: supportsUltracode
                    ? 'Ultracode · 多子 Agent 并行'
                    : '这个模型不能用 Ultracode',
                semanticsLabel: 'Ultracode',
                glyph: WorkspaceGlyph.workflow,
                active: ultracode,
                supported: supportsUltracode,
                activeBackground: ComposerSurface.accentSoftStrong(brightness),
                activeForeground: ComposerSurface.accentText(brightness),
                onTap: onToggleUltracode,
              ),
              const SizedBox(width: ComposerSpace.footerControlGap),
              Expanded(
                child: Align(
                  alignment: AlignmentDirectional.centerEnd,
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    spacing: ComposerSpace.footerControlGap,
                    children: [
                      if (showPlanToggle)
                        _PlanModeButton(active: planMode, onTap: onTogglePlan),
                      if (showPermissionButton && permissionMode != null)
                        Flexible(
                          child: _PermissionSwitchButton(
                            mode: permissionMode!,
                            onTap: onTapPermission,
                          ),
                        ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _ModeSwitchButton extends StatelessWidget {
  const _ModeSwitchButton({
    super.key,
    required this.tooltip,
    required this.semanticsLabel,
    required this.glyph,
    required this.active,
    required this.supported,
    required this.activeBackground,
    required this.activeForeground,
    required this.onTap,
  });

  final String tooltip;
  final String semanticsLabel;
  final WorkspaceGlyph glyph;
  final bool active;
  final bool supported;
  final Color activeBackground;
  final Color activeForeground;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final colors = ComposerSurface.palette(Theme.of(context).brightness);
    final touch = timelineTouchHeight(context);
    final radius = BorderRadius.circular(ComposerRadius.block);

    return Tooltip(
      message: tooltip,
      child: Semantics(
        button: true,
        enabled: supported,
        toggled: active,
        label: semanticsLabel,
        child: SizedBox.square(
          dimension: touch,
          child: InkWell(
            onTap: supported ? onTap : null,
            borderRadius: radius,
            child: Center(
              child: Opacity(
                opacity: supported ? 1 : ComposerControl.disabledOpacity,
                child: Container(
                  width: ComposerControl.switchVisualSize,
                  height: ComposerControl.switchVisualSize,
                  decoration: BoxDecoration(
                    color: active && supported
                        ? activeBackground
                        : Colors.transparent,
                    borderRadius: radius,
                  ),
                  alignment: Alignment.center,
                  child: IconTheme(
                    data: IconThemeData(
                      color: !supported
                          ? colors.faint
                          : active
                          ? activeForeground
                          : colors.muted,
                    ),
                    child: WorkspaceIcon(
                      glyph,
                      size: ComposerControl.switchIcon,
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _EffortSliderRow extends StatelessWidget {
  const _EffortSliderRow({
    required this.efforts,
    required this.value,
    required this.enabled,
    required this.onChanged,
  });

  final List<String> efforts;
  final String? value;
  final bool enabled;
  final ValueChanged<String?> onChanged;

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final colors = ComposerSurface.palette(brightness);
    final touch = timelineTouchHeight(context);
    final stops = <String?>[null, ...efforts];
    final maxIndex = stops.length - 1;
    final selectedIndex = !enabled || value == null
        ? 0
        : math.max(0, stops.indexOf(value));
    String labelOf(String? stop) =>
        stop == null ? '默认' : composerEffortLabel(stop);
    final displayText = !enabled ? '—' : labelOf(stops[selectedIndex]);

    void selectAt(double dx, double width) {
      if (!enabled || maxIndex <= 0) return;
      const thumb = ComposerControl.effortThumbDiameter;
      final span = math.max(1.0, width - thumb);
      final clamped = ((dx - thumb / 2) / span).clamp(0.0, 1.0);
      final nextIndex = (clamped * maxIndex).round().clamp(0, maxIndex);
      if (nextIndex != selectedIndex) {
        onChanged(stops[nextIndex]);
      }
    }

    return Row(
      spacing: ComposerSpace.effortRowGap,
      children: [
        Text('思考深度', style: ComposerType.footerLabel(colors.muted)),
        Expanded(
          child: Semantics(
            slider: enabled,
            enabled: enabled,
            label: '思考深度',
            value: displayText,
            increasedValue: enabled && selectedIndex < maxIndex
                ? labelOf(stops[selectedIndex + 1])
                : null,
            decreasedValue: enabled && selectedIndex > 0
                ? labelOf(stops[selectedIndex - 1])
                : null,
            onIncrease: enabled && selectedIndex < maxIndex
                ? () => onChanged(stops[selectedIndex + 1])
                : null,
            onDecrease: enabled && selectedIndex > 0
                ? () => onChanged(stops[selectedIndex - 1])
                : null,
            child: LayoutBuilder(
              builder: (context, constraints) {
                final trackWidth = constraints.maxWidth;
                const thumbSize = ComposerControl.effortThumbDiameter;
                final span = math.max(0.0, trackWidth - thumbSize);
                final fillWidth =
                    !enabled || maxIndex <= 0 || selectedIndex == 0
                    ? 0.0
                    : thumbSize + span * (selectedIndex / maxIndex);
                final thumbLeft = maxIndex <= 0
                    ? 0.0
                    : span * (selectedIndex / maxIndex);

                return GestureDetector(
                  key: const ValueKey('composer-effort-slider'),
                  behavior: HitTestBehavior.opaque,
                  onTapUp: enabled
                      ? (details) =>
                            selectAt(details.localPosition.dx, trackWidth)
                      : null,
                  onHorizontalDragStart: enabled
                      ? (details) =>
                            selectAt(details.localPosition.dx, trackWidth)
                      : null,
                  onHorizontalDragUpdate: enabled
                      ? (details) =>
                            selectAt(details.localPosition.dx, trackWidth)
                      : null,
                  child: SizedBox(
                    height: touch,
                    child: Center(
                      child: Opacity(
                        opacity: enabled ? 1 : ComposerControl.disabledOpacity,
                        child: SizedBox(
                          width: trackWidth,
                          height: ComposerControl.effortThumbDiameter,
                          child: Stack(
                            clipBehavior: Clip.none,
                            alignment: Alignment.centerLeft,
                            children: [
                              Positioned(
                                left: 0,
                                right: 0,
                                child: Container(
                                  height: ComposerControl.effortTrackHeight,
                                  decoration: BoxDecoration(
                                    color: colors.switchTrack,
                                    borderRadius: BorderRadius.circular(
                                      ComposerRadius.full,
                                    ),
                                  ),
                                ),
                              ),
                              if (fillWidth > 0)
                                Positioned(
                                  left: 0,
                                  width: fillWidth,
                                  child: Container(
                                    height: ComposerControl.effortTrackHeight,
                                    decoration: BoxDecoration(
                                      color: ComposerSurface.accent(brightness),
                                      borderRadius: BorderRadius.circular(
                                        ComposerRadius.full,
                                      ),
                                    ),
                                  ),
                                ),
                              if (enabled && maxIndex > 0)
                                for (var i = 0; i <= maxIndex; i++)
                                  if (i != selectedIndex)
                                    Positioned(
                                      left:
                                          thumbSize / 2 +
                                          span * (i / maxIndex) -
                                          (i == 0
                                                  ? ComposerControl
                                                        .effortDefaultRingDiameter
                                                  : ComposerControl
                                                        .effortDotDiameter) /
                                              2,
                                      child: Container(
                                        width: i == 0
                                            ? ComposerControl
                                                  .effortDefaultRingDiameter
                                            : ComposerControl.effortDotDiameter,
                                        height: i == 0
                                            ? ComposerControl
                                                  .effortDefaultRingDiameter
                                            : ComposerControl.effortDotDiameter,
                                        decoration: i == 0
                                            ? BoxDecoration(
                                                shape: BoxShape.circle,
                                                border: Border.all(
                                                  color: i < selectedIndex
                                                      ? colors.onPrimary.withValues(
                                                          alpha: ComposerControl
                                                              .effortOnDotOpacity,
                                                        )
                                                      : colors.strongBorder,
                                                  width: ComposerBorder
                                                      .effortDefaultRing,
                                                ),
                                              )
                                            : BoxDecoration(
                                                shape: BoxShape.circle,
                                                color: i < selectedIndex
                                                    ? colors.onPrimary.withValues(
                                                        alpha: ComposerControl
                                                            .effortOnDotOpacity,
                                                      )
                                                    : colors.strongBorder,
                                              ),
                                      ),
                                    ),
                              if (enabled)
                                Positioned(
                                  left: thumbLeft,
                                  child: Container(
                                    width: thumbSize,
                                    height: thumbSize,
                                    decoration: BoxDecoration(
                                      color: colors.switchThumb,
                                      shape: BoxShape.circle,
                                      boxShadow: ComposerSurface.knobShadow,
                                    ),
                                  ),
                                ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                );
              },
            ),
          ),
        ),
        ConstrainedBox(
          constraints: const BoxConstraints(
            minWidth: ComposerControl.effortValueMinWidth,
          ),
          child: Text(
            displayText,
            key: const ValueKey('composer-effort-value'),
            textAlign: TextAlign.end,
            style: ComposerType.footerValue(
              enabled && value != null ? colors.foreground : colors.muted,
              emphasized: enabled && value != null,
            ),
          ),
        ),
      ],
    );
  }
}

class _PlanModeButton extends StatelessWidget {
  const _PlanModeButton({required this.active, required this.onTap});

  final bool active;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final colors = ComposerSurface.palette(brightness);
    final touch = timelineTouchHeight(context);
    final radius = BorderRadius.circular(ComposerRadius.block);

    return Tooltip(
      message: '计划模式',
      child: Semantics(
        button: true,
        toggled: active,
        label: '计划模式',
        child: InkWell(
          key: const ValueKey('composer-plan-toggle'),
          onTap: onTap,
          borderRadius: radius,
          child: ConstrainedBox(
            constraints: BoxConstraints(minWidth: touch, minHeight: touch),
            child: Center(
              child: Container(
                height: ComposerControl.planToggleVisualHeight,
                padding: ComposerSpace.planTogglePadding,
                decoration: BoxDecoration(
                  color: active
                      ? ComposerSurface.accentSoftStrong(brightness)
                      : Colors.transparent,
                  borderRadius: radius,
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  spacing: ComposerSpace.chipGap,
                  children: [
                    IconTheme(
                      data: IconThemeData(
                        color: active
                            ? ComposerSurface.accentText(brightness)
                            : colors.muted,
                      ),
                      child: WorkspaceIcon(
                        active ? WorkspaceGlyph.listChecks : WorkspaceGlyph.bot,
                        size: ComposerControl.planToggleIcon,
                      ),
                    ),
                    Text(
                      active ? '计划' : '执行',
                      style: ComposerType.footerValue(
                        active
                            ? ComposerSurface.accentText(brightness)
                            : colors.muted,
                        emphasized: active,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _PermissionSwitchButton extends StatelessWidget {
  const _PermissionSwitchButton({required this.mode, required this.onTap});

  final MobileDraftPermission mode;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final colors = ComposerSurface.palette(Theme.of(context).brightness);
    final touch = timelineTouchHeight(context);
    final isElevated = composerPermissionNeedsConfirmation(mode);
    final label = composerPermissionLabel(mode);
    final foreground = isElevated ? colors.attention : colors.secondaryText;
    final radius = BorderRadius.circular(ComposerRadius.block);

    return Tooltip(
      message: '权限模式',
      child: Semantics(
        button: true,
        label: '权限模式：$label',
        child: InkWell(
          key: const ValueKey('composer-permission-button'),
          onTap: onTap,
          borderRadius: radius,
          child: ConstrainedBox(
            constraints: BoxConstraints(minWidth: touch, minHeight: touch),
            child: Center(
              child: Container(
                height: ComposerControl.permissionButtonVisualHeight,
                constraints: const BoxConstraints(
                  maxWidth: ComposerControl.permissionButtonMaxWidth,
                ),
                padding: ComposerSpace.permissionButtonPadding,
                decoration: BoxDecoration(
                  color: isElevated ? colors.attentionTint : colors.field,
                  borderRadius: radius,
                ),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  spacing: ComposerSpace.chipGap,
                  children: [
                    IconTheme(
                      data: IconThemeData(color: foreground),
                      child: WorkspaceIcon(
                        composerPermissionGlyph(mode),
                        size: ComposerControl.permissionButtonIcon,
                      ),
                    ),
                    Flexible(
                      child: Text(
                        label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: ComposerType.footerValue(
                          foreground,
                          emphasized: isElevated,
                        ),
                      ),
                    ),
                    IconTheme(
                      data: IconThemeData(
                        color: isElevated ? colors.attention : colors.faint,
                      ),
                      child: const WorkspaceIcon(
                        WorkspaceGlyph.chevronDown,
                        size: ComposerControl.chipCaret,
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _PermissionOptionRow extends StatelessWidget {
  const _PermissionOptionRow({
    required this.mode,
    required this.selected,
    required this.dividerAbove,
    required this.onTap,
  });

  final MobileDraftPermission mode;
  final bool selected;
  final bool dividerAbove;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final brightness = Theme.of(context).brightness;
    final colors = ComposerSurface.palette(brightness);
    final touch = timelineTouchHeight(context);
    final isElevated = composerPermissionNeedsConfirmation(mode);
    final titleColor = isElevated ? colors.attention : colors.foreground;
    final iconColor = isElevated ? colors.attention : colors.secondaryText;

    return Semantics(
      button: true,
      selected: selected,
      child: InkWell(
        onTap: onTap,
        child: ConstrainedBox(
          constraints: BoxConstraints(
            minHeight: math.max(ComposerControl.permissionRowMinHeight, touch),
          ),
          child: DecoratedBox(
            decoration: BoxDecoration(
              border: dividerAbove
                  ? Border(
                      top: BorderSide(
                        color: colors.divider,
                        width: ComposerBorder.hairline,
                      ),
                    )
                  : null,
            ),
            child: Padding(
              padding: ComposerSpace.permissionRowPadding,
              child: Row(
                spacing: ComposerSpace.permissionRowGap,
                children: [
                  IconTheme(
                    data: IconThemeData(color: iconColor),
                    child: WorkspaceIcon(
                      composerPermissionGlyph(mode),
                      size: ComposerControl.permissionRowIcon,
                    ),
                  ),
                  Expanded(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      spacing: ComposerSpace.permissionTextGap,
                      children: [
                        Text(
                          composerPermissionLabel(mode),
                          style: ComposerType.permissionTitle(
                            titleColor,
                            emphasized: selected || isElevated,
                          ),
                        ),
                        Text(
                          composerPermissionDescription(mode),
                          style: ComposerType.permissionDescription(
                            colors.muted,
                          ),
                        ),
                      ],
                    ),
                  ),
                  if (selected)
                    IconTheme(
                      data: IconThemeData(
                        color: ComposerSurface.accent(brightness),
                      ),
                      child: const WorkspaceIcon(
                        WorkspaceGlyph.check,
                        size: ComposerControl.pickerRowCheckIcon,
                      ),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
