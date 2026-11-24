/**
 * OmniCast Dynamic STUN/TURN Relays Endpoint (Vercel Serverless)
 */

module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const turnUrl = process.env.TURN_URL || 'turn:openrelay.metered.ca:443';
  const turnUsername = process.env.TURN_USERNAME || 'openrelayproject';
  const turnCredential = process.env.TURN_CREDENTIAL || 'openrelayproject';

  res.status(200).json({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
      {
        urls: [turnUrl, 'turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443?transport=tcp'],
        username: turnUsername,
        credential: turnCredential
      }
    ]
  });
};
