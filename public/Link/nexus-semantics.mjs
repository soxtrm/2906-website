// One descriptive tag graph, not a second property matcher or a new ranking.
export function propertyPillars(taxonomy, facts = {}) {
  return taxonomy.pillars.map(pillar => {
    const definitions = taxonomy.features.filter(f => f.pillars.includes(pillar.key));
    const tags = definitions.map(definition => {
      const fact = facts[definition.key];
      const supported = fact?.status === 'KNOWN' && [1,2,3].includes(fact.tier) && /^(db_field|manual|owner_chat|listing_text|derived:)/.test(fact.source || '');
      return { key:definition.key, label:definition.label, status: supported ? 'KNOWN' : ['LIKELY','CONFLICTING'].includes(fact?.status) ? fact.status : 'UNKNOWN', value: supported ? fact.value : null, source: supported ? fact.source : null, equivalenceGroup:definition.equivalenceGroup || definition.key };
    });
    const positive = tags.filter(t => t.status === 'KNOWN' && t.value !== false && t.value !== null && !['PROHIBITED','UNFURNISHED'].includes(t.value));
    return { key:pillar.key, label:pillar.label, tags, confirmed:positive, confirmedCount:new Set(positive.map(t=>t.equivalenceGroup)).size, unknownCount:tags.filter(t=>t.status==='UNKNOWN').length, score:null };
  });
}

export function semanticPreferences(taxonomy, profile = {}) {
  const output = [];
  for (const definition of taxonomy.preferences) {
    const value = ['transport','homeOffice','nightlife'].includes(definition.key) ? profile[definition.key] : profile.priorities?.[definition.key];
    if (value === null || value === undefined || value === false || value === 'any' || value === 'dont_care') continue;
    output.push({key:definition.key,type:'USER_PREFERENCE',value,source:'explicit_user_input',pillars:definition.pillars});
  }
  return output;
}

export function resumeSummary(taxonomy, profile, homes) {
  return {taxonomyVersion:taxonomy.version,preferences:semanticPreferences(taxonomy,profile),homes:homes.map(home=>({id:home.id,title:home.title,area:home.area,rent:home.rent,currency:home.currency||'EUR',locationPrecision:'locality',pillars:propertyPillars(taxonomy,home.featureFacts||{}).filter(p=>p.confirmedCount>0).map(p=>({key:p.key,label:p.label,tags:p.confirmed.map(t=>t.label),score:null}))})),scores:'No score without supported facts and a documented matching method.'};
}
