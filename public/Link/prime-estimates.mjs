// User-provided starting estimates, 24 Sep 2026. Not calculated from CRM listings.
// Monthly longlet orientation only. Null maximum means an open-ended range.
export const PRIME_ESTIMATES=[
 {name:'Pendergardens',ids:[34,35,36],min:1500,max:9000},
 {name:'Portomaso',ids:[4,5],min:1800,max:15000},
 {name:'Mercury',ids:[6],min:1900,max:20000},
 {name:'Mercury Studios',ids:[7],min:1800,max:3500},
 {name:'Verdala Terraces',ids:[26],min:2500,max:14000},
 {name:'Madliena Village',ids:[22],min:2000,max:8000},
 {name:'OneOneO',ids:[1],min:2500,max:14000},
 {name:'Fort Cambridge',ids:[2,3],min:1400,max:24000},
 {name:'Fortina',ids:[14],min:8000,max:18000},
 {name:'Tigné Point',ids:[15,16,17,18],min:2000,max:15000},
 {name:'Creekville',ids:[10,11],min:1900,max:7000},
 {name:'Balluta Terraces',ids:[12],min:1500,max:6000},
 {name:'Balluta Buildings',ids:[13],min:1900,max:9000},
 {name:'ORA / Hard Rock',ids:[8,9,37],min:4500,max:null},
 {name:'IVORY Bugibba',ids:[23],min:2500,max:4000}
].map(p=>({...p,period:'month',currency:'EUR',source:'Owner-supplied concept estimate',asOf:'2026-09-24'}));
export const primeEstimate=id=>PRIME_ESTIMATES.find(p=>p.ids.includes(Number(id)));
export function estimateLabel(estimate){if(!estimate)return '';const money=n=>new Intl.NumberFormat('en-IE',{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(n);return `${money(estimate.min)}${estimate.max===null?'+':' – '+money(estimate.max)}`;}
