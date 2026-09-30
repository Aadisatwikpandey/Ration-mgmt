# Monthly Ration

A phone app for the monthly wholesale list and the weekly fresh shopping, served from a Mac mini.

- **Months:** tracking starts in **October 2026**. Every month (and every week of the weekly list) keeps its own ticks, spends and review.
- **Wholesale trip:** tap **Start trip** on the List tab before you shop. Each item then gets a ₹ box: type what you paid and the item ticks itself. The keyboard's **next** key moves down the list. Tap **Finish** and enter the bill total. Per-item prices are optional, so you can enter just the total.
- **Top-ups:** extra rice, atta or anything else bought later in the month. Use **+ Top-up** on the List or Spend tab, or **Bought more…** on an item. Add as many items as you like, each with a quantity and price.
- **Spend:** the month's total (wholesale + top-ups + veg/milk), each purchase, what you spent per item, and a 12-month history.
- **Review:** anything you topped up counts as "needed more", and next month's quantity grows by the amount you actually bought (8 kg + a 5 kg top-up gives 13 kg). Mark other items "ran out early", "just right" or "left over" (about ±25%), then **Apply**. Things you bought that aren't on the list show up with a one-tap **+ List**.
- **Edit anything:** add, rename, move or remove items, and change quantities (`2 kg`, `500 g`, `1 L`, `6 pcs`, or any text). Quantities scale with the number of people.
- **Reminders:** repeating monthly and weekly events in your phone's calendar (Google Calendar buttons, or a `.ics` file).
- **Share:** send the items you haven't picked yet to WhatsApp.

## Built for phones

- Installs to the home screen like an app. Long-press the icon for **Top-up** and **Spend** shortcuts.
- Large tap targets. Bottom sheets keep **Save** visible above the keyboard, and the back button closes a sheet instead of leaving the app.
- Two phones stay in step instantly: each open phone keeps one quiet request waiting at the Mac mini, answered the moment the other phone saves.
- Works with no signal: the app opens, and ticks and prices are kept on the phone and sent when it reconnects.
- During a wholesale trip, the screen stays on and each tick gives a small vibration.

The last three need the app opened over **HTTPS**, which [Tailscale](#use-it-at-the-market-tailscale) gives you for free.

## Run it on the Mac mini

It needs only `python3`, which comes with macOS. There's nothing to install.

```bash
git clone https://github.com/Aadisatwikpandey/Ration-mgmt.git ~/ration-app
cd ~/ration-app
cp .env.example .env    # then set APP_PIN in .env (recommended)
python3 server.py
```

It prints the address to open on your phone, e.g. `http://Your-Mac-mini.local:8080` (phone on the same Wi-Fi). The first time, macOS asks whether Python may accept incoming connections: choose **Allow**.

**Keep it running in the background.** This starts it at login, restarts it if it crashes, and runs it at low CPU and disk priority:

```bash
~/ration-app/scripts/install-mac-service.sh
```

Keep the folder outside Desktop, Documents and Downloads: macOS blocks background apps from reading those. Also turn on **System Settings → Energy → Prevent automatic sleeping when the display is off**.

**After updating the code** (`git pull`), restart it:

```bash
launchctl kickstart -k gui/$(id -u)/com.ration-app
```

### How light it is

- One Python process using about **19 MB of memory**, with no measurable CPU when idle.
- Data is held in memory and written to disk only when something changes.
- The app's files are cached on the phone and only re-downloaded when they change.
- No polling: an open phone makes about two tiny requests a minute, and a closed one makes none.
- The background service runs as a low-priority process (`Nice 10`, low-priority disk I/O).

## Use it at the market (Tailscale)

At the wholesale market your phone isn't on the home Wi-Fi, so it can't reach the Mac mini directly. [Tailscale](https://tailscale.com) (free for personal use) fixes that privately, with nothing opened on your router:

1. Install Tailscale on the Mac mini and on your phone, and sign in to the same account on both.
2. On the Mac mini, run:
   ```bash
   tailscale serve --bg 8080
   ```
   It prints an address like `https://mac-mini.tail1234.ts.net`.
3. On your phone, open that **https** address in Chrome and use it from now on, at home and away.
4. Install it to the home screen: **⋮ → Add to Home screen** (or **Install app**).

Over HTTPS the app also opens with no signal at all, keeps the screen on during a trip, and shares straight to WhatsApp.

Tailscale forwards requests on to the app. If saving ever fails with "cross-site request blocked", add `ALLOWED_ORIGINS=https://mac-mini.tail1234.ts.net` (your address) to `.env` and restart.

## Reminders

In the app, go to **Settings → Shopping reminders**, pick the day and time, and tap the two **Add to Google Calendar** buttons. They're normal repeating calendar events, so they ring even when the app is closed.

## Your data

```
data/
  data.json                     ← everything (items, months, purchases, reviews, settings)
  backups/data-YYYY-MM-DD.json  ← copy taken before the first change each day
  backups/pre-import-*.json     ← copy taken before a "Restore from backup"
  .secret                       ← signs login cookies; keep it private
  server.log                    ← only when installed as a background service
```

- Saves are atomic (written to a temp file, then renamed), so a power cut can't leave a half-written file. Nothing is ever deleted, and removed items can be put back from Settings.
- If `data.json` is ever damaged, the app refuses to start rather than overwrite it, and says so in `server.log`. Copy the newest file from `backups/` over it and restart.
- **Settings → Download backup** saves a JSON copy to your phone at any time. **Restore from backup** puts one back, and keeps a copy of what was there first.
- The app keeps `data.json` in memory. To edit it by hand, stop the app first, edit, then start it again.
- `data/` and `.env` are git-ignored, so your data and PIN never end up in the repo.

## Security

- Set `APP_PIN` in `.env` to lock the app. Each phone stays signed in for 180 days; changing the PIN signs every phone out.
- 5 wrong PINs lock logins for 15 minutes.
- Saves must come from the app's own page. Every change is validated before it touches the data.

## Files

```
server.py                      the whole server (Python standard library)
defaults.json                  the starting list, used when data.json doesn't exist yet
public/index.html, app.js, app.css   the app
public/shared/ops.js           how a change is applied (server.py mirrors this)
public/shared/schedule.js      reminder dates
public/sw.js                   offline copy of the app (HTTPS only)
public/manifest.webmanifest    home-screen install, icons, shortcuts
scripts/install-mac-service.sh background service for macOS
```
