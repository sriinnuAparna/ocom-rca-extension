'use strict';

// ── Module → AKS actuator path ────────────────────────────────────────────────
const MODULE_ACTUATOR_PATH = {
  'ocom-web-idgenerator':    'web-idgenerator',
  'ocom-uj-processor':       'uj-processor',
  'ocom-mf-processor':       'mf-processor',
  'ocom-outbound-processor': 'outbound-processor',
  'ocom-uj-api':             'uj-api',
  'ocom-customer-groups':    'customer-groups',
  'ocom-customer-group':     'customer-groups',
  'ocom-store-groups':       'store-groups',
  'ocom-store-group':        'store-groups',
  'ocom-product-groups':     'product-groups',
  'ocom-product-group':      'product-groups',
  'ocom-offer-services':     'offer-service',
  'ocom-mi-consumer':        'mi-consumer',
  'ocom-or-processor':       'or-processor',
};

// ── Workflow env → AKS domain segment ─────────────────────────────────────────
// acceptance runs on qa2 AKS cluster; dev has its own cluster
const ENV_TO_AKS = {
  acceptance: 'qa2',
  dev:        'dev',
  qa:  'qa1', qa1: 'qa1', qa2: 'qa2',
  perf: 'perf1', perf1: 'perf1',
  stage: 'stage',
  prod:  'prod',
};

// ── API endpoint path keyword → OCOM module ───────────────────────────────────
const API_PATH_TO_MODULE = [
  ['/customer-groups', 'ocom-customer-groups'],
  ['/customergroups',  'ocom-customer-groups'],
  ['/product-groups',  'ocom-product-groups'],
  ['/productgroups',   'ocom-product-groups'],
  ['/store-groups',    'ocom-store-groups'],
  ['/storegroups',     'ocom-store-groups'],
  ['/offer-service',   'ocom-offer-services'],
  ['/offers',          'ocom-offer-services'],
  ['/uj-api',          'ocom-uj-api'],
  ['/universaljob',    'ocom-uj-api'],
  ['/mf-processor',    'ocom-mf-processor'],
  ['/neptunereceiver', 'ocom-mf-processor'],
  ['/web-idgenerator', 'ocom-web-idgenerator'],
  ['/webidgen',        'ocom-web-idgenerator'],
  ['/or-processor',    'ocom-or-processor'],
  ['/outbound',        'ocom-outbound-processor'],
  ['/mi-consumer',     'ocom-mi-consumer'],
];

// ── Tag → module ──────────────────────────────────────────────────────────────
const TAG_TO_MODULE = {
  '@CGIntegration':           'ocom-customer-groups',
  '@customerGroup':           'ocom-customer-groups',
  '@PGIntegrationTest':       'ocom-product-groups',
  '@ProductGroup':            'ocom-product-groups',
  '@SGIntegrationTest':       'ocom-store-groups',
  '@ocom-offer-services':     'ocom-offer-services',
  '@WebIdGenIntegrationTest': 'ocom-web-idgenerator',
  '@ocom-uj-apiprocessor':    'ocom-uj-api',
  '@ocom-mf-processor':       'ocom-mf-processor',
  '@ocom-outbound-processor': 'ocom-outbound-processor',
  '@MI':                      'ocom-mi-consumer',
};

// ── Feature path → module ─────────────────────────────────────────────────────
const FEATURE_PATH_TO_MODULE = [
  ['CustomerGroup',   'ocom-customer-groups'],
  ['BulkCustomerGroup', 'ocom-customer-groups'],
  ['ProductGroup',    'ocom-product-groups'],
  ['BulkProductGroup','ocom-product-groups'],
  ['StoreGroup',      'ocom-store-groups'],
  ['ProductGroupSearch','ocom-product-groups'],
  ['MI/SC',           'ocom-mi-consumer'],
  ['webIdGenerator',  'ocom-web-idgenerator'],
  ['Dao/UJ-API',      'ocom-uj-api'],
  ['MF/',             'ocom-mf-processor'],
];

const OCOM_REPOS = {
  'ocom-customer-groups':    { owner: 'Albertsons', repo: 'ocom-customer-groups' },
  'ocom-product-groups':     { owner: 'Albertsons', repo: 'ocom-product-groups' },
  'ocom-offer-services':     { owner: 'Albertsons', repo: 'ocom-offer-services' },
  'ocom-store-groups':       { owner: 'Albertsons', repo: 'ocom-store-groups' },
  'ocom-uj-api':             { owner: 'Albertsons', repo: 'ocom-uj-api' },
  'ocom-uj-processor':       { owner: 'Albertsons', repo: 'ocom-uj-processor' },
  'ocom-mf-processor':       { owner: 'Albertsons', repo: 'ocom-mf-processor' },
  'ocom-outbound-processor': { owner: 'Albertsons', repo: 'ocom-outbound-processor' },
  'ocom-mi-consumer':        { owner: 'Albertsons', repo: 'ocom-mi-consumer' },
  'ocom-or-processor':       { owner: 'Albertsons', repo: 'ocom-or-processor' },
  'ocom-web-idgenerator':    { owner: 'Albertsons', repo: 'ocom-web-idgenerator' },
  'ocom-api-automation':     { owner: 'Albertsons', repo: 'ocom-api-automation' },
};

const ACTUATOR_URL_TEMPLATE = 'https://ocom.{env}.westus.aks.az.albertsons.com/{path}/actuator/info';
const GH_API = 'https://api.github.com';
