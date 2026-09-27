$ErrorActionPreference='Stop'
$localities = node --input-type=module -e "import {LOCALITIES} from './public/Link/places-registry.mjs';console.log(JSON.stringify(LOCALITIES))" | ConvertFrom-Json
$overrides=@{'malta:rabat'='Rabat, Malta';'malta:zebbug'='Żebbuġ';'gozo:zebbug'='Żebbuġ, Gozo';'gozo:victoria'='Victoria, Gozo';'gozo:fontana'='Fontana, Gozo';'malta:pembroke'='Pembroke, Malta';'malta:marsa'='Marsa, Malta';'malta:safi'='Safi, Malta';'malta:santa-lucia'='Santa Luċija';'malta:paola'='Paola, Malta';'malta:pieta'='Pietà, Malta';'malta:mgarr'='Mġarr';'malta:tigne'='Tigné';'malta:ta-ibragg'='Ibraġ';'malta:isla'='Senglea';'malta:bormla'='Cospicua';'malta:fleur-de-lys'='Fleur-de-Lys, Malta';'malta:salina'='Salina, Malta'}
$titles=@{};foreach($l in $localities){$title=$overrides[$l.key];if(!$title){$title=($l.label -replace '^Gozo - ','') -replace ' \(.*\)$','';$accent=@($l.aliases | Where-Object {$_ -match '[^\x00-\x7F]'});if($accent.Count){$title=$accent[0]}};$titles[$l.key]=$title}
$records=@()
for($offset=0;$offset -lt $localities.Count;$offset+=15){
 $batch=@($localities | Select-Object -Skip $offset -First 15)
 $url='https://en.wikipedia.org/w/api.php?action=query&prop=extracts%7Ccoordinates%7Cpageprops&colimit=max&explaintext=1&exintro=1&exlimit=20&redirects=1&format=json&titles='+[uri]::EscapeDataString((($batch | ForEach-Object {$titles[$_.key]}) -join '|'))
 $result=$null
 for($attempt=0;$attempt -lt 3;$attempt++){try{$result=Invoke-RestMethod $url;break}catch{Write-Output 'Wikipedia cooling down';Start-Sleep -Seconds 20}}
 foreach($locality in $batch){
  $title=$titles[$locality.key];foreach($redirect in @($result.query.normalized)+@($result.query.redirects)){if($redirect.from -eq $title){$title=$redirect.to}}
  $page=@($result.query.pages.PSObject.Properties.Value | Where-Object title -eq $title)[0];$c=@($page.coordinates)[0]
  if($c -and $c.lat -ge 35.7 -and $c.lat -le 36.2 -and $c.lon -ge 14.1 -and $c.lon -le 14.7 -and !$page.pageprops.disambiguation -and $page.extract){
   $intro=($page.extract -split '\n\n|\n==')[0] -replace '\n',' ';$summary=''
   foreach($sentence in [regex]::Split($intro,'(?<=[.!?])\s+(?=[A-Z])')){if(($summary+' '+$sentence).Split(' ').Count -gt 105){break};$summary=($summary+' '+$sentence).Trim()}
   $feasts=@([regex]::Split(($page.extract -replace '\n',' '),'(?<=[.!?])\s+(?=[A-Z])') | Where-Object {$_ -match '(?i)\b(feast|festa)\b' -and $_.Length -lt 340 -and $_ -notmatch '==|\b(19|20)\d{2}\b'} | Select-Object -First 1)
   $records+=@{key=$locality.key;name=$locality.label;coordinates=@($c.lon,$c.lat);summary=$summary;traditions=$feasts;sourceTitle=$page.title;sourceUrl=('https://en.wikipedia.org/wiki/'+[uri]::EscapeDataString($page.title.Replace(' ','_')));license='CC BY-SA 4.0';retrievedAt=(Get-Date -Format 'yyyy-MM-dd');status='SOURCED'}
  }else{$records+=@{key=$locality.key;name=$locality.label;status='UNKNOWN';summary='';traditions=@()}}
 }
 Start-Sleep -Seconds 4
}
@{records=$records;note='Wikipedia excerpts; recurring traditions are not a current event schedule. Venue data comes from the Nexus registry.'} | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 public/link-marketplace/locality-guides.json
Write-Output ('Guides: '+$records.Count+' sourced: '+@($records | Where-Object status -eq SOURCED).Count)
$records | Where-Object status -eq UNKNOWN | ForEach-Object {Write-Output ('UNRESOLVED '+$_.name)}


