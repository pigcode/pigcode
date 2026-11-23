import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:pigcode_client/pigcode_client.dart';

import 'mobile_reminders.dart';

class ReminderSettingsPage extends StatefulWidget {
  const ReminderSettingsPage({
    super.key,
    required this.bridge,
    required this.settings,
    required this.onChanged,
  });

  final MobileReminderBridge bridge;
  final ValueListenable<MobileReminderSettings?> settings;
  final ValueChanged<MobileReminderSettings> onChanged;

  @override
  State<ReminderSettingsPage> createState() => _ReminderSettingsPageState();
}

class _ReminderSettingsPageState extends State<ReminderSettingsPage>
    with WidgetsBindingObserver {
  bool _working = false;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _read(widget.bridge.settings);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _read(widget.bridge.settings);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  Future<void> _openSystemSettings() async {
    try {
      await widget.bridge.openSystemSettings();
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    }
  }

  Future<void> _read(Future<MobileReminderSettings> Function() action) async {
    if (_working) return;
    setState(() {
      _working = true;
      _failed = false;
    });
    try {
      final settings = await action();
      if (!mounted) return;
      widget.onChanged(settings);
    } catch (_) {
      if (mounted) setState(() => _failed = true);
    } finally {
      if (mounted) setState(() => _working = false);
    }
  }

  @override
  Widget build(BuildContext context) => ValueListenableBuilder(
    valueListenable: widget.settings,
    builder: (context, settings, _) => Scaffold(
      appBar: AppBar(title: const Text('通知设置')),
      body: SafeArea(
        top: false,
        child: ListView(
          children: [
            if (_failed)
              ListTile(
                title: const Text('通知设置暂不可用'),
                trailing: TextButton(
                  onPressed: _working
                      ? null
                      : () => _read(widget.bridge.settings),
                  child: const Text('重试'),
                ),
              ),
            if (settings != null) ...[
              SwitchListTile(
                title: const Text('手机提醒'),
                value: settings.enabled,
                onChanged: _working
                    ? null
                    : (enabled) =>
                          _read(() => widget.bridge.setEnabled(enabled)),
              ),
              ListTile(
                title: const Text('系统通知授权'),
                subtitle: Text(switch (settings.permission) {
                  MobileReminderPermission.granted => '已授权',
                  MobileReminderPermission.denied => '未授权，可在系统设置中修改',
                  MobileReminderPermission.undetermined => '未选择',
                }),
                trailing: switch (settings.permission) {
                  MobileReminderPermission.granted => null,
                  MobileReminderPermission.denied => TextButton(
                    onPressed: _working ? null : _openSystemSettings,
                    child: const Text('打开系统设置'),
                  ),
                  MobileReminderPermission.undetermined => TextButton(
                    onPressed: _working
                        ? null
                        : () => _read(widget.bridge.requestPermission),
                    child: const Text('申请授权'),
                  ),
                },
              ),
              ListTile(
                title: const Text('推送登记'),
                subtitle: Text(switch (settings.apns?.environment) {
                  ApnsEnvironment.production => '已取得正式环境设备令牌',
                  ApnsEnvironment.sandbox => '已取得开发环境设备令牌',
                  null => '未登记',
                }),
              ),
            ],
          ],
        ),
      ),
    ),
  );
}
