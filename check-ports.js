const http = require('http');
const check = (port) => new Promise((resolve) => {
  const req = http.request({ hostname: '127.0.0.1', port, path: '/user', method: 'GET', timeout: 3000 }, (res) => {
    resolve({ port, status: res.statusCode });
  });
  req.on('error', (err) => resolve({ port, error: err.message }));
  req.end();
});

(async () => {
  console.log(await check(3000));
  console.log(await check(3001));
})();
