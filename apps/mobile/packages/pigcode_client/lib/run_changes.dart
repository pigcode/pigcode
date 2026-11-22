import 'host_rpc.dart';
import 'run_change_models.dart';

class MobileRunChanges {
  MobileRunChanges(this._rpc);

  final HostRequests _rpc;

  Future<MobileRunChangesPage> list(MobileRunChangesParams params) async {
    final result = await _rpc.call(
      MobileRunChangesMethods.list,
      params.toJson(),
    );
    return MobileRunChangesPage.fromJson(result as Map<String, dynamic>);
  }

  Future<MobileRunDiffPage> diff(MobileRunDiffParams params) async {
    final result = await _rpc.call(
      MobileRunChangesMethods.diff,
      params.toJson(),
    );
    return MobileRunDiffPage.fromJson(result as Map<String, dynamic>);
  }
}
