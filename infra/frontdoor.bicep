// BlueExif's endpoint, rules, custom domain and route on the Front Door profile
// the Bluethroat sites share (BlueMask, BluePaper). Deployed into the profile's
// resource group by main.bicep; only adds children, the profile itself stays as is.

@description('Existing Front Door profile to add BlueExif to')
param profileName string

@description('Name prefix for the Front Door children')
param prefix string

@description('Static website hostname of the storage account')
param originHostName string

@description('Hostname Front Door serves in addition to its azurefd.net endpoint')
param customDomainHostName string

var customDomainName = replace(customDomainHostName, '.', '-')

resource profile 'Microsoft.Cdn/profiles@2023-05-01' existing = {
  name: profileName
}

resource endpoint 'Microsoft.Cdn/profiles/afdEndpoints@2021-06-01' = {
  parent: profile
  name: prefix
  location: 'global'
  properties: {
    enabledState: 'Enabled'
  }
}

resource originGroup 'Microsoft.Cdn/profiles/originGroups@2021-06-01' = {
  parent: profile
  name: '${prefix}-web'
  properties: {
    loadBalancingSettings: {
      sampleSize: 4
      successfulSamplesRequired: 3
      additionalLatencyInMilliseconds: 50
    }
    healthProbeSettings: {
      probePath: '/'
      probeRequestType: 'HEAD'
      probeProtocol: 'Https'
      probeIntervalInSeconds: 120
    }
  }
}

resource origin 'Microsoft.Cdn/profiles/originGroups/origins@2021-06-01' = {
  parent: originGroup
  name: 'blob'
  properties: {
    hostName: originHostName
    originHostHeader: originHostName
    httpPort: 80
    httpsPort: 443
    priority: 1
    weight: 1000
    enabledState: 'Enabled'
  }
}

// Rule set and rule names may only contain letters and digits.
resource ruleSet 'Microsoft.Cdn/profiles/ruleSets@2021-06-01' = {
  parent: profile
  name: '${prefix}security'
}

// The page carries the full Content-Security-Policy as a <meta> tag (see vite.config.ts);
// frame-ancestors only works as a response header, so it is added here.
resource headersRule 'Microsoft.Cdn/profiles/ruleSets/rules@2021-06-01' = {
  parent: ruleSet
  name: 'headers'
  properties: {
    order: 1
    matchProcessingBehavior: 'Continue'
    conditions: []
    actions: [
      {
        name: 'ModifyResponseHeader'
        parameters: {
          typeName: 'DeliveryRuleHeaderActionParameters'
          headerAction: 'Overwrite'
          headerName: 'Referrer-Policy'
          value: 'no-referrer'
        }
      }
      {
        name: 'ModifyResponseHeader'
        parameters: {
          typeName: 'DeliveryRuleHeaderActionParameters'
          headerAction: 'Overwrite'
          headerName: 'X-Content-Type-Options'
          value: 'nosniff'
        }
      }
      {
        name: 'ModifyResponseHeader'
        parameters: {
          typeName: 'DeliveryRuleHeaderActionParameters'
          headerAction: 'Overwrite'
          headerName: 'X-Frame-Options'
          value: 'DENY'
        }
      }
      {
        name: 'ModifyResponseHeader'
        parameters: {
          typeName: 'DeliveryRuleHeaderActionParameters'
          headerAction: 'Overwrite'
          headerName: 'Permissions-Policy'
          value: 'camera=(), microphone=(), geolocation=()'
        }
      }
      {
        name: 'ModifyResponseHeader'
        parameters: {
          typeName: 'DeliveryRuleHeaderActionParameters'
          headerAction: 'Overwrite'
          headerName: 'Content-Security-Policy'
          value: 'frame-ancestors \'none\''
        }
      }
    ]
  }
}

// /blueexif.html is the same page as /, served as a download for offline use.
resource offlineHeadersRule 'Microsoft.Cdn/profiles/ruleSets/rules@2021-06-01' = {
  parent: ruleSet
  name: 'offlinedownload'
  properties: {
    order: 2
    matchProcessingBehavior: 'Continue'
    conditions: [
      {
        name: 'UrlPath'
        parameters: {
          typeName: 'DeliveryRuleUrlPathMatchConditionParameters'
          operator: 'Equal'
          negateCondition: false
          matchValues: [
            '/blueexif.html'
          ]
          transforms: []
        }
      }
    ]
    actions: [
      {
        name: 'ModifyResponseHeader'
        parameters: {
          typeName: 'DeliveryRuleHeaderActionParameters'
          headerAction: 'Overwrite'
          headerName: 'X-Robots-Tag'
          value: 'noindex'
        }
      }
      {
        name: 'ModifyResponseHeader'
        parameters: {
          typeName: 'DeliveryRuleHeaderActionParameters'
          headerAction: 'Overwrite'
          headerName: 'Content-Disposition'
          value: 'attachment; filename="blueexif.html"'
        }
      }
    ]
  }
}

resource customDomain 'Microsoft.Cdn/profiles/customDomains@2023-05-01' = {
  parent: profile
  name: customDomainName
  properties: {
    hostName: customDomainHostName
    tlsSettings: {
      certificateType: 'ManagedCertificate'
      minimumTlsVersion: 'TLS12'
    }
  }
}

resource route 'Microsoft.Cdn/profiles/afdEndpoints/routes@2021-06-01' = {
  parent: endpoint
  name: 'web'
  dependsOn: [
    origin
    headersRule
    offlineHeadersRule
  ]
  properties: {
    originGroup: {
      id: originGroup.id
    }
    supportedProtocols: [
      'Http'
      'Https'
    ]
    patternsToMatch: [
      '/*'
    ]
    forwardingProtocol: 'HttpsOnly'
    httpsRedirect: 'Enabled'
    linkToDefaultDomain: 'Enabled'
    enabledState: 'Enabled'
    cacheConfiguration: {
      queryStringCachingBehavior: 'IgnoreQueryString'
      compressionSettings: {
        isCompressionEnabled: true
        contentTypesToCompress: [
          'text/html'
        ]
      }
    }
    customDomains: [
      {
        id: customDomain.id
      }
    ]
    ruleSets: [
      {
        id: ruleSet.id
      }
    ]
  }
}

output hostName string = endpoint.properties.hostName
output customDomainValidationToken string = customDomain.properties.?validationProperties.?validationToken ?? ''
