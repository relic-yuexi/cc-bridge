#!/usr/bin/env node
// upload-helper.js - Upload a file to the cc-bridge server
// Usage: node upload-helper.js <file-path> [display-name]

import { readFileSync } from 'fs';
import { basename } from 'path';
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';

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
const payload = JSON.stringify({ filename, content });

const url = new URL(uploadUrl);
const isHttps = url.protocol === 'https:';
const requestFn = isHttps ? httpsRequest : httpRequest;

const options = {
  hostname: url.hostname,
  port: url.port || (isHttps ? 443 : 80),
  path: url.pathname + url.search,
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  },
};

const req = requestFn(options, (res) => {
  let data = '';
  res.on('data', chunk => { data += chunk; });
  res.on('end', () => {
    if (res.statusCode === 200) {
      try {
        const result = JSON.parse(data);
        console.log(`✅ Uploaded successfully: ${result.name}`);
        if (result.url) {
          console.log(`   Available at: ${result.url}`);
        }
      } catch {
        console.log('✅ Upload successful');
      }
    } else {
      console.error(`❌ Upload failed (HTTP ${res.statusCode}): ${data}`);
      process.exit(1);
    }
  });
});

req.on('error', (err) => {
  console.error(`❌ Upload error: ${err.message}`);
  process.exit(1);
});

req.write(payload);
req.end();
