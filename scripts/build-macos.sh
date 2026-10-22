#!/bin/bash
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
interface_dir="$project_root/macos/Web"
build_dir="$project_root/.build/macos"
output_dir="$project_root/dist"
app_bundle="$output_dir/糖果磁链.app"
architecture="$(uname -m)"
sdk_path="$(xcrun --sdk macosx --show-sdk-path)"

mkdir -p "$build_dir" "$app_bundle/Contents/MacOS" "$app_bundle/Contents/Resources/Web/assets"

xcrun --sdk macosx swiftc -O -swift-version 5 -parse-as-library \
  -sdk "$sdk_path" -target "$architecture-apple-macosx12.0" \
  -framework AppKit -framework WebKit -framework Network -lsqlite3 \
  "$project_root/macos/CandyMagnet.swift" "$project_root/macos/LocalAssetServer.swift" "$project_root/macos/HistoryStore.swift" \
  -o "$app_bundle/Contents/MacOS/CandyMagnet"

xcrun --sdk macosx swiftc -O -swift-version 5 -sdk "$sdk_path" \
  "$project_root/macos/GenerateIcon.swift" -o "$build_dir/generate-icon"
"$build_dir/generate-icon" "$build_dir/CandyMagnet.iconset"
iconutil --convert icns "$build_dir/CandyMagnet.iconset" --output "$app_bundle/Contents/Resources/CandyMagnet.icns"

cp "$project_root/macos/Info.plist" "$app_bundle/Contents/Info.plist"
for asset in index.html styles.css app.js torrent.js converter-worker.js history.html history.css history.js history-store.js; do
  cp "$interface_dir/$asset" "$app_bundle/Contents/Resources/Web/$asset"
done
cp "$interface_dir/assets/zenicon.woff" "$app_bundle/Contents/Resources/Web/assets/zenicon.woff"
printf 'APPL????' > "$app_bundle/Contents/PkgInfo"
chmod +x "$app_bundle/Contents/MacOS/CandyMagnet"

# Finder metadata inherited by copied resources cannot be sealed by codesign.
# Clear only these two attributes from the newly generated application bundle.
xattr -dr com.apple.FinderInfo "$app_bundle" 2>/dev/null || true
xattr -dr com.apple.ResourceFork "$app_bundle" 2>/dev/null || true

# Ad-hoc signing is part of producing a locally launchable Apple Silicon bundle.
# No certificate, Apple account, notarization, or network request is involved.
codesign --force --sign - "$app_bundle"
ditto -c -k --sequesterRsrc --keepParent "$app_bundle" "$output_dir/糖果磁链-macOS-$architecture.zip"
printf '\n已生成：%s\n' "$app_bundle"
printf '压缩包：%s\n' "$output_dir/糖果磁链-macOS-$architecture.zip"
