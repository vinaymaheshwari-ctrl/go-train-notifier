/**
 * GO Train Delay Notifier
 * Monitors Bronte GO → Union Station (Lakeshore West Line)
 * Sends SMS via Twilio when morning trains (7:45–8:30 AM) are delayed
 *
 * API: Metrolinx Open API (api.openmetrolinx.com/OpenDataAPI)
 * Docs: https://api.openmetrolinx.com/OpenDataAPI/Help/Index/en
 *
 * TRIGGER MODE: cron-job.org calls POST /api/trigger?key=YOUR_CRON_SECRET
 * every 2 minutes on weekday mornings, waking the server even if it was sleeping.
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
  // Metrolinx Open API
  // Base URL for all calls: https://api.openmetrolinx.com/OpenDataAPI/
  // Key appended as ?key=YOUR_KEY
  GO_API_KEY: process.env.GO_API_KEY || '',
  GO_API_BASE: 'https://api.openmetrolinx.com/OpenDataAPI',

  // Bronte GO station code on Lakeshore West line
  BRONTE_STOP_CODE: 'BR',
  LINE_CODE: 'LW',

  // Monitoring window
  MONITOR_START_HOUR: 7,
  MONITOR_START_MIN: 30,
  MONITOR_END_HOUR: 8,
  MONITOR_END_MIN: 45,

  // Minutes of delay before SMS is sent
  DELAY_THRESHOLD_MINS: 3,

  // Twilio
  TWILIO_ACCOUNT_SID: process.env.TWILIO_ACCOUNT_SID || '',
  TWILIO_AUTH_TOKEN: process.env.TWILIO_AUTH_TOKEN || '',
  TWILIO_FROM_NUMBER: process.env.TWILIO_FROM_NUMBER || '',
  NOTIFY_PHONE: process.env.NOTIFY_PHONE || '',

  // Protects /api/trigger from random callers
  CRON_SECRET: process.env.CRON_SECRET || 'change-me-please',
};

// ─── State ────────────────────────────────────────────────────────────────────
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

// ─── Metrolinx API helpers ────────────────────────────────────────────────────

function apiUrl(path) {
  return `${CONFIG.GO_API_BASE}${path}?key=${CONFIG.GO_API_KEY}`;
}

/**
 * Fetch next service predictions at Bronte GO stop.
 * Endpoint: GET /api/V1/Stop/NextService/{StopCode}
 * Returns all upcoming trips at Bronte GO with scheduled + estimated times and delays.
 * This is the single best endpoint for our use case — gives scheduled time,
 * estimated time, delay, and destination all in one call.
 */
async function fetchBronteNextService() {
  try {
    const url = apiUrl(`/api/V1/Stop/NextService/${CONFIG.BRONTE_STOP_CODE}`);
    const { data } = await axios.get(url, { timeout: 10000 });
    // Returns { NextService: { Lines: [ { Trips: [...] } ] } }
    const lines = data?.NextService?.Lines || [];
    // Flatten all trips across all lines
    const allTrips = lines.flatMap(line => line.Trips || []);
    return allTrips;
  } catch (err) {
    console.error('[GO API] NextService fetch failed:', err.message);
    return [];
  }
}

/**
 * Fetch service alerts.
 * Endpoint: GET /api/V1/ServiceUpdate/ServiceAlert/All
 */
async function fetchServiceAlerts() {
  try {
    const url = apiUrl('/api/V1/ServiceUpdate/ServiceAlert/All');
    const { data } = await axios.get(url, { timeout: 10000 });
    return data?.ServiceAlerts || data?.Alerts || data?.entity || [];
  } catch (err) {
    console.error('[GO API] ServiceAlerts fetch failed:', err.message);
    return [];
  }
}

/**
 * Fetch all live train trips (Service at a Glance).
 * Endpoint: GET /api/V1/ServiceataGlance/Trains/All
 * Used to cross-reference delay deviations by trip number.
 */
async function fetchLiveTrains() {
  try {
    const url = apiUrl('/api/V1/ServiceataGlance/Trains/All');
    const { data } = await axios.get(url, { timeout: 10000 });
    return data?.Trips || [];
  } catch (err) {
    console.error('[GO API] LiveTrains fetch failed:', err.message);
    return [];
  }
}

/**
 * Fetch cancelled/modified train trips.
 * Endpoint: GET /api/V1/ServiceUpdate/Exceptions/Train
 */
async function fetchExceptions() {
  try {
    const url = apiUrl('/api/V1/ServiceUpdate/Exceptions/Train');
    const { data } = await axios.get(url, { timeout: 10000 });
    return data?.Exceptions || [];
  } catch (err) {
    console.error('[GO API] Exceptions fetch failed:', err.message);
    return [];
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getTodayDateString() {
  // Returns date in format YYYYMMDD as required by Metrolinx API
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' }));
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function isMonitoringWindow() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Toronto' }));
  const totalMins = now.getHours() * 60 + now.getMinutes();
  const start = CONFIG.MONITOR_START_HOUR * 60 + CONFIG.MONITOR_START_MIN;
  const end = CONFIG.MONITOR_END_HOUR * 60 + CONFIG.MONITOR_END_MIN;
  return totalMins >= start && totalMins <= end;
}

function isMorningTrain(scheduledTime) {
  // scheduledTime is HH:MM or HH:MM:SS
  if (!scheduledTime) return false;
  const [h, m] = scheduledTime.split(':').map(Number);
  return (h === 7 && m >= 45) || (h === 8 && m <= 30);
}

function addMinsToTime(timeStr, mins) {
  if (!timeStr) return timeStr;
  const [h, m] = timeStr.split(':').map(Number);
  const total = h * 60 + m + mins;
  const newH = Math.floor(total / 60) % 24;
  const newM = total % 60;
  return `${String(newH).padStart(2, '0')}:${String(newM).padStart(2, '0')}`;
}

// ─── Core Check Logic ─────────────────────────────────────────────────────────

async function checkTrains() {
  state.lastCheck = new Date().toISOString();
  console.log(`[Check] ${new Date().toLocaleTimeString('en-CA', { timeZone: 'America/Toronto' })}`);

  // Fetch everything in parallel
  const [nextService, liveTrains, alerts, exceptions] = await Promise.all([
    fetchBronteNextService(),
    fetchLiveTrains(),
    fetchServiceAlerts(),
    fetchExceptions(),
  ]);

  // Build a map of tripNumber → delay from ServiceataGlance (seconds → minutes)
  const delayMap = {};
  for (const trip of liveTrains) {
    const tripNum = String(trip.TripNumber || trip.TripNo || '');
    const delay = trip.DelayDeviation || 0;
    if (tripNum) delayMap[tripNum] = Math.max(0, Math.round(Number(delay) / 60));
  }

  // Build a set of cancelled trip numbers from exceptions
  const cancelledTrips = new Set(
    exceptions
      .filter(e => e.Cancelled === true || e.Status === 'Cancelled')
      .map(e => String(e.TripNumber || e.TripNo))
  );

  // Filter to morning Bronte → Union trains only
  // NextService returns ScheduledDepartureTime, EstimatedDepartureTime, DelayMinutes
  const morningTrips = nextService.filter(trip => {
    const time = trip.ScheduledDepartureTime || trip.DepartureTime || '';
    return isMorningTrain(time);
  });

  // Build trainStatuses for dashboard + alert checking
  // NextService already provides EstimatedDepartureTime and DelayMinutes directly
  state.trainStatuses = morningTrips.map(trip => {
    const tripNum = String(trip.TripNumber || trip.TripNo || '');
    const scheduled = (trip.ScheduledDepartureTime || trip.DepartureTime || '').slice(0, 5);
    // Prefer DelayMinutes from NextService, fall back to ServiceataGlance delayMap
    const delayMins = Number(trip.DelayMinutes || delayMap[tripNum] || 0);
    const cancelled = cancelledTrips.has(tripNum) || trip.Status === 'Cancelled';
    const estimated = trip.EstimatedDepartureTime
      ? trip.EstimatedDepartureTime.slice(0, 5)
      : addMinsToTime(scheduled, delayMins);
    return {
      scheduled,
      estimated: cancelled ? scheduled : estimated,
      tripId: tripNum,
      status: cancelled ? 'Cancelled' : delayMins >= CONFIG.DELAY_THRESHOLD_MINS ? 'Delayed' : 'On Time',
      delayMins,
      cancelled,
      destination: trip.Destination || trip.LastStopName || 'Union Station',
    };
  });

  // Sort by scheduled time
  state.trainStatuses.sort((a, b) => a.scheduled.localeCompare(b.scheduled));

  // ── Send SMS alerts ──────────────────────────────────────────────────────────

  // 1. Delayed trains
  for (const train of state.trainStatuses) {
    const tripKey = `${new Date().toDateString()}-${train.tripId}`;
    if (train.delayMins >= CONFIG.DELAY_THRESHOLD_MINS && !train.cancelled && !state.notifiedTrips.has(tripKey)) {
      state.notifiedTrips.add(tripKey);
      const msg = `🚆 GO Train Alert! Your ${train.scheduled} Bronte → Union train is delayed ~${train.delayMins} min. Est. departure: ${train.estimated}. Check gotransit.com for updates.`;
      console.log('[ALERT - Delay]', msg);
      await sendSMS(msg);
      state.alertsSentToday++;
      state.alertHistory.unshift({ time: new Date().toISOString(), message: msg, train: train.scheduled, delay: train.delayMins });
      if (state.alertHistory.length > 50) state.alertHistory.pop();
    }
  }

  // 2. Cancelled trains
  for (const train of state.trainStatuses) {
    const cancelKey = `${new Date().toDateString()}-cancelled-${train.tripId}`;
    if (train.cancelled && !state.notifiedTrips.has(cancelKey)) {
      state.notifiedTrips.add(cancelKey);
      const msg = `🚫 GO Train Cancelled! Your ${train.scheduled} Bronte → Union train has been cancelled. Please check gotransit.com for the next available train.`;
      console.log('[ALERT - Cancelled]', msg);
      await sendSMS(msg);
      state.alertsSentToday++;
      state.alertHistory.unshift({ time: new Date().toISOString(), message: msg, train: train.scheduled, delay: null });
      if (state.alertHistory.length > 50) state.alertHistory.pop();
    }
  }

  // 3. Line-wide LW service alerts
  const lwAlerts = alerts.filter(a => {
    const alertStr = JSON.stringify(a).toUpperCase();
    return alertStr.includes('LW') || alertStr.includes('LAKESHORE WEST') || alertStr.includes('BRONTE');
  });

  for (const alert of lwAlerts) {
    const alertMsg = alert.HeaderText || alert.DescriptionText || alert.Message || alert.Title || '';
    const alertKey = `${new Date().toDateString()}-alert-${alertMsg.slice(0, 40)}`;
    if (alertMsg && !state.notifiedTrips.has(alertKey)) {
      state.notifiedTrips.add(alertKey);
      const msg = `🚨 GO Transit Alert (Lakeshore West): ${alertMsg}. Check gotransit.com for details.`;
      console.log('[ALERT - Line]', msg);
      await sendSMS(msg);
      state.alertsSentToday++;
      state.alertHistory.unshift({ time: new Date().toISOString(), message: msg, train: 'Line Alert', delay: null });
      if (state.alertHistory.length > 50) state.alertHistory.pop();
    }
  }

  // Update overall status
  const anyDelayed = state.trainStatuses.some(t => t.delayMins >= CONFIG.DELAY_THRESHOLD_MINS && !t.cancelled);
  const anyCancelled = state.trainStatuses.some(t => t.cancelled);
  const anyLineAlert = lwAlerts.length > 0;

  state.lastStatus = anyDelayed ? 'Delayed' : anyCancelled ? 'Cancelled' : anyLineAlert ? 'Alert' : 'On Time';
  state.lastDelay = anyDelayed ? Math.max(...state.trainStatuses.map(t => t.delayMins)) : null;

  console.log(`[Check] Done — Status: ${state.lastStatus} · Trains: ${state.trainStatuses.length} · Alerts: ${lwAlerts.length}`);
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

// ─── REST API ─────────────────────────────────────────────────────────────────

// Called by cron-job.org every 2 min on weekday mornings
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
      line: CONFIG.LINE_CODE,
      station: 'Bronte GO',
      monitorWindow: `${CONFIG.MONITOR_START_HOUR}:${String(CONFIG.MONITOR_START_MIN).padStart(2, '0')} – ${CONFIG.MONITOR_END_HOUR}:${String(CONFIG.MONITOR_END_MIN).padStart(2, '0')} AM`,
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

// Test SMS
app.post('/api/test-sms', async (req, res) => {
  try {
    const result = await sendSMS('🧪 GO Train Notifier test — your alert system is working! Bronte → Union monitoring is active.');
    res.json({ success: true, result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Debug endpoint — tests all 4 Metrolinx API calls and returns raw responses
// Visit: GET /api/debug in your browser to verify API key is working
app.get('/api/debug', async (req, res) => {
  const results = {};

  // 1. Next service at Bronte GO — the main endpoint we use
  try {
    const url = apiUrl(`/api/V1/Stop/NextService/${CONFIG.BRONTE_STOP_CODE}`);
    const { data } = await axios.get(url, { timeout: 10000 });
    const lines = data?.NextService?.Lines || [];
    const allTrips = lines.flatMap(l => l.Trips || []);
    results.bronteNextService = {
      success: true,
      url: url.replace(CONFIG.GO_API_KEY, 'HIDDEN'),
      linesReturned: lines.length,
      totalTrips: allTrips.length,
      sample: allTrips.slice(0, 4).map(t => ({
        trip: t.TripNumber,
        scheduled: t.ScheduledDepartureTime,
        estimated: t.EstimatedDepartureTime,
        delay: t.DelayMinutes,
        destination: t.Destination || t.LastStopName,
        status: t.Status,
      })),
    };
  } catch (err) {
    results.bronteNextService = { success: false, error: err.message };
  }

  // 2. All live trains
  try {
    const url = apiUrl('/api/V1/ServiceataGlance/Trains/All');
    const { data } = await axios.get(url, { timeout: 10000 });
    const trips = data?.Trips || [];
    results.liveTrains = {
      success: true,
      url: url.replace(CONFIG.GO_API_KEY, 'HIDDEN'),
      count: trips.length,
      sample: trips.slice(0, 3).map(t => ({
        trip: t.TripNumber,
        line: t.LineCode,
        delay: t.DelayDeviation,
        from: t.StartStationCode,
        to: t.EndStationCode,
      })),
    };
  } catch (err) {
    results.liveTrains = { success: false, error: err.message };
  }

  // 3. Service alerts
  try {
    const url = apiUrl('/api/V1/ServiceUpdate/ServiceAlert/All');
    const { data } = await axios.get(url, { timeout: 10000 });
    const alerts = data?.ServiceAlerts || data?.Alerts || data?.entity || [];
    results.serviceAlerts = {
      success: true,
      url: url.replace(CONFIG.GO_API_KEY, 'HIDDEN'),
      count: alerts.length,
      sample: alerts.slice(0, 2),
    };
  } catch (err) {
    results.serviceAlerts = { success: false, error: err.message };
  }

  // 4. Exceptions
  try {
    const url = apiUrl('/api/V1/ServiceUpdate/Exceptions/Train');
    const { data } = await axios.get(url, { timeout: 10000 });
    const exceptions = data?.Exceptions || [];
    results.exceptions = {
      success: true,
      url: url.replace(CONFIG.GO_API_KEY, 'HIDDEN'),
      count: exceptions.length,
      sample: exceptions.slice(0, 3).map(e => ({
        trip: e.TripNumber,
        status: e.Status,
        cancelled: e.Cancelled,
      })),
    };
  } catch (err) {
    results.exceptions = { success: false, error: err.message };
  }

  const allOk = Object.values(results).every(r => r.success);
  res.json({
    apiKeyConfigured: !!CONFIG.GO_API_KEY,
    allEndpointsWorking: allOk,
    checkedAt: new Date().toLocaleTimeString('en-CA', { timeZone: 'America/Toronto' }),
    results,
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚆 GO Train Notifier running on port ${PORT}`);
  console.log(`   API: Metrolinx Open API (api.openmetrolinx.com)`);
  console.log(`   Mode: External trigger via cron-job.org`);
  console.log(`   Trigger URL: POST /api/trigger?key=${CONFIG.CRON_SECRET}`);
  console.log(`   Window: 7:30–8:45 AM ET, Mon–Fri\n`);
});