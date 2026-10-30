"""Read-only gate against a freshly pulled phone APK; never installs anything."""
import argparse
import importlib.util
import json
from pathlib import Path

TOOL = Path(r"C:\Users\DELL\AppData\Local\Temp\opencode\delivery-native-20261029\verify-update.py")
spec = importlib.util.spec_from_file_location("qa_compatibility", TOOL)
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--installed", type=Path, required=True)
parser.add_argument("--candidate", type=Path, required=True)
parser.add_argument("--web-dir", type=Path, required=True)
parser.add_argument("--output", type=Path, required=True)
parser.add_argument("--expected-installed-sha256", default="71bbbfe8c431330a981e2a13473c15b117b5898b5bd924f40db91351e67e312e", choices=[
    "71bbbfe8c431330a981e2a13473c15b117b5898b5bd924f40db91351e67e312e",
    "b847f4d4ccb128125040a593d017b02f1e2752ccddbb0ae1927f96b7e12d7a47",
    "d61afb91dff7483c3307ce67306eb9f29e9ca5c60df1a8e07cdc24fc3fc8cd12",
    "035f65964391ac73f8ab84a5b8daf5a35dcb7f3147422a937f32a61dbb098f1a",
    "78fcda40841eb6ddb778af05f910a0aeeb065e31e0529a51f77333c9b1b9ae66",
    "c0448c3234c031cd9a25b68b96f799d5f26ec25533b9660353f1cee19d36499b",
])
args = parser.parse_args()

before = qa.inspect(args.installed.resolve(strict=True))
after = qa.inspect(args.candidate.resolve(strict=True))
if before["sha256"] != args.expected_installed_sha256:
    raise SystemExit("Phone APK differs from the last scoped baseline; reconcile ownership before updating")
if before["package"] != "com.burgonomics" or after["package"] != before["package"]:
    raise SystemExit("Package mismatch")
if before["signers"] != after["signers"] or not before["signatureVerified"] or not after["signatureVerified"]:
    raise SystemExit("Signature/signer mismatch")
if not before["debuggable"] or not after["debuggable"] or after["versionCode"] < before["versionCode"]:
    raise SystemExit("Non-debug APK or downgrade refused")
report = qa.verify(args.candidate.resolve(strict=True), args.web_dir.resolve(strict=True))
report.update({
    "freshInstalled": before, "targetDevice": "RZCX51TXRKB",
    "freshInstalledPath": str(args.installed.resolve()),
    "scope": "Compatible data-preserving debug update only; no uninstall/clear/downgrade",
})
with args.output.open("x", encoding="utf-8") as stream:
    json.dump(report, stream, indent=2)
print(json.dumps(report, indent=2))
