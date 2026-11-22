import 'package:pigcode_client/pigcode_client.dart';

import 'mobile_command_journal.dart';

sealed class PendingRunCommand implements JournalCommand {
  const PendingRunCommand();

  MobileRunMethod get method;
  @override
  String get slot => method.name;
  @override
  String get commandId;
  String get threadId;
  @override
  Map<String, Object?> toJson();
  Future<MobileRunReceipt> sendVia(MobileRunCommands api);

  bool matches(MobileRunReceipt receipt) =>
      receipt.commandId == commandId &&
      receipt.method == method &&
      receipt.threadId == threadId;

  static PendingRunCommand decode(String slot, Map<String, dynamic> data) {
    final method = MobileRunMethod.values.byName(slot);
    return switch (method) {
      MobileRunMethod.runStart => PendingSend(
        MobileStartRunParams.fromJson(data),
      ),
      MobileRunMethod.runInterrupt => PendingStop(
        MobileInterruptRunParams.fromJson(data),
      ),
    };
  }
}

final class PendingSend extends PendingRunCommand {
  const PendingSend(this.params);

  final MobileStartRunParams params;

  @override
  MobileRunMethod get method => MobileRunMethod.runStart;
  @override
  String get commandId => params.commandId;
  @override
  String get threadId => params.threadId;
  @override
  Map<String, Object?> toJson() => params.toJson();
  @override
  Future<MobileRunReceipt> sendVia(MobileRunCommands api) => api.start(params);
}

final class PendingStop extends PendingRunCommand {
  const PendingStop(this.params);

  final MobileInterruptRunParams params;

  @override
  MobileRunMethod get method => MobileRunMethod.runInterrupt;
  @override
  String get commandId => params.commandId;
  @override
  String get threadId => params.threadId;
  @override
  Map<String, Object?> toJson() => params.toJson();
  @override
  Future<MobileRunReceipt> sendVia(MobileRunCommands api) =>
      api.interrupt(params);
  @override
  bool matches(MobileRunReceipt receipt) =>
      super.matches(receipt) && receipt.runId == params.runId;
}

class RunCommandJournal {
  RunCommandJournal(MobileConnection connection, String threadId)
    : _journal = MobileCommandJournal(
        connection,
        threadId,
        PendingRunCommand.decode,
      );

  final MobileCommandJournal<PendingRunCommand> _journal;

  Future<PendingRunCommand?> read(MobileRunMethod method) =>
      _journal.read(method.name);

  Future<PendingRunCommand> reserve(PendingRunCommand command) =>
      _journal.reserve(command);

  Future<void> remove(
    PendingRunCommand command, {
    required bool Function() mounted,
    Future<void> Function()? beforeRemove,
  }) => _journal.remove(command, mounted: mounted, beforeRemove: beforeRemove);
}
