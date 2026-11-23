import 'dart:convert';

import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

final mobileReminderBridgeProvider = Provider<MobileReminderBridge>(
  (_) => const MobileReminderBridge(),
);

class MobileReminderBridge {
  const MobileReminderBridge();

  static const _channel = MethodChannel('pigcode/mobile-reminders');

  void watchTaps(VoidCallback? received) {
    _channel.setMethodCallHandler(
      received == null
          ? null
          : (call) async {
              if (call.method == 'tapReady') received();
            },
    );
  }

  Future<MobileReminder?> takeTap() async {
    try {
      final data = await _channel.invokeMapMethod<String, dynamic>('takeTap');
      return data == null ? null : MobileReminder.fromJson(data);
    } on Exception {
      return null;
    } on TypeError {
      return null;
    }
  }

  Future<MobileReminderSettings> settings() => _settings('settings');
  Future<MobileReminderSettings> requestPermission() =>
      _settings('requestPermission');
  Future<MobileReminderSettings> setEnabled(bool enabled) =>
      _settings('setEnabled', enabled);

  Future<void> openSystemSettings() =>
      _channel.invokeMethod<void>('openSystemSettings');

  Future<MobileReminderSettings> _settings(
    String method, [
    Object? arguments,
  ]) async {
    try {
      final data = (await _channel.invokeMapMethod<String, dynamic>(
        method,
        arguments,
      ))!;
      return MobileReminderSettings.fromJson(data);
    } on MissingPluginException {
      return const MobileReminderSettings(
        enabled: true,
        permission: MobileReminderPermission.undetermined,
      );
    }
  }

  Future<void> setVisible(String? computerId, String? threadId) async {
    try {
      await _channel.invokeMethod<void>('setVisible', {
        'computerId': computerId,
        'threadId': threadId,
      });
    } on MissingPluginException {
      // This app surface is only available on the native phone platforms.
    }
  }
}

Future<String> reminderComputerId(ComputerProfile computer) =>
    publicKeyFingerprint(
      base64Url.decode(base64Url.normalize(computer.computerKey)),
    );

Future<ComputerProfile?> findReminderComputer(
  MobileReminder reminder,
  List<ComputerProfile> computers,
) async {
  for (final computer in computers) {
    if (await reminderComputerId(computer) == reminder.computerId) {
      return computer;
    }
  }
  return null;
}
