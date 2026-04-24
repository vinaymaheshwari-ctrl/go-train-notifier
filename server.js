/**
 * GO Train Delay Notifier
 * Monitors Bronte GO → Union Station (Lakeshore West Line)
 * Sends SMS via Twilio when morning trains (7:45–8:30 AM) are delayed
 *
 * TRIGGER MODE: No internal cron. Instead, cron-job.org (free) calls
 * POST /api/trigger?key=YOUR_CRON_SECRET every 2 minutes on weekday mornings.
 * This works perfectly on free servers (Railway, Render) that sleep when idle —
 * because the incoming request from cron-job.org wakes the server up just in time.
 *
 * cron-job.org setup:
 *   URL: https://YOUR-APP-URL/api/trigger?key=YOUR_CRON_SECRET
 *   Schedule: Every 2 min, Mon–Fri, between 7:30–8:45 AM (Toronto / ET)
 */

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const twilio = require('twilio');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ─── Config ───────────────────────────────────────────────────────────────────
const CONFIG = {
  // GO Transit / Metrolinx
  GO_API_KEY: process.env.GO_API_KEY || '',
  BRONTE_STOP_CODE: 'BR',
  LINE: 'LW',

  // Monitoring window — used to guard against accidental out-of-hours triggers
  MONITOR_START_HOUR: 7,
  MONITOR_START_MIN: 30,
  MONITOR_END_HOUR: 8,
  MONITOR_END_MIN: 45,

  // Delay threshold (minutes) before sending SMS
  DELAY_THRESHOLD_MINS: 3,

  // Twilio SMS
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || '',
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || '',
  TWILIO_FROM_NUMBER: process.env.TWILIO_FROM_NUMBER || '',
  NOTIFY_PHONE: process.env.NOTIFY_PHONE || '',

  // Protects /api/trigger from random callers — set to any secret string
  CRON_SECRET: process.env.CRON_SECRET || 'change-me-please',
};

// ─── State ────────────────────────────────────────────────────────────────────
// Resets on server restart — that's fine, notifiedTrips uses a date prefix
// so there are no duplicate SMS even after a restart.
let state = {
  monitoring: true,
  lastCheck: null,
  lastTrigger: null,
  lastStatus: 'Unknown',
  lastDelay: null,
  alertsSentToday: 0,
  alertHistory: [],
  trainStatuses: [],
  notifiedTrips: new Set(),
};

// ─── GO Transit API ───────────────────────────────────────────────────────────

async function fetchServiceAlerts() {
  try {
    const url = `https://api.gotransit.com/v2/serviceAlerts?apiKey=${CONFIG.GO_API_KEY}`;
    const { data } = await axios.get(url, { timeout: 10000 });
    return data?.Messages || [];
  } catch (err) {
    console.error('[GO API] Service alerts fetch failed:', err.message);
    return [];
  }
}

async function fetchBronteTrains() {
  try {
    const url = `https://api.gotransit.com/v2/lines/${CONFIG.LINE}/stops/${CONFIG.BRONTE_STOP_CODE}/nextservice?apiKey=${CONFIG.GO_API_KEY}`;
    const { data } = await axios.get(url, { timeout: 10000 });
    return data?.NextService || [];
  } catch (err) {
    console.error('[GO API] Train fetch failed:', err.message);
    return [];
  }
}

function filterMorningTrains(trains) {
  return trains.filter(trip => {
    const [h, m] = (trip.ScheduledDepartureTime || '').split(':').map(Number);
    return (h === 7 && m >= 45) || (h === 8 && m <= 30);
  });
}

function isMonitoringWindow() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' }));
  const totalMins = now.getHours() * 60 + now.getMinutes();
  const start = CONFIG.MONITOR_START_HOUR * 60 + CONFIG.MONITOR_START_MIN;
  const end   = CONFIG.MONITOR_END_HOUR   * 60 + CONFIG.MONITOR_END_MIN;
  return totalMins >= start && totalMins <= end;
}

// ─── SMS via Twilio ───────────────────────────────────────────────────────────

async function sendSMS(message) {
  if (!CONFIG.TWILIO_ACCOUNT_SID || !CONFIG.TWILIO_AUTH_TOKEN) {
    console.log('[SMS] Twilio not configured — would have sent:', message);
    return { simulated: true };
  }
  const client = twilio(CONFIG.TWILIO_ACCOUNT_SID, CONFIG.TWILIO_AUTH_TOKEN);
  const result = await client.messages.create({
    body: message,
    from: CONFIG.TWILIO_FROM_NUMBER,
    to: CONFIG.NOTIFY_PHONE,
  });
  console.log(`[SMS] Sent: ${result.sid}`);
  return result;
}

// ─── Core Check Logic ─────────────────────────────────────────────────────────

async function checkTrains() {
  state.lastCheck = new Date().toISOString();
  console.log(`[Check] ${new Date().toLocaleTimeString('en-CA', { timeZone: 'America/Toronto' })}`);

  const [alerts, trains] = await Promise.all([fetchServiceAlerts(), fetchBronteTrains()]);

  const lwAlerts = alerts.filter(a =>
    a.Lines?.includes('LW') || a.Stops?.includes(CONFIG.BRONTE_STOP_CODE)
  );

  const morningTrains = filterMorningTrains(trains);
  state.trainStatuses = morningTrains.map(t => ({
    scheduled: t.ScheduledDepartureTime,
    estimated: t.EstimatedDepartureTime || t.ScheduledDepartureTime,
    tripId: t.TripNumber,
    status: t.Status || 'On Time',
    delayMins: t.DelayMinutes || 0,
    destination: t.LastStopName || 'Union Station',
  }));

  // Notify for each delayed morning train (once per trip per day)
  for (const train of state.trainStatuses) {
    const delay = train.delayMins;
    const tripKey = `${new Date().toDateString()}-${train.tripId}`;

    if (delay >= CONFIG.DELAY_THRESHOLD_MINS && !state.notifiedTrips.has(tripKey)) {
      state.notifiedTrips.add(tripKey);
      const msg = `🚆 GO Train Alert! Your ${train.scheduled} Bronte → Union train is delayed ~${delay} min. Est. departure: ${train.estimated}. Check gotransit.com for updates.`;
      console.log('[ALERT]', msg);
      await sendSMS(msg);
      state.alertsSentToday++;
      state.alertHistory.unshift({ time: new Date().toISOString(), message: msg, train: train.scheduled, delay });
      if (state.alertHistory.length > 50) state.alertHistory.pop();
    }
  }

  // Notify for line-wide service alerts (once per alert per day)
  for (const alert of lwAlerts) {
    const alertKey = `${new Date().toDateString()}-alert-${alert.ID || alert.Message?.slice(0, 30)}`;
    if (!state.notifiedTrips.has(alertKey)) {
      state.notifiedTrips.add(alertKey);
      const msg = `🚨 GO Transit Alert (Lakeshore West): ${alert.Message || alert.Title}. Check gotransit.com for details.`;
      console.log('[LINE ALERT]', msg);
      await sendSMS(msg);
      state.alertsSentToday++;
      state.alertHistory.unshift({ time: new Date().toISOString(), message: msg, train: 'Line Alert', delay: null });
    }
  }

  const anyDelayed = state.trainStatuses.some(t => t.delayMins >= CONFIG.DELAY_THRESHOLD_MINS);
  state.lastStatus = anyDelayed ? 'Delayed' : lwAlerts.length > 0 ? 'Alert' : 'On Time';
  state.lastDelay  = anyDelayed ? Math.max(...state.trainStatuses.map(t => t.delayMins)) : null;
}

// ─── REST API ─────────────────────────────────────────────────────────────────

// Called by cron-job.org every 2 min on weekday mornings
// URL: POST https://your-app.railway.app/api/trigger?key=YOUR_CRON_SECRET
app.post('/api/trigger', async (req, res) => {
  const key = req.query.key || req.body?.key;

  if (key !== CONFIG.CRON_SECRET) {
    console.warn('[Trigger] Rejected — bad secret');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  state.lastTrigger = new Date().toISOString();

  if (!isMonitoringWindow()) {
    console.log('[Trigger] Outside monitoring window — skipped');
    return res.json({ skipped: true, reason: 'Outside 7:30–8:45 AM window' });
  }

  try {
    await checkTrains();
    res.json({ success: true, status: state.lastStatus, trains: state.trainStatuses.length });
  } catch (err) {
    console.error('[Trigger] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Dashboard status
app.get('/api/status', (req, res) => {
  res.json({
    ...state,
    notifiedTrips: [...state.notifiedTrips],
    config: {
      line: CONFIG.LINE,
      station: 'Bronte GO',
      monitorWindow: `${CONFIG.MONITOR_START_HOUR}:${String(CONFIG.MONITOR_START_MIN).padStart(2,'0')} – ${CONFIG.MONITOR_END_HOUR}:${String(CONFIG.MONITOR_END_MIN).padStart(2,'0')} AM`,
      delayThreshold: CONFIG.DELAY_THRESHOLD_MINS,
      notifyPhone: CONFIG.NOTIFY_PHONE ? CONFIG.NOTIFY_PHONE.slice(0, -4) + '****' : 'Not set',
      twilioConfigured: !!(CONFIG.TWILIO_ACCOUNT_SID && CONFIG.TWILIO_AUTH_TOKEN),
      goApiConfigured: !!CONFIG.GO_API_KEY,
      cronSecret: CONFIG.CRON_SECRET !== 'change-me-please' ? '✓ Set' : '⚠ Using default — please change!',
    }
  });
});

// Manual check from dashboard
app.post('/api/check-now', async (req, res) => {
  try {
    await checkTrains();
    res.json({ success: true, status: state.lastStatus, trains: state.trainStatuses });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Test SMS from dashboard
app.post('/api/test-sms', async (req, res) => {
  try {
    const result = await sendSMS('🧪 GO Train Notifier test — your alert system is working! Bronte → Union monitoring is active.');
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚆 GO Train Notifier running on port ${PORT}`);
  console.log(`   Mode: External trigger via cron-job.org`);
  console.log(`   Trigger URL: POST /api/trigger?key=${CONFIG.CRON_SECRET}`);
  console.log(`   Window: 7:30–8:45 AM ET, Mon–Fri\n`);
});
