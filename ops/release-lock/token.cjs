// The release scripts only accept the dedicated release token, passed for one process by
//   powershell -File release-token.ps1 run node <script>.cjs
// They no longer read the shared Vercel CLI login (auth.json).
module.exports = function releaseToken() {
  const t = process.env.VERCEL_TOKEN
  if (!t) { console.error('No release token. Run through: powershell -File release-token.ps1 run node ' + require('path').basename(process.argv[1])); process.exit(2) }
  return t
}
