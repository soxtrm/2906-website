// The first half is everyday budgets; the second half gives premium homes room.
export function budgetFromPosition(position){const x=Math.max(0,Math.min(100,Number(position)||0));return Math.round(x<=50?x*50:2500+(x-50)*150);}
export function budgetPosition(value){const n=Math.max(0,Math.min(10000,Number(value)||0));return n<=2500?n/50:50+(n-2500)/150;}
export function budgetLabel(value,openEnded=false){return openEnded?'€10,000+ · no ceiling':value?new Intl.NumberFormat('en-IE',{style:'currency',currency:'EUR',maximumFractionDigits:0}).format(value):'Keep open';}
