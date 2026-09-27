$ErrorActionPreference='Stop'
$path='public/link-marketplace/locality-guides.json'
$before=(Get-FileHash $path).Hash
$data=Get-Content $path -Raw | ConvertFrom-Json
function Wiki($base,$params){$query=($params.GetEnumerator() | ForEach-Object {$_.Key+'='+[uri]::EscapeDataString([string]$_.Value)}) -join '&'; Invoke-RestMethod ($base+'?'+$query) -Headers @{'User-Agent'='NexusLocalityGuide/1.0'} }
$targets=@($data.records | Where-Object {$_.sourceTitle -and $_.name -match 'Sliema|Julian|Valletta|Gzira|Mellieha|Marsaskala|Paul|Mdina|Rabat|Birgu|Pembroke|Swieqi'})
foreach($g in $targets){
 try{
  $r=Wiki 'https://en.wikipedia.org/w/api.php' @{action='query';format='json';prop='pageimages';titles=$g.sourceTitle;pithumbsize=1200}
  $p=@($r.query.pages.PSObject.Properties.Value)[0]
  if(!$p.thumbnail){continue}
  $m=Wiki 'https://en.wikipedia.org/w/api.php' @{action='query';format='json';prop='imageinfo';titles=('File:'+$p.pageimage);iiprop='extmetadata|url'}
  $i=@($m.query.pages.PSObject.Properties.Value)[0].imageinfo[0];$e=$i.extmetadata
  if(!$e.LicenseShortName.value -or !$i.descriptionurl){continue}
  $photo=@{url=$p.thumbnail.source;sourceUrl=$i.descriptionurl;author=([regex]::Replace($e.Artist.value,'<[^>]+>',''));license=$e.LicenseShortName.value;licenseUrl=$e.LicenseUrl.value;caption=$g.name;source='Wikimedia Commons'}
  $g | Add-Member -NotePropertyName photo -NotePropertyValue $photo -Force
  Write-Output ($g.name+' · '+$photo.license)
 }catch{Write-Warning ($g.name+': photo not connected')}
 Start-Sleep -Milliseconds 400
}
if((Get-FileHash $path).Hash -ne $before){throw 'Guide changed during fetch'}
$data | ConvertTo-Json -Depth 12 | Set-Content $path -Encoding utf8

