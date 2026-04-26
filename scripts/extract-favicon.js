'use strict'
const fs   = require('fs')
const path = require('path')

const svgPath = process.argv[2] || 'C:/Users/Kevin/Downloads/2906logogoo.svg'
const src = fs.readFileSync(svgPath, 'utf8')

// Extract base64 PNG from href="data:image/png;base64,..."
const match = src.match(/href="data:image\/png;base64,([^"]+)"/)
if (!match) { console.error('No embedded PNG found'); process.exit(1) }

const buf = Buffer.from(match[1], 'base64')
const outFull = 'C:/Users/Kevin/2906-website/public/logo-icon.png'
fs.writeFileSync(outFull, buf)
console.log('Saved full-size PNG:', outFull, buf.length, 'bytes')

// Write metadata for jimp step
fs.writeFileSync('/tmp/favicon-b64.txt', match[1])
console.log('B64 written to /tmp/favicon-b64.txt')
