#!/usr/bin/env bash
set -euo pipefail

app_root="${1:-.}"
app_json_path="$app_root/app.json"
target_name="SNAPEBTGroceryTrackerQA"
plist_path="$app_root/ios/$target_name/Info.plist"
privacy_manifest_path="$app_root/ios/$target_name/PrivacyInfo.xcprivacy"
project_path="$app_root/ios/$target_name.xcodeproj"
skad_ids_path="$app_root/ios/skadnetwork-ids.txt"
icon_b64_path="$app_root/assets/app-icon.png.base64"
asset_root="$app_root/ios/$target_name/Images.xcassets"
plist_buddy="/usr/libexec/PlistBuddy"

production_publisher_id="8054612600809568"
production_app_id="ca-app-pub-8054612600809568~1748518282"
production_banner_id="ca-app-pub-8054612600809568/3872496047"

if [[ "${EXPO_PUBLIC_AD_PROFILE:-}" != "production" ]] ||
  [[ "${EXPO_PUBLIC_ADMOB_PUBLISHER_ID:-}" != "$production_publisher_id" ]] ||
  [[ "${EXPO_PUBLIC_IOS_ADMOB_APP_ID:-}" != "$production_app_id" ]] ||
  [[ "${EXPO_PUBLIC_IOS_ADMOB_BANNER_ID:-}" != "$production_banner_id" ]]; then
  echo "Production AdMob environment does not match the reviewed live identifiers." >&2
  exit 1
fi

if [[ "$production_publisher_id" == "3940256099942544" ]] ||
  [[ "$production_app_id" == *"3940256099942544"* ]] ||
  [[ "$production_banner_id" == *"3940256099942544"* ]] ||
  [[ ! "$production_publisher_id" =~ ^[0-9]{16}$ ]] ||
  [[ ! "$production_app_id" =~ ^ca-app-pub-([0-9]{16})~([0-9]{10})$ ]] ||
  [[ ! "$production_banner_id" =~ ^ca-app-pub-([0-9]{16})/([0-9]{10})$ ]] ||
  [[ "$production_app_id" != "ca-app-pub-$production_publisher_id~"* ]] ||
  [[ "$production_banner_id" != "ca-app-pub-$production_publisher_id/"* ]]; then
  echo "Production AdMob identifiers are malformed, demo-owned, or publisher-mismatched." >&2
  exit 1
fi

if [[ ! -f "$app_json_path" || ! -f "$plist_path" || ! -f "$privacy_manifest_path" || ! -f "$skad_ids_path" || ! -f "$icon_b64_path" ]]; then
  echo "Required iOS production-release inputs are missing." >&2
  exit 1
fi

# Normalize the reviewed StoreKit config plugin and remove the obsolete
# react-native-iap plugin from the frozen source.
node - "$app_json_path" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const document = JSON.parse(fs.readFileSync(path, "utf8"));
if (!document?.expo) throw new Error("app.json expo is missing");
document.expo.name = "Grocery Benefits Tracker";
const plugins = document.expo.plugins;
if (!Array.isArray(plugins)) throw new Error("app.json expo.plugins is missing");
document.expo.plugins = plugins.filter((plugin) => {
  const name = Array.isArray(plugin) ? plugin[0] : plugin;
  return name !== "expo-iap" && name !== "react-native-iap";
});
document.expo.plugins.push("expo-iap");
fs.writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
NODE

if ! grep -Fq '"name": "Grocery Benefits Tracker"' "$app_json_path"; then
  echo "The public Expo app name is not generic." >&2
  exit 1
fi

if [[ "$(grep -Fc '"expo-iap"' "$app_json_path")" != "1" ]] ||
  grep -Fq 'react-native-iap' "$app_json_path"; then
  echo "The reviewed expo-iap plugin configuration is invalid." >&2
  exit 1
fi

# This archive is assembled without Expo prebuild, so record the iOS
# In-App Purchase capability directly on the existing Xcode target.
ruby -rxcodeproj - "$project_path/project.pbxproj" "$target_name" <<'RUBY'
project_file, target_name = ARGV
project = Xcodeproj::Project.open(File.dirname(project_file))
target = project.targets.find { |candidate| candidate.name == target_name }
raise "Missing Xcode target #{target_name}" unless target
attributes = project.root_object.attributes
target_attributes = attributes["TargetAttributes"] ||= {}
entry = target_attributes[target.uuid] ||= {}
capabilities = entry["SystemCapabilities"] ||= {}
capabilities["com.apple.InAppPurchase"] = { "enabled" => 1 }
project.save
RUBY

grep -Fq 'com.apple.InAppPurchase' "$project_path/project.pbxproj"

"$plist_buddy" -c "Set :CFBundleDisplayName Grocery Benefits Tracker" "$plist_path"
"$plist_buddy" -c "Set :CFBundleName Grocery Benefits Tracker" "$plist_path"
"$plist_buddy" -c "Set :GADApplicationIdentifier $production_app_id" "$plist_path"
"$plist_buddy" -c "Delete :GADDelayAppMeasurementInit" "$plist_path" 2>/dev/null || true
"$plist_buddy" -c "Add :GADDelayAppMeasurementInit bool true" "$plist_path"
"$plist_buddy" -c "Delete :GBTAdMobBuildProfile" "$plist_path" 2>/dev/null || true
"$plist_buddy" -c "Add :GBTAdMobBuildProfile string production" "$plist_path"
# Never permit QA test-device IDs to leak into an App Store build.
"$plist_buddy" -c "Delete :GBTAdMobTestDeviceIdentifiers" "$plist_path" 2>/dev/null || true
"$plist_buddy" -c "Add :GBTAdMobTestDeviceIdentifiers array" "$plist_path"
"$plist_buddy" -c "Delete :NSUserTrackingUsageDescription" "$plist_path" 2>/dev/null || true
"$plist_buddy" -c "Add :NSUserTrackingUsageDescription string Your permission allows this app and its advertising partners to use a device identifier to measure non-personalized ads. Denying permission does not limit app features." "$plist_path"
"$plist_buddy" -c "Delete :NSPrivacyTracking" "$privacy_manifest_path" 2>/dev/null || true
"$plist_buddy" -c "Add :NSPrivacyTracking bool false" "$privacy_manifest_path"
"$plist_buddy" -c "Delete :NSPrivacyTrackingDomains" "$privacy_manifest_path" 2>/dev/null || true
"$plist_buddy" -c "Delete :NSPrivacyCollectedDataTypes" "$privacy_manifest_path" 2>/dev/null || true
if [[ "$("$plist_buddy" -c "Print :NSPrivacyTracking" "$privacy_manifest_path")" != "false" ]] ||
  "$plist_buddy" -c "Print :NSPrivacyTrackingDomains" "$privacy_manifest_path" >/dev/null 2>&1 ||
  "$plist_buddy" -c "Print :NSPrivacyCollectedDataTypes" "$privacy_manifest_path" >/dev/null 2>&1; then
  echo "The app-owned privacy manifest must not duplicate Google SDK tracking or collection declarations." >&2
  exit 1
fi
"$plist_buddy" -c "Delete :WKAppBoundDomains" "$plist_path" 2>/dev/null || true
"$plist_buddy" -c "Delete :SKAdNetworkItems" "$plist_path" 2>/dev/null || true
"$plist_buddy" -c "Add :SKAdNetworkItems array" "$plist_path"

skad_index=0
while IFS= read -r skad_id; do
  [[ -n "$skad_id" ]] || continue
  "$plist_buddy" -c "Add :SKAdNetworkItems:$skad_index dict" "$plist_path"
  "$plist_buddy" -c "Add :SKAdNetworkItems:$skad_index:SKAdNetworkIdentifier string $skad_id" "$plist_path"
  skad_index=$((skad_index + 1))
done < "$skad_ids_path"

decoded_icon="$RUNNER_TEMP/snap-ebt-wic-app-icon.png"
/usr/bin/base64 -D < "$icon_b64_path" > "$decoded_icon"
/usr/bin/sips -s format png "$decoded_icon" \
  --out "$app_root/assets/icon.png" >/dev/null
/usr/bin/sips -s format png "$decoded_icon" \
  --out "$app_root/assets/splash-icon.png" >/dev/null
/usr/bin/sips -s format png "$decoded_icon" \
  --out "$asset_root/AppIcon.appiconset/App-Icon-1024x1024@1x.png" >/dev/null
/usr/bin/sips -z 176 176 "$decoded_icon" \
  --out "$asset_root/SplashScreenLogo.imageset/image.png" >/dev/null
/usr/bin/sips -z 352 352 "$decoded_icon" \
  --out "$asset_root/SplashScreenLogo.imageset/image@2x.png" >/dev/null
/usr/bin/sips -z 528 528 "$decoded_icon" \
  --out "$asset_root/SplashScreenLogo.imageset/image@3x.png" >/dev/null

echo "Configured StoreKit IAP, generic bundle identity, delayed Google measurement, localized ATT disclosure, app-owned non-tracking privacy manifest, reviewed production AdMob app ID, zero production AdMob test-device IDs, $skad_index SKAdNetwork IDs, and release artwork."
