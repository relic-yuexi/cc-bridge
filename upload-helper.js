#!/usr/bin/env node
// upload-helper.js - Upload a file to the cc-bridge server
// Usage: node upload-helper.js <file-path> [display-name]

import { readFileSync } from 'fs';
import { basename } from 'path';
import { uploadFileBase64 } from './shared/http-upload.js';

const filePath = process.argv[2];
const uploadUrl = process.env.BRIDGE_UPLOAD_URL;

if (!filePath) {
  console.error('Usage: node upload-helper.js <file-path> [display-name]');
  process.exit(1);
}

if (!uploadUrl) {
  console.error('Error: BRIDGE_UPLOAD_URL is not set. Are you running inside a cc-bridge session?');
  process.exit(1);
}

let fileContent;
try {
  fileContent = readFileSync(filePath);
} catch (e) {
  console.error(`Error: Cannot read file "${filePath}": ${e.message}`);
  process.exit(1);
}

const filename = process.argv[3] || basename(filePath);
const content = fileContent.toString('base64');

uploadFileBase64({
  url: uploadUrl,
  filename,
  content,
  onSuccess: (result) => {
    console.log(`\u2705 Uploaded successfully: ${result.name || filename}`);
    if (result.url) {
      console.log(`   Available at: ${result.url}`);
    }
  },
  onError: (errMsg) => {
    console.error(`\u274C Upload failed: ${errMsg}`);
    process.exit(1);
  },
});
