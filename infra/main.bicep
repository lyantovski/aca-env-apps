targetScope = 'resourceGroup'

param location string = resourceGroup().location
param appName string = 'pocket-tasks'
param environmentName string = '${appName}-env'
@description('Existing non-ABAC Azure Container Registry. Build and push the image before deploying.')
param registryName string
param registryResourceGroup string = resourceGroup().name
param imageName string = 'pocket-tasks'
param imageTag string = '1.0.0'
param entraTenantId string
param entraClientId string
@secure()
param entraClientSecret string
@secure()
@minLength(32)
param sessionSecret string

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: registryName
  scope: resourceGroup(registryResourceGroup)
}

resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' existing = {
  name: '${appName}-pull'
}

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' existing = {
  name: environmentName
}

resource app 'Microsoft.App/containerApps@2025-01-01' = {
  name: appName
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${pullIdentity.id}': {}
    }
  }
  properties: {
    managedEnvironmentId: environment.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      maxInactiveRevisions: 0
      ingress: {
        external: true
        targetPort: 8080
        transport: 'http'
        allowInsecure: false
      }
      registries: [
        {
          server: registry.properties.loginServer
          identity: pullIdentity.id
        }
      ]
      secrets: [
        { name: 'entra-client-secret', value: entraClientSecret }
        { name: 'session-secret', value: sessionSecret }
      ]
    }
    template: {
      terminationGracePeriodSeconds: 30
      containers: [
        {
          name: 'pocket-tasks'
          image: '${registry.properties.loginServer}/${imageName}:${imageTag}'
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'PORT', value: '8080' }
            { name: 'APP_URL', value: 'https://${appName}.${environment.properties.defaultDomain}' }
            { name: 'ENTRA_TENANT_ID', value: entraTenantId }
            { name: 'ENTRA_CLIENT_ID', value: entraClientId }
            { name: 'ENTRA_CLIENT_SECRET', secretRef: 'entra-client-secret' }
            { name: 'SESSION_SECRET', secretRef: 'session-secret' }
          ]
          probes: [
            {
              type: 'Startup'
              httpGet: { path: '/health/ready', port: 8080, scheme: 'HTTP' }
              periodSeconds: 3
              timeoutSeconds: 2
              failureThreshold: 40
            }
            {
              type: 'Readiness'
              httpGet: { path: '/health/ready', port: 8080, scheme: 'HTTP' }
              periodSeconds: 10
              timeoutSeconds: 2
              failureThreshold: 3
            }
            {
              type: 'Liveness'
              httpGet: { path: '/health/live', port: 8080, scheme: 'HTTP' }
              periodSeconds: 30
              timeoutSeconds: 2
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}

output appUrl string = 'https://${app.properties.configuration.ingress.fqdn}'
output callbackUrl string = 'https://${app.properties.configuration.ingress.fqdn}/auth/callback'
