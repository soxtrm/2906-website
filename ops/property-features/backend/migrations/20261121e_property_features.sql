-- NEXUS adaptive property features (Claude, 2026-11-21). Additive.
-- nexus_feature_dictionary: canonical features (the 27 ARGUS feature tags + counters + common extras) with aliases in
--   several languages, and owner/agent-proposed CANDIDATES that stay out of filters until staff promote them.
-- nexus_property_features: what is stated about one property, with provenance: who stated it (owner / agent / import),
--   whether an agent confirmed it, and whether a document or an independent check supports it. properties.feature_tags
--   (the extracted/manual tag array) is unchanged and keeps feeding the existing website filters.
BEGIN;
CREATE TABLE IF NOT EXISTS nexus_feature_dictionary (
  key TEXT PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  label TEXT NOT NULL,
  grp TEXT NOT NULL DEFAULT 'other',
  kind TEXT NOT NULL DEFAULT 'boolean' CHECK (kind IN ('boolean','count','choice')),
  choices TEXT[] NOT NULL DEFAULT '{}',
  aliases TEXT[] NOT NULL DEFAULT '{}',
  categories TEXT[] NOT NULL DEFAULT '{residential}',
  status TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN ('standard','candidate','retired')),
  filterable BOOLEAN NOT NULL DEFAULT false,
  argus_tag TEXT,
  created_from TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS nexus_property_features (
  id BIGSERIAL PRIMARY KEY,
  property_id INT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  feature_key TEXT NOT NULL REFERENCES nexus_feature_dictionary(key) ON UPDATE CASCADE,
  value JSONB NOT NULL DEFAULT 'true'::jsonb,
  original_text TEXT CHECK (original_text IS NULL OR length(original_text) <= 200),
  note TEXT CHECK (note IS NULL OR length(note) <= 300),
  source TEXT NOT NULL CHECK (source IN ('owner','agent','import')),
  confirmation TEXT NOT NULL DEFAULT 'declared' CHECK (confirmation IN ('declared','agent_confirmed','rejected')),
  verification TEXT NOT NULL DEFAULT 'none' CHECK (verification IN ('none','document','verified')),
  document_id INT REFERENCES owner_documents(id) ON DELETE SET NULL,
  declared_by_account BIGINT REFERENCES sync_accounts(id) ON DELETE SET NULL,
  declared_by_agent INT REFERENCES agents(id) ON DELETE SET NULL,
  confirmed_by_agent INT REFERENCES agents(id) ON DELETE SET NULL,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (property_id, feature_key)
);
CREATE INDEX IF NOT EXISTS nexus_property_features_key ON nexus_property_features (feature_key);
CREATE INDEX IF NOT EXISTS nexus_property_features_review ON nexus_property_features (created_at) WHERE confirmation = 'declared';

INSERT INTO nexus_feature_dictionary (key, label, grp, kind, choices, aliases, status, filterable, argus_tag, created_from) VALUES
 -- counters
 ('balconies','Balconies','outdoor','count','{}','{balcony,balconies,balkon,balkone,balcone,balconi,balcon,balcons,gallarija}','standard',true,'balcony','seed'),
 ('terraces','Terraces','outdoor','count','{}','{terrace,terraces,terrasse,terrassen,terrazza,terrazzo,terrazzi,terraza,roof terrace,dachterrasse}','standard',true,'terrace','seed'),
 ('showers','Showers','bathroom','count','{}','{shower,showers,dusche,duschen,doccia,docce,douche,ducha,walk in shower,walk-in shower}','standard',false,null,'seed'),
 ('bathtubs','Bathtubs','bathroom','count','{}','{bathtub,bath tub,bath,badewanne,vasca da bagno,vasca,baignoire,banera,bañera}','standard',true,'bathtub','seed'),
 ('parking_spaces','Parking spaces','parking','count','{}','{parking,parking space,parking spaces,car space,stellplatz,parkplatz,posto auto,parcheggio,place de parking,aparcamiento,garage space}','standard',true,'parking','seed'),
 ('furnishing','Furnishing','comfort','choice','{furnished,part_furnished,unfurnished}','{furnished,unfurnished,part furnished,semi furnished,möbliert,moebliert,unmöbliert,arredato,non arredato,meublé,meuble,amueblado}','standard',true,'furnished','seed'),
 ('shower_type','Shower type','bathroom','choice','{walk_in,cabin,over_bath,rain_shower}','{walk in shower,shower cabin,rain shower,regendusche,doccia a pioggia,douche à l italienne}','standard',false,null,'seed'),
 -- the ARGUS feature tags (services/featureTags.js)
 ('air_conditioning','Air conditioning','comfort','boolean','{}','{air conditioning,aircon,air con,a/c,ac,klimaanlage,klima,aria condizionata,condizionatore,climatisation,climatisé,aire acondicionado}','standard',true,'air_conditioning','seed'),
 ('garden','Garden','outdoor','boolean','{}','{garden,yard,backyard,garten,giardino,jardin,jardín,ġnien}','standard',true,'garden','seed'),
 ('pool','Swimming pool','outdoor','boolean','{}','{pool,swimming pool,pool area,schwimmbad,pool,piscina,piscine}','standard',true,'pool','seed'),
 ('lift','Lift','building','boolean','{}','{lift,elevator,aufzug,fahrstuhl,ascensore,ascenseur,ascensor}','standard',true,'lift','seed'),
 ('sea_view','Sea view','view','boolean','{}','{sea view,sea views,ocean view,seaview,meerblick,vista mare,vue sur mer,vista al mar,veduta tal-baħar}','standard',true,'sea_view','seed'),
 ('washing_machine','Washing machine','kitchen','boolean','{}','{washing machine,washer,waschmaschine,lavatrice,lave-linge,lavadora}','standard',true,'washing_machine','seed'),
 ('dishwasher','Dishwasher','kitchen','boolean','{}','{dishwasher,geschirrspüler,spülmaschine,lavastoviglie,lave-vaisselle,lavavajillas}','standard',true,'dishwasher','seed'),
 ('storage_room','Storage room','building','boolean','{}','{storage,storage room,store room,box room,abstellraum,ripostiglio,cantina,débarras,trastero}','standard',true,'storage_room','seed'),
 ('fireplace','Fireplace','comfort','boolean','{}','{fireplace,kamin,camino,cheminée,chimenea}','standard',true,'fireplace','seed'),
 ('double_glazing','Double glazing','comfort','boolean','{}','{double glazing,double glazed,doppelverglasung,doppio vetro,double vitrage,doble acristalamiento}','standard',true,'double_glazing','seed'),
 ('built_in_wardrobes','Built-in wardrobes','rooms','boolean','{}','{built in wardrobes,fitted wardrobes,einbauschrank,armadio a muro,placards,armarios empotrados}','standard',true,'built_in_wardrobes','seed'),
 ('alarm_system','Alarm system','security','boolean','{}','{alarm,alarm system,alarmanlage,allarme,antifurto,alarme}','standard',true,'alarm_system','seed'),
 ('solar_water_heater','Solar water heater','energy','boolean','{}','{solar water heater,solar heater,solarthermie,pannello solare termico,chauffe-eau solaire}','standard',true,'solar_water_heater','seed'),
 ('concierge','Concierge','building','boolean','{}','{concierge,doorman,portier,portiere,conserje}','standard',true,'concierge','seed'),
 ('gym','Gym','building','boolean','{}','{gym,fitness room,fitnessraum,palestra,salle de sport,gimnasio}','standard',true,'gym','seed'),
 ('jacuzzi','Jacuzzi','outdoor','boolean','{}','{jacuzzi,hot tub,whirlpool,idromassaggio,spa bath}','standard',true,'jacuzzi','seed'),
 ('rooftop_access','Roof access','outdoor','boolean','{}','{roof access,rooftop,roof,dachzugang,accesso al tetto,bejt}','standard',true,'rooftop_access','seed'),
 ('garage','Garage','parking','boolean','{}','{garage,garaxx,garage box,box auto}','standard',true,'garage','seed'),
 ('study','Study','rooms','boolean','{}','{study,home office,office room,arbeitszimmer,studio,bureau,despacho}','standard',true,'study','seed'),
 ('step_free','Step-free access','accessibility','boolean','{}','{step free,step-free,wheelchair accessible,barrierefrei,senza barriere,accessible,accès pmr}','standard',true,'step_free','seed'),
 ('internet','Internet','comfort','boolean','{}','{internet,wifi,wi-fi,fibre,fiber,broadband,wlan}','standard',true,'internet','seed'),
 -- common extras (not yet ARGUS tags)
 ('soundproof_windows','Soundproof windows','comfort','boolean','{}','{soundproof windows,soundproof glass,soundproof glazing,acoustic windows,acoustic glazing,noise reducing windows,noise insulated windows,schallschutzfenster,schallschutzverglasung,vetri insonorizzati,finestre insonorizzate,fenêtres insonorisées,vitrage acoustique,ventanas insonorizadas}','standard',true,null,'seed'),
 ('underfloor_heating','Underfloor heating','comfort','boolean','{}','{underfloor heating,floor heating,fußbodenheizung,fussbodenheizung,riscaldamento a pavimento,chauffage au sol,suelo radiante}','standard',true,null,'seed'),
 ('central_heating','Central heating','comfort','boolean','{}','{central heating,heating,zentralheizung,heizung,riscaldamento,chauffage central,calefacción}','standard',true,null,'seed'),
 ('solar_panels','Solar panels','energy','boolean','{}','{solar panels,photovoltaic,pv panels,photovoltaik,pannelli solari,fotovoltaico,panneaux solaires,placas solares}','standard',true,null,'seed'),
 ('ev_charger','EV charger','parking','boolean','{}','{ev charger,electric car charger,wallbox,ladestation,colonnina di ricarica,borne de recharge}','standard',true,null,'seed'),
 ('pets_area','Pet-friendly outdoor space','outdoor','boolean','{}','{dog run,pet area,pet friendly garden}','candidate',false,null,'seed'),
 ('smart_home','Smart home controls','comfort','boolean','{}','{smart home,home automation,smart thermostat,hausautomation,domotica,domotique}','standard',false,null,'seed'),
 ('laundry_room','Laundry room','rooms','boolean','{}','{laundry room,utility room,waschküche,lavanderia,buanderie}','standard',false,null,'seed'),
 ('walk_in_closet','Walk-in closet','rooms','boolean','{}','{walk in closet,walk-in wardrobe,dressing room,ankleidezimmer,cabina armadio,dressing}','standard',false,null,'seed'),
 ('water_tank','Water tank / pump','building','boolean','{}','{water tank,water pump,booster pump,wasserpumpe,serbatoio,pompa acqua}','standard',false,null,'seed'),
 ('sea_access','Direct sea access','view','boolean','{}','{sea access,beach access,direct access to the sea,meerzugang,accesso al mare,accès à la mer}','standard',true,null,'seed')
ON CONFLICT (key) DO NOTHING;
COMMIT;
