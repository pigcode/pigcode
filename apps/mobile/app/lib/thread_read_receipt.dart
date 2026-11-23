import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:pigcode_client/pigcode_client.dart';

/// Sends a receipt after the live result's frame is visible in the foreground.
class ThreadReadReceipt extends StatefulWidget {
  const ThreadReadReceipt({
    super.key,
    required this.visible,
    required this.shownRunId,
    required this.target,
    this.manualUnread,
    this.connection,
    required this.unread,
    required this.visit,
    required this.confirm,
    required this.child,
  });

  final bool visible;
  final String? shownRunId;
  final MobileThreadReadTarget? target;
  final MobileThreadReadTarget? manualUnread;
  final Object? connection;
  final bool unread;
  final int visit;
  final Future<void> Function(MobileThreadReadTarget)? confirm;
  final Widget child;

  @override
  State<ThreadReadReceipt> createState() => _ThreadReadReceiptState();
}

class _ThreadReadReceiptState extends State<ThreadReadReceipt>
    with WidgetsBindingObserver {
  MobileThreadReadTarget? _viewed;
  Object? _attempt;
  bool _retried = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didUpdateWidget(covariant ThreadReadReceipt oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.visit != widget.visit) {
      _viewed = null;
      _attempt = null;
      _retried = false;
    }
    if (!identical(oldWidget.connection, widget.connection)) {
      _attempt = null;
      _retried = false;
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) setState(() {});
  }

  void _report() {
    final runId = widget.shownRunId;
    final target = widget.target;
    final confirm = widget.confirm;
    if (!widget.visible ||
        runId == null ||
        confirm == null ||
        WidgetsBinding.instance.lifecycleState != AppLifecycleState.resumed) {
      return;
    }
    if (_viewed?.runId != runId) {
      final manualUnread = widget.manualUnread;
      _viewed = MobileThreadReadTarget(
        runId: runId,
        revision: manualUnread?.runId == runId ? manualUnread!.revision : 0,
      );
      _attempt = null;
      _retried = false;
    }
    if (!widget.unread ||
        target?.runId != runId ||
        _viewed?.revision != target!.revision ||
        _attempt != null) {
      return;
    }
    final attempt = Object();
    _attempt = attempt;
    unawaited(
      confirm(target).catchError((Object error) {
        if (mounted &&
            identical(_attempt, attempt) &&
            error is TimeoutException &&
            !_retried) {
          setState(() {
            _retried = true;
            _attempt = null;
          });
        }
      }),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (widget.visible && widget.shownRunId != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _report();
      });
    }
    return widget.child;
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }
}
