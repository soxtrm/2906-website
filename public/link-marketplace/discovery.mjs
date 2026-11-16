import {editions, normalisePlace, findEdition} from './editions.mjs';
import {createLocalityMap} from './property-map.mjs';

const groups = {
  all: ['All mapped places', []],
  food: ['Food & drink', ['restaurant', 'cafe', 'bar', 'nightlife', 'nightclub']],
  stays: ['Stays', ['hotel']],
  shopping: ['Shopping', ['grocery', 'shopping', 'supermarket', 'convenience']],
  outdoors: ['Things to do', ['beach', 'gym', 'sport', 'park', 'swimming_spot']],
  essentials: ['Everyday essentials', ['atm', 'medical', 'pharmacy', 'healthcare']],
};

const connectors = {food:'social', stays:'mobility', shopping:'daily', outdoors:'wellbeing', essentials:'daily'};
const markets = {longlets:'Rent', sales:'Buy', stays:'Shortlet', commercials:'Commercial'};
const hubPath = '/link-marketplace/index.html';

function el(tag, text, attributes = {}) {
  const element = document.createElement(tag);
  if (text) element.textContent = text;
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
  return element;
}

async function readPublicFeed(path) {
  const response = await fetch(path, {cache:'no-store'});
  if (!response.ok) throw new Error('Feed unavailable');
  return response.json();
}

function nearbyPlaces(records, centre) {
  const radians = Math.PI / 180;
  return records.filter(place => place.mapVisible === true && place.searchable !== false &&
    typeof place.name === 'string' && Array.isArray(place.coordinates) &&
    place.coordinates.length === 2 && place.coordinates.every(Number.isFinite))
    .map(place => {
      const [lng, lat] = place.coordinates;
      const a = Math.sin((lat-centre[1])*radians/2)**2 +
        Math.cos(centre[1]*radians)*Math.cos(lat*radians)*Math.sin((lng-centre[0])*radians/2)**2;
      const distance = 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
      const industry = Object.keys(connectors).find(key => groups[key][1].includes(place.kind));
      return {...place, distance, connector:connectors[industry] || 'daily'};
    }).filter(place => place.distance <= 2).sort((a,b) => a.distance-b.distance);
}

function attachPlaces(root, localEdition) {
  const ui = root.querySelector('[data-place-ui]');
  const trigger = ui.querySelector('[data-map-open]');
  let feed, map, pending, selector, category, list, canvas, status, active;
  let group = 'all';

  const setSector = key => {
    group = Object.hasOwn(groups,key) ? key : 'all';
    if (category) category.value = group;
    if (!localEdition) document.querySelectorAll('[data-sector]').forEach(link => {
      if (link.dataset.sector === group) link.setAttribute('aria-current','true');
      else link.removeAttribute('aria-current');
    });
    if (canvas) chooseCategory();
  };

  function selectPlace(place) {
    map?.focus(place.id);
    const detail = el('span', place.name + ' · ' + place.kind.replaceAll('_',' ') + ' · ');
    const [lng,lat] = place.coordinates;
    const directions = el('a','Open in OpenStreetMap ↗',{
      href:'https://www.openstreetmap.org/?mlat='+lat+'&mlon='+lng+'#map=18/'+lat+'/'+lng,
      rel:'noopener',target:'_blank',
    });
    status.replaceChildren(detail,directions);
  }

  function chooseCategory() {
    const kinds = group === 'all' ? null : groups[group][1];
    const hits = kinds ? active.filter(place => kinds.includes(place.kind)) : active;
    map?.filter(kinds);
    status.textContent = hits.length
      ? 'Mapped places within 2 km · showing '+ Math.min(8,hits.length) +' of '+hits.length+' below. Check venues for opening hours.'
      : 'No mapped places in this category within 2 km. Try another category or neighbourhood.';
    list.replaceChildren(...hits.slice(0,8).map(place => {
      const item = el('li');
      const button = el('button',place.name,{type:'button'});
      button.append(el('small',place.kind.replaceAll('_',' ')));
      button.addEventListener('click',() => selectPlace(place));
      item.append(button);
      return item;
    }));
  }

  let revision = 0;
  async function drawMap() {
    const edition = localEdition || editions.find(item => item.slug === selector.value);
    const version = ++revision;
    map?.destroy();
    map = null;
    active = nearbyPlaces(feed,edition.center);
    const locations = active;
    const surface = el('div','',{class:'nx-place-map',role:'region','aria-label':'Map around '+edition.name});
    canvas.replaceChildren(surface);
    chooseCategory();
    try {
      const instance = await createLocalityMap(surface,edition.center,locations,{
        onSelect:id => { const place = locations.find(item => item.id === id); if (place) selectPlace(place); },
      });
      if (version !== revision) {
        instance?.destroy();
        return;
      }
      map = instance;
      map?.filter(group === 'all' ? null : groups[group][1]);
    } catch {
      if (version === revision) {
        surface.remove();
        status.textContent = 'The map could not load. You can still browse the mapped places below.';
      }
    }
  }

  async function load() {
    if (pending || canvas) return;
    pending = true;
    trigger.disabled = true;
    trigger.textContent = 'Loading mapped places…';
    try {
      const payload = await readPublicFeed('/api/nexus/places');
      if (!Array.isArray(payload.records)) throw new Error('Places unavailable');
      feed = payload.records;
    } catch {
      trigger.disabled = false;
      trigger.textContent = 'Retry loading places';
      pending = false;
      return;
    }
    const controls = el('div','',{class:'nx-explorer-controls'});
    if (!localEdition) {
      const label = el('label','Neighbourhood');
      selector = el('select','',{'aria-label':'Map neighbourhood'});
      selector.append(...editions.map(item => el('option',item.name+' · '+item.island,{value:item.slug})));
      selector.value = 'valletta';
      selector.addEventListener('change',drawMap);
      label.append(selector);
      controls.append(label);
    }
    const label = el('label','Industry');
    category = el('select','',{'aria-label':'Place industry'});
    category.append(...Object.entries(groups).map(([value,[name]]) => el('option',name,{value})));
    category.value = group;
    category.addEventListener('change',() => setSector(category.value));
    label.append(category);
    controls.append(label);
    canvas = el('div');
    status = el('p','',{'data-map-status':'',role:'status'});
    list = el('ul','',{class:'nx-poi-list','aria-label':'Nearby mapped places'});
    const focusAfterLoad = document.activeElement === trigger;
    ui.replaceChildren(controls,canvas,status,list);
    if (focusAfterLoad) category.focus({preventScroll:true});
    await drawMap();
  }

  trigger.addEventListener('click',load);
  if (!localEdition) {
    document.querySelectorAll('[data-sector]').forEach(link => link.addEventListener('click',() => {
      setSector(link.dataset.sector);
      load();
    }));
  }
}

async function loadHomes(section, edition) {
  const output = section.querySelector('[data-local-homes-list]');
  output.textContent = 'Loading live listings…';
  try {
    const payload = await readPublicFeed('/api/nexus/inventory');
    if (!Array.isArray(payload.properties) || payload.meta?.firewall_leaks?.length) throw new Error('Inventory unavailable');
    const listings = payload.properties.filter(home =>
      home.listable === true && ['available','available_confirmed','upcoming'].includes(home.status) &&
      home.images?.length && findEdition(home.areaLabel,home.area)?.slug === edition.slug
    ).slice(0,4);
    if (!listings.length) {
      output.textContent = 'There are no published homes in this neighbourhood in the current feed.';
      return;
    }
    const list = el('ul');
    const currency = new Intl.NumberFormat('en-IE',{style:'currency',currency:'EUR',maximumFractionDigits:0});
    for (const home of listings) {
      const market = Object.hasOwn(markets,home.market) ? home.market : 'longlets';
      const price = Number.isFinite(home.rent) && home.rent > 0
        ? currency.format(home.rent) + (market !== 'sales' && home.rentPeriod ? ' / '+home.rentPeriod : '')
        : 'Price on request';
      const params = new URLSearchParams({area:edition.slug,market,property:home.id});
      const link = el('a','',{href:hubPath+'?'+params+'#homes'});
      const name = home.title?.trim() || ((home.propertyType || 'Property').replaceAll('-',' ')+' · '+edition.name);
      link.append(el('span',name),el('span',markets[market]+' · '+price));
      const item = el('li');
      item.append(link);
      list.append(item);
    }
    output.replaceChildren(list);
  } catch {
    output.textContent = 'Live listings could not be loaded. You can still open the local listing search below.';
  }
}

const directory = document.querySelector('#edition-directory');
if (directory) {
  const filter = directory.querySelector('#edition-filter');
  filter.addEventListener('input',() => {
    const value = normalisePlace(filter.value);
    let count = 0;
    for (const item of directory.querySelectorAll('[data-edition-key]')) {
      const edition = editions.find(entry => entry.slug === item.dataset.editionKey);
      item.hidden = !normalisePlace([edition.name,edition.island,...edition.aliases].join(' ')).includes(value);
      if (!item.hidden) count++;
    }
    directory.querySelector('#edition-count').textContent = count ? count+' editions' : 'No editions match this search.';
  });
}

const explorer = document.querySelector('[data-market-places]');
if (explorer) attachPlaces(explorer);
const local = document.querySelector('[data-local-market]');
const localEdition = local && editions.find(edition => edition.slug === local.dataset.localMarket);
if (localEdition) attachPlaces(local,localEdition);

const observed = document.querySelectorAll('.nx-edition-card, [data-local-market]');
if ('IntersectionObserver' in window) {
  const observe = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      entry.target.classList.add('nx-arrive');
      if (entry.target === local && localEdition) loadHomes(local,localEdition);
      observe.unobserve(entry.target);
    }
  },{threshold:0.08});
  observed.forEach(node => observe.observe(node));
} else if (localEdition) {
  loadHomes(local,localEdition);
}
