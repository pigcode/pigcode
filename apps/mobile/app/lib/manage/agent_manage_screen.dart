import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';

import '../app_theme.dart';
import '../mobile_glass.dart';
import '../mobile_sheet.dart';
import '../theme_colors.dart';
import '../timeline/timeline_tokens.dart';
import '../workspace_icon.dart';
import 'agent_instance_editor_screen.dart';
import 'manage_form_widgets.dart';
import 'manage_utils.dart';

/// Agent 实例总览页：设置新会话默认 Agent、聚焦显示已就绪/已配置实例，
/// 其余未配置 Agent 折叠收纳在底部，避免空占位卡片铺屏。
class AgentManageScreen extends StatefulWidget {
  const AgentManageScreen({
    super.key,
    required this.connectionListenable,
    this.computerName,
  });

  static const refreshDetectButtonKey = ValueKey('agent-manage-refresh-detect');
  static const globalCreateButtonKey = ValueKey('agent-manage-global-create');
  static const defaultCardKey = ValueKey('agent-manage-default-card');
  static const defaultAutoOptionKey = ValueKey('agent-default-option-auto');
  static const moreAgentsToggleKey = ValueKey('agent-manage-more-toggle');

  static ValueKey<String> createButtonKey(String agentId) =>
      ValueKey('agent-manage-create-$agentId');
  static ValueKey<String> instanceTileKey(String instanceId) =>
      ValueKey('agent-manage-instance-$instanceId');
  static ValueKey<String> toggleKey(String instanceId) =>
      ValueKey('agent-manage-toggle-$instanceId');
  static ValueKey<String> defaultOptionKey(String instanceId) =>
      ValueKey('agent-default-option-$instanceId');

  final ValueListenable<MobileConnection?> connectionListenable;
  final String? computerName;

  static Future<void> open(
    BuildContext context, {
    required ValueListenable<MobileConnection?> connectionListenable,
    String? computerName,
  }) => Navigator.of(context).push<void>(
    MaterialPageRoute<void>(
      builder: (_) => AgentManageScreen(
        connectionListenable: connectionListenable,
        computerName: computerName,
      ),
    ),
  );

  @override
  State<AgentManageScreen> createState() => _AgentManageScreenState();
}

class _AgentManageScreenState extends State<AgentManageScreen> {
  MobileConnection? _connection;
  MobileAgentListResult? _data;
  Map<String, MobileAgentStatus> _statuses = const {};
  bool _loading = true;
  bool _detecting = false;
  bool _updating = false;
  bool _otherExpanded = false;
  String? _error;
  int _seq = 0;

  @override
  void initState() {
    super.initState();
    _connection = widget.connectionListenable.value;
    widget.connectionListenable.addListener(_onConnectionChanged);
    unawaited(_load());
  }

  @override
  void didUpdateWidget(covariant AgentManageScreen oldWidget) {
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
    super.dispose();
  }

  void _onConnectionChanged() {
    if (!mounted) return;
    final next = widget.connectionListenable.value;
    final reconnected = next != null && !identical(next, _connection);
    setState(() => _connection = next);
    if (reconnected) {
      unawaited(_load());
    }
  }

  Future<void> _load({bool refreshDetect = false}) async {
    final conn = _connection;
    final seq = ++_seq;
    setState(() {
      if (_data == null) _loading = true;
      _error = null;
    });
    if (conn == null) {
      setState(() {
        _loading = false;
        _error = '电脑连接已断开，重连后将自动刷新。';
      });
      return;
    }
    try {
      final result = await conn.agents.list();
      if (!mounted || seq != _seq) return;
      setState(() {
        _data = result;
        _loading = false;
      });
      unawaited(_detect(refresh: refreshDetect, seq: seq));
    } catch (error) {
      if (!mounted || seq != _seq) return;
      setState(() {
        _loading = false;
        _error = manageErrorMessage(error);
      });
    }
  }

  Future<void> _detect({required bool refresh, int? seq}) async {
    final conn = _connection;
    if (conn == null) return;
    final expectedSeq = seq ?? _seq;
    setState(() => _detecting = true);
    try {
      final statuses = await conn.agents.detect(refresh: refresh);
      if (!mounted || expectedSeq != _seq) return;
      setState(() {
        _statuses = statuses;
        _detecting = false;
      });
    } catch (error) {
      if (!mounted || expectedSeq != _seq) return;
      setState(() => _detecting = false);
      if (refresh) {
        ScaffoldMessenger.maybeOf(
          context,
        )?.showSnackBar(SnackBar(content: Text(manageErrorMessage(error))));
      }
    }
  }

  bool _isSelectedDefault(
    MobileAgentSummary agent,
    MobileAgentInstance instance,
  ) {
    final data = _data;
    if (data == null || data.defaultAgentId != agent.agentId) return false;
    final defaultInst = data.defaultInstanceId;
    if (defaultInst == null) return instance.isDefault;
    return instance.instanceId == defaultInst;
  }

  String _currentDefaultLabel() {
    final data = _data;
    if (data == null || data.defaultAgentId == null) {
      return '自动挑选（按可用顺序）';
    }
    for (final agent in data.agents) {
      if (agent.agentId != data.defaultAgentId) continue;
      for (final inst in agent.instances) {
        if (_isSelectedDefault(agent, inst)) {
          return inst.isDefault
              ? agent.displayName
              : '${inst.label} · ${agent.displayName}';
        }
      }
      return agent.displayName;
    }
    return data.defaultInstanceId ?? data.defaultAgentId!;
  }

  Future<void> _pickDefaultAgent() async {
    final conn = _connection;
    final data = _data;
    if (conn == null || data == null || _updating) return;

    final choices =
        <({String? agentId, String? instanceId, String label, bool selected})>[
          (
            agentId: null,
            instanceId: null,
            label: '自动挑选（按可用顺序）',
            selected: data.defaultAgentId == null,
          ),
        ];
    for (final agent in data.agents) {
      if (!agent.registered || !agent.enabled) continue;
      for (final inst in agent.instances) {
        if (!inst.enabled) continue;
        choices.add((
          agentId: agent.agentId,
          instanceId: inst.isDefault ? null : inst.instanceId,
          label: inst.isDefault
              ? agent.displayName
              : '${inst.label} (${agent.displayName})',
          selected: _isSelectedDefault(agent, inst),
        ));
      }
    }

    final picked =
        await showMobileSheet<({String? agentId, String? instanceId})>(
          context,
          title: '新会话默认 Agent',
          content: (sheetContext) => SliverList.list(
            children: [
              for (var i = 0; i < choices.length; i++)
                MobileSheetAction(
                  key: choices[i].agentId == null
                      ? AgentManageScreen.defaultAutoOptionKey
                      : AgentManageScreen.defaultOptionKey(
                          choices[i].instanceId ?? choices[i].agentId!,
                        ),
                  glyph: choices[i].selected
                      ? WorkspaceGlyph.check
                      : WorkspaceGlyph.bot,
                  label: choices[i].label,
                  dividerAbove: i > 0,
                  onTap: () => Navigator.pop(sheetContext, (
                    agentId: choices[i].agentId,
                    instanceId: choices[i].instanceId,
                  )),
                ),
            ],
          ),
        );
    if (!mounted || picked == null) return;

    setState(() => _updating = true);
    try {
      await conn.agents.setDefault(
        agentId: picked.agentId,
        instanceId: picked.instanceId,
      );
      if (!mounted) return;
      ScaffoldMessenger.maybeOf(
        context,
      )?.showSnackBar(const SnackBar(content: Text('已更新默认 Agent')));
      await _load();
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.maybeOf(
        context,
      )?.showSnackBar(SnackBar(content: Text(manageErrorMessage(error))));
    } finally {
      if (mounted) setState(() => _updating = false);
    }
  }

  Future<void> _pickAgentToCreate() async {
    final data = _data;
    if (_connection == null || data == null || _updating) return;
    final candidates = data.agents
        .where((agent) => agent.registered)
        .toList(growable: false);
    if (candidates.isEmpty) return;
    if (candidates.length == 1) {
      await _openEditor(candidates.first);
      return;
    }
    final picked = await ManageSelectSheet.show<MobileAgentSummary>(
      context,
      title: '选择要新建实例的 Agent',
      showChevron: true,
      options: [
        for (final agent in candidates)
          ManageSelectOption(
            value: agent,
            label: agent.displayName,
            subtitle: agent.version != null ? 'v${agent.version}' : null,
          ),
      ],
    );
    if (!mounted || picked == null) return;
    await _openEditor(picked);
  }

  Future<void> _toggleInstance(
    MobileAgentInstance instance,
    bool enabled,
  ) async {
    final conn = _connection;
    if (conn == null || _updating) return;
    setState(() => _updating = true);
    try {
      await conn.agents.updateInstance(
        instanceId: instance.instanceId,
        enabled: enabled,
      );
      if (!mounted) return;
      await _load();
    } catch (error) {
      if (!mounted) return;
      ScaffoldMessenger.maybeOf(
        context,
      )?.showSnackBar(SnackBar(content: Text(manageErrorMessage(error))));
    } finally {
      if (mounted) setState(() => _updating = false);
    }
  }

  Future<void> _openEditor(
    MobileAgentSummary agent, {
    MobileAgentInstance? instance,
  }) async {
    final changed = await AgentInstanceEditorScreen.open(
      context,
      connectionListenable: widget.connectionListenable,
      computerName: widget.computerName,
      agent: agent,
      instance: instance,
    );
    if (!mounted || changed != true) return;
    await _load(refreshDetect: true);
  }

  bool _isPrimaryAgent(MobileAgentSummary agent) {
    if (agent.instances.isNotEmpty || agent.error != null) return true;
    final status = _statuses[agent.agentId];
    return status?.installed == true;
  }

  String _statusSubtitle(
    MobileAgentSummary agent,
    MobileAgentInstance instance,
  ) {
    final status =
        _statuses[instance.instanceId] ??
        (instance.isDefault ? _statuses[agent.agentId] : null);
    if (status == null) {
      return _detecting ? '正在检测 CLI 状态…' : instance.instanceId;
    }
    if (!status.installed) {
      final err = status.error?.trim();
      return err != null && err.isNotEmpty ? '未安装 · $err' : '未安装 CLI';
    }
    final parts = <String>[
      status.version != null && status.version!.isNotEmpty
          ? '已安装 ${status.version}'
          : '已安装',
    ];
    if (status.account != null && status.account!.isNotEmpty) {
      parts.add(status.account!);
    } else if (status.email != null && status.email!.isNotEmpty) {
      parts.add(status.email!);
    } else if (status.authenticated == true) {
      parts.add('已登录');
    } else if (status.authenticated == false) {
      parts.add('未登录');
    } else if (status.credentialsConfigured) {
      parts.add('已配置凭据');
    }
    return parts.join(' · ');
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;

    final agents = _data?.agents ?? const <MobileAgentSummary>[];
    final hasCreatable = agents.any((a) => a.registered);
    final primaryAgents = <MobileAgentSummary>[];
    final otherAgents = <MobileAgentSummary>[];
    for (final agent in agents) {
      if (_isPrimaryAgent(agent)) {
        primaryAgents.add(agent);
      } else {
        otherAgents.add(agent);
      }
    }

    return Scaffold(
      backgroundColor: colors.background,
      appBar: AppBar(
        title: ManageAppBarTitle(
          title: 'Agent 实例',
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
        actions: [
          Center(
            child: MobileGlassChromeButton(
              padding: EdgeInsetsDirectional.only(end: hasCreatable ? 6 : 10),
              child: SizedBox.square(
                dimension: 40,
                child: IconButton(
                  key: AgentManageScreen.refreshDetectButtonKey,
                  tooltip: '重新检测状态',
                  padding: EdgeInsets.zero,
                  onPressed: _connection == null || _detecting
                      ? null
                      : () => unawaited(_detect(refresh: true)),
                  icon: _detecting
                      ? const SizedBox.square(
                          dimension: 18,
                          child: CircularProgressIndicator.adaptive(
                            strokeWidth: 2,
                          ),
                        )
                      : const Icon(Icons.refresh, size: 20),
                ),
              ),
            ),
          ),
          if (hasCreatable)
            Center(
              child: MobileGlassChromeButton(
                padding: const EdgeInsetsDirectional.only(end: 10),
                child: SizedBox.square(
                  dimension: 40,
                  child: IconButton(
                    key: AgentManageScreen.globalCreateButtonKey,
                    tooltip: '新建实例',
                    padding: EdgeInsets.zero,
                    onPressed: _connection == null || _updating
                        ? null
                        : () => unawaited(_pickAgentToCreate()),
                    icon: const WorkspaceIcon(WorkspaceGlyph.plus, size: 20),
                  ),
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
            Expanded(
              child: _loading
                  ? const Center(child: CircularProgressIndicator.adaptive())
                  : _error != null
                  ? Center(
                      child: Padding(
                        padding: const EdgeInsets.all(24),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          spacing: 12,
                          children: [
                            Text(
                              _error!,
                              textAlign: TextAlign.center,
                              style: theme.textTheme.bodyMedium?.copyWith(
                                color: colors.muted,
                              ),
                            ),
                            OutlinedButton(
                              onPressed: () => unawaited(_load()),
                              child: const Text('重试'),
                            ),
                          ],
                        ),
                      ),
                    )
                  : RefreshIndicator.adaptive(
                      onRefresh: () => _load(refreshDetect: true),
                      child: ListView(
                        padding: const EdgeInsets.fromLTRB(16, 16, 16, 36),
                        children: [
                          ManageSurfaceCard(
                            children: [
                              ManagePickerRow(
                                key: AgentManageScreen.defaultCardKey,
                                leading: IconTheme(
                                  data: IconThemeData(
                                    color: colors.secondaryText,
                                  ),
                                  child: const WorkspaceIcon(
                                    WorkspaceGlyph.bot,
                                    size: 19,
                                  ),
                                ),
                                title: '默认 Agent',
                                value: _currentDefaultLabel(),
                                enabled: _connection != null && !_updating,
                                onTap: () => unawaited(_pickDefaultAgent()),
                              ),
                            ],
                          ),
                          for (final agent in primaryAgents) ...[
                            const SizedBox(height: 20),
                            _buildPrimaryAgentGroup(context, agent),
                          ],
                          if (otherAgents.isNotEmpty) ...[
                            const SizedBox(height: 22),
                            _buildOtherAgentsSection(
                              context,
                              otherAgents,
                              forceExpanded: primaryAgents.isEmpty,
                            ),
                          ],
                          const SizedBox(height: 24),
                          Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 6),
                            child: Text(
                              'CLI 安装与登录认证请在桌面端完成',
                              textAlign: TextAlign.center,
                              style: TimelineType.smallStyle(colors.muted),
                            ),
                          ),
                        ],
                      ),
                    ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildPrimaryAgentGroup(
    BuildContext context,
    MobileAgentSummary agent,
  ) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final canCreate = _connection != null && agent.registered && !_updating;
    final headerTitle = agent.version != null
        ? '${agent.displayName} · v${agent.version}'
        : agent.displayName;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        ManageSectionHeader(
          title: headerTitle,
          trailing: agent.registered
              ? TextButton.icon(
                  key: AgentManageScreen.createButtonKey(agent.agentId),
                  style: TextButton.styleFrom(
                    visualDensity: VisualDensity.compact,
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 4,
                    ),
                    foregroundColor: colors.secondaryText,
                    textStyle: TimelineType.smallStyle(
                      colors.secondaryText,
                      weight: FontWeight.w500,
                    ),
                  ),
                  onPressed: canCreate
                      ? () => unawaited(_openEditor(agent))
                      : null,
                  icon: const Icon(Icons.add, size: 15),
                  label: const Text('新建'),
                )
              : null,
        ),
        const SizedBox(height: 6),
        ManageSurfaceCard(
          children: [
            if (agent.error != null)
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 10,
                ),
                color: colors.errorTint,
                child: Text(
                  agent.error!,
                  style: TimelineType.smallStyle(colors.error),
                ),
              ),
            if (agent.instances.isEmpty)
              Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 14,
                ),
                child: Text(
                  agent.registered ? '尚无实例，点击右上「新建」添加一个配置' : '暂未启用或未加载',
                  style: TimelineType.metaStyle(colors.muted),
                ),
              )
            else
              for (var i = 0; i < agent.instances.length; i++) ...[
                if (i > 0)
                  Divider(height: 1, indent: 38, color: colors.divider),
                _buildInstanceTile(context, agent, agent.instances[i]),
              ],
          ],
        ),
      ],
    );
  }

  Widget _buildOtherAgentsSection(
    BuildContext context,
    List<MobileAgentSummary> otherAgents, {
    required bool forceExpanded,
  }) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final expanded = forceExpanded || _otherExpanded;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const ManageSectionHeader(title: '其他可用 Agent'),
        const SizedBox(height: 8),
        ManageSurfaceCard(
          children: [
            if (!forceExpanded)
              InkWell(
                key: AgentManageScreen.moreAgentsToggleKey,
                onTap: () => setState(() => _otherExpanded = !_otherExpanded),
                child: ConstrainedBox(
                  constraints: const BoxConstraints(minHeight: 48),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 16,
                      vertical: 12,
                    ),
                    child: Row(
                      children: [
                        Expanded(
                          child: Text(
                            '查看 ${otherAgents.length} 个未建实例的 Agent',
                            style: TimelineType.contentStyle(
                              colors.foreground,
                              weight: FontWeight.w500,
                            ),
                          ),
                        ),
                        Icon(
                          expanded
                              ? Icons.keyboard_arrow_up_rounded
                              : Icons.keyboard_arrow_down_rounded,
                          size: 20,
                          color: colors.muted,
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            if (expanded) ...[
              for (var i = 0; i < otherAgents.length; i++) ...[
                if (i > 0 || !forceExpanded)
                  Divider(height: 1, color: colors.divider),
                _buildOtherAgentRow(context, otherAgents[i]),
              ],
            ],
          ],
        ),
      ],
    );
  }

  Widget _buildOtherAgentRow(BuildContext context, MobileAgentSummary agent) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final canCreate = _connection != null && agent.registered && !_updating;
    return InkWell(
      key: AgentManageScreen.createButtonKey(agent.agentId),
      onTap: canCreate ? () => unawaited(_openEditor(agent)) : null,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 48),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      agent.displayName,
                      style: TimelineType.contentStyle(
                        colors.foreground,
                        weight: FontWeight.w500,
                      ),
                    ),
                    Text(
                      agent.registered ? '未建自定义实例' : '未启用',
                      style: TimelineType.smallStyle(colors.muted),
                    ),
                  ],
                ),
              ),
              if (agent.registered)
                Text(
                  '新建',
                  style: TimelineType.metaStyle(
                    canCreate ? colors.secondaryText : colors.muted,
                    weight: FontWeight.w500,
                  ),
                ),
              const SizedBox(width: 4),
              Icon(Icons.chevron_right, size: 18, color: colors.faint),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildInstanceTile(
    BuildContext context,
    MobileAgentSummary agent,
    MobileAgentInstance instance,
  ) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final isDefaultChoice = _isSelectedDefault(agent, instance);
    final canToggle = !instance.isDefault || agent.accountSetup;
    final dotColor =
        parseAgentAccentColor(instance.accentColor) ??
        (instance.enabled ? colors.readyMark : colors.faint);

    return InkWell(
      key: AgentManageScreen.instanceTileKey(instance.instanceId),
      onTap: _connection == null
          ? null
          : () => unawaited(_openEditor(agent, instance: instance)),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 12, 12),
        child: Row(
          children: [
            Container(
              width: 10,
              height: 10,
              decoration: BoxDecoration(
                color: dotColor,
                shape: BoxShape.circle,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Flexible(
                        child: Text(
                          instance.label,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: TimelineType.contentStyle(
                            colors.foreground,
                            weight: FontWeight.w500,
                          ),
                        ),
                      ),
                      if (isDefaultChoice) ...[
                        const SizedBox(width: 6),
                        ManageStatusTag(
                          label: '默认',
                          background: colors.surfaceSunken,
                          foreground: colors.foreground,
                        ),
                      ] else if (instance.isDefault) ...[
                        const SizedBox(width: 6),
                        ManageStatusTag(
                          label: '内置',
                          background: colors.field,
                          foreground: colors.muted,
                        ),
                      ],
                    ],
                  ),
                  const SizedBox(height: 2),
                  Text(
                    _statusSubtitle(agent, instance),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TimelineType.smallStyle(colors.muted),
                  ),
                ],
              ),
            ),
            if (canToggle) ...[
              const SizedBox(width: 8),
              Switch.adaptive(
                key: AgentManageScreen.toggleKey(instance.instanceId),
                value: instance.enabled,
                onChanged: _connection == null || _updating
                    ? null
                    : (next) => unawaited(_toggleInstance(instance, next)),
              ),
            ],
            const SizedBox(width: 2),
            Icon(Icons.chevron_right, size: 18, color: colors.faint),
          ],
        ),
      ),
    );
  }
}
