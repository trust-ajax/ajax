// Handles Strava webhook events:
//   GET  /api/strava-webhook  → subscription verification handshake
//   POST /api/strava-webhook  → new/updated/deleted activity event
const { createClient } = require('@supabase/supabase-js');

function supa() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}

module.exports = async function handler(req, res) {
  // Webhook subscription verification (Strava sends GET with a challenge)
  if (req.method === 'GET') {
    const verify = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (verify === process.env.STRAVA_WEBHOOK_VERIFY_TOKEN) {
      return res.json({ 'hub.challenge': challenge });
    }
    return res.status(403).end();
  }

  if (req.method !== 'POST') return res.status(405).end();

  const { object_type, object_id, aspect_type } = req.body || {};

  // Acknowledge immediately — Strava requires a response within 2 seconds
  res.json({ ok: true });

  if (object_type !== 'activity') return;

  const db = supa();

  if (aspect_type === 'delete') {
    await db.from('strava_activities').delete().eq('id', object_id);
    return;
  }

  if (aspect_type !== 'create' && aspect_type !== 'update') return;

  const { data: tokenRow, error } = await db
    .from('strava_tokens').select('*').eq('id', 1).single();
  if (error || !tokenRow) return;

  const accessToken = await validToken(db, tokenRow);
  if (!accessToken) return;

  try {
    const r = await fetch(
      `https://www.strava.com/api/v3/activities/${object_id}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const a = await r.json();
    if (!a.id) return;
    await db.from('strava_activities').upsert(toRow(a), { onConflict: 'id' });
  } catch (e) {
    console.error('[strava-webhook] fetch activity error:', e);
  }
};

async function validToken(db, row) {
  // Use existing token if it expires more than 5 minutes from now
  if (Date.now() / 1000 < row.expires_at - 300) return row.access_token;
  try {
    const r = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        refresh_token: row.refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    const data = await r.json();
    if (!data.access_token) return null;
    await db.from('strava_tokens').update({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: data.expires_at,
    }).eq('id', 1);
    return data.access_token;
  } catch (e) { return null; }
}

function toRow(a) {
  return {
    id: a.id,
    name: a.name,
    sport_type: a.sport_type || a.type,
    start_date: a.start_date,
    distance: a.distance || 0,
    moving_time: a.moving_time || 0,
    total_elevation_gain: a.total_elevation_gain || 0,
    average_speed: a.average_speed || 0,
    average_heartrate: a.average_heartrate || null,
    max_heartrate: a.max_heartrate || null,
    suffer_score: a.suffer_score || null,
    data: a,
  };
}
