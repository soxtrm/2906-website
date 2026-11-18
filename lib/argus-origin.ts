// Single place for the ARGUS backend address.
// Set NEXT_PUBLIC_ARGUS_API_ORIGIN (for example https://api.2906.estate) in the Vercel project; the value is
// used by server routes and by the few client components that talk to the backend directly.
// Without it the previous direct address is used, so a release with this change behaves exactly as before
// until the variable is set.
// The value is cleaned of invisible characters and whitespace that a shell or a copy-paste can add.
export const ARGUS_ORIGIN = (
  process.env.NEXT_PUBLIC_ARGUS_API_ORIGIN ||
  process.env.ARGUS_API_ORIGIN ||
  'http://178.104.162.193:3001'
).replace(/[^\x21-\x7E]/g, '').replace(/\/+$/, '')
