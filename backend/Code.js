// Code.js (Google Apps Script V8 Runtime)
// ==========================================================
// NOTE: Environment selection ("DEV" | "PROD") is controlled
// exclusively via /backend/config.js. Do NOT hardcode APP_ENV
// in this file.
// ==========================================================

const FALLBACK_ENV_CONFIG = {
  PROD: {
    sheetName: 'WERONE_Database',
    folderName: 'WERONE_Icons',
    sheetProp: 'SHEET_ID_PROD',
    folderProp: 'FOLDER_ID_PROD'
  },
  DEV: {
    sheetName: 'WERONE_Database_DEV',
    folderName: 'WERONE_Icons_DEV',
    sheetProp: 'SHEET_ID_DEV',
    folderProp: 'FOLDER_ID_DEV'
  }
};

const CACHE_TTL_SECONDS = 21600; // 6 hours (maximum allowed by CacheService)

/**
 * Resolves the active environment ('DEV' or 'PROD') from:
 * 1. Incoming request payload/query from the frontend (sourced from /backend/config.js)
 * 2. Global WERONE_CONFIG / APP_ENV if config.js is deployed in the same Apps Script project
 * 3. Fallback to 'PROD'
 */
function resolveEnvKey(requestedEnv) {
  const candidate = String(
    requestedEnv ||
    (typeof globalThis !== 'undefined' && globalThis.WERONE_CONFIG && globalThis.WERONE_CONFIG.APP_ENV) ||
    (typeof APP_ENV !== 'undefined' ? APP_ENV : 'PROD')
  ).trim().toUpperCase();

  return candidate === 'DEV' ? 'DEV' : 'PROD';
}

function getEnvConfig(envKey) {
  const key = resolveEnvKey(envKey);
  const sharedMap = (typeof globalThis !== 'undefined' && globalThis.WERONE_CONFIG && globalThis.WERONE_CONFIG.ENV_CONFIG) ||
                    (typeof ENV_CONFIG !== 'undefined' ? ENV_CONFIG : null);
  const base = FALLBACK_ENV_CONFIG[key];
  const override = sharedMap && sharedMap[key] ? sharedMap[key] : {};
  return {
    key,
    sheetName: override.sheetName || base.sheetName,
    folderName: override.folderName || base.folderName,
    sheetProp: override.sheetProp || base.sheetProp,
    folderProp: override.folderProp || base.folderProp
  };
}

function getAppsCacheKey(envKey) {
  return `WERONE_APPS_CACHE_V2_${resolveEnvKey(envKey)}`;
}

function invalidateAppsCache(envKey) {
  try {
    CacheService.getScriptCache().remove(getAppsCacheKey(envKey));
  } catch (_) {}
}

/**
 * Lazily initializes and returns ONLY the Spreadsheet Sheet for the given environment.
 * Avoids unnecessary DriveApp folder lookups during read/write sheet operations.
 */
function getOrCreateSheet(envKey, scriptProps, allProps) {
  const config = getEnvConfig(envKey);
  const props = scriptProps || PropertiesService.getScriptProperties();
  const cachedProps = allProps || props.getProperties();

  let sheetId = cachedProps[config.sheetProp];
  if (sheetId) {
    try {
      return SpreadsheetApp.openById(sheetId).getSheets()[0];
    } catch (_) {
      sheetId = null;
    }
  }

  const ss = SpreadsheetApp.create(config.sheetName);
  const sheet = ss.getSheets()[0];
  sheet.appendRow(['ID', 'Name', 'URL', 'IconURL', 'OrderIndex']);
  sheetId = ss.getId();
  props.setProperty(config.sheetProp, sheetId);
  return sheet;
}

/**
 * Lazily initializes and returns the Google Drive Folder for icons in the given environment.
 * Only called when uploading icons or browsing Drive.
 */
function getOrCreateFolder(envKey, scriptProps, allProps) {
  const config = getEnvConfig(envKey);
  const props = scriptProps || PropertiesService.getScriptProperties();
  const cachedProps = allProps || props.getProperties();

  let folderId = cachedProps[config.folderProp];
  if (folderId) {
    try {
      return DriveApp.getFolderById(folderId);
    } catch (_) {
      folderId = null;
    }
  }

  const folders = DriveApp.getFoldersByName(config.folderName);
  let folder;
  if (folders.hasNext()) {
    folder = folders.next();
  } else {
    folder = DriveApp.createFolder(config.folderName);
    folder.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  }
  props.setProperty(config.folderProp, folder.getId());
  return folder;
}

// Backwards-compatible helper if run manually from the Apps Script IDE
function setupStorage(envKey) {
  const activeEnv = resolveEnvKey(envKey);
  const props = PropertiesService.getScriptProperties();
  const allProps = props.getProperties();
  getOrCreateFolder(activeEnv, props, allProps);
  return getOrCreateSheet(activeEnv, props, allProps);
}

function doPost(e) {
  let request;
  try {
    request = JSON.parse(e && e.postData && e.postData.contents ? e.postData.contents : '{}');
  } catch (err) {
    return respond({ success: false, error: 'Invalid JSON request.' });
  }

  const action = request.action;
  const payload = request.payload || {};
  const envKey = resolveEnvKey(request.env || payload.env || (e && e.parameter && e.parameter.env));

  try {
    // 1. Fast read path (no password or LockService needed; served via CacheService)
    if (action === 'getApps') {
      return respond({ success: true, data: fetchApps(envKey) });
    }

    // Read all script properties in a single RPC call
    const scriptProps = PropertiesService.getScriptProperties();
    const allProps = scriptProps.getProperties();
    const actualPassword = allProps.ADMIN_PASSWORD;

    // 2. Password verification
    if (action === 'verifyPassword') {
      const isValid = Boolean(payload.password && actualPassword && payload.password === actualPassword);
      return respond({ success: isValid });
    }

    // 3. Drive folder browser (used in Icon Studio modal after admin unlock)
    if (action === 'getDriveFiles') {
      if (actualPassword && payload.password && payload.password !== actualPassword) {
        return respond({ success: false, error: 'Unauthorized: Incorrect Password' });
      }
      return respond({
        success: true,
        data: getDriveFiles(payload.parentId, envKey, scriptProps, allProps)
      });
    }

    // 4. Protected write operations (require valid ADMIN_PASSWORD)
    if (!payload.password || payload.password !== actualPassword) {
      return respond({ success: false, error: 'Unauthorized: Incorrect Password' });
    }

    // Upload icon to Drive (does not mutate Sheet rows, so no Sheet lock needed)
    if (action === 'uploadIcon') {
      const iconUrl = uploadIcon(payload.filename, payload.base64, payload.mimeType, envKey, scriptProps, allProps);
      return respond({ success: true, data: iconUrl });
    }

    // Serialize Sheet mutations with LockService to prevent race conditions
    const lock = LockService.getScriptLock();
    lock.waitLock(10000);
    try {
      let result;
      switch (action) {
        case 'addApp':
          result = addApp(payload.app, envKey, scriptProps, allProps);
          break;
        case 'editApp':
          result = editApp(payload.app, envKey, scriptProps, allProps);
          break;
        case 'deleteApp':
          result = deleteApp(payload.id, envKey, scriptProps, allProps);
          break;
        case 'reorderApps':
          result = reorderApps(payload.orderedIds, envKey, scriptProps, allProps);
          break;
        default:
          return respond({ success: false, error: 'Unknown action.' });
      }
      return respond({ success: true, data: result });
    } finally {
      lock.releaseLock();
    }
  } catch (error) {
    return respond({ success: false, error: error && error.message ? error.message : error.toString() });
  }
}

function doGet(e) {
  const envKey = resolveEnvKey(e && e.parameter && e.parameter.env);
  return respond({
    success: true,
    environment: envKey,
    message: `WERONE Backend Active. Environment: ${envKey}`
  });
}

function respond(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}

function verifyPassword(inputPass) {
  const actualPass = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD');
  return Boolean(inputPass && actualPass && inputPass === actualPass);
}

function fetchApps(envKey, bypassCache = false, existingSheet = null) {
  const activeEnv = resolveEnvKey(envKey);
  const cache = CacheService.getScriptCache();
  const cacheKey = getAppsCacheKey(activeEnv);

  if (!bypassCache) {
    try {
      const cachedJson = cache.get(cacheKey);
      if (cachedJson) {
        return JSON.parse(cachedJson);
      }
    } catch (_) {}
  }

  const sheet = existingSheet || getOrCreateSheet(activeEnv);
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) {
    try {
      cache.put(cacheKey, '[]', CACHE_TTL_SECONDS);
    } catch (_) {}
    return [];
  }

  const values = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
  const apps = [];

  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    if (!row[0] && !row[1]) continue;
    apps.push({
      ID: String(row[0]),
      Name: String(row[1] || ''),
      URL: String(row[2] || ''),
      IconURL: String(row[3] || ''),
      OrderIndex: Number(row[4]) || 0
    });
  }

  apps.sort((a, b) => a.OrderIndex - b.OrderIndex);

  try {
    cache.put(cacheKey, JSON.stringify(apps), CACHE_TTL_SECONDS);
  } catch (_) {}

  return apps;
}

function addApp(app, envKey, scriptProps, allProps) {
  if (!app || !app.name || !app.url) {
    throw new Error('Application name and URL are required.');
  }

  const activeEnv = resolveEnvKey(envKey);
  const sheet = getOrCreateSheet(activeEnv, scriptProps, allProps);
  const id = Utilities.getUuid();
  const nextOrderIndex = Math.max(0, sheet.getLastRow() - 1);

  sheet.appendRow([id, app.name, app.url, app.iconUrl || '', nextOrderIndex]);
  SpreadsheetApp.flush();
  invalidateAppsCache(activeEnv);

  return { id };
}

function editApp(app, envKey, scriptProps, allProps) {
  if (!app || !app.id) {
    throw new Error('Application ID is required.');
  }

  const activeEnv = resolveEnvKey(envKey);
  const sheet = getOrCreateSheet(activeEnv, scriptProps, allProps);
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) throw new Error('App not found.');

  // Read only Column A (IDs) to locate the target row with minimal data transfer
  const idColumn = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  const targetId = String(app.id);

  for (let i = 0; i < idColumn.length; i++) {
    if (String(idColumn[i][0]) === targetId) {
      sheet.getRange(i + 2, 2, 1, 3).setValues([[app.name, app.url, app.iconUrl || '']]);
      SpreadsheetApp.flush();
      invalidateAppsCache(activeEnv);
      return true;
    }
  }

  throw new Error('App not found.');
}

function deleteApp(id, envKey, scriptProps, allProps) {
  if (!id) throw new Error('Application ID is required.');

  const activeEnv = resolveEnvKey(envKey);
  const sheet = getOrCreateSheet(activeEnv, scriptProps, allProps);
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) throw new Error('App not found.');

  const idColumn = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  const targetId = String(id);

  for (let i = 0; i < idColumn.length; i++) {
    if (String(idColumn[i][0]) === targetId) {
      sheet.deleteRow(i + 2);
      SpreadsheetApp.flush();
      invalidateAppsCache(activeEnv);
      return true;
    }
  }

  throw new Error('App not found.');
}

function reorderApps(orderedIds, envKey, scriptProps, allProps) {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) return true;

  const activeEnv = resolveEnvKey(envKey);
  const sheet = getOrCreateSheet(activeEnv, scriptProps, allProps);
  const lastRow = sheet.getLastRow();
  if (lastRow <= 1) return true;

  const rowCount = lastRow - 1;
  // Build O(1) lookup map for new order positions
  const orderMap = {};
  for (let i = 0; i < orderedIds.length; i++) {
    orderMap[String(orderedIds[i])] = i;
  }

  // Read IDs (Col 1) and existing OrderIndex (Col 5)
  const idValues = sheet.getRange(2, 1, rowCount, 1).getValues();
  const currentOrderValues = sheet.getRange(2, 5, rowCount, 1).getValues();
  const updatedOrderValues = new Array(rowCount);

  for (let i = 0; i < rowCount; i++) {
    const rowId = String(idValues[i][0]);
    const mappedIdx = orderMap[rowId];
    updatedOrderValues[i] = [mappedIdx !== undefined ? mappedIdx : (Number(currentOrderValues[i][0]) || i)];
  }

  // Single batch write for all rows instead of N separate setValue() calls
  sheet.getRange(2, 5, rowCount, 1).setValues(updatedOrderValues);
  SpreadsheetApp.flush();
  invalidateAppsCache(activeEnv);
  return true;
}

function uploadIcon(filename, base64Data, mimeType, envKey, scriptProps, allProps) {
  if (!base64Data) throw new Error('Missing icon image payload.');

  const activeEnv = resolveEnvKey(envKey);
  const folder = getOrCreateFolder(activeEnv, scriptProps, allProps);

  const decodedBytes = Utilities.base64Decode(base64Data);
  const safeMime = mimeType || 'image/png';
  const safeName = filename || `icon_${Date.now()}.png`;
  const blob = Utilities.newBlob(decodedBytes, safeMime, safeName);

  const file = folder.createFile(blob);
  return `https://drive.google.com/thumbnail?id=${file.getId()}&sz=w512`;
}

function getDriveFiles(parentId, envKey, scriptProps, allProps) {
  let folder;
  if (!parentId || parentId === 'root') {
    folder = DriveApp.getRootFolder();
  } else {
    folder = DriveApp.getFolderById(parentId);
  }

  const items = [];
  const subFolders = folder.getFolders();
  let count = 0;
  while (subFolders.hasNext() && count < 100) {
    const f = subFolders.next();
    items.push({
      id: f.getId(),
      name: f.getName(),
      mimeType: 'application/vnd.google-apps.folder'
    });
    count++;
  }

  const files = folder.getFiles();
  count = 0;
  while (files.hasNext() && count < 150) {
    const file = files.next();
    const mime = file.getMimeType() || '';
    if (mime.indexOf('image/') === 0) {
      items.push({
        id: file.getId(),
        name: file.getName(),
        mimeType: mime
      });
      count++;
    }
  }

  items.sort((a, b) => {
    const aIsFolder = a.mimeType === 'application/vnd.google-apps.folder';
    const bIsFolder = b.mimeType === 'application/vnd.google-apps.folder';
    if (aIsFolder !== bIsFolder) return aIsFolder ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return items;
}