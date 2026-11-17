$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$output = Join-Path $root 'dist-demo'
$destination = Join-Path $root 'release-demo'
$archive = Join-Path $destination 'grounds-demo.zip'

if (!(Test-Path -LiteralPath (Join-Path $output 'index.html') -PathType Leaf)) {
    throw 'Build the demo before packaging: npm run build:demo'
}

$files = @(Get-ChildItem -LiteralPath $output -Recurse -File)
foreach ($file in $files) {
    $relative = $file.FullName.Substring($output.Length + 1).Replace('\', '/')
    if ($relative -ne 'index.html' -and $relative -notmatch '^assets/[a-zA-Z0-9_-]+\.(js|css)$') {
        throw "Unexpected file in demo output: $relative"
    }
}
if (($files | Measure-Object -Property Length -Sum).Sum -ge 300000000) {
    throw 'Demo output exceeds the 300 MB upload limit.'
}

New-Item -ItemType Directory -Path $destination -Force | Out-Null
$temporary = Join-Path $destination ('grounds-demo-' + [guid]::NewGuid().ToString('N') + '.zip')
try {
    $zip = [System.IO.Compression.ZipFile]::Open($temporary, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in $files) {
            # Explicit ZIP paths avoid legacy .NET emitting Windows backslashes.
            $relative = $file.FullName.Substring($output.Length + 1).Replace('\', '/')
            $entry = $zip.CreateEntry($relative, [System.IO.Compression.CompressionLevel]::Optimal)
            $inputStream = [System.IO.File]::OpenRead($file.FullName)
            try {
                $entryStream = $entry.Open()
                try {
                    $inputStream.CopyTo($entryStream)
                } finally {
                    $entryStream.Dispose()
                }
            } finally {
                $inputStream.Dispose()
            }
        }
    } finally {
        $zip.Dispose()
    }
    $zip = [System.IO.Compression.ZipFile]::OpenRead($temporary)
    try {
        if (@($zip.Entries | Where-Object { $_.FullName -eq 'index.html' }).Count -ne 1) {
            throw 'The demo archive must have exactly one index.html at its root.'
        }
        if ($zip.Entries.Count -ne $files.Count) {
            throw 'The demo archive does not match the built files.'
        }
        foreach ($entry in $zip.Entries) {
            if ($entry.FullName -ne 'index.html' -and $entry.FullName -notmatch '^assets/[a-zA-Z0-9_-]+\.(js|css)$') {
                throw "Unexpected archive path: $($entry.FullName)"
            }
        }
    } finally {
        $zip.Dispose()
    }
    if ((Get-Item -LiteralPath $temporary).Length -ge 300000000) {
        throw 'Demo archive exceeds the 300 MB upload limit.'
    }
    Move-Item -LiteralPath $temporary -Destination $archive -Force
    Write-Output "Upload this archive as a Vibe-project: $archive"
} finally {
    if (Test-Path -LiteralPath $temporary) {
        Remove-Item -LiteralPath $temporary
    }
}
