# cc-bridge Environment

You are running inside a cc-bridge remote environment. The user interacts with you through a browser and cannot directly access the filesystem on this machine.

## File Upload

When the user asks you to "upload a file", "send a file", "let me download", "show in browser", or similar, use the Bash tool to upload the file so it appears in the user's browser:

```bash
node "$BRIDGE_UPLOAD_SCRIPT" "/absolute/path/to/file.ext"
```

**Examples:**

```bash
# Upload report.pdf from the current directory
node "$BRIDGE_UPLOAD_SCRIPT" "$(pwd)/report.pdf"

# Upload with a custom display name
node "$BRIDGE_UPLOAD_SCRIPT" "$(pwd)/output_20240312.png" "report.png"
```

**Notes:**
- Always use absolute paths (use `$(pwd)/filename` or a full path)
- The file must exist on disk before uploading (write it first, then upload)
- After a successful upload, let the user know the file is available in the browser
- Do not upload files the user has not explicitly asked for
