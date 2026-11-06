/**
 * OmniCast Host Input Endpoint (Vercel Serverless Fallback)
 * When running purely on Vercel cloud, host input is simulated visually inside the browser.
 */

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  res.status(200).json({
    ok: true,
    mode: 'serverless-visual'
  });
};
