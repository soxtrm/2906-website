import {createArgusInventoryAdapter} from './argus-inventory.mjs';
import {DESIGN_PROPERTIES} from './design-inventory.mjs';
import {DEMO_PROPERTIES,DEVELOPMENTS,evaluateDemo} from './data.mjs';
export class IntegrationUnavailable extends Error {constructor(message='This action needs the 2906 / ARGUS connection.'){super(message);this.name='IntegrationUnavailable';}}
const delay=()=>new Promise(r=>setTimeout(r,240));
const config=globalThis.NEXUS_CONFIG||{};
const safeRead=()=>{try{return JSON.parse(localStorage.getItem('nexus-link-demo-favorites')||'[]').filter(id=>[...DEMO_PROPERTIES,...DESIGN_PROPERTIES].some(p=>p.id===id));}catch{return [];}};
const previewProperties=()=>[...DEMO_PROPERTIES,...(config.designInventory===false?[]:DESIGN_PROPERTIES)];
let demoFavorites=safeRead(),activitySeed;
export const demoAdapter={mode:'demo',
 async getActivities(){activitySeed||=fetch('./assets/activity-seed.json').then(r=>{if(!r.ok)throw new Error('Activity data unavailable');return r.json();}).catch(error=>{activitySeed=null;throw error;});return {records:await activitySeed,coverage:'partial'};},
 async getMatches(profile){await delay();return evaluateDemo(profile,previewProperties());},
 async getProperty(id){await delay();const p=previewProperties().find(p=>p.id===id);if(!p)throw new Error('This property could not be found.');return {...p};},
 async getDevelopment(id){const d=DEVELOPMENTS.find(d=>d.id===id);if(!d)throw new Error('Development not found.');return {...d,properties:DEMO_PROPERTIES.filter(p=>p.developmentId===id)};},
 async getFavorites(){return [...demoFavorites];},
 async setFavorite(id,saved){if(!previewProperties().some(p=>p.id===id))throw new Error('Unknown property.');const set=new Set(demoFavorites);saved?set.add(id):set.delete(id);demoFavorites=[...set];try{localStorage.setItem('nexus-link-demo-favorites',JSON.stringify(demoFavorites));}catch{}return {saved,scope:'device'};},
 async getViewingSlots(){return {slots:[],connected:false};},async requestViewing(){throw new IntegrationUnavailable('Viewing requests are not sent in the demo.');},async createSelectionLink(){throw new IntegrationUnavailable('A private selection link needs the 2906 connection.');}
};
export function createHttpAdapter({baseUrl,endpoints={}}){
 const root=new URL(baseUrl,location.origin);if(!['https:','http:'].includes(root.protocol))throw new Error('Invalid API URL.');
 const routes={activities:'/link/intelligence/activities',matches:'/link/matches',property:'/properties/{id}',development:'/developments/{id}',favorites:'/link/favorites',slots:'/properties/{id}/viewing-slots',viewing:'/properties/{id}/viewing-requests',selection:'/link/selections',...endpoints};
 async function request(key,{id,method='GET',body}={}){const path=routes[key].replace('{id}',encodeURIComponent(id??''));const url=new URL(root.href.replace(/\/$/,'')+'/'+path.replace(/^\//,''));const response=await fetch(url,{method,credentials:'same-origin',headers:{Accept:'application/json',...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});if(!response.ok)throw new Error(response.status===401?'Please sign in through 2906 to continue.':'The connection could not complete this request. Please try again.');return response.status===204?{}:response.json();}
 return {mode:'live',getActivities:anchor=>request('activities',{method:'POST',body:{anchorId:anchor.id,kind:anchor.kind,origin:anchor.coordinates}}),getMatches:profile=>request('matches',{method:'POST',body:{profile}}),getProperty:id=>request('property',{id}),getDevelopment:id=>request('development',{id}),getFavorites:()=>request('favorites'),setFavorite:(id,saved)=>request('favorites',{method:'POST',body:{propertyId:id,saved}}),getViewingSlots:id=>request('slots',{id}),requestViewing:(id,slotId)=>request('viewing',{id,method:'POST',body:{slotId}}),createSelectionLink:propertyIds=>request('selection',{method:'POST',body:{propertyIds}})};
}
export const adapter=config.mode==='argus'&&config.inventoryUrl?createArgusInventoryAdapter({inventoryUrl:config.inventoryUrl,placesUrl:config.placesUrl,designProperties:config.designInventory===false?[]:DESIGN_PROPERTIES,getActivities:demoAdapter.getActivities}):config.mode==='live'&&config.apiBase?createHttpAdapter({baseUrl:config.apiBase,endpoints:config.endpoints}):demoAdapter;
