'use strict'
// Resize logo-icon.png to 32x32 for Next.js favicon using jimp
const { Jimp } = require('jimp')

;(async () => {
  const img = await Jimp.read('C:/Users/Kevin/2906-website/public/logo-icon.png')
  await img.resize({ w: 32, h: 32 }).write('C:/Users/Kevin/2906-website/app/icon.png')
  console.log('Written: app/icon.png (32x32)')

  // Also 180x180 for apple-touch-icon
  const img2 = await Jimp.read('C:/Users/Kevin/2906-website/public/logo-icon.png')
  await img2.resize({ w: 180, h: 180 }).write('C:/Users/Kevin/2906-website/app/apple-icon.png')
  console.log('Written: app/apple-icon.png (180x180)')
})().catch(e => { console.error(e.message); process.exit(1) })
