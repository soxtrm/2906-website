// Canonical neighbourhood editions and public map centres [longitude, latitude].
export const editions = [
  {"slug":"attard","name":"Attard","island":"Malta","key":"malta:attard","center":[14.438,35.892],"aliases":["Attard"]},
  {"slug":"bahar-ic-caghaq","name":"Baħar iċ-Ċagħaq","island":"Malta","key":"malta:bahar-ic-caghaq","center":[14.4695,35.9405],"aliases":["Bahar Ic Caghaq"]},
  {"slug":"bahrija","name":"Il-Baħrija","island":"Malta","key":"malta:bahrija","center":[14.363,35.879],"aliases":["Bahrija"]},
  {"slug":"balzan","name":"Ħal Balzan","island":"Malta","key":"malta:balzan","center":[14.453,35.896],"aliases":["Balzan"]},
  {"slug":"birgu","name":"Birgu (Vittoriosa)","island":"Malta","key":"malta:birgu","center":[14.52395,35.88665],"aliases":["Birgu","Vittoriosa"]},
  {"slug":"birkirkara","name":"Birkirkara","island":"Malta","key":"malta:birkirkara","center":[14.4655,35.8955],"aliases":["Birkirkara"]},
  {"slug":"birzebbuga","name":"Birżebbuġa","island":"Malta","key":"malta:birzebbuga","center":[14.529,35.826],"aliases":["Birzebbuga"]},
  {"slug":"bormla","name":"Bormla (Cospicua)","island":"Malta","key":"malta:bormla","center":[14.5225,35.883],"aliases":["Bormla","Cospicua"]},
  {"slug":"bugibba","name":"Buġibba","island":"Malta","key":"malta:bugibba","center":[14.413,35.9505],"aliases":["Bugibba"]},
  {"slug":"dingli","name":"Ħad-Dingli","island":"Malta","key":"malta:dingli","center":[14.3815,35.857],"aliases":["Dingli"]},
  {"slug":"fgura","name":"Il-Fgura","island":"Malta","key":"malta:fgura","center":[14.5105,35.875],"aliases":["Fgura"]},
  {"slug":"floriana","name":"Floriana","island":"Malta","key":"malta:floriana","center":[14.5055,35.894],"aliases":["Floriana"]},
  {"slug":"fontana-gozo","name":"Il-Fontana","island":"Gozo","key":"gozo:fontana","center":[14.239,36.038],"aliases":["Gozo - Fontana"]},
  {"slug":"ghajnsielem","name":"Għajnsielem","island":"Gozo","key":"gozo:ghajnsielem","center":[14.2915,36.027],"aliases":["Gozo - Ghajnsielem"]},
  {"slug":"gharb-gozo","name":"L-Għarb","island":"Gozo","key":"gozo:gharb","center":[14.2115,36.0615],"aliases":["Gozo - Gharb"]},
  {"slug":"gharghur","name":"Għargħur","island":"Malta","key":"malta:gharghur","center":[14.4535,35.924],"aliases":["Gharghur"]},
  {"slug":"ghaxaq","name":"Ħal Għaxaq","island":"Malta","key":"malta:ghaxaq","center":[14.516,35.849],"aliases":["Ghaxaq"]},
  {"slug":"gudja","name":"Il-Gudja","island":"Malta","key":"malta:gudja","center":[14.503269,35.848938],"aliases":["Gudja"]},
  {"slug":"gzira","name":"Gżira","island":"Malta","key":"malta:gzira","center":[14.4935,35.905],"aliases":["Gzira"]},
  {"slug":"hamrun","name":"Il-Ħamrun","island":"Malta","key":"malta:hamrun","center":[14.48722,35.88656],"aliases":["Hamrun","Ħamrun","Il-Hamrun"]},
  {"slug":"haz-zebbug","name":"Ħaż-Żebbuġ","island":"Malta","key":"malta:zebbug","center":[14.441,35.87],"aliases":["Haz Zebbug","Zebbug"]},
  {"slug":"iklin","name":"Iklin","island":"Malta","key":"malta:iklin","center":[14.455,35.909],"aliases":["Iklin"]},
  {"slug":"kalkara","name":"Il-Kalkara","island":"Malta","key":"malta:kalkara","center":[14.532,35.889],"aliases":["Kalkara"]},
  {"slug":"kappara","name":"Kappara","island":"Malta","key":"malta:kappara","center":[14.4745,35.9015],"aliases":["Kappara"]},
  {"slug":"kirkop","name":"Ħal Kirkop","island":"Malta","key":"malta:kirkop","center":[14.486,35.8425],"aliases":["Kirkop"]},
  {"slug":"lija","name":"Ħal Lija","island":"Malta","key":"malta:lija","center":[14.4455,35.901],"aliases":["Lija"]},
  {"slug":"luqa","name":"Ħal Luqa","island":"Malta","key":"malta:luqa","center":[14.491,35.857],"aliases":["Luqa"]},
  {"slug":"madliena","name":"Madliena","island":"Malta","key":"malta:madliena","center":[14.4755,35.932],"aliases":["Madliena"]},
  {"slug":"manikata","name":"Manikata","island":"Malta","key":"malta:manikata","center":[14.3535,35.9415],"aliases":["Manikata"]},
  {"slug":"marsa","name":"Marsa","island":"Malta","key":"malta:marsa","center":[14.49,35.879],"aliases":["Marsa"]},
  {"slug":"marsalforn-gozo","name":"Marsalforn","island":"Gozo","key":"gozo:marsalforn","center":[14.258,36.064],"aliases":["Gozo - Marsalforn"]},
  {"slug":"marsaskala","name":"Marsaskala","island":"Malta","key":"malta:marsaskala","center":[14.56,35.8605],"aliases":["Marsaskala"]},
  {"slug":"marsaxlokk","name":"Marsaxlokk","island":"Malta","key":"malta:marsaxlokk","center":[14.542,35.84],"aliases":["Marsaxlokk"]},
  {"slug":"mdina","name":"L-Imdina","island":"Malta","key":"malta:mdina","center":[14.4038738,35.8848166],"aliases":["Mdina","Imdina","L-Imdina","Città Notabile"]},
  {"slug":"mellieha","name":"Mellieħa","island":"Malta","key":"malta:mellieha","center":[14.362,35.9555],"aliases":["Mellieha"]},
  {"slug":"mgarr","name":"Mġarr","island":"Malta","key":"malta:mgarr","center":[14.3675,35.921],"aliases":["Mgarr"]},
  {"slug":"mosta","name":"Mosta","island":"Malta","key":"malta:mosta","center":[14.426,35.9095],"aliases":["Mosta"]},
  {"slug":"mqabba","name":"L-Imqabba","island":"Malta","key":"malta:mqabba","center":[14.46715,35.84548],"aliases":["Mqabba","Imqabba"]},
  {"slug":"msida","name":"Msida","island":"Malta","key":"malta:msida","center":[14.4865,35.898],"aliases":["Msida"]},
  {"slug":"mtarfa","name":"L-Imtarfa","island":"Malta","key":"malta:mtarfa","center":[14.4002277,35.8930146],"aliases":["Mtarfa","Imtarfa","L-Imtarfa"]},
  {"slug":"nadur-gozo","name":"In-Nadur","island":"Gozo","key":"gozo:nadur","center":[14.2942943,36.0376895],"aliases":["Nadur","In-Nadur","Gozo - Nadur"]},
  {"slug":"naxxar","name":"Naxxar","island":"Malta","key":"malta:naxxar","center":[14.4445,35.914],"aliases":["Naxxar"]},
  {"slug":"paola","name":"Paola (Raħal Ġdid)","island":"Malta","key":"malta:paola","center":[14.4985,35.8725],"aliases":["Paola","Rahal Gdid"]},
  {"slug":"pembroke","name":"Pembroke","island":"Malta","key":"malta:pembroke","center":[14.4795,35.9255],"aliases":["Pembroke"]},
  {"slug":"pieta","name":"Pietà","island":"Malta","key":"malta:pieta","center":[14.494,35.8935],"aliases":["Pieta"]},
  {"slug":"qala-gozo","name":"Il-Qala","island":"Gozo","key":"gozo:qala","center":[14.301,36.0295],"aliases":["Gozo - Qala"]},
  {"slug":"qawra","name":"Qawra","island":"Malta","key":"malta:qawra","center":[14.42,35.9545],"aliases":["Qawra"]},
  {"slug":"qrendi","name":"Il-Qrendi","island":"Malta","key":"malta:qrendi","center":[14.45775,35.8346],"aliases":["Qrendi"]},
  {"slug":"qormi","name":"Ħal Qormi","island":"Malta","key":"malta:qormi","center":[14.46835,35.88223],"aliases":["Qormi","Hal Qormi","Citta Pinto"]},
  {"slug":"rabat","name":"Rabat","island":"Malta","key":"malta:rabat","center":[14.3975,35.8815],"aliases":["Rabat"]},
  {"slug":"safi","name":"Ħal Safi","island":"Malta","key":"malta:safi","center":[14.48675,35.83405],"aliases":["Safi"]},
  {"slug":"salina","name":"Salina","island":"Malta","key":"malta:salina","center":[14.4185,35.952],"aliases":["Salina"]},
  {"slug":"san-gwann","name":"San Ġwann","island":"Malta","key":"malta:san-gwann","center":[14.475,35.912],"aliases":["San Gwann"]},
  {"slug":"san-lawrenz-gozo","name":"San Lawrenz","island":"Gozo","key":"gozo:san-lawrenz","center":[14.2035276,36.0554759],"aliases":["San Lawrenz","St Lawrence","Gozo - San Lawrenz"]},
  {"slug":"sannat-gozo","name":"Ta’ Sannat","island":"Gozo","key":"gozo:sannat","center":[14.244,36.0135],"aliases":["Gozo - Sannat"]},
  {"slug":"santa-lucija","name":"Santa Luċija","island":"Malta","key":"malta:santa-lucija","center":[14.50444,35.8625],"aliases":["Santa Lucija","Santa Lucia","Sta Lucia","Sta Lucija","Saint Lucia"]},
  {"slug":"santa-venera","name":"Santa Venera","island":"Malta","key":"malta:santa-venera","center":[14.4755,35.8885],"aliases":["Santa Venera"]},
  {"slug":"senglea","name":"L-Isla (Senglea)","island":"Malta","key":"malta:senglea","center":[14.51687,35.887416],"aliases":["Senglea","Isla"]},
  {"slug":"siggiewi","name":"Siġġiewi","island":"Malta","key":"malta:siggiewi","center":[14.438,35.855],"aliases":["Siggiewi"]},
  {"slug":"sliema","name":"Sliema","island":"Malta","key":"malta:sliema","center":[14.5027,35.9138],"aliases":["Sliema"]},
  {"slug":"st-julians","name":"St Julian’s","island":"Malta","key":"malta:st-julian-s","center":[14.4905,35.9205],"aliases":["St Julians","St Julian's","San Giljan"]},
  {"slug":"st-pauls-bay","name":"St Paul’s Bay","island":"Malta","key":"malta:st-paul-s-bay","center":[14.403,35.95],"aliases":["St Pauls Bay","St Paul's Bay","San Pawl il-Bahar"]},
  {"slug":"swatar","name":"Swatar","island":"Malta","key":"malta:swatar","center":[14.469,35.8945],"aliases":["Swatar","Swatar (Birkirkara)"]},
  {"slug":"swieqi","name":"Swieqi","island":"Malta","key":"malta:swieqi","center":[14.475,35.925],"aliases":["Swieqi"]},
  {"slug":"ta-xbiex","name":"Ta’ Xbiex","island":"Malta","key":"malta:ta-xbiex","center":[14.498,35.899],"aliases":["Ta Xbiex"]},
  {"slug":"tal-ibrag","name":"Tal-Ibraġ","island":"Malta","key":"malta:ta-ibragg","center":[14.475,35.92],"aliases":["Tal Ibrag","Ta Ibragg (Swieqi)","Ta Ibragg","Tal Ibragg"]},
  {"slug":"tarxien","name":"Ħal Tarxien","island":"Malta","key":"malta:tarxien","center":[14.513206,35.866517],"aliases":["Tarxien"]},
  {"slug":"valletta","name":"Valletta","island":"Malta","key":"malta:valletta","center":[14.5145,35.8985],"aliases":["Valletta"]},
  {"slug":"victoria-gozo","name":"Victoria (Ir-Rabat)","island":"Gozo","key":"gozo:victoria","center":[14.2405,36.0445],"aliases":["Gozo - Victoria","Gozo - Rabat (Victoria)"]},
  {"slug":"xaghra-gozo","name":"Ix-Xagħra","island":"Gozo","key":"gozo:xaghra","center":[14.265,36.0515],"aliases":["Gozo - Xaghra"]},
  {"slug":"xemxija","name":"Ix-Xemxija","island":"Malta","key":"malta:xemxija","center":[14.384,35.9495],"aliases":["Xemxija"]},
  {"slug":"xewkija-gozo","name":"Ix-Xewkija","island":"Gozo","key":"gozo:xewkija","center":[14.2610087,36.0317516],"aliases":["Xewkija","Ix-Xewkija","Gozo - Xewkija"]},
  {"slug":"xghajra","name":"Ix-Xgħajra","island":"Malta","key":"malta:xghajra","center":[14.545,35.8855],"aliases":["Xghajra"]},
  {"slug":"zabbar","name":"Ħaż-Żabbar","island":"Malta","key":"malta:zabbar","center":[14.536,35.8765],"aliases":["Zabbar"]},
  {"slug":"zebbug-gozo","name":"Iż-Żebbuġ","island":"Gozo","key":"gozo:zebbug","center":[14.246,36.066],"aliases":["Gozo - Zebbug"]},
  {"slug":"zejtun","name":"Żejtun","island":"Malta","key":"malta:zejtun","center":[14.533,35.855],"aliases":["Zejtun"]},
  {"slug":"zurrieq","name":"Żurrieq","island":"Malta","key":"malta:zurrieq","center":[14.4735,35.8275],"aliases":["Zurrieq"]}
];
export function normalisePlace(value) {
  return String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/ħ/g, 'h').replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

export function findEdition(name, areaKey) {
  const key = String(areaKey ?? '').toLowerCase();
  const label = normalisePlace(name);
  return editions.find(edition => edition.key === key) || editions.find(edition =>
    (!key.includes(':') || key.startsWith(edition.island.toLowerCase() + ':')) &&
    [edition.name, ...edition.aliases].some(alias => normalisePlace(alias) === label));
}

export const editionPath = edition => '/link-marketplace/areas/' + edition.slug + '.html';
