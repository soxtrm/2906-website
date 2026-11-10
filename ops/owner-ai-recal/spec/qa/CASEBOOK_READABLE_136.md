# ARGUS — 136 OWNER CONVERSATION GOLDEN TEST CASES
These fixtures describe **expected** behavior. They have NOT been run on the live ARGUS bot. All private names, phone numbers and addresses are omitted from the test examples.
136 tests: 20 direct screenshot-derived + 116 curated synthetic.

### 001. S01 — identity
**Inbound:** Are you an agent in Malta or do you own properties? I'm an agent also; I asked a question.
**Context:** Outgoing sender Cedric; owner has not yet offered a particular unit; auto-reply mentions Gabriella
**Correct next action:** `ANSWER_DIRECT` / `OWNER_DIRECT_QUESTION`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** agent
**Forbidden:** bedroom, bathroom, rent per month
**Automated send blocked:** False

### 002. S02 — viewing
**Inbound:** Villa available 4 December, 4 bedrooms plus office, 3-car garage, pool, €5,600. Address and photos attached. Viewing tomorrow at 3 PM.
**Context:** Owner messages with same villa sent in burst
**Correct next action:** `HUMAN_HANDOFF` / `VIEWING_OFFER`
**Facts to record:** {"property_type": "VILLA", "bedrooms": 4, "office": true, "garage_capacity": 3, "asking_rent": 5600, "viewing_status": "PROPOSED"}
**Must mention (if a reply is appropriate):** 3:00
**Forbidden:** found the right tenants, it's rented
**Automated send blocked:** False

### 003. S03 — commercial
**Inbound:** They're both residential apartments.
**Context:** Bot asked what space is for
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `RESIDENTIAL_NOT_COMMERCIAL`
**Facts to record:** {"use_type": "RESIDENTIAL"}
**Must mention (if a reply is appropriate):** residential
**Forbidden:** permit, licence, license
**Automated send blocked:** False

### 004. S04 — clarification
**Inbound:** I'm not sure what you mean.
**Context:** Bot mistakenly requested permit/licence status for two residential apartments
**Correct next action:** `ANSWER_DIRECT` / `OWNER_DIRECT_QUESTION`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** sorry, residential
**Forbidden:** approximate size, permit status
**Automated send blocked:** False

### 005. S05 — agent_handoff
**Inbound:** Both around 90sqm. Give me a call if you need more info.
**Context:** Two residential apartment records with distinct IDs
**Correct next action:** `HUMAN_HANDOFF` / `CALLBACK_REQUEST`
**Facts to record:** {"approx_area_sqm": 90, "callback_requested": true}
**Must mention (if a reply is appropriate):** call
**Forbidden:** permit, licence
**Automated send blocked:** False

### 006. S06 — availability
**Inbound:** It's €2,800. And yes, it's available.
**Context:** Old CRM marketing card says €2,649
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `PRICE_CORRECTION`
**Facts to record:** {"asking_rent": 2800, "marketable": true}
**Must mention (if a reply is appropriate):** 2,800, available
**Forbidden:** sorry to hear, rented, on a break
**Automated send blocked:** False

### 007. S07 — occupancy
**Inbound:** My tenant leaves on 20 November.
**Context:** Owner already confirmed property available for offers; previous note available mid-December
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `FUTURE_VACANCY`
**Facts to record:** {"tenant_departure_date": "2026-11-20", "available_from": "UNKNOWN_OR_PRIOR_APPROXIMATE"}
**Must mention (if a reply is appropriate):** 20 November
**Forbidden:** rented?, on a break
**Automated send blocked:** False

### 008. S08 — unavailable
**Inbound:** It's not available, it's rented for many years. Thanks.
**Context:** Bot asked for photos; owner said no pets
**Correct next action:** `NO_SEND` / `LONG_TERM_RENTED`
**Facts to record:** {"availability_status": "UNAVAILABLE_LONG_TERM", "pets_allowed": false}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** sublet, company, photos
**Automated send blocked:** True

### 009. S09 — decline
**Inbound:** No thanks for now.
**Context:** Bot inappropriately suggested subletting companies
**Correct next action:** `NO_SEND` / `NO_REPLY_REQUIRED`
**Facts to record:** {"current_offer_declined": true}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** one last question, sublet
**Automated send blocked:** True

### 010. S10 — room
**Inbound:** Double room available 1 Dec, €900 all inclusive, in a three-bedroom sharing apartment. Only one room is available; other two are rented. Two bathrooms.
**Context:** Owner sent photo link; no pets
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `ROOM_NOT_ENTIRE_APARTMENT`
**Facts to record:** {"property_type": "ROOM_IN_SHARED_APARTMENT", "total_bedrooms": 3, "rooms_available": 1, "bathrooms": 2, "room_rent": 900, "pets_allowed": false}
**Must mention (if a reply is appropriate):** room
**Forbidden:** professional sharing, how many bedrooms
**Automated send blocked:** False

### 011. S11 — room
**Inbound:** What do you mean please? It's a good room.
**Context:** Bot asked room-in-sharing owner if they accept professional sharing
**Correct next action:** `ANSWER_DIRECT` / `OWNER_DIRECT_QUESTION`
**Facts to record:** {"property_type": "ROOM_IN_SHARED_APARTMENT"}
**Must mention (if a reply is appropriate):** sorry, room
**Forbidden:** would you consider professional sharing
**Automated send blocked:** False

### 012. S12 — studio
**Inbound:** Valletta studio, 1100e.
**Context:** Owner offering residential rental
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `STUDIO_EXPLICIT`
**Facts to record:** {"property_type": "STUDIO", "asking_rent": 1100}
**Must mention (if a reply is appropriate):** studio
**Forbidden:** how many bedrooms
**Automated send blocked:** False

### 013. S13 — studio
**Inbound:** It's a studio.
**Context:** Bot mistakenly asked how many bedrooms after source says studio
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `STUDIO_EXPLICIT`
**Facts to record:** {"property_type": "STUDIO"}
**Must mention (if a reply is appropriate):** studio
**Forbidden:** how many bedrooms
**Automated send blocked:** False

### 014. S14 — media
**Inbound:** Here's a 40-second video of the studio.
**Context:** Studio Valletta €1,100 already known; video attachment not yet processed
**Correct next action:** `WAIT_FOR_MEDIA` / `OWNER_MEDIA_BURST`
**Facts to record:** {"media_status": "PENDING"}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** bedrooms, bathrooms, price, availability
**Automated send blocked:** False

### 015. S15 — media
**Inbound:** One bathroom. [6-second voice note attached]
**Context:** Studio already known; video pending
**Correct next action:** `HUMAN_HANDOFF` / `MEDIA_UNREADABLE`
**Facts to record:** {"bathrooms": 1, "media_status": "PENDING_TRANSCRIPTION"}
**Must mention (if a reply is appropriate):** bathroom
**Forbidden:** i'm on appointments, how many bedrooms
**Automated send blocked:** False

### 016. S16 — quiet
**Inbound:** Do you accept pets?
**Context:** Inbound at 00:47 Malta; all automated owner sends limited to 08:30–19:00
**Correct next action:** `DEFER` / `OUT_OF_HOURS`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** None specified
**Automated send blocked:** True

### 017. S17 — quiet
**Inbound:** One of the bedrooms is empty.
**Context:** Inbound Sunday 21:36 Malta; bot would draft a reply
**Correct next action:** `DEFER` / `OUT_OF_HOURS`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** None specified
**Automated send blocked:** True

### 018. S18 — property_multi
**Inbound:** We also have these three offices for sale. [three different cards with distinct prices]
**Context:** Two earlier residential flats under same agent
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `OWNER_MEDIA_BURST`
**Facts to record:** {"new_property_candidates": 3, "transaction_mode": "SALE", "use_type": "COMMERCIAL"}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** monthly rent, same apartment
**Automated send blocked:** False

### 019. S19 — autoresponder
**Inbound:** Thank you for contacting Gabriella, please let us know how we can help.
**Context:** Outgoing sender verified Cedric; automatic responder from recipient
**Correct next action:** `NO_SEND` / `INBOUND_AUTORESPONDER`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** bedroom, rent
**Automated send blocked:** True

### 020. S20 — privacy
**Inbound:** You obtained my number without my permission. Remove my details from your database.
**Context:** Unsolicited outreach question; no verified permission
**Correct next action:** `DNC` / `DNC`
**Facts to record:** {"do_not_contact": true, "privacy_request": "DELETION_OR_RESTRICTION_REVIEW"}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** property, bedroom, available
**Automated send blocked:** True

### 021. G001 — identity
**Inbound:** Which company do you work for?
**Context:** Verified Kevin/2906 sender, independent consultant
**Correct next action:** `ANSWER_DIRECT` / `OWNER_DIRECT_QUESTION`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** 2906
**Forbidden:** bedrooms
**Automated send blocked:** False

### 022. G002 — identity
**Inbound:** Are you the landlord or an agent?
**Context:** Verified Cedric/QuickLets sender
**Correct next action:** `ANSWER_DIRECT` / `OWNER_DIRECT_QUESTION`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** agent
**Forbidden:** bathroom
**Automated send blocked:** False

### 023. G003 — identity
**Inbound:** I thought you owned these flats?
**Context:** Sender is an agent, no ownership verified
**Correct next action:** `ANSWER_DIRECT` / `OWNER_DIRECT_QUESTION`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** agent
**Forbidden:** my flats
**Automated send blocked:** False

### 024. G004 — identity
**Inbound:** Who is Gabriela?
**Context:** Incoming auto-responder referred to Gabriella; sender is Cedric
**Correct next action:** `ANSWER_DIRECT` / `OWNER_DIRECT_QUESTION`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** Cedric
**Forbidden:** we own
**Automated send blocked:** False

### 025. G005 — identity
**Inbound:** What is 2906 Estate?
**Context:** Kevin verified as 2906 independent collective
**Correct next action:** `ANSWER_DIRECT` / `OWNER_DIRECT_QUESTION`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** collective
**Forbidden:** bedrooms
**Automated send blocked:** False

### 026. G006 — identity
**Inbound:** Send me your company website.
**Context:** Kevin verified; site must be validated
**Correct next action:** `ANSWER_DIRECT` / `OWNER_DIRECT_QUESTION`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** 2906.estate
**Forbidden:** rent
**Automated send blocked:** False

### 027. G007 — identity
**Inbound:** Are you registered?
**Context:** No proof of licence attached to sender profile
**Correct next action:** `HUMAN_HANDOFF` / `OWNER_DIRECT_QUESTION`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** our license is
**Automated send blocked:** False

### 028. G008 — identity
**Inbound:** How did you get my number?
**Context:** Source record has no verified explanation/marketing basis
**Correct next action:** `HUMAN_HANDOFF` / `OWNER_DIRECT_QUESTION`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** you opted in
**Automated send blocked:** False

### 029. G009 — identity
**Inbound:** I am not the owner; I'm another estate agent.
**Context:** No property on table
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `AGENT_TO_AGENT`
**Facts to record:** {"owner_role": "AGENT"}
**Must mention (if a reply is appropriate):** agent
**Forbidden:** what's the rent
**Automated send blocked:** False

### 030. G010 — identity
**Inbound:** Can I speak to a real person?
**Context:** Valid recipient and complaint about AI
**Correct next action:** `HUMAN_HANDOFF` / `CALLBACK_REQUEST`
**Facts to record:** {"human_requested": true}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** how many bedrooms
**Automated send blocked:** False

### 031. G011 — identity
**Inbound:** What are your agency fees?
**Context:** No verified approved fee terms in account profile
**Correct next action:** `HUMAN_HANDOFF` / `OWNER_DIRECT_QUESTION`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** 1 month
**Automated send blocked:** False

### 032. G012 — identity
**Inbound:** Please explain if you're independent or employed by 2906.
**Context:** Kevin independent consultant, verified collective membership
**Correct next action:** `ANSWER_DIRECT` / `OWNER_DIRECT_QUESTION`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** independent
**Forbidden:** I am the owner
**Automated send blocked:** False

### 033. G013 — studio_room
**Inbound:** Gzira studio available now.
**Context:** Rental enquiry
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `STUDIO_EXPLICIT`
**Facts to record:** {"property_type": "STUDIO"}
**Must mention (if a reply is appropriate):** studio
**Forbidden:** how many bedrooms
**Automated send blocked:** False

### 034. G014 — studio_room
**Inbound:** It's a studio, no separate bedroom.
**Context:** Bot had asked room count wrongly
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `STUDIO_EXPLICIT`
**Facts to record:** {"property_type": "STUDIO"}
**Must mention (if a reply is appropriate):** studio
**Forbidden:** 1 bedroom
**Automated send blocked:** False

### 035. G015 — studio_room
**Inbound:** I can rent one room in my 4-bedroom flat.
**Context:** Other three bedrooms occupied
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `ROOM_NOT_ENTIRE_APARTMENT`
**Facts to record:** {"property_type": "ROOM_IN_SHARED_APARTMENT", "rooms_available": 1, "total_bedrooms": 4}
**Must mention (if a reply is appropriate):** room
**Forbidden:** entire apartment
**Automated send blocked:** False

### 036. G016 — studio_room
**Inbound:** Two rooms are free, four in total.
**Context:** Owner rents individual rooms
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `ROOM_NOT_ENTIRE_APARTMENT`
**Facts to record:** {"rooms_available": 2, "total_bedrooms": 4}
**Must mention (if a reply is appropriate):** room
**Forbidden:** 4 bedrooms available
**Automated send blocked:** False

### 037. G017 — studio_room
**Inbound:** It's a maisonette with two bedrooms.
**Context:** Earlier property kind unknown
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `QUESTION_ALREADY_ANSWERED`
**Facts to record:** {"property_type": "MAISONETTE", "bedrooms": 2}
**Must mention (if a reply is appropriate):** maisonette
**Forbidden:** how many bedrooms
**Automated send blocked:** False

### 038. G018 — studio_room
**Inbound:** It's a 3-bedroom apartment, all of it is available.
**Context:** Whole apartment, not room by room
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `QUESTION_ALREADY_ANSWERED`
**Facts to record:** {"property_type": "WHOLE_APARTMENT", "bedrooms": 3}
**Must mention (if a reply is appropriate):** 3
**Forbidden:** how many bedrooms
**Automated send blocked:** False

### 039. G019 — studio_room
**Inbound:** It's a twin room in a student flat.
**Context:** Owner says no whole-unit let
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `ROOM_NOT_ENTIRE_APARTMENT`
**Facts to record:** {"property_type": "ROOM_IN_SHARED_APARTMENT"}
**Must mention (if a reply is appropriate):** room
**Forbidden:** whole flat
**Automated send blocked:** False

### 040. G020 — studio_room
**Inbound:** Only the master bedroom is available.
**Context:** Flat has three bedrooms occupied otherwise
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `ROOM_NOT_ENTIRE_APARTMENT`
**Facts to record:** {"rooms_available": 1}
**Must mention (if a reply is appropriate):** master bedroom
**Forbidden:** three-bedroom flat to let
**Automated send blocked:** False

### 041. G021 — studio_room
**Inbound:** All three bedrooms can be rented together.
**Context:** Was previously renting individually; now clarified whole unit
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `QUESTION_ALREADY_ANSWERED`
**Facts to record:** {"rooms_available": 3}
**Must mention (if a reply is appropriate):** together
**Forbidden:** only one room
**Automated send blocked:** False

### 042. G022 — studio_room
**Inbound:** This is a 3BR but the third is an office.
**Context:** Original card said 3 bed but owner corrects
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `QUESTION_ALREADY_ANSWERED`
**Facts to record:** {"bedrooms": 2, "office": true}
**Must mention (if a reply is appropriate):** office
**Forbidden:** 3 bedrooms confirmed
**Automated send blocked:** False

### 043. G023 — studio_room
**Inbound:** It's a commercial office, not a flat.
**Context:** Old record residential, needs review
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `RESIDENTIAL_NOT_COMMERCIAL`
**Facts to record:** {"use_type": "COMMERCIAL"}
**Must mention (if a reply is appropriate):** office
**Forbidden:** residential confirmed
**Automated send blocked:** False

### 044. G024 — studio_room
**Inbound:** It was a studio years ago; it's now a one-bedroom.
**Context:** New authoritative owner subtype correction
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `QUESTION_ALREADY_ANSWERED`
**Facts to record:** {"bedrooms": 1, "property_type": "APARTMENT"}
**Must mention (if a reply is appropriate):** one-bedroom
**Forbidden:** it's a studio
**Automated send blocked:** False

### 045. G025 — studio_room
**Inbound:** I have two separate studio apartments.
**Context:** Same building, distinct units
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `QUESTION_ALREADY_ANSWERED`
**Facts to record:** {"property_candidates": 2}
**Must mention (if a reply is appropriate):** two
**Forbidden:** same flat
**Automated send blocked:** False

### 046. G026 — studio_room
**Inbound:** There's a room in a shared house, €700 inclusive.
**Context:** Apartment owner with no full-unit offering
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `ROOM_NOT_ENTIRE_APARTMENT`
**Facts to record:** {"property_type": "ROOM_IN_SHARED_APARTMENT", "room_rent": 700}
**Must mention (if a reply is appropriate):** room
**Forbidden:** monthly rent for whole house
**Automated send blocked:** False

### 047. G027 — availability
**Inbound:** Yes it is available.
**Context:** Bot previous inquiry asked still available
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `AVAILABLE_CONFIRMED`
**Facts to record:** {"availability_status": "AVAILABLE_MARKETING"}
**Must mention (if a reply is appropriate):** available
**Forbidden:** rented, sorry to hear
**Automated send blocked:** False

### 048. G028 — availability
**Inbound:** No, it's rented until 2028.
**Context:** Same property current tenant
**Correct next action:** `NO_SEND` / `LONG_TERM_RENTED`
**Facts to record:** {"availability_status": "UNAVAILABLE_LONG_TERM"}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** sublet, photos
**Automated send blocked:** True

### 049. G029 — availability
**Inbound:** No longer on the market.
**Context:** Owner withdraws offer
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `LONG_TERM_RENTED`
**Facts to record:** {"availability_status": "OFF_MARKET"}
**Must mention (if a reply is appropriate):** noted
**Forbidden:** still available?
**Automated send blocked:** False

### 050. G030 — availability
**Inbound:** It'll be free mid-December.
**Context:** No exact date
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `FUTURE_VACANCY`
**Facts to record:** {"available_from_precision": "APPROXIMATE"}
**Must mention (if a reply is appropriate):** December
**Forbidden:** 15 December confirmed
**Automated send blocked:** False

### 051. G031 — availability
**Inbound:** Tenant leaves 20 Nov; I need two weeks to repaint.
**Context:** Previously marketed as available mid-Dec
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `FUTURE_VACANCY`
**Facts to record:** {"tenant_departure_date": "2026-11-20"}
**Must mention (if a reply is appropriate):** repaint
**Forbidden:** available 20 November
**Automated send blocked:** False

### 052. G032 — availability
**Inbound:** We can do a viewing Tuesday at 4.
**Context:** An agent asked for viewing options
**Correct next action:** `HUMAN_HANDOFF` / `VIEWING_OFFER`
**Facts to record:** {"viewing_status": "PROPOSED"}
**Must mention (if a reply is appropriate):** 4
**Forbidden:** booked
**Automated send blocked:** False

### 053. G033 — availability
**Inbound:** Viewing possible, not confirmed until I speak to tenant.
**Context:** Requested tomorrow
**Correct next action:** `HUMAN_HANDOFF` / `VIEWING_OFFER`
**Facts to record:** {"viewing_status": "TENTATIVE"}
**Must mention (if a reply is appropriate):** confirm
**Forbidden:** confirmed
**Automated send blocked:** False

### 054. G034 — availability
**Inbound:** It is available to view, not to move in until January.
**Context:** Distinguish viewing and move-in
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `FUTURE_VACANCY`
**Facts to record:** {"move_in_availability": "JANUARY"}
**Must mention (if a reply is appropriate):** January
**Forbidden:** move in today
**Automated send blocked:** False

### 055. G035 — availability
**Inbound:** The viewing tomorrow is cancelled.
**Context:** Earlier proposed viewing
**Correct next action:** `HUMAN_HANDOFF` / `VIEWING_OFFER`
**Facts to record:** {"viewing_status": "CANCELLED"}
**Must mention (if a reply is appropriate):** cancel
**Forbidden:** confirmed
**Automated send blocked:** False

### 056. G036 — availability
**Inbound:** It's back on the market.
**Context:** Earlier off-market owner record
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `AVAILABLE_CONFIRMED`
**Facts to record:** {"availability_status": "AVAILABLE_MARKETING"}
**Must mention (if a reply is appropriate):** market
**Forbidden:** still rented
**Automated send blocked:** False

### 057. G037 — availability
**Inbound:** This one is rented, but I have another flat.
**Context:** Two distinct property refs
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `LONG_TERM_RENTED`
**Facts to record:** {"current_property_status": "RENTED", "new_property_candidate": true}
**Must mention (if a reply is appropriate):** another
**Forbidden:** all flats rented
**Automated send blocked:** False

### 058. G038 — availability
**Inbound:** Now €1,750, not €1,650.
**Context:** Owner directly corrects their rent
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `PRICE_CORRECTION`
**Facts to record:** {"asking_rent": 1750}
**Must mention (if a reply is appropriate):** 1,750
**Forbidden:** 1,650 is correct
**Automated send blocked:** False

### 059. G039 — availability
**Inbound:** Actually it's €1,350 per month.
**Context:** Old €1,450 copied from owner website
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `PRICE_CORRECTION`
**Facts to record:** {"asking_rent": 1350}
**Must mention (if a reply is appropriate):** 1,350
**Forbidden:** 1,450 per month
**Automated send blocked:** False

### 060. G040 — availability
**Inbound:** I can sell it, but can't rent it.
**Context:** Earlier generic marketing status
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `QUESTION_ALREADY_ANSWERED`
**Facts to record:** {"sale_offered": true, "rent_offered": false}
**Must mention (if a reply is appropriate):** sale
**Forbidden:** available for rent
**Automated send blocked:** False

### 061. G041 — availability
**Inbound:** Available on 4 December, keys from 10 December.
**Context:** Physical vacancy vs handover dates
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `FUTURE_VACANCY`
**Facts to record:** {"available_from": "2026-12-04", "key_handover_from": "2026-12-10"}
**Must mention (if a reply is appropriate):** 10 December
**Forbidden:** move in 4 December confirmed
**Automated send blocked:** False

### 062. G042 — availability
**Inbound:** Yes, but only for a winter let.
**Context:** Owner declines long-let
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `QUESTION_ALREADY_ANSWERED`
**Facts to record:** {"rent_type": "WINTER_LET"}
**Must mention (if a reply is appropriate):** winter
**Forbidden:** long let available
**Automated send blocked:** False

### 063. G043 — commercial
**Inbound:** Two residential flats in Sliema.
**Context:** Bot about to ask permit status
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `RESIDENTIAL_NOT_COMMERCIAL`
**Facts to record:** {"use_type": "RESIDENTIAL"}
**Must mention (if a reply is appropriate):** residential
**Forbidden:** permit, license
**Automated send blocked:** False

### 064. G044 — commercial
**Inbound:** A normal residential villa.
**Context:** Permission question queued
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `RESIDENTIAL_NOT_COMMERCIAL`
**Facts to record:** {"use_type": "RESIDENTIAL"}
**Must mention (if a reply is appropriate):** villa
**Forbidden:** licence
**Automated send blocked:** False

### 065. G045 — commercial
**Inbound:** An office suitable for professional use.
**Context:** Commercial unit; no owner use restrictions yet
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `QUESTION_ALREADY_ANSWERED`
**Facts to record:** {"use_type": "COMMERCIAL"}
**Must mention (if a reply is appropriate):** office
**Forbidden:** bedrooms
**Automated send blocked:** False

### 066. G046 — commercial
**Inbound:** It's a retail shop with Class 4B permit.
**Context:** Actual supplied permit, no re-ask
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `QUESTION_ALREADY_ANSWERED`
**Facts to record:** {"permit": "4B"}
**Must mention (if a reply is appropriate):** 4B
**Forbidden:** which permit
**Automated send blocked:** False

### 067. G047 — commercial
**Inbound:** It is an office, licensed for office use.
**Context:** Commercial source explicit
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `QUESTION_ALREADY_ANSWERED`
**Facts to record:** {"use_type": "COMMERCIAL"}
**Must mention (if a reply is appropriate):** office
**Forbidden:** permit status?
**Automated send blocked:** False

### 068. G048 — commercial
**Inbound:** Commercial showroom, the permit is pending.
**Context:** Commercial property, permit not yet granted
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `QUESTION_ALREADY_ANSWERED`
**Facts to record:** {"permit_status": "PENDING"}
**Must mention (if a reply is appropriate):** pending
**Forbidden:** approved
**Automated send blocked:** False

### 069. G049 — commercial
**Inbound:** The apartment is currently occupied by a family.
**Context:** Do not ask commercial use
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `RESIDENTIAL_NOT_COMMERCIAL`
**Facts to record:** {"use_type": "RESIDENTIAL"}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** permits, commercial
**Automated send blocked:** False

### 070. G050 — commercial
**Inbound:** I have one office and one home on the same floor.
**Context:** Separate units and rights
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `QUESTION_ALREADY_ANSWERED`
**Facts to record:** {"property_candidates": 2}
**Must mention (if a reply is appropriate):** office
**Forbidden:** same apartment
**Automated send blocked:** False

### 071. G051 — commercial
**Inbound:** This garage can be sold separately.
**Context:** Garage sale listing, not an apartment
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `QUESTION_ALREADY_ANSWERED`
**Facts to record:** {"property_type": "GARAGE", "transaction_mode": "SALE"}
**Must mention (if a reply is appropriate):** garage
**Forbidden:** bathroom
**Automated send blocked:** False

### 072. G052 — commercial
**Inbound:** It's a warehouse, not licensed for retail.
**Context:** Commercial explicit no retail
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `QUESTION_ALREADY_ANSWERED`
**Facts to record:** {"permitted_use": "WAREHOUSE_NOT_RETAIL"}
**Must mention (if a reply is appropriate):** warehouse
**Forbidden:** retail approved
**Automated send blocked:** False

### 073. G053 — media
**Inbound:** [5 photos] The balcony is the third one.
**Context:** Owner with two apartments, one selected by source reference
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `OWNER_MEDIA_BURST`
**Facts to record:** {"media_count": 5}
**Must mention (if a reply is appropriate):** balcony
**Forbidden:** both listings
**Automated send blocked:** False

### 074. G054 — media
**Inbound:** [photos link] Here are the images of Apartment B.
**Context:** Owner also has Apartment A
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `OWNER_MEDIA_BURST`
**Facts to record:** {"media_binding": "B"}
**Must mention (if a reply is appropriate):** apartment b
**Forbidden:** apartment a photos
**Automated send blocked:** False

### 075. G055 — media
**Inbound:** [audio note 0:08]
**Context:** No verified ASR transcript; agent currently available
**Correct next action:** `HUMAN_HANDOFF` / `MEDIA_UNREADABLE`
**Facts to record:** {"media_status": "PENDING_TRANSCRIPTION"}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** i heard you say
**Automated send blocked:** False

### 076. G056 — media
**Inbound:** [video]
**Context:** Attachment download succeeded, no local parser
**Correct next action:** `WAIT_FOR_MEDIA` / `MEDIA_UNREADABLE`
**Facts to record:** {"media_status": "PENDING"}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** cannot open if not tested
**Automated send blocked:** False

### 077. G057 — media
**Inbound:** Here are the photos. [link]
**Context:** Bot already asked for photos
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `OWNER_MEDIA_BURST`
**Facts to record:** {"photos_received": true}
**Must mention (if a reply is appropriate):** photos
**Forbidden:** send photos
**Automated send blocked:** False

### 078. G058 — media
**Inbound:** Here are ten more images for the penthouse.
**Context:** Earlier same owner has an apartment and a penthouse
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `OWNER_MEDIA_BURST`
**Facts to record:** {"media_property": "PENTHOUSE"}
**Must mention (if a reply is appropriate):** penthouse
**Forbidden:** apartment photos
**Automated send blocked:** False

### 079. G059 — media
**Inbound:** This picture belongs to my OTHER apartment.
**Context:** AI previously misassigned an image
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `OWNER_MEDIA_BURST`
**Facts to record:** {"media_binding_review": true}
**Must mention (if a reply is appropriate):** other
**Forbidden:** same apartment
**Automated send blocked:** False

### 080. G060 — media
**Inbound:** Please see the PDF floorplan and photos.
**Context:** Two attachments, sizes allowed and rights unknown
**Correct next action:** `WAIT_FOR_MEDIA` / `OWNER_MEDIA_BURST`
**Facts to record:** {"media_status": "PENDING"}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** i have reviewed the PDF
**Automated send blocked:** False

### 081. G061 — media
**Inbound:** This is all the information. [photo card]
**Context:** One property; important facts in caption
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `OWNER_MEDIA_BURST`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** information
**Forbidden:** all missing
**Automated send blocked:** False

### 082. G062 — media
**Inbound:** Can you use these photos on your website?
**Context:** No publication rights granted yet
**Correct next action:** `ANSWER_DIRECT` / `OWNER_DIRECT_QUESTION`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** permission
**Forbidden:** already published
**Automated send blocked:** False

### 083. G063 — refusal
**Inbound:** No pets.
**Context:** Pet policy for current property
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `NO_PETS`
**Facts to record:** {"pets_allowed": false}
**Must mention (if a reply is appropriate):** pets
**Forbidden:** insurance loophole
**Automated send blocked:** False

### 084. G064 — refusal
**Inbound:** Not open to subletting.
**Context:** Owner current unit
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `NO_SUBLETTING`
**Facts to record:** {"subletting_allowed": false}
**Must mention (if a reply is appropriate):** noted
**Forbidden:** but companies
**Automated send blocked:** False

### 085. G065 — refusal
**Inbound:** Not interested.
**Context:** Marketing outreach
**Correct next action:** `NO_SEND` / `NO_REPLY_REQUIRED`
**Facts to record:** {"engagement": "DECLINED"}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** another apartment
**Automated send blocked:** True

### 086. G066 — refusal
**Inbound:** Stop contacting me.
**Context:** Any prior relationship
**Correct next action:** `DNC` / `DNC`
**Facts to record:** {"do_not_contact": true}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** one last question
**Automated send blocked:** True

### 087. G067 — refusal
**Inbound:** Delete my contact data.
**Context:** Owner explicitly invokes removal
**Correct next action:** `DNC` / `DNC`
**Facts to record:** {"privacy_request": "DELETE_REVIEW"}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** properties?
**Automated send blocked:** True

### 088. G068 — refusal
**Inbound:** I've been contacted by three of your numbers. Stop.
**Context:** Cross-account duplicate contacts
**Correct next action:** `DNC` / `COMPLAINT`
**Facts to record:** {"do_not_contact": true}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** you might still
**Automated send blocked:** True

### 089. G069 — refusal
**Inbound:** There is no flat available and won't be for years.
**Context:** Owner firm status
**Correct next action:** `NO_SEND` / `LONG_TERM_RENTED`
**Facts to record:** {"availability_status": "UNAVAILABLE_LONG_TERM"}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** photos, subletting
**Automated send blocked:** True

### 090. G070 — refusal
**Inbound:** No thanks for now, I don't want to discuss it.
**Context:** Offer declined
**Correct next action:** `NO_SEND` / `NO_REPLY_REQUIRED`
**Facts to record:** {"engagement": "DECLINED"}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** followup
**Automated send blocked:** True

### 091. G071 — refusal
**Inbound:** Please speak to my agent instead.
**Context:** Owner delegates
**Correct next action:** `HUMAN_HANDOFF` / `CALLBACK_REQUEST`
**Facts to record:** {"human_requested": true}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** what's the rent
**Automated send blocked:** False

### 092. G072 — refusal
**Inbound:** I'm busy, call next week.
**Context:** Legitimate established relationship
**Correct next action:** `HUMAN_HANDOFF` / `CALLBACK_REQUEST`
**Facts to record:** {"callback_requested": true}
**Must mention (if a reply is appropriate):** next week
**Forbidden:** how many beds
**Automated send blocked:** False

### 093. G073 — refusal
**Inbound:** You are a robot, stop messaging me.
**Context:** Owner explicitly objects
**Correct next action:** `DNC` / `COMPLAINT`
**Facts to record:** {"do_not_contact": true}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** let me explain
**Automated send blocked:** True

### 094. G074 — refusal
**Inbound:** Wrong number.
**Context:** Contact owner ID mismatch
**Correct next action:** `DNC` / `DNC`
**Facts to record:** {"wrong_number": true}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** is your flat
**Automated send blocked:** True

### 095. G075 — handoff
**Inbound:** Can you arrange a viewing for tomorrow afternoon?
**Context:** One rental unit with no agreed time
**Correct next action:** `HUMAN_HANDOFF` / `VIEWING_OFFER`
**Facts to record:** {"viewing_status": "REQUESTED"}
**Must mention (if a reply is appropriate):** viewing
**Forbidden:** confirmed appointment
**Automated send blocked:** False

### 096. G076 — handoff
**Inbound:** Come tomorrow at 15:00.
**Context:** Owner offers time but client's approval absent
**Correct next action:** `HUMAN_HANDOFF` / `VIEWING_OFFER`
**Facts to record:** {"viewing_status": "PROPOSED"}
**Must mention (if a reply is appropriate):** 15:00
**Forbidden:** booked
**Automated send blocked:** False

### 097. G077 — handoff
**Inbound:** Call me after 5 PM.
**Context:** No agent callback yet
**Correct next action:** `HUMAN_HANDOFF` / `CALLBACK_REQUEST`
**Facts to record:** {"callback_requested": true}
**Must mention (if a reply is appropriate):** 5
**Forbidden:** already called
**Automated send blocked:** False

### 098. G078 — handoff
**Inbound:** I spoke to your colleague Kevin.
**Context:** Cedric WA account; cross-account last agent active
**Correct next action:** `NO_SEND` / `HUMAN_ACTIVE`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** how many bedrooms
**Automated send blocked:** True

### 099. G079 — handoff
**Inbound:** The agent is handling this.
**Context:** Explicit human claim
**Correct next action:** `NO_SEND` / `HUMAN_ACTIVE`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** can I help
**Automated send blocked:** True

### 100. G080 — handoff
**Inbound:** Please let your manager know.
**Context:** Owner complaint about sender
**Correct next action:** `HUMAN_HANDOFF` / `COMPLAINT`
**Facts to record:** {"escalate_to_manager": true}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** rent
**Automated send blocked:** False

### 101. G081 — handoff
**Inbound:** Can I send my bank details to confirm a deposit?
**Context:** Sensitive payment workflow not supported
**Correct next action:** `HUMAN_HANDOFF` / `OWNER_DIRECT_QUESTION`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** send your bank details here
**Automated send blocked:** False

### 102. G082 — handoff
**Inbound:** We can view, but ask me to confirm on the day.
**Context:** Appointment conditional
**Correct next action:** `HUMAN_HANDOFF` / `VIEWING_OFFER`
**Facts to record:** {"viewing_status": "TENTATIVE"}
**Must mention (if a reply is appropriate):** confirm
**Forbidden:** confirmed booking
**Automated send blocked:** False

### 103. G083 — handoff
**Inbound:** I am a colleague, taking over this thread.
**Context:** Manual agent takeover signal
**Correct next action:** `NO_SEND` / `HUMAN_ACTIVE`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** owner?
**Automated send blocked:** True

### 104. G084 — handoff
**Inbound:** I can meet the client at 11:00 on Saturday.
**Context:** Owner proposed viewing; no client confirmation
**Correct next action:** `HUMAN_HANDOFF` / `VIEWING_OFFER`
**Facts to record:** {"viewing_status": "PROPOSED"}
**Must mention (if a reply is appropriate):** Saturday
**Forbidden:** confirmed
**Automated send blocked:** False

### 105. G085 — multi_property
**Inbound:** I have two in Mellieha and one in Valletta.
**Context:** Owner has portfolio with no unit refs
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `QUESTION_ALREADY_ANSWERED`
**Facts to record:** {"property_candidates": 3}
**Must mention (if a reply is appropriate):** two
**Forbidden:** one apartment
**Automated send blocked:** False

### 106. G086 — multi_property
**Inbound:** The one in Sliema costs €1,400; Valletta is €1,900.
**Context:** Two unique candidates
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `QUESTION_ALREADY_ANSWERED`
**Facts to record:** {"property_candidates": 2}
**Must mention (if a reply is appropriate):** Sliema
**Forbidden:** all €1,400
**Automated send blocked:** False

### 107. G087 — multi_property
**Inbound:** The first one is rented, second is available.
**Context:** Owner has distinct A and B candidates
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `QUESTION_ALREADY_ANSWERED`
**Facts to record:** {"property_a": "RENTED", "property_b": "AVAILABLE"}
**Must mention (if a reply is appropriate):** second
**Forbidden:** both available
**Automated send blocked:** False

### 108. G088 — multi_property
**Inbound:** These photos are for Unit 7B.
**Context:** Owner has three units
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `OWNER_MEDIA_BURST`
**Facts to record:** {"media_binding": "UNIT_7B"}
**Must mention (if a reply is appropriate):** 7B
**Forbidden:** all units
**Automated send blocked:** False

### 109. G089 — multi_property
**Inbound:** All my properties are currently booked.
**Context:** 10-unit portfolio with stale dates
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `LONG_TERM_RENTED`
**Facts to record:** {"portfolio_status": "NONE_CURRENTLY_AVAILABLE"}
**Must mention (if a reply is appropriate):** all
**Forbidden:** available 1 January
**Automated send blocked:** False

### 110. G090 — multi_property
**Inbound:** I have two apartments in this block with the same layout.
**Context:** Separate units, cannot unify IDs
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `QUESTION_ALREADY_ANSWERED`
**Facts to record:** {"property_candidates": 2}
**Must mention (if a reply is appropriate):** two
**Forbidden:** same unit
**Automated send blocked:** False

### 111. G091 — multi_property
**Inbound:** I already gave the address of the top floor one.
**Context:** Owner two flats, address previously supplied
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `QUESTION_ALREADY_ANSWERED`
**Facts to record:** {"address_already_provided": true}
**Must mention (if a reply is appropriate):** top floor
**Forbidden:** what's the address?
**Automated send blocked:** False

### 112. G092 — multi_property
**Inbound:** The shop is for sale; the apartment is for rent.
**Context:** Same complex
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `QUESTION_ALREADY_ANSWERED`
**Facts to record:** {"property_candidates": 2}
**Must mention (if a reply is appropriate):** shop
**Forbidden:** all rentals
**Automated send blocked:** False

### 113. G093 — multi_property
**Inbound:** No groups for the apartment, rooms are fine for studio B.
**Context:** Distinct property policies
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `QUESTION_ALREADY_ANSWERED`
**Facts to record:** {"policy_scope": "PROPERTY_SPECIFIC"}
**Must mention (if a reply is appropriate):** apartment
**Forbidden:** all properties no groups
**Automated send blocked:** False

### 114. G094 — multi_property
**Inbound:** The price on that card is outdated; use the latest one I sent.
**Context:** Owner newer explicit quote available
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `PRICE_CORRECTION`
**Facts to record:** {"price_provenance": "LATEST_OWNER"}
**Must mention (if a reply is appropriate):** latest
**Forbidden:** old card still current
**Automated send blocked:** False

### 115. G095 — dispatch
**Inbound:** Thanks!
**Context:** Owner replied at 18:10; conversation closed
**Correct next action:** `NO_SEND` / `NO_REPLY_REQUIRED`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** another thing
**Automated send blocked:** True

### 116. G096 — dispatch
**Inbound:** Can you ask again tomorrow?
**Context:** Request at 18:45, permitted current window
**Correct next action:** `DEFER` / `NO_REPLY_REQUIRED`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** right now
**Automated send blocked:** True

### 117. G097 — dispatch
**Inbound:** Photo attached, one moment sending details.
**Context:** Owner sends follow-up details 7 sec later
**Correct next action:** `WAIT_FOR_MEDIA` / `OWNER_MEDIA_BURST`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** how many bedrooms
**Automated send blocked:** False

### 118. G098 — dispatch
**Inbound:** One bedroom
**Context:** Sender account Auto OFF
**Correct next action:** `NO_SEND` / `AUTO_DISABLED`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** thanks
**Automated send blocked:** True

### 119. G099 — dispatch
**Inbound:** It's available
**Context:** Conversation manually paused
**Correct next action:** `NO_SEND` / `MANUAL_PAUSE`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** thanks
**Automated send blocked:** True

### 120. G100 — dispatch
**Inbound:** €1,800 a month
**Context:** Same WhatsApp message_id already processed
**Correct next action:** `NO_SEND` / `NO_REPLY_REQUIRED`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** noted
**Automated send blocked:** True

### 121. G101 — dispatch
**Inbound:** I sent it before
**Context:** Human agent typed in this chat in last minute
**Correct next action:** `NO_SEND` / `HUMAN_ACTIVE`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** what details
**Automated send blocked:** True

### 122. G102 — dispatch
**Inbound:** Available from August
**Context:** Inbound 01:11 Europe/Malta
**Correct next action:** `DEFER` / `OUT_OF_HOURS`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** great
**Automated send blocked:** True

### 123. G103 — dispatch
**Inbound:** [photo]
**Context:** Inbound 22:19 Europe/Malta
**Correct next action:** `DEFER` / `OUT_OF_HOURS`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** photo received
**Automated send blocked:** True

### 124. G104 — dispatch
**Inbound:** We don't have any now
**Context:** Account identity is unknown after WAHA reconnect
**Correct next action:** `HUMAN_HANDOFF` / `UNCERTAIN_SENDER`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** I represent QuickLets
**Automated send blocked:** False

### 125. G105 — dispatch
**Inbound:** My flat is still available
**Context:** Contact on global DNC list
**Correct next action:** `DNC` / `DNC`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** can we view
**Automated send blocked:** True

### 126. G106 — dispatch
**Inbound:** Please correct my details
**Context:** Owner sees wrong status
**Correct next action:** `HUMAN_HANDOFF` / `OWNER_DIRECT_QUESTION`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** everything is fixed
**Automated send blocked:** False

### 127. G107 — dispatch
**Inbound:** Can we view tomorrow?
**Context:** Bot's earlier auto draft queued, owner now cancels and asks to stop
**Correct next action:** `DNC` / `DNC`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** tomorrow at
**Automated send blocked:** True

### 128. G108 — dispatch
**Inbound:** Three messages in 5 seconds, one attached photo
**Context:** A delayed auto reply is ready for an old state
**Correct next action:** `WAIT_FOR_MEDIA` / `OWNER_MEDIA_BURST`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** old question
**Automated send blocked:** False

### 129. G109 — copy_quality
**Inbound:** I have a property available.
**Context:** New owner, verified Kevin 2906, first eligible reply
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `AVAILABLE_CONFIRMED`
**Facts to record:** {"offer_exists": true}
**Must mention (if a reply is appropriate):** property
**Forbidden:** sorry to hear
**Automated send blocked:** False

### 130. G110 — copy_quality
**Inbound:** Good evening
**Context:** Sent at 10:30 Malta; ongoing chat
**Correct next action:** `NO_SEND` / `NO_REPLY_REQUIRED`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** Good evening
**Automated send blocked:** True

### 131. G111 — copy_quality
**Inbound:** Please be brief.
**Context:** Owner annoyed by long script
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `NO_REPLY_REQUIRED`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** No additional phrase requirement
**Forbidden:** let me tell you about all services
**Automated send blocked:** False

### 132. G112 — copy_quality
**Inbound:** I don't understand your question.
**Context:** Bot asked about commercial permits for residential
**Correct next action:** `ANSWER_DIRECT` / `OWNER_DIRECT_QUESTION`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** sorry
**Forbidden:** size in sqm?
**Automated send blocked:** False

### 133. G113 — copy_quality
**Inbound:** That message sounded automated.
**Context:** Owner questions authenticity
**Correct next action:** `ANSWER_DIRECT` / `OWNER_DIRECT_QUESTION`
**Facts to record:** {}
**Must mention (if a reply is appropriate):** automated
**Forbidden:** I'm definitely a human
**Automated send blocked:** False

### 134. G114 — copy_quality
**Inbound:** Are you sure about my price?
**Context:** Owner earlier corrected €1,700 -> €1,900
**Correct next action:** `ANSWER_DIRECT` / `PRICE_CORRECTION`
**Facts to record:** {"asking_rent": 1900}
**Must mention (if a reply is appropriate):** 1,900
**Forbidden:** 1,700 remains correct
**Automated send blocked:** False

### 135. G115 — copy_quality
**Inbound:** I'm not upset; the flat is available.
**Context:** Bot sentiment falsely negative
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `AVAILABLE_CONFIRMED`
**Facts to record:** {"availability_status": "AVAILABLE_MARKETING"}
**Must mention (if a reply is appropriate):** available
**Forbidden:** sorry to hear
**Automated send blocked:** False

### 136. G116 — copy_quality
**Inbound:** Thanks, I will send photos next week.
**Context:** Owner schedules future media, no current media
**Correct next action:** `ACKNOWLEDGE_UPDATE` / `NO_REPLY_REQUIRED`
**Facts to record:** {"photos_expected": "NEXT_WEEK"}
**Must mention (if a reply is appropriate):** next week
**Forbidden:** please send now
**Automated send blocked:** False
