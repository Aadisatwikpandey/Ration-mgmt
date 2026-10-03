#!/bin/sh
# Runs the app in the background on this Mac: starts at login, restarts if it crashes,
# at low CPU and disk priority so it never gets in the way of anything else.
# Undo with: launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.ration-app.plist
set -e
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="$(command -v python3 || true)"
[ -n "$PYTHON" ] || { echo "python3 not found. Install it with: xcode-select --install"; exit 1; }

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
    <string>$PYTHON</string>
    <string>-u</string>
    <string>server.py</string>
  </array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>EnvironmentVariables</key>
  <dict><key>PYTHONDONTWRITEBYTECODE</key><string>1</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>Nice</key><integer>10</integer>
  <key>LowPriorityIO</key><true/>
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
echo "After updating the code (git pull), restart it with:"
echo "  launchctl kickstart -k gui/$(id -u)/com.ration-app"
