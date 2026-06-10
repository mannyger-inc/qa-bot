'use strict';

const express  = require('express');
const cron     = require('node-cron');
const { webcrypto } = require('crypto');
const { subtle } = webcrypto;

// ── CONFIG ───────────────────────────────────────────────────────────────────
const SLACK_TOKEN         = process.env.SLACK_BOT_TOKEN;
const RIPPIT_TOKEN        = process.env.RIPPIT_API_TOKEN;
const ZD_SUBDOMAIN        = process.env.ZENDESK_SUBDOMAIN || 'incfile';
const ZD_EMAIL            = process.env.ZENDESK_EMAIL;
const ZD_API_TOKEN        = process.env.ZENDESK_API_TOKEN;
const GOOGLE_CLIENT_EMAIL = process.env.GOOGLE_CLIENT_EMAIL;
const GOOGLE_PRIVATE_KEY  = process.env.GOOGLE_PRIVATE_KEY;
const QA_SHEET_ID         = process.env.QA_STATE_SHEET_ID;
const QA_SHEET_TAB        = process.env.QA_SHEET_TAB || 'Sheet1';
const PORT                = process.env.PORT || 3000;
const TZ                  = 'America/Mexico_City';

const MANNY_SLACK_ID      = 'U09AV9NJQQY';
const MANNY_EMAIL         = 'manuel.r@incfile.com';
const LOW_SCORE_THRESHOLD = 80;
const MAESTROQA_URL       = 'https://app.maestroqa.com/performance';

const SUPERVISORS = {
  jewel:  { slackId: 'U09A1QG8N5B', email: 'jewel.f@incfile.com',   name: 'Jewel'  },
  diana:  { slackId: 'U09ADSM8SDT', email: 'diana.o@incfile.com',   name: 'Diana'  },
  mario:  { slackId: 'U09CJNNT9BQ', email: 'mario.z@incfile.com',   name: 'Mario'  },
  albert: { slackId: 'U09A618E92Q', email: 'alberto.r@incfile.com', name: 'Albert' },
  jose:   { slackId: 'U09DLGLJWB0', email: 'jose.h@incfile.com',    name: 'Jose'   },
};

// Populated from Rippit groups export on startup
let AGENT_TEAM_MAP = {};

// In-memory cache for KB widget endpoints
let cachedQAData = {
  updatedAt: null,
  weekLabel: null,
  teams: {},
};

// ── GOOGLE AUTH (webcrypto pattern) ──────────────────────────────────────────
function stripPem(raw) {
  return String(raw || '')
    .replace(/-----BEGIN[^-]*-----/g, '')
    .replace(/-----END[^-]*-----/g, '')
    .replace(/\\n/g, '')
    .replace(/\n/g, '')
    .replace(/\r/g, '')
    .replace(/\s/g, '');
}

async function getGoogleAccessToken() {
  const derBuffer = Buffer.from(stripPem(GOOGLE_PRIVATE_KEY || ''), 'base64');
  const cryptoKey = await subtle.importKey(
    'pkcs8', derBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claim  = Buffer.from(JSON.stringify({
    iss:   GOOGLE_CLIENT_EMAIL,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud:   'https://oauth2.googleapis.com/token',
    exp:   now + 3600,
    iat:   now,
  })).toString('base64url');
  const signingInput = `${header}.${claim}`;
  const sigBuffer = await subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, Buffer.from(signingInput));
  const jwt = `${signingInput}.${Buffer.from(sigBuffer).toString('base64url')}`;
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) throw new Error('Google auth failed: ' + JSON.stringify(tokenData));
  return tokenData.access_token;
}

// ── GOOGLE SHEETS ─────────────────────────────────────────────────────────────
async function sheetsGet(range) {
  const token = await getGoogleAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${QA_SHEET_ID}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error('sheetsGet HTTP ' + res.status);
  const data = await res.json();
  return data.values || [];
}

async function sheetsAppend(range, values) {
  const token = await getGoogleAccessToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${QA_SHEET_ID}/values/${encodeURIComponent(range)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  });
  if (!res.ok) throw new Error('sheetsAppend HTTP ' + res.status);
}

async function getNotifiedSet() {
  try {
    const rows = await sheetsGet(`${QA_SHEET_TAB}!A:B`);
    const set = new Set();
    rows.slice(1).forEach(r => { // skip header row
      if (r[0] && r[1]) set.add(r[0] + '|' + r[1]);
    });
    return set;
  } catch (e) {
    console.error('getNotifiedSet error:', e.message);
    return new Set();
  }
}

async function markNotified(ticketId, agentEmail) {
  try {
    await sheetsAppend(`${QA_SHEET_TAB}!A:C`, [[ticketId, agentEmail, new Date().toISOString()]]);
  } catch (e) {
    console.error('markNotified error:', e.message);
  }
}

async function ensureSheetHeaders() {
  try {
    const rows = await sheetsGet(`${QA_SHEET_TAB}!A1:C1`);
    if (rows.length && rows[0][0] === 'ticket_id') {
      console.log('Sheet headers already set');
      return;
    }
    const token = await getGoogleAccessToken();
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${QA_SHEET_ID}/values/${encodeURIComponent(QA_SHEET_TAB + '!A1:C1')}?valueInputOption=RAW`;
    await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [['ticket_id', 'agent_email', 'notified_at']] }),
    });
    console.log('Sheet headers written to', QA_SHEET_TAB);
  } catch (e) {
    console.error('ensureSheetHeaders error:', e.message);
  }
}

// ── CSV HELPER ────────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.replace(/"/g, '').trim().toLowerCase().replace(/[\s-]+/g, '_'));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    // Handle quoted fields with commas inside
    const vals = [];
    let inQuote = false, cur = '';
    for (const ch of lines[i] + ',') {
      if (ch === '"') { inQuote = !inQuote; }
      else if (ch === ',' && !inQuote) { vals.push(cur.trim()); cur = ''; }
      else { cur += ch; }
    }
    if (vals.length < 2) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h] = (vals[idx] || '').replace(/"/g, '').trim(); });
    rows.push(row);
  }
  return rows;
}

// Try multiple column name patterns — Rippit CSV column names may vary
function col(row, ...candidates) {
  for (const c of candidates) {
    const needle = c.toLowerCase().replace(/[\s_-]/g, '');
    for (const [k, v] of Object.entries(row)) {
      if (k.toLowerCase().replace(/[\s_-]/g, '') === needle && v !== undefined && v !== '') return String(v).trim();
    }
  }
  return '';
}

// ── RIPPIT API ────────────────────────────────────────────────────────────────
function getWeekRange() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
  const dow = now.getDay();
  const monday = new Date(now);
  monday.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1));
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  const fmt = d => `${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getDate().toString().padStart(2,'0')}/${d.getFullYear()}`;
  return {
    startDate: monday.toISOString(),
    endDate:   sunday.toISOString(),
    label:     `${fmt(monday)} - ${fmt(sunday)}`,
  };
}

async function requestRippitExport(startDate, endDate) {
  const res = await fetch('https://app.rippit.com/api/v1/request-raw-export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apitoken': RIPPIT_TOKEN },
    body: JSON.stringify({ startDate, endDate, singleFileExport: 'total_scores' }),
  });
  if (!res.ok) throw new Error('Rippit export request failed HTTP ' + res.status);
  const data = await res.json();
  if (!data.exportId) throw new Error('No exportId returned: ' + JSON.stringify(data));
  return data.exportId;
}

async function waitForExport(exportId, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 7000));
    const res = await fetch(`https://app.rippit.com/api/v1/export-data/${exportId}`, {
      headers: { 'apitoken': RIPPIT_TOKEN },
    });
    if (!res.ok) throw new Error('Export poll HTTP ' + res.status);
    const data = await res.json();
    if (data.status === 'complete') {
      if (!data.dataUrl) { console.log('Export complete but no dataUrl — no data for this period'); return null; }
      return data.dataUrl;
    }
    if (data.status === 'errored') throw new Error('Rippit export errored');
    console.log('Export status:', data.status, '— polling...');
  }
  throw new Error('Export timed out after 2 minutes');
}

async function fetchExportRows(exportId) {
  const dataUrl = await waitForExport(exportId);
  if (!dataUrl) return [];
  const res = await fetch(dataUrl);
  if (!res.ok) throw new Error('CSV download HTTP ' + res.status);
  const text = await res.text();
  const rows = parseCSV(text);
  if (rows[0]) {
    // Log ALL column names so we can verify field names
    console.log(`Parsed ${rows.length} rows. All columns: ${Object.keys(rows[0]).join(' | ')}`);
  }
  return rows;
}

async function loadAgentTeamMap() {
  if (!RIPPIT_TOKEN) { console.log('No RIPPIT_TOKEN — skipping agent team map load'); return; }
  try {
    console.log('Loading agent-team map from Rippit groups export...');
    const res = await fetch('https://app.rippit.com/api/v1/request-groups-export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apitoken': RIPPIT_TOKEN },
      body: JSON.stringify({ includeUnavailable: true }),
    });
    if (!res.ok) { console.error('Groups export request failed HTTP', res.status); return; }
    const data = await res.json();
    const dataUrl = await waitForExport(data.exportId, 60000);
    if (!dataUrl) return;
    const gRes = await fetch(dataUrl);
    const text = await gRes.text();
    const rows = parseCSV(text);
    console.log('Groups export sample:', rows[0] ? Object.keys(rows[0]).join(', ') : 'empty');
    let mapped = 0;
    rows.forEach(row => {
      const email = col(row, 'agent_email', 'email', 'agent email').toLowerCase();
      const group = col(row, 'group_name', 'group', 'team', 'agent_group').toLowerCase();
      if (!email || !group) return;
      for (const key of Object.keys(SUPERVISORS)) {
        if (group.includes(key)) {
          AGENT_TEAM_MAP[email] = key;
          mapped++;
          break;
        }
      }
    });
    console.log(`Agent team map: ${mapped} agents mapped, ${rows.length} total rows`);
  } catch (e) {
    console.error('loadAgentTeamMap error:', e.message);
  }
}

// ── ZENDESK ──────────────────────────────────────────────────────────────────
async function getZendeskTicket(ticketId) {
  try {
    const creds = Buffer.from(`${ZD_EMAIL}/token:${ZD_API_TOKEN}`).toString('base64');
    const res = await fetch(`https://${ZD_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticketId}.json`, {
      headers: { Authorization: `Basic ${creds}`, 'Content-Type': 'application/json' },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.ticket || null;
  } catch (e) {
    console.error('getZendeskTicket error:', e.message);
    return null;
  }
}

// ── SLACK ─────────────────────────────────────────────────────────────────────
async function slackLookupByEmail(email) {
  try {
    const res = await fetch(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`, {
      headers: { Authorization: `Bearer ${SLACK_TOKEN}` },
    });
    const data = await res.json();
    if (!data.ok) { console.log('lookupByEmail failed for', email, ':', data.error); return null; }
    return data.user?.id || null;
  } catch (e) {
    console.error('slackLookupByEmail error:', e.message);
    return null;
  }
}

async function slackDM(userId, text) {
  try {
    const openRes = await fetch('https://slack.com/api/conversations.open', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ users: userId }),
    });
    const openData = await openRes.json();
    if (!openData.ok) { console.error('conversations.open failed:', openData.error, 'userId:', userId); return; }
    const msgRes = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SLACK_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: openData.channel.id, text, mrkdwn: true }),
    });
    const msgData = await msgRes.json();
    if (!msgData.ok) console.error('chat.postMessage failed:', msgData.error);
  } catch (e) {
    console.error('slackDM error:', e.message);
  }
}

function scoreEmoji(score) {
  const n = Number(score);
  if (n >= 95) return ':star:';
  if (n >= 90) return ':white_check_mark:';
  if (n >= 80) return ':thumbsup:';
  return ':warning:';
}

function formatScore(score) {
  const n = Number(score);
  return isNaN(n) ? score : n.toFixed(1) + '%';
}

// ── NOTIFICATION LOGIC ────────────────────────────────────────────────────────
async function processAndNotifyGradings(rows, weekLabel, weekStart, weekEnd, notifiedSet) {
  const weekStartMs = new Date(weekStart).getTime();
  const weekEndMs   = new Date(weekEnd).getTime();

  // Filter to gradings that actually occurred this week and are not deleted
  const filtered = rows.filter(row => {
    if (col(row, 'is_deleted') === 'true' || col(row, 'is_deleted') === '1') return false;
    const gradedAt = col(row, 'date_graded', 'date_first_graded', 'date graded', 'graded_at', 'created_at');
    if (!gradedAt) return true;
    const ms = new Date(gradedAt).getTime();
    return ms >= weekStartMs && ms <= weekEndMs;
  });
  console.log(`Week filter: ${rows.length} total rows -> ${filtered.length} in current week`);

  const teamData = {};
  let newCount = 0;

  for (const row of filtered) {
    const ticketId   = col(row, 'ticket_id', 'ticketid', 'ticket id', 'external_id', 'ticket_external_id', 'zendesk_ticket_id', 'helpdesk_ticket_id');
    const agentEmail = col(row, 'agent_email', 'agentemail', 'agent email', 'email').toLowerCase();
    const agentName  = col(row, 'agent_name', 'agentname', 'agent name', 'agent') || agentEmail.split('@')[0];
    const graderName = col(row, 'grader_name', 'gradername', 'grader name', 'grader');

    // Score: try direct percentage fields first, then calculate from rubric_score / max_rubric_score
    let score = parseFloat(col(row, 'score', 'total_score', 'total score', 'percentage', 'overall_score', 'overall score', 'rubric_score', 'rubric score'));
    if (isNaN(score)) {
      const rubric    = parseFloat(col(row, 'rubric_score', 'rubric score'));
      const maxRubric = parseFloat(col(row, 'max_rubric_score', 'max rubric score', 'max_score', 'max score'));
      if (!isNaN(rubric) && !isNaN(maxRubric) && maxRubric > 0) {
        score = (rubric / maxRubric) * 100;
      }
    }

    if (!agentEmail || isNaN(score)) continue;

    // Accumulate team scores (regardless of notification state)
    const teamKey = AGENT_TEAM_MAP[agentEmail];
    if (teamKey) {
      if (!teamData[teamKey]) teamData[teamKey] = { total: 0, count: 0, agents: {} };
      teamData[teamKey].total += score;
      teamData[teamKey].count += 1;
      if (!teamData[teamKey].agents[agentEmail]) {
        teamData[teamKey].agents[agentEmail] = { name: agentName, total: 0, count: 0 };
      }
      teamData[teamKey].agents[agentEmail].total += score;
      teamData[teamKey].agents[agentEmail].count += 1;
    }

    if (!ticketId) continue; // need ticket ID for per-ticket notifications

    // Skip already-notified
    const key = ticketId + '|' + agentEmail;
    if (notifiedSet.has(key)) continue;
    notifiedSet.add(key);
    newCount++;

    // Mark as notified in sheet (non-blocking)
    markNotified(ticketId, agentEmail).catch(e => console.error('markNotified error:', e.message));

    // Get Zendesk ticket for extra context
    const zdTicket = await getZendeskTicket(ticketId);
    const subject  = zdTicket?.subject || '';
    const channel  = zdTicket?.channel || '';

    // Look up agent Slack ID
    const agentSlackId = await slackLookupByEmail(agentEmail);

    const emoji = scoreEmoji(score);
    const scoreStr = formatScore(score);
    const zdLink = `https://${ZD_SUBDOMAIN}.zendesk.com/agent/tickets/${ticketId}`;

    // ── DM the agent ──
    if (agentSlackId) {
      const agentMsg = [
        `*QA Bizee-Bot ${emoji} — New grading ready*`,
        '',
        `Hi ${agentName}, a QA grading is ready for week *${weekLabel}*.`,
        '',
        `*Score:* ${scoreStr} ${emoji}`,
        `*Ticket:* #${ticketId} | <${zdLink}|View in Zendesk>`,
        graderName ? `*Graded by:* ${graderName}` : null,
        channel ? `*Channel:* ${channel}` : null,
        '',
        score < LOW_SCORE_THRESHOLD
          ? ':warning: Your score was below 80%. Your supervisor will be in touch.'
          : 'Keep it up! :muscle:',
      ].filter(Boolean).join('\n');
      await slackDM(agentSlackId, agentMsg);
    } else {
      console.log('No Slack ID for agent:', agentEmail);
    }

    // ── DM supervisor + Manny: new grading notice ──
    const supMsg = [
      `*QA Bizee-Bot ${emoji} — New grading: ${agentName}*`,
      '',
      `*Agent:* ${agentName} (${agentEmail})`,
      `*Week:* ${weekLabel}`,
      `*Score:* ${scoreStr} ${emoji}`,
      `*Ticket:* #${ticketId} | <${zdLink}|View in Zendesk>`,
      graderName ? `*Graded by:* ${graderName}` : null,
      channel ? `*Channel:* ${channel}` : null,
    ].filter(Boolean).join('\n');

    const sup = SUPERVISORS[teamKey];
    if (sup) await slackDM(sup.slackId, supMsg);
    await slackDM(MANNY_SLACK_ID, supMsg);

    // ── Low score alert (< 80) ──
    if (score < LOW_SCORE_THRESHOLD) {
      const alertMsg = [
        `*QA Bizee-Bot :rotating_light: — Low Score Alert*`,
        '',
        `*Agent:* ${agentName} (${agentEmail})`,
        `*Score:* ${scoreStr} :x: _(below ${LOW_SCORE_THRESHOLD}%)_`,
        `*Week:* ${weekLabel}`,
        `*Ticket:* #${ticketId} | <${zdLink}|View in Zendesk>`,
        channel ? `*Channel:* ${channel}` : null,
        subject ? `*Subject:* ${subject}` : null,
        graderName ? `*Graded by:* ${graderName}` : null,
        '',
        `<${MAESTROQA_URL}|Open MaestroQA Performance Dashboard>`,
      ].filter(Boolean).join('\n');

      if (sup) await slackDM(sup.slackId, alertMsg);
      await slackDM(MANNY_SLACK_ID, `[Low Score Alert]\n${alertMsg}`);
    }

    // Pace Slack requests
    await new Promise(r => setTimeout(r, 600));
  }

  console.log(`Sent ${newCount} new grading notification(s)`);
  return teamData;
}

async function sendWeeklyTeamSummary(teamData, weekLabel) {
  for (const [teamKey, data] of Object.entries(teamData)) {
    const sup = SUPERVISORS[teamKey];
    if (!sup || data.count === 0) continue;

    const teamAvg = (data.total / data.count).toFixed(1);
    const agentLines = Object.values(data.agents)
      .sort((a, b) => (b.total / b.count) - (a.total / a.count))
      .map(a => `  - ${a.name}: *${(a.total / a.count).toFixed(1)}%* (${a.count} ticket${a.count > 1 ? 's' : ''} graded)`)
      .join('\n');

    const summaryMsg = [
      `*QA Bizee-Bot :bar_chart: — Weekly Team Summary*`,
      `*Team ${sup.name} | Week ${weekLabel}*`,
      '',
      `*Team average: ${teamAvg}% ${scoreEmoji(parseFloat(teamAvg))}*`,
      `*Graded tickets: ${data.count}*`,
      '',
      `*Per agent:*`,
      agentLines || '  No graded agents this week.',
      '',
      `<${MAESTROQA_URL}|Open MaestroQA Performance Dashboard>`,
    ].join('\n');

    await slackDM(sup.slackId, summaryMsg);
    await slackDM(MANNY_SLACK_ID, `[Team ${sup.name} Weekly Summary]\n${summaryMsg}`);
    await new Promise(r => setTimeout(r, 600));
  }
}

// ── MAIN POLL ─────────────────────────────────────────────────────────────────
async function runQAPoll(opts = {}) {
  const { weeklySummary = false } = opts;
  console.log(`[${new Date().toISOString()}] QA poll starting | weeklySummary=${weeklySummary}`);

  if (!RIPPIT_TOKEN) {
    console.error('RIPPIT_API_TOKEN not set — skipping poll');
    return;
  }

  try {
    const { startDate, endDate, label } = getWeekRange();
    console.log(`Week range: ${label}`);

    // Request export from Rippit
    const exportId = await requestRippitExport(startDate, endDate);
    console.log('Export ID:', exportId);

    // Fetch and parse rows
    const rows = await fetchExportRows(exportId);
    if (!rows.length) {
      console.log('No rows returned for this period — nothing to notify');
      return;
    }

    // Get already-notified set from Google Sheets
    const notifiedSet = await getNotifiedSet();

    // Process gradings, send per-ticket notifications
    const teamData = await processAndNotifyGradings(rows, label, startDate, endDate, notifiedSet);

    // Update in-memory cache for KB endpoints
    cachedQAData.updatedAt = new Date().toISOString();
    cachedQAData.weekLabel = label;
    cachedQAData.teams = {};
    for (const [teamKey, data] of Object.entries(teamData)) {
      const sup = SUPERVISORS[teamKey];
      cachedQAData.teams[teamKey] = {
        name: sup?.name || teamKey,
        avg: data.count > 0 ? parseFloat((data.total / data.count).toFixed(1)) : null,
        gradedTickets: data.count,
        agents: Object.values(data.agents).map(a => ({
          name: a.name,
          avg: parseFloat((a.total / a.count).toFixed(1)),
          count: a.count,
        })).sort((a, b) => b.avg - a.avg),
      };
    }

    // Optional Friday weekly summary
    if (weeklySummary) {
      console.log('Sending weekly team summary...');
      await sendWeeklyTeamSummary(teamData, label);
    }

    console.log(`[${new Date().toISOString()}] QA poll complete`);
  } catch (e) {
    console.error('runQAPoll error:', e.message, e.stack);
    try {
      await slackDM(MANNY_SLACK_ID, `:x: *QA Bizee-Bot error:* ${e.message}`);
    } catch (_) { /* ignore */ }
  }
}

// ── CRON SCHEDULE ─────────────────────────────────────────────────────────────
// Poll every 2 hours Mon-Sat, skip outside 8am-8pm GDL
cron.schedule('0 */2 * * 1-6', async () => {
  const nowGDL = new Date(new Date().toLocaleString('en-US', { timeZone: TZ }));
  const h = nowGDL.getHours();
  if (h < 8 || h >= 20) return;
  await runQAPoll({ weeklySummary: false });
});

// Friday 5:30 PM GDL — weekly team summary
cron.schedule('30 17 * * 5', async () => {
  await runQAPoll({ weeklySummary: true });
}, { timezone: TZ });

// ── EXPRESS — KB WIDGET ENDPOINTS ─────────────────────────────────────────────
const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Health
app.get('/health', (req, res) => {
  res.json({ ok: true, uptime: Math.floor(process.uptime()), lastPoll: cachedQAData.updatedAt });
});

// Full QA summary for KB widget
app.get('/qa/summary', (req, res) => {
  res.json(cachedQAData);
});

// Team averages only
app.get('/qa/team-averages', (req, res) => {
  const teams = Object.values(cachedQAData.teams).map(t => ({
    name: t.name,
    avg: t.avg,
    gradedTickets: t.gradedTickets,
  })).sort((a, b) => (b.avg || 0) - (a.avg || 0));
  res.json({ updatedAt: cachedQAData.updatedAt, week: cachedQAData.weekLabel, teams });
});

// Manual poll trigger (for testing without restarting)
app.post('/qa/poll-now', async (req, res) => {
  const weekly = req.body && req.body.weeklySummary === true;
  res.json({ ok: true, message: `Poll started${weekly ? ' (with weekly summary)' : ''}` });
  setImmediate(() => runQAPoll({ weeklySummary: weekly }));
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`QA Bizee-Bot listening on port ${PORT}`);
  await ensureSheetHeaders();
  await loadAgentTeamMap();
  // Initial poll after 8 seconds
  setTimeout(() => runQAPoll({ weeklySummary: false }), 8000);
});
