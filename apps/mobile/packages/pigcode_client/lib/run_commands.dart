import 'command_models.dart';
import 'host_rpc.dart';

class MobileRunCommands {
  MobileRunCommands(this._rpc);

  final HostRequests _rpc;

  Future<MobileRunReceipt> start(MobileStartRunParams params) => _send(
    MobileRunMethod.runStart,
    params.commandId,
    params.threadId,
    params.toJson(),
  );

  Future<MobileRunReceipt> interrupt(MobileInterruptRunParams params) => _send(
    MobileRunMethod.runInterrupt,
    params.commandId,
    params.threadId,
    params.toJson(),
  );

  Future<MobileRunReceipt?> receipt(String commandId) async {
    final result = await _rpc.call(
      MobileCommandMethods.receipt,
      MobileReceiptParams(commandId: commandId).toJson(),
    );
    final receipt = MobileReceiptResult.fromJson(
      result as Map<String, dynamic>,
    ).receipt;
    if (receipt != null && receipt.commandId != commandId) {
      throw const FormatException('Receipt does not belong to this command');
    }
    return receipt;
  }

  Future<MobileRunReceipt> _send(
    MobileRunMethod method,
    String commandId,
    String threadId,
    Map<String, Object?> params,
  ) async {
    final result = await _rpc.call(method.wire, params);
    final receipt = MobileRunReceipt.fromJson(result as Map<String, dynamic>);
    if (receipt.method != method ||
        receipt.commandId != commandId ||
        receipt.threadId != threadId) {
      throw const FormatException('Receipt does not belong to this command');
    }
    return receipt;
  }
}
