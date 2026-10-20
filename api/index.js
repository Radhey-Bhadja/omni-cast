/**
 * OmniCast Vercel Serverless Function Entrypoint
 */
module.exports = (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.status(200).json({
    status: 'online',
    app: 'OmniCast',
    version: '1.0.0',
    mode: 'Vercel Serverless'
  });
};
