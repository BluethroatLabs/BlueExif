// BlueExif's storage static website, in BlueMask's resource group, behind the
// Front Door profile the Bluethroat sites share (frontdoor.bicep).

@description('Azure region for the storage account')
param location string = resourceGroup().location

@description('Name prefix for Azure resources')
param prefix string = 'blueexif'

@description('Add BlueExif to the shared Front Door profile')
param deployFrontDoor bool = true

@description('Resource group of the shared Front Door profile')
param frontDoorResourceGroup string = 'rg-blueskills-wehi-aci-sandbox'

@description('Shared Front Door profile')
param frontDoorProfileName string = 'bluepaper-fd'

@description('Hostname Front Door serves in addition to its azurefd.net endpoint')
param customDomainHostName string = 'blueexif.bluethroatlabs.com'

var tags = {
  project: 'blueexif'
  environment: 'sandbox'
  managedBy: 'bluethroat'
  owner: 'wehi'
  costCenter: 'blueexif-experiments'
  purpose: 'blueexif-sandbox'
}

var storageName = take('st${prefix}${uniqueString(resourceGroup().id)}', 24)
var staticHost = replace(replace(storage.properties.primaryEndpoints.web, 'https://', ''), '/', '')

resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: storageName
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_LRS'
  }
  properties: {
    // The static website endpoint serves $web regardless; no container needs anonymous blob access.
    allowBlobPublicAccess: false
    allowSharedKeyAccess: true
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: 'Enabled'
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2025-08-01' = {
  parent: storage
  name: 'default'
  properties: {
    staticWebsite: {
      enabled: true
      indexDocument: 'index.html'
    }
  }
}

module frontDoor 'frontdoor.bicep' = if (deployFrontDoor) {
  name: '${prefix}-frontdoor'
  scope: resourceGroup(frontDoorResourceGroup)
  params: {
    profileName: frontDoorProfileName
    prefix: prefix
    originHostName: staticHost
    customDomainHostName: customDomainHostName
  }
}

output storageAccountName string = storage.name
output staticWebsiteHostName string = staticHost
output staticWebsiteUrl string = storage.properties.primaryEndpoints.web
output frontDoorHostName string = deployFrontDoor ? frontDoor!.outputs.hostName : ''
output frontDoorUrl string = deployFrontDoor ? 'https://${frontDoor!.outputs.hostName}/' : ''
output customDomainHostName string = customDomainHostName
output customDomainValidationToken string = deployFrontDoor ? frontDoor!.outputs.customDomainValidationToken : ''
