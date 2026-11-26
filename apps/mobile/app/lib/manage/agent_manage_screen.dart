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
import 'manage_utils.dart';

/// Agent 实例总览页：设置新会话默认 Agent、按 Agent 分组查看检测状态与启停实例、进入编辑/新建页。
class AgentManageScreen extends StatefulWidget {
  const AgentManageScreen({super.key, required this.connectionListenable});

  static const refreshDetectButtonKey = ValueKey('agent-manage-refresh-detect');
  static const defaultCardKey = ValueKey('agent-manage-default-card');
  static const defaultAutoOptionKey = ValueKey('agent-default-option-auto');

  static ValueKey<String> createButtonKey(String agentId) =>
      ValueKey('agent-manage-create-$agentId');
  static ValueKey<String> instanceTileKey(String instanceId) =>
      ValueKey('agent-manage-instance-$instanceId');
  static ValueKey<String> toggleKey(String instanceId) =>
      ValueKey('agent-manage-toggle-$instanceId');
  static ValueKey<String> defaultOptionKey(String instanceId) =>
      ValueKey('agent-default-option-$instanceId');

  final ValueListenable<MobileConnection?> connectionListenable;

  static Future<void> open(
    BuildContext context, {
    required ValueListenable<MobileConnection?> connectionListenable,
  }) => Navigator.of(context).push<void>(
    MaterialPageRoute<void>(
      builder: (_) =>
          AgentManageScreen(connectionListenable: connectionListenable),
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

    final picked = await showMobileSheet<({String? agentId, String? instanceId})>(
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
      agent: agent,
      instance: instance,
    );
    if (!mounted || changed != true) return;
    await _load(refreshDetect: true);
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

    return Scaffold(
      backgroundColor: colors.background,
      appBar: AppBar(
        title: const Text('Agent 实例'),
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
              padding: const EdgeInsetsDirectional.only(end: 10),
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
                        padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
                        children: [
                          _AgentCard(
                            children: [
                              ListTile(
                                key: AgentManageScreen.defaultCardKey,
                                leading: IconTheme(
                                  data: IconThemeData(
                                    color: colors.secondaryText,
                                  ),
                                  child: const WorkspaceIcon(
                                    WorkspaceGlyph.bot,
                                    size: 20,
                                  ),
                                ),
                                title: const Text('新会话默认 Agent'),
                                subtitle: Text(
                                  _currentDefaultLabel(),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: TimelineType.metaStyle(colors.muted),
                                ),
                                trailing: Icon(
                                  Icons.chevron_right,
                                  size: 18,
                                  color: colors.faint,
                                ),
                                onTap: _connection == null || _updating
                                    ? null
                                    : () => unawaited(_pickDefaultAgent()),
                              ),
                            ],
                          ),
                          for (final agent in _data?.agents ?? const []) ...[
                            const SizedBox(height: 20),
                            _buildAgentGroup(context, agent),
                          ],
                          const SizedBox(height: 24),
                          Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 6),
                            child: Text(
                              'CLI 安装升级与浏览器 OAuth 登录请在电脑端完成。',
                              textAlign: TextAlign.center,
                              style: TimelineType.metaStyle(colors.muted),
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

  Widget _buildAgentGroup(BuildContext context, MobileAgentSummary agent) {
    final colors = Theme.of(context).brightness == Brightness.dark
        ? pigcodeDark
        : pigcodeLight;
    final canCreate = _connection != null && agent.registered && !_updating;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      agent.version != null
                          ? '${agent.displayName} · v${agent.version}'
                          : agent.displayName,
                      style: TimelineType.metaStyle(
                        colors.secondaryText,
                        weight: FontWeight.w600,
                      ),
                    ),
                    if (agent.description != null)
                      Text(
                        agent.description!,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TimelineType.microStyle(colors.muted),
                      ),
                  ],
                ),
              ),
              if (agent.registered)
                TextButton.icon(
                  key: AgentManageScreen.createButtonKey(agent.agentId),
                  onPressed: canCreate
                      ? () => unawaited(_openEditor(agent))
                      : null,
                  icon: const Icon(Icons.add, size: 16),
                  label: const Text('新建实例'),
                ),
            ],
          ),
        ),
        const SizedBox(height: 6),
        _AgentCard(
          children: [
            if (agent.error != null)
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 10,
                ),
                color: colors.error.withValues(alpha: 0.08),
                child: Text(
                  agent.error!,
                  style: TimelineType.metaStyle(colors.error),
                ),
              ),
            if (agent.instances.isEmpty)
              Padding(
                padding: const EdgeInsets.all(16),
                child: Text(
                  agent.registered
                      ? '暂无实例，点击右上角「新建实例」进行配置'
                      : '此 Agent 当前未启用或未加载',
                  style: TimelineType.metaStyle(colors.muted),
                ),
              )
            else
              for (var i = 0; i < agent.instances.length; i++) ...[
                if (i > 0)
                  Divider(height: 1, indent: 46, color: colors.divider),
                _buildInstanceTile(context, agent, agent.instances[i]),
              ],
          ],
        ),
      ],
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

    return ListTile(
      key: AgentManageScreen.instanceTileKey(instance.instanceId),
      leading: Container(
        width: 10,
        height: 10,
        decoration: BoxDecoration(color: dotColor, shape: BoxShape.circle),
      ),
      minLeadingWidth: 16,
      title: Row(
        children: [
          Flexible(
            child: Text(
              instance.label,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          if (isDefaultChoice) ...[
            const SizedBox(width: 6),
            _AgentPill(
              label: '默认',
              background: colors.surfaceRaised,
              foreground: colors.foreground,
            ),
          ] else if (instance.isDefault) ...[
            const SizedBox(width: 6),
            _AgentPill(
              label: '内置',
              background: colors.field,
              foreground: colors.muted,
            ),
          ],
        ],
      ),
      subtitle: Text(
        _statusSubtitle(agent, instance),
        maxLines: 2,
        overflow: TextOverflow.ellipsis,
        style: TimelineType.metaStyle(colors.muted),
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (canToggle)
            Switch.adaptive(
              key: AgentManageScreen.toggleKey(instance.instanceId),
              value: instance.enabled,
              onChanged: _connection == null || _updating
                  ? null
                  : (next) => unawaited(_toggleInstance(instance, next)),
            ),
          Icon(Icons.chevron_right, size: 18, color: colors.faint),
        ],
      ),
      onTap: _connection == null
          ? null
          : () => unawaited(_openEditor(agent, instance: instance)),
    );
  }
}

class _AgentCard extends StatelessWidget {
  const _AgentCard({required this.children});

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

class _AgentPill extends StatelessWidget {
  const _AgentPill({
    required this.label,
    required this.background,
    required this.foreground,
  });

  final String label;
  final Color background;
  final Color foreground;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
    decoration: BoxDecoration(
      color: background,
      borderRadius: BorderRadius.circular(5),
    ),
    child: Text(label, style: TimelineType.microStyle(foreground)),
  );
}
