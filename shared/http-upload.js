// shared/http-upload.js - Common HTTP upload logic
import { request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';

/**
 * Upload a base64-encoded file via HTTP POST.
 * @param {object} opts
 * @param {string} opts.url - Full URL to POST to
 * @param {string} opts.filename - Display name of the file
 * @param {string} opts.content - Base64-encoded file content
 * @param {(result: object) => void} opts.onSuccess - Called with parsed JSON on 200
 * @param {(error: string) => void} opts.onError - Called with error message on failure
 */
export function uploadFileBase64({ url: targetUrl, filename, content, onSuccess, onError }) {
  const url = new URL(targetUrl);
  const isHttps = url.protocol === 'https:';
  const requestFn = isHttps ? httpsRequest : httpRequest;

  const payload = JSON.stringify({ filename, content });

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
    res.on('data', (chunk) => { data += chunk; });
    res.on('end', () => {
      if (res.statusCode === 200) {
        try {
          const result = JSON.parse(data);
          onSuccess(result);
        } catch (e) {
          onSuccess({ raw: data });
        }
      } else {
        onError(`HTTP ${res.statusCode}: ${data}`);
      }
    });
  });

  req.on('error', (err) => {
    onError(err.message);
  });

  req.write(payload);
  req.end();
}
