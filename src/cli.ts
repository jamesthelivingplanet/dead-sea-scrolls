import http from 'node:http';

const command = process.argv[2];
if (command !== 'sync' && command !== 'status') {
  console.error('Usage: node dist/cli.js sync|status');
  process.exit(2);
}

const port = Number(process.env.DSS_CONTROL_PORT) || 32474;
const req = http.request(
  {
    host: '127.0.0.1',
    port,
    path: command === 'sync' ? '/sync' : '/status',
    method: command === 'sync' ? 'POST' : 'GET',
  },
  (res) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      let out = text;
      try {
        out = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* print as is */
      }
      const okStatus = (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300;
      (okStatus ? console.log : console.error)(out);
      process.exit(okStatus ? 0 : 1);
    });
  },
);
req.on('error', (e) => {
  console.error(`Could not reach the control server on 127.0.0.1:${port}: ${e.message}. Is the service running?`);
  process.exit(1);
});
req.end();
