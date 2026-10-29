'use strict'
// ============================================================================
// services/outreachTemplateSeed.js — initial persona template library
// (Kev, 2026-10-29). 3 personas × 3 send-time periods × 4 variants = 36.
//
// Variant 1 of every block is Kev's own wording from the 2026-10-29 brief.
// Variants 2–4 keep the same purpose (clients searching for rentals/sales in
// Malta, interest in available or upcoming properties, optional help with
// marketing and matching) without inventing personal details, client
// commitments or guaranteed demand. The live library is the
// outreach_persona_templates table; this file only seeds missing rows, so
// edits made in the CRM are never overwritten.
// ============================================================================

const TEMPLATES = {
  kev: {
    morning: [
      "Good morning! Kevin here. I'm currently assisting several clients looking for properties to rent or purchase across Malta. If you have anything available or coming onto the market soon, I'd be happy to hear from you. Have a lovely day!",
      "Good morning, I hope your day is off to a good start. My name is Kevin and I work with clients who are looking to rent or buy property in Malta. Do you have anything available at the moment, or something coming up in the next few weeks? Have a great day!",
      "Good morning! This is Kevin. I help property owners find suitable tenants and buyers, and I currently have clients searching for rentals and homes to purchase. If you have a property available or soon to be, I'd be glad to help market it. Have a lovely day!",
      "Good morning! Kevin here, I hope all is well. I'm reaching out to owners who may have a rental or a property for sale coming up. If that's the case for you, feel free to send me the details and I'll let you know if it suits any of the clients I'm working with. Have a good day!",
    ],
    afternoon: [
      "Good afternoon, hope your day is going well! I'm reaching out as I'm working with clients actively searching for rental and sales opportunities. Feel free to share any available or upcoming properties, and I'd be happy to assist.",
      "Good afternoon! Kevin here. I'm currently helping clients who are looking to rent or buy in Malta, and I wanted to ask whether you have any properties available now or coming up soon. I'd be happy to hear from you.",
      "Good afternoon, I hope you're having a good day. This is Kevin, I work with tenants and buyers searching for property across Malta. If you have something available or expected shortly, just send me the details and I'll see if it's a good match.",
      "Good afternoon! Just a short message from Kevin. If you have a property for rent or sale, now or in the near future, I'd be glad to help with marketing it and finding suitable tenants or buyers. Have a lovely afternoon!",
    ],
    evening: [
      "Good evening! Just a quick message from Kevin. I'm currently helping clients with property searches across Malta and would be glad to hear about any properties you have available or coming up soon. Wishing you a pleasant evening!",
      "Good evening, I hope you've had a good day. Kevin here, I'm working with clients looking for rentals and properties to buy in Malta. If you have anything available or coming onto the market, I'd be happy to hear about it. Enjoy your evening!",
      "Good evening! This is Kevin. I help owners find the right tenants and buyers for their properties. If you have something available or opening up soon, feel free to share the details and I'll get back to you. Have a pleasant evening!",
      "Good evening! Kevin here with a short question: do you currently have, or expect to have, a property for rent or sale in Malta? I'm assisting several clients with their search and would be glad to help. Have a lovely evening!",
    ],
  },
  cedric: {
    morning: [
      "Good morning! This is Cedric. I'm working with clients who are currently looking for suitable rental and purchase opportunities in Malta. Please feel free to let me know if you have any properties available or expected soon.",
      "Good morning, I hope you're well. Cedric here. I'm assisting clients who are looking to rent or buy property in Malta, and I'd be glad to know if you have anything available or coming up. Have a good day!",
      "Good morning! My name is Cedric and I help match property owners with suitable tenants and buyers. If you have a property available now or in the coming weeks, I'd be happy to hear about it. Have a nice day!",
      "Good morning! Cedric here. I'm reaching out to owners who may have a rental or sale property coming up. If that applies to you, feel free to send me the details and I'll check whether it fits the clients I'm working with. Have a great day!",
    ],
    afternoon: [
      "Good afternoon! I hope everything is going well. I'm currently assisting clients with their property search and wanted to check whether you have any new or upcoming listings. I'd be happy to help find suitable matches.",
      "Good afternoon! This is Cedric. I'm working with clients looking for rentals and properties to buy across Malta. Do you have anything available at the moment or expected soon? I'd be glad to hear from you.",
      "Good afternoon, I hope your day is going well. Cedric here, I help owners market their properties and find suitable tenants or buyers. If you have something available or coming up, just let me know.",
      "Good afternoon! A short message from Cedric. If you have a property for rent or sale now or in the near future, feel free to share the details. I'd be happy to see whether it suits any of my clients. Have a nice afternoon!",
    ],
    evening: [
      "Good evening! Cedric here. If you have any properties available for rent or sale, or anything becoming available shortly, I'd be happy to assist with finding suitable clients. Enjoy your evening!",
      "Good evening, I hope you've had a good day. This is Cedric, I'm assisting clients who are searching for rentals and homes to buy in Malta. If you have anything available or coming up soon, I'd be glad to hear about it. Have a pleasant evening!",
      "Good evening! Cedric here. I help property owners find the right tenants and buyers. If you have a property available now or in the coming weeks, feel free to send me the details. Wishing you a lovely evening!",
      "Good evening! This is Cedric with a quick question: do you have a property for rent or sale in Malta, or one coming up soon? I'd be happy to help with finding suitable clients. Enjoy your evening!",
    ],
  },
  gabriela: {
    morning: [
      "Good morning! Gabriela here. I'm currently working with clients looking for homes and investment opportunities in Malta. I'd love to hear if you have any properties available now or coming up soon. Have a wonderful day!",
      "Good morning, I hope your day has started well! This is Gabriela. I'm helping clients who want to rent or buy property in Malta, and I'd be happy to know if you have anything available or coming up soon. Have a lovely day!",
      "Good morning! My name is Gabriela and I help owners find suitable tenants and buyers. If you have a property available now or in the coming weeks, I'd be glad to help with marketing it. Have a beautiful day!",
      "Good morning! Gabriela here. I'm reaching out to owners who may have a rental or property for sale coming up. If that's you, feel free to share the details and I'll let you know whether it suits my clients. Have a great day!",
    ],
    afternoon: [
      "Good afternoon, hope you're having a lovely day! I'm helping clients find suitable rental and sales properties and wanted to ask whether you have anything currently available or expected in the near future.",
      "Good afternoon! Gabriela here. I'm working with clients looking for homes to rent or buy across Malta. Do you have anything available at the moment or coming up soon? I'd love to hear from you.",
      "Good afternoon, I hope all is well! This is Gabriela, I help property owners market their homes and find suitable tenants or buyers. If you have something available or expected shortly, just let me know.",
      "Good afternoon! A quick message from Gabriela. If you have a property for rent or sale now or in the near future, feel free to send me the details and I'll see whether it matches any of my clients. Have a lovely afternoon!",
    ],
    evening: [
      "Good evening! This is Gabriela. I'm currently assisting clients with their property search and would be happy to help with any available or upcoming rental or sales listings. Wishing you a lovely evening!",
      "Good evening, I hope you've had a lovely day! Gabriela here. I'm helping clients who are looking for homes and investment properties in Malta. If you have anything available or coming up soon, I'd be glad to hear about it. Enjoy your evening!",
      "Good evening! This is Gabriela. I help owners find the right tenants and buyers for their properties. If you have something available now or soon, feel free to share the details. Have a pleasant evening!",
      "Good evening! Gabriela here with a short question: do you have a property for rent or sale in Malta, now or coming up soon? I'd be happy to help find suitable clients. Have a lovely evening!",
    ],
  },
}

const PERIODS = ['morning', 'afternoon', 'evening']

function seedRows() {
  const rows = []
  for (const [persona, periods] of Object.entries(TEMPLATES)) {
    for (const period of PERIODS) {
      periods[period].forEach((body, i) => rows.push({ persona, period, slot: i + 1, body }))
    }
  }
  return rows
}

module.exports = { TEMPLATES, PERIODS, seedRows }
