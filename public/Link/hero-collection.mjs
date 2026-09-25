// Manually reviewed property photographs. Exact URLs prevent index changes from admitting unreviewed rooms.
export const HERO_PHOTOS=[
  {
    "propertyId": "2906-9018",
    "image": "https://res.cloudinary.com/du2jwqnbs/image/upload/v1787065441/2906-properties/enivz6splqqhrql7m0ia.jpg",
    "scene": "Pool terrace"
  },
  {
    "propertyId": "2906-9189",
    "image": "https://res.cloudinary.com/du2jwqnbs/image/upload/v1788806467/2906-properties/tgznaypsfe4rrne44nb6.jpg",
    "scene": "Living space"
  },
  {
    "propertyId": "2906-9104",
    "image": "https://res.cloudinary.com/du2jwqnbs/image/upload/v1787837068/2906-properties/ns6bwtpzawm6ysvwmvzx.jpg",
    "scene": "Sea-view terrace"
  },
  {
    "propertyId": "2906-9045",
    "image": "https://res.cloudinary.com/du2jwqnbs/image/upload/v1787333962/2906-properties/j8w8grihhzo5iloesdsr.jpg",
    "scene": "Coastal outlook"
  },
  {
    "propertyId": "2906-9268",
    "image": "https://res.cloudinary.com/du2jwqnbs/image/upload/v1789321615/2906-properties/rfnreoyy4hkygdw2mnje.jpg",
    "scene": "Valletta at night"
  },
  {
    "propertyId": "2906-9018",
    "image": "https://res.cloudinary.com/du2jwqnbs/image/upload/v1787065448/2906-properties/qhenrwhzxdfquxxypmt0.jpg",
    "scene": "Living space"
  },
  {
    "propertyId": "2906-9189",
    "image": "https://res.cloudinary.com/du2jwqnbs/image/upload/v1788806466/2906-properties/mc8vfe8mdk2ebvpoyfzp.jpg",
    "scene": "Waterfront balcony"
  }
];
export const HERO_INTERVAL=2000;
export function heroCollection(properties){const live=new Map(properties.map(p=>[p.id,p]));return HERO_PHOTOS.flatMap(photo=>{const property=live.get(photo.propertyId);return property?.images?.includes(photo.image)?[{...photo,property}]:[];});}
