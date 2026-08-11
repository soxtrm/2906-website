// Minimal HTTPS front for the local production server, so the page can be
// loaded as the genuine origin https://crm.2906.estate (with Chrome's host
// resolver pointed at 127.0.0.1). That makes the Referer Google sees real,
// instead of a header we rewrote ourselves.
const https = require('https')
const http = require('http')
const fs = require('fs')

const cert = fs.readFileSync(process.env.TLS_CERT || '/tmp/tlsprobe/cert.pem')
const key = fs.readFileSync(process.env.TLS_KEY || '/tmp/tlsprobe/key.pem')
const PORT = Number(process.env.TLS_PORT || 443)
const TARGET = { host: '127.0.0.1', port: Number(process.env.TARGET_PORT || 3000) }

https.createServer({ cert, key }, (req, res) => {
  const proxy = http.request(
    { host: TARGET.host, port: TARGET.port, method: req.method, path: req.url, headers: req.headers },
    up => {
      res.writeHead(up.statusCode, up.headers)
      up.pipe(res)
    })
  proxy.on('error', e => { res.writeHead(502); res.end(`proxy error: ${e.message}`) })
  req.pipe(proxy)
}).listen(PORT, () => console.log(`https://crm.2906.estate:${PORT} → http://127.0.0.1:${TARGET.port}`))
