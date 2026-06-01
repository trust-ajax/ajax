// One-time helper: visit /api/strava-subscribe once after deployment to
// register the webhook subscription with Strava.
// Strava will immediately send a GET verification to /api/strava-webhook.
module.exports = async function handler(req, res) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const callbackUrl = process.env.STRAVA_WEBHOOK_CALLBACK_URL ||
    `${proto}://${host}/api/strava-webhook`;

  const body = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID,
    client_secret: process.env.STRAVA_CLIENT_SECRET,
    callback_url: callbackUrl,
    verify_token: process.env.STRAVA_WEBHOOK_VERIFY_TOKEN,
  });

  try {
    const r = await fetch('https://www.strava.com/api/v3/push_subscriptions', {
      method: 'POST',
      body,
    });
    const data = await r.json();
    res.json({ callbackUrl, strava: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
