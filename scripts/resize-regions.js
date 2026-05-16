// One-shot helper to resize Malta region PNGs from a source folder to public/regions/.
// All overlays stay pixel-aligned with the base because they share the same source canvas.
const sharp = require('sharp')
const path = require('path')
const fs = require('fs')

const SRC = 'C:/Users/Kevin/Desktop/maltamaphq'
const DST = path.join(__dirname, '..', 'public', 'regions')
const SIZE = 2000

const FILES = [
  { src: 'maltapath.png', dst: 'malta-base.png' },
  { src: 'gozo.png',       dst: 'gozo.png' },
  { src: 'commino.png',    dst: 'comino.png' },
  { src: 'north.png',      dst: 'north.png' },
  { src: 'central.png',    dst: 'central.png' },
  { src: 'southeast.png',  dst: 'southeast.png' },
  { src: 'south.png',      dst: 'south.png' },
]

if (!fs.existsSync(DST)) fs.mkdirSync(DST, { recursive: true })

;(async () => {
  for (const f of FILES) {
    const inPath  = path.join(SRC, f.src)
    const outPath = path.join(DST, f.dst)
    await sharp(inPath)
      .resize(SIZE, SIZE, { fit: 'fill' })
      .png({ compressionLevel: 9, palette: true, quality: 90 })
      .toFile(outPath)
    const stat = fs.statSync(outPath)
    console.log(`${f.dst}  ${(stat.size / 1024).toFixed(1)} KB`)
  }
})().catch(e => { console.error(e); process.exit(1) })
