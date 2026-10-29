# Iż-Żebbuġ, Gozo edition — sourced research draft

Language: English. Status: **RESEARCH DRAFT — NOT PUBLISHED**. Checked 29 October 2026 (Europe/Malta).

## Why this locality is next

The public 2906 inventory endpoint returned 497 records during this check. One available record with six images used the exact location label `Gozo - Zebbug (Gozo)`, while the public neighbourhood directory contained 59 editions and no Iż-Żebbuġ (Gozo) edition. This is an editorial coverage signal only. It is not a popularity, demand, quality or availability ranking, and it does not justify publishing the property's address, coordinates, description, images or claimed outlook.

- Inventory source: https://www.2906.estate/api/properties?limit=500
- Observed reference: the record identity was used only to confirm the exact locality label, public status and image count.

## Naming and editorial boundary

Use the Maltese name **Iż-Żebbuġ (Għawdex)** in formal locality context and `zebbug-gozo.html` as the practical ASCII filename. The Office of the Address Registrar lists Iż-Żebbuġ (Għawdex) as its own local council in the Gozo Region. The Local Council describes the village across adjoining slopes around the parish church, while Visit Gozo treats the hill village, Qbajjar, Xwejni and the northern coast as connected but distinct contexts.

A future edition must keep at least four contexts distinct:

1. the lived-in hill village and Pjazza l-Assunta around St Mary's parish church;
2. the residential and rural slopes around Ta' Abram and Is-Sagħtrija;
3. the coastal contexts of Qbajjar and Xwejni, including the operational salt pans;
4. Marsalforn, which already has its own editorial page and must not be absorbed into Iż-Żebbuġ.

Għasri, Marsalforn, Victoria and Xagħra remain separate localities. A coastal view, bay address or salt-pan proximity may never be inferred for an unspecified village property. The administrative search result is not property geometry and must not be converted into an invented neighbourhood boundary.

- Office of the Address Registrar, local-council register: https://address.gov.mt/local-council/
- Iż-Żebbuġ Local Council: https://zebbuggozolc.gov.mt/en/
- Visit Gozo, Iż-Żebbuġ locality overview: https://visitgozo.com/places/iz-zebbug/
- Gozo Album, Iż-Żebbuġ: https://gozoalbum.gov.mt/localities/%C5%BBebbu%C4%A1-2

## Everyday life and public services

The Local Council publishes live service, notice, publication and event routes. A public edition may point residents to those official channels, but current office hours, contacts, permits, collections and event dates should remain on the live council site.

Malta Public Transport currently lists route 309 for Iż-Żebbuġ. A future page should link the live route and service-update pages rather than freeze a departure time or frequency into evergreen copy. A locality route does not prove that a particular home is a short walk from a stop.

Primary HealthCare's current Gozo notice says all Gozo community clinics are temporarily closed except Għarb, Xewkija and Qala. The future edition must therefore avoid promising an Iż-Żebbuġ clinic, opening day, service or appointment pathway and should link the live government clinic and Victoria Health Centre information instead.

- Iż-Żebbuġ Local Council services and notices: https://zebbuggozolc.gov.mt/en/
- Malta Public Transport, route 309: https://www.publictransport.com.mt/route/309/
- Malta Public Transport, live service updates: https://www.publictransport.com.mt/service-updates/
- Primary HealthCare, current community-clinic notice: https://primaryhealthcare.gov.mt/en/clinics/malta-community-clinics/
- Primary HealthCare, health-centre directory: https://primaryhealthcare.gov.mt/en/health-centers/

## Activities and heritage

Official visitor and heritage sources support several distinct, non-ranked anchors:

- **St Mary's parish church:** Visit Gozo identifies the present church as the Assumption parish church, records parish status from 1688 and highlights the Gozo-onyx interior. Access and service details must remain on the live source.
- **Village niches and craft context:** the Local Council and Gozo Album document the village's street niches and craft traditions. These are cultural context, not proof of an attraction being open or near a property.
- **Qbajjar and Xwejni bays:** Visit Gozo describes them as adjacent shallow bays with pebbly and rocky shorelines. Swimming, sea conditions and operator availability are changeable and require a current check.
- **Xwejni salt pans:** Visit Gozo describes an active, family-maintained salt-making landscape and explicitly asks visitors not to walk on the pans. Seasonal harvesting is not a permanent daily activity.

The Saltpans Walk is a published visitor itinerary, not a verified route from any listing. Its line, distance and icons must not be reused as a property walking route. A property page should link the official itinerary rather than invent a shortcut across fields or coastal rock.

- Visit Gozo, St Mary's Church: https://visitgozo.com/places/st-marys-church/
- Visit Gozo, Qbajjar and Xwejni: https://visitgozo.com/places/qbajjar/
- Visit Gozo, salt pans: https://visitgozo.com/places/salt-pans/
- Visit Gozo, Saltpans Walk: https://visitgozo.com/wp-content/uploads/2024/03/SaltPansWalk.pdf

## Restaurants and everyday food anchors

The Malta Tourism Authority's exact `ZEBBUG Gozo` filters returned four restaurant records and one snack-bar record. The following three are useful only as geographically varied, non-ranked register anchors:

1. **The View Restaurant** — `RST-22782`, 20 Pjazza l-Assunta;
2. **Santa Maria Restaurant** — `RST-27663`, Kazin Banda Santa Marija, Triq il-Knisja;
3. **Qbajjar Restaurant** — `RST-12876`, 23 Triq ix-Xwejni.

The register proves the licence record, name and recorded address at check time. It does not prove current opening hours, menu, price, quality, accessibility, availability or proximity to any property. A future page must link the live register and tell readers to confirm current operating details directly.

- MTA, exact restaurant filter: https://www.mta.com.mt/licences/licences/?type=restaurants&town=ZEBBUG%20Gozo&size=250
- MTA, exact snack-bar filter: https://www.mta.com.mt/licences/licences/?type=snack-bars&town=ZEBBUG%20Gozo&size=250
- Direct result at check time: restaurants `1–4 of 4`, last updated 29 October 2026 at 08:25 Malta time; snack bars one record, last updated 29 October 2026 at 06:26 Malta time.

## Lightweight 2D map boundary

A future edition should use the established click-to-load OpenStreetMap pattern: no initial iframe, no tracking-heavy map SDK and no listing pin. A neutral village-and-coast viewport can use approximately `14.226,36.049,14.266,36.083`; it is a viewing window, not a municipal boundary. OpenStreetMap's administrative result is substantially broader than the village core and must not be reused as an editorial claim about where a property sits.

The map must draw no route by default. If routing is offered later, it must use provider-returned land geometry and show no route when valid geometry is unavailable. No straight line over valleys, fields, bays or sea may be presented as walking or driving.

- OpenStreetMap Nominatim locality result, checked only to establish a neutral viewport: https://nominatim.openstreetmap.org/search?format=jsonv2&limit=3&q=I%C5%BC-%C5%BBebbu%C4%A1%2C%20Gozo%2C%20Malta
- OpenStreetMap copyright and licence: https://www.openstreetmap.org/copyright

## Licensed image candidates

The Wikimedia Commons API returned the following candidate originals with reusable licences. They are metadata candidates only: no original has been downloaded, selected, transformed or added to Git in this research step. A later asset step must download candidates outside Git, verify each local SHA-1 against Commons, inspect every full-resolution image and test real 390px and desktop crops before selecting one.

1. **Malta – Gozo – Zeebugg - panoramio.jpg** — giggel; captured 28 September 2014; 4320×3240; 3,782,611 bytes; CC BY 3.0; Commons SHA-1 `F9B8DD98510DBFB390F19A9AF31B59F9D7C1B486`.
   - https://commons.wikimedia.org/wiki/File:Malta_%E2%80%93_Gozo_%E2%80%93_Zeebugg_-_panoramio.jpg
2. **Zebbug Parish Church.jpg** — Matt Hush; captured 30 May 2017; 7358×4910; 33,033,430 bytes; CC BY-SA 4.0; Commons SHA-1 `C5566221CF38679C0299567ABBA8577AF83DA792`.
   - https://commons.wikimedia.org/wiki/File:Zebbug_Parish_Church.jpg
3. **Parish Church of St Mary, Żebbuġ, Gozo 002.jpg** — Matthew Axiak; captured 10 August 2020; 4032×2268; 4,867,312 bytes; CC BY-SA 4.0; Commons SHA-1 `CB5F8921B9AC1AF4234718A304EABBC4CD199BD2`.
   - https://commons.wikimedia.org/wiki/File:Parish_Church_of_St_Mary,_%C5%BBebbu%C4%A1,_Gozo_002.jpg
4. **Malte, Gozo, Zebugg 2011-04-19.JPG** — Florival fr; captured 19 April 2011; 4608×3072; 3,682,545 bytes; CC BY-SA 3.0; Commons SHA-1 `E0A46D4B8DDFE8E46D717C647534348060167470`.
   - https://commons.wikimedia.org/wiki/File:Malte,_Gozo,_Zebugg_2011-04-19.JPG
5. **Melħ@Iż-Żebbuġ(Għawdex).jpg** — Eric Bézine; captured 24 December 2008; 3733×2500; 4,018,839 bytes; CC BY-SA 3.0; Commons SHA-1 `593BD4CB659EF928C76BF074489D99576FB37549`.
   - https://commons.wikimedia.org/wiki/File:Mel%C4%A7@I%C5%BC-%C5%BBebbu%C4%A1(G%C4%A7awdex).jpg
6. **Qolla l-Bajda Battery, Żebbuġ, Gozo 003.jpg** — Matthew Axiak; captured 14 August 2018; 4032×2268; 2,124,905 bytes; CC BY-SA 4.0; Commons SHA-1 `6B4E98EE1E4A693007E5E0DA7B41FBB927FEF3BA`.
   - https://commons.wikimedia.org/wiki/File:Qolla_l-Bajda_Battery,_%C5%BBebbu%C4%A1,_Gozo_003.jpg

The preferred hero should represent the hill village rather than only a church façade, restaurant, private residence, cemetery, bay or salt-pan operator. A coastal candidate must not imply that every Iż-Żebbuġ property overlooks or sits beside the sea. The final rendered page must visibly credit the selected author, Wikimedia Commons and licence, with links to the file page and licence.

## Verification and publication boundary

The inventory, Address Registrar, Visit Gozo locality/heritage/coast pages, Malta Public Transport route 309, both exact MTA filters, Wikimedia Commons API and OpenStreetMap Nominatim returned HTTP 200 to the neutral direct client on 29 October 2026. The Local Council and Primary HealthCare pages rejected that client with HTTP 403 but remained current and readable through browser retrieval; Gozo Album was likewise readable through the current browser source. No claim was expanded from those transport-layer differences. Volatile health, transport, event, bathing and operating information remains on the linked live sources.

No private contact details were copied. No image, preview, public HTML, canonical, sitemap, index, route, deployment, backlink, external account, outreach message, WhatsApp message or scheduler was created or changed in this step.
