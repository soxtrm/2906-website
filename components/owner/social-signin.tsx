'use client'
// Sign in with Facebook, Google or Apple. The mobile number is still asked
// afterwards and confirmed with a code: that is what links the account to the
// owner's homes in ARGUS, whichever way they signed in. Facebook uses the same
// Meta app as the Facebook Pages feature, so a later "post my homes on my Page"
// needs no second login. Preview: no provider is contacted.
import { useOwner } from '@/lib/owner/store'

export type Provider = 'facebook' | 'google' | 'apple'

const Glyph = ({ p }: { p: Provider }) => p === 'facebook'
  ? <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="10" fill="#1877F2" /><path d="M12.9 10.4h-1.7V16h-2.3v-5.6H7.7V8.6h1.2V7.3c0-1.4.7-2.6 2.7-2.6h1.6v2h-1c-.4 0-.6.2-.6.7v1.2h1.7l-.4 1.8Z" fill="#fff" /></svg>
  : p === 'google'
    ? <svg width="20" height="20" viewBox="0 0 48 48" aria-hidden="true"><path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z" /><path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" /><path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.5 39.6 16.2 44 24 44z" /><path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.3-.4-3.5z" /></svg>
    : <svg width="18" height="20" viewBox="0 0 17 20" aria-hidden="true"><path fill="#111" d="M14 10.6c0-2.6 2.1-3.8 2.2-3.9-1.2-1.8-3.1-2-3.7-2-1.6-.2-3.1.9-3.9.9-.8 0-2-.9-3.4-.9C3.5 4.8 1.9 5.8 1 7.3c-1.8 3.1-.5 7.8 1.3 10.3.9 1.2 1.9 2.6 3.2 2.6 1.3-.1 1.8-.8 3.4-.8s2 .8 3.4.8 2.3-1.3 3.1-2.5c1-1.4 1.4-2.8 1.4-2.9 0 0-2.8-1.1-2.8-4.2zM11.4 3c.7-.9 1.2-2 1-3.2-1 0-2.3.7-3 1.6-.7.8-1.2 2-1.1 3.1 1.2.1 2.3-.6 3.1-1.5z" /></svg>

export function SocialSignIn({ onDone }: { onDone: () => void }) {
  const s = useOwner()
  const go = (p: Provider) => { if (s.signUpWith(p)) onDone() }
  return (
    <div className="ow-social">
      <button type="button" className="ow-social-btn fb" onClick={() => go('facebook')}><Glyph p="facebook" />Continue with Facebook</button>
      {/* Google and Apple come once their apps are registered; the real site offers Facebook only */}
      {s.demo && <button type="button" className="ow-social-btn" onClick={() => go('google')}><Glyph p="google" />Continue with Google</button>}
      {s.demo && <button type="button" className="ow-social-btn" onClick={() => go('apple')}><Glyph p="apple" />Continue with Apple</button>}
      <p className="ow-or"><span>or with email</span></p>
    </div>
  )
}
