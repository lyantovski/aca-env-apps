targetScope = 'resourceGroup'

param location string = resourceGroup().location
param appName string = 'pocket-tasks'
param environmentName string = '${appName}-env'
param registryName string

resource registry 'Microsoft.ContainerRegistry/registries@2025-04-01' = {
  name: registryName
  location: location
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
    anonymousPullEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${appName}-pull'
  location: location
}

module pullRole 'registry-role.bicep' = {
  name: '${appName}-registry-role'
  params: {
    registryName: registry.name
    principalId: pullIdentity.properties.principalId
  }
}

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: environmentName
  location: location
  properties: {
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
}

output environmentDefaultDomain string = environment.properties.defaultDomain
output registryLoginServer string = registry.properties.loginServer
output pullIdentityId string = pullIdentity.id
