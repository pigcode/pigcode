import 'command_models.dart';
import 'host_rpc.dart';
import 'queue_models.dart';

class MobileQueueCommands {
  MobileQueueCommands(this._rpc);

  final HostRequests _rpc;

  Future<QueueSnapshot> snapshot(String threadId) async {
    final result = await _rpc.call(QueueMethods.get, {'threadId': threadId});
    final snapshot = QueueSnapshot.fromJson(result as Map<String, dynamic>);
    if (snapshot.threadId != threadId) {
      throw const FormatException('Unexpected queue');
    }
    return snapshot;
  }

  Future<QueueReceipt> submit(
    QueueMethod method,
    Map<String, Object?> params,
  ) async {
    final result = await _rpc.call(method.wire, params);
    final receipt = QueueReceipt.fromJson(result as Map<String, dynamic>);
    if (receipt.commandId != params['commandId'] ||
        receipt.threadId != params['threadId'] ||
        receipt.method != method) {
      throw const FormatException('Unexpected queue receipt');
    }
    return receipt;
  }

  Future<QueueReceipt?> receipt(String commandId) async {
    final value = await _rpc.call(
      MobileCommandMethods.receipt,
      MobileReceiptParams(commandId: commandId).toJson(),
    );
    final receipt = QueueReceiptResult.fromJson(
      value as Map<String, dynamic>,
    ).receipt;
    if (receipt != null && receipt.commandId != commandId) {
      throw const FormatException('Unexpected queue receipt');
    }
    return receipt;
  }
}
