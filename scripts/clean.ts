// clean.js

const fs = require("fs");
const path = require("path");

function walk(dir: string) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === "node_modules") {
        fs.rmSync(fullPath, { recursive: true, force: true });
        console.log(`Removed ${fullPath}`);
      } else {
        walk(fullPath);
      }
    } else if (entry.name === "bun.lock" || entry.name === "bun.lockb") {
      fs.rmSync(fullPath, { force: true });
      console.log(`Removed ${fullPath}`);
    }
  }
}

walk(process.cwd());
