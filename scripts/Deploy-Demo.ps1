#Requires -Version 7.2
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Subscription,
    [Parameter(Mandatory)][string]$Location,
    [string]$ResourceGroup = 'rg-pocket-tasks-demo',
    [ValidatePattern('^[a-z][a-z0-9-]{0,28}[a-z0-9]$')][string]$AppName = 'pocket-tasks',
    [string]$RegistryName,
    [string]$EntraAppObjectId,
    [switch]$SkipImageBuild
)

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$root = Split-Path $PSScriptRoot -Parent
$stateDirectory = Join-Path $root '.azure'
$statePath = Join-Path $stateDirectory 'demo-deployment.json'

function Invoke-Az {
    param([Parameter(Mandatory)][string[]]$Arguments, [switch]$Json)
    $output = & az @Arguments --only-show-errors --output $(if ($Json) { 'json' } else { 'none' })
    if ($LASTEXITCODE -ne 0) {
        throw "Azure CLI failed: $($Arguments[0..([Math]::Min(2, $Arguments.Length - 1))] -join ' '). Review the error above."
    }
    if ($Json) { return ($output -join "`n" | ConvertFrom-Json -Depth 100) }
}

function Invoke-Graph {
    param([string]$Method, [string]$Uri, [object]$Body)
    $arguments = @('rest', '--subscription', $script:subscriptionId, '--method', $Method,
        '--url', "https://graph.microsoft.com/v1.0/$Uri")
    $requestFile = $null
    try {
        if ($null -ne $Body) {
            $requestFile = [System.IO.Path]::GetTempFileName()
            $Body | ConvertTo-Json -Depth 20 -Compress | Set-Content -LiteralPath $requestFile -Encoding utf8NoBOM
            $arguments += @('--headers', 'Content-Type=application/json', '--body', "@$requestFile")
        }
        Invoke-Az -Arguments $arguments -Json
    } finally {
        if ($requestFile) { Remove-Item -LiteralPath $requestFile -Force }
    }
}

function Save-State {
    $script:state | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $statePath -Encoding utf8
}

function Assert-WhatIf {
    param([string]$Name, [string[]]$DeploymentArguments)
    $preview = Invoke-Az -Arguments (@('deployment', 'group', 'what-if', '--name', $Name, '--no-pretty-print') + $DeploymentArguments) -Json
    if ($preview.status -and $preview.status -ne 'Succeeded') {
        throw "Deployment preview failed: $($preview.status)"
    }
    if (@($preview.changes | Where-Object changeType -eq 'Delete').Count) {
        throw 'Deployment preview includes resource deletion. Review it manually; this script will not delete existing resources.'
    }
    Write-Host "What-if passed: $(@($preview.changes).Count) resource changes; no deletions."
}

Push-Location $root
$secretEnvironment = @('ENTRA_CLIENT_SECRET', 'SESSION_SECRET')
$previousEnvironment = @{}
foreach ($name in $secretEnvironment) { $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    $context = Invoke-Az -Arguments @('account', 'get-access-token', '--subscription', $Subscription,
        '--resource', 'https://management.azure.com/', '--query', '{tenantId:tenant,subscriptionId:subscription}') -Json
    $script:subscriptionId = $context.subscriptionId
    if (!$subscriptionId -or !$context.tenantId) { throw 'Could not determine the explicitly selected Azure context. Run az login manually.' }
    $tenantId = $context.tenantId

    if (!$RegistryName) {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes("$subscriptionId/$ResourceGroup")
        $hash = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
        $RegistryName = "pocket$($hash.Substring(0, 14))"
    }
    if (Test-Path -LiteralPath $statePath) {
        $script:state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json -AsHashtable
        if ($state.subscriptionId -ne $subscriptionId -or $state.resourceGroup -ne $ResourceGroup -or
            $state.location -ne $Location -or $state.appName -ne $AppName -or $state.registryName -ne $RegistryName) {
            throw 'The saved .azure/demo-deployment.json belongs to a different target. Use the saved target or move that state file before creating another deployment.'
        }
        if ($EntraAppObjectId -and $state.entraAppObjectId -and $EntraAppObjectId -ne $state.entraAppObjectId) {
            throw 'EntraAppObjectId differs from the saved deployment. Use the registered app already associated with this deployment.'
        }
    } else {
        $script:state = @{
            subscriptionId = $subscriptionId; tenantId = $tenantId; location = $Location
            resourceGroup = $ResourceGroup; appName = $AppName; registryName = $RegistryName
        }
        New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
        Save-State
    }

    if (!$SkipImageBuild) {
        & docker info --format '{{.OSType}}' | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Start Docker Desktop in Linux-container mode before deploying.' }
    } elseif (!$state.imageTag) {
        throw 'SkipImageBuild requires an imageTag from a previous completed image push in the saved deployment state.'
    }
    Write-Host "Target: $subscriptionId / $ResourceGroup / $Location"
    foreach ($provider in @('Microsoft.App', 'Microsoft.ContainerRegistry', 'Microsoft.ManagedIdentity')) {
        Invoke-Az -Arguments @('provider', 'register', '--subscription', $subscriptionId, '--namespace', $provider, '--wait')
    }
    Invoke-Az -Arguments @('bicep', 'build', '--file', '.\infra\platform.bicep', '--stdout') | Out-Null
    Invoke-Az -Arguments @('bicep', 'build', '--file', '.\infra\main.bicep', '--stdout') | Out-Null
    Invoke-Az -Arguments @('group', 'create', '--subscription', $subscriptionId, '--name', $ResourceGroup, '--location', $Location)

    $platformArgs = @('--subscription', $subscriptionId, '--resource-group', $ResourceGroup,
        '--template-file', '.\infra\platform.bicep', '--parameters', "location=$Location", "appName=$AppName", "registryName=$RegistryName")
    Write-Host 'Validating and provisioning the registry, environment and image-pull identity...'
    Assert-WhatIf -Name 'pocket-platform-preview' -DeploymentArguments $platformArgs
    $platform = Invoke-Az -Arguments (@('deployment', 'group', 'create', '--name', 'pocket-platform') + $platformArgs) -Json
    $loginServer = $platform.properties.outputs.registryLoginServer.value
    $appUrl = "https://$AppName.$($platform.properties.outputs.environmentDefaultDomain.value)"
    $state.appUrl = $appUrl
    Save-State

    if (!$SkipImageBuild) {
        $imageTag = (Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss')
        $image = "${loginServer}/pocket-tasks:$imageTag"
        Write-Host "Building and pushing $image ..."
        & docker build --platform linux/amd64 --tag $image .
        if ($LASTEXITCODE -ne 0) { throw 'Container build failed.' }
        Invoke-Az -Arguments @('acr', 'login', '--subscription', $subscriptionId, '--name', $RegistryName)
        & docker push $image
        if ($LASTEXITCODE -ne 0) { throw 'Image push failed. Confirm Container Registry push permissions.' }
        $state.imageTag = $imageTag
        Save-State
    }

    if (!$state.entraAppObjectId -and $EntraAppObjectId) {
        $application = Invoke-Graph -Method GET -Uri "applications/$EntraAppObjectId"
        if ($application.signInAudience -ne 'AzureADMyOrg') { throw 'The supplied Entra app must be single-tenant (AzureADMyOrg).' }
        $state.entraAppObjectId = $application.id
        $state.entraClientId = $application.appId
        Save-State
    }
    if (!$state.entraAppObjectId) {
        Write-Host 'Creating the single-tenant Entra application registration...'
        $application = Invoke-Graph -Method POST -Uri 'applications' -Body @{
            displayName = "Pocket Tasks demo ($ResourceGroup)"
            signInAudience = 'AzureADMyOrg'
            requiredResourceAccess = @()
            web = @{ redirectUris = @('http://localhost:8080/auth/callback', 'http://localhost:8080/', "$appUrl/auth/callback", "$appUrl/") }
        }
        $state.entraAppObjectId = $application.id
        $state.entraClientId = $application.appId
        Save-State
    } else {
        $application = Invoke-Graph -Method GET -Uri "applications/$($state.entraAppObjectId)"
        $uris = @(@($application.web.redirectUris) + @('http://localhost:8080/auth/callback', 'http://localhost:8080/', "$appUrl/auth/callback", "$appUrl/") | Sort-Object -Unique)
        $null = Invoke-Graph -Method PATCH -Uri "applications/$($state.entraAppObjectId)" -Body @{ web = @{ redirectUris = $uris } }
    }
    $principals = Invoke-Graph -Method GET -Uri "servicePrincipals?`$filter=appId eq '$($state.entraClientId)'&`$select=id"
    if (@($principals.value).Count -eq 0) {
        $null = Invoke-Graph -Method POST -Uri 'servicePrincipals' -Body @{ appId = $state.entraClientId }
    }

    Write-Host 'Creating a six-month application credential and injecting runtime secrets...'
    $credentialName = "pocket-demo-$((Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss'))"
    $credential = Invoke-Graph -Method POST -Uri "applications/$($state.entraAppObjectId)/addPassword" -Body @{
        passwordCredential = @{
            displayName = $credentialName
            endDateTime = (Get-Date).ToUniversalTime().AddMonths(6).ToString('o')
        }
    }
    if (!$credential.secretText) { throw 'Entra did not return a client credential. No application deployment was attempted.' }
    $state.credentialKeyId = $credential.keyId
    $state.credentialExpiresAt = $credential.endDateTime
    Save-State
    $env:ENTRA_CLIENT_SECRET = $credential.secretText
    $env:SESSION_SECRET = [Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(48)).ToLowerInvariant()
    $env:AZURE_RESOURCE_GROUP = $ResourceGroup
    $env:AZURE_LOCATION = $Location
    $env:ACR_NAME = $RegistryName
    $env:APP_NAME = $AppName
    $env:IMAGE_TAG = $state.imageTag
    $env:ENTRA_TENANT_ID = $tenantId
    $env:ENTRA_CLIENT_ID = $state.entraClientId
    $appArgs = @('--subscription', $subscriptionId, '--resource-group', $ResourceGroup, '--parameters', '.\infra\main.bicepparam')
    Assert-WhatIf -Name 'pocket-app-preview' -DeploymentArguments $appArgs
    $deployment = Invoke-Az -Arguments (@('deployment', 'group', 'create', '--name', 'pocket-app') + $appArgs) -Json
    $state.appUrl = $deployment.properties.outputs.appUrl.value
    $state.credentialKeyId = $credential.keyId
    $state.credentialExpiresAt = $credential.endDateTime
    $state.deployedAt = (Get-Date).ToUniversalTime().ToString('o')
    Save-State

    $ready = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        & curl --fail --silent --show-error --max-time 10 "$($state.appUrl)/health/ready" 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Seconds 10
    }
    if (!$ready) { throw 'Deployment finished, but the HTTPS readiness check did not pass. Inspect Container Apps console/system logs.' }
    Write-Host "Ready: $($state.appUrl)"
    Write-Host "Entra client ID: $($state.entraClientId)"
    Write-Host "Credential expires: $($state.credentialExpiresAt). Older credentials were not removed."
    Write-Host 'Complete one interactive Microsoft sign-in to verify your tenant policies and account access.'
} finally {
    foreach ($name in $secretEnvironment) { [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process') }
    $credential = $null
    Pop-Location
}
