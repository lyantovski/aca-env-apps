using './main.bicep'

param location = readEnvironmentVariable('AZURE_LOCATION')
param appName = readEnvironmentVariable('APP_NAME', 'pocket-tasks')
param registryName = readEnvironmentVariable('ACR_NAME')
param registryResourceGroup = readEnvironmentVariable('AZURE_RESOURCE_GROUP')
param imageTag = readEnvironmentVariable('IMAGE_TAG', '1.0.0')
param entraTenantId = readEnvironmentVariable('ENTRA_TENANT_ID')
param entraClientId = readEnvironmentVariable('ENTRA_CLIENT_ID')
param entraClientSecret = readEnvironmentVariable('ENTRA_CLIENT_SECRET')
param sessionSecret = readEnvironmentVariable('SESSION_SECRET')
