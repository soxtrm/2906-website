// Reserve the freshest homes for their own row; avoid repeating cards above it.
export function diversifyRows(rows, limit=14) {
  const recent=rows.find(row=>row.title==='Most Recent');
  const reserved=new Set(recent?.items.slice(0,4).map(p=>p.id)||[]);
  const seen=new Map();
  return rows.map(row=>{
    const candidates=[...new Map(row.items.map(p=>[p.id,p])).values()];
    const indexed=candidates.map((p,index)=>({p,index}));
    if(row.title!=='Most Recent') indexed.sort((a,b)=>{
      const exposure=p=>(seen.get(p.id)||0)+(row.title==='Nexus Selects'&&reserved.has(p.id)&&!p.crmTop?1:0);
      return exposure(a.p)-exposure(b.p)||a.index-b.index;
    });
    const items=indexed.slice(0,limit).map(x=>x.p);
    items.forEach(p=>seen.set(p.id,(seen.get(p.id)||0)+1));
    return {...row,items};
  });
}
