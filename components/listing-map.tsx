'use client'
import {useEffect,useRef,useState,useMemo} from 'react'
import type {Property} from '@/lib/types'
import styles from './listing-map.module.css'
export function ListingMap({properties}:{properties:Property[]}){
 const root=useRef<HTMLDivElement>(null),frame=useRef<HTMLIFrameElement>(null)
 const [visible,setVisible]=useState(false),[inventory,setInventory]=useState<any[]>([]),[ready,setReady]=useState(0),[selected,setSelected]=useState('')
 useEffect(()=>{const observer=new IntersectionObserver(([entry])=>{if(entry.isIntersecting){setVisible(true);observer.disconnect()}},{rootMargin:'200px'});if(root.current)observer.observe(root.current);return()=>observer.disconnect()},[])
 useEffect(()=>{if(!visible)return;const abort=new AbortController();fetch('/api/nexus/inventory',{signal:abort.signal}).then(r=>r.json()).then(d=>setInventory(d.properties||[])).catch(()=>{});return()=>abort.abort()},[visible])
 const pins=useMemo(()=>properties.flatMap(p=>{const ref=p.propertyReference||p.id;const hit=inventory.find(i=>i.id===ref);return hit&&Array.isArray(hit.coordinates)&&hit.coordinates.every(Number.isFinite)?[{id:p.id,name:p.location,price:p.price,coordinates:hit.coordinates,slug:p.slug}]:[]}),[properties,inventory])
 useEffect(()=>{const receive=(e:MessageEvent)=>{if(e.origin!==location.origin||e.source!==frame.current?.contentWindow||e.data?.channel!=='estate-listing-map')return;if(e.data.ready)setReady(n=>n+1);if(pins.some(p=>p.id===e.data.selected))setSelected(e.data.selected)};window.addEventListener('message',receive);return()=>window.removeEventListener('message',receive)},[pins])
 useEffect(()=>{frame.current?.contentWindow?.postMessage({channel:'estate-listing-map',pins},location.origin)},[pins,ready])
 const chosen=pins.find(p=>p.id===selected)
 return <div ref={root} className={styles.shell}><header><div><span className={styles.star} aria-hidden>✦</span><h2>Find your place.</h2></div><span>Approximate areas · Nexus Link</span></header>{visible&&<iframe ref={frame} src="/link-marketplace/listing-map.html" title="Map of filtered properties" onLoad={()=>setReady(n=>n+1)}/>}<footer>{chosen?<a href={`/property/${chosen.slug}`}>{chosen.name} · €{chosen.price.toLocaleString()} · View property ↗</a>:<span>{pins.length?'Select a pin to explore a home.':'Only verified public area pins are shown.'}</span>}</footer></div>
}
