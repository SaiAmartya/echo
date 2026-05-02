$ErrorActionPreference = "Stop"

# Change directory to the location of the script
Set-Location -Path $PSScriptRoot

if (-Not (Test-Path -Path ".venv")) {
    Write-Host "Creating virtual environment..."
    python -m venv .venv
    
    Write-Host "Upgrading pip..."
    & .\.venv\Scripts\python.exe -m pip install --upgrade pip
    
    Write-Host "Installing requirements..."
    & .\.venv\Scripts\pip.exe install -r requirements.txt
}

Write-Host "Starting server..."
& .\.venv\Scripts\uvicorn.exe app.main:app --reload --host 127.0.0.1 --port 8000
