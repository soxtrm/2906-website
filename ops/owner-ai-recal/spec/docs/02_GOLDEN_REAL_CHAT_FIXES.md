# GOLDEN CASES: WHAT THE BOT SHOULD HAVE DONE

These are expert annotations of the eleven screenshots shared by the founder on 10 Nov 2026. **Anonymized excerpts**: the screenshots contain names, phone numbers, private addresses and image previews; don't publish or use raw owner details in ordinary QA logs. Gold replies are *illustrative correct next responses*, not authorizations to send to real contacts. Content and account affiliation must be validated against actual owner/agent context at the time.

In all cases the expected response MUST pass identity, quiet-hours, DNC, consent, Auto/Pause, human-agent and stale-message checks before sending. A correct DRAFT is not permission to send.

## S01 — Person asks 'Are you an agent in Malta, or do you have your own properties?'

**Observed:** Bot asked rent, then bedrooms, then bathrooms while the sender replied `i am agent also`, `and we have a variety`, `of clients`, `i asked u a questions lol`, `r u an agent or urs`. The other party has not identified a specific apartment to rent.

**Interpretation:** `owner_role=AGENT` or at least real-estate intermediary; `intent=IDENTITY_QUESTION`; zero active specific property; questions directed at the bot have been unanswered repeatedly. Incoming `Thank you for contacting Gabriella` is an automated greeting, not the owner's identity.

**Expected action:** `ANSWER_DIRECT`, possibly followed by brief agent-to-agent cooperation question; no property extraction questions yet. Verify current Cedric identity and firm (historically QuickLets).

**Gold reply:**
> "Sorry, I missed your question. Yes, I’m a real estate agent here in Malta, working with QuickLets. I’m contacting you about potential property opportunities for clients, not because I own properties myself. I understand you're an agent too, so happy to coordinate if we have suitable requirements."

**Do not say:** `Roughly what's the rent?`; `How many bedrooms?`; `And how many bathrooms?` unless a concrete property is actively being discussed and the identity question has been settled. No fabricated business affiliation if the sender profile does not verify it.

## S02 — Villa Iris: owner sends complete details, media, address, and offers a viewing

**Observed:** `Villa ... available 4th December`, `4 bedroom + office`, `3 car garage connected by lift`, `salt pool and outdoor living`, `Price €5,600`, photo set, address, then `Viewing possible tomorrow at 3.00 pm, today tenant is not there`. Bot replied as if the property were unavailable and as if the owner had already found tenants.

**Interpretation:** Long-let villa offer; owner is sharing full listing information and a **proposed** viewing slot. `available_from=Dec 4` (year anchored by message timestamp), bedrooms 4, office separate, garage 3 cars, lift, pool, quoted rent 5600/month if context establishes monthly, viewable tomorrow 15:00 (not booked). Move-in date separate from viewing date. Photo bindings attached to same villa candidate.

**Expected action:** `ACKNOWLEDGE_UPDATE` + `HUMAN_HANDOFF` for time-sensitive viewing; assign/alert correct agent. Do not book or promise attendance without client confirmation.

**Gold reply:**
> "Thank you for the villa details and the photos. I’ve noted the address and that a viewing may be possible tomorrow at 3:00 pm. I’ll check with the client and come back to confirm before treating the slot as booked."

**Do not say:** `Hope you found the right tenants`; `It's rented`; `Don't worry` followed by a generic goodbye. Avoid asking bedrooms, garage or availability again.

## S03 — Residential apartments are called residential; bot requests a permit

**Observed:** An agent shares two residential apartments and other units/listing cards. Bot asks `what is the space intended or permitted for?`; owner clarifies `They’re both residential apartments`; bot asks `Could you tell me the permit or licence status?`; owner replies `I'm not sure what you mean`; bot jumps to sqm.

**Interpretation:** The two identified flats are residential. Commercial permit investigation is inapplicable to the residential records. Property facts for each unit must not be merged. If commercial listings appear later, they are separate records with different requirements. Source cards and prices need individual binding.

**Expected action:** First apologize for confusion, withdraw wrong question, acknowledge residential use and save that. Only ask one relevant missing question when necessary; if the owner offers phone contact, handoff instead.

**Gold reply (immediately after 'I'm not sure what you mean'):**
> "Sorry, I phrased that badly. I was asking about the permitted use, but you’ve already confirmed these are residential apartments, so there’s nothing further needed on that point. Thanks for clarifying."

**Do not say:** `What is the approximate size?` while prior question remains unexplained. Never ask commercial permit for an ordinary home.

## S04 — Owner asks for a call after providing size and other listings

**Observed:** `They're both around 90sqm`, `Give me a call if you need more info`, `We also have these listed` followed by distinct commercial property cards. Bot previously interrogated permit then size.

**Interpretation:** Both residential flats each ~90 sqm (unless known otherwise), telephone follow-up offered/requested; attached cards may represent additional units. This is a high-value agent-to-agent lead, not an open-ended bot questionnaire.

**Expected action:** `HUMAN_HANDOFF`, create callback task for assigned agent, save scope, queue separate commercial property candidates if identifiable; no claims that phone call already took place.

**Gold reply:**
> "Thanks, that helps. I’ve noted approximately 90 sqm for each residential apartment, and I’ll pass your request for a call to the agent handling this. I've also received the additional listings and will keep them separate from the two apartments."

If the human agent is already handling it, `NO_SEND` and internal notification may be preferable.

## S05 — Owner explicitly confirms availability and corrects price

**Observed:** Bot asks whether listing with reference/price €2,649 is available. Owner says `It's 2,800` and `And yes it's available`; bot replies `Sorry to hear — is it rented, or just on a break for now?`; owner says `It's available`, `Why sorry to hear?`, `My tenant leaves on the 20th November`. Older note: `flat will be available mid December`.

**Interpretation:** Owner authoritative price update to €2,800; marketable/being offered yes. Occupancy ends 20 Nov; earliest possible move-in unknown, earlier mid-Dec statement may coexist due to preparation time. Do not invent readiness Nov 20 or silently overwrite earlier mid-Dec availability without evidence.

**Expected action:** `ACKNOWLEDGE_UPDATE`, store price correction and available/marketable=true, record tenant departure separately, reconcile prior 'mid December' with one targeted clarification only if material. Bot's earlier misleading apology warrants a brief repair.

**Gold reply:**
> "Apologies, I misunderstood your earlier message. Thanks for confirming it’s available and correcting the rent to €2,800. I’ve also noted that the current tenant leaves on 20 November. Is the property ready for a new tenant then, or is the planned move-in date still around mid-December?"

**Do not say:** `Sorry to hear`, `Is it rented?`, `on a break?`, `great, noted` without actually saving the €2,800. Never overwrite owner price with website's cheaper candidate rule.

## S06 — Long-term occupied, no pets, and declined offer

**Observed:** Owner says `No pets`, then `It's not available, it's rented for many years`, `Tqx`. Bot responds with a long solicitation for subletting companies and admits `sorry for spam`; owner replies `No thanks for now`.

**Interpretation:** Current owner listing is long-term rented, no pets, no active available unit, no subletting indication. Refusal of offered deal. No lead to work right now. The earlier missing-photo reminder is no longer relevant.

**Expected action:** After the unavailable update, `NO_SEND` or one short closing if justified, close intake and suppress reminders; after `No thanks for now`, stop related follow-up. Do not infer universal global DNC unless explicit.

**Gold reply if a final acknowledgement is needed:**
> "Understood, thanks for letting me know. I’ve marked the property as unavailable and won’t follow up about it."

**Do not say:** `Would you consider subletting?`, `serious companies`, `super interesting offers`, `one last question` or more photo reminders.

## S07 — One available room, not a whole three-bedroom flat

**Observed:** Owner says a double bedroom is available from 1 Dec in a modern three-bedroom sharing apartment, €900 all-inclusive, photos link and address. Bot asks `How many bedrooms?`. Owner answers `3 but only 1 is available, the others are rented`. Bot asks bathrooms; answer `2`. After owner declines pets, bot asks if professional sharing is accepted, and owner asks `What do you mean?`.

**Interpretation:** One room, three total bedrooms, two other rooms occupied, existing shared accommodation, two bathrooms, €900 inclusive for the ROOM, available from Dec 1. No pets. No separate professional whole-unit sharing offer.

**Expected action:** Build one `ROOM_IN_SHARED_APARTMENT` listing or candidate with these exact facts. Stop asking rooms/sharing/pets, acknowledge or ask ONLY genuinely missing important information (e.g. deposit/term) if owner available and conversation permits. Wrong question should be explained/withdrawn if it has already been sent.

**Gold reply after 'What do you mean?':**
> "Sorry, I misunderstood the setup. You're offering one room in an apartment that’s already shared, not the entire apartment for a new group. I’ve noted that, along with the two bathrooms and no-pets policy. Thank you."

**Do not say:** `Would you consider professional sharing?` (already shared), `How many bedrooms?` (three stated), `Can I rent out all three?`.

## S08 — Valletta studio, €1,100: don't ask 'How many bedrooms?'

**Observed:** Owner says `Valletta studio`, rent `1100e`. Bot responds `Lovely, thanks, how many bedrooms does it have?`. Owner replies `Its a studio`.

**Interpretation:** studio unit, monthly rent €1,100 in Valletta if the rental context is explicit; studio = no separately designated bedroom unless the owner states otherwise. The enquiry is already answered in the property type.

**Expected action:** update subtype STUDIO, rent and locality. If a next question is truly needed, ask an appropriate missing detail such as availability/photos *only if not already supplied*. No bedroom question.

**Gold reply after `Valletta studio` + `1100e`:**
> "Thanks, I've noted a studio in Valletta at €1,100 per month. Is it available now or from a later date?"

Only ask the date if absent; if it has already been provided, acknowledge or `NO_SEND` instead.

## S09 — Video attachment and voice note: don't claim a known fact is missing

**Observed:** Owner forwards a video of the studio. Bot says it couldn't open the file and asks for `bedrooms, bathrooms, price, availability` again; then in another automated message asks bathrooms. Owner says `1`, sends a voice note, and bot claims to be `on appointments` and will come back later.

**Interpretation:** locality, subtype and price already known; bathroom count now 1; media unreadability must be based on a real media fetch/decode attempt. Voice note may add material facts and must be parsed by authorized voice pipeline or marked pending; do not invent what it says. The agent's personal availability must not be fabricated by an automated persona.

**Expected action:** If video genuinely unavailable, save `media_pending`, do not re-ask known text. If owner sends a voice note and media transcription isn't available, internal review/handoff and maybe ONE truthful brief request; no fabricated appointments.

**Gold reply (only if necessary):**
> "Thank you, I've noted one bathroom. I have the studio, Valletta location and €1,100 rent already. I'll flag the video and voice note for review so we don't lose any details."

Never say `I'm on appointments` unless an actual verified human status or direct user instruction supports it. Avoid two back-to-back messages in the same burst.

## S10 — Wrong agency/persona or auto-responder in same chat

**Observed:** Intro says `My name is Cedric`; incoming auto-reply says `Thank you for contacting Gabriella`. Agent continues as if an owner answered. Separate older screenshots show terse `Of course, I represent 2906` to requests for identity.

**Interpretation:** Sender is the authenticated WA account, not whatever name appears in quoted chat text or the other side's auto-responder. Inbound autoresponder should not flip sender identity. If sender is Cedric, only use verified Cedric affiliation; if Kevin, verified 2906; Gabriela depends on real account config.

**Expected action:** `NO_SEND` to autoresponder; real later identity question gets accurate direct response. Preserve audit of assigned sender versus last bot sender.

**Gold reply for Kevin when his identity is verified:**
> "Of course. I'm Kevin, an independent real estate consultant working with 2906 Estate, a collective of agents in Malta. We help clients with residential rentals and sales. You can find our company information at https://2906.estate."

Mention tenure, prior companies or licence numbers only if verifiably true in configured profile; no guessed employment statement.

## S11 — Quiet-hours violations in the screenshots

**Observed:** Outbound bot asks property questions after midnight and at ~21:36/22:19. The configured historical owner automation send window was 08:30–19:00 Europe/Malta.

**Interpretation:** Whether the outbound was fully automatic must be confirmed in metadata; **if automated**, it violates the configured window. Manual human messages require separate treatment.

**Expected action:** `DEFER` or `NO_SEND` according to policy; never dispatch automated replies outside the allowed window. At the next send time RECHECK all facts and DNC, and DO NOT send a stale queued question if a newer owner message arrived. If there is no useful action, discard it.

**Gold reply:** None during quiet hours. A queued draft is NOT a send authorization.

## S12 — Privacy objection (historical known regression)

**Observed historically:** Owner questioned how the phone was obtained and explicitly requested removal from the database.

**Expected action:** `DNC` + privacy request workflow + suppress all linked accounts + human/legal review of applicable deletion/retention. No marketing and no script asking for apartment details. Acknowledge only through approved privacy process if appropriate. Do not assume a source list grants permission to market.

## S13 — Agent shares several independent commercial sale listings

**Observed:** Source cards mention distinct office/retail units at different levels with different prices. In another message the owner separately identifies residential flats.

**Expected action:** Create separate provisional objects with distinct source IDs and prices; do not attach commercial prices, images, or permit questions to residential flats. If commercial unit data explicitly demands use/permit status, ask specifically and once, otherwise extract known fields. A forwarded sale price in a card is not rental €/month.

## S14 — 'No thanks for now' after inappropriate subletting pitch

**Expected action:** stop that offer, mark contact preference for related proposals (source/tenant scope), no follow-up pitch until owner reinitiates or clearly authorizes it. Distinguish `decline offer` from explicit request to erase all personal data. If preceding assistant behavior was poor, log quality incident for review.

## S15 — Multiple inbound details and previous bot question

**Observed:** Owner sends price, then availability, then tenant move-out in separate messages, but bot reacts to just one fragment and reverses meaning.

**Expected action:** use a time-bounded burst; update all fields before writing; if price changed, availability confirmed, and move-out specified, there are THREE facts, not three separate reply opportunities. One well-informed response maximum.

## S16 — Mixed natural language: 'sorry to hear' only for actual negative events

**Expected action:** Sentiment may inform phrasing but must NEVER override structured facts. `yes, available` is positive; `rented for many years` may simply require an acknowledgement without artificial sympathy. `We can view tomorrow` is a practical opportunity, not an owner's success in finding tenants. Avoid filler until the intent is known.

## S17 — 'I have a room in a shared apartment' vs `No pets`

**Expected action:** Respect owner-wide and listing-specific scopes. `No pets` for this room/listing means no pets, not an invitation to bargain with insured pets. Existing shared accommodation is not permission for any further subletting or group occupancy. Don't send the same question from another persona/account.

## S18 — Owner asks who the sender is and why they were contacted

**Expected action:** Verified account, transparent purpose and appropriate contact-basis explanation, or immediate human handoff if provenance is uncertain. Do not invent prior contact or claim they opted in if the source doesn't support that. No aggressive follow-up. If they object, stop outreach.

---

# Recommended professional reply styles (only for eligible, context-verified scenarios)

**Short acknowledgment of complete listing:**
> "Thanks for sending this over. I've noted the main details and attached the photos to the property record. I'll review the information and let you know if we have a suitable client."

**Another agent is replying:**
> "Thanks for clarifying — I'm also working as an agent in Malta. If you have a suitable property that could match one of our active requirements, I'm happy to coordinate agent-to-agent."

**Price and availability correction:**
> "Thank you. I've updated the asking rent to €2,800 and noted that the property is available to discuss."

**Property currently rented:**
> "Understood, thanks for the update. I've marked it as unavailable so we don't keep asking you about it."

**Viewing offered:**
> "Thank you, I've noted tomorrow at 3 pm as a possible viewing. I'll confirm with the client before arranging anything."

**Studio known, date missing:**
> "Thanks — a studio in Valletta at €1,100. Do you know when it would be available?"

**Already shared room:**
> "Got it: one room available in the three-bedroom shared apartment, with two bathrooms. I've noted the no-pets policy as well."

**Owner requests a phone call:**
> "Of course. I'll pass this to the agent handling the property and ask them to contact you. Is there a convenient time?"

**Owner doesn't understand a question:**
> "Sorry, that question wasn't relevant to your residential apartment. I've removed it from the details we're asking for."

**No further message needed:**
> `[NO_SEND]` — The most professional answer is often silence after facts are saved and a human task is created.

The founder asked for personalized professional paragraphs in outreach introductions. This is separate from ordinary owner-chat replies, which should be SHORT, context-aware, and not repeat a long introduction on every exchange.
