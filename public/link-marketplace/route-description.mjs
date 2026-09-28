// Route evidence comes from routing steps; never infer a ferry from a sea crossing.
export function routeDescription(result, mode = 'walk') {
 const travel = mode === 'walk' ? 'Walk' : 'Drive';
 if (!result?.includesFerry) return `${travel} route from approximate map pin · OpenStreetMap`;
 const names = [...new Set((result.ferries || []).map(f => f.name).filter(Boolean))];
 return `${travel} + ferry · ${names.join(' / ') || 'Ferry crossing'}. Modelled route time; ferry timetable, waiting time and fare not verified. From approximate map pin · OpenStreetMap`;
}
