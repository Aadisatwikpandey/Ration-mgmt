# Monthly Ration

A phone-friendly app for the monthly wholesale list and the weekly fresh shopping.

- **Months:** tracking starts in **October 2026**. Every month (and every week of the weekly list) keeps its own ticks, spends and review.
- **Wholesale trip:** tap **Start trip** on the List tab before you shop. Each item then gets a ₹ box: type what you paid and the item ticks itself. Use the phone's **next** key to move down the list. Tap **Finish** and enter the bill total. Per-item prices are optional, so you can enter just the total.
- **Top-ups:** extra rice, atta or anything else bought later in the month. Use **+ Top-up** on the List or Spend tab, or **Bought more…** on an item. Add as many items as you like, each with a quantity and price.
- **Spend:** the month's total (wholesale + top-ups + veg/milk), each purchase, what you spent per item, and a 12-month history.
- **Review:** anything you topped up counts as "needed more", and next month's quantity grows by the amount you actually bought (8 kg + a 5 kg top-up gives 13 kg). Mark other items "ran out early", "just right" or "left over" (about ±25%), then **Apply**. Things you bought that aren't on the list show up with a one-tap **+ List**.
- **Edit anything:** add, rename, move or remove items, and change quantities (`2 kg`, `500 g`, `1 L`, `6 pcs`, or any text). Quantities scale with the number of people.
- **Reminders:** repeating monthly and weekly events in your phone's calendar (Google Calendar on Android, or a `.ics` file for any other calendar).
- **Data:** one JSON file with a dated backup copy every day. Nothing is ever deleted, and removed items can be put back from Settings.

## Run it on the Mac mini

Needs Node.js 22 or newer (`brew install node`). There are no packages to install.

```bash
git clone https://github.com/Aadisatwikpandey/Ration-mgmt.git ~/ration-app
cd ~/ration-app
cp .env.example .env    # then set APP_PIN in .env (recommended)
npm start
```

It prints the address to open on your phone, e.g. `http://Your-Mac-mini.local:8080`.
The phone must be on the same Wi-Fi. The first time, macOS asks whether `node` may accept incoming connections: choose **Allow**.

**Keep it running in the background** (starts at login, restarts if it crashes):

```bash
~/ration-app/scripts/install-mac-service.sh
```

Keep the folder outside Desktop, Documents and Downloads: macOS blocks background apps from reading those.

Also turn on **System Settings → Energy → Prevent automatic sleeping when the display is off**.

**On your Android phone:** open the address in Chrome, then tap **⋮ → Add to Home screen**. It then opens like an app.

**Reminders:** in the app, go to **Settings → Shopping reminders**, pick the day and time, and tap the two **Add to Google Calendar** buttons.

### Where the data lives

```
data/
  data.json                  ← everything (items, months, spends, reviews, settings)
  backups/data-YYYY-MM-DD.json  ← copy taken before the first change each day
  backups/pre-import-*.json     ← copy taken before a "Restore from backup"
  .secret                    ← signs login cookies; keep it private
```

- Saves are atomic (write to a temp file, then rename), so a power cut can't leave a half-written file.
- If `data.json` is ever damaged, the app refuses to overwrite it and shows an error. Copy a file from `backups/` over it to restore.
- **Settings → Download backup** saves a JSON copy to your phone at any time.

### Reaching it away from home (optional)

Install [Tailscale](https://tailscale.com) on the Mac mini and your phone. The app is then reachable from anywhere, privately, with no ports opened. Don't port-forward it on your router.

## Host it on Vercel with your own domain (optional)

The same code runs on Vercel. Vercel doesn't keep files between requests, so the JSON is stored in a **private Vercel Blob** store instead. Reads there need a token, so the file isn't reachable by URL.

1. Import the GitHub repo at vercel.com → **Add New → Project**. No framework and no build step are needed; `vercel.json` handles it. The repo holds no secrets: your data, PIN and `.env` are never committed.
2. In the project, go to **Storage → Create → Blob**, set **Access: Private**, and connect it to the project.
3. In **Settings → Environment Variables**, add:
   - `APP_PIN`: at least 8 characters. Use three or four random words rather than a number, because the site is public.
   - `SESSION_SECRET`: the output of `openssl rand -hex 32`.

   Until both are set, the app refuses to show any data.
4. Redeploy, then add your domain under **Settings → Domains** and create the DNS record Vercel shows you at your registrar.
5. To move your data over: in the Mac mini app, use **Settings → Download backup**. In the Vercel app, use **Settings → Restore from backup**.

Notes for Vercel:
- Backups go to `ration/backups/` in the Blob store, one per day. The code never deletes blobs.
- The free (Hobby) plan includes 2,000 Blob writes a month. The app batches edits (a save about every 2.5 s while you tick) and checks for changes every 60 s, which is far below that for one family. Hobby pauses Blob access if you exceed the limit (data is kept), so keep an eye on **Usage** the first month.
- Login lockout (5 wrong tries = 15 minutes) is per server instance on Vercel, which is why the PIN must be long.

## Files

```
server.js            Mac mini server (static files + API, file storage)
api/*.js             Vercel functions (all re-export lib/vercel.js)
lib/api.js           the API both hosts share
lib/store-file.js    data/data.json + daily backups
lib/store-blob.js    private Vercel Blob + daily backups, conflict-safe writes (ifMatch)
lib/auth.js          PIN login, signed HttpOnly cookie, lockout
lib/ics.js           calendar file for reminders
lib/defaults.js      the starting list
public/              the app (index.html, app.js, app.css, shared/ used by browser and server)
```

Edits are sent as small changes ("tick atta in 2026-10"), not whole-file saves. Two phones ticking at once never overwrite each other, and edits made offline are kept on the phone and sent when it reconnects.
