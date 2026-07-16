// Vercel serverless function — generic lead handler for ALL factory landing pages.
// POST /api/lead — identical contract to the per-page handlers it replaces (ads5/ads6),
// but page specifics (adsName, labels, allowed dropdown options) are loaded at runtime
// from pages/<variant>.json based on the `variant` the form already sends.
// Side effects preserved 1:1: Coconut OS upsert + ads_name PATCH, Slack (meet-main setup),
// Meta CAPI Lead at stage 'partial' with eventId dedup, optional META_TEST_EVENT_CODE.

import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const LEAD_TAG = 'Ads';
const PAGE_URL = process.env.PAGE_URL || '';

async function loadPageConfig(variant) {
  if (!/^[a-z0-9-]{3,60}$/.test(variant || '')) return null;
  try {
    const raw = await readFile(path.join(process.cwd(), 'pages', variant + '.json'), 'utf8');
    const cfg = JSON.parse(raw);
    return {
      adsName: cfg.adsName,
      pageLabel: cfg.pageLabel,
      sourceInfo: `Meta Ads — ${cfg.pageLabel} (Vercel LP)`,
      contentName: cfg.adsName,
      contentCategory: `${cfg.pageLabel} Ad`,
      validNeeds: cfg.form.needOptions,
      hoursOptions: (cfg.form.hours && cfg.form.hours.options) || null
    };
  } catch {
    return null;
  }
}

const VALID_TIMELINES = [
  'ASAP (within 2 weeks)',
  'Within the next month',
  '1 to 3 months',
  '3 to 6 months',
  'Just exploring for now'
];
const STAGES = ['partial', 'partial2', 'complete'];

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'method_not_allowed' });
  }

  const raw = await readJson(req);
  const page = await loadPageConfig(raw && raw.variant);
  // Attribution: default stays "Meta Ads — …" exactly as before. We flip to Google Ads ONLY
  // on explicit Google click signals in the landing URL (gclid/gbraid/wbraid or utm_source=google),
  // so existing Meta traffic and organic behavior are byte-for-byte unchanged.
  const attribution = parseAttribution((raw && raw.sourceUrl) || '');
  if (page && attribution.isGoogle) {
    page.sourceInfo = page.sourceInfo.replace(/^Meta Ads/, 'Google Ads');
  }
  if (!page) return res.status(400).json({ ok: false, error: 'unknown_variant' });
  const stage = STAGES.includes(raw && raw.stage) ? raw.stage : 'complete';
  const name = clean(raw && raw.name, 120);
  const email = clean(raw && raw.email, 160).toLowerCase();
  const company = clean(raw && raw.company, 160);
  const primaryNeed = page.validNeeds.includes(raw && raw.primaryNeed) ? raw.primaryNeed : null;
  const helpHours = (page.hoursOptions && page.hoursOptions.includes(raw && raw.helpHours)) ? raw.helpHours : null;
  const phone = clean(raw && raw.phone, 40);
  const hiringTimeline = VALID_TIMELINES.includes(raw && raw.hiringTimeline) ? raw.hiringTimeline : null;
  const userAgent = clean(raw && raw.userAgent, 400) || (req.headers['user-agent'] || '');
  const fbp = clean(raw && raw.fbp, 200);
  const fbc = clean(raw && raw.fbc, 400);
  const sourceUrl = clean(raw && raw.sourceUrl, 500) || PAGE_URL;
  const clientIp = clientIpFrom(req);

  if (!email || !isEmail(email)) return res.status(400).json({ ok: false, error: 'invalid_email' });
  if (!name) return res.status(400).json({ ok: false, error: 'missing_name' });

  const parts = name.split(/\s+/);
  const firstName = parts.shift() || null;
  const lastName = parts.length ? parts.join(' ') : null;

  const supaUrl = process.env.SUPABASE_OS_URL;
  const supaKey = process.env.SUPABASE_OS_SERVICE_ROLE_KEY;
  if (!supaUrl || !supaKey) {
    console.error('SUPABASE env vars missing');
    return res.status(500).json({ ok: false, error: 'config_missing' });
  }

  // 1. Upsert into Coconut OS (always). primaryNeed rides in the p_ap_tool slot (see note above).
  let contactId = null;
  try {
    const r = await fetch(`${supaUrl}/rest/v1/rpc/upsert_ad_lead`, {
      method: 'POST',
      headers: {
        apikey: supaKey,
        Authorization: `Bearer ${supaKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        p_email: email,
        p_full_name: name,
        p_first_name: firstName,
        p_last_name: lastName,
        p_company: company || null,
        p_ap_tool: primaryNeed,
        p_lead_tag: LEAD_TAG,
        p_source_info: page.sourceInfo,
        p_phone: phone || null,
        p_hiring_timeline: hiringTimeline
      })
    });
    if (!r.ok) {
      console.error('Supabase upsert failed', r.status, await r.text());
      return res.status(502).json({ ok: false, error: 'db_upsert_failed' });
    }
    const body = await r.json();
    contactId = typeof body === 'string' ? body : (body && body[0]) || null;
  } catch (e) {
    console.error('Supabase exception', e);
    return res.status(502).json({ ok: false, error: 'db_exception' });
  }

  // 1b. Stamp contacts.ads_name with this page's name (non-fatal if the column is missing).
  if (contactId) {
    await safe(async () => {
      const r = await fetch(`${supaUrl}/rest/v1/contacts?id=eq.${encodeURIComponent(contactId)}`, {
        method: 'PATCH',
        headers: {
          apikey: supaKey,
          Authorization: `Bearer ${supaKey}`,
          'Content-Type': 'application/json',
          Prefer: 'return=minimal'
        },
        body: JSON.stringify({ ads_name: page.adsName, ...(helpHours ? { help_hours: helpHours } : {}) })
      });
      if (!r.ok) {
        console.error('ads_name PATCH failed (column missing? run: ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS ads_name text;)', r.status, await r.text());
      }
    }, 'ads_name');
  }

  // 1c. Attribution stamp (Google Ads closed-loop). Click ids are FIRST-touch: never overwrite
  // an existing one (the 63-day window runs from the first click). UTMs are last-touch.
  // Non-fatal by design — a stamp failure must never block the lead.
  if (contactId && attribution.hasAny) {
    await safe(async () => {
      const headers = {
        apikey: supaKey,
        Authorization: `Bearer ${supaKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal'
      };
      const patch = { ...attribution.utms };
      const hasNewClickId = Object.keys(attribution.clickIds).length > 0;
      if (hasNewClickId) {
        // first-touch check: only write click ids if none is stored yet
        const chk = await fetch(
          `${supaUrl}/rest/v1/contacts?id=eq.${encodeURIComponent(contactId)}&select=gclid,gbraid,wbraid`,
          { headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` } }
        );
        const rows = chk.ok ? await chk.json() : [];
        const cur = (rows && rows[0]) || {};
        if (!cur.gclid && !cur.gbraid && !cur.wbraid) {
          Object.assign(patch, attribution.clickIds, { first_click_at: new Date().toISOString() });
        }
      }
      if (Object.keys(patch).length === 0) return;
      const r = await fetch(`${supaUrl}/rest/v1/contacts?id=eq.${encodeURIComponent(contactId)}`, {
        method: 'PATCH', headers, body: JSON.stringify(patch)
      });
      if (!r.ok) console.error('attribution PATCH failed', r.status, await r.text());
    }, 'attribution');
  }

  const eventId = `lead_${contactId || Date.now()}`;

  // 2. Side effects per stage. Slack = meet-main setup (bot token → lm_submissions, webhook fallback).
  //    Meta CAPI Lead fires at 'partial' — same as ads4 — deduped with the browser event via eventId.
  if (stage === 'complete') {
    await safe(() => notifySlackComplete({ name, email, company, primaryNeed, helpHours, phone, hiringTimeline, page }), 'slack:complete');
  } else if (stage === 'partial2') {
    await safe(() => notifySlackPartial2({ name, email, company, primaryNeed, helpHours, page }), 'slack:partial2');
  } else {
    await safe(() => notifySlackPartial({ name, email, page }), 'slack:partial');
    await safe(() => sendCapi({ email, phone, userAgent, eventId, fbp, fbc, sourceUrl, clientIp, page }), 'capi');
  }

  return res.status(200).json({ ok: true, contactId, eventId, stage });
}

/* ===================== META CAPI ===================== */

async function sendCapi({ email, phone, userAgent, eventId, fbp, fbc, sourceUrl, clientIp, page }) {
  const pixelId = process.env.META_PIXEL_ID;
  const token   = process.env.META_CAPI_ACCESS_TOKEN;
  if (!pixelId || !token) { console.warn('Meta secrets missing — CAPI skipped'); return; }
  const phoneDigits = digits(phone);
  const body = {
    data: [{
      event_name: 'Lead',
      event_time: Math.floor(Date.now() / 1000),
      action_source: 'website',
      event_id: eventId,
      event_source_url: sourceUrl || PAGE_URL,
      user_data: {
        em: [sha256(email)],
        ...(phoneDigits ? { ph: [sha256(phoneDigits)] } : {}),
        ...(userAgent ? { client_user_agent: userAgent } : {}),
        ...(fbp ? { fbp } : {}),
        ...(fbc ? { fbc } : {}),
        ...(clientIp ? { client_ip_address: clientIp } : {})
      },
      custom_data: { content_name: page.contentName, content_category: page.contentCategory }
    }],
    ...(process.env.META_TEST_EVENT_CODE ? { test_event_code: process.env.META_TEST_EVENT_CODE } : {})
  };
  const r = await fetch(`https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!r.ok) console.error('CAPI error', r.status, await r.text());
}

/* ===================== SLACK ===================== */
// Identical setup to meet-main: Slack Web API (chat.postMessage) with a bot token + channel id
// ("Coconut RB2B Scraper" bot, xoxb + chat:write). Falls back to an incoming webhook URL if
// SLACK_BOT_TOKEN is not set. Channel defaults to the lm_submissions channel.
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID || 'C0BFD2YJDCY';

async function notifySlackComplete({ name, email, company, primaryNeed, helpHours, phone, hiringTimeline, page }) {
  await postSlack({
    text: `🥥 New lead — ${page.pageLabel}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: `🥥 New lead — ${page.pageLabel}` } },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: `*Name:*\n${name}` },
        { type: 'mrkdwn', text: `*Email:*\n${email}` },
        { type: 'mrkdwn', text: `*Company:*\n${company || '—'}` },
        { type: 'mrkdwn', text: `*Primary need:*\n${primaryNeed || '—'}` },
        ...(page.hoursOptions ? [{ type: 'mrkdwn', text: `*Hours needed:*\n${helpHours || '—'}` }] : []),
        { type: 'mrkdwn', text: `*Phone:*\n${phone || '—'}` },
        { type: 'mrkdwn', text: `*Hiring:*\n${hiringTimeline || '—'}` }
      ]},
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Source: ${page.sourceInfo}` }] }
    ]
  }, 'complete');
}

async function notifySlackPartial2({ name, email, company, primaryNeed, helpHours, page }) {
  await postSlack({
    text: `🟠 Partial lead (step 2) — ${page.pageLabel}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '🟠 Partial lead — step 2 of 3' } },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: `*Name:*\n${name}` },
        { type: 'mrkdwn', text: `*Email:*\n${email}` },
        { type: 'mrkdwn', text: `*Company:*\n${company || '—'}` },
        { type: 'mrkdwn', text: `*Primary need:*\n${primaryNeed || '—'}` },
        ...(page.hoursOptions ? [{ type: 'mrkdwn', text: `*Hours needed:*\n${helpHours || '—'}` }] : []),
      ]},
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Phone / hiring timeline not yet provided. Source: ${page.sourceInfo}` }] }
    ]
  }, 'partial2');
}

async function notifySlackPartial({ name, email, page }) {
  await postSlack({
    text: `🟡 Partial lead (step 1) — ${page.pageLabel}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '🟡 Partial lead — step 1 of 3' } },
      { type: 'section', fields: [
        { type: 'mrkdwn', text: `*Name:*\n${name}` },
        { type: 'mrkdwn', text: `*Email:*\n${email}` }
      ]},
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Name + email captured. Source: ${page.sourceInfo}` }] }
    ]
  }, 'partial');
}

async function postSlack(payload, tag) {
  const token = process.env.SLACK_BOT_TOKEN;
  const webhook = process.env.SLACK_WEBHOOK_LEADS;

  // Preferred: Web API chat.postMessage (bot token + channel id).
  if (token) {
    const r = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ channel: SLACK_CHANNEL_ID, ...payload })
    });
    // chat.postMessage returns HTTP 200 even on logical errors — must check body.ok.
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body.ok) console.error(`Slack chat.postMessage (${tag}) error`, r.status, body && body.error);
    return;
  }

  // Fallback: incoming webhook URL.
  if (webhook) {
    const r = await fetch(webhook, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!r.ok) console.error(`Slack webhook (${tag}) error`, r.status, await r.text());
    return;
  }

  console.warn(`Slack not configured — ${tag} skipped`);
}

/* ===================== HELPERS ===================== */

// Parses ad-click identifiers + UTMs out of the landing URL for the Google Ads
// closed-loop pipeline (marketing.v_google_ads_conversions reads them off contacts).
function parseAttribution(sourceUrl) {
  const out = { clickIds: {}, utms: {}, isGoogle: false, hasAny: false };
  let u;
  try { u = new URL(String(sourceUrl)); } catch { return out; }
  const p = u.searchParams;
  for (const k of ['gclid', 'gbraid', 'wbraid']) {
    const v = (p.get(k) || '').trim();
    if (v) { out.clickIds[k] = v.slice(0, 200); out.hasAny = true; }
  }
  for (const k of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) {
    const v = (p.get(k) || '').trim();
    if (v) { out.utms[k] = v.slice(0, 200); out.hasAny = true; }
  }
  out.isGoogle = Boolean(out.clickIds.gclid || out.clickIds.gbraid || out.clickIds.wbraid) ||
    /^google$/i.test(p.get('utm_source') || '');
  return out;
}

function clean(v, max) { return (typeof v === 'string' ? v : '').trim().slice(0, max); }
function isEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }
function digits(s) { return String(s || '').replace(/\D/g, ''); }
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function clientIpFrom(req) {
  const xfwd = req.headers['x-forwarded-for'];
  if (typeof xfwd === 'string' && xfwd) return xfwd.split(',')[0].trim();
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real) return real.trim();
  return (req.socket && req.socket.remoteAddress) || '';
}

async function safe(fn, tag) {
  try { await fn(); } catch (e) { console.error(`Side-effect ${tag} failed`, e); }
}

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return await new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}
