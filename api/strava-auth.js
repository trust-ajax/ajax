// Handles two roles:
//   GET /api/strava-auth          → redirects browser to Strava OAuth consent screen
//   GET /api/strava-auth?code=... → exchanges code, stores tokens, backfills activities
const { createClient } = require('@supabase/supabase-js');

const SCOPE = 'activity:read_all';

function supa() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );
}

function redirectUri(req) {
  if (process.env.STRAVA_REDIRECT_URI) return process.env.STRAVA_REDIRECT_URI;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${host}/api/strava-auth`;
}

module.exports = async function handler(req, res) {
  const { code, error } = req.query;

  // Step 1 — no code yet: redirect user to Strava
  if (!code && !error) {
    const url = new URL('https://www.strava.com/oauth/authorize');
    url.searchParams.set('client_id', process.env.STRAVA_CLIENT_ID);
    url.searchParams.set('redirect_uri', redirectUri(req));
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('approval_prompt', 'auto');
    url.searchParams.set('scope', SCOPE);
    return res.redirect(302, url.toString());
  }

  if (error) return res.redirect(302, '/gym.html?strava=error');

  // Step 2 — exchange code for tokens
  try {
    const tokenRes = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        code,
        grant_type: 'authorization_code',
      }),
    });
    const token = await tokenRes.json();
    if (!token.access_token) throw new Error(`No access_token: ${JSON.stringify(token)}`);

    const db = supa();
    await db.from('strava_tokens').upsert({
      id: 1,
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: token.expires_at,
      athlete_id: token.athlete?.id,
      athlete_firstname: token.athlete?.firstname,
      athlete_lastname: token.athlete?.lastname,
    });

    // Backfill the most recent 30 activities on first connect
    await backfill(db, token.access_token, 30);

    res.redirect(302, '/gym.html?strava=connected');
  } catch (e) {
    console.error('[strava-auth]', e);
    res.redirect(302, '/gym.html?strava=error');
  }
};

async function backfill(db, accessToken, count) {
  const r = await fetch(
    `https://www.strava.com/api/v3/athlete/activities?per_page=${count}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const list = await r.json();
  if (!Array.isArray(list) || !list.length) return;
  await db.from('strava_activities').upsert(list.map(toRow), { onConflict: 'id' });
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
