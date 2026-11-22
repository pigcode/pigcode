import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:mobile_scanner/mobile_scanner.dart';
import 'package:pigcode_client/pigcode_client.dart';
import 'package:pigcode_transport/pigcode_transport.dart';

import 'computers.dart';
import 'theme_colors.dart';

const _version = String.fromEnvironment('PIGCODE_PRODUCT_VERSION');

void main() {
  runApp(const ProviderScope(child: PigcodeApp()));
}

class PigcodeApp extends StatelessWidget {
  const PigcodeApp({super.key});

  ThemeData _theme(Brightness brightness) {
    final colors = brightness == Brightness.dark ? pigcodeDark : pigcodeLight;
    final scheme = ColorScheme(
      brightness: brightness,
      primary: colors.primary,
      onPrimary: colors.onPrimary,
      secondary: colors.primary,
      onSecondary: colors.onPrimary,
      error: colors.error,
      onError: colors.onError,
      surface: colors.surface,
      onSurface: colors.foreground,
      onSurfaceVariant: colors.secondaryText,
      outlineVariant: colors.divider,
    );
    final theme = ThemeData(
      colorScheme: scheme,
      scaffoldBackgroundColor: colors.background,
      cardTheme: CardThemeData(color: colors.surface),
      listTileTheme: ListTileThemeData(selectedTileColor: colors.selected),
      visualDensity: VisualDensity.standard,
    );
    final text = theme.textTheme;
    const body = TextStyle(
      fontSize: 15,
      height: 1.45,
      fontWeight: FontWeight.w400,
    );
    return theme.copyWith(
      textTheme: text.copyWith(
        bodyLarge: text.bodyLarge?.merge(body),
        bodyMedium: text.bodyMedium?.merge(body),
        labelLarge: text.labelLarge?.copyWith(fontWeight: FontWeight.w500),
      ),
    );
  }

  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Pigcode',
    debugShowCheckedModeBanner: false,
    theme: _theme(Brightness.light),
    darkTheme: _theme(Brightness.dark),
    home: const ComputersPage(),
  );
}

class ComputersPage extends ConsumerStatefulWidget {
  const ComputersPage({super.key});

  @override
  ConsumerState<ComputersPage> createState() => _ComputersPageState();
}

class _ComputersPageState extends ConsumerState<ComputersPage> {
  MobileConnection? _connection;
  String? _selected;
  String? _verification;
  String? _feedback;
  bool _working = false;

  Future<void> _choose(
    ComputerProfile computer, {
    PairingInvite? invite,
  }) async {
    if (_working) return;
    setState(() {
      _working = true;
      _verification = null;
      _feedback = null;
      _selected = null;
    });
    final previous = _connection;
    _connection = null;
    MobileConnection? opened;
    try {
      await previous?.close();
      if (!mounted) return;
      final computers = ref.read(computersProvider.notifier);
      if (invite == null) {
        opened = await MobileConnection.resume(computer, computers.identity);
      } else {
        opened = await MobileConnection.pair(
          invite: invite,
          identity: computers.identity,
          deviceName: Platform.isIOS ? 'iPhone' : 'Android 手机',
          platform: Platform.isIOS ? 'ios' : 'android',
          showVerificationCode: (code) {
            if (mounted) setState(() => _verification = code);
          },
        );
        if (mounted) await computers.remember(computer);
      }
      if (!mounted) return;
      final connected = opened;
      _connection = connected;
      setState(() => _selected = computer.computerKey);
      unawaited(
        connected.done.then(
          (_) => _connectionEnded(connected),
          onError: (Object _) => _connectionEnded(connected),
        ),
      );
    } on ConnectionFailure catch (failure) {
      if (mounted) setState(() => _feedback = _message(failure.code));
    } catch (_) {
      if (mounted) setState(() => _feedback = '无法完成连接，请重试。');
    } finally {
      if (opened != null && !identical(_connection, opened)) {
        await opened.close();
      }
      if (mounted) {
        setState(() {
          _working = false;
          _verification = null;
        });
      }
    }
  }

  void _connectionEnded(MobileConnection ended) {
    if (!mounted || !identical(_connection, ended)) return;
    unawaited(ended.close());
    setState(() {
      _connection = null;
      _selected = null;
      _feedback = '电脑连接已断开，请重新连接。';
    });
  }

  String _message(String code) => switch (code) {
    'expired' => '二维码已过期，请在电脑重新生成。',
    'offline' => '这台电脑未连接中继。',
    'unreachable' => '连不上中继，请检查网络。',
    'token-rejected' => '中继拒绝了访问令牌，请重新扫码。',
    'update-phone' => '请更新 Pigcode 手机端后重新连接。',
    'update-desktop' => '请更新这台电脑上的 Pigcode 后重新连接。',
    'incompatible' => '连接协议不兼容，请检查两端和中继的版本。',
    'busy' => '电脑的手机连接已满，请稍后重试。',
    'authentication-failed' => '电脑或设备身份验证失败，请检查配对。',
    _ => '连接已关闭。请确认电脑上的配对未取消。',
  };

  Future<void> _scan() async {
    final qr = await Navigator.of(
      context,
    ).push<String>(MaterialPageRoute(builder: (_) => const ScanPage()));
    if (!mounted || qr == null) return;
    try {
      final invite = PairingInvite.parse(qr);
      await _choose(invite.computer, invite: invite);
    } on ConnectionFailure catch (failure) {
      setState(() => _feedback = _message(failure.code));
    } catch (_) {
      setState(() => _feedback = '这个二维码无法用于 Pigcode 配对。');
    }
  }

  @override
  void dispose() {
    final connection = _connection;
    _connection = null;
    if (connection != null) unawaited(connection.close());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final computers = ref.watch(computersProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('电脑')),
      body: SafeArea(
        top: false,
        child: computers.when(
          loading: () =>
              const Center(child: CircularProgressIndicator.adaptive()),
          error: (_, _) => Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                const Text('无法读取系统凭据存储。'),
                TextButton(
                  onPressed: () => ref.invalidate(computersProvider),
                  child: const Text('重试'),
                ),
              ],
            ),
          ),
          data: (entries) => ListView(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 20),
            children: [
              if (entries.isEmpty)
                const Padding(
                  padding: EdgeInsets.symmetric(vertical: 16),
                  child: Text('在电脑打开「设置 → 手机连接」，生成二维码后用手机扫描。'),
                ),
              for (final entry in entries)
                ListTile(
                  key: ValueKey(entry.computerKey),
                  leading: const Icon(Icons.computer_outlined),
                  title: Text(entry.name),
                  subtitle: Text(
                    _selected == entry.computerKey ? '已连接' : '点按连接',
                  ),
                  selected: _selected == entry.computerKey,
                  enabled: !_working,
                  onTap: () => unawaited(_choose(entry)),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(12),
                  ),
                ),
              const SizedBox(height: 12),
              if (_verification case final code?)
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(16),
                    child: Semantics(
                      liveRegion: true,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text('核对电脑上显示的数字，在电脑点允许。'),
                          const SizedBox(height: 8),
                          Text(
                            code,
                            style: Theme.of(context).textTheme.headlineMedium,
                          ),
                        ],
                      ),
                    ),
                  ),
                )
              else if (_working)
                const LinearProgressIndicator(),
              if (_feedback case final feedback?)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 12),
                  child: Semantics(liveRegion: true, child: Text(feedback)),
                ),
              Align(
                alignment: Alignment.centerLeft,
                child: FilledButton.icon(
                  onPressed: _working ? null : _scan,
                  icon: const Icon(Icons.qr_code_scanner),
                  label: const Text('扫码配对电脑'),
                  style: FilledButton.styleFrom(minimumSize: const Size(0, 50)),
                ),
              ),
              if (_version.isNotEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: 16),
                  child: Text(
                    'Pigcode $_version',
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class ScanPage extends StatefulWidget {
  const ScanPage({super.key});
  @override
  State<ScanPage> createState() => _ScanPageState();
}

class _ScanPageState extends State<ScanPage> {
  final _scanner = MobileScannerController(formats: [BarcodeFormat.qrCode]);
  bool _finished = false;

  @override
  void dispose() {
    unawaited(_scanner.dispose());
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('扫描电脑上的二维码')),
    body: SafeArea(
      child: MobileScanner(
        controller: _scanner,
        errorBuilder: (_, _) => const Center(
          child: Padding(
            padding: EdgeInsets.all(16),
            child: Text('相机不可用。请在系统设置允许 Pigcode 使用相机。'),
          ),
        ),
        onDetect: (capture) {
          if (_finished) return;
          for (final barcode in capture.barcodes) {
            final text = barcode.rawValue;
            if (text == null) continue;
            _finished = true;
            Navigator.of(context).pop(text);
            break;
          }
        },
      ),
    ),
  );
}
