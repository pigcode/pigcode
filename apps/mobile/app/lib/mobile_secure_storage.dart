import 'package:flutter_secure_storage/flutter_secure_storage.dart';

const mobileSecureStorage = FlutterSecureStorage(
  iOptions: IOSOptions(
    accessibility: KeychainAccessibility.unlocked_this_device,
  ),
);
