#!/bin/sh
# Runs the app in the background on this Mac: starts at login, restarts if it crashes.
# Undo with: launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.ration-app.plist
set -e
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "Node.js not found. Install it with: brew install node"; exit 1; }

case "$APP_DIR" in
  "$HOME/Desktop"*|"$HOME/Documents"*|"$HOME/Downloads"*)
    echo "macOS doesn't let background apps read Desktop, Documents or Downloads."
    echo "Move the folder first, then run this again:"
    echo "  mv \"$APP_DIR\" ~/ration-app && ~/ration-app/scripts/install-mac-service.sh"
    exit 1 ;;
esac

PLIST="$HOME/Library/LaunchAgents/com.ration-app.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$APP_DIR/data"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.ration-app</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>--env-file-if-exists=.env</string>
    <string>server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$APP_DIR/data/server.log</string>
  <key>StandardErrorPath</key><string>$APP_DIR/data/server.log</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 1
echo "Installed and running. Addresses and logs: $APP_DIR/data/server.log"
tail -n 4 "$APP_DIR/data/server.log" 2>/dev/null || true
