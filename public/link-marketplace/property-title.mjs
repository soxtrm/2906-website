export function withoutLocality(title,area){
 if(!area)return title;
 const escaped=String(area).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
 // Remove standalone location labels, not embedded development names.
 const result=String(title).replace(new RegExp(`\\s+(?:in|at)\\s+${escaped}[.!]?$`,'i'),'').replace(new RegExp(`^${escaped}\\s*[-–—:|]\\s*`,'i'),'').replace(new RegExp(`\\s*[-–—:|,]\\s*${escaped}$`,'i'),'').trim();
 return result||title;
}
