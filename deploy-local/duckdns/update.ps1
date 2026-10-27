# Actualiza tu dominio DuckDNS con la IP pública actual de este PC. Rellena DOMAIN y TOKEN.
$Domain = "juntial"          # el subdominio, SIN ".duckdns.org"
$Token  = "PEGA_AQUI_TU_TOKEN"

$log = Join-Path $PSScriptRoot "duck.log"
try {
  $resp = Invoke-RestMethod -Uri "https://www.duckdns.org/update?domains=$Domain&token=$Token&ip=" -TimeoutSec 15
  "$(Get-Date -Format s)  dominio=$Domain  respuesta=$resp" | Out-File -FilePath $log -Append -Encoding utf8
  if ($resp -notmatch '^OK') { Write-Error "DuckDNS respondió: $resp (revisa DOMAIN/TOKEN)" }
} catch {
  "$(Get-Date -Format s)  ERROR: $($_.Exception.Message)" | Out-File -FilePath $log -Append -Encoding utf8
  throw
}
