# Nexus Malta geometry cache

This importer downloads public OpenStreetMap geometry for Nexus Link. It does
not scan cameras, devices or private networks.

```powershell
python fetch_osm_geometry.py --layer all
# In the CRM repository:
python fetch_osm_geometry.py --layer vegetation --output ../../public/Link/assets
```

Generated files:

- `assets/malta-osm-vegetation.geojson`: mapped trees, tree rows and woodland.
- `assets/malta-osm-buildings.geojson`: only buildings with a mapped `height`
  or `building:levels`. A missing height is never invented in this dataset.

Runtime pages use the cached output and therefore do not call Overpass. Keep
the OpenStreetMap attribution visible when these layers are shown.
