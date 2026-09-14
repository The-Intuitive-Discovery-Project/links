# TinyThor v2 test deployment helper
# Run only after creating a separate Cloudflare D1 database named tinythor-links-v2
# and replacing database_id in wrangler.jsonc.example (copy it to wrangler.jsonc first).

$ErrorActionPreference = "Stop"
$Npx = "C:\Program Files\nodejs\npx.cmd"
if (!(Test-Path $Npx)) { throw "Node.js npx.cmd was not found at $Npx." }
if (!(Test-Path ".\wrangler.jsonc")) { throw "Copy wrangler.jsonc.example to wrangler.jsonc and set the D1 database_id first." }

Write-Host "Creating/updating private Worker secrets..." -ForegroundColor Cyan
& $Npx wrangler secret put MASTER_ADMIN_SERVICE_TOKEN --config wrangler.jsonc
& $Npx wrangler secret put ANALYTICS_HASH_SECRET --config wrangler.jsonc

Write-Host "Applying the TinyThor v2 schema..." -ForegroundColor Cyan
& $Npx wrangler d1 execute tinythor-links-v2 --remote --file .\schema.sql --config wrangler.jsonc

Write-Host "Deploying the separate v2 Worker..." -ForegroundColor Cyan
& $Npx wrangler deploy --config wrangler.jsonc

Write-Host "Done. Do not attach tinythor.cc to this test Worker until links have been migrated and tested." -ForegroundColor Green
