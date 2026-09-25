// Switch to live only when the documented 2906 endpoints are connected.
// Never place secrets or private contacts in this public file.
window.NEXUS_CONFIG = { mode: 'argus', apiBase: null, endpoints: {}, inventoryUrl: '/api/nexus/inventory', placesUrl: '/api/nexus/places', designInventory: true };

// For the supplied public export schema: mode: argus, inventoryUrl: the read-only public JSON endpoint.
// Disable designInventory to remove all 15 temporary Sales / Commercial examples.
