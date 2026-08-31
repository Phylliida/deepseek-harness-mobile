// Logging MITM in front of the dsh web server: observe exactly what Firefox
// sends, especially the WebSocket upgrade on /api/events.mux.
import http from 'node:http'
import net from 'node:net'

const LISTEN_PORT = 3080
const TARGET_PORT = 3081

const server = http.createServer((req, res) => {
  const interesting = req.url.startsWith('/api')
  if (interesting) {
    console.log(`\n[HTTP] ${req.method} ${req.url}`)
    console.log(`  host: ${req.headers.host}  origin: ${req.headers.origin ?? '-'}  sec-fetch-site: ${req.headers['sec-fetch-site'] ?? '-'}`)
  }
  const proxy = http.request(
    { host: '127.0.0.1', port: TARGET_PORT, path: req.url, method: req.method, headers: req.headers },
    (proxyRes) => {
      if (interesting) console.log(`  -> ${proxyRes.statusCode}`)
      res.writeHead(proxyRes.statusCode, proxyRes.headers)
      proxyRes.pipe(res)
    },
  )
  proxy.on('error', (e) => { console.log(`  proxy error: ${e.message}`); res.destroy() })
  req.pipe(proxy)
})

// Minimal WS frame decoder for logging: [dir] opcode len payload-preview.
function makeFrameSniffer(tag) {
  let buf = Buffer.alloc(0)
  let pastHeaders = false
  return (chunk) => {
    buf = Buffer.concat([buf, chunk])
    if (!pastHeaders) {
      const idx = buf.indexOf('\r\n\r\n')
      if (idx === -1) { console.log(`  [${tag}] headers: ${JSON.stringify(buf.subarray(0, 300).toString('latin1'))}`); buf = Buffer.alloc(0); return }
      console.log(`  [${tag}] handshake done`)
      buf = buf.subarray(idx + 4)
      pastHeaders = true
    }
    while (buf.length >= 2) {
      const fin = (buf[0] & 0x80) !== 0
      const op = buf[0] & 0x0f
      const masked = (buf[1] & 0x80) !== 0
      let len = buf[1] & 0x7f
      let off = 2
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4 }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10 }
      const maskOff = off
      if (masked) off += 4
      if (buf.length < off + len) return
      let payload = buf.subarray(off, off + len)
      if (masked) {
        const mask = buf.subarray(maskOff, maskOff + 4)
        payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]))
      }
      console.log(`  [${tag}] frame op=0x${op.toString(16)} fin=${fin} len=${len} payload=${JSON.stringify(payload.subarray(0, 500).toString('latin1'))}`)
      buf = buf.subarray(off + len)
    }
  }
}

server.on('upgrade', (req, socket, head) => {
  console.log(`\n[UPGRADE] ${req.url}`)
  for (const [k, v] of Object.entries(req.headers)) console.log(`  ${k}: ${v}`)
  const target = net.connect(TARGET_PORT, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`]
    for (const [k, v] of Object.entries(req.headers)) lines.push(`${k}: ${v}`)
    target.write(lines.join('\r\n') + '\r\n\r\n')
    if (head?.length) target.write(head)
    const sniffC2S = makeFrameSniffer('browser->server')
    const sniffS2C = makeFrameSniffer('server->browser')
    socket.on('data', sniffC2S)
    target.on('data', sniffS2C)
    socket.pipe(target).pipe(socket)
    // Headless runs and tab closes reset sockets; a reset must not kill the MITM.
    socket.on('error', () => {})
  })
  target.on('error', (e) => { console.log(`  target error: ${e.message}`); socket.destroy() })
})

// A TLS ClientHello (wss:// after an HTTPS-First rewrite) hitting our plain
// HTTP port surfaces as an HTTP parse error.
server.on('clientError', (err, socket) => {
  console.log(`\n[clientError on 3080] ${err.code ?? err.message} — likely TLS/wss bytes sent to a plain HTTP port`)
  socket.destroy()
})

server.listen(LISTEN_PORT, '0.0.0.0', () => console.log(`mitm on :${LISTEN_PORT} -> :${TARGET_PORT}`))
