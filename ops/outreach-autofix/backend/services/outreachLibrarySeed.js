'use strict'
// ============================================================================
// services/outreachLibrarySeed.js — first-contact message library (Kev, 2026-11-21).
//
// Kev: "Mach du die Templates … 50 verschiedene pro User und der switcht die
// randomisiert." Written by hand (Claude) in the style of Kev's own Saved
// Drafts — no AI rewriting at send time. Rules for every text:
//   - NO greeting. "Good morning/afternoon/evening" is added at the moment of
//     sending, from the recipient's local time (outreachLibrary.greetingFor).
//   - The first paragraph is a short "hope you're well" line; the greeting is
//     joined to it: "Good afternoon, I hope you're well."
//   - No invented facts: no agency names, no "we spoke before", no property
//     details, no time-bound closings ("have a good week").
//   - Signs only as the account's own persona.
// Each text is a fixed, reviewable row in outreach_library_templates (seeded
// once; edits in the CRM are kept, a re-seed never overwrites them).
// ============================================================================

const HOPE = [
  "I hope you're well.",
  "I hope you're keeping well.",
  'I hope all is well with you.',
  'I hope this message finds you well.',
  "I hope you're doing well.",
  'I hope everything is going well on your side.',
  "I trust you're well.",
  'I hope all is good with you.',
  "Hope you're well.",
  'I hope you are having a good day.',
]

const PERSONAS = {
  kev: {
    signature: 'Kevin Eich\nAgent',
    intro: [
      'My name is Kevin and I am an agent and real estate specialist here in Malta.',
      'This is Kevin, an independent real estate agent based in Malta.',
      "I'm Kevin, and I work as a real estate agent here in Malta.",
      'Kevin here, a real estate agent working with tenants and buyers across Malta.',
      'My name is Kevin and I help property owners in Malta find reliable tenants and buyers.',
      'My name is Kevin Eich, a real estate agent here in Malta.',
    ],
  },
  gabriela: {
    signature: 'Gabriela\nRental Agent',
    intro: [
      'My name is Gabriela and I am an agent and real estate specialist here in Malta.',
      'This is Gabriela, a rental agent based in Malta.',
      "I'm Gabriela, and I work as a rental agent here in Malta.",
      'Gabriela here, a rental agent working with tenants and buyers across Malta.',
      'My name is Gabriela and I help property owners in Malta find reliable tenants.',
      'My name is Gabriela, a real estate agent here in Malta.',
    ],
  },
  cedric: {
    signature: 'Cedric\nRental Agent',
    intro: [
      'My name is Cedric and I am an agent and real estate specialist here in Malta.',
      'This is Cedric, a rental agent based in Malta.',
      "I'm Cedric, and I work as a rental agent here in Malta.",
      'Cedric here, a rental agent working with tenants and buyers across Malta.',
      'My name is Cedric and I help property owners in Malta find reliable tenants.',
      'My name is Cedric, a real estate agent here in Malta.',
    ],
  },
}

const CONTEXT = [
  'I am currently working with a strong portfolio of serious and reliable clients who are actively looking, and I would be happy to assist you in securing suitable tenants or buyers.',
  'At the moment I have several serious clients actively looking to rent or buy, and I would be glad to help you find the right match for your property.',
  "I'm currently assisting a number of reliable clients who are searching for their next home, both to rent and to buy.",
  'Several of my clients are actively searching right now, and some of them are ready to move quickly for the right property.',
  'I work with professionals and families relocating to Malta who are looking for well-kept properties.',
  'I have clients ready to view at short notice and would be happy to arrange viewings around your schedule.',
  'My clients are mainly long-term tenants and genuine buyers, so I focus on finding owners a good and lasting fit.',
  "I'm handling a few active searches at the moment, and some of my clients could be a great fit for the right property.",
]

const ASK = [
  'I just wanted to check in and see if you currently have any available properties, or anything upcoming that could be suitable for some of my clients.',
  'Please feel free to send me any available or upcoming properties.',
  'Do you currently have any property available for rent or sale, or anything coming onto the market soon?',
  'If you have anything available now or becoming free in the coming weeks, I would be happy to hear about it.',
  'Would you have any property available at the moment, or something that will become available soon?',
  'If you have a property you would like to rent out or sell, feel free to send me the details and a few photos.',
  'Should you have anything available, or coming up soon, just send me the details and I will take it from there.',
  "I'd be glad to know whether you have any property currently available, or anything you're planning to put on the market.",
]

const CLOSE = [
  'Looking forward to hearing from you.',
  'Thank you, and I look forward to hearing from you.',
  'Many thanks in advance.',
  'Kind regards,',
  'Thank you for your time.',
  'I look forward to your reply.',
  'Thanks a lot, speak soon.',
]

// Kev's own Saved Drafts, greeting removed and typos fixed ("Iam a Agent"),
// time-bound closings dropped. The "we spoke some time ago … towards
// September" draft is NOT included: it is untrue for a cold owner list.
const KEV_DRAFTS = {
  kev: [
    "Hope you're well.\n\nI am currently working with a strong portfolio of serious and reliable clients who are actively looking, and I would be happy to assist you in securing suitable tenants or buyers.\n\nPlease feel free to send me any available or upcoming properties.",
  ],
  gabriela: [
    "Hope you're well.\n\nMy name is Gabriela and I am an agent and real estate specialist.\n\nI just wanted to check in and see if you currently have any available properties, or anything upcoming that could be suitable for some of my clients.\n\nLooking forward to hearing from you.",
  ],
  cedric: [
    "Hope you're well.\n\nMy name is Cedric and I am an agent and real estate specialist.\n\nI just wanted to check in and see if you currently have any available properties, or anything upcoming that could be suitable for some of my clients.\n\nLooking forward to hearing from you.",
  ],
}

const PER_PERSONA = 50

function compose(persona, i) {
  const p = PERSONAS[persona]
  const hope = HOPE[i % HOPE.length]
  const intro = p.intro[(i * 5 + Math.floor(i / 6)) % p.intro.length]
  const context = CONTEXT[(i * 3 + Math.floor(i / 8)) % CONTEXT.length]
  const ask = ASK[(i * 7 + Math.floor(i / 8) * 3) % ASK.length]
  const close = CLOSE[(i * 4 + Math.floor(i / 7)) % CLOSE.length]
  // Three layouts so the shape of the message varies too, not only the words.
  const layout = i % 3
  const parts = layout === 0
    ? [hope, intro, context, ask]
    : layout === 1
      ? [`${hope} ${intro}`, context, ask]
      : [hope, `${intro} ${context}`, ask]
  const sig = close === 'Kind regards,' ? `${close}\n${p.signature}` : `${close}\n\n${p.signature}`
  return `${parts.join('\n\n')}\n\n${sig}`
}

function withSignature(persona, body) {
  return `${body}\n\n${PERSONAS[persona].signature}`
}

function seedRows() {
  const rows = []
  for (const persona of Object.keys(PERSONAS)) {
    const seen = new Set()
    const list = KEV_DRAFTS[persona].map(b => withSignature(persona, b))
    for (const b of list) seen.add(b)
    for (let i = 0; list.length < PER_PERSONA && i < 400; i++) {
      const text = compose(persona, i)
      if (seen.has(text)) continue
      seen.add(text)
      list.push(text)
    }
    list.forEach((body, idx) => rows.push({ persona, number: idx + 1, body, source: idx < KEV_DRAFTS[persona].length ? 'kev_draft' : 'claude_20261121' }))
  }
  return rows
}

module.exports = { seedRows, PERSONAS, PER_PERSONA }
