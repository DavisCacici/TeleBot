const http = require('http');

let inputData = '';
process.stdin.setEncoding('utf8');

process.stdin.on('data', chunk => {
  inputData += chunk;
});

process.stdin.on('end', () => {
  const hookType = process.argv[2] || 'unknown';

  let payload = {};
  try {
    const cleaned = inputData.trim().replace(/^\uFEFF/, '');
    if (cleaned) {
      payload = JSON.parse(cleaned);
    }
  } catch (err) {
    payload = { parseError: err.message, raw: inputData };
  }

  const postData = JSON.stringify({
    hookType,
    fromTelegram: process.env.AGY_FROM_TELEGRAM === '1',
    payload
  });

  const req = http.request({
    hostname: '127.0.0.1',
    port: parseInt(process.env.HOOK_PORT || '37482', 10),
    path: '/hook',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    },
    timeout: 65000
  }, (res) => {
    let resData = '';
    res.on('data', chunk => { resData += chunk; });
    res.on('end', () => {
      process.stdout.write(resData || '{}');
      process.exit(0);
    });
  });

  req.on('error', (err) => {
    // Se il server del bot non risponde (bot spento), accetta di default per non bloccare
    if (hookType === 'PreToolUse') {
      process.stdout.write(JSON.stringify({ decision: 'allow' }));
    } else {
      process.stdout.write('{}');
    }
    process.exit(0);
  });

  req.on('timeout', () => {
    req.destroy();
    // Se scade il timeout di rete, accetta di default
    if (hookType === 'PreToolUse') {
      process.stdout.write(JSON.stringify({ decision: 'allow' }));
    } else {
      process.stdout.write('{}');
    }
    process.exit(0);
  });

  req.write(postData);
  req.end();
});
