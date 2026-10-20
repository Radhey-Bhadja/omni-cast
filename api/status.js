/**
 * OmniCast Serverless Status Endpoint (Vercel)
 */

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  res.status(200).json({
    status: 'online',
    appName: 'OmniCast',
    version: '1.0.0',
    runtime: 'Vercel Serverless Edge/Node',
    signaling: 'WebRTC Direct Mesh + Serverless Gateway',
    timestamp: new Date().toISOString()
  });
};
