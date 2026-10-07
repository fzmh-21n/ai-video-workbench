$ErrorActionPreference = 'Stop'
$dataDir = Join-Path $PSScriptRoot '.workbench-data'
$venvDir = Join-Path $dataDir 'face-venv'
$modelDir = Join-Path $dataDir 'face-models'
$pythonExe = Join-Path $venvDir 'Scripts\python.exe'

New-Item -ItemType Directory -Path $modelDir -Force | Out-Null
if (-not (Test-Path -LiteralPath $pythonExe)) {
    python -m venv $venvDir
}
& $pythonExe -m pip install --disable-pip-version-check 'numpy<3' 'opencv-contrib-python-headless==4.11.0.86'
if ($LASTEXITCODE -ne 0) { throw '人脸分析依赖安装失败' }

$models = @(
    @{ Name = 'face_detection_yunet_2023mar.onnx'; MinBytes = 100000 },
    @{ Name = 'face_recognition_sface_2021dec.onnx'; MinBytes = 10000000 }
)
foreach ($model in $models) {
    $target = Join-Path $modelDir $model.Name
    if ((Test-Path -LiteralPath $target) -and (Get-Item -LiteralPath $target).Length -ge $model.MinBytes) { continue }
    $source = if ($model.Name -like 'face_detection*') { 'face_detection_yunet' } else { 'face_recognition_sface' }
    $url = "https://huggingface.co/opencv/opencv_zoo/resolve/main/models/$source/$($model.Name)?download=true"
    $temporary = "$target.download"
    Invoke-WebRequest -Uri $url -OutFile $temporary
    if ((Get-Item -LiteralPath $temporary).Length -lt $model.MinBytes) { throw "模型下载不完整：$($model.Name)" }
    Move-Item -LiteralPath $temporary -Destination $target -Force
}
Write-Host '明星脸初筛组件已安装。'
