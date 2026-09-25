// Reviewed against public ARGUS listing descriptions on 2026-09-24.
// These identify a development, never an apartment's exact address or block.
const reviewed = [
 ['2906-156','portomaso',/home in portomaso/i],
 ['2906-9138','portomaso',/apartment in the prestigious portomaso development/i],
 ['2906-9166','portomaso',/apartment in portomaso/i],
 ['2906-9253','portomaso',/apartment at portomaso laguna/i],
 ['2906-9103','creekville',/apartment in the sought-after creekville area/i],
 ['2906-9193','creekville',/apartment at creekville/i],
 ['2906-9221','creekville',/residence at creekville/i],
 ['2906-9119','fort-cambridge',/home at fort cambridge/i],
 ['2906-9139','pendergardens',/apartment in the prestigious pender gardens/i],
 ['2906-9271','pendergardens',/apartment in prestigious pender gardens/i],
 ['2906-9200','oneoneo',/set on the highest floor of oneoneo/i],
 ['2906-9208','mercury',/residence within the iconic mercury development/i],
 ['2906-9268','tigne-point',/residence at prestigious tign.{1,3} point/i],
];
// These phrases describe membership; proximity alone is deliberately insufficient.
const membership = [
 ['portomaso', /(?:home|apartment|residence|penthouse|studio)\s+(?:within|in|at)\s+(?:(?:the|prestigious|luxury|exclusive)\s+)*portomaso(?:\s+laguna)?\b/i],
 ['creekville', /(?:home|apartment|residence|penthouse|studio)\s+(?:within|in|at)\s+(?:(?:the|sought-after|prestigious)\s+)*creekville\b/i],
 ['mercury', /(?:home|apartment|residence|penthouse|studio)\s+(?:within|in|at)\s+(?:(?:the|iconic|prestigious)\s+)*mercury\b/i],
 ['pendergardens', /(?:home|apartment|residence|penthouse)\s+(?:within|in|at)\s+(?:(?:the|prestigious)\s+)*pender\s*gardens\b/i],
 ['fort-cambridge', /(?:home|apartment|residence|penthouse)\s+(?:within|in|at)\s+(?:(?:the|prestigious)\s+)*fort cambridge\b/i],
 ['tigne-point', /(?:home|apartment|residence|penthouse)\s+(?:within|in|at)\s+(?:(?:the|prestigious)\s+)*tign[ée] point\b/i],
];
export function developmentBinding(record){
 const description=record.description||'';
 const checked=reviewed.find(([id,,evidence])=>id===String(record.id)&&evidence.test(description));
 const inferred=membership.filter(([,pattern])=>pattern.test(description));
 const id=checked?.[1]||(inferred.length===1?inferred[0][0]:null);
 return id?{id,source:'Reviewed public listing description',level:'development',status:'KNOWN',tags:['development:'+id],evidence:description.match(membership.find(([key])=>key===id)?.[1]||checked[2])?.[0]||null}:null;
}
