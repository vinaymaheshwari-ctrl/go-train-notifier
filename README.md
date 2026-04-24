# 🚆 GO Train Delay Notifier

Automatically monitors **Bronte GO → Union Station** (Lakeshore West) morning trains (7:45–8:30 AM) and **texts your wife the moment a delay is detected**.

**Runs free, forever** — deployed on Railway + triggered by cron-job.org.

---

## How It Works

```
cron-job.org  →  POST /api/trigger  →  GO Transit API  →  Twilio SMS  →  Wife's phone
(every 2 min)     (wakes server)        (check delays)      (if delay)
```

1. **cron-job.org** (free) pings your server every 2 minutes on weekday mornings
2. The ping wakes the server (even if it was sleeping) and triggers a train check
3. The app calls the **GO Transit API** to check Bronte → Union trains
4. If any 7:45–8:30 AM train is delayed 3+ minutes → **SMS sent via Twilio**
5. Each trip is only notified once per day (no duplicate messages)

---

## Setup (~20 minutes total)

### Step 1: Prepare your .env file
```bash
cp .env.example .env
```
Fill in:
- `GO_API_KEY` — from Metrolinx (waiting for approval)
- `TWILIO_ACCOUNT_SID` — from twilio.com/console
- `TWILIO_AUTH_TOKEN` — from twilio.com/console
- `TWILIO_FROM_NUMBER` — your Twilio phone number
- `NOTIFY_PHONE` — wife's number in E.164 format (e.g. +14161234567)
- `CRON_SECRET` — any random string you choose (e.g. `bronte-union-2024`)

---

### Step 2: Deploy to Railway (Free)

1. Go to [railway.app](https://railway.app) and sign up with GitHub
2. Click **New Project → Deploy from GitHub repo**
3. Push this folder to a GitHub repo, connect it
4. In Railway dashboard → your service → **Variables** tab
5. Add all 6 variables from your `.env` file (paste them one by one)
6. Railway auto-deploys. Copy your app's public URL (e.g. `https://go-notifier-production.up.railway.app`)

---

### Step 3: Set Up cron-job.org (Free)

1. Go to [cron-job.org](https://cron-job.org) and create a free account
2. Click **CREATE CRONJOB**
3. Fill in:
   - **Title:** GO Train Check
   - **URL:** `https://YOUR-RAILWAY-URL/api/trigger?key=YOUR_CRON_SECRET`
     *(replace both parts with your actual values)*
   - **Schedule:** Custom
     - Minutes: `*/2` (every 2 minutes)
     - Hours: `7,8` (7 AM and 8 AM hour)
     - Days of week: `Mon, Tue, Wed, Thu, Fri`
     - Months: `*` (all)
   - **Request method:** POST
4. Save — it will start running automatically on weekday mornings

The app has a built-in guard: even if cron-job.org fires outside 7:30–8:45 AM, it skips and does nothing.

---

### Step 4: Test it

Open your Railway app URL in a browser — you'll see the live dashboard.

Click **Send Test SMS** to confirm your wife receives a message.

To do a full end-to-end test, click **Check Now** in the dashboard (works any time).

---

## Dashboard

Visit your Railway URL to see:
- 🟢 / 🔴 Live train status
- Table of morning trains with scheduled vs estimated times
- Alert history log
- Configuration status (API keys, Twilio, cron secret)

---

## SMS Examples

**Delay detected:**
> 🚆 GO Train Alert! Your 8:04 Bronte → Union train is delayed ~12 min. Est. departure: 8:16. Check gotransit.com for updates.

**Line-wide alert:**
> 🚨 GO Transit Alert (Lakeshore West): Signal issue west of Bronte GO. Expect 5-10 min delays.

**Test message:**
> 🧪 GO Train Notifier test — your alert system is working! Bronte → Union monitoring is active.

---

## Cost Summary

| Service | Cost |
|---|---|
| Railway hosting | Free |
| cron-job.org | Free |
| Twilio number | $1.15/month (covered by $15 trial credit for ~12 months) |
| Twilio SMS | ~$0.008/msg (minimal — only fires on actual delays) |
| **Total ongoing** | **~$1.15/month after trial** |

