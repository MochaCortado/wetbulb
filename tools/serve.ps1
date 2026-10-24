# Minimal static file server for Heat Plan tests (localhost only, no Node).
param([int]$Port = 8833)
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$types = @{ '.html' = 'text/html; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8';
            '.json' = 'application/json; charset=utf-8'; '.css' = 'text/css; charset=utf-8'; '.md' = 'text/plain; charset=utf-8';
            '.png' = 'image/png'; '.svg' = 'image/svg+xml'; '.webmanifest' = 'application/manifest+json' }
$l = New-Object System.Net.HttpListener
$l.Prefixes.Add("http://localhost:$Port/")
$l.Start()
Write-Host "Serving $Root on http://localhost:$Port/"
while ($l.IsListening) {
  $ctx = $l.GetContext()
  $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
  if ($rel -eq '') { $rel = 'index.html' }
  $full = [IO.Path]::GetFullPath((Join-Path $Root $rel))
  if ((Test-Path $full -PathType Container) -and (Test-Path (Join-Path $full 'index.html'))) { $full = Join-Path $full 'index.html' }
  if ($full.StartsWith($Root) -and (Test-Path $full -PathType Leaf)) {
    $bytes = [IO.File]::ReadAllBytes($full)
    $ext = [IO.Path]::GetExtension($full).ToLower()
    $ctx.Response.ContentType = $(if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' })
    $ctx.Response.Headers.Add('Cache-Control', 'no-store')
    $ctx.Response.ContentLength64 = $bytes.Length
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  } else { $ctx.Response.StatusCode = 404 }
  $ctx.Response.Close()
}
